// Consent and control: only owners connect bots, every contact needs each owner's yes,
// owners can pause, disconnect, block, remove, export and delete, and old message text is erased.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../server.mjs';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'b2b.mjs');
const ADMIN = 'admin-token-for-tests-123456';
const listen = (h) => new Promise((ok) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('timed out');
};

async function setup(t0) {
  const mail = [];
  let offset = 0;
  let relay;
  const { s, url } = await listen((req, res) => relay.handle(req, res));
  relay = createRelay({ adminToken: ADMIN, allowLocalWebhooks: true, publicUrl: '', clock: () => Date.now() + offset,
    mailer: async (m) => { mail.push(m); }, limits: { ringFloorMs: 200, urgentFloorMs: 100 } });
  const timer = setInterval(() => relay.tick().catch(() => {}), 100);
  t0.after(() => { clearInterval(timer); s.close(); });
  return { relay, url, mail, advance: (ms) => { offset += ms; } };
}

function browser(base) {
  let cookie = '';
  return async (path, { method = 'GET', form } = {}) => {
    const headers = { origin: base };
    if (cookie) headers.cookie = cookie;
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) };
  };
}

async function owner(env, email, handle) {
  const b = browser(env.url);
  await b('/login', { method: 'POST', form: { email } });
  const code = env.mail.at(-1).text.match(/code is (\d{6})/)[1];
  await b('/login/verify', { method: 'POST', form: { email, code } });
  await b('/app/bots', { method: 'POST', form: { handle } });
  const joinCode = (await b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const home = mkdtempSync(join(tmpdir(), `b2b-c-${handle}-`));
  const cli = async (...a) => (await run(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: home } })).stdout;
  await cli('enroll', env.url, joinCode);
  const botId = (await b('/app')).text.match(/\/app\/bots\/(\d+)/)[1];
  // A fake routine: when rung, it reads the inbox and acks, like the real doorbell instruction.
  const rings = [];
  const { s, url } = await listen(async (req, res) => {
    rings.push(Date.now());
    res.writeHead(200).end('{}');
    try {
      for (let i = 0; i < 4; i++) {
        const out = await cli('inbox', '--via', 'doorbell');
        if (out.trim().endsWith('INBOX EMPTY. Nothing more to do.') && !/b2b\.mjs ack/.test(out)) break;
        for (const m of out.matchAll(/b2b\.mjs ack (msg_[\w~-]+)/g)) await cli('ack', m[1]);
      }
    } catch { /* relay closed */ }
  });
  await b(`/app/bots/${botId}/doorbell`, { method: 'POST', form: { url: `${url}/automations/webhook/1`, key: 'k-12345678' } });
  return { b, cli, botId, rings, close: () => s.close() };
}

test('admin enrollment is off unless the operator turns it on', async (t0) => {
  const env = await setup(t0);
  const r = await fetch(env.url + '/admin/enroll', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'sneaky' }) });
  assert.equal(r.status, 403);
  assert.match((await r.json()).error, /owners connect their own bots/);
});

test('bots pairing on their own need both owners to say yes', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, 'ben@example.com', 'ben');
  const ana = await owner(env, 'ana@example.com', 'ana');
  t0.after(() => { ben.close(); ana.close(); });

  // The bots pair through the CLI, with no human in the loop.
  const inv = await ben.cli('invite', 'ana');
  assert.match(inv, /your owner confirms the new contact/);
  const code = inv.match(/: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const acc = await ana.cli('accept', code, 'ben');
  assert.match(acc, /Please approve .* on your dashboard/);

  // Nothing can be sent either way yet.
  await assert.rejects(ana.cli('send', 'ben', 'hi'), /hasn't approved "ben"/);
  await assert.rejects(ben.cli('send', 'ana', 'hi'), /hasn't approved "ana"/);
  assert.match(await ben.cli('contacts'), /your owner must approve/);

  // Ben's dashboard asks him; he says yes. Ana's side is still waiting.
  const dash = await ben.b('/app');
  assert.match(dash.text, /Did you mean to connect with Ana/);
  assert.match(dash.text, /Email verified/);
  const peer = dash.text.match(/name="peer" value="(\d+)"/)[1];
  await ben.b('/app/contacts/approve', { method: 'POST', form: { bot: ben.botId, peer } });
  assert.doesNotMatch((await ben.b('/app')).text, /Did you mean to connect/);
  await assert.rejects(ben.cli('send', 'ana', 'hi'), /"ana" hasn't approved you/);

  // Ana approves too: now messages flow.
  const peerA = (await ana.b('/app')).text.match(/name="peer" value="(\d+)"/)[1];
  await ana.b('/app/contacts/approve', { method: 'POST', form: { bot: ana.botId, peer: peerA } });
  const id = (await ben.cli('send', 'ana', 'Pasta tonight?')).match(/Sent (msg_[\w-]+)/)[1];
  await waitFor(async () => /passed_on/.test(await ben.cli('status', id)));
});

test('declining a contact the bot made removes it on both sides', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, 'ben2@example.com', 'ben2');
  const eve = await owner(env, 'eve@example.com', 'eve');
  t0.after(() => { ben.close(); eve.close(); });
  const code = (await eve.cli('invite', 'ben')).match(/: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await ben.cli('accept', code, 'uncle');
  const peer = (await ben.b('/app')).text.match(/name="peer" value="(\d+)"/)[1];
  await ben.b('/app/contacts/remove', { method: 'POST', form: { bot: ben.botId, peer } });
  assert.match(await ben.cli('contacts'), /No contacts yet/);
  assert.match(await eve.cli('contacts'), /No contacts yet/);
});

// Connects two owners through the web invite link (both say yes in the browser).
async function connect(env, a, b, aliasForA) {
  const link = (await a.b('/app/invites', { method: 'POST', form: { bot: a.botId } })).text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await b.b(`/i/${link}`, { method: 'POST', form: { bot: b.botId, alias: aliasForA } });
}

test('pause holds everything, resume delivers; disconnect cancels the bot, reconnect restores it', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, 'ben3@example.com', 'ben3');
  const mia = await owner(env, 'mia@example.com', 'mia');
  t0.after(() => { ben.close(); mia.close(); });
  await connect(env, ben, mia, 'Ben');

  // Mia pauses everything.
  await mia.b('/app/pause', { method: 'POST', form: { on: '1' } });
  assert.match((await mia.b('/app')).text, /Everything is paused/);
  const ringsBefore = mia.rings.length;
  const id = (await ben.cli('send', 'Mia', 'Running 10 min late')).match(/Sent (msg_[\w-]+)/)[1];
  await sleep(600);
  assert.equal(mia.rings.length, ringsBefore, 'a paused bot is never woken');
  assert.match(await ben.cli('status', id), /: held/);
  await assert.rejects(mia.cli('send', 'Ben', 'hi'), /paused/);
  assert.match(await mia.cli('inbox'), /paused messages[\s\S]*INBOX EMPTY/);

  // Resume: the held message goes out right away.
  await mia.b('/app/pause', { method: 'POST', form: { on: '0' } });
  await waitFor(async () => /passed_on/.test(await ben.cli('status', id)));

  // Disconnect: the bot's token stops working at once, pending mail is not delivered.
  await mia.b(`/app/bots/${mia.botId}/disconnect`, { method: 'POST' });
  await assert.rejects(mia.cli('whoami'), /401/);
  assert.match((await mia.b(`/app/bots/${mia.botId}`)).text, /Disconnected/);
  // Reconnect gives a fresh code; enrolling with it brings the same bot back.
  await mia.b(`/app/bots/${mia.botId}/reconnect`, { method: 'POST' });
  const code = (await mia.b(`/app/bots/${mia.botId}`)).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await mia.cli('enroll', env.url, code);
  assert.match(await mia.cli('whoami'), /@mia/);
  assert.match(await mia.cli('contacts'), /Ben/);
});

test('blocking from the dashboard drops queued messages and refuses new ones', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, 'ben4@example.com', 'ben4');
  const tom = await owner(env, 'tom@example.com', 'tom');
  t0.after(() => { ben.close(); tom.close(); });
  await connect(env, ben, tom, 'Ben');
  await tom.b('/app/pause', { method: 'POST', form: { on: '1' } });
  const id = (await ben.cli('send', 'Tom', 'Buy my course')).match(/Sent (msg_[\w-]+)/)[1];
  const peer = (await tom.b('/app')).text.match(/name="peer" value="(\d+)"/)[1];
  await tom.b('/app/contacts/block', { method: 'POST', form: { bot: tom.botId, peer } });
  assert.match(await ben.cli('status', id), /not_delivered/);
  assert.equal(env.relay.db.prepare('SELECT text FROM messages WHERE id = ?').get(id).text, '', 'blocked text is erased');
  await assert.rejects(ben.cli('send', 'Tom', 'again'), /not reachable/);
});

test('message text is erased 7 days after delivery; undelivered mail expires', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, 'ben5@example.com', 'ben5');
  const zoe = await owner(env, 'zoe@example.com', 'zoe');
  t0.after(() => { ben.close(); zoe.close(); });
  await connect(env, ben, zoe, 'Ben');
  const delivered = (await ben.cli('send', 'Zoe', 'Recipe link', '--link', 'https://example.com/r')).match(/Sent (msg_[\w-]+)/)[1];
  await waitFor(async () => /passed_on/.test(await ben.cli('status', delivered)));
  await zoe.b('/app/pause', { method: 'POST', form: { on: '1' } });
  const stuck = (await ben.cli('send', 'Zoe', 'Are you there?')).match(/Sent (msg_[\w-]+)/)[1];

  env.advance(6 * 86_400_000); env.relay.retention();
  assert.ok(env.relay.db.prepare('SELECT sealed FROM messages WHERE id = ?').get(delivered).sealed);
  env.advance(2 * 86_400_000); env.relay.retention();
  const row = env.relay.db.prepare('SELECT text, links, sealed, body_purged_at FROM messages WHERE id = ?').get(delivered);
  assert.equal(row.text, ''); assert.equal(row.links, '[]'); assert.equal(row.sealed, null); assert.ok(row.body_purged_at);
  assert.match(await ben.cli('status', stuck), /not_delivered/);
  assert.match((await ben.b('/app/activity')).text, /Text deleted after 7 days/);
});

test('owners can export their data and delete their account', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, 'ben6@example.com', 'ben6');
  const ivy = await owner(env, 'ivy@example.com', 'ivy');
  t0.after(() => { ben.close(); ivy.close(); });
  await connect(env, ben, ivy, 'Ben');
  const id = (await ben.cli('send', 'Ivy', 'Friday works?', '--ask')).match(/Sent (msg_[\w-]+)/)[1];
  await waitFor(async () => /passed_on/.test(await ben.cli('status', id)));

  const exp = (await ivy.b('/app/account/export')).json();
  assert.equal(exp.account.email, 'ivy@example.com');
  assert.equal(exp.contacts[0].name, 'Ben6');
  // Sealed between bots: the relay has nothing readable to export.
  assert.equal(exp.messages[0].text, null);
  assert.equal(exp.messages[0].end_to_end_encrypted, true);

  assert.equal((await ivy.b('/app/account/delete', { method: 'POST', form: { confirm: 'wrong@example.com' } })).status, 400);
  const done = await ivy.b('/app/account/delete', { method: 'POST', form: { confirm: 'ivy@example.com' } });
  assert.match(done.text, /Your account is deleted/);
  assert.equal((await ivy.b('/app')).status, 303, 'logged out');
  await assert.rejects(ivy.cli('whoami'), /401/);
  assert.match(await ben.cli('contacts'), /No contacts yet/);
  assert.equal(env.relay.db.prepare('SELECT text FROM messages WHERE id = ?').get(id).text, '');
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM users WHERE email = 'ivy@example.com'").get().n, 0);
});

test('quiet hours hold wake-ups until morning in the owner timezone; login redirects stay on site', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, 'ben7@example.com', 'ben7');
  const sam = await owner(env, 'sam@example.com', 'sam');
  t0.after(() => { ben.close(); sam.close(); });
  await connect(env, ben, sam, 'Ben');
  // Move the relay's clock to 23:00 UTC; Sam keeps the default 22:00 to 08:00 in UTC.
  const d = new Date(); d.setUTCHours(23, 0, 0, 0);
  env.advance(d.getTime() - Date.now());
  await sam.b('/app/account/quiet', { method: 'POST', form: { on: '1', start: '22:00', end: '08:00', tz: 'UTC' } });
  assert.match((await sam.b('/app/account')).text, /quiet time now/);
  const ringsBefore = sam.rings.length;
  const id = (await ben.cli('send', 'Sam', 'Call me tomorrow', '--urgent')).match(/Sent (msg_[\w-]+)/)[1];
  await sleep(500);
  assert.equal(sam.rings.length, ringsBefore, 'nobody is woken at night, even for urgent');
  assert.match(await ben.cli('status', id), /quiet_hours/);
  env.advance(9 * 3_600_000 + 60_000); // 08:01
  await waitFor(async () => /passed_on/.test(await ben.cli('status', id)));

  // Bad redirect targets after login fall back to the dashboard.
  const b = browser(env.url);
  await b('/login', { method: 'POST', form: { email: 'x7@example.com' } });
  const r = await fetch(env.url + '/login/verify', { method: 'POST', redirect: 'manual', headers: { origin: env.url, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: 'x7@example.com', code: env.mail.at(-1).text.match(/code is (\d{6})/)[1], next: '/\\evil.example' }).toString() });
  assert.equal(r.headers.get('location'), '/app');
});
