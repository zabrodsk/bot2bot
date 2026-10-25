// Regression tests for docs/AUDIT-0.7.md: one check per finding (finding 14 is in consent.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, owner, connect, login, cliHome, browser, sleep, waitFor, msgId } from './helpers.mjs';

test('audit 1: a bot cannot undo its owner\'s block', async (t0) => {
  const env = await setup(t0);
  const bob = await owner(env, t0, 'bob@example.com', 'bob');
  const ali = await owner(env, t0, 'ali@example.com', 'ali');
  await connect(bob, ali, 'Bob');
  const peer = (await bob.b('/app')).text.match(/name="peer" value="(\d+)"/)[1];
  await bob.b('/app/contacts/block', { method: 'POST', form: { bot: bob.botId, peer } });
  const r = await bob.api('POST', '/v1/contacts/block', { contact: 'Ali', unblock: true });
  assert.equal(r.status, 403);
  await assert.rejects(ali.cli('send', 'Bob', 'hi'), /not reachable/);
});

test('audit 2 and 3: disconnect kills old setup codes, and a disconnected inbox gets nothing', async (t0) => {
  const env = await setup(t0, { webInbox: true });
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const gran = { b: await login(env, 'gran@example.com') };
  await connect(ben, gran, 'Ben', { web: true });
  const granBot = (await gran.b('/app/inbox')).text.match(/name="bot" value="(\d+)"/)[1];
  // Gran starts an upgrade to a real bot, then changes her mind and disconnects.
  await gran.b(`/app/bots/${granBot}/reconnect`, { method: 'POST' });
  const code = (await gran.b(`/app/bots/${granBot}`)).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await gran.b(`/app/bots/${granBot}/disconnect`, { method: 'POST' });
  const agent = cliHome();
  await assert.rejects(agent.cli('enroll', env.url, code), /invalid, used or expired/);
  // Messages to a disconnected inbox are refused, and no email goes out.
  const mails = env.mail.length;
  await assert.rejects(ben.cli('send', 'Gran', 'hello?'), /not reachable/);
  await sleep(300);
  assert.equal(env.mail.length, mails);
});

test('audit 3b: saving a doorbell on a disconnected bot is refused', async (t0) => {
  const env = await setup(t0);
  const mia = await owner(env, t0, 'mia@example.com', 'mia');
  // The save re-checks the bot after reading the form, so a disconnect that lands first always wins.
  await mia.b(`/app/bots/${mia.botId}/disconnect`, { method: 'POST' });
  const r = await mia.b(`/app/bots/${mia.botId}/doorbell`, { method: 'POST', form: { url: `${env.url}/automations/webhook/2`, key: 'k-87654321' } });
  assert.notEqual(r.status, 303);
  assert.equal(env.relay.db.prepare('SELECT webhook_url FROM bots WHERE id = ?').get(Number(mia.botId)).webhook_url, null);
});

test('audit 4: pause can\'t be bypassed by the bot', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const bob = await owner(env, t0, 'bob@example.com', 'bob');
  await connect(ben, bob, 'Ben');
  await bob.b('/app/pause', { method: 'POST', form: { on: '1' } });
  await ben.cli('send', 'Bob', 'secret plans');
  assert.equal((await bob.api('POST', '/v1/doorbell/test', {})).status, 403);
  const rec = await bob.api('GET', '/v1/received');
  assert.equal(rec.json.messages.length, 0, 'held messages are not readable');
});

test('audit 5 and 7: answer choices and "via" notes are erased with the message', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const zoe = await owner(env, t0, 'zoe@example.com', 'zoe');
  await connect(ben, zoe, 'Ben');
  const id = msgId(await ben.cli('send', 'Zoe', 'Which clinic?', '--choice', 'Private clinic A', '--choice', 'Clinic B'));
  await waitFor(async () => /passed_on/.test(await ben.cli('status', id)));
  await zoe.api('POST', '/v1/inbox/claim', { via: 'secret diary entry' });
  const ev = env.relay.db.prepare("SELECT detail FROM events WHERE detail LIKE '%secret diary%'").all();
  assert.equal(ev.length, 0, 'free-form via is never stored');
  env.advance(8 * 86_400_000); env.relay.retention();
  const row = env.relay.db.prepare('SELECT text, choices FROM messages WHERE id = ?').get(id);
  assert.equal(row.text, ''); assert.equal(row.choices, null);
  assert.equal((await ben.api('GET', `/v1/messages/${id}`)).json.choices, undefined);
});

test('audit 6: blocking drops my own queued messages too', async (t0) => {
  const env = await setup(t0);
  const ali = await owner(env, t0, 'ali@example.com', 'ali');
  const bob = await owner(env, t0, 'bob@example.com', 'bob');
  await connect(ali, bob, 'Ali');
  await bob.b('/app/pause', { method: 'POST', form: { on: '1' } });
  const id = msgId(await ali.cli('send', 'Bob', 'before I blocked you'));
  const peer = (await ali.b('/app')).text.match(/name="peer" value="(\d+)"/)[1];
  await ali.b('/app/contacts/block', { method: 'POST', form: { bot: ali.botId, peer } });
  await bob.b('/app/pause', { method: 'POST', form: { on: '0' } });
  assert.equal((await bob.api('POST', '/v1/inbox/claim', {})).json.messages.length, 0);
  assert.match(await ali.cli('status', id), /not_delivered/);
});

test('audit 9: expired messages are never handed out, even before the cleanup runs', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const tom = await owner(env, t0, 'tom@example.com', 'tom');
  await connect(ben, tom, 'Ben');
  await tom.b('/app/pause', { method: 'POST', form: { on: '1' } });
  await ben.cli('send', 'Tom', 'old news');
  env.advance(8 * 86_400_000);
  await tom.b('/app/pause', { method: 'POST', form: { on: '0' } });
  assert.equal((await tom.api('POST', '/v1/inbox/claim', {})).json.messages.length, 0);
});

test('audit 10: an ambiguous 5xx still counts against the daily wake limit', async (t0) => {
  const env = await setup(t0, { limits: { wakesPerDay: 2 } });
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const sam = await owner(env, t0, 'sam@example.com', 'sam', { status: 502 });
  await connect(ben, sam, 'Ben');
  await ben.cli('send', 'Sam', 'one');
  await waitFor(() => sam.rings.length >= 1);
  assert.match(await sam.cli('whoami'), /wake-ups today: 1\//);
});

test('audit 11: reusing a client id with different choices is a conflict', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const ivy = await owner(env, t0, 'ivy@example.com', 'ivy');
  await connect(ben, ivy, 'Ben');
  // Messages are sealed, so the relay tells them apart by the sender's content tag.
  const a = msgId(await ben.cli('send', 'Ivy', 'Pick one', '--choice', 'A', '--choice', 'B', '--client-id', 'x1'));
  assert.match(await ben.cli('send', 'Ivy', 'Pick one', '--choice', 'A', '--choice', 'B', '--client-id', 'x1'), new RegExp(`Already sent as ${a}`));
  await assert.rejects(ben.cli('send', 'Ivy', 'Pick one', '--choice', 'C', '--choice', 'D', '--client-id', 'x1'), /409/);
  const c = msgId(await ben.cli('send', 'Ivy', 'Pick one', '--choice', 'C', '--choice', 'D'));
  assert.notEqual(c, a, 'different options are a different question');
});

test('audit 12: a failed inbox email is retried', async (t0) => {
  let fail = true; const sent = [];
  const env = await setup(t0, { webInbox: true, mailer: async (m) => { if (fail) { fail = false; throw new Error('provider down'); } sent.push(m); } });
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const gran = { b: await login(env, 'gran@example.com') };
  await connect(ben, gran, 'Ben', { web: true });
  await ben.cli('send', 'Gran', 'Lunch?');
  await sleep(400);
  assert.equal(sent.length, 0);
  env.advance(6 * 60_000);
  await waitFor(() => sent.length === 1);
});

test('audit 13: login emails are limited per client', async (t0) => {
  const env = await setup(t0);
  const b = browser(env.url);
  for (let i = 0; i < 10; i++) assert.equal((await b('/login', { method: 'POST', form: { email: `p${i}@example.com` } })).status, 200);
  assert.equal((await b('/login', { method: 'POST', form: { email: 'p10@example.com' } })).status, 429);
});
