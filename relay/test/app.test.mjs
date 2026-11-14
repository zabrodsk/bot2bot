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

// A tiny browser: keeps its cookies, sends Origin on POST like a real form.
function browser(base) {
  const jar = {};
  return async (path, { method = 'GET', form, json } = {}) => {
    const headers = { origin: base };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
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
  assert.match((await ben('/app')).text, /Connect your bot[^]*href="\/app\/bots\/add\/grok"[^]*Grok Bot/);
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
  // The page leads with the owner's one step (two values from the routine, on a computer), with a button to Grok Bot's
  // routines; testing is part of it. A bot that never made its routine: the exact message for it, folded away.
  const bell = (await ben(`/app/bots/${botId}`)).text;
  assert.match(bell, /<ol class="stepper[^]*Connect your bot[^]*Turn on the doorbell[^]*<\/ol>/);
  assert.doesNotMatch(bell.match(/<ol class="stepper[^]*?<\/ol>/)[0], /Test the doorbell/);
  assert.match(bell, /class="phone-only"[^]*open this page on a computer/i);
  assert.match(bell, /href="https:\/\/cursor\.com\/grok-bot\/link\/v1\/sidebar\?tab=routines"[^>]*>Open routines/);
  // Its arrow is sized like the text, not stretched to the card's width.
  assert.match(bell, /class="link" href="https:\/\/cursor\.com[^>]*>Open routines<svg/);
  assert.match(bell, /\.link svg\{width:14px;height:14px/);
  assert.match(bell, /Save and test[^]*<details class="diy"><summary>No b2b doorbell routine\?<\/summary>[^]*Make a routine called &quot;b2b doorbell&quot; with a webhook trigger and this exact instruction: &quot;b2b messages may be waiting for my owner\. Run `node ~\/bin\/b2b\.mjs inbox --via doorbell`/);
  assert.match((await ben('/app')).text, /Set up @ben[^]*1 of 3 done/);
  assert.equal((await ben(`/app/bots/${botId}/doorbell`, { method: 'POST', form: { url: 'https://evil.example/x', key: 'k-12345678' } })).status, 400);
  // The two boxes the wrong way round still work.
  assert.equal((await ben(`/app/bots/${botId}/doorbell`, { method: 'POST', form: { url: 'k-12345678', key: `${hookUrl}/automations/webhook/1` } })).status, 303);
  assert.equal(env.relay.db.prepare('SELECT webhook_url FROM bots WHERE id = ?').get(Number(botId)).webhook_url, `${hookUrl}/automations/webhook/1`);
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
  assert.match(landing.text, /Add the setup bot[^]*href="\/connect\/chatgpt\?invite=[A-Z0-9]{4}-[A-Z0-9]{4}"/);
  assert.match(landing.text, /Email verified/);

  // Anna signs up, connects her bot, accepts the link
  const anna = await signup(env, 'anna@example.com');
  const annaBot = await connectBot(env, anna, 'anna');
  assert.match((await anna(`/i/${link}`)).text, />Connect<\/button>/);
  const accepted = await anna(`/i/${link}`, { method: 'POST', form: { bot: (await anna('/app')).text.match(/\/app\/bots\/(\d+)/)[1], alias: 'Ben' } });
  assert.match(accepted.text, /You're connected/);
  assert.match((await ben('/app')).text, /item__title">Anna</);   // inviter sees the friend's real name, not "friend-xxxx"
  assert.match((await anna(`/i/${link}`)).text, /already connected[^]*Go to overview/);
  assert.equal((await browser(env.url)(`/i/${link}`)).status, 410);

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
  // Each one a minute apart (one right after another is the same request, sent once).
  const later = () => env.relay.db.prepare('UPDATE login_codes SET created_at = created_at - 60000').run();
  for (let i = 0; i < 4; i++) { later(); await b('/login', { method: 'POST', form: { email: 'x@example.com' } }); }
  later();
  assert.match((await b('/login', { method: 'POST', form: { email: 'x@example.com' } })).text, /Too many/);
  const env2 = await setup(t0);
  const c = browser(env2.url);
  await c('/login', { method: 'POST', form: { email: 'y@example.com' } });
  const linkPath = env2.mail.at(-1).text.match(/(\/login\/link\?t=[\w-]+)/)[1];
  assert.match((await c(linkPath)).text, /Continue to/);                 // GET only shows a button
  assert.match((await browser(env2.url)(linkPath)).text, /same browser/);  // another browser can't use it
  assert.equal((await c('/login/link', { method: 'POST', form: { t: linkPath.split('t=')[1] } })).status, 303);
  // New people connect a bot first; their name and picture come after.
  assert.match((await c('/app')).text, /Connect your bot/);
});

test('adding a bot is a page of its own: pick the platform, name it, then only its steps', async (t0) => {
  const env = await setup(t0);
  const ben = await signup(env, 'ben.second@example.com');
  await connectBot(env, ben, 'ben');

  // The overview's button opens the page; the old ways in lead there too.
  assert.match((await ben('/app')).text, /href="\/app\/bots\/add"[^>]*>[^]*Add a bot/);
  assert.equal((await ben('/app/bots/new', { method: 'POST' })).location, '/app/bots/add');
  const pick = (await ben('/app/bots/add')).text;
  assert.match(pick, /Which bot\?[^]*href="\/app\/bots\/add\/grok"[^]*Grok Bot[^]*href="\/app\/bots\/add\/dots"[^]*href="\/app\/bots\/add\/openclaw"[^]*href="\/app\/bots\/add\/hermes"[^]*href="\/app\/bots\/add\/instinct"[^]*href="\/app\/bots\/add\/claude-code"[^]*href="\/app\/bots\/add\/codex"[^]*href="\/app\/bots\/add\/cursor"[^]*href="\/app\/bots\/add\/other"/);
  assert.match((await ben('/app/bots/add/grok')).text, /What should your bot be called\?[^]*name="handle"/);

  // A bad name says why; a taken one too.
  const bad = await ben('/app/bots/add/grok', { method: 'POST', form: { handle: 'b2b test' } });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /No spaces/);
  assert.match(bad.text, /value="b2b test"/);
  assert.equal((await ben('/app/bots/add/grok', { method: 'POST', form: { handle: 'ben' } })).status, 409);

  // Grok Bot: the setup code holds the name. Its page is Grok Bot's alone, and waits for the second bot.
  assert.equal((await ben('/app/bots/add/grok', { method: 'POST', form: { handle: 'b2b-test' } })).location, '/app/bots/add/grok/steps');
  const steps = (await ben('/app/bots/add/grok/steps')).text;
  assert.match(steps, /Connect @b2b-test[^]*Copy this message[^]*Message for Grok Bot[^]*join with code[^]*Grok Bot app[^]*Waiting for your bot to join[^]*Cancel setup/);
  assert.doesNotMatch(steps, /Instinct|OpenClaw|Claude Code|Codex|Hermes/);
  assert.match(steps, /d\.bots>1/);
  // The overview only points back to it.
  assert.match((await ben('/app')).text, /Connect @b2b-test[^]*href="\/app\/bots\/add\/grok\/steps"/);
  // Cancelling ends the setup with a toast whose Undo starts it again under the same name.
  await ben('/app/bots/cancel', { method: 'POST' });
  const cancelled = (await ben('/app')).text;
  assert.doesNotMatch(cancelled, /Connect @b2b-test/);
  assert.match(cancelled, /Setup cancelled[^]*action="\/app\/bots"[^]*name="handle" value="b2b-test"[^]*Undo/);
  assert.equal((await ben('/app/bots', { method: 'POST', form: { handle: 'b2b-test', undo: '1' } })).location, '/app/bots/add/grok/steps');
  const again = (await ben('/app/bots/add/grok/steps')).text;
  const home = mkdtempSync(join(tmpdir(), 'b2b-app-second-'));
  await run(process.execPath, [CLI, 'enroll', env.url, again.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]], { env: { ...process.env, B2B_HOME: home } });
  const after = (await ben('/app')).text;
  assert.match(after, /@b2b-test/);
  assert.doesNotMatch(after, /Connect @b2b-test/);
  // Once it joins, the page goes on to the new bot's own page.
  const newest = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'b2b-test'").get().id;
  assert.equal((await ben('/app/bots/add/done')).location, `/app/bots/${newest}`);

  // Any other platform: the name rides in the message it pastes (join --name), and its page is its own.
  assert.equal((await ben('/app/bots/add/codex', { method: 'POST', form: { handle: 'ben-codex' } })).location, '/app/bots/add/codex/steps');
  const codex = (await ben('/app/bots/add/codex/steps')).text;
  assert.match(codex, /Connect @ben-codex[^]*open Codex and paste this message[^]*b2b\.mjs join \S* ?--name ben-codex --agent codex/);
  assert.doesNotMatch(codex, /Grok Bot|Instinct|OpenClaw|Hermes/);
  // An app that signs in (dots, other bots) finds the name already filled in.
  await ben('/app/bots/add/dots', { method: 'POST', form: { handle: 'ben-dot' } });
  const meta = await (await fetch(`${env.url}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(new URL(meta.registration_endpoint, env.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'] }) })).json();
  const consent = (await ben(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect', code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' })}`)).text;
  assert.match(consent, /name="handle"[^>]*value="ben-dot"/);
});
