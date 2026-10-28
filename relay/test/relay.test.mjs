// End-to-end tests: real HTTP relay, the real CLI, and two simulated bots whose
// "webhook routine" is a local HTTP server that runs the CLI when rung.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import * as fsMod from 'node:fs';
const require_fs = () => fsMod;
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay, LIMITS } from '../server.mjs';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'b2b.mjs');
const ADMIN = 'admin-token-for-tests-123456';

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve({ server: s, url: `http://127.0.0.1:${s.address().port}` }));
});

async function setup(t0, opts = {}) {
  let t = Date.now();
  const clock = opts.fakeClock ? () => t : Date.now;
  const relay = createRelay({ adminToken: ADMIN, adminEnroll: true, allowLocalWebhooks: true, clock, limits: opts.limits ?? { ringFloorMs: 300, urgentFloorMs: 100 } });
  const { server, url } = await listen(relay.handle);
  // Real relays tick every 2 s; tests tick fast unless they control the clock.
  const timer = opts.fakeClock ? null : setInterval(() => { relay.tick().catch(() => {}); }, 100);
  const closers = [() => server.close(), () => timer && clearInterval(timer)];
  t0.after(() => { for (const c of closers) c(); });
  const admin = async (path, body) => (await fetch(url + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
  const bot = (name) => {
    const home = mkdtempSync(join(tmpdir(), `b2b-${name}-`));
    const cli = async (...args) => (await run(process.execPath, [CLI, ...args], { env: { ...process.env, B2B_HOME: home } })).stdout;
    return { name, home, cli };
  };
  return { relay, url, admin, bot, server, closers, advance: (ms) => { t += ms; }, close: () => {} };
}

async function enroll(env, b) {
  const { code } = await env.admin('/admin/enroll', { handle: b.name, display_name: b.name });
  await b.cli('enroll', env.url, code);
}

// A fake GrokBot routine: when rung, it behaves like the doorbell instruction.
async function fakeRoutine(env, b, { onRing, behave = 'normal' } = {}) {
  const rings = [];
  const told = [];
  const { server, url } = await listen(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    rings.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
    res.writeHead(200).end('{}');
    onRing?.();
    if (behave === 'ignore') return;
    for (let i = 0; i < 5; i++) {
      const out = await b.cli('inbox', '--via', 'doorbell');
      if (out.trim() === 'INBOX EMPTY. Stop here. Nothing more to tell your owner, and if no message came for them, say nothing at all.') break;
      for (const id of out.matchAll(/^[^|\n].*b2b\.mjs ack (msg_[\w~-]+)$/gm)) {
        told.push(out);
        if (behave !== 'claim-only') await b.cli('ack', id[1]);
      }
    }
  });
  env.closers.push(() => server.close());
  return { server, url: `${url}/automations/webhook/test`, rings, told };
}

const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('timed out');
};

test('send Anna a link: pair, doorbell verify, wake, deliver, reply', async (t0) => {
  const env = await setup(t0);
  const ben = env.bot('ben'); const anna = env.bot('anna');
  await enroll(env, ben); await enroll(env, anna);

  // Pairing
  const inv = await ben.cli('invite', 'anna');
  const code = inv.match(/: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await anna.cli('accept', code, 'ben');
  assert.match(await ben.cli('contacts'), /anna\s+@anna/);
  assert.match(await anna.cli('contacts'), /ben\s+@ben/);

  // Anna's doorbell + verification via probe claim
  const routine = await fakeRoutine(env, anna);
  await anna.cli('doorbell', 'set', routine.url, '--key', 'secret-webhook-key');
  assert.match(await anna.cli('doorbell', 'test'), /HTTP 200/);
  await waitFor(async () => (await anna.cli('doorbell', 'status')).includes('verified ('));

  // The actual flow
  await env.relay.tick();
  const sent = await ben.cli('send', 'anna', 'Check this out', '--link', 'https://x.com/someone/status/123');
  const id = sent.match(/Sent (msg_[\w-]+)/)[1];
  try { await waitFor(async () => (await ben.cli('status', id)).includes(': passed_on')); }
  catch (e) { console.log(JSON.stringify((await env.admin('/admin/events')).events.map((x) => [x.handle, x.kind, x.detail]))); console.log(await ben.cli('status', id)); throw e; }
  const toldText = routine.told.join('\n');
  assert.match(toldText, /from "ben"/);
  assert.match(toldText, /https:\/\/x\.com\/someone\/status\/123/);
  assert.equal(routine.rings.at(-1).auth, 'Bearer secret-webhook-key');
  assert.equal(JSON.stringify(routine.rings.at(-1).body).includes('Check this out'), false, 'ring must not carry content');

  // Anna replies; ben's bot has no doorbell, so it waits in ben's inbox.
  await anna.cli('reply', 'ben', 'Thanks, will watch tonight');   // by contact name: answers ben's latest message
  assert.match(await ben.cli('status', id), /replied[\s\S]*Thanks, will watch tonight/);
  assert.match(await ben.cli('inbox'), /REPLY to msg_[\s\S]*Thanks, will watch tonight/);
  routine.server.close(); env.close();
});

test('strangers cannot message, aliases are per-owner, limits apply', async (t0) => {
  const env = await setup(t0);
  const a = env.bot('alice'); const b = env.bot('bob');
  await enroll(env, a); await enroll(env, b);
  await assert.rejects(a.cli('send', '@bob', 'hi'), /no contact/);
  const code = (await a.cli('invite', 'bob')).match(/: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await assert.rejects(a.cli('accept', code, 'me'), /own invite/);
  await b.cli('accept', code, 'alice');
  await assert.rejects(b.cli('accept', code, 'alice2'), /invalid, used or expired/);
  await assert.rejects(a.cli('send', 'bob', 'x'.repeat(LIMITS.textMax + 1)), /longer than/);
  await assert.rejects(a.cli('send', 'bob', 'hi', '--link', 'javascript:alert(1)'), /http\(s\)/);
  // bad token
  const res = await fetch(`${env.url}/v1/me`, { headers: { authorization: 'Bearer nope' } });
  assert.equal(res.status, 401);
  // webhook host allowlist (local allowed only in tests; non-cursor https rejected)
  await assert.rejects(b.cli('doorbell', 'set', 'https://evil.example.com/hook', '--key', '12345678'), /webhook host/);
  await assert.rejects(b.cli('doorbell', 'set', 'https://api2.cursor.sh/v1/other', '--key', '12345678'), /routine webhook/);
  env.close();
});

test('re-rings until claimed, and re-rings after an expired lease', async (t0) => {
  const env = await setup(t0, { fakeClock: true, limits: {} });
  const a = env.bot('ann'); const b = env.bot('ben');
  await enroll(env, a); await enroll(env, b);
  const code = (await a.cli('invite', 'ben')).match(/: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await b.cli('accept', code, 'ann');
  const asleep = await fakeRoutine(env, b, { behave: 'ignore' }); // run starts but never reads inbox
  await b.cli('doorbell', 'set', asleep.url, '--key', 'k-12345678');
  const id = (await a.cli('send', 'ben', 'hello')).match(/Sent (msg_[\w-]+)/)[1];
  await env.relay.tick();
  await waitFor(() => asleep.rings.length >= 1);
  await env.relay.tick();                 // too soon: no extra ring
  assert.equal(asleep.rings.length, 1);
  env.advance(31_000); await env.relay.tick();
  await waitFor(() => asleep.rings.length >= 2);
  env.advance(121_000); await env.relay.tick();
  await waitFor(() => asleep.rings.length >= 3);
  assert.match(await a.cli('status', id), /: rung/);

  // Now the bot claims but never acks: after the lease expires, it is rung again.
  const claimed = JSON.parse(JSON.stringify(await (await fetch(`${env.url}/v1/inbox/claim`, { method: 'POST', headers: { authorization: `Bearer ${JSON.parse((await import('node:fs')).readFileSync(join(b.home, 'config.json'), 'utf8')).token}`, 'content-type': 'application/json' }, body: '{}' })).json()));
  assert.equal(claimed.messages.length, 1);
  const before = asleep.rings.length;
  env.advance(LIMITS.leaseMs + 1_000); await env.relay.tick();
  await waitFor(() => asleep.rings.length > before);
  const again = await b.cli('inbox');
  assert.match(again, /shown before/);
  asleep.server.close(); env.close();
});

test('coalesces: quick messages are batched and all get delivered', async (t0) => {
  const env = await setup(t0, { limits: { ringFloorMs: 3000, urgentFloorMs: 1000 } });
  const a = env.bot('cat'); const b = env.bot('dan');
  await enroll(env, a); await enroll(env, b);
  const code = (await a.cli('invite', 'dan')).match(/: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await b.cli('accept', code, 'cat');
  const routine = await fakeRoutine(env, b);
  await b.cli('doorbell', 'set', routine.url, '--key', 'k-12345678');
  const ids = [];
  for (const t of ['one', 'two', 'three']) ids.push((await a.cli('send', 'dan', t)).match(/Sent (msg_[\w-]+)/)[1]);
  await waitFor(async () => (await a.cli('status', ids[2])).includes(': passed_on'), 8000);
  for (const id of ids) assert.match(await a.cli('status', id), /: passed_on/);
  assert.ok(routine.rings.length <= 2, `expected batched rings, got ${routine.rings.length}`);
  routine.server.close(); env.close();
});

test('audit fixes: dedup retries, stale lease fencing, block drops queued, reissue, wake budget, key sealed', async (t0) => {
  const env = await setup(t0, { fakeClock: true, limits: { wakesPerDay: 2 } });
  const a = env.bot('eve'); const b = env.bot('fay');
  await enroll(env, a); await enroll(env, b);
  const code = (await a.cli('invite', 'fay')).match(/: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await b.cli('accept', code, 'eve');
  // duplicate send (retry after lost response) collapses
  const first = (await a.cli('send', 'fay', 'same thing')).match(/Sent (msg_[\w-]+)/)[1];
  assert.match(await a.cli('send', 'fay', 'same thing'), new RegExp(`Already sent as ${first}`));
  // stale lease: run 1 claims, lease expires, run 2 claims, run 1's late ack is rejected
  const tok = JSON.parse((await import('node:fs')).readFileSync(join(b.home, 'config.json'), 'utf8')).token;
  const H = { authorization: `Bearer ${tok}`, 'content-type': 'application/json' };
  const c1 = await (await fetch(`${env.url}/v1/inbox/claim`, { method: 'POST', headers: H, body: '{}' })).json();
  env.advance(LIMITS.leaseMs + 1000);
  const c2 = await (await fetch(`${env.url}/v1/inbox/claim`, { method: 'POST', headers: H, body: '{}' })).json();
  assert.equal(c2.messages[0].id, first);
  const stale = await fetch(`${env.url}/v1/messages/${first}/ack`, { method: 'POST', headers: H, body: JSON.stringify({ lease: c1.messages[0].lease }) });
  assert.equal(stale.status, 409);
  const fresh = await fetch(`${env.url}/v1/messages/${first}/ack`, { method: 'POST', headers: H, body: JSON.stringify({ lease: c2.messages[0].lease }) });
  assert.equal(fresh.status, 200);
  // block: queued message from a now-blocked contact is dropped, never shown
  const m2 = (await a.cli('send', 'fay', 'second')).match(/Sent (msg_[\w-]+)/)[1];
  await fetch(`${env.url}/v1/contacts/block`, { method: 'POST', headers: H, body: JSON.stringify({ contact: 'eve' }) });
  assert.match(await b.cli('inbox'), /INBOX EMPTY/);
  assert.match(await a.cli('status', m2), /not_delivered/);
  // reissue replaces the token
  const { code: rc } = await env.admin('/admin/reissue', { handle: 'fay' });
  // The old connection still works, so replacing it on this computer takes --again (and the code isn't used up).
  await assert.rejects(b.cli('enroll', env.url, rc), /already has a bot2bot connection, @fay[^]*--again/);
  await b.cli('enroll', env.url, rc, '--again');
  assert.equal((await fetch(`${env.url}/v1/me`, { headers: H })).status, 401, 'old token revoked');
  // webhook key is stored sealed when a key secret is configured
  const sealed = createRelay({ adminToken: ADMIN, adminEnroll: true, allowLocalWebhooks: true, keySecret: 'k'.repeat(32) });
  const { server, url } = await listen(sealed.handle); t0.after(() => server.close());
  const ec = await (await fetch(url + '/admin/enroll', { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'gus' }) })).json();
  const et = await (await fetch(url + '/v1/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: ec.code }) })).json();
  await fetch(url + '/v1/doorbell', { method: 'POST', headers: { authorization: `Bearer ${et.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:9/automations/webhook/x', key: 'plain-secret-key' }) });
  const stored = sealed.db.prepare('SELECT webhook_key FROM bots WHERE handle = ?').get('gus').webhook_key;
  assert.ok(stored.startsWith('enc:v1:') && !stored.includes('plain-secret-key'));
});

test('wake budget: stops ringing after the daily cap', async (t0) => {
  const env = await setup(t0, { fakeClock: true, limits: { wakesPerDay: 2 } });
  const a = env.bot('hal'); const b = env.bot('ivy');
  await enroll(env, a); await enroll(env, b);
  const code = (await a.cli('invite', 'ivy')).match(/: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await b.cli('accept', code, 'hal');
  const asleep = await fakeRoutine(env, b, { behave: 'ignore' });
  await b.cli('doorbell', 'set', asleep.url, '--key', 'k-12345678');
  await a.cli('send', 'ivy', 'one');
  await env.relay.tick(); await waitFor(() => asleep.rings.length >= 1);
  env.advance(31_000); await env.relay.tick(); await waitFor(() => asleep.rings.length >= 2);
  env.advance(121_000); await env.relay.tick();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(asleep.rings.length, 2, 'third ring blocked by budget');
});

test('round 2 fixes: reply dedup, client_id conflict, ack needs active claim, test ring budget, reissue invalidation, block cancels rings', async (t0) => {
  const env = await setup(t0, { fakeClock: true, limits: { wakesPerDay: 3 } });
  const a = env.bot('jon'); const b = env.bot('kim');
  await enroll(env, a); await enroll(env, b);
  const code = (await a.cli('invite', 'kim')).match(/: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await b.cli('accept', code, 'jon');
  const tok = (h) => JSON.parse((require_fs()).readFileSync(join(h.home, 'config.json'), 'utf8')).token;
  const call = async (h, method, path, body) => fetch(env.url + path, { method, headers: { authorization: `Bearer ${tok(h)}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  // two different questions, both answered "Yes": two distinct replies
  const q1 = (await a.cli('send', 'kim', 'Coming Friday?', '--ask')).match(/Sent (msg_[\w-]+)/)[1];
  const q2 = (await a.cli('send', 'kim', 'Bringing cake?', '--ask')).match(/Sent (msg_[\w-]+)/)[1];
  const r1 = (await b.cli('reply', q1, 'Yes')).match(/Replied with (msg_[\w-]+)/)[1];
  const r2 = (await b.cli('reply', q2, 'Yes')).match(/Replied with (msg_[\w-]+)/)[1];
  assert.notEqual(r1, r2);
  // client_id reuse for different content: 409
  await a.cli('send', 'kim', 'A', '--client-id', 'x1');
  await assert.rejects(a.cli('send', 'kim', 'B', '--client-id', 'x1'), /409/);
  // plain text between two bots with keys is refused: nothing readable reaches the relay
  const plain = await call(a, 'POST', '/v1/messages', { to: 'kim', text: 'hello' });
  assert.equal(plain.status, 400);
  assert.match((await plain.json()).error, /end-to-end encrypted/);
  // ack without a claim: 409
  assert.equal((await call(b, 'POST', `/v1/messages/${q1}/ack`, {})).status, 409);
  // test ring respects the wake budget
  const routine = await fakeRoutine(env, b, { behave: 'ignore' });
  await b.cli('doorbell', 'set', routine.url, '--key', 'k-12345678');
  let ok = 0;
  for (let i = 0; i < 5; i++) { env.advance(10_000); const r = await call(b, 'POST', '/v1/doorbell/test', {}); if (r.status === 200) ok++; }
  assert.ok(routine.rings.length <= 3, `rings ${routine.rings.length} exceed budget`);
  // reissue: an older code cannot undo a newer recovery
  const { code: c1 } = await env.admin('/admin/reissue', { handle: 'kim' });
  const { code: c2 } = await env.admin('/admin/reissue', { handle: 'kim' });
  await b.cli('enroll', env.url, c2, '--again');
  await assert.rejects(b.cli('enroll', env.url, c1, '--again'), /invalid, used or expired/);
});

test('block cancels pending wake-ups immediately', async (t0) => {
  const env = await setup(t0, { fakeClock: true, limits: {} });
  const a = env.bot('lou'); const b = env.bot('max');
  await enroll(env, a); await enroll(env, b);
  const code = (await a.cli('invite', 'max')).match(/: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await b.cli('accept', code, 'lou');
  const routine = await fakeRoutine(env, b, { behave: 'ignore' });
  await b.cli('doorbell', 'set', routine.url, '--key', 'k-12345678');
  await a.cli('send', 'max', 'spam 1');
  await env.relay.tick(); await waitFor(() => routine.rings.length >= 1);
  const t = JSON.parse(require_fs().readFileSync(join(b.home, 'config.json'), 'utf8')).token;
  await fetch(`${env.url}/v1/contacts/block`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ contact: 'lou' }) });
  env.advance(31_000); await env.relay.tick(); env.advance(121_000); await env.relay.tick();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(routine.rings.length, 1);
});

test('upgrades a database created by v0.1', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(mkdtempSync(join(tmpdir(), 'b2b-old-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE bots (id INTEGER PRIMARY KEY, handle TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL, token_hash TEXT UNIQUE, created_at INTEGER NOT NULL,
              webhook_url TEXT, webhook_key TEXT, doorbell_verified_at INTEGER, last_ring_at INTEGER, last_ring_status INTEGER, last_claim_at INTEGER);
            CREATE TABLE enroll_codes (code_hash TEXT PRIMARY KEY, handle TEXT NOT NULL, display_name TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
            CREATE TABLE messages (id TEXT PRIMARY KEY, from_bot INTEGER NOT NULL, to_bot INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
              links TEXT NOT NULL DEFAULT '[]', reply_to TEXT, urgent INTEGER NOT NULL DEFAULT 0, client_id TEXT, created_at INTEGER NOT NULL, status TEXT NOT NULL,
              lease_until INTEGER, claim_count INTEGER NOT NULL DEFAULT 0, first_claimed_at INTEGER, delivered_at INTEGER, note TEXT,
              ring_count INTEGER NOT NULL DEFAULT 0, next_ring_at INTEGER, first_rung_at INTEGER, replied_at INTEGER, UNIQUE (from_bot, client_id));`);
  old.close();
  const relay = createRelay({ adminToken: ADMIN, dbPath: path, allowLocalWebhooks: true });
  for (const [table, col] of [['bots', 'wake_day'], ['bots', 'wake_count'], ['bots', 'doorbell_gen'], ['enroll_codes', 'reissue'], ['messages', 'lease_token'], ['messages', 'probe_gen'], ['contacts', 'approved_at'], ['bots', 'paused_at'], ['bots', 'disconnected_at'], ['messages', 'body_purged_at'], ['invites', 'by_owner']]) {
    assert.ok(relay.db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col), `${table}.${col} missing`);
  }
});

test('paused doorbell: refused rings show doorbell_off and do not use the wake budget', async (t0) => {
  const env = await setup(t0, { fakeClock: true, limits: {} });
  const a = env.bot('ned'); const b = env.bot('ola');
  await enroll(env, a); await enroll(env, b);
  const code = (await a.cli('invite', 'ola')).match(/: ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await b.cli('accept', code, 'ned');
  let paused = true; let rings = 0;
  const { server, url } = await listen(async (req, res) => { rings++; res.writeHead(paused ? 400 : 200).end('{}'); });
  env.closers.push(() => server.close());
  await b.cli('doorbell', 'set', `${url}/automations/webhook/x`, '--key', 'k-12345678');
  const id = (await a.cli('send', 'ola', 'hello')).match(/Sent (msg_[\w-]+)/)[1];
  await env.relay.tick(); await waitFor(() => rings >= 1);
  await waitFor(async () => /doorbell_off/.test(await a.cli('status', id)));
  assert.match(await b.cli('whoami'), /wake-ups today: 0\//);
  env.advance(61_000); await env.relay.tick(); await waitFor(() => rings >= 2);   // refused: retried after 1 min
  paused = false; env.advance(61_000); await env.relay.tick(); await waitFor(() => rings >= 3);
  assert.match(await a.cli('status', id), /: rung/);
});
