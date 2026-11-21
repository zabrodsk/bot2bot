// Private local relay only. No external bots, email service or deployment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setup, login, connectApp } from './helpers.mjs';

const DAY = 86_400_000;
const T = 't_abcdefgh12345678', OTHER = 't_otherabc12345678';
const pkg = (thread = T, id = 'h_abcdefgh12345678') => `---\nspec: b2b-handoff/1\nid: ${id}\nthread: ${thread}\nask: review\nrefs: []\n---\n## Goal\nReview the local test.\n## Current state\nThe test is ready.\n## Decisions\nUse a private relay.\n## Open questions\nNone.\n## Constraints\nNo real messages.\n## What I need from you\nA review.\n## How to verify\nnode --test\n`;
function fakeBot(env, handle) {
  const token = `local-test-token-${handle}`;
  const id = Number(env.relay.db.prepare('INSERT INTO bots (handle, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(handle, handle, createHash('sha256').update(token).digest('hex'), env.now()).lastInsertRowid);
  const api = async (method, path, body) => {
    const r = await fetch(env.url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  return { id, handle, api };
}
function pair(env, a, b) {
  for (const [from, to] of [[a, b], [b, a]]) env.relay.db.prepare('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at) VALUES (?, ?, ?, ?, ?)').run(from.id, to.id, to.handle, env.now(), env.now());
}
async function fixture(t) {
  const env = await setup(t, { limits: { sendPerHour: 1000, sendPerContactPer10Min: 1000 } });
  const a = fakeBot(env, 'alice'), b = fakeBot(env, 'bob'), c = fakeBot(env, 'carol');
  pair(env, a, b); pair(env, a, c); pair(env, b, c);
  return { env, a, b, c, q: (sql) => env.relay.db.prepare(sql) };
}
const send = (a, b, text, extra = {}) => a.api('POST', '/v1/messages', { to: `@${b.handle}`, text, ...extra });
const get = (a, id = T, query = '') => a.api('GET', `/v1/threads/${id}${query}`);
const close = (a, id = T) => a.api('POST', `/v1/threads/${id}/close`, {});

test('plaintext handoffs infer a thread, replies inherit it, and history pages within the actual pair', async (t) => {
  const { env, a, b, q } = await fixture(t);
  const first = await send(a, b, pkg(), { kind: 'ask', client_id: 'first' });
  assert.equal(first.status, 200); assert.equal(first.json.thread, T);
  const reply = await send(b, a, 'Reviewed.', { kind: 'reply', reply_to: first.json.id });
  assert.equal(reply.status, 200); assert.equal(reply.json.thread, T);
  const note = await send(a, b, 'Ready.', { thread: T });
  const independent = await send(a, b, 'Ready.', { thread: OTHER });
  assert.notEqual(note.json.id, independent.json.id, 'deduplication includes thread');
  assert.equal((await send(a, b, 'Different.', { thread: OTHER, client_id: 'first' })).status, 409);
  assert.equal((await send(b, a, 'Wrong thread.', { kind: 'reply', reply_to: first.json.id, thread: OTHER })).status, 400);
  assert.equal((await send(a, b, pkg(), { thread: OTHER })).status, 400);
  assert.equal((await send(a, b, 'Malformed', { thread: 'local-private-thread' })).status, 400);
  assert.equal((await a.api('GET', `/v1/messages/${reply.json.id}`)).json.thread, T);
  const claimed = (await b.api('POST', '/v1/inbox/claim', {})).json.messages;
  assert.equal(claimed.find((m) => m.id === first.json.id).thread, T);
  assert.equal((await b.api('POST', `/v1/messages/${first.json.id}/ack`, { lease: claimed.find((m) => m.id === first.json.id).lease })).status, 200);
  assert.equal((await b.api('GET', '/v1/received')).json.messages.find((m) => m.id === first.json.id).thread, T);
  // Old implementation lost a thread after 500 unrelated messages. Insert unrelated local fixture records.
  const insert = q("INSERT INTO messages (id,from_bot,to_bot,kind,text,created_at,status) VALUES (?, ?, ?, 'note', 'unrelated', ?, 'delivered')");
  for (let n = 0; n < 501; n++) insert.run(`noise_${n}`, a.id, b.id, env.now());
  const brief = (await get(b, T, '?brief=1&limit=1')).json;
  assert.equal(brief.thread.state, 'handed_off'); assert.equal(brief.thread.encrypted, false);
  assert.equal(brief.latest_package.id, first.json.id);
  assert.deepEqual(brief.messages.map((m) => m.id), [reply.json.id]);
  assert.equal(brief.more, true);
  const next = (await get(b, T, `?brief=1&after=${brief.next_after}&limit=1`)).json;
  assert.deepEqual(next.messages.map((m) => m.id), [note.json.id]); assert.equal(next.more, false);
  assert.equal((await get(b, T, `?after=${independent.json.id}`)).status, 400);
  assert.deepEqual((await get(b)).json.messages.map((m) => m.id), [first.json.id, reply.json.id, note.json.id]);
});

test('a guessed thread cannot cross contacts, bypass owner consent or expose held text', async (t) => {
  const { a, b, c, q } = await fixture(t);
  const sent = await send(a, b, pkg());
  assert.equal((await get(c)).status, 404); assert.equal((await close(c)).status, 404);
  assert.equal((await send(c, a, 'Mix into someone else’s work', { thread: T })).status, 409);
  assert.equal((await send(c, b, pkg())).status, 409);
  assert.equal(q('SELECT count(*) AS n FROM task_threads').get().n, 1);
  q("UPDATE messages SET note = 'key_check' WHERE id = ?").run(sent.json.id);
  assert.equal((await get(b)).json.messages.length, 0);
  q('UPDATE messages SET note = NULL WHERE id = ?').run(sent.json.id);
  q('UPDATE contacts SET blocked = 1 WHERE owner_bot = ? AND peer_bot = ?').run(a.id, b.id);
  assert.equal((await get(b)).status, 403); assert.equal((await get(a)).status, 403);
  assert.equal((await close(b)).status, 403);
  q('UPDATE contacts SET blocked = 0, approved_at = NULL WHERE owner_bot = ? AND peer_bot = ?').run(a.id, b.id);
  assert.equal((await get(b)).status, 403); assert.equal((await close(a)).status, 403);
  q('UPDATE contacts SET approved_at = 1').run();
  q('UPDATE bots SET paused_at = 1 WHERE id = ?').run(b.id);
  assert.equal((await get(b)).status, 403); assert.equal((await close(b)).status, 403);
});

test('thread retention extends pending and delivered history, while ordinary mail expires after seven days', async (t) => {
  const { env, a, b, q } = await fixture(t);
  const first = await send(a, b, pkg());
  const plain = await send(a, b, 'Ordinary mail');
  const delivered = await send(b, a, 'Old delivered message', { thread: T });
  q("UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id IN (?, ?)").run(env.now(), plain.json.id, delivered.json.id);
  const ttl = q('SELECT expires_at FROM task_threads WHERE id = ?').get(T).expires_at;
  env.advance(8 * DAY); env.relay.retention();
  assert.ok(q('SELECT body_purged_at FROM messages WHERE id = ?').get(plain.json.id).body_purged_at);
  assert.equal(q('SELECT body_purged_at FROM messages WHERE id = ?').get(delivered.json.id).body_purged_at, null);
  assert.equal(q('SELECT status FROM messages WHERE id = ?').get(first.json.id).status, 'pending');
  assert.ok((await b.api('POST', '/v1/inbox/claim', {})).json.messages.some((m) => m.id === first.json.id));
  assert.equal((await get(b)).json.messages.length, 2);
  env.advance(21 * DAY);
  const recent = await send(b, a, 'Another update', { thread: T, client_id: 'update' });
  assert.equal(recent.status, 200);
  const renewed = q('SELECT expires_at FROM task_threads WHERE id = ?').get(T).expires_at;
  assert.ok(renewed > ttl + 28 * DAY);
  env.advance(2 * DAY); env.relay.retention();
  assert.ok((await get(b)).json.messages.some((m) => m.id === first.json.id));
  await send(b, a, 'Another update', { thread: T, client_id: 'update' });
  assert.equal(q('SELECT expires_at FROM task_threads WHERE id = ?').get(T).expires_at, renewed, 'retry does not renew history');
  env.advance(29 * DAY); env.relay.retention();
  assert.equal((await get(b)).json.thread.state, 'expired');
  assert.deepEqual((await get(b)).json.messages, []);
  assert.ok(q('SELECT body_purged_at FROM messages WHERE id = ?').get(first.json.id).body_purged_at);
  assert.equal((await send(a, b, 'Cannot resurrect', { thread: T })).status, 409);
});

test('closing is pair scoped and idempotent, caps retention and refuses new messages', async (t) => {
  const { env, a, b, q } = await fixture(t);
  const sent = await send(a, b, pkg(), { client_id: 'package' });
  env.advance(8 * DAY);
  const closed = await close(b);
  assert.equal(closed.status, 200); assert.equal(closed.json.thread.state, 'closed');
  assert.ok(Date.parse(closed.json.thread.expires_at) <= env.now() + 2 * DAY);
  assert.equal((await send(a, b, 'New message', { thread: T })).status, 409);
  assert.equal((await send(a, b, pkg(), { client_id: 'package' })).json.id, sent.json.id);
  env.advance(1 * DAY);
  assert.equal((await close(a)).json.thread.expires_at, closed.json.thread.expires_at);
  env.relay.retention(); assert.ok((await get(a)).json.messages.length);
  env.advance(2 * DAY); env.relay.retention();
  assert.equal(q('SELECT text FROM messages WHERE id = ?').get(sent.json.id).text, '');
  assert.deepEqual((await get(b)).json.messages, []);
});

test('quick-connect tools use scoped history, carry a plain thread and expose close as an owner action', async (t) => {
  const { env, a, q } = await fixture(t);
  const owner = await login(env, 'thread-owner@example.com');
  const app = await connectApp(env, owner, 'thread-app');
  const b = q('SELECT id, handle FROM bots WHERE handle = ?').get('thread-app');
  pair(env, a, b);
  const first = await send(a, b, pkg());
  const tools = (await app.rpc('tools/list')).body.result.tools;
  assert.match(tools.find((tool) => tool.name === 'thread_close').description, /only when your owner asks/);
  assert.equal(tools.find((tool) => tool.name === 'thread_close').annotations.destructiveHint, true);
  assert.match((await app.tool('thread_brief', { thread: T })).content[0].text, /Latest package:[\s\S]*Review the local test/);
  assert.equal((await app.tool('send_message', { to: '@alice', text: 'Continuing', thread: T })).isError, false);
  assert.equal(q("SELECT thread_id FROM messages WHERE text = 'Continuing'").get().thread_id, T);
  assert.equal((await app.tool('reply', { message_id: first.json.id, text: 'Result' })).isError, false);
  assert.equal(q("SELECT thread_id FROM messages WHERE text = 'Result'").get().thread_id, T);
  const inbox = await app.tool('check_inbox');
  assert.match(inbox.content[0].text, new RegExp(`thread: ${T}`));
  assert.match((await app.tool('thread_close', { thread: T })).content[0].text, /Closed thread.*both participants.*Not end-to-end encrypted/);
  assert.equal((await app.tool('send_message', { to: '@alice', text: 'Closed', thread: T })).isError, true);
  const exported = (await owner('/app/account/export')).json();
  assert.equal(exported.threads[0].id, T);
  assert.ok(exported.messages.some((m) => m.thread === T));
  assert.equal((await owner('/app/account/delete', { method: 'POST', form: { confirm: 'thread-owner@example.com' } })).status, 200);
  assert.equal(q('SELECT count(*) AS n FROM task_threads WHERE id = ?').get(T).n, 0);
  assert.equal(q('SELECT text FROM messages WHERE id = ?').get(first.json.id).text, '');
});

test('private mode never stores or returns a relay thread and rejects exposed thread metadata', async (t) => {
  const { a, b, q } = await fixture(t);
  q("UPDATE bots SET box_pub = 'test-public-key', sign_pub = 'test-sign-key' WHERE id IN (?, ?)").run(a.id, b.id);
  const sealed = `b2b1.${'a'.repeat(43)}.${'b'.repeat(16)}.ciphertext.${'c'.repeat(86)}`;
  const exposed = await a.api('POST', '/v1/messages', { to: '@bob', sealed, thread: T });
  assert.equal(exposed.status, 400); assert.match(exposed.json.error, /inside the encrypted message/);
  const privateMessage = await a.api('POST', '/v1/messages', { to: '@bob', sealed });
  assert.equal(privateMessage.status, 200); assert.equal(privateMessage.json.thread, undefined);
  assert.equal(q('SELECT thread_id FROM messages WHERE id = ?').get(privateMessage.json.id).thread_id, null);
  assert.equal(q('SELECT count(*) AS n FROM task_threads').get().n, 0);
  assert.equal((await get(b)).status, 404);
});
