// One send gate for bots, fixed receipts, readable replies, and authorization generations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setup, login, cliHome, connectHandled as connect, connectApp, msgId, ADMIN } from './helpers.mjs';

async function api(env, token, method, path, body) {
  const r = await fetch(env.url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json() };
}
const keys = () => ({ sign: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x, box: generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x });

async function bot(env, handle, encrypted = false) {
  const b = await login(env, `${handle}@example.com`);
  await b('/app/bots', { method: 'POST', form: { handle } });
  const code = (await b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const { home, cli } = cliHome();
  if (encrypted) await cli('enroll', env.url, code);
  else {
    const { json: r } = await api(env, '', 'POST', '/v1/enroll', { code });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ relay: env.url, token: r.token, handle }));
  }
  const cfg = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
  const botId = env.relay.db.prepare('SELECT id FROM bots WHERE handle = ?').get(handle).id;
  return { b, botId, home, cli, token: cfg.token, api: (method, path, body) => api(env, cfg.token, method, path, body) };
}
async function pair(t0, opts = {}, encrypted = false) {
  const env = await setup(t0, { privacyPilot: true, ...opts });
  const a = await bot(env, 'alice', encrypted), b = await bot(env, 'bob', encrypted);
  await connect(a, b, 'Alice');
  return { ...env, a, b };
}
const send = (b, text, extra = {}) => b.api('POST', '/v1/messages', { to: '@bob', text, ...extra });
const row = (env, a, b) => env.relay.db.prepare('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(a.botId, b.botId);
const gens = (env) => env.relay.db.prepare('SELECT gen FROM contacts ORDER BY owner_bot, peer_bot').all().map((c) => c.gen);
const bumped = (env, before) => {
  const after = gens(env);
  assert.equal(after.length, before.length);
  after.forEach((n, i) => assert.ok(n >= before[i] + 1));
};
const refused = (r) => { assert.equal(r.status, 403); assert.match(r.json.error, /^owner_approval_required:.*owner approves.*pass the matter to your owner/); };

test('gate: additive defaults, dark pilot, directional privacy and generation helper', async (t0) => {
  const env = await pair(t0, { privacyPilot: false });
  const { a, b, relay } = env;
  assert.equal(row(env, a, b).privacy_on, 0);
  assert.ok(row(env, a, b).gen >= env.now() - 1000);
  assert.equal((await a.api('GET', '/v1/contacts')).json.contacts[0].owner_approves_first, false);
  assert.throws(() => relay.setPrivacy(a.botId, b.botId, true), (e) => e.status === 404);
  assert.equal((await send(a, 'Same as before')).status, 200);
  // There is no bot-facing privacy mutation, even with an actor claim in the request.
  assert.equal((await a.api('POST', '/v1/contacts/privacy', { contact: '@bob', on: true, actor: 'owner_web' })).status, 404);
});

test('gate: raw API refuses every new kind, topic, auto and claimed owner flag', async (t0) => {
  const env = await pair(t0);
  const { a, b, relay } = env;
  const orig = (await b.api('POST', '/v1/messages', { to: '@alice', text: 'Question', kind: 'ask' })).json.id;
  const retry = { text: 'Before protection', client_id: 'retry-key' };
  assert.equal((await send(a, retry.text, retry)).status, 200);
  const initialGens = gens(env);
  relay.setPrivacy(a.botId, b.botId, true);
  assert.equal(row(env, a, b).privacy_on, 1);
  assert.equal(row(env, b, a).privacy_on, 0);
  bumped(env, initialGens);
  const protectedGens = gens(env);
  assert.equal((await a.api('GET', '/v1/contacts')).json.contacts[0].owner_approves_first, true);
  assert.equal((await b.api('GET', '/v1/contacts')).json.contacts[0].owner_approves_first, false);
  const before = relay.db.prepare('SELECT count(*) AS n FROM messages').get().n;
  for (const extra of [{ kind: 'note' }, { kind: 'ask' }, { kind: 'reply', reply_to: orig },
    { kind: 'ask', topic: 'availability', auto: true }, { kind: 'reply', reply_to: orig, auto: true },
    { viaWeb: true, actor: 'owner_web', ctx: { actor: 'owner_web' }, privacy_on: 0, again: true }]) {
    refused(await send(a, 'Not allowed', extra));
  }
  assert.equal(relay.db.prepare('SELECT count(*) AS n FROM messages').get().n, before);
  assert.equal((await b.api('POST', '/v1/messages', { to: '@alice', text: 'Other direction still works' })).status, 200);
  relay.setPrivacy(a.botId, b.botId, true);
  assert.deepEqual(gens(env), protectedGens, 'setting the same policy is a no-op');
  relay.setPrivacy(a.botId, b.botId, false);
  bumped(env, protectedGens);
  assert.equal((await send(a, 'Unprotected again')).status, 200);
});

test('gate: sealed API and real CLI sends, asks and replies cannot bypass protection', async (t0) => {
  const env = await pair(t0, {}, true);
  const { a, b, relay } = env;
  const id = msgId(await a.cli('send', 'Bob', 'Sealed before protection'));
  const original = msgId(await b.cli('send', 'Alice', 'Please answer', '--ask'));
  const sealed = relay.db.prepare('SELECT sealed, content_tag FROM messages WHERE id = ?').get(id);
  relay.setPrivacy(a.botId, b.botId, true);
  for (const extra of [{ kind: 'note' }, { kind: 'ask', topic: 'availability', auto: true }, { kind: 'reply', reply_to: original, auto: true }]) {
    refused(await a.api('POST', '/v1/messages', { to: '@bob', ...sealed, ...extra }));
  }
  for (const args of [['send', 'Bob', 'Sealed refusal'], ['send', 'Bob', 'Question', '--ask', '--topic', 'availability'], ['reply', original, 'Automatic answer', '--auto']]) {
    await assert.rejects(a.cli(...args), /owner_approval_required:/);
  }
  assert.equal(relay.db.prepare('SELECT count(*) AS n FROM messages').get().n, 2);
  assert.match(await b.cli('send', 'Alice', 'Unprotected sealed direction'), /End-to-end encrypted/);
});

test('gate: connected-app send_message and reply use the same gate', async (t0) => {
  const env = await setup(t0, { privacyPilot: true });
  const a = { b: await login(env, 'alice@example.com') }, b = { b: await login(env, 'bob@example.com') };
  const app = await connectApp(env, a.b, 'alice'), peer = await connectApp(env, b.b, 'bob');
  a.botId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'alice'").get().id;
  b.botId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'bob'").get().id;
  await connect(a, b, 'Alice');
  assert.equal((await app.tool('send_message', { to: 'Bob', text: 'Unprotected' })).isError, false);
  const incoming = await peer.tool('send_message', { to: 'Alice', text: 'Question', question: true });
  const id = incoming.content[0].text.match(/Sent (msg_[\w-]+)/)[1];
  // Topic grants now need owner authority throughout the governance pilot.
  env.relay.applyOwnerOps(a.botId, ['availability', 'wishlist'].map((topic) => ({ op: 'add_topic', contact: '@bob', topic })));
  assert.equal((await app.tool('allow_topics', { contact: 'Bob', topics: ['availability', 'wishlist'] })).isError, false);
  env.relay.setPrivacy(a.botId, b.botId, true);
  const widening = await app.tool('allow_topics', { contact: 'Bob', topics: ['location'] });
  assert.equal(widening.isError, true);
  assert.match(widening.content[0].text, /owner_only:/);
  assert.equal((await app.tool('allow_topics', { contact: 'Bob', topics: ['wishlist'] })).isError, false);
  for (const [name, args] of [['send_message', { to: 'Bob', text: 'No' }], ['send_message', { to: 'Bob', text: 'Question', topic: 'availability', question: true }], ['reply', { message_id: id, text: 'No', auto: true }]]) {
    const r = await app.tool(name, args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /owner_approval_required:/);
  }
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM messages').get().n, 2);
});

test('gate: owner web sends and replies still work on a protected row', async (t0) => {
  const env = await setup(t0, { privacyPilot: true, webInbox: true, hosted: true, billing: { freeMessages: 1 } });
  const a = await bot(env, 'alice');
  const b = { b: await login(env, 'bob@example.com') };
  await connect(a, b, 'Alice', { web: true });
  b.botId = env.relay.db.prepare("SELECT id FROM bots WHERE vendor = 'web'").get().id;
  const orig = (await send(a, 'Question for the owner', { to: `@${env.relay.db.prepare('SELECT handle FROM bots WHERE id = ?').get(b.botId).handle}`, kind: 'ask' })).json.id;
  env.relay.setPrivacy(b.botId, a.botId, true);
  for (const extra of [{}, { reply_to: orig }]) {
    const r = await b.b('/app/inbox/send', { method: 'POST', form: { bot: b.botId, peer: a.botId, text: 'Owner typed this', ...extra } });
    assert.equal(r.status, 303);
  }
  const sent = env.relay.db.prepare('SELECT via FROM messages WHERE from_bot = ?').all(b.botId);
  assert.deepEqual(sent.map((m) => m.via), ['web', 'web']);
});

test('gate: protected ack notes store only exact receipt codes, visible in CLI status', async (t0) => {
  const env = await pair(t0);
  const { a, b, relay } = env;
  relay.setPrivacy(b.botId, a.botId, true);
  for (const [i, note] of [undefined, 'private answer', 'failed security check', 'could not be opened by a connected-app bot', 'failed security check ', { toString: 'failed security check' }].entries()) {
    const id = (await send(a, `Message ${i}`)).json.id;
    const claim = (await b.api('POST', '/v1/inbox/claim', {})).json.messages.find((m) => m.id === id);
    const r = await b.api('POST', `/v1/messages/${id}/ack`, { lease: claim.lease, note });
    assert.equal(r.status, 200);
    const expected = typeof note === 'string' && ['failed security check', 'could not be opened by a connected-app bot'].includes(note) ? note : 'received';
    assert.equal((await a.api('GET', `/v1/messages/${id}`)).json.note, expected);
    if (note === 'private answer') {
      const status = await a.cli('status', id);
      assert.match(status, /received/);
      assert.doesNotMatch(status, /private answer/);
    }
  }
  relay.setPrivacy(b.botId, a.botId, false);
  const id = (await send(a, 'Unprotected receipt')).json.id;
  const claim = (await b.api('POST', '/v1/inbox/claim', {})).json.messages.find((m) => m.id === id);
  await b.api('POST', `/v1/messages/${id}/ack`, { lease: claim.lease, note: 'Normal free text' });
  assert.equal((await a.api('GET', `/v1/messages/${id}`)).json.note, 'Normal free text');
});

test('gate: status replies require a live body, unpaused caller and both unblocked rows', async (t0) => {
  const env = await pair(t0);
  const { a, b, relay } = env, db = relay.db;
  const orig = (await send(a, 'Question', { kind: 'ask' })).json.id;
  const reply = (await b.api('POST', '/v1/messages', { to: '@alice', text: 'Readable answer', kind: 'reply', reply_to: orig })).json.id;
  const read = async () => {
    const status = (await a.api('GET', `/v1/messages/${orig}`)).json;
    assert.equal(status.status === 'replied', !!status.reply);
    const sent = (await a.api('GET', '/v1/sent')).json.messages.find((m) => m.id === orig);
    assert.equal(sent.status === 'replied', !!status.reply);
    return status.reply;
  };
  for (const status of ['pending', 'claimed', 'delivered']) {
    db.prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, reply);
    assert.equal((await read()).text, 'Readable answer');
  }
  db.prepare("UPDATE messages SET status = 'pending', note = 'key_check' WHERE id = ?").run(reply);
  assert.equal(await read(), undefined);
  const hidden = await a.cli('status', orig);
  assert.doesNotMatch(hidden, /Readable answer|they replied|: replied|reply \(/);
  db.prepare('UPDATE messages SET note = NULL WHERE id = ?').run(reply);
  const cutoff = env.now() - 7 * 24 * 3_600_000;
  for (const status of ['pending', 'claimed']) {
    db.prepare('UPDATE messages SET status = ?, created_at = ? WHERE id = ?').run(status, cutoff, reply);
    assert.equal(await read(), undefined);
  }
  db.prepare("UPDATE messages SET status = 'delivered' WHERE id = ?").run(reply);
  assert.equal((await read()).id, reply, 'delivered replies do not expire as undelivered');
  db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(env.now(), reply);
  assert.equal((await b.api('GET', `/v1/messages/${orig}`)).json.reply, undefined, 'reply sender cannot use status to read it as incoming');
  db.prepare("UPDATE messages SET status = 'dropped' WHERE id = ?").run(reply);
  assert.equal(await read(), undefined);
  db.prepare("UPDATE messages SET status = 'delivered', body_purged_at = ? WHERE id = ?").run(env.now(), reply);
  assert.equal(await read(), undefined);
  db.prepare('UPDATE messages SET body_purged_at = NULL WHERE id = ?').run(reply);
  await a.b('/app/pause', { method: 'POST', form: { on: '1' } });
  assert.equal(await read(), undefined);
  await a.b('/app/pause', { method: 'POST', form: { on: '0' } });
  assert.equal((await read()).id, reply);
  for (const [owner, peer] of [[a, b], [b, a]]) {
    db.prepare('UPDATE contacts SET blocked = 1 WHERE owner_bot = ? AND peer_bot = ?').run(owner.botId, peer.botId);
    assert.equal(await read(), undefined);
    db.prepare('UPDATE contacts SET blocked = 0 WHERE owner_bot = ? AND peer_bot = ?').run(owner.botId, peer.botId);
    const c = row(env, owner, peer);
    db.prepare('DELETE FROM contacts WHERE owner_bot = ? AND peer_bot = ?').run(owner.botId, peer.botId);
    assert.equal(await read(), undefined);
    db.prepare('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at) VALUES (?, ?, ?, ?, ?)').run(owner.botId, peer.botId, c.alias, c.created_at, c.approved_at);
  }
  await b.api('POST', '/v1/contacts/block', { contact: '@alice' });
  assert.equal(await read(), undefined, 'actual block hides even delivered replies');
});

test('gate: protected topic lists can shrink but cannot widen through raw API, CLI or connector', async (t0) => {
  const env = await pair(t0, {}, true);
  const { a, b, relay } = env;
  relay.applyOwnerOps(a.botId, ['availability', 'wishlist'].map((topic) => ({ op: 'add_topic', contact: '@bob', topic })));
  assert.equal((await a.api('POST', '/v1/contacts/allow', { contact: '@bob', topics: ['availability', 'wishlist'] })).status, 200);
  relay.setPrivacy(a.botId, b.botId, true);
  const set = (topics) => a.api('POST', '/v1/contacts/allow', { contact: '@bob', topics });
  assert.equal((await set(['availability', 'wishlist', 'location'])).status, 403);
  assert.match((await set(['location'])).json.error, /^owner_only:/);
  await assert.rejects(a.cli('allow', 'Bob', 'location'), /owner_only:/);
  assert.deepEqual((await set([' WISHLIST '])).json.topics, ['wishlist']);
  assert.equal((await set(['wishlist'])).status, 200);
  assert.deepEqual((await set([])).json.topics, []);
  relay.setPrivacy(a.botId, b.botId, false);
  assert.equal((await set(['location'])).status, 403, 'pilot topic grants still require owner authority after the old switch is off');
  relay.applyOwnerOps(a.botId, [{ op: 'add_topic', contact: '@bob', topic: 'location' }]);
  assert.equal((await set(['location'])).status, 200);
});

test('gate: retries still dedupe before billing and conflicting client IDs still fail', async (t0) => {
  const env = await pair(t0, { hosted: true, billing: { freeMessages: 1 } });
  const { a, b, relay } = env;
  const first = await send(a, 'Only charged once', { client_id: 'same-send' });
  const retry = await send(a, 'Only charged once', { client_id: 'same-send' });
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.id, first.json.id);
  assert.equal(retry.json.duplicate, true);
  assert.equal((await send(a, 'Different content', { client_id: 'same-send' })).status, 409);
  const implicit = await send(a, 'Only charged once');
  assert.equal(implicit.json.duplicate, true);
  assert.equal(implicit.json.id, first.json.id);
  assert.equal((await send(a, 'Second billed message')).status, 402);
  relay.setPrivacy(a.botId, b.botId, true);
  const protectedRetry = await send(a, 'Only charged once', { client_id: 'same-send' });
  assert.equal(protectedRetry.status, 200);
  assert.equal(protectedRetry.json.id, first.json.id);
  assert.equal(protectedRetry.json.duplicate, true);
  assert.equal((await send(a, 'Changed', { client_id: 'same-send' })).status, 409);
  refused(await send(a, 'Second billed message'));
  assert.equal(relay.db.prepare("SELECT count(*) AS n FROM messages WHERE via = 'bot'").get().n, 1);
});

test('gate: generations bump both rows for bot and owner block, unblock, pause and disconnect', async (t0) => {
  const env = await pair(t0);
  const { a, b } = env;
  let before = gens(env);
  assert.equal((await a.api('POST', '/v1/contacts/block', { contact: '@bob' })).status, 200);
  bumped(env, before);
  before = gens(env);
  await a.b('/app/contacts/block', { method: 'POST', form: { bot: a.botId, peer: b.botId, unblock: '1' } });
  bumped(env, before);
  before = gens(env);
  await a.b('/app/contacts/block', { method: 'POST', form: { bot: a.botId, peer: b.botId } });
  bumped(env, before);
  before = gens(env);
  await a.b('/app/pause', { method: 'POST', form: { on: '1' } });
  bumped(env, before);
  before = gens(env);
  await a.b(`/app/bots/${a.botId}/disconnect`, { method: 'POST' });
  bumped(env, before);
});

test('gate: generations bump on setKeys and enrollment replacement, including unchanged keys', async (t0) => {
  const env = await pair(t0, { adminEnroll: true });
  const { a, relay } = env;
  const k = keys();
  let before = gens(env);
  assert.equal((await a.api('POST', '/v1/keys', { keys: k })).status, 200);
  bumped(env, before);
  before = gens(env);
  assert.equal((await a.api('POST', '/v1/keys', { keys: k })).json.already, true);
  assert.deepEqual(gens(env), before);
  for (const next of [keys(), k, k]) {
    before = gens(env);
    const code = (await api(env, ADMIN, 'POST', '/admin/reissue', { handle: 'alice' })).json.code;
    assert.equal((await api(env, '', 'POST', '/v1/enroll', { code, keys: next })).status, 200);
    bumped(env, before);
  }
  assert.equal(relay.db.prepare("SELECT vendor FROM bots WHERE id = ?").get(a.botId).vendor, 'grokbot');
});

test('gate: join replacement and quick-connect to private enrollment bump generations', async (t0) => {
  const env = await setup(t0, { privacyPilot: true });
  const a = { b: await login(env, 'alice@example.com') }, b = await bot(env, 'bob');
  const app = await connectApp(env, a.b, 'alice');
  a.botId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'alice'").get().id;
  await connect(a, b, 'Alice');
  let before = gens(env);
  const steps = await app.tool('turn_on_encryption');
  const code = steps.content[0].text.match(/b2b\.mjs enroll \S+ ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  assert.equal((await api(env, '', 'POST', '/v1/enroll', { code, keys: keys() })).status, 200);
  bumped(env, before);
  assert.equal((await app.rpc('ping')).status, 401);
  before = gens(env);
  const request = await api(env, '', 'POST', '/v1/join', { keys: keys(), name: 'Replacement' });
  const link = new URL(request.json.link).pathname;
  assert.equal((await a.b(link, { method: 'POST', form: { decision: 'allow', bot: a.botId } })).status, 303);
  bumped(env, before);
  assert.equal((await api(env, '', 'POST', '/v1/join/poll', { poll: request.json.poll })).json.status, 'joined');
});

test('gate: contact removal and account deletion bump generations before deleting rows', async (t0) => {
  const env = await pair(t0);
  const { a, b, relay } = env;
  relay.db.exec(`CREATE TABLE removed_gens (gen INTEGER);
    CREATE TRIGGER remember_gen BEFORE DELETE ON contacts BEGIN INSERT INTO removed_gens VALUES (old.gen); END;`);
  let before = gens(env);
  assert.equal((await a.b('/app/contacts/remove', { method: 'POST', form: { bot: a.botId, peer: b.botId } })).status, 303);
  assert.deepEqual(gens(env), []);
  relay.db.prepare('SELECT gen FROM removed_gens').all().forEach((r, i) => assert.ok(r.gen > before[i]));
  const removed = relay.db.prepare('SELECT gen FROM removed_gens').all().map((r) => r.gen);
  env.advance(1000);
  await connect(a, b, 'Alice');
  gens(env).forEach((n, i) => assert.ok(n > removed[i]));
  relay.db.exec('DELETE FROM removed_gens');
  before = gens(env);
  assert.equal((await a.b('/app/account/delete', { method: 'POST', form: { confirm: 'alice@example.com' } })).status, 200);
  assert.deepEqual(gens(env), []);
  relay.db.prepare('SELECT gen FROM removed_gens').all().forEach((r, i) => assert.ok(r.gen > before[i]));
});


test('gate: pilot off still lets owners remove existing protection after a restart', async (t0) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'b2b-privacy-')), 'relay.db');
  const first = await pair(t0, { dbPath });
  const { a, b } = first;
  first.relay.setPrivacy(a.botId, b.botId, true);
  first.relay.setPrivacy(b.botId, a.botId, true);
  refused(await send(a, 'Protected before restart'));
  first.relay.db.close();
  const env = await setup(t0, { dbPath, privacyPilot: false });
  const owner = await login(env, 'alice@example.com');
  const other = await login(env, 'bob@example.com');
  const form = { bot: a.botId, peer: b.botId, on: '0' };
  assert.match((await owner('/app')).text, /Ask me before my bot writes to Bob/);
  assert.equal((await other('/app/contacts/privacy', { method: 'POST', form })).status, 404);
  assert.equal((await owner('/app/contacts/privacy', { method: 'POST', form: { ...form, on: '1' } })).status, 404);
  refused(await api(env, a.token, 'POST', '/v1/messages', { to: '@bob', text: 'Still protected' }));
  env.relay.setPrivacy(b.botId, a.botId, false);
  assert.equal(row(env, b, a).privacy_on, 0, 'the transaction wrapper also works with pilot off');
  assert.equal((await owner('/app/contacts/privacy', { method: 'POST', form })).status, 303);
  assert.equal(row(env, a, b).privacy_on, 0);
  assert.doesNotMatch((await owner('/app')).text, /Ask me before my bot writes|contacts\/privacy/);
  assert.equal((await owner('/app/contacts/privacy', { method: 'POST', form })).status, 404);
  assert.equal((await api(env, a.token, 'POST', '/v1/messages', { to: '@bob', text: 'Unprotected after restart' })).status, 200);
});

test('gate: caller transactions roll back privacy and unknown actors cannot send protected messages', async (t0) => {
  const env = await pair(t0);
  const { a, b, relay } = env, db = relay.db;
  const before = gens(env);
  db.exec('BEGIN IMMEDIATE');
  relay.setPrivacyInTx(a.botId, b.botId, true);
  assert.equal(row(env, a, b).privacy_on, 1);
  db.exec('ROLLBACK');
  assert.equal(row(env, a, b).privacy_on, 0);
  assert.deepEqual(gens(env), before);
  relay.setPrivacy(a.botId, b.botId, true);
  const me = db.prepare('SELECT * FROM bots WHERE id = ?').get(a.botId);
  for (const ctx of [undefined, null, {}, { actor: 'owner_decision' }, { actor: 'owner' }, { actor: 'BOT' }, { actor: 'bot' }]) {
    db.exec('BEGIN IMMEDIATE');
    try {
      assert.throws(() => relay.enqueue(me, { to: '@bob', text: 'Unknown actor' }, ctx), (e) => e.status === 403 && /^owner_approval_required:/.test(e.message));
    } finally { db.exec('ROLLBACK'); }
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  db.exec('BEGIN IMMEDIATE');
  relay.enqueue(me, { to: '@bob', text: 'Owner transaction' }, { actor: 'owner_web' });
  assert.equal(db.prepare('SELECT via FROM messages').get().via, 'web');
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});

test('gate: pair changes leave other pairs alone, bot changes bump all its pairs', async (t0) => {
  const env = await pair(t0);
  const { a, b, relay } = env, c = await bot(env, 'carol');
  await connect(a, c, 'Alice');
  await connect(b, c, 'Bob');
  const snapshot = () => relay.db.prepare('SELECT owner_bot, peer_bot, gen FROM contacts ORDER BY owner_bot, peer_bot').all();
  const check = (before, affected) => {
    const after = snapshot();
    assert.equal(after.length, before.length);
    after.forEach((r, i) => {
      if (affected(r)) assert.ok(r.gen > before[i].gen);
      else assert.equal(r.gen, before[i].gen);
    });
  };
  const pairOnly = (r) => [a.botId, b.botId].includes(r.owner_bot) && [a.botId, b.botId].includes(r.peer_bot);
  for (const action of [
    () => relay.setPrivacy(a.botId, b.botId, true),
    () => a.api('POST', '/v1/contacts/block', { contact: '@bob' }),
    () => a.b('/app/contacts/block', { method: 'POST', form: { bot: a.botId, peer: b.botId, unblock: '1' } }),
  ]) {
    const before = snapshot();
    await action();
    check(before, pairOnly);
  }
  for (const action of [
    () => a.api('POST', '/v1/keys', { keys: keys() }),
    () => a.b('/app/pause', { method: 'POST', form: { on: '1' } }),
    () => a.b(`/app/bots/${a.botId}/disconnect`, { method: 'POST' }),
  ]) {
    const before = snapshot();
    await action();
    check(before, (r) => r.owner_bot === a.botId || r.peer_bot === a.botId);
  }
});

test('gate: explicit and implicit dedupe beat the hourly rate limit', async (t0) => {
  const env = await pair(t0, { limits: { sendPerHour: 1 } });
  const { a } = env;
  const first = await send(a, 'One message', { client_id: 'hourly-retry' });
  assert.equal(first.status, 200);
  assert.equal((await send(a, 'Over limit')).status, 429);
  for (const extra of [{ client_id: 'hourly-retry' }, {}]) {
    const retry = await send(a, 'One message', extra);
    assert.equal(retry.status, 200);
    assert.equal(retry.json.id, first.json.id);
    assert.equal(retry.json.duplicate, true);
  }
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
});

test('gate: connector status hides held replies and protected receipts stay fixed', async (t0) => {
  const env = await setup(t0, { privacyPilot: true });
  const a = { b: await login(env, 'alice@example.com') }, b = await bot(env, 'bob');
  const app = await connectApp(env, a.b, 'alice');
  a.botId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'alice'").get().id;
  await connect(a, b, 'Alice');
  const sent = await app.tool('send_message', { to: 'Bob', text: 'A question', question: true });
  const id = sent.content[0].text.match(/Sent (msg_[\w-]+)/)[1];
  const reply = (await b.api('POST', '/v1/messages', { to: '@alice', text: 'Secret answer', kind: 'reply', reply_to: id })).json.id;
  assert.match((await app.tool('message_status', { message_id: id })).content[0].text, /replied[^]*Secret answer/);
  env.relay.db.prepare("UPDATE messages SET note = 'key_check' WHERE id = ?").run(reply);
  const hidden = await app.tool('message_status', { message_id: id });
  assert.equal(hidden.isError, false);
  assert.doesNotMatch(hidden.content[0].text, /replied|Secret answer|reply:/);
  env.relay.db.prepare("UPDATE messages SET status = 'dropped' WHERE id = ?").run(reply);
  env.relay.setPrivacy(a.botId, b.botId, true);
  // A connector can't open a seal. Seed the pending transport record to exercise its auto-ack path.
  const sealedId = (await b.api('POST', '/v1/messages', { to: '@alice', text: 'Transport fixture' })).json.id;
  env.relay.db.prepare("UPDATE messages SET text = '', sealed = 'AA' WHERE id = ?").run(sealedId);
  const plainId = (await b.api('POST', '/v1/messages', { to: '@alice', text: 'Tell your owner' })).json.id;
  const inbox = await app.tool('check_inbox');
  assert.equal(inbox.isError, false);
  assert.equal(env.relay.db.prepare('SELECT note FROM messages WHERE id = ?').get(sealedId).note, 'could not be opened by a connected-app bot');
  const receipt = inbox.content[0].text.match(new RegExp(`receipt=(${plainId}~[\\w-]+)`))[1];
  assert.equal((await app.tool('mark_delivered', { receipt })).isError, false);
  assert.equal(env.relay.db.prepare('SELECT note FROM messages WHERE id = ?').get(plainId).note, 'received');
});


test('gate: generations use the clock and still advance when the counter is ahead', async (t0) => {
  const env = await pair(t0);
  const { a, b, relay } = env;
  env.advance(10_000);
  const minimum = env.now();
  relay.setPrivacy(a.botId, b.botId, true);
  gens(env).forEach((n) => assert.ok(n >= minimum));
  const ahead = env.now() + 10_000;
  relay.db.prepare('UPDATE contacts SET gen = ?').run(ahead);
  relay.setPrivacy(a.botId, b.botId, false);
  assert.deepEqual(gens(env), [ahead + 1, ahead + 1]);
});
