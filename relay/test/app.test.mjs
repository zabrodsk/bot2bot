// End-to-end test of the human side: email login, self-serve bot setup, doorbell, invite link, verified sender.
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

async function setup(t0) {
  const mail = [];
  let relay;
  const { s, url } = await listen((req, res) => relay.handle(req, res));
  relay = createRelay({ adminToken: 'admin-token-for-tests-123456', allowLocalWebhooks: true, publicUrl: '', mailer: async (m) => { mail.push(m); },
    limits: { ringFloorMs: 200, urgentFloorMs: 100 } });
  const timer = setInterval(() => relay.tick().catch(() => {}), 100);
  t0.after(() => { clearInterval(timer); s.close(); });
  return { relay, url, mail };
}

// A tiny browser: keeps one session cookie, sends Origin on POST like a real form.
function browser(base) {
  let cookie = '';
  return async (path, { method = 'GET', form, json } = {}) => {
    const headers = { origin: base };
    if (cookie) headers.cookie = cookie;
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    return { status: r.status, location: r.headers.get('location'), text, json: () => JSON.parse(text) };
  };
}

async function signup(env, email) {
  const b = browser(env.url);
  await b('/login', { method: 'POST', form: { email } });
  const code = env.mail.at(-1).text.match(/code is (\d{6})/)[1];
  const r = await b('/login/verify', { method: 'POST', form: { email, code } });
  assert.equal(r.status, 303);
  await b('/app/picture', { method: 'POST', form: { avatar: 'classic' } });
  return b;
}

async function connectBot(env, b, handle) {
  const home = mkdtempSync(join(tmpdir(), `b2b-app-${handle}-`));
  const cli = async (...a) => (await run(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: home } })).stdout;
  await b('/app/bots', { method: 'POST', form: { handle } });
  const dash = await b('/app');
  const code = dash.text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await cli('enroll', env.url, code);
  assert.match((await b('/app')).text, new RegExp(`@${handle}`));
  return { cli, home };
}

test('owner journey: login, connect bot, doorbell, invite link, friend accepts, verified sender', async (t0) => {
  const env = await setup(t0);

  // Wrong origin is refused (CSRF)
  const evil = await fetch(env.url + '/login', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a%40b.co' });
  assert.equal(evil.status, 403);

  const ben = await signup(env, 'ben.k@example.com');
  assert.match((await ben('/app')).text, /Connect your Grok Bot[^]*Add the setup bot/);
  const benBot = await connectBot(env, ben, 'ben');

  // Doorbell: a fake GrokBot routine that runs the inbox when rung
  const { s: hook, url: hookUrl } = await listen(async (req, res) => {
    res.writeHead(200).end('{}');
    try {
      for (let i = 0; i < 4 && !done; i++) {
        const out = await benBot.cli('inbox', '--via', 'doorbell');
        if (out.trim() === 'INBOX EMPTY. Stop here. Nothing more to tell your owner, and if no message came for them, say nothing at all.') break;
        for (const m of out.matchAll(/^[^|\n].*b2b\.mjs ack (msg_[\w~-]+)$/gm)) await benBot.cli('ack', m[1]);
      }
    } catch { /* relay closed after the test */ }
  });
  let done = false;
  t0.after(() => { done = true; hook.close(); });
  const botId = (await ben('/app')).text.match(/\/app\/bots\/(\d+)/)[1];
  // A private-mode bot may never have made its routine: the page gives the owner the exact message for it.
  assert.match((await ben(`/app/bots/${botId}`)).text, /Make a routine called &quot;b2b doorbell&quot; with a webhook trigger and this exact instruction: &quot;b2b messages may be waiting for my owner\. Run `node ~\/bin\/b2b\.mjs inbox --via doorbell`/);
  assert.equal((await ben(`/app/bots/${botId}/doorbell`, { method: 'POST', form: { url: 'https://evil.example/x', key: 'k-12345678' } })).status, 400);
  assert.equal((await ben(`/app/bots/${botId}/doorbell`, { method: 'POST', form: { url: `${hookUrl}/automations/webhook/1`, key: 'k-12345678' } })).status, 303);
  assert.match((await ben(`/app/bots/${botId}`)).text, /Test the doorbell/);
  const ringRes = (await ben(`/app/bots/${botId}/test`, { method: 'POST', json: {} })).json();
  assert.equal(ringRes.status, 200);
  for (let i = 0; i < 40 && !(await ben(`/app/bots/${botId}/state`)).json().verified; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await ben(`/app/bots/${botId}/state`)).json().verified, true);

  // Invite link
  const inv = await ben('/app/invites', { method: 'POST', form: { bot: botId } });
  const link = inv.text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const anon = browser(env.url);
  const landing = await anon(`/i/${link}`);
  assert.match(landing.text, /Ben K wants your bots to talk/);
  assert.match(landing.text, /Add the setup bot[^]*accept_invite tool: code/);
  assert.match(landing.text, /Email verified/);

  // Anna signs up, connects her bot, accepts the link
  const anna = await signup(env, 'anna@example.com');
  const annaBot = await connectBot(env, anna, 'anna');
  assert.match((await anna(`/i/${link}`)).text, />Connect<\/button>/);
  const accepted = await anna(`/i/${link}`, { method: 'POST', form: { bot: (await anna('/app')).text.match(/\/app\/bots\/(\d+)/)[1], alias: 'Ben' } });
  assert.match(accepted.text, /You're connected/);
  assert.match((await ben('/app')).text, /item__title">Anna</);   // inviter sees the friend's real name, not "friend-xxxx"
  assert.equal((await anna(`/i/${link}`)).location, '/app');    // one-time: used, so it goes home
  assert.equal((await browser(env.url)(`/i/${link}`)).status, 404);

  // Anna's bot messages Ben's: Ben's bot sees who it really is
  await annaBot.cli('send', 'Ben', 'Recipe for tonight', '--link', 'https://example.com/pasta');
  for (let i = 0; i < 50 && env.relay.db.prepare("SELECT status FROM messages WHERE kind = 'note'").get()?.status !== 'delivered'; i++) await new Promise((r) => setTimeout(r, 100));
  // Bot to bot is end-to-end encrypted: the relay (and so the dashboard) never has the text.
  const dash = (await ben('/app/activity')).text;
  assert.doesNotMatch(dash, /Recipe for tonight/);
  assert.match(dash, /End-to-end encrypted messages show no text here. Only the bots can read them./);
  const seen = env.relay.db.prepare("SELECT status, text, links, sealed FROM messages WHERE kind = 'note'").get();
  assert.equal(seen.status, 'delivered');
  assert.equal(seen.text, ''); assert.equal(seen.links, '[]');
  assert.doesNotMatch(seen.sealed, /Recipe|pasta/);

  // Other people can't see or touch Ben's bot
  assert.equal((await anna(`/app/bots/${botId}`)).status, 404);
});

test('login codes: wrong code, attempts limit, rate limit, magic link', async (t0) => {
  const env = await setup(t0);
  const b = browser(env.url);
  await b('/login', { method: 'POST', form: { email: 'x@example.com' } });
  for (let i = 0; i < 5; i++) assert.equal((await b('/login/verify', { method: 'POST', form: { email: 'x@example.com', code: '000000' } })).status, 400);
  const real = env.mail.at(-1).text.match(/code is (\d{6})/)[1];
  assert.match((await b('/login/verify', { method: 'POST', form: { email: 'x@example.com', code: real } })).text, /Too many wrong tries/); // locked after 5 tries
  for (let i = 0; i < 4; i++) await b('/login', { method: 'POST', form: { email: 'x@example.com' } });
  assert.match((await b('/login', { method: 'POST', form: { email: 'x@example.com' } })).text, /Too many/);
  const env2 = await setup(t0);
  const c = browser(env2.url);
  await c('/login', { method: 'POST', form: { email: 'y@example.com' } });
  const linkPath = env2.mail.at(-1).text.match(/(\/login\/link\?t=[\w-]+)/)[1];
  assert.match((await c(linkPath)).text, /Continue to/);                 // GET only shows a button
  assert.match((await browser(env2.url)(linkPath)).text, /same browser/);  // another browser can't use it
  assert.equal((await c('/login/link', { method: 'POST', form: { t: linkPath.split('t=')[1] } })).status, 303);
  assert.match((await c('/app')).location, /^\/app\/picture/, 'new people pick a picture first');
  await c('/app/picture', { method: 'POST', form: { avatar: 'classic' } });
  assert.match((await c('/app')).text, /Connect your Grok Bot/);
});

test('adding a second private-mode bot shows its setup code, and a bad name says why', async (t0) => {
  const env = await setup(t0);
  const ben = await signup(env, 'ben.second@example.com');
  await connectBot(env, ben, 'ben');

  const add = await ben('/app/bots/new', { method: 'POST' });
  assert.equal(add.location, '/app/bots/new-form');
  const bad = await ben('/app/bots', { method: 'POST', form: { handle: 'b2b test' } });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /Add another bot[^]*No spaces/);
  assert.match(bad.text, /value="b2b test"/);

  await ben('/app/bots', { method: 'POST', form: { handle: 'ben' } });
  assert.match((await ben('/app/bots', { method: 'POST', form: { handle: 'ben' } })).text, /That name is taken/);

  await ben('/app/bots', { method: 'POST', form: { handle: 'b2b-test' } });
  const dash = (await ben('/app')).text;
  assert.match(dash, /Connect @b2b-test/);
  assert.match(dash, /d\.bots>1/); // waits for the second bot, not the first
  const home = mkdtempSync(join(tmpdir(), 'b2b-app-second-'));
  await run(process.execPath, [CLI, 'enroll', env.url, dash.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]], { env: { ...process.env, B2B_HOME: home } });
  const after = (await ben('/app')).text;
  assert.match(after, /@b2b-test/);
  assert.doesNotMatch(after, /Connect @b2b-test/);
});
