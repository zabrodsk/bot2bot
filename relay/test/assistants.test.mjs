// More assistants on quick connect: an app that signs in under a name we know (Poke, Instinct…) or one we don't. Each
// sets its own doorbell from its tool: its inbound API, or a recurring check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, listen, waitFor, cliHome } from './helpers.mjs';
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

test('only recognized app names get specific setup steps; unnamed apps and Cursor are generic', () => {
  assert.equal(platformForApp('Poke'), 'poke');
  assert.equal(platformForApp('Instinct'), 'instinct');
  assert.equal(platformForApp('Instinct AI'), 'instinct');
  assert.equal(platformForApp('instinctools'), 'other');
  assert.equal(platformForApp('Town'), 'town');
  assert.equal(platformForApp('Manus'), 'manus');
  assert.equal(platformForApp('Cue'), 'cue');
  assert.equal(platformForApp('Cue by Manus'), 'cue');
  assert.equal(platformForApp('Manus Cue'), 'cue');
  assert.equal(platformForApp('Cue OS'), 'other');
  assert.equal(platformForApp('Rescue'), 'other');
  assert.equal(platformForApp('Perplexity'), 'perplexity');
  assert.equal(platformForApp('Gemini'), 'other');
  assert.equal(platformForApp('ChatGPT'), 'chatgpt');
  assert.equal(platformForApp('OpenClaw'), 'openclaw');
  assert.equal(platformForApp('Grok Bot'), 'grok');
  assert.equal(platformForApp('xAI'), 'grok');
  for (const name of [undefined, null, '', ' ', 'An app', 'Cursor']) assert.equal(platformForApp(name), 'other');
  assert.equal(platformForApp('Some New Assistant'), 'other');
});

test('Cue setup uses its scheduled private-mode doorbell and waits for an independent test', () => {
  const prompt = setupPrompts({ origin: 'https://bot2bot.link' }).cue();
  assert.match(prompt, /join \S+ --agent cue --wait 100/);
  assert.match(prompt, /every 30 minutes[^]*same absolute B2B_HOME[^]*inbox --via doorbell/);
  assert.match(prompt, /Only after the task exists[^]*doorbell set --schedule[^]*separate scheduled run/);
  assert.match(prompt, /Do not read the test manually/);
  assert.doesNotMatch(prompt, /custom MCP|Grok Bot routine/);
});

test('an OAuth app with no name gets generic setup and encryption steps', async (t0) => {
  const env = await setup(t0);
  const b = await login(env, 'unnamed@example.com');
  const app = await connectApp(env, b, 'unnamed', null);
  assert.equal(botOf(env, 'unnamed').platform, 'other');
  const who = text(await app.tool('whoami'));
  assert.match(who, /inbound API or webhook[^]*recurring task/);
  assert.doesNotMatch(who, /Grok|routine called/);
  const steps = text(await app.tool('turn_on_encryption'));
  assert.match(steps, /No doorbell is configured[^]*Automatic delivery remains unverified/);
  assert.doesNotMatch(steps, /Edit your "b2b doorbell"|then do nothing for a minute/);
});

for (const [name, way] of [['Claude Duet', 'schedule'], ['Poke', 'webhook'], ['OpenClaw', 'schedule'], ['OpenClaw', 'webhook']]) {
  test(`${name}: encryption requires direct access and preserves its ${way} through enrollment`, async (t0) => {
    const env = await setup(t0);
    const b = await login(env, 'test@example.com');
    const app = await connectApp(env, b, 'test-assistant', name);
    const { s, url } = await listen((req, res) => res.end('{}'));
    t0.after(() => s.close());
    await app.tool('set_doorbell', { way, ...(way === 'webhook' ? { url: `${url}/inbound`, key: 'test-hook-key' } : {}) });
    await app.tool('test_doorbell');
    await pickUp(app);
    const before = botOf(env, 'test-assistant');
    const who = text(await app.tool('whoami'));
    assert.match(who, /A working MCP connector does not prove your computer can reach/);
    assert.ok(who.includes(`${env.url}/cli/b2b.mjs`));
    assert.match(who, /If access is already known to be blocked, do not retry/);
    assert.match(who, /do not offer to turn on encryption or call turn_on_encryption[^]*Keep quick connect/);
    assert.match(who, /Only if both checks pass[^]*Only if they say yes, call turn_on_encryption/);
    assert.doesNotMatch(who, /I can turn it on myself/);
    assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM enroll_codes WHERE handle = ?').get(before.handle).n, 0);

    const steps = text(await app.tool('turn_on_encryption'));
    assert.match(steps, /If installation or enrollment fails because access is blocked, stop, keep this app connected/);
    assert.doesNotMatch(steps, /Edit your "b2b doorbell"|then do nothing for a minute/);
    if (way === 'schedule') {
      assert.match(steps, /Keep your existing recurring task and its schedule[^]*inbox --via doorbell/);
      assert.match(steps, /let your recurring task pick up and acknowledge the test on its next run/);
    } else {
      assert.match(steps, /Keep your existing inbound API or webhook, including its URL and key[^]*inbox --via doorbell/);
    }
    // Asking for instructions has not switched or revoked quick connect.
    assert.equal(botOf(env, before.handle).vendor, 'connector');
    assert.equal((await app.rpc('ping')).status, 200);
    const { cli } = cliHome();
    const code = steps.match(/b2b\.mjs enroll \S+ ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
    await cli('enroll', env.url, code);
    const after = botOf(env, before.handle);
    for (const field of ['id', 'platform', 'doorbell_kind', 'webhook_url', 'webhook_key']) assert.equal(after[field], before[field], field);
    assert.ok(after.box_pub);
    assert.equal(after.doorbell_verified_at, null, 'the updated handling instruction needs a new test');
    assert.equal((await app.rpc('ping')).status, 401);
    env.advance(1000);
    await cli('doorbell', 'test');
    if (way === 'schedule') env.advance(15 * 60_000);
    const inbox = await cli('inbox', '--via', 'doorbell');
    const ack = inbox.match(/^[^|\n].*b2b\.mjs ack (msg_[\w~-]+)$/m)?.[1];
    assert.ok(ack, inbox);
    await cli('ack', ack);
    assert.ok(botOf(env, before.handle).doorbell_verified_at);
  });
}

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

test("an assistant whose sandbox can't reach the relay asks about quick connect instead of giving up", async (t0) => {
  const env = await setup(t0);
  const prompts = setupPrompts({ origin: env.url });
  const other = prompts.other();
  const at = (s) => { const i = other.indexOf(s); assert.ok(i >= 0, s); return i; };
  // After the steps that need the tool, before the generic failure step that needs it too.
  const fallback = at(`can't reach ${env.url}`);
  assert.ok(at('4. ') < fallback && fallback < at('If a step fails'));
  // The owner hears it isn't end-to-end encrypted and says yes before any connector steps.
  assert.ok(at("isn't end-to-end encrypted") < at('wait for my yes') && at('wait for my yes') < at(`${env.url}/mcp`));
  // Only before a join link went out, and the rest of the message is left behind.
  assert.match(other, /haven't given me a join link/);
  assert.match(other, /skip the rest of this message/);
  assert.match(other, /whoami/);
  assert.match(prompts.instinct(), /can't reach /);
  // On an invite page, the owner is sent back to the invite once the connector works.
  assert.ok(prompts.other('', 'other', `${env.url}/i/ABCD-EFGH`).includes(`open ${env.url}/i/ABCD-EFGH again`));
  // The dashboard's Other bots page offers quick connect for the same case, not only for bots without commands.
  const b = await login(env, 'oli@example.com');
  assert.equal((await b('/app/bots/add/other', { method: 'POST', form: { handle: 'oli-bot' } })).location, '/app/bots/add/other/steps');
  const steps = (await b('/app/bots/add/other/steps')).text;
  assert.match(steps, /can(?:'|&#39;|&#x27;)t reach bot2bot\?/);
  assert.ok(steps.includes(`${env.url}/mcp`));
});
