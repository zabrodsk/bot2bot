// Governance runs entirely against local fixtures. No real bots, webhooks or mail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, login, browser } from './helpers.mjs';
import { openDb, createRelay } from '../server.mjs';
import { migrateGovernance, createGovernance } from '../governance.mjs';

const DAY = 86_400_000;
const hash = (s) => createHash('sha256').update(s).digest('hex');
const keys = () => ({ sign: generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x, box: generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x });
const SEALED = `b2b1.${'A'.repeat(43)}.${'A'.repeat(16)}.${'A'.repeat(32)}.${'A'.repeat(86)}`;
async function fixture(t, opts = {}) {
  const env = await setup(t, { privacyPilot: true, ...opts });
  const { db } = env.relay;
  const add = (handle) => {
    const uid = Number(db.prepare("INSERT INTO users(email, name, created_at, tz, avatar) VALUES (?, ?, ?, 'UTC', 'classic')").run(`${handle}@example.com`, handle, env.now()).lastInsertRowid);
    const raw = `fixture-token-${handle}`;
    const id = Number(db.prepare('INSERT INTO bots(handle, display_name, user_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(handle, handle, uid, hash(raw), env.now()).lastInsertRowid);
    const api = async (method, path, body) => {
      const r = await fetch(env.url + path, { method, headers: { authorization: `Bearer ${raw}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };
    return { id, uid, raw, api, me: () => db.prepare('SELECT * FROM bots WHERE id = ?').get(id) };
  };
  const a = add('alice'), b = add('bob'), c = add('carol');
  for (const peer of [b, c]) for (const [from, to] of [[a, peer], [peer, a]]) db.prepare('INSERT INTO contacts(owner_bot, peer_bot, alias, created_at, approved_at, gen) VALUES (?, ?, ?, ?, ?, ?)').run(from.id, to.id, to.me().handle, env.now(), env.now(), env.now());
  const row = (from = a, to = b) => db.prepare('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(from.id, to.id);
  const settings = (from = a) => env.relay.getSettings(from.id);
  const patch = (ops, from = a) => from.api('PATCH', '/v1/settings', { ops });
  const ownerOps = (ops, from = a) => env.relay.applyOwnerOps(from.id, ops);
  const send = (extra = {}, from = a) => from.api('POST', '/v1/messages', { to: '@bob', text: 'Hello', ...extra });
  const inTx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const inbound = () => inTx(() => env.relay.enqueue(b.me(), { to: '@alice', text: 'Where are you?', kind: 'ask' }, { actor: 'owner_web' })).id;
  const propose = async (body = {}) => (await a.api('POST', '/v1/requests', { to: '@bob', draft: { text: 'The park', links: ['https://example.com/park'] }, ...body })).json;
  const encrypt = (who) => { const k = keys(); db.prepare('UPDATE bots SET sign_pub = ?, box_pub = ? WHERE id = ?').run(k.sign, k.box, who.id); };
  return { ...env, db, a, b, c, row, settings, patch, ownerOps, send, inTx, inbound, propose, encrypt };
}

test('governance: email pilot membership, lazy defaults and outside-pilot 404s', async (t) => {
  const e = await fixture(t, { privacyPilot: [' ALICE@example.com '] });
  assert.equal(e.relay.inPilot(e.a.me()), true);
  assert.equal(e.relay.inPilot({ email: 'alice@example.com' }), true);
  assert.equal(e.relay.inPilot(e.b.me()), false);
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM circles').get().n, 0);
  assert.deepEqual(e.settings().circles.map((c) => [c.name, c.mode, c.is_default]), [['family', 'handles', 1], ['friends', 'handles', 1], ['work', 'handles', 1]]);
  e.settings(); assert.equal(e.db.prepare('SELECT count(*) AS n FROM circles').get().n, 3);
  for (const path of ['/v1/settings', '/v1/requests', '/v1/requests/missing']) assert.equal((await e.b.api('GET', path)).status, 404);
  assert.equal((await e.b.api('PATCH', '/v1/settings', { ops: [{ op: 'pause', on: true }] })).status, 404);
  assert.equal((await e.b.api('POST', '/v1/decisions', { contact: '@alice', topic: 'location', answer: 'share' })).status, 404);
  assert.equal((await e.b.api('POST', '/v1/requests', { to: '@alice', draft: { text: 'Hi' } })).status, 404);
  assert.equal((await e.b.api('POST', '/v1/messages', { to: '@alice', text: 'Legacy send' })).status, 200);
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM circles WHERE owner_bot = ?').get(e.b.id).n, 0);
  const other = await fixture(t, { privacyPilot: false });
  assert.equal(other.relay.inPilot(other.a.me()), false);
  assert.equal(other.relay.effectiveMode(other.row()), 'handles');
});

test('governance: additive migration preserves privacy_on and is re-runnable', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'governance-')), 'relay.db'));
  db.prepare('INSERT INTO bots(id, handle, display_name, created_at) VALUES (1, ?, ?, 1), (2, ?, ?, 1)').run('alice', 'Alice', 'bob', 'Bob');
  db.prepare("INSERT INTO contacts(owner_bot, peer_bot, alias, created_at, privacy_on) VALUES (1, 2, 'Bob', 1, 1)").run();
  migrateGovernance(db); migrateGovernance(db);
  assert.equal(db.prepare('SELECT mode_override FROM contacts').get().mode_override, 'asks');
  db.prepare("UPDATE contacts SET mode_override = 'handles'").run(); migrateGovernance(db);
  assert.equal(db.prepare('SELECT mode_override FROM contacts').get().mode_override, 'handles', 'a later migration does not overwrite owner choices');
  db.close();
});

test('governance: full effective-mode matrix and directional pilot gate', async (t) => {
  const e = await fixture(t), friends = e.settings().circles[1];
  for (const group of [null, 'asks', 'handles']) for (const override of [null, 'asks', 'handles']) {
    if (group) e.db.prepare('UPDATE circles SET mode = ? WHERE id = ?').run(group, friends.id);
    e.db.prepare('UPDATE contacts SET circle_id = ?, mode_override = ? WHERE owner_bot = ? AND peer_bot = ?').run(group ? friends.id : null, override, e.a.id, e.b.id);
    assert.equal(e.relay.effectiveMode(e.row()), override ?? group ?? 'asks');
  }
  e.db.prepare('UPDATE contacts SET circle_id = NULL, mode_override = NULL WHERE owner_bot = ?').run(e.a.id);
  const denied = await e.send({ actor: 'owner_web', viaWeb: true, auto: true });
  assert.equal(denied.status, 403); assert.match(denied.json.error, /owner_approval_required:.*propose_reply/);
  assert.equal((await e.b.api('POST', '/v1/messages', { to: '@alice', text: 'Other side also unsorted' })).status, 403);
  e.ownerOps([{ op: 'move', contact: '@bob', circle: friends.id }]);
  assert.equal((await e.send()).status, 200);
  assert.equal((await e.b.api('POST', '/v1/messages', { to: '@alice', text: 'Still asks' })).status, 403);
});

test('governance: defaults cannot be deleted and renaming does not recreate them', async (t) => {
  const e = await fixture(t), family = e.settings().circles[0];
  assert.equal((await e.patch([{ op: 'delete_circle', circle: family.id }])).status, 400);
  assert.equal((await e.patch([{ op: 'rename_circle', circle: family.id, name: 'relatives' }])).status, 200);
  assert.equal(e.settings().circles.length, 3); assert.equal(e.settings().circles[0].name, 'relatives');
});

test('governance: neutral metadata, rules, groups and quiet hours apply directly', async (t) => {
  const e = await fixture(t);
  const r = await e.patch([{ op: 'add_circle', name: 'school', mode: 'asks' }, { op: 'move', contact: '@bob', circle: 'school' },
    { op: 'set_purpose', contact: '@bob', purpose: 'football friend' }, { op: 'set_notes', contact: '@bob', notes: 'Only discuss football' },
    { op: 'add_rule', contact: '@bob', text: 'Ask about plans first', topic: 'plans', days: ['wed'], answer: 'ask' },
    { op: 'quiet_hours', on: true, start: 1320, end: 480, tz: 'Europe/Prague' }, { op: 'rename_circle', circle: 'school', name: 'college' }]);
  assert.equal(r.status, 200); assert.equal(r.json.applied.length, 7); assert.equal(r.json.proposal, null);
  const s = e.settings(), c = s.contacts.find((c) => c.peer_bot === e.b.id);
  assert.equal(c.circle.name, 'college'); assert.equal(c.purpose, 'football friend'); assert.equal(c.notes, 'Only discuss football');
  assert.equal(c.rules[0].source, 'owner'); assert.deepEqual(c.rules[0].days, ['wed']); assert.equal(s.quiet_hours.tz, 'Europe/Prague');
  assert.equal((await e.patch([{ op: 'delete_circle', circle: 'college' }])).json.proposal, null);
});

test('governance: moves and overrides compare actual effective modes and bump only on change', async (t) => {
  const e = await fixture(t), friends = e.settings().circles[1], gen = e.row().gen;
  let r = await e.patch([{ op: 'move', contact: '@bob', circle: friends.id }, { op: 'set_notes', contact: '@bob', notes: 'safe' }]);
  assert.equal(r.json.applied.length, 1); assert.ok(r.json.proposal); assert.equal(e.row().circle_id, null); assert.equal(e.row().gen, gen);
  assert.equal(e.relay.decideProposal(e.a.id, r.json.proposal.id, 'approve').state, 'APPROVED');
  assert.equal(e.row().circle_id, friends.id); assert.ok(e.row().gen > gen);
  const now = e.row().gen;
  r = await e.patch([{ op: 'set_mode', contact: '@bob', mode: 'handles' }]); assert.equal(r.json.proposal, null); assert.equal(e.row().gen, now);
  r = await e.patch([{ op: 'set_mode', contact: '@bob', mode: 'asks' }]); assert.equal(r.json.proposal, null); assert.ok(e.row().gen > now);
  r = await e.patch([{ op: 'move', contact: '@bob', circle: null }]); assert.equal(r.json.proposal, null);
  assert.equal((await e.patch([{ op: 'set_mode', contact: '@bob', mode: null }])).json.proposal, null, 'unsorted stays asks');
  r = await e.patch([{ op: 'set_mode', contact: '@bob', mode: 'handles' }]); assert.ok(r.json.proposal); assert.equal(e.row().mode_override, null);
});

test('governance: a group switch considers every member including overrides', async (t) => {
  const e = await fixture(t);
  e.ownerOps([{ op: 'add_circle', name: 'school', mode: 'asks' }, { op: 'move', contact: '@bob', circle: 'school' }, { op: 'move', contact: '@carol', circle: 'school' }, { op: 'set_mode', contact: '@bob', mode: 'asks' }]);
  let r = await e.patch([{ op: 'set_mode', circle: 'school', mode: 'handles' }]);
  assert.ok(r.json.proposal); assert.equal(e.settings().circles.find((c) => c.name === 'school').mode, 'asks');
  e.ownerOps([{ op: 'set_mode', contact: '@carol', mode: 'asks' }]);
  r = await e.patch([{ op: 'set_mode', circle: 'school', mode: 'handles' }]); assert.equal(r.json.proposal, null);
  assert.equal(e.relay.effectiveMode(e.row()), 'asks');
});

test('governance: batch cannot hide widening behind later strict ops', async (t) => {
  const e = await fixture(t); e.settings();
  const r = await e.patch([{ op: 'add_circle', name: 'school', mode: 'handles' }, { op: 'move', contact: '@bob', circle: 'school' }, { op: 'set_mode', contact: '@bob', mode: 'asks' }]);
  assert.equal(r.status, 200); assert.equal(r.json.applied.length, 2); assert.ok(r.json.proposal);
  assert.equal(e.row().circle_id, null); assert.equal(e.row().mode_override, 'asks');
  e.relay.decideProposal(e.a.id, r.json.proposal.id, 'approve'); assert.equal(e.row().circle_id, e.settings().circles.find((c) => c.name === 'school').id);
  assert.equal(e.relay.effectiveMode(e.row()), 'asks');
});

test('governance: clearing an asks override in a handles circle needs approval', async (t) => {
  const e = await fixture(t); e.settings();
  e.ownerOps([{ op: 'move', contact: '@bob', circle: 'friends' }, { op: 'set_mode', contact: '@bob', mode: 'asks' }]);
  const r = await e.patch([{ op: 'set_mode', contact: '@bob', mode: null }]);
  assert.ok(r.json.proposal); assert.equal(e.row().mode_override, 'asks');
  e.relay.decideProposal(e.a.id, r.json.proposal.id, 'approve'); assert.equal(e.relay.effectiveMode(e.row()), 'handles');
});

test('governance: topics, owner rules, unblock and resume are proposals; stricter ops apply', async (t) => {
  const e = await fixture(t);
  e.ownerOps([{ op: 'add_topic', contact: '@bob', topic: 'football' }, { op: 'add_rule', contact: '@bob', text: 'Only football' }]);
  const rule = e.settings().contacts[0].rules[0].id;
  let r = await e.patch([{ op: 'remove_topic', contact: '@bob', topic: 'football' }, { op: 'block', contact: '@bob', on: true }, { op: 'pause', on: true }]);
  assert.equal(r.json.applied.length, 3); assert.equal(r.json.proposal, null);
  r = await e.patch([{ op: 'add_topic', contact: '@bob', topic: 'location' }, { op: 'remove_rule', rule }, { op: 'block', contact: '@bob', on: false }, { op: 'pause', on: false }]);
  assert.equal(r.json.applied.length, 0);
  const ops = JSON.parse(e.db.prepare('SELECT ops FROM settings_proposals WHERE id = ?').get(r.json.proposal.id).ops);
  assert.deepEqual(ops.map((o) => o.op), ['add_topic', 'remove_rule', 'block', 'pause']);
  assert.equal(e.row().blocked, 1); assert.ok(e.a.me().paused_at);
  e.relay.decideProposal(e.a.id, r.json.proposal.id, 'approve');
  assert.equal(e.row().blocked, 0); assert.equal(e.a.me().paused_at, null); assert.deepEqual(e.settings().contacts[0].topics, ['location']); assert.equal(e.settings().contacts[0].rules.length, 0);
});

test('governance: deleting a handles group tightens; deleting an asks group stays asks', async (t) => {
  const e = await fixture(t);
  e.ownerOps([{ op: 'add_circle', name: 'school', mode: 'handles' }, { op: 'move', contact: '@bob', circle: 'school' }]);
  const before = e.row().gen;
  const r = await e.patch([{ op: 'delete_circle', circle: 'school' }]);
  assert.equal(r.json.proposal, null); assert.equal(e.relay.effectiveMode(e.row()), 'asks'); assert.ok(e.row().gen > before);
});

test('governance: proposal decisions are owner-scoped, retryable and expire after seven days', async (t) => {
  const e = await fixture(t);
  const r = await e.patch([{ op: 'add_topic', contact: '@bob', topic: 'location' }]), id = r.json.proposal.id;
  assert.throws(() => e.relay.decideProposal(e.b.id, id, 'approve'), (e) => e.status === 404);
  assert.deepEqual(e.relay.decideProposal(e.a.id, id, 'decline'), { id, state: 'DECLINED' });
  assert.equal(e.relay.decideProposal(e.a.id, id, 'approve').state, 'DECLINED');
  assert.deepEqual(e.settings().contacts[0].topics, []);
  const next = (await e.patch([{ op: 'add_topic', contact: '@bob', topic: 'location' }])).json.proposal.id;
  e.advance(7 * DAY); assert.equal(e.relay.decideProposal(e.a.id, next, 'approve').state, 'EXPIRED');
});

test('governance: approval revalidates every proposed op and rolls back all on failure', async (t) => {
  const e = await fixture(t); e.settings();
  const r = await e.patch([{ op: 'add_topic', contact: '@carol', topic: 'location' }, { op: 'move', contact: '@bob', circle: 'friends' }]);
  e.db.prepare('DELETE FROM contacts WHERE owner_bot = ? AND peer_bot = ?').run(e.a.id, e.b.id);
  assert.throws(() => e.relay.decideProposal(e.a.id, r.json.proposal.id, 'approve'), (e) => e.status === 404);
  assert.deepEqual(e.settings().contacts[0].topics, []);
  assert.equal(e.db.prepare('SELECT state FROM settings_proposals WHERE id = ?').get(r.json.proposal.id).state, 'PENDING_OWNER');
});

test('governance: invalid batches roll back safe ops, proposals and gen bumps', async (t) => {
  const e = await fixture(t), before = e.row().gen;
  const r = await e.patch([{ op: 'set_mode', contact: '@bob', mode: 'handles' }, { op: 'set_notes', contact: '@bob', notes: 'should roll back' }, { op: 'set_purpose', contact: '@bob', purpose: 'x'.repeat(61) }]);
  assert.equal(r.status, 400); assert.equal(e.row().notes, null); assert.equal(e.row().gen, before);
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM settings_proposals').get().n, 0);
});

test('governance: validation limits, ownership and owner-only op rejection', async (t) => {
  const e = await fixture(t); e.settings(); e.relay.getSettings(e.b.id);
  const foreign = e.relay.getSettings(e.b.id).circles[0].id;
  for (const op of [{ op: 'add_circle', name: 'x'.repeat(25) }, { op: 'add_circle', name: 'FRIENDS' }, { op: 'set_mode', circle: foreign, mode: 'handles' },
    { op: 'set_notes', contact: '@bob', notes: 'x'.repeat(281) }, { op: 'add_rule', contact: '@bob', text: 'x'.repeat(201) },
    { op: 'add_rule', contact: '@bob', text: 'hello', days: ['wednesday'] }, { op: 'add_topic', contact: '@bob', topic: '<script>' },
    { op: 'quiet_hours', on: true, start: -1, end: 480, tz: 'UTC' }, { op: 'quiet_hours', on: true, start: 0, end: 480, tz: 'Nowhere' },
    { op: 'pause', on: 'false' }, { op: 'billing' }, { op: 'export' }, { op: 'delete_account' }, { op: 'link_bot' }]) {
    assert.ok((await e.patch([op])).status >= 400, JSON.stringify(op));
  }
  for (let i = 0; i < 9; i++) assert.equal((await e.patch([{ op: 'add_circle', name: `group${i}` }])).status, 200);
  assert.equal((await e.patch([{ op: 'add_circle', name: 'thirteenth' }])).status, 400);
  assert.equal((await e.a.api('PATCH', '/v1/settings', null)).status, 400);
  assert.equal((await e.patch([])).status, 400);
});

test('governance: inbound request idempotency, immutable revisions and ownership', async (t) => {
  const e = await fixture(t), inbound = e.inbound();
  const body = { inbound_message_id: inbound, draft: { text: 'First' } };
  const first = (await e.a.api('POST', '/v1/requests', body)).json;
  const same = (await e.a.api('POST', '/v1/requests', body)).json;
  assert.equal(same.id, first.id); assert.equal(same.revision, 1);
  const next = (await e.a.api('POST', '/v1/requests', { ...body, draft: { text: 'Second' } })).json;
  assert.equal(next.id, first.id); assert.equal(next.revision, 2);
  assert.deepEqual(e.db.prepare('SELECT text FROM privacy_candidates WHERE request_id = ? ORDER BY revision').all(first.id).map((c) => c.text), ['First', 'Second']);
  assert.equal((await e.b.api('GET', `/v1/requests/${first.id}`)).status, 404);
  assert.equal((await e.b.api('POST', '/v1/requests', body)).status, 404);
  assert.equal((await e.a.api('POST', '/v1/requests', { ...body, to: '@carol' })).status, 400);
  const open = (await e.a.api('GET', '/v1/requests')).json.requests;
  assert.equal(open.length, 1); assert.equal(open[0].draft, undefined);
});

for (const action of ['send', 'edit', 'write', 'decline']) test(`governance: owner ${action} decision is exact, fenced and idempotent`, async (t) => {
  const e = await fixture(t), id = (await e.propose()).id;
  assert.throws(() => e.relay.decideRequest(e.b.id, id, { action, revision: 1 }), (e) => e.status === 404);
  assert.throws(() => e.relay.decideRequest(e.a.id, id, { action, revision: 2 }), (e) => e.status === 409);
  const result = e.relay.decideRequest(e.a.id, id, { action, revision: 1, draft: { text: 'Owner wrote this', links: ['https://example.com/owner'] } });
  assert.equal(result.state, action === 'decline' ? 'DECLINED' : 'ENQUEUED');
  // A competing device with a stale revision gets the recorded outcome.
  assert.equal(e.relay.decideRequest(e.a.id, id, { action: 'decline', revision: 0 }).state, result.state);
  const messages = e.db.prepare('SELECT * FROM messages').all();
  assert.equal(messages.length, action === 'decline' ? 0 : 1);
  if (action !== 'decline') {
    assert.equal(messages[0].text, action === 'send' ? 'The park' : 'Owner wrote this');
    assert.equal(messages[0].client_id, `privacy:${id}`); assert.equal(messages[0].privacy_request_id, id);
    assert.equal(result.revision, action === 'send' ? 1 : 2);
  }
  assert.equal(e.relay.openRequests(e.a.id).length, 0);
});

test('governance: inbound approval sends one exact reply; parallel owner decisions record once', async (t) => {
  const e = await fixture(t), inbound = e.inbound();
  const req = (await e.a.api('POST', '/v1/requests', { inbound_message_id: inbound, draft: { text: 'Exact answer', links: [] } })).json;
  const results = await Promise.all([1, 2].map(() => Promise.resolve().then(() => e.relay.decideRequest(e.a.id, req.id, { action: 'send', revision: 1 }))));
  assert.equal(results[0].outbound_message_id, results[1].outbound_message_id);
  const m = e.db.prepare('SELECT * FROM messages WHERE privacy_request_id = ?').get(req.id);
  assert.equal(m.reply_to, inbound); assert.equal(m.kind, 'reply'); assert.equal(m.text, 'Exact answer');
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM messages WHERE privacy_request_id = ?').get(req.id).n, 1);
});

test('governance: pending and approved requests expire at 24 hours, including mutation checks', async (t) => {
  const e = await fixture(t), req = await e.propose();
  e.encrypt(e.a); e.encrypt(e.b);
  const approved = await e.propose({ to: '@carol', draft: { text: 'Another' } });
  e.encrypt(e.c);
  assert.equal(e.relay.decideRequest(e.a.id, approved.id, { action: 'send', revision: 1 }).state, 'APPROVED');
  e.advance(DAY);
  assert.equal(e.relay.decideRequest(e.a.id, req.id, { action: 'send', revision: 1 }).state, 'EXPIRED');
  assert.equal((await e.send({ to: '@carol', text: undefined, sealed: SEALED, approval: approved.id })).status, 403);
  await e.relay.tick(); assert.equal(e.relay.getRequest(e.a.id, approved.id).state, 'EXPIRED');
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});

test('governance: mode, block, pause, keys and removal cancel open requests transactionally', async (t) => {
  for (const action of ['mode', 'block', 'pause', 'keys', 'remove']) {
    const e = await fixture(t), req = await e.propose();
    if (action === 'mode') e.ownerOps([{ op: 'set_mode', contact: '@bob', mode: 'handles' }]);
    if (action === 'block') e.ownerOps([{ op: 'block', contact: '@bob', on: true }]);
    if (action === 'pause') e.ownerOps([{ op: 'pause', on: true }]);
    if (action === 'keys') assert.equal((await e.a.api('POST', '/v1/keys', { keys: keys() })).status, 200);
    if (action === 'remove') e.inTx(() => e.db.prepare('DELETE FROM contacts WHERE owner_bot = ? AND peer_bot = ?').run(e.a.id, e.b.id));
    assert.equal(e.relay.getRequest(e.a.id, req.id).state, 'CANCELLED', action);
  }
});

test('governance: end-to-end approval is pair-bound, single-use, atomic and retryable', async (t) => {
  const e = await fixture(t); e.encrypt(e.a); e.encrypt(e.b); e.encrypt(e.c);
  const req = await e.propose();
  assert.equal((await e.send({ text: undefined, sealed: SEALED })).status, 403);
  const approved = e.relay.decideRequest(e.a.id, req.id, { action: 'edit', revision: 1, draft: { text: 'Approved location' } });
  assert.equal(approved.state, 'APPROVED'); assert.equal(approved.draft.text, 'Approved location');
  assert.equal((await e.a.api('GET', `/v1/requests/${req.id}`)).json.draft.text, 'Approved location');
  assert.equal((await e.send({ to: '@carol', text: undefined, sealed: SEALED, approval: req.id })).status, 403);
  assert.equal((await e.b.api('POST', '/v1/messages', { to: '@alice', sealed: SEALED, approval: req.id })).status, 403);
  const body = { text: undefined, sealed: SEALED, approval: req.id, client_id: `privacy:${req.id}` };
  const sent = await e.send(body); assert.equal(sent.status, 200);
  assert.equal(e.relay.getRequest(e.a.id, req.id).state, 'ENQUEUED');
  assert.equal(e.db.prepare('SELECT privacy_request_id FROM messages').get().privacy_request_id, req.id);
  assert.equal((await e.send(body)).json.id, sent.json.id, 'an exact retry returns the original');
  assert.equal((await e.send({ ...body, client_id: 'reused' })).status, 403);
  assert.equal((await e.send({ ...body, client_id: undefined })).status, 403);
  const stale = await e.propose(); e.relay.decideRequest(e.a.id, stale.id, { action: 'send', revision: 1 });
  e.ownerOps([{ op: 'set_mode', contact: '@bob', mode: 'handles' }]);
  assert.equal(e.relay.getRequest(e.a.id, stale.id).state, 'CANCELLED');
  assert.equal((await e.send({ text: undefined, sealed: SEALED, approval: stale.id })).status, 403, 'a changed generation invalidates approval even when the new mode handles sends');
});

test('governance: approvals are not implicitly deduplicated across two requests', async (t) => {
  const e = await fixture(t); e.encrypt(e.a); e.encrypt(e.b);
  for (let i = 0; i < 2; i++) {
    const req = await e.propose(); e.relay.decideRequest(e.a.id, req.id, { action: 'send', revision: 1 });
    assert.equal((await e.send({ text: undefined, sealed: SEALED, content_tag: 'A'.repeat(16), approval: req.id, client_id: `privacy:${req.id}` })).status, 200);
    assert.equal(e.relay.getRequest(e.a.id, req.id).state, 'ENQUEUED');
  }
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM messages').get().n, 2);
});

test('governance: failed enqueue and outer transaction rollback preserve approvals and candidates', async (t) => {
  const e = await fixture(t); e.encrypt(e.a); e.encrypt(e.b);
  const req = await e.propose(); e.relay.decideRequest(e.a.id, req.id, { action: 'send', revision: 1 });
  e.db.exec("CREATE TRIGGER fail_request_message BEFORE UPDATE OF privacy_request_id ON messages BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;");
  assert.equal((await e.send({ text: undefined, sealed: SEALED, approval: req.id, client_id: `privacy:${req.id}` })).status, 500);
  assert.equal(e.relay.getRequest(e.a.id, req.id).state, 'APPROVED'); assert.equal(e.db.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  e.db.exec('DROP TRIGGER fail_request_message');
  e.db.exec('BEGIN IMMEDIATE');
  e.relay.applyOwnerOpsInTx(e.a.id, [{ op: 'set_mode', contact: '@bob', mode: 'handles' }]);
  assert.equal(e.db.prepare('SELECT state FROM privacy_requests WHERE id = ?').get(req.id).state, 'CANCELLED');
  e.db.exec('ROLLBACK'); assert.equal(e.relay.getRequest(e.a.id, req.id).state, 'APPROVED');
  const plain = await fixture(t), pending = await plain.propose();
  plain.db.exec("CREATE TRIGGER fail_enqueue BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;");
  assert.throws(() => plain.relay.decideRequest(plain.a.id, pending.id, { action: 'edit', revision: 1, draft: { text: 'Should roll back' } }));
  assert.equal(plain.relay.getRequest(plain.a.id, pending.id).state, 'PENDING_OWNER');
  assert.equal(plain.db.prepare('SELECT count(*) AS n FROM privacy_candidates').get().n, 1);
});

test('governance: owner-decision helpers compose inside a caller transaction with no early wake', async (t) => {
  const e = await fixture(t), req = await e.propose();
  e.db.exec('BEGIN IMMEDIATE');
  const r = e.relay.decideRequestInTx(e.a.id, req.id, { action: 'send', revision: 1 });
  assert.equal(r.state, 'ENQUEUED'); e.db.exec('ROLLBACK');
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  assert.equal(e.relay.getRequest(e.a.id, req.id).state, 'PENDING_OWNER');
  e.db.exec('BEGIN IMMEDIATE');
  const p = e.relay.governance.applySettingsInTx(e.a.id, [{ op: 'set_mode', contact: '@bob', mode: 'handles' }]).proposal;
  e.relay.decideProposalInTx(e.a.id, p.id, 'approve'); e.db.exec('ROLLBACK');
  assert.equal(e.relay.effectiveMode(e.row()), 'asks'); assert.equal(e.settings().pending_proposals.length, 0);
});

test('governance: answers become past answers per topic and answer, never rules by count, for 60 days', async (t) => {
  const e = await fixture(t);
  const report = (contact, answer = 'share', topic = 'location') => e.a.api('POST', '/v1/decisions', { contact, topic, answer });
  for (let week = 0; week < 4; week++) { if (week) e.advance(7 * DAY); assert.equal((await report('@bob')).json.learned_rules.length, 0); }
  await report('@carol'); await report('@bob', 'decline', 'money'); await report('@bob', 'share', 'wishlist');
  assert.equal(e.settings().new_learned_rules.length, 0);
  assert.equal(e.settings().contacts.find((c) => c.handle === '@bob').rules.length, 0, 'no rule from a count');
  const past = e.settings().contacts.find((c) => c.handle === '@bob').past_answers;
  assert.deepEqual(past.map(({ topic, answer, times }) => [topic, answer, times]), [['wishlist', 'share', 1], ['money', 'decline', 1], ['location', 'share', 4]]);
  assert.equal(new Set(past.flatMap((p) => p.days)).size, 1, 'the same weekday each week');
  assert.match(past[0].last, /^\d{4}-\d\d-\d\d$/);
  assert.deepEqual(e.settings().contacts.find((c) => c.handle === '@carol').past_answers.map((p) => p.times), [1], 'per person');
  e.advance(61 * DAY);
  assert.deepEqual(e.settings().contacts.find((c) => c.handle === '@bob').past_answers, [], 'older than 60 days drops out');
});

test('governance: always_days creates guidance immediately, announce until ack, remove learned safely', async (t) => {
  const e = await fixture(t);
  const r = await e.a.api('POST', '/v1/decisions', { contact: '@bob', topic: 'location', answer: 'share', always_days: ['wed', 'thu'] });
  assert.equal(r.status, 200); assert.equal(r.json.learned_rules.length, 2);
  const first = e.settings().new_learned_rules; assert.equal(first.length, 2); assert.equal(e.settings().new_learned_rules.length, 2);
  assert.deepEqual(first.flatMap((r) => r.days).sort(), ['thu', 'wed']);
  assert.equal((await e.patch([{ op: 'ack_learned', ids: first.map((r) => r.id) }])).json.proposal, null);
  assert.equal(e.settings().new_learned_rules.length, 0);
  assert.equal(e.settings().contacts[0].rules.length, 2);
  assert.equal((await e.patch([{ op: 'remove_rule', rule: first[0].id }])).json.proposal, null);
  assert.equal(e.settings().contacts[0].rules.length, 1); assert.equal(e.relay.effectiveMode(e.row()), 'asks', 'learning never lifts the hard gate');
  assert.equal((await e.a.api('POST', '/v1/decisions', { contact: '@bob', topic: 'location', answer: 'share', always_days: ['wed', 'wed'] })).status, 400);
  assert.equal((await e.b.api('PATCH', '/v1/settings', { ops: [{ op: 'ack_learned', ids: [first[1].id] }] })).status, 404);
});

test('governance: ordinary incoming messages cannot create learned rules', async (t) => {
  const e = await fixture(t);
  for (let i = 0; i < 4; i++) e.inbound();
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM owner_decisions').get().n, 0);
  assert.equal(e.settings().new_learned_rules.length, 0);
});

test('governance: legacy topics cannot widen pilot permissions and legacy unblock creates proposal', async (t) => {
  const e = await fixture(t);
  assert.equal((await e.a.api('POST', '/v1/contacts/allow', { contact: '@bob', topics: ['location'] })).status, 403);
  e.ownerOps([{ op: 'add_topic', contact: '@bob', topic: 'location' }]);
  assert.equal((await e.a.api('POST', '/v1/contacts/allow', { contact: '@bob', topics: [] })).status, 200);
  assert.equal((await e.a.api('POST', '/v1/contacts/block', { contact: '@bob' })).status, 200);
  const r = await e.a.api('POST', '/v1/contacts/block', { contact: '@bob', unblock: true, actor: 'owner' });
  assert.ok(r.json.proposal); assert.equal(e.row().blocked, 1);
  assert.equal((await e.a.api('GET', '/v1/contacts')).json.contacts.find((c) => c.handle === '@bob').owner_approves_first, true);
});

test('governance: bot tokens cannot decide requests or proposals or reach existing owner routes', async (t) => {
  const e = await fixture(t), req = await e.propose(), prop = (await e.patch([{ op: 'add_topic', contact: '@bob', topic: 'location' }])).json.proposal;
  for (const path of [`/app/requests/${req.id}`, `/app/proposals/${prop.id}`, '/app/contacts/privacy', '/app/pause']) {
    const r = await browser(e.url, { authorization: `Bearer ${e.a.raw}` })(path, { method: 'POST', form: { decision: 'approve', action: 'send', bot: e.a.id, peer: e.b.id, on: '0' } });
    assert.equal(r.status, 303); assert.match(r.location, /^\/login/);
  }
  for (const path of [`/v1/requests/${req.id}/approve`, `/v1/proposals/${prop.id}/approve`]) assert.equal((await e.a.api('POST', path, { actor: 'owner_web' })).status, 404);
  assert.equal(e.relay.getRequest(e.a.id, req.id).state, 'PENDING_OWNER'); assert.equal(e.settings().pending_proposals.length, 1);
});

test('governance: pilot email list gates the existing dashboard switch per owner', async (t) => {
  const e = await fixture(t, { privacyPilot: ['alice@example.com'], bumpPair: () => {} });
  const alice = await login(e, 'alice@example.com'), bob = await login(e, 'bob@example.com');
  assert.match((await alice('/app')).text, /<dt>Basket<\/dt>/); assert.doesNotMatch((await bob('/app')).text, /<dt>Basket<\/dt>|contacts\/privacy/);
  assert.equal((await bob('/app/contacts/privacy', { method: 'POST', form: { bot: e.b.id, peer: e.a.id, on: '1' } })).status, 404);
});

test('governance: request retention erases final candidate bodies but keeps retry metadata', async (t) => {
  const e = await fixture(t), req = await e.propose();
  e.relay.decideRequest(e.a.id, req.id, { action: 'decline', revision: 1 });
  e.advance(7 * DAY + 1); e.relay.retention();
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM privacy_candidates').get().n, 0);
  assert.equal(e.relay.decideRequest(e.a.id, req.id, { action: 'send', revision: 1 }).state, 'DECLINED');
});

test('governance: export includes private settings, account deletion erases new private data', async (t) => {
  const e = await fixture(t), req = await e.propose();
  e.ownerOps([{ op: 'set_notes', contact: '@bob', notes: 'Private notes' }]);
  await e.a.api('POST', '/v1/decisions', { contact: '@bob', topic: 'location', answer: 'share', always_days: ['wed'] });
  await e.patch([{ op: 'add_topic', contact: '@bob', topic: 'location' }]);
  const b = await login(e, 'alice@example.com');
  const data = (await b('/app/account/export')).json();
  assert.equal(data.governance.privacy_requests[0].id, req.id); assert.equal(data.governance.contacts[0].notes, 'Private notes');
  assert.equal((await b('/app/account/delete', { method: 'POST', form: { confirm: 'alice@example.com' } })).status, 200);
  for (const table of ['circles', 'contact_rules', 'owner_decisions', 'settings_proposals', 'privacy_requests', 'privacy_candidates']) assert.equal(e.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
});


test('governance: outbound request retries recover the pending request and new drafts revise it', async (t) => {
  const e = await fixture(t), first = await e.propose(), same = await e.propose();
  assert.equal(same.id, first.id); assert.equal(same.revision, 1);
  const next = await e.propose({ draft: { text: 'New draft' } });
  assert.equal(next.id, first.id); assert.equal(next.revision, 2);
  assert.throws(() => e.relay.decideRequest(e.a.id, first.id, { action: 'send', revision: 1 }), (e) => e.status === 409);
  e.relay.decideRequest(e.a.id, first.id, { action: 'send', revision: 2 });
  assert.notEqual((await e.propose()).id, first.id, 'a finished request does not absorb a new outbound draft');
});

test('governance: malformed request and rule references return validation errors', async (t) => {
  const e = await fixture(t);
  assert.equal((await e.a.api('POST', '/v1/requests', { inbound_message_id: {}, draft: { text: 'Hi' } })).status, 400);
  assert.equal((await e.patch([{ op: 'remove_rule', rule: {} }])).status, 400);
  assert.equal((await e.propose({ draft: { text: 'Hi', links: ['javascript:alert(1)'] } })).error, 'invalid draft link');
});

test('fix: proposal scope refuses new basket members, but permits a smaller widening set', async (t) => {
  const e = await fixture(t);
  e.ownerOps([{ op: 'add_circle', name: 'club', mode: 'asks' }, { op: 'move', contact: '@bob', circle: 'club' }]);
  const id = (await e.patch([{ op: 'set_mode', circle: 'club', mode: 'handles' }])).json.proposal.id;
  const p = e.db.prepare('SELECT * FROM settings_proposals WHERE id = ?').get(id);
  assert.equal(JSON.parse(p.ops)[0].circle_name, 'club');
  assert.deepEqual(JSON.parse(p.widening), [{ owner_bot: e.a.id, peer_bot: e.b.id, gen: e.row().gen }]);
  e.ownerOps([{ op: 'move', contact: '@carol', circle: 'club' }]);
  assert.throws(() => e.relay.decideProposal(e.a.id, id, 'approve'), (x) => x.status === 409 && x.message === 'this change now affects more people, look at it again');
  assert.equal(e.settings().circles.find((c) => c.name === 'club').mode, 'asks');
  assert.equal(e.relay.effectiveMode(e.row()), 'asks');
  e.ownerOps([{ op: 'move', contact: '@carol', circle: null }, { op: 'set_mode', contact: '@bob', mode: 'asks' }]);
  assert.equal(e.relay.decideProposal(e.a.id, id, 'approve').state, 'APPROVED', 'no contacts widen now');
});

test('fix: proposal generations, names and deleted circle identities stay bound', async (t) => {
  const e = await fixture(t);
  const genProp = (await e.patch([{ op: 'add_topic', contact: '@bob', topic: 'location' }])).json.proposal.id;
  e.ownerOps([{ op: 'block', contact: '@bob', on: true }, { op: 'block', contact: '@bob', on: false }]);
  assert.throws(() => e.relay.decideProposal(e.a.id, genProp, 'approve'), (x) => x.status === 409);
  assert.deepEqual(e.settings().contacts[0].topics, []);
  e.ownerOps([{ op: 'add_circle', name: 'old club', mode: 'handles' }]);
  const old = e.settings().circles.at(-1).id;
  const renamed = (await e.patch([{ op: 'move', contact: '@bob', circle: old }])).json.proposal.id;
  e.ownerOps([{ op: 'rename_circle', circle: old, name: 'new club' }]);
  assert.throws(() => e.relay.decideProposal(e.a.id, renamed, 'approve'), (x) => x.status === 409);
  e.ownerOps([{ op: 'delete_circle', circle: old }, { op: 'add_circle', name: 'replacement' }]);
  assert.ok(e.settings().circles.at(-1).id > old);
  assert.throws(() => e.relay.decideProposal(e.a.id, renamed, 'approve'), (x) => x.status === 404);
});

test('fix: ownerless bots never join the pilot, including a mixed pilot and legacy pair', async (t) => {
  const e = await fixture(t);
  e.db.prepare('UPDATE bots SET user_id = NULL WHERE id = ?').run(e.b.id);
  assert.equal(e.relay.inPilot(e.b.me()), false);
  assert.equal(e.relay.inPilot(e.b.id), false);
  assert.equal((await e.b.api('GET', '/v1/settings')).status, 404);
  assert.equal((await e.b.api('POST', '/v1/messages', { to: '@alice', text: 'legacy to pilot' })).status, 200);
  assert.equal((await e.send()).status, 403, 'pilot to legacy still asks');
  e.ownerOps([{ op: 'move', contact: '@bob', circle: 'friends' }]);
  assert.equal((await e.send()).status, 200);
  assert.equal((await e.b.api('POST', '/v1/messages', { to: '@alice', text: 'bad namespace', client_id: 'privacy:anything', approval: 'anything' })).status, 403);
});

test('fix: past answers use owner-local dates and deduplicate client retries', async (t) => {
  const e = await fixture(t);
  e.advance(Date.parse('2026-10-29T04:00:00Z') - e.now());
  e.db.prepare("UPDATE users SET tz = 'Pacific/Honolulu' WHERE id = ?").run(e.a.uid);
  const body = { contact: '@bob', topic: 'location', answer: 'share', client_id: 'owner-answer-1' };
  const first = await e.a.api('POST', '/v1/decisions', body);
  const retry = await e.a.api('POST', '/v1/decisions', body);
  assert.deepEqual(retry.json, first.json);
  assert.equal((await e.a.api('POST', '/v1/decisions', { ...body, answer: 'decline' })).status, 409);
  for (let i = 0; i < 5; i++) await e.a.api('POST', '/v1/decisions', { ...body, client_id: `same-day-${i}` });
  assert.equal(e.settings().new_learned_rules.length, 0);
  const row = e.db.prepare('SELECT * FROM owner_decisions WHERE id = ?').get(first.json.id);
  assert.equal(row.local_date, '2026-10-28'); assert.equal(row.weekday, 'wed', 'Thursday UTC is still Wednesday for this owner');
  assert.equal(row.local_date, new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Honolulu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(row.created_at)));
  assert.equal(row.weekday, new Intl.DateTimeFormat('en', { timeZone: 'Pacific/Honolulu', weekday: 'short' }).format(new Date(row.created_at)).toLowerCase());
  e.advance(7 * DAY);
  await e.a.api('POST', '/v1/decisions', { ...body, client_id: 'next-week' });
  e.advance(7 * DAY);
  assert.equal((await e.a.api('POST', '/v1/decisions', { ...body, client_id: 'third-week' })).json.learned_rules.length, 0);
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM owner_decisions').get().n, 8);
  const [past] = e.settings().contacts.find((c) => c.handle === '@bob').past_answers;
  assert.deepEqual([past.times, past.days, past.last], [8, ['wed'], '2026-11-11'], 'retries count once; weekdays and dates are the owner\'s');
});

test('fix: a removed always rule does not come back from later yeses', async (t) => {
  const e = await fixture(t), body = { contact: '@bob', topic: 'location', answer: 'share' };
  await e.a.api('POST', '/v1/decisions', { ...body, always_days: ['wed'] });
  const rule = e.settings().new_learned_rules[0];
  assert.ok(rule);
  await e.patch([{ op: 'remove_rule', rule: rule.id }]);
  for (let i = 0; i < 4; i++) { e.advance(7 * DAY); assert.equal((await e.a.api('POST', '/v1/decisions', body)).json.learned_rules.length, 0); }
  assert.equal(e.settings().contacts.find((c) => c.handle === '@bob').rules.length, 0);
});

test('fix: cancelled and expired inbound requests reopen, decided drafts conflict', async (t) => {
  const e = await fixture(t), inbound = e.inbound();
  const body = { inbound_message_id: inbound, draft: { text: 'First' } };
  const first = (await e.a.api('POST', '/v1/requests', body)).json;
  e.ownerOps([{ op: 'set_mode', contact: '@bob', mode: 'handles' }]);
  const reopened = (await e.a.api('POST', '/v1/requests', body)).json;
  assert.equal(reopened.id, first.id); assert.equal(reopened.revision, 2);
  assert.equal(reopened.contact_gen, e.row().gen); assert.equal(reopened.state, 'PENDING_OWNER');
  e.advance(DAY + 1);
  const expired = (await e.a.api('POST', '/v1/requests', { ...body, draft: { text: 'New day' } })).json;
  assert.equal(expired.id, first.id); assert.equal(expired.revision, 3); assert.ok(expired.expires_at > reopened.expires_at);
  e.relay.decideRequest(e.a.id, first.id, { action: 'decline', revision: 3 });
  assert.equal((await e.a.api('POST', '/v1/requests', body)).status, 409);
  const second = e.inbound();
  const sent = (await e.a.api('POST', '/v1/requests', { ...body, inbound_message_id: second })).json;
  e.relay.decideRequest(e.a.id, sent.id, { action: 'send', revision: 1 });
  assert.equal((await e.a.api('POST', '/v1/requests', { ...body, inbound_message_id: second })).status, 409);
});

test('fix: approvals require their reserved retry key and original inbound reply', async (t) => {
  const e = await fixture(t), inbound = e.inbound(), other = e.inTx(() => e.relay.enqueue(e.b.me(), { to: '@alice', text: 'Another question', kind: 'ask', again: true }, { actor: 'owner_web' })).id;
  e.encrypt(e.a); e.encrypt(e.b);
  const req = (await e.a.api('POST', '/v1/requests', { inbound_message_id: inbound, draft: { text: 'Only this reply' } })).json;
  e.relay.decideRequest(e.a.id, req.id, { action: 'send', revision: 1 });
  const body = { text: undefined, sealed: SEALED, approval: req.id, client_id: `privacy:${req.id}`, kind: 'reply', reply_to: inbound };
  for (const bad of [{ client_id: 'wrong' }, { client_id: null }, { kind: 'note' }, { reply_to: other }, { approval: undefined }]) {
    assert.equal((await e.send({ ...body, ...bad })).status, 403);
    assert.equal(e.relay.getRequest(e.a.id, req.id).state, 'APPROVED');
  }
  assert.equal((await e.send(body)).status, 200);
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM privacy_candidates WHERE request_id = ?').get(req.id).n, 0);
  assert.equal((await e.send(body)).status, 200, 'exact retry after consumption');
  assert.equal((await e.send({ ...body, approval: 'other' })).status, 403);
  e.ownerOps([{ op: 'set_mode', contact: '@bob', mode: 'handles' }]);
  assert.equal((await e.send({ text: undefined, sealed: SEALED, client_id: 'privacy:fake' })).status, 403);
});

test('fix: plaintext approved candidates disappear in the same enqueue transaction', async (t) => {
  const e = await fixture(t), req = await e.propose();
  e.db.exec('BEGIN IMMEDIATE');
  e.relay.decideRequestInTx(e.a.id, req.id, { action: 'send', revision: 1 });
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM privacy_candidates').get().n, 0);
  e.db.exec('ROLLBACK');
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM privacy_candidates').get().n, 1);
  e.relay.decideRequest(e.a.id, req.id, { action: 'send', revision: 1 });
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM privacy_candidates').get().n, 0);
});

test('fix: approval doorbell runs after commit, never on an outer rollback', async (t) => {
  let e; const rings = [];
  e = await fixture(t, { fetchImpl: async (url, opts) => {
    rings.push({ ...JSON.parse(opts.body), inTransaction: e.db.isTransaction, state: e.db.prepare('SELECT state FROM privacy_requests').get().state });
    return new Response('{}');
  } });
  e.encrypt(e.a); e.encrypt(e.b);
  e.db.prepare("UPDATE bots SET webhook_url = 'http://127.0.0.1/fixture' WHERE id = ?").run(e.a.id);
  const req = await e.propose();
  e.db.exec('BEGIN IMMEDIATE');
  e.relay.decideRequestInTx(e.a.id, req.id, { action: 'send', revision: 1 });
  assert.equal(rings.length, 0);
  e.db.exec('ROLLBACK');
  assert.equal(rings.length, 0);
  e.relay.decideRequest(e.a.id, req.id, { action: 'send', revision: 1 });
  assert.equal(rings.length, 1);
  assert.deepEqual([rings[0].reason, rings[0].state, rings[0].inTransaction], ['approval', 'APPROVED', false]);
});

test('fix: numeric circle names cannot impersonate IDs and Unicode names share one key', async (t) => {
  const e = await fixture(t), friends = e.settings().circles[1];
  assert.equal((await e.patch([{ op: 'move', contact: '@bob', circle: String(friends.id) }])).status, 404);
  for (const name of ['123', '１２３']) assert.equal((await e.patch([{ op: 'add_circle', name }])).status, 400);
  assert.equal((await e.patch([{ op: 'add_circle', name: 'École' }])).status, 200);
  assert.equal((await e.patch([{ op: 'add_circle', name: 'E\u0301COLE' }])).status, 409);
  const group = e.settings().circles.at(-1);
  assert.equal(group.name_key, 'école');
  assert.equal((await e.patch([{ op: 'rename_circle', circle: friends.id, name: 'ÉCOLE' }])).status, 409);
  assert.equal((await e.patch([{ op: 'move', contact: '@bob', circle: 'E\u0301COLE' }])).status, 200);
});

test('fix: InTx helpers reject autocommit before writing anything', async (t) => {
  const e = await fixture(t), req = await e.propose();
  const calls = [() => e.relay.applyOwnerOpsInTx(e.a.id, [{ op: 'pause', on: true }]),
    () => e.relay.governance.applySettingsInTx(e.a.id, [{ op: 'set_notes', contact: '@bob', notes: 'oops' }]),
    () => e.relay.decideProposalInTx(e.a.id, 'missing', 'approve'),
    () => e.relay.decideRequestInTx(e.a.id, req.id, { action: 'send', revision: 1 }),
    () => e.relay.governance.proposeReplyInTx(e.a.id, { to: '@bob', draft: { text: 'oops' } }),
    () => e.relay.governance.recordDecisionInTx(e.a.id, { contact: '@bob', topic: 'x', answer: 'share' }),
    () => e.relay.governance.deleteDataInTx([e.a.id]), () => e.relay.setPrivacyInTx(e.a.id, e.b.id, true)];
  for (const fn of calls) assert.throws(fn, /requires a transaction/);
  assert.equal(e.row().notes, null); assert.equal(e.a.me().paused_at, null);
  assert.equal(e.relay.getRequest(e.a.id, req.id).state, 'PENDING_OWNER');
});

test('fix: bot-added rules are marked for the owner and safe to remove', async (t) => {
  const e = await fixture(t);
  await e.patch([{ op: 'add_rule', contact: '@bob', text: 'From your bot' }]);
  const rule = e.settings().contacts[0].rules[0];
  assert.equal(rule.via, 'bot'); assert.equal(rule.owner_seen_at, null);
  assert.equal((await e.patch([{ op: 'remove_rule', rule: rule.id }])).json.proposal, null);
  e.ownerOps([{ op: 'add_rule', contact: '@bob', text: 'From the owner' }]);
  assert.ok((await e.patch([{ op: 'remove_rule', rule: e.settings().contacts[0].rules[0].id }])).json.proposal);
});

test('fix: pending proposals collapse, cap at twenty and roll back safe ops at the cap', async (t) => {
  const e = await fixture(t), op = { op: 'add_topic', contact: '@bob', topic: 'topic zero' };
  const first = (await e.patch([op])).json.proposal.id;
  assert.equal((await e.patch([op])).json.proposal.id, first);
  for (let i = 1; i < 20; i++) assert.equal((await e.patch([{ ...op, topic: `topic ${i}` }])).status, 200);
  assert.equal((await e.patch([{ op: 'set_notes', contact: '@bob', notes: 'rollback' }, { ...op, topic: 'twenty first' }])).status, 409);
  assert.equal(e.row().notes, null); assert.equal(e.settings().pending_proposals.length, 20);
  assert.equal((await e.patch([op])).json.proposal.id, first);
  e.advance(7 * DAY);
  assert.equal((await e.patch([{ ...op, topic: 'new week' }])).status, 200);
});

test('fix: retention purges decisions at sixty days and final proposals at seven days', async (t) => {
  const e = await fixture(t);
  await e.a.api('POST', '/v1/decisions', { contact: '@bob', topic: 'location', answer: 'share' });
  const declined = (await e.patch([{ op: 'add_topic', contact: '@bob', topic: 'one' }])).json.proposal.id;
  e.relay.decideProposal(e.a.id, declined, 'decline');
  const expired = (await e.patch([{ op: 'add_topic', contact: '@bob', topic: 'two' }])).json.proposal.id;
  e.advance(15 * DAY); e.relay.retention();
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM settings_proposals WHERE id IN (?, ?)').get(declined, expired).n, 0);
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM owner_decisions').get().n, 1);
  e.advance(46 * DAY); e.relay.retention();
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM owner_decisions').get().n, 0);
});

test('fix: settings batches resolve pilot membership once and join circle modes', async (t) => {
  const e = await fixture(t), sql = [];
  const g = createGovernance({ db: e.db, q: (s) => { sql.push(s); return e.db.prepare(s); }, tx: e.inTx, clock: e.now,
    token: () => 'fixture-id', HttpError: class extends Error {}, publicUrl: e.url, privacyPilot: ['alice@example.com'], bumpPair: () => {} });
  sql.length = 0;
  g.applySettings(e.a.id, [{ op: 'set_notes', contact: '@bob', notes: 'first' }, { op: 'set_purpose', contact: '@carol', purpose: 'second' }]);
  assert.equal(sql.filter((s) => s === 'SELECT email FROM users WHERE id = ?').length, 1);
  assert.equal(sql.filter((s) => s.includes('LEFT JOIN circles')).length, 4);
  assert.equal(sql.filter((s) => s.startsWith('SELECT mode FROM circles')).length, 0);
});

test('fix: mode changes mirror privacy_on to preserve protection outside the pilot', async (t) => {
  const e = await fixture(t);
  e.ownerOps([{ op: 'move', contact: '@bob', circle: 'friends' }]);
  assert.equal(e.row().privacy_on, 0);
  e.ownerOps([{ op: 'set_mode', circle: 'friends', mode: 'asks' }]);
  assert.equal(e.row().privacy_on, 1);
  e.ownerOps([{ op: 'set_mode', contact: '@bob', mode: 'handles' }]);
  assert.equal(e.row().privacy_on, 0);
  e.ownerOps([{ op: 'set_mode', contact: '@bob', mode: null }]);
  assert.equal(e.row().privacy_on, 1);
  const outside = await fixture(t, { privacyPilot: false });
  outside.db.prepare('UPDATE contacts SET privacy_on = ? WHERE owner_bot = ? AND peer_bot = ?').run(e.row().privacy_on, outside.a.id, outside.b.id);
  assert.equal((await outside.send()).status, 403);
});

test('fix: old Part S circle tables migrate in place and remain re-runnable', () => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'gov-old-')), 'relay.db'));
  db.exec(`CREATE TABLE circles (id INTEGER PRIMARY KEY, owner_bot INTEGER NOT NULL, name TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('handles','asks')), is_default INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    INSERT INTO circles VALUES (40, 1, 'École basket 42', 'asks', 0, 2, 1), (41, 1, 'École', 'asks', 0, 0, 1), (42, 1, 'ÉCOLE', 'handles', 0, 1, 1);
    INSERT INTO bots(id, handle, display_name, created_at) VALUES (1, 'alice', 'Alice', 1), (2, 'bob', 'Bob', 1);
    ALTER TABLE contacts ADD COLUMN circle_id INTEGER;
    INSERT INTO contacts(owner_bot, peer_bot, alias, created_at, circle_id) VALUES (1, 2, 'Bob', 1, 41);`);
  migrateGovernance(db); migrateGovernance(db);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'circles'").get().sql, /AUTOINCREMENT/);
  assert.equal(db.prepare('SELECT circle_id FROM contacts').get().circle_id, 41);
  assert.equal(db.prepare('SELECT name_key FROM circles WHERE id = 41').get().name_key, 'école');
  assert.equal(db.prepare('SELECT name_key FROM circles WHERE id = 42').get().name_key, 'école basket 42 1');
  db.exec('DELETE FROM circles WHERE id = 42');
  const next = db.prepare("INSERT INTO circles(owner_bot,name,name_key,mode,created_at) VALUES (1,'new','new','asks',1)").run();
  assert.ok(Number(next.lastInsertRowid) > 42);
  db.close();
});

test('fix: joining, leaving and rejoining the pilot preserves the legacy protection bit', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'gov-join-')), 'relay.db');
  const e = await fixture(t, { dbPath, privacyPilot: false });
  assert.equal(e.row().privacy_on, 0);
  const joining = createRelay({ dbPath, adminToken: 'test-admin-token-for-pilot', privacyPilot: ['alice@example.com'] });
  assert.equal(joining.effectiveMode(e.row()), 'asks');
  assert.equal(e.row().privacy_on, 1);
  assert.equal(joining.getSettings(e.a.id).contacts[0].mode_override, null, 'joining does not freeze inherited asks as an override');
  joining.applyOwnerOps(e.a.id, [{ op: 'move', contact: '@bob', circle: 'friends' }]);
  assert.equal(e.row().privacy_on, 0);
  joining.applyOwnerOps(e.a.id, [{ op: 'set_mode', circle: 'friends', mode: 'asks' }]);
  assert.equal(e.row().privacy_on, 1);
  const leaving = createRelay({ dbPath, adminToken: 'test-admin-token-for-pilot', privacyPilot: false });
  assert.equal(leaving.effectiveMode(e.row()), 'asks');
  assert.throws(() => leaving.getSettings(e.a.id), (x) => x.status === 404);
  assert.equal((await e.send()).status, 403, 'existing nonpilot server uses the persisted privacy_on protection');
  const rejoining = createRelay({ dbPath, adminToken: 'test-admin-token-for-pilot', privacyPilot: ['alice@example.com'] });
  assert.equal(rejoining.effectiveMode(e.row()), 'asks');
  assert.equal(rejoining.getSettings(e.a.id).contacts[0].circle.name, 'friends');
  joining.db.close(); leaving.db.close(); rejoining.db.close();
});

test('fix: proposal preview includes safe later moves, and pending revisions keep their deadline', async (t) => {
  const e = await fixture(t);
  e.ownerOps([{ op: 'add_circle', name: 'club', mode: 'asks' }, { op: 'move', contact: '@bob', circle: 'club' }]);
  const p = (await e.patch([{ op: 'set_mode', circle: 'club', mode: 'handles' }, { op: 'move', contact: '@carol', circle: 'club' }])).json.proposal;
  const scope = JSON.parse(e.db.prepare('SELECT widening FROM settings_proposals WHERE id = ?').get(p.id).widening);
  assert.deepEqual(scope.map((c) => c.peer_bot), [e.b.id, e.c.id]);
  assert.equal(e.relay.decideProposal(e.a.id, p.id, 'approve').state, 'APPROVED');
  const req = await e.propose();
  e.advance(1000);
  const revised = await e.propose({ draft: { text: 'Revised' } });
  assert.equal(revised.id, req.id); assert.equal(revised.expires_at, req.expires_at);
  e.advance(DAY);
  const reopened = await e.propose({ draft: { text: 'Fresh' } });
  assert.equal(reopened.id, req.id); assert.ok(reopened.expires_at > req.expires_at);
});

test('governance: in handles mode the bot asks when it judges it should, and the owner\'s answers teach it', async (t) => {
  const e = await fixture(t);
  e.ownerOps([{ op: 'move', contact: '@bob', circle: 'friends' }]);
  assert.equal(e.settings().contacts.find((c) => c.handle === '@bob').effective_mode, 'handles');
  // Three Wednesdays in a row the bot asks about sharing where its owner is, and the owner says yes on the page.
  const DAY = 86_400_000;
  e.advance(((3 - new Date(e.now()).getUTCDay() + 7) % 7) * DAY);
  for (let week = 0; week < 3; week++) {
    const r = await e.propose({ topic: ' Location ', question: 'Share where you are with Bob?' });
    assert.equal(r.topic, 'location');
    const done = e.relay.decideRequest(e.a.id, r.id, { action: week === 1 ? 'edit' : 'send', revision: 1, ...(week === 1 ? { draft: { text: 'Near the park' } } : {}) });
    assert.equal(done.state, 'ENQUEUED');
    // A retried decision returns what happened and records nothing twice.
    assert.equal(e.relay.decideRequest(e.a.id, r.id, { action: 'send', revision: 1 }).state, 'ENQUEUED');
    if (week < 2) e.advance(7 * DAY);
  }
  const decisions = e.db.prepare("SELECT answer, weekday, via, client_id FROM owner_decisions WHERE owner_bot = ? AND topic = 'location'").all(e.a.id);
  assert.equal(decisions.length, 3);
  assert.ok(decisions.every((d) => d.answer === 'share' && d.weekday === 'wed' && d.via === 'owner_request' && d.client_id.startsWith('request:')));
  // They become past answers the bot judges from, not a rule.
  assert.equal(e.settings().new_learned_rules.length, 0);
  assert.deepEqual(e.settings().contacts.find((c) => c.handle === '@bob').past_answers.map(({ topic, answer, times, days }) => [topic, answer, times, days]), [['location', 'share', 3, ['wed']]]);
  // A no counts too, and a bot can't take the request's decision ID first.
  const money = await e.propose({ topic: 'money' });
  e.relay.decideRequest(e.a.id, money.id, { action: 'decline', revision: 1 });
  assert.equal(e.db.prepare("SELECT answer FROM owner_decisions WHERE owner_bot = ? AND topic = 'money'").get(e.a.id).answer, 'decline');
  const r = await e.a.api('POST', '/v1/decisions', { contact: '@bob', topic: 'location', answer: 'share', client_id: 'request:req_future' });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /reserved/);
  // The owner's own words could mean yes or no, so they teach nothing.
  const own = await e.propose({ topic: 'plans' });
  e.relay.decideRequest(e.a.id, own.id, { action: 'write', revision: 1, draft: { text: 'Ask me later' } });
  assert.equal(e.db.prepare("SELECT count(*) AS n FROM owner_decisions WHERE owner_bot = ? AND topic = 'plans'").get(e.a.id).n, 0);
  // Without a topic nothing is learned, as before.
  const plain = await e.propose({ to: '@carol' });
  e.relay.decideRequest(e.a.id, plain.id, { action: 'send', revision: 1 });
  assert.equal(e.db.prepare('SELECT count(*) AS n FROM owner_decisions WHERE owner_bot = ? AND peer_bot = ?').get(e.a.id, e.c.id).n, 0);
});

test('turning it on for everyone keeps how each bot behaved: friends, and asks-first stays asks-first, once', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'gov-all-')), 'relay.db');
  const e = await fixture(t, { dbPath, privacyPilot: false });
  e.db.prepare('UPDATE contacts SET privacy_on = 1 WHERE owner_bot = ? AND peer_bot = ?').run(e.a.id, e.c.id);
  const all = createRelay({ dbPath, adminToken: 'test-admin-token-for-pilot', privacyPilot: true });
  const mine = all.getSettings(e.a.id).contacts;
  const bob = mine.find((c) => c.peer_bot === e.b.id), carol = mine.find((c) => c.peer_bot === e.c.id);
  assert.equal(bob.circle.name, 'friends'); assert.equal(bob.effective_mode, 'handles');
  assert.equal(carol.circle.name, 'friends'); assert.equal(carol.effective_mode, 'asks', 'still asks first');
  assert.equal((await e.send()).status, 200, 'the bot still writes to Bob on its own');
  // Someone connected later is not sorted yet, even after a restart.
  all.db.prepare('UPDATE contacts SET circle_id = NULL WHERE owner_bot = ? AND peer_bot = ?').run(e.a.id, e.b.id);
  const again = createRelay({ dbPath, adminToken: 'test-admin-token-for-pilot', privacyPilot: true });
  assert.equal(again.getSettings(e.a.id).contacts.find((c) => c.peer_bot === e.b.id).circle, null);
  all.db.close(); again.db.close();
});
