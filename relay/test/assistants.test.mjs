// More assistants on quick connect: an app that signs in under a name we know (Poke, Instinct…) or one we don't. Each
// sets its own doorbell from its tool: its inbound API, or a recurring check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, listen, waitFor } from './helpers.mjs';
import { connectApp } from './helpers.mjs';
import { generateKeyPairSync } from 'node:crypto';
import { platformForApp } from '../platforms.mjs';
import { setupPrompts } from '../setup-prompts.mjs';

const text = (r) => r.content.map((c) => c.text).join('\n');
const botOf = (env, handle) => env.relay.db.prepare('SELECT * FROM bots WHERE handle = ?').get(handle);
// What a woken assistant does: read the inbox and confirm the test message with the receipt it got.
async function pickUp(app) {
  const inbox = text(await app.tool('check_inbox'));
  const receipt = inbox.match(/receipt=(\S+)/)?.[1];
  assert.ok(receipt, inbox);
  await app.tool('mark_delivered', { receipt });
}

test('an app is known by the name it signs in with; no name stays Grok Bot', () => {
  assert.equal(platformForApp('Poke'), 'poke');
  assert.equal(platformForApp('Instinct'), 'instinct');
  assert.equal(platformForApp('Instinct AI'), 'instinct');
  assert.equal(platformForApp('instinctools'), 'other');
  assert.equal(platformForApp('Town'), 'town');
  assert.equal(platformForApp('Manus'), 'manus');
  assert.equal(platformForApp('Perplexity'), 'perplexity');
  assert.equal(platformForApp('Gemini'), 'other');
  assert.equal(platformForApp('ChatGPT'), 'chatgpt');
  assert.equal(platformForApp('OpenClaw'), 'openclaw');
  assert.equal(platformForApp('Grok Bot'), null);
  assert.equal(platformForApp('An app'), null);
  assert.equal(platformForApp('Some New Assistant'), 'other');
});

test('Instinct keeps its own name without a Beta label and gets the generic delivery choices', async (t0) => {
  const env = await setup(t0);
  const b = await login(env, 'ian@example.com');
  const app = await connectApp(env, b, 'ian-instinct', 'Instinct');
  assert.equal(botOf(env, 'ian-instinct').platform, 'instinct');
  const who = text(await app.tool('whoami'));
  assert.match(who, /inbound API or webhook/);
  assert.match(who, /recurring task/);
  assert.doesNotMatch(who, /routine called/);
  const home = (await b('/app')).text;
  const at = home.indexOf('data-origin="instinct"');
  assert.ok(at >= 0);
  const line = home.slice(home.lastIndexOf('<li>', at), home.indexOf('</li>', at));
  assert.match(line, /Instinct/);
  assert.doesNotMatch(line, /Beta/);
});

test('Instinct in private mode: it says so when it joins, and the dashboard shows its name and logo', async (t0) => {
  const env = await setup(t0);
  const b = await login(env, 'ian@example.com');
  assert.match(setupPrompts({ origin: env.url }).instinct(), /join \S+ --agent instinct --wait 100/);
  const keys = { sign: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x, box: generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x };
  const post = (path, body) => fetch(env.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const req = await post('/v1/join', { keys, name: 'ian-instinct', agent: 'instinct' });
  assert.equal((await b(new URL(req.link).pathname, { method: 'POST', form: { decision: 'allow', bot: 'new', handle: 'ian-instinct' } })).status, 303);
  assert.equal((await post('/v1/join/poll', { poll: req.poll })).status, 'joined');
  assert.equal(botOf(env, 'ian-instinct').platform, 'instinct');
  const home = (await b('/app')).text;
  const at = home.indexOf('data-origin="instinct"');
  assert.ok(at >= 0);
  const line = home.slice(home.lastIndexOf('<li>', at), home.indexOf('</li>', at));
  assert.match(line, /Instinct/);
  assert.doesNotMatch(line, /Beta/);
});

test('Poke: its own name on the dashboard, its inbound API as the doorbell, never the Grok routine', async (t0) => {
  const env = await setup(t0);
  const got = [];
  const { s, url } = await listen(async (req, res) => { let body = ''; for await (const c of req) body += c; got.push({ path: req.url, auth: req.headers.authorization, json: JSON.parse(body) }); res.writeHead(200); res.end('{}'); });
  t0.after(() => s.close());
  const b = await login(env, 'pia@example.com');
  const poke = await connectApp(env, b, 'pia-poke', 'Poke');
  assert.equal(botOf(env, 'pia-poke').platform, 'poke');
  const who = text(await poke.tool('whoami'));
  assert.match(who, /NEXT STEP: turn on your doorbell[^]*1\. If you have an inbound API[^]*way=webhook/);
  assert.doesNotMatch(who, /routine called|Grok Bot/);
  const home = (await b('/app')).text;
  assert.match(home, /Poke/);
  assert.match(home, /viewBox="95 95 322 322"/, "Poke's own logo, not the plug");

  assert.match(text(await poke.tool('set_doorbell', { way: 'webhook', url: `${url}/api/v1/inbound/api-message`, key: 'poke-api-key-123' })), /Doorbell saved/);
  assert.match(text(await poke.tool('test_doorbell')), /Called your API \(HTTP 200\)/);
  const ring = await waitFor(() => got.at(-1));
  assert.equal(ring.path, '/api/v1/inbound/api-message');
  assert.equal(ring.auth, 'Bearer poke-api-key-123');
  assert.equal(ring.json.data, ring.json.message, 'Town reads data');
  assert.match(ring.json.message, /^bot2bot: messages from a friend's bot may be waiting for you\. Use the bot2bot app's check_inbox tool/);
  await pickUp(poke);
  assert.ok(botOf(env, 'pia-poke').doorbell_verified_at, 'verified once it picked up the test');
  const page = (await b(`/app/bots/${botOf(env, 'pia-poke').id}`)).text;
  assert.match(page, /Woken through its API/);
});

test('schedule: nothing is rung; the recurring task picks up the test, and an app we don\'t know gets every way to choose from', async (t0) => {
  const env = await setup(t0);
  const b = await login(env, 'sam@example.com');
  const app = await connectApp(env, b, 'sam-bot', 'Some New Assistant');
  assert.equal(botOf(env, 'sam-bot').platform, 'other');
  const who = text(await app.tool('whoami'));
  assert.match(who, /webhook[^]*recurring task/);
  assert.doesNotMatch(who, /email/);
  assert.doesNotMatch(who, /routine called/);
  assert.match((await b('/app')).text, /Some New Assistant/);
  await app.tool('set_doorbell', { way: 'schedule' });
  assert.match(text(await app.tool('test_doorbell')), /Your recurring task picks it up on its next run/);
  // Half an hour later its task runs: well past a ring's 10 minutes, and it still counts.
  env.advance(30 * 60_000);
  await pickUp(app);
  assert.ok(botOf(env, 'sam-bot').doorbell_verified_at);
  assert.match(text(await app.tool('whoami')), /Doorbell: your recurring task ·/);
});
