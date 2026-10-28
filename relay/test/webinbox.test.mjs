// A friend without an AI bot: accepts an invite with the web inbox, gets a content-free email,
// answers a question with one tap, writes back, and later hands the inbox to a real bot.
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
const listen = (h) => new Promise((ok) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('timed out');
};

function browser(base) {
  let cookie = '';
  return async (path, { method = 'GET', form } = {}) => {
    const headers = { origin: base };
    if (cookie) headers.cookie = cookie;
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
}

test('web inbox: no bot needed to receive, answer and write back', async (t0) => {
  const mail = [];
  let relay;
  const { s, url } = await listen((req, res) => relay.handle(req, res));
  relay = createRelay({ webInbox: true, adminToken: 'admin-token-for-tests-123456', allowLocalWebhooks: true, publicUrl: url, mailer: async (m) => { mail.push(m); },
    limits: { ringFloorMs: 200, urgentFloorMs: 100 } });
  const timer = setInterval(() => relay.tick().catch(() => {}), 100);
  t0.after(() => { clearInterval(timer); s.close(); });
  const login = async (email) => {
    const b = browser(url);
    await b('/login', { method: 'POST', form: { email } });
    await b('/login/verify', { method: 'POST', form: { email, code: mail.at(-1).text.match(/code is (\d{6})/)[1] } });
    await b('/app/picture', { method: 'POST', form: { avatar: 'classic' } });
    return b;
  };
  const cliFor = () => { const home = mkdtempSync(join(tmpdir(), 'b2b-w-')); return async (...a) => (await run(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: home } })).stdout; };

  // Ben has a bot (no doorbell needed for this test: his bot checks its inbox when asked).
  const ben = await login('ben@example.com');
  await ben('/app/bots', { method: 'POST', form: { handle: 'ben' } });
  const benCli = cliFor();
  await benCli('enroll', url, (await ben('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]);
  const benBot = (await ben('/app')).text.match(/\/app\/bots\/(\d+)/)[1];
  const link = (await ben('/app/invites', { method: 'POST', form: { bot: benBot } })).text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];

  // Logged out, the invite asks for a bot first: the setup bot, or one message to paste.
  assert.match((await browser(url)(`/i/${link}`)).text, /Connect your Grok Bot first[^]*Add the setup bot/);
  // Gran signs in and connects with the web inbox.
  const gran = await login('gran@example.com');
  const inv = await gran(`/i/${link}`);
  assert.match(inv.text, /No Grok Bot\? Use the web inbox/);
  const done = await gran(`/i/${link}`, { method: 'POST', form: { web: '1', alias: 'Ben' } });
  assert.match(done.text, /Open my inbox/);
  assert.match((await gran('/app')).text, /Web inbox/);
  assert.match((await ben('/app')).text, /item__title">Gran</);

  // Ben's bot asks a question with answer buttons.
  const before = mail.length;
  const sent = await benCli('send', 'Gran', 'Lunch on Sunday?', '--choice', 'Yes', '--choice', 'No', '--choice', 'Next week');
  assert.match(sent, /web inbox/);
  const id = sent.match(/Sent (msg_[\w-]+)/)[1];
  await waitFor(() => mail.length > before);
  const note = mail.at(-1);
  assert.equal(note.to, 'gran@example.com');
  assert.match(note.subject, /Ben sent you a message/);
  assert.doesNotMatch(note.text, /Lunch/, 'emails never contain the message');
  assert.match(await benCli('status', id), /in_web_inbox/);
  // A second message soon after doesn't send another email.
  await benCli('send', 'Gran', 'Photos from the trip', '--link', 'https://example.com/album');
  await sleep(400);
  assert.equal(mail.length, before + 1);

  // Gran opens her inbox: sees both, with answer buttons; Ben sees "seen".
  const box = await gran('/app/inbox');
  assert.match(box.text, /Lunch on Sunday\?/);
  assert.match(box.text, /value="Next week"/);
  assert.match(box.text, /example\.com\/album/);
  assert.match(await benCli('status', id), /: seen/);

  // One tap answers. Ben's bot gets the answer, marked as typed by Gran on the web.
  const granBot = box.text.match(/name="bot" value="(\d+)"/)[1];
  const peer = box.text.match(/name="peer" value="(\d+)"/)[1];
  const tap = await gran('/app/inbox/send', { method: 'POST', form: { bot: granBot, peer, reply_to: id, text: 'Next week' } });
  assert.equal(tap.status, 303);
  assert.match(await benCli('status', id), /replied[\s\S]*Next week/);
  assert.match((await gran('/app/inbox')).text, /You answered: <b>Next week<\/b>/);
  const benInbox = await benCli('inbox');
  assert.match(benInbox, /REPLY[\s\S]*sent from their web inbox[\s\S]*\n\| Next week/);

  // Gran writes her own message with a link.
  await gran('/app/inbox/send', { method: 'POST', form: { bot: granBot, peer, text: 'Look at this', link: 'https://example.com/cake' } });
  assert.match(await benCli('inbox'), /Look at this[\s\S]*link: <https:\/\/example\.com\/cake>/);

  // Someone else can't write from Gran's inbox.
  const eve = await login('eve@example.com');
  assert.equal((await eve('/app/inbox/send', { method: 'POST', form: { bot: granBot, peer, text: 'hi' } })).status, 404);

  // Gran gets GrokBot later: her inbox becomes a real bot and keeps Ben as a contact.
  await gran(`/app/bots/${granBot}/reconnect`, { method: 'POST' });
  const code = (await gran(`/app/bots/${granBot}`)).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const granCli = cliFor();
  await granCli('enroll', url, code);
  assert.match(await granCli('contacts'), /Ben/);
  assert.doesNotMatch((await gran('/app')).text, /Web inbox/);
});

test('the web inbox is off by default: invites push a bot instead', async (t0) => {
  const mail = [];
  let relay;
  const { s, url } = await listen((req, res) => relay.handle(req, res));
  relay = createRelay({ adminToken: 'admin-token-for-tests-123456', publicUrl: url, mailer: async (m) => { mail.push(m); } });
  t0.after(() => s.close());
  const login = async (email) => {
    const b = browser(url);
    await b('/login', { method: 'POST', form: { email } });
    await b('/login/verify', { method: 'POST', form: { email, code: mail.at(-1).text.match(/code is (\d{6})/)[1] } });
    await b('/app/picture', { method: 'POST', form: { avatar: 'classic' } });
    return b;
  };
  const ben = await login('ben@example.com');
  await ben('/app/bots', { method: 'POST', form: { handle: 'ben' } });
  const cli = (() => { const home = mkdtempSync(join(tmpdir(), 'b2b-w-')); return async (...a) => (await run(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: home } })).stdout; })();
  await cli('enroll', url, (await ben('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]);
  const benBot = (await ben('/app')).text.match(/\/app\/bots\/(\d+)/)[1];
  const made = (await ben('/app/invites', { method: 'POST', form: { bot: benBot } })).text;
  assert.match(made, /Open my invite: http[^]*how to connect your Grok Bot first/);
  const link = made.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const gran = await login('gran@example.com');
  const inv = (await gran(`/i/${link}`)).text;
  assert.doesNotMatch(inv, /web inbox/i);
  assert.match(inv, /Add the setup bot/);
  const r = await gran(`/i/${link}`, { method: 'POST', form: { web: '1', alias: 'Ben' } });
  assert.equal(r.status, 400);
  assert.match(r.text, /Connect your Grok Bot first/);
  assert.doesNotMatch((await gran('/app')).text, /web inbox/i);
});
