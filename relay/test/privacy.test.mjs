// The owner's "ask me first" switch on the dashboard, and how bots hear about it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, login, browser, cliHome, connectHandled as connect, connectApp } from './helpers.mjs';

async function api(env, token, method, path, body) {
  const r = await fetch(env.url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}
async function bot(env, handle) {
  const b = await login(env, `${handle}@example.com`);
  await b('/app/bots', { method: 'POST', form: { handle } });
  const code = (await b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const { home, cli } = cliHome();
  const { json: r } = await api(env, '', 'POST', '/v1/enroll', { code });
  writeFileSync(join(home, 'config.json'), JSON.stringify({ relay: env.url, token: r.token, handle }));
  const botId = env.relay.db.prepare('SELECT id FROM bots WHERE handle = ?').get(handle).id;
  return { b, botId, cli, token: r.token, api: (method, path, body) => api(env, r.token, method, path, body) };
}
async function pair(t0, opts = {}) {
  const env = await setup(t0, { privacyPilot: true, ...opts });
  const a = await bot(env, 'alice'), b = await bot(env, 'bob');
  await connect(a, b, 'Alice');
  return { ...env, a, b };
}
// Pilot owners see the basket and change it on People; the switch itself is for owners outside the pilot.
const BASKET_ROW = /<dt>Basket<\/dt><dd><span class="hand basket-word">friends<\/span>( · asks you first)? · <a href="\/app\/people\/\d+\/\d+">Change<\/a>/;
const row = (env) => ({ ...env.relay.db.prepare('SELECT privacy_on, gen FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(env.a.botId, env.b.botId) });
const toggle = (env, who, on, extra = {}) => who('/app/contacts/privacy', { method: 'POST', form: { bot: env.a.botId, peer: env.b.botId, ...(on ? { on: '1' } : {}), ...extra } });
const REFUSAL = 'Not sent. owner_approval_required: your owner approves messages to this contact first. For now, pass the matter to your owner. Use propose_reply.\n';

test('privacy switch: hidden and 404 with the pilot off', async (t0) => {
  const env = await pair(t0, { privacyPilot: false });
  assert.doesNotMatch((await env.a.b('/app')).text, /Ask me before my bot writes|contacts\/privacy/);
  assert.equal((await toggle(env, env.a.b, true)).status, 404);
  assert.equal((await toggle(env, env.a.b, false)).status, 404);
  assert.equal(row(env).privacy_on, 0);
  assert.ok(row(env).gen > 0);
  assert.doesNotMatch(await env.a.cli('contacts'), /approves/);
});

test('privacy switch: the owner turns it on and off, and the bot is told plainly', async (t0) => {
  const env = await pair(t0);
  const { a } = env;
  let html = (await a.b('/app')).text;
  assert.equal(html.match(BASKET_ROW)?.[1], undefined);
  assert.doesNotMatch(html, /contacts\/privacy/);
  assert.equal((await a.api('POST', '/v1/messages', { to: '@bob', text: 'Before' })).status, 200);

  const r = await toggle(env, a.b, true);
  assert.equal(r.status, 303);
  assert.equal(r.location, `/app#f-${a.botId}-${env.b.botId}`);
  assert.equal(row(env).privacy_on, 1);
  html = (await a.b('/app')).text;
  assert.equal(html.match(BASKET_ROW)?.[1], ' · asks you first');
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM events WHERE kind = 'privacy_on'").get().n, 1);

  assert.match(await a.cli('contacts'), /^Bob\s+@bob {2}\[your owner approves messages to them first\]/m);
  await assert.rejects(a.cli('send', 'Bob', 'After'), (e) => e.stderr === REFUSAL && e.code === 1);
  const ask = (await env.b.api('POST', '/v1/messages', { to: '@alice', text: 'Free Friday?', kind: 'ask' })).json.id;
  await assert.rejects(a.cli('reply', ask, 'Yes'), (e) => e.stderr === REFUSAL);
  assert.doesNotMatch(await env.b.cli('contacts'), /approves/, 'only the side that turned it on');

  const protectedRow = row(env);
  // Saving the same state again changes nothing.
  assert.equal((await toggle(env, a.b, true)).status, 303);
  assert.deepEqual(row(env), protectedRow);
  // An unchecked switch sends no "on" field.
  assert.equal((await toggle(env, a.b, false)).status, 303);
  assert.equal(row(env).privacy_on, 0);
  assert.ok(row(env).gen > protectedRow.gen);
  assert.doesNotMatch(await a.cli('contacts'), /approves/);
  assert.match(await a.cli('send', 'Bob', 'After again'), /Sent msg_/);
});

test('privacy switch: only the owner, signed in, from our own pages', async (t0) => {
  const env = await pair(t0);
  const { a, b } = env;
  const before = row(env);
  // Bob owns the other side of this chat, not Alice's row.
  assert.equal((await toggle(env, b.b, true)).status, 404);
  assert.equal((await b.b('/app/contacts/privacy', { method: 'POST', form: { bot: b.botId, peer: b.botId, on: '1' } })).status, 404);
  // A stranger with no contacts at all.
  assert.equal((await toggle(env, await login(env, 'eve@example.com'), true)).status, 404);
  // Bot tokens and connected-app tokens are not a session.
  const app = await connectApp(env, await login(env, 'carol@example.com'), 'carol');
  for (const token of [a.token, app.tokens.access_token]) {
    const r = await toggle(env, browser(env.url, { authorization: `Bearer ${token}` }), true);
    assert.equal(r.status, 303);
    assert.match(r.location, /^\/login/);
  }
  assert.deepEqual(row(env), before);
});

test('privacy switch: a signed-in owner posting from another origin is refused', async (t0) => {
  const env = await pair(t0);
  const { a } = env;
  const before = row(env);
  // Alice's own session cookie, sent from another site and then with no origin.
  const cookies = [];
  await browser(env.url)('/login', { method: 'POST', form: { email: 'alice@example.com' } });
  const code = env.mail.filter((m) => m.to === 'alice@example.com').at(-1).text.match(/code is (\d{6})/)[1];
  const r = await fetch(`${env.url}/login/verify`, { method: 'POST', redirect: 'manual', headers: { origin: env.url, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'alice@example.com', code }) });
  for (const sc of r.headers.getSetCookie()) cookies.push(sc.split(';')[0]);
  const body = new URLSearchParams({ bot: a.botId, peer: env.b.botId, on: '1' });
  const post = (headers) => fetch(`${env.url}/app/contacts/privacy`, { method: 'POST', redirect: 'manual', headers: { cookie: cookies.join('; '), 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({})).status, 403);
  assert.equal((await post({ origin: 'null' })).status, 403);
  assert.equal((await post({ origin: env.url + '.evil.example' })).status, 403);
  assert.deepEqual(row(env), before);
  assert.equal((await post({ origin: env.url })).status, 303, 'the same session from our own page works');
  assert.equal(row(env).privacy_on, 1);
});

test('privacy switch: connected-app bots see the note and get a plain tool error', async (t0) => {
  const env = await setup(t0, { privacyPilot: true });
  const a = { b: await login(env, 'alice@example.com') }, b = { b: await login(env, 'bob@example.com') };
  const app = await connectApp(env, a.b, 'alice');
  await connectApp(env, b.b, 'bob');
  a.botId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'alice'").get().id;
  b.botId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'bob'").get().id;
  await connect(a, b, 'Alice');
  assert.doesNotMatch((await app.tool('list_contacts')).content[0].text, /approves/);
  assert.equal((await a.b('/app/contacts/privacy', { method: 'POST', form: { bot: a.botId, peer: b.botId, on: '1' } })).status, 303);
  assert.match((await app.tool('list_contacts')).content[0].text, /^Bob \(@bob\): connected · not end-to-end encrypted \(you use the connected app\) · your owner approves messages to them first$/m);
  const r = await app.tool('send_message', { to: 'Bob', text: 'Hi' });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'owner_approval_required: your owner approves messages to this contact first. For now, pass the matter to your owner. Use propose_reply.');
});

test('privacy switch: not offered on a web inbox, where the owner writes everything', async (t0) => {
  const env = await setup(t0, { privacyPilot: true, webInbox: true });
  const a = await bot(env, 'alice');
  const b = { b: await login(env, 'bob@example.com') };
  await connect(a, b, 'Alice', { web: true });
  assert.doesNotMatch((await b.b('/app')).text, /<dt>Basket<\/dt>/);
  assert.match((await a.b('/app')).text, /<dt>Basket<\/dt>/);
});

test('skills tell bots to hand an owner-approval refusal to their owner', () => {
  for (const f of ['../skill/SKILL.md', '../../plugin/skills/bot2bot-messaging/SKILL.md']) {
    assert.match(readFileSync(new URL(f, import.meta.url), 'utf8'), /approves messages to someone first, don't retry or rephrase\. Tell my owner/);
  }
});


test('privacy switch: the contact alias is escaped in the accessible label', async (t0) => {
  const env = await pair(t0, { privacyPilot: false });
  // Protection set during the pilot stays visible after it, so the owner can turn it off.
  env.relay.db.prepare('UPDATE contacts SET privacy_on = 1 WHERE owner_bot = ? AND peer_bot = ?').run(env.a.botId, env.b.botId);
  const alias = 'Bob </p><script>alert("x")</script> & friends';
  env.relay.db.prepare('UPDATE contacts SET alias = ? WHERE owner_bot = ? AND peer_bot = ?').run(alias, env.a.botId, env.b.botId);
  const html = (await env.a.b('/app')).text;
  const id = `f-${env.a.botId}-${env.b.botId}-ask`;
  assert.ok(html.includes(`id="${id}">Ask me before my bot writes to Bob &lt;/p&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; friends</p>`));
  assert.ok(html.includes(`aria-labelledby="${id}"`));
  assert.ok(!html.includes(alias));
});

test('privacy wording: CLI, package and connected app report the same release version', async (t0) => {
  const env = await setup(t0);
  const app = await connectApp(env, await login(env, 'alice@example.com'), 'alice');
  const init = await app.rpc('initialize', { protocolVersion: '2025-06-18' });
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.version, '0.19.6');
  assert.equal(init.body.result.serverInfo.version, pkg.version);
  assert.equal((await cliHome().cli('version')).trim(), pkg.version);
});


test('privacy switch: a failed audit insert rolls back policy and generations', async (t0) => {
  const env = await pair(t0);
  const before = env.relay.db.prepare('SELECT privacy_on, gen FROM contacts ORDER BY owner_bot').all();
  env.relay.db.exec(`CREATE TRIGGER reject_privacy_audit BEFORE INSERT ON events
    WHEN new.kind = 'privacy_on' BEGIN SELECT RAISE(ABORT, 'audit insert failed'); END;`);
  assert.equal((await toggle(env, env.a.b, true)).status, 500);
  assert.deepEqual(env.relay.db.prepare('SELECT privacy_on, gen FROM contacts ORDER BY owner_bot').all(), before);
  assert.match(await env.a.cli('send', 'Bob', 'The failed change was rolled back'), /Sent msg_/);
});
