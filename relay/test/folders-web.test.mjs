// The web version of shared folders v2: the browser's crypto, run under Node's WebCrypto. It must interoperate with
// the CLI's b2b1 seal/unseal byte for byte, follow format 2 exactly (chunks, nonces, AAD, sha256), merge text like the
// spec says, and talk to the v2 API (a small fake here, built from the spec) as a linked device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nc from 'node:crypto';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { folderCrypto, folderMerge, folderClient, folderZip, FOLDERS_JS } from '../folders-web.mjs';
import zlib from 'node:zlib';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const core = folderCrypto(globalThis.crypto);
const merge = folderMerge();
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

// The CLI's own b2b1 code, cut out of cli/b2b.mjs, with its randomness injectable (the rest of unseal's cleanup
// helpers are stubbed: they only filter fields).
function cliB2b1({ eph, nonce } = {}) {
  const src = readFileSync(new URL('../cli/b2b.mjs', import.meta.url), 'utf8');
  const part = src.slice(src.indexOf('const b64 = (b) =>'), src.indexOf('const handoffMeta'));
  assert.match(part, /function seal\(payload[^]*function unseal\(sealed/);
  const fake = { ...nc,
    generateKeyPairSync: (t, ...a) => (t === 'x25519' && eph ? eph : nc.generateKeyPairSync(t, ...a)),
    randomBytes: (n) => (n === 12 && nonce ? Buffer.from(nonce) : nc.randomBytes(n)) };
  const names = ['generateKeyPairSync', 'createPublicKey', 'createPrivateKey', 'diffieHellman', 'hkdfSync', 'createCipheriv', 'createDecipheriv', 'randomBytes', 'sign', 'verify'];
  return new Function(...names, 'TEXT_MAX', 'WANT_MAX', 'fileMetas', 'THREAD_ID_RE', 'handoffMeta', 'crossMeta', 'jobMeta', 'GROUP_POST_RE', `${part}\nreturn { seal, unseal, newKeys, publicKeys };`)(
    ...names.map((n) => fake[n]), 8000, 160, () => [], /^t_/, () => null, () => null, () => null, /^p_/);
}
const jwkPriv = (crv, k) => subtle.importKey('jwk', { kty: 'OKP', crv, x: k.x, d: k.d }, { name: crv }, false, crv === 'Ed25519' ? ['sign'] : ['deriveBits']);
const webEph = async (pair) => ({
  privateKey: await subtle.importKey('jwk', pair.privateKey.export({ format: 'jwk' }), { name: 'X25519' }, false, ['deriveBits']),
  publicKey: await subtle.importKey('jwk', pair.publicKey.export({ format: 'jwk' }), { name: 'X25519' }, true, []),
});

test('b2b1: the browser seals byte for byte like the CLI, and each opens the other', async () => {
  const cli = cliB2b1();
  const ben = cli.newKeys(), anna = cli.newKeys();
  const meta = { from: ben.sign.x, to: anna.box.x, kind: 'team-folder/2/7/f_' + 'a'.repeat(32) + '/1' };
  const manifest = { v: 2, path: 'notes/plan.md', size: 3, sha256: 'b'.repeat(64), mime: 'text/markdown', mtime: 1, key: core.b64(core.random(32)), chunk_size: core.CHUNK, chunks: 1, base: 0 };

  // Same ephemeral key and nonce: the same string, character for character.
  const eph = nc.generateKeyPairSync('x25519'), nonce = nc.randomBytes(12);
  const fromCli = cliB2b1({ eph, nonce }).seal(manifest, { keys: ben, peer: cli.publicKeys(anna), meta });
  const fromWeb = await core.seal(manifest, { sign: await jwkPriv('Ed25519', ben.sign), peerBox: anna.box.x, meta }, { eph: await webEph(eph), nonce: new Uint8Array(nonce) });
  assert.equal(fromWeb, fromCli);

  // CLI → browser, with fresh randomness.
  const sealed = cli.seal(manifest, { keys: ben, peer: cli.publicKeys(anna), meta });
  const box = await jwkPriv('X25519', anna.box);
  assert.deepEqual(await core.unseal(sealed, { box, boxPub: anna.box.x, peerSign: ben.sign.x, meta }), manifest);
  // Browser → CLI: the CLI's unseal opens it (it keeps the fields it knows, like text).
  const web = await core.seal({ text: 'hello from the browser', cid: 'c1' }, { sign: await jwkPriv('Ed25519', ben.sign), peerBox: anna.box.x, meta });
  assert.equal(cli.unseal(web, { keys: anna, peer: cli.publicKeys(ben), meta }).text, 'hello from the browser');

  // Bound to the header, the signer and every byte.
  await assert.rejects(core.unseal(sealed, { box, boxPub: anna.box.x, peerSign: ben.sign.x, meta: { ...meta, kind: meta.kind.replace(/1$/, '2') } }), /signature/);
  await assert.rejects(core.unseal(sealed, { box, boxPub: anna.box.x, peerSign: anna.sign.x, meta }), /signature/);
  const parts = sealed.split('.'), ct = core.unb64(parts[3]); ct[0] ^= 1; parts[3] = core.b64(ct);
  await assert.rejects(core.unseal(parts.join('.'), { box, boxPub: anna.box.x, peerSign: ben.sign.x, meta }), /signature/);
  assert.throws(() => cli.unseal(web.replace(/\.[^.]+$/, '.' + 'A'.repeat(86)), { keys: anna, peer: cli.publicKeys(ben), meta }), /signature/);
});

test('ChaCha20-Poly1305 matches node:crypto at every block boundary', () => {
  for (const n of [0, 1, 15, 16, 63, 64, 65, 129, 1000, 8000]) {
    const key = nc.randomBytes(32), nonce = nc.randomBytes(12), aad = nc.randomBytes(n % 37), plain = nc.randomBytes(n);
    const c = nc.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    c.setAAD(aad);
    const want = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    const got = core.aeadSeal(new Uint8Array(key), new Uint8Array(nonce), new Uint8Array(aad), new Uint8Array(plain));
    assert.equal(Buffer.from(got).toString('hex'), want.toString('hex'), `length ${n}`);
    assert.deepEqual(Buffer.from(core.aeadOpen(new Uint8Array(key), new Uint8Array(nonce), new Uint8Array(aad), got)), plain);
  }
});

test('format 2: 4 MiB chunks, counter nonces, the AAD string, sha256 checked before anything comes out', async () => {
  const ctx = { group: 7, fileId: 'f_' + 'c'.repeat(32), version: 3 };
  const data = new Uint8Array(nc.randomBytes(2 * core.CHUNK + 123));
  const { manifest, chunk } = await core.encryptVersion({ ...ctx, data, path: 'data/set.bin', base: 2, mtime: 5 });
  assert.equal(manifest.chunks, 3);
  assert.deepEqual(Object.keys(manifest), ['v', 'path', 'size', 'sha256', 'mime', 'mtime', 'key', 'chunk_size', 'chunks', 'base']);
  assert.equal(manifest.sha256, nc.createHash('sha256').update(data).digest('hex'));
  const chunks = [await chunk(0), await chunk(1), await chunk(2)];
  assert.deepEqual(chunks.map((c) => c.length), [core.CHUNK + 16, core.CHUNK + 16, 123 + 16]);

  // Independently, with node:crypto and the spec's own words: nonce 00000000 || uint64be(i), AAD with i and n.
  const iv = Buffer.alloc(12); iv.writeBigUInt64BE(1n, 4);
  const d = nc.createDecipheriv('aes-256-gcm', core.unb64(manifest.key), iv);
  d.setAAD(Buffer.from(`b2b-folder/2|7|${ctx.fileId}|3|1|3`)); d.setAuthTag(chunks[1].subarray(-16));
  assert.deepEqual(Buffer.concat([d.update(chunks[1].subarray(0, -16)), d.final()]), Buffer.from(data.subarray(core.CHUNK, 2 * core.CHUNK)));

  const get = (list) => async (i) => list[i];
  assert.deepEqual(await core.decryptVersion(manifest, ctx, get(chunks)), data);
  // Tampered, reordered, truncated, swapped between versions, or a lying manifest: nothing comes out.
  const bad = chunks.map((c) => c.slice()); bad[2][5] ^= 1;
  await assert.rejects(core.decryptVersion(manifest, ctx, get(bad)), /failed its check/);
  await assert.rejects(core.decryptVersion(manifest, ctx, get([chunks[1], chunks[0], chunks[2]])), /failed its check/);
  await assert.rejects(core.decryptVersion(manifest, ctx, get([chunks[0], chunks[1], chunks[2].subarray(0, 50)])), /wrong size/);
  await assert.rejects(core.decryptVersion({ ...manifest, chunks: 2, size: 2 * core.CHUNK }, ctx, get(chunks)), /failed its check/);
  await assert.rejects(core.decryptVersion(manifest, { ...ctx, version: 4 }, get(chunks)), /failed its check/);
  await assert.rejects(core.decryptVersion({ ...manifest, sha256: 'f'.repeat(64) }, ctx, get(chunks)), /file failed its check/);

  // An empty file is one empty chunk; a deletion has none.
  const empty = await core.encryptVersion({ ...ctx, data: new Uint8Array(0), path: 'empty.txt', base: 0 });
  assert.equal(empty.manifest.chunks, 1);
  assert.equal((await empty.chunk(0)).length, 16);
  assert.equal((await core.decryptVersion(empty.manifest, ctx, async () => empty.chunk(0))).length, 0);
  const gone = core.tombstone({ path: 'empty.txt', base: 1 });
  assert.equal(gone.sha256, nc.createHash('sha256').update('').digest('hex'));
  assert.deepEqual([gone.chunks, gone.size, gone.deleted, core.unb64(gone.key).length], [0, 0, true, 32]);
  assert.equal(core.checkManifest(gone), gone);

  // Suggestion parts: their own key each, and the b2b-suggestion/1 AAD with the proposal and part bound in.
  const sctx = { group: 7, fileId: ctx.fileId, proposal: 'p_' + 'd'.repeat(32), part: 'proposed' };
  const part = await core.encryptPart({ ...sctx, data: enc.encode('new text\n') });
  const sc = await part.chunk(0);
  const siv = Buffer.alloc(12), sd = nc.createDecipheriv('aes-256-gcm', core.unb64(part.desc.key), siv);
  sd.setAAD(Buffer.from(`b2b-suggestion/1|7|${ctx.fileId}|${sctx.proposal}|proposed|0|1`)); sd.setAuthTag(sc.subarray(-16));
  assert.equal(Buffer.concat([sd.update(sc.subarray(0, -16)), sd.final()]).toString(), 'new text\n');
  assert.equal(new TextDecoder().decode(await core.decryptPart(part.desc, sctx, async () => sc)), 'new text\n');
  await assert.rejects(core.decryptPart(part.desc, { ...sctx, part: 'current' }, async () => sc), /failed its check/);

  // Paths: relative, "/", no "..", no leading "/", ≤ 1024 bytes, NFC.
  for (const ok of ['a.md', 'Plans/Q4 plan.docx', 'ěščř/ž.txt']) assert.equal(core.checkPath(ok), ok);
  for (const no of ['', '/a', 'a/../b', '../a', 'a//b', 'a/', './a', 'a\\b', 'é.md', 'x'.repeat(1025), 'a\nb']) assert.throws(() => core.checkPath(no), /invalid path/, JSON.stringify(no));
});

test('three-way merge: separate edits merge, insertions at one spot keep both in commit order, overlaps do not', () => {
  const base = 'one\ntwo\nthree\nfour\nfive\nsix\n';
  assert.deepEqual(merge.merge3(base, 'ONE\ntwo\nthree\nfour\nfive\nsix\n', 'one\ntwo\nthree\nfour\nfive\nSIX\n'), { clean: true, text: 'ONE\ntwo\nthree\nfour\nfive\nSIX\n' });
  assert.deepEqual(merge.merge3(base, 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'zero\none\ntwo\nthree\nfour\nfive\nsix\n'), { clean: true, text: 'zero\none\ntwo\nthree\nfour\nfive\nsix\nseven\n' });
  assert.deepEqual(merge.merge3(base, 'one\nthree\nfour\nfive\nsix\n', 'one\ntwo\nthree\nfour\nsix\n'), { clean: true, text: 'one\nthree\nfour\nsix\n' });
  assert.deepEqual(merge.merge3(base, 'one\ntwo\nTHREE\nfour\nfive\nsix\n', 'one\ntwo\nthree?\nfour\nfive\nsix\n'), { clean: false });
  assert.deepEqual(merge.merge3(base, base.replace('two', 'TWO'), base.replace('two', 'TWO')), { clean: true, text: base.replace('two', 'TWO') });
  // Insertions at the same spot (bullets or CSV rows added at the end) keep both, theirs first, as committed.
  assert.deepEqual(merge.merge3('', 'a\n', 'b\n'), { clean: true, text: 'b\na\n' });
  assert.deepEqual(merge.merge3('- one\n', '- one\n- mine\n', '- one\n- theirs\n'), { clean: true, text: '- one\n- theirs\n- mine\n' });
  assert.deepEqual(merge.merge3('a,1\n', 'a,1\nb,2\n', 'a,1\nc,3\n'), { clean: true, text: 'a,1\nc,3\nb,2\n' });
  assert.deepEqual(merge.merge3('x\n', 'x\ny\n', 'w\nx\n'), { clean: true, text: 'w\nx\ny\n' });
  // A long file with edits at both ends merges without a huge diff.
  const long = Array.from({ length: 20000 }, (_, i) => `line ${i}\n`).join('');
  const m = merge.merge3(long, 'top\n' + long, long + 'bottom\n');
  assert.equal(m.clean, true);
  assert.equal(m.text, 'top\n' + long + 'bottom\n');
  // Applying a reviewed change: only its lines move onto the target; nothing from the original comes back.
  const budget = 'Budget 40\nDecision wait\n';
  assert.deepEqual(merge.apply(budget, 'Budget 40\nDecision hire\n', 'Budget 10\nDecision wait\n'), { ok: true, text: 'Budget 10\nDecision hire\n' });
  // The reviewer overrides a target that changed too, line for line, and still keeps every other line of the target.
  assert.deepEqual(merge.apply(budget, 'Budget 40\nDecision hire\n', 'Budget 10\nDecision maybe\n'), { ok: true, text: 'Budget 10\nDecision hire\n' });
  assert.deepEqual(merge.apply('a\nb\n', 'a\nb\nc\n', 'A\nb\nz\n'), { ok: true, text: 'A\nb\nz\nc\n' });
  assert.deepEqual(merge.apply('a\nb\nc\n', 'a\nB\nc\n', 'a\nc\n'), { ok: true, text: 'a\nB\nc\n' });
  assert.deepEqual(merge.apply('a\nb\nc\n', 'a\nB\nc\n', 'x\ny\nz\nw\n'), { ok: false });
  // 10 MiB of text, edited at both ends, merges, diffs and applies without stalling.
  const fill = (tag) => { const parts = []; for (let n = 0, i = 0; n < 10 * 1024 * 1024 - 2048; i++) { const l = `${tag} ${i} ${'x'.repeat(56)}\n`; parts.push(l); n += l.length; } return parts.join(''); };
  const tenMiB = fill('line');
  assert.ok(tenMiB.length > 9.9 * 1024 * 1024 && tenMiB.length <= 10 * 1024 * 1024, String(tenMiB.length));
  const t0 = Date.now();
  assert.equal(merge.merge3(tenMiB, 'top\n' + tenMiB, tenMiB + 'end\n').text, 'top\n' + tenMiB + 'end\n');
  assert.equal(merge.apply(tenMiB, tenMiB.replace('line 5 ', 'LINE 5 '), tenMiB + 'end\n').text, tenMiB.replace('line 5 ', 'LINE 5 ') + 'end\n');
  assert.equal(merge.diff(tenMiB, tenMiB.replace('line 9 ', 'LINE 9 ')).filter((o) => o.t !== 'same').length, 2);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.deepEqual(merge.diff('a\nb\nc\n', 'a\nB\nc\nd\n').map((o) => o.t + ':' + o.line), ['same:a\n', 'del:b\n', 'add:B\n', 'same:c\n', 'add:d\n']);
});

test('the page script is built from the tested functions and has no imports or eval', () => {
  assert.doesNotThrow(() => new Function(FOLDERS_JS));
  for (const fn of [folderCrypto, folderMerge, folderClient, folderZip]) assert.ok(FOLDERS_JS.includes(fn.toString()));
  assert.doesNotMatch(FOLDERS_JS, /\bimport\(|\beval\(|innerHTML|insertAdjacentHTML|document\.write|new Function/);
});

test('wrapped device keys keep AES-GCM wrapKey and unwrapped Ed25519/X25519 keys non-extractable and interoperate', async () => {
  const { keys, wrapped } = await core.newWrappedDeviceKeys();
  assert.equal(wrapped.v, 2);
  assert.equal(wrapped.wrapKey.extractable, false);
  assert.equal(wrapped.wrapKey.algorithm.name, 'AES-GCM');
  assert.equal(keys.sign.privateKey.extractable, false);
  assert.equal(keys.box.privateKey.extractable, false);
  const restored = await core.unwrapDeviceKeys(wrapped);
  assert.equal(restored.sign.privateKey.extractable, false);
  assert.equal(restored.box.privateKey.extractable, false);
  assert.deepEqual(restored.pub, keys.pub);
  const link = await core.linkRequest(restored, 'web-safari');
  assert.equal(await core.deviceCheck('request', link.request, link.proof, restored.pub.sign), true);
  const peer = await core.newDeviceKeys();
  const meta = { from: restored.pub.sign, to: peer.pub.box, kind: 'team-folder/2/1/f_' + 'a'.repeat(32) + '/1' };
  const sealed = await core.seal({ v: 2, path: 'note.md' }, { sign: restored.sign.privateKey, peerBox: peer.pub.box, meta });
  const opened = await core.unseal(sealed, { box: peer.box.privateKey, boxPub: peer.pub.box, peerSign: restored.pub.sign, meta });
  assert.deepEqual(opened, { v: 2, path: 'note.md' });
});

// ───── a fake v2 relay, from the spec and the relay implementer's notes ─────
async function identity(handle, extra = []) {
  const keys = await core.newDeviceKeys();
  const devices = [{ id: 'primary', name: 'primary', ...keys.pub, keys }];
  for (const name of extra) devices.push({ id: 'd_' + core.hex(core.random(12)), name, ...(await core.newDeviceKeys()).pub });
  for (const d of devices.slice(1)) d.keys = await core.newDeviceKeys(), d.sign = d.keys.pub.sign, d.box = d.keys.pub.box;
  let list = null;
  if (extra.length) {
    const roster = { v: 1, root: keys.pub, revision: extra.length, devices: devices.map(({ id, name, sign, box }) => ({ id, name, sign, box })) };
    list = { roster, signature: core.b64(await subtle.sign('Ed25519', keys.sign.privateKey, core.deviceBytes('roster', roster))) };
  }
  return { handle, root: keys.pub, devices, list };
}
function fakeRelay(group, people) {
  const rows = [], objects = new Map(), uploads = new Map(), suggestions = [], events = [], requests = new Set(), ifSeqs = [];
  let seq = 0, refreshOnce = false;
  const tokens = new Map();
  for (const p of people) for (const d of p.devices) tokens.set(`t_${p.handle}_${d.name}`, { p, d });
  const recipients = () => people.flatMap((p) => p.devices.filter((d) => !d.late).map((d) => ({ handle: p.handle, device: d.name, box: d.box, sign: d.sign })));
  const view = (row, key) => { const { envelopes, backfills, ...r } = row; return { ...r, envelope: envelopes[key] ?? null, ...(backfills?.[key] ? { backfill: backfills[key] } : {}) }; };
  const server = http.createServer(async (req, res) => {
    const send = (s, body, raw = false) => { res.writeHead(s, { 'content-type': raw ? 'application/octet-stream' : 'application/json' }); res.end(raw ? body : JSON.stringify(body)); };
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const u = new URL(req.url, 'http://x');
    let m;
    if ((m = u.pathname.match(/^\/objects\/(\w+)\/(\d+)$/))) {
      const k = `${m[1]}/${m[2]}`;
      if (req.method === 'PUT') { if (req.headers['if-none-match'] !== '*') return send(428, {}); if (objects.has(k)) return send(412, {}); objects.set(k, body); return send(200, {}); }
      return objects.has(k) ? send(200, objects.get(k), true) : send(404, {});
    }
    const who = tokens.get(String(req.headers.authorization).replace('Bearer ', ''));
    if (!who) return send(401, { error: 'unknown token' });
    assert.equal(req.headers['x-b2b-version'], '0.30.0');
    const key = `${who.p.handle}:${who.d.name}`, root = `/v1/team-folders/${group}`, json = body.length ? JSON.parse(body) : null;
    const p = u.pathname.slice(root.length);
    if (!u.pathname.startsWith(root)) return send(404, {});
    if (req.method === 'GET' && p === '') return send(200, { alpha: true, name: 'Research', role: who.p.role ?? 'write', roster: 'r' + people.length, recipients: recipients(), members: people.map((x) => ({ handle: x.handle, role: 'write', sign: x.root.sign, box: x.root.box, device_list: x.list })), quota: { used: [...objects.values()].reduce((s, b) => s + b.length, 0), max: 10 * 1024 ** 3 }, max_file_bytes: 200 * 1024 * 1024, seq });
    if (req.method === 'GET' && p === '/changes') { const since = Number(u.searchParams.get('since')); return send(200, { changes: rows.filter((r) => r.seq > since).map((r) => view(r, key)), suggestion_events: events.filter((e) => e.seq > since), seq }); }
    const fresh = (id) => { assert.match(id, /^req_[0-9a-f]{32}$/); assert.ok(!requests.has(id), 'a new request id per attempt'); requests.add(id); };
    const keysOk = (env) => JSON.stringify(Object.keys(env).sort()) === JSON.stringify(recipients().map((r) => `${r.handle}:${r.device}`).sort());
    const event = (sg) => events.push({ seq: ++seq, proposal_id: sg.proposal_id, file_id: sg.file_id, state: sg.state });
    if (req.method === 'POST' && p === '/suggestions') {
      fresh(json.request_id);
      assert.match(json.proposal_id, /^p_[0-9a-f]{32}$/); assert.match(json.logical_edit_id, /^edit_[0-9a-f]{32}$/);
      if (!keysOk(json.envelopes)) return send(409, { error: 'refresh' });
      for (const part of ['original', 'current', 'proposed', 'intent']) { const up = uploads.get(json.uploads[part]); for (let i = 0; i < up.chunks; i++) if (!objects.has(`${json.uploads[part]}/${i}`)) return send(400, { error: 'missing chunk' }); }
      const sg = { proposal_id: json.proposal_id, file_id: json.file_id, base: json.base, observed: json.observed, logical_edit_id: json.logical_edit_id, state: 'pending', author: '@' + who.p.handle, author_device: who.d.name, sign_key: who.d.sign, root_sign: who.p.root.sign, root_box: who.p.root.box, device_list: who.p.list, created_at: Date.now(), resolved_at: null, resolved_version: null, envelopes: json.envelopes, uploads: json.uploads };
      suggestions.push(sg); event(sg); sg.seq = seq;
      return send(200, { proposal_id: sg.proposal_id, file_id: sg.file_id, state: 'pending', seq });
    }
    const sview = (sg) => { const { envelopes, uploads: _u, ...r } = sg; return { ...r, envelope: envelopes[key] ?? null }; };
    if (req.method === 'GET' && p === '/suggestions') return send(200, { suggestions: suggestions.filter((x) => !u.searchParams.get('file_id') || x.file_id === u.searchParams.get('file_id')).map(sview) });
    if ((m = p.match(/^\/suggestions\/(p_[0-9a-f]{32})$/))) { const sg = suggestions.find((x) => x.proposal_id === m[1]); return send(200, { ...sview(sg), urls: Object.fromEntries(Object.entries(sg.uploads).map(([k, id]) => [k, Array.from({ length: uploads.get(id).chunks }, (_, i) => `/objects/${id}/${i}`)])) }); }
    if ((m = p.match(/^\/suggestions\/(p_[0-9a-f]{32})\/resolve$/))) {
      fresh(json.request_id);
      const sg = suggestions.find((x) => x.proposal_id === m[1]);
      if (json.decision === 'withdraw' && sg.author !== '@' + who.p.handle) return send(403, { error: 'only the author can withdraw' });
      const head = rows.filter((r) => r.file_id === sg.file_id).reduce((n, r) => Math.max(n, r.version), 0);
      if (json.decision === 'reopen') {
        if (sg.state !== 'rejected' || sg.rejected_by !== who.p.handle || Date.now() - sg.resolved_at > 600_000 || json.base !== head || head !== sg.rejected_head) return send(409, { error: 'this suggestion can no longer be reopened' });
        sg.state = 'pending'; sg.resolved_at = null; event(sg);
        return send(200, { proposal_id: sg.proposal_id, state: sg.state, seq });
      }
      if (sg.state !== 'pending') return send(409, { error: 'already resolved' });
      sg.state = json.decision === 'reject' ? 'rejected' : 'withdrawn'; sg.resolved_at = Date.now(); sg.rejected_by = who.p.handle; sg.rejected_head = head; event(sg);
      return send(200, { proposal_id: sg.proposal_id, state: sg.state, seq });
    }
    if (req.method === 'POST' && p === '/uploads') {
      const id = 'u' + core.hex(core.random(8));
      uploads.set(id, json);
      return send(200, { upload_id: id, chunk_size: core.CHUNK, urls: Array.from({ length: json.chunks }, (_, i) => `/objects/${id}/${i}`), expires_at: Date.now() + 900_000 });
    }
    if ((m = p.match(/^\/files\/(f_[0-9a-f]{32})\/history$/))) return send(200, { versions: rows.filter((r) => r.file_id === m[1]).map((r) => view(r, key)) });
    if ((m = p.match(/^\/files\/(f_[0-9a-f]{32})\/(\d+)$/))) {
      const r = rows.find((x) => x.file_id === m[1] && x.version === Number(m[2]));
      return r ? send(200, { ...view(r, key), urls: Array.from({ length: r.chunks }, (_, i) => `/objects/${r.upload_id}/${i}`) }) : send(404, {});
    }
    if ((m = p.match(/^\/files\/(f_[0-9a-f]{32})$/)) && req.method === 'POST') {
      fresh(json.request_id);
      assert.match(json.logical_edit_id, /^edit_[0-9a-f]{32}$/);
      const head = rows.filter((r) => r.file_id === m[1]).reduce((n, r) => Math.max(n, r.version), 0);
      if (json.base !== head) return send(409, { error: 'stale', file_id: m[1], current: head });
      ifSeqs.push(json.if_seq ?? null);
      if (json.if_seq != null && rows.some((r) => r.version === 1 && r.seq > json.if_seq)) return send(409, { error: 'the folder changed after if_seq; reread', seq });
      if (refreshOnce) { refreshOnce = false; return send(409, { error: 'refresh' }); }
      if (JSON.stringify(Object.keys(json.envelopes).sort()) !== JSON.stringify(recipients().map((r) => `${r.handle}:${r.device}`).sort())) return send(409, { error: 'refresh' });
      const up = json.upload_id ? uploads.get(json.upload_id) : { size: 0, chunks: 0 };
      for (let i = 0; i < up.chunks; i++) if (!objects.has(`${json.upload_id}/${i}`)) return send(400, { error: 'missing chunk' });
      const row = { file_id: m[1], version: head + 1, seq: ++seq, author: '@' + who.p.handle, author_device: who.d.name, sign_key: who.d.sign, root_sign: who.p.root.sign, root_box: who.p.root.box, device_list: who.p.list, deleted: !json.upload_id, size: up.size, chunks: up.chunks, created_at: Date.now(), upload_id: json.upload_id, envelopes: json.envelopes };
      rows.push(row);
      if (json.resolve_proposal) { const sg = suggestions.find((x) => x.proposal_id === json.resolve_proposal); sg.state = 'accepted'; sg.resolved_version = row.version; event(sg); }
      return send(200, { file_id: row.file_id, version: row.version, seq: row.seq });
    }
    send(404, { error: 'no route' });
  });
  return { server, rows, objects, suggestions, ifSeqs, refresh: () => { refreshOnce = true; }, bump: (row) => { row.seq = ++seq; } };
}
const clientFor = (url, group, person, name = 'primary', pins = null) => {
  const d = person.devices.find((x) => x.name === name);
  return folderClient({ core, merge, fetch, base: url, group, keys: d.keys, pins, device: { token: `t_${person.handle}_${name}`, handle: person.handle, device: { id: d.id, name }, root: person.root } });
};

test('the browser client: write, read on another device, merge, suggestions, delete, restore, history, tamper', async (t) => {
  const ben = await identity('ben', ['web-chrome']), anna = await identity('anna');
  const relay = fakeRelay(5, [ben, anna]);
  await new Promise((ok) => relay.server.listen(0, '127.0.0.1', ok));
  t.after(() => relay.server.close());
  const url = `http://127.0.0.1:${relay.server.address().port}`;
  const store = new Map(), pins = { get: async (h) => store.get(h), set: async (h, v) => store.set(h, v) };
  const web = clientFor(url, 5, ben, 'web-chrome', pins), other = clientFor(url, 5, anna);
  await web.refresh(); await other.refresh();

  // The browser writes; Anna's device reads it, checked against Ben's signed device list.
  const text = 'one\ntwo\nthree\nfour\nfive\n';
  const made = await web.write({ path: 'notes/plan.md', data: enc.encode(text) });
  assert.match(made.file_id, /^f_[0-9a-f]{32}$/);
  const row = relay.rows.at(-1);
  assert.deepEqual(Object.keys(row.envelopes).sort(), ['anna:primary', 'ben:primary', 'ben:web-chrome']);
  assert.equal(row.author_device, 'web-chrome');
  assert.deepEqual(await other.sync(), [made.file_id]);
  const got = await other.load(made.file_id, 1);
  assert.equal(new TextDecoder().decode(got.data), text);
  assert.equal(other.state.files.get(made.file_id).author, 'ben');
  assert.equal(store.get('ben').revision, 1, 'device list pinned');

  // A multi-chunk binary both ways.
  const big = new Uint8Array(nc.randomBytes(core.CHUNK + 777));
  const bin = await other.write({ path: 'data/set.bin', data: big });
  await web.sync();
  assert.deepEqual((await web.load(bin.file_id, 1)).data, big);

  // Both edit version 1 of the text: different lines merge (the second saver merges).
  await other.write({ fileId: made.file_id, path: 'notes/plan.md', data: enc.encode('ONE\ntwo\nthree\nfour\nfive\n'), base: 1, baseData: got.data });
  const merged = await web.write({ fileId: made.file_id, path: 'notes/plan.md', data: enc.encode('one\ntwo\nthree\nfour\nFIVE\n'), base: 1, baseData: enc.encode(text) });
  assert.deepEqual([merged.outcome, merged.version, merged.with], ['merged', 3, 'anna']);
  await other.sync();
  const now = new TextDecoder().decode((await other.load(made.file_id, 3)).data);
  assert.equal(now, 'ONE\ntwo\nthree\nfour\nFIVE\n');
  const textOf = async (c, v) => new TextDecoder().decode((await c.load(made.file_id, v)).data);
  const edit = async (c, from, to) => { await c.sync(); const f = c.state.files.get(made.file_id), t0 = await textOf(c, f.version); return c.write({ fileId: made.file_id, path: 'notes/plan.md', data: enc.encode(t0.replace(from, to)), base: f.version, baseData: enc.encode(t0) }); };

  // The same line: no second file, ever. Ours becomes a suggestion on the document, with all three texts encrypted.
  await edit(other, 'three', 'THREE');
  const rowsBefore = relay.rows.length;
  const clash = await web.write({ fileId: made.file_id, path: 'notes/plan.md', data: enc.encode(now.replace('three', 'three!')), base: 3, baseData: enc.encode(now) });
  assert.deepEqual([clash.outcome, clash.with], ['suggestion', 'anna']);
  assert.equal(relay.rows.length, rowsBefore);
  const stored = relay.suggestions.at(-1);
  assert.deepEqual([stored.base, stored.observed, stored.state, Object.keys(stored.envelopes).sort()], [3, 4, 'pending', ['anna:primary', 'ben:primary', 'ben:web-chrome']]);
  // Anna's device sees it live from the feed, opens and checks every part.
  await other.sync();
  const [seen] = other.pending();
  assert.deepEqual([seen.proposal_id, seen.author, seen.state], [stored.proposal_id, 'ben', 'pending']);
  const full = await other.details(seen);
  assert.deepEqual([full.original.text, full.current.text, full.proposed.text], [now, now.replace('three', 'THREE'), now.replace('three', 'three!')]);
  assert.deepEqual(full.intent, { edits: [{ old: 'three\n', new: 'three!\n' }], reason: 'overlap', path: 'notes/plan.md' });
  assert.deepEqual(merge.diff(full.current.text, full.proposed.text).filter((o) => o.t !== 'same'), [{ t: 'del', line: 'THREE\n' }, { t: 'add', line: 'three!\n' }]);

  // Accepting applies it to the latest version: Anna changed another line meanwhile, so it merges in, and resolves.
  await edit(other, 'ONE', 'One');
  const yes = await other.accept(seen);
  assert.deepEqual([yes.outcome, yes.version, yes.before], ['saved', 6, 5]);
  assert.deepEqual([stored.state, stored.resolved_version], ['accepted', 6]);
  assert.equal(await textOf(web, 6), 'One\ntwo\nthree!\nfour\nFIVE\n');
  await web.sync();
  assert.equal(web.pending().length, 0);
  assert.equal(web.state.proposals.get(stored.proposal_id).state, 'accepted');

  // When the same line moved on again, accepting commits nothing and asks again. Reject and withdraw resolve it.
  await edit(other, 'two', 'TWO');
  const s2 = (await web.write({ fileId: made.file_id, path: 'notes/plan.md', data: enc.encode('One\ntwo?\nthree!\nfour\nFIVE\n'), base: 6, baseData: enc.encode(await textOf(web, 6)) })).suggestion;
  await edit(other, 'TWO', 'Two');
  const n = relay.rows.length;
  const moved = await web.accept(s2);
  assert.deepEqual([moved.outcome, moved.moved, relay.rows.length], ['suggestion', true, n]);
  // Edited to fit the latest version, then accepted.
  const fitted = await web.accept(s2, { text: 'One\nTwo?\nthree!\nfour\nFIVE\n', basedOn: 8 });
  assert.deepEqual([fitted.outcome, fitted.version], ['saved', 9]);
  await edit(other, 'four', 'FOUR');
  const s3 = (await web.write({ fileId: made.file_id, path: 'notes/plan.md', data: enc.encode('One\nTwo?\nthree!\nfour!\nFIVE\n'), base: 9, baseData: enc.encode(await textOf(web, 9)) })).suggestion;
  await other.sync();
  await assert.rejects(other.resolve(other.pending()[0], 'withdraw'), (e) => e.status === 403);
  await other.resolve(other.pending()[0], 'reject');
  assert.equal(relay.suggestions.find((x) => x.proposal_id === s3.proposal_id).state, 'rejected');
  // Undo files the same suggestion again (as whoever undid it); its author can withdraw it.
  const back = await other.again(await other.details(s3));
  await web.sync();
  assert.equal(web.pending()[0].proposal_id, back.proposal_id);
  await other.resolve(back, 'withdraw');
  assert.equal(relay.suggestions.find((x) => x.proposal_id === back.proposal_id).state, 'withdrawn');
  assert.equal(relay.rows.length, n + 2);
  const final = await textOf(web, 10);

  // A binary changed underneath stops: theirs stays, nothing is lost, and no copy appears.
  await other.write({ fileId: bin.file_id, path: 'data/set.bin', data: new Uint8Array([1]), base: 1 });
  const binRows = relay.rows.length;
  await assert.rejects(web.write({ fileId: bin.file_id, path: 'data/set.bin', data: new Uint8Array([2]), base: 1 }), (e) => e.code === 'changed' && e.with === 'anna');
  assert.equal(relay.rows.length, binRows);

  // Delete writes a tombstone; restore brings it back as a new version; history shows each.
  await web.sync();
  await web.remove(made.file_id);
  await other.sync();
  assert.equal(other.state.files.get(made.file_id).manifest.deleted, true);
  assert.ok(!other.live().some((f) => f.file_id === made.file_id));
  assert.equal(relay.rows.at(-1).size, 0);
  await other.restore(made.file_id, 10);
  await web.sync();
  assert.equal(await textOf(web, 12), final);
  assert.deepEqual((await web.history(made.file_id)).map((v) => [v.version, v.deleted]).slice(0, 3), [[12, false], [11, true], [10, false]]);

  // A changed roster: the commit refreshes, reseals and lands once.
  relay.refresh();
  const again = await web.write({ path: 'after.txt', data: enc.encode('x') });
  assert.equal(relay.rows.filter((r) => r.file_id === again.file_id).length, 1);

  // A stored chunk changed on the server: nothing comes out.
  const target = relay.rows.find((r) => r.file_id === bin.file_id && r.version === 1);
  const obj = relay.objects.get(`${target.upload_id}/1`); obj[3] ^= 1;
  await assert.rejects(web.load(bin.file_id, 1), /failed its check/);

  // An envelope signed by a device that isn't in the author's signed list is hidden, not shown.
  const fake = relay.rows.at(-1), forged = { ...fake, file_id: 'f_' + 'e'.repeat(32), seq: 999, sign_key: anna.root.sign };
  relay.rows.push(forged);
  const before = web.state.unverified;
  await web.sync();
  assert.equal(web.state.unverified, before + 1);
  assert.ok(!web.state.files.has(forged.file_id));

  // Keys that change under a pinned name stop the browser from sealing to them.
  store.set('anna', { sign: ben.root.sign, box: anna.root.box, revision: 0 });
  await web.refresh();
  await assert.rejects(web.write({ path: 'x.txt', data: enc.encode('x') }), (e) => e.code === 'keys');
});

test('history: what each save changed, undoing one save on top of later ones, a clash waits, own suggestions', async (t) => {
  const ben = await identity('ben', ['web-chrome']), anna = await identity('anna');
  const relay = fakeRelay(6, [ben, anna]);
  await new Promise((ok) => relay.server.listen(0, '127.0.0.1', ok));
  t.after(() => relay.server.close());
  const url = `http://127.0.0.1:${relay.server.address().port}`;
  const web = clientFor(url, 6, ben, 'web-chrome'), other = clientFor(url, 6, anna);
  await web.refresh(); await other.refresh();
  const dec = (d) => new TextDecoder().decode(d);
  const textOf = async (c, id, v) => dec((await c.load(id, v)).data);
  const edit = async (c, id, fn) => { await c.sync(); const f = c.state.files.get(id), t0 = await textOf(c, id, f.version); return c.write({ fileId: id, path: f.manifest.path, data: enc.encode(fn(t0)), base: f.version, baseData: enc.encode(t0) }); };

  // v1 Ben writes, v2 Anna adds a line, v3 Ben (an old copy saved whole) drops it and adds his own.
  const { file_id: id } = await web.write({ path: 'r3/timeline.md', data: enc.encode('# Timeline\n- alpha\n') });
  await edit(other, id, (x) => `${x}- beta (anna)\n`);
  await web.sync();
  const v3 = await web.write({ fileId: id, path: 'r3/timeline.md', data: enc.encode('# Timeline\n- alpha\n- gamma (ben)\n'), base: 2 });
  assert.equal(v3.version, 3);
  // Then Anna edits the top line, so the undo has a later save to keep.
  await edit(other, id, (x) => x.replace('# Timeline', '# Timeline, day 1'));

  // The summary: lines added and removed against the version before, and the first version against nothing.
  assert.deepEqual(await web.change(id, 1), { add: 2, del: 0 });
  assert.deepEqual(await web.change(id, 2, 1), { add: 1, del: 0 });
  assert.deepEqual(await web.change(id, 3, 2), { add: 1, del: 1 });

  // Undo version 3 only: Anna's line comes back, Ben's goes, and her later heading stays.
  const r = await web.revert(id, 3, 2);
  assert.deepEqual([r.outcome, r.version, r.before], ['saved', 5, 4]);
  assert.equal(await textOf(other, id, 5), '# Timeline, day 1\n- alpha\n- beta (anna)\n');
  // Nothing left to undo the second time.
  assert.equal((await web.revert(id, 3, 2)).outcome, 'same');
  // The toast's Undo: undoing the undo puts version 3's change back, still keeping the heading.
  const back = await web.revert(id, 5, 4);
  assert.equal(back.outcome, 'saved');
  assert.equal(await textOf(other, id, back.version), '# Timeline, day 1\n- alpha\n- gamma (ben)\n');

  // When a later save changed the same lines, the undo commits nothing and waits as Ben's suggestion.
  await edit(other, id, (x) => x.replace('- gamma (ben)', '- gamma (ben, checked by anna)'));
  const rows = relay.rows.length;
  const clash = await web.revert(id, 3, 2);
  assert.equal(clash.outcome, 'suggestion');
  assert.equal(relay.rows.length, rows);
  const full = await web.details(clash.suggestion);
  assert.deepEqual([full.base, full.original.text, full.proposed.text], [3, await textOf(web, id, 3), await textOf(web, id, 2)]);
  // On Ben's other devices it shows as his own, waiting; on Anna's as one to decide.
  await web.sync(); await other.sync();
  assert.deepEqual(web.mineWaiting().map((p) => p.file_id), [id]);
  assert.deepEqual(other.mineWaiting(), []);
  assert.equal(other.pending()[0].author, 'ben');

  // Bots keep only text files on their disks (the CLI's rule): the page marks the rest as web only.
  assert.deepEqual(['a.md', 'notes', 'x/data.jsonl', '.env', 'chart.png', 'report.pdf', '.hidden', 'a.'].map(core.onDisk), [true, true, true, true, false, false, false, false]);
});

// ───── against the real relay and the real CLI ─────
import { setup, owner, connect } from './helpers.mjs';

test('the browser links as a device with the same protocol as b2b device link, approved by the real CLI', async (t) => {
  const env = await setup(t, { autoTick: false });
  const ben = await owner(env, t, 'ben@example.com', 'ben');
  const post = async (path, body) => { const r = await fetch(env.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; };

  const keys = await core.newDeviceKeys();
  const link = await core.linkRequest(keys, 'web-chrome');
  assert.deepEqual(Object.keys(link.request), ['id', 'name', 'sign', 'box', 'token_hash', 'nonce', 'expires_at']);
  assert.equal((await post('/v1/devices/link', { request: link.request, proof: link.proof })).status, 200);
  // A forged proof is refused by the relay's own check.
  const other = await core.linkRequest(keys, 'web-safari');
  assert.equal((await post('/v1/devices/link', { request: other.request, proof: link.proof })).status, 400);

  const poll = async () => (await post('/v1/devices/link/poll', { id: link.request.id, proof: await core.pollProof(keys, link.request.id) })).json;
  assert.equal((await poll()).status, 'waiting');
  await assert.rejects(core.finishLink(link, keys, await poll(), '0'.repeat(16)), (e) => e.code === 'waiting');
  // The CLI checks the first code against the request it fetches, and prints the return code.
  await assert.rejects(ben.cli('device', 'approve', link.request.id, '0'.repeat(16), '--owner-ok'), /does not match/);
  const said = await ben.cli('device', 'approve', link.request.id, await core.deviceCode(link.request), '--owner-ok');
  const back = said.match(/--confirm ([0-9A-F]{16})/)[1];
  const approved = await poll();
  assert.equal(approved.status, 'approved');
  await assert.rejects(core.finishLink(link, keys, approved, 'ABCDEF0123456789'), (e) => e.code === 'mismatch');
  const done = await core.finishLink(link, keys, approved, back.toLowerCase().replace(/(.{4})/g, '$1 '));
  // Pasting the bot's whole reply works too: the 16-character code is taken out of it.
  assert.equal((await core.finishLink(link, keys, approved, said)).handle, 'ben');
  assert.equal((await core.finishLink(link, keys, approved, `Here's the code: ${back}`)).handle, 'ben');
  assert.equal(done.handle, 'ben');
  assert.equal(done.device.name, 'web-chrome');
  const cfg = JSON.parse(readFileSync(`${ben.home}/config.json`, 'utf8'));
  assert.deepEqual(done.device.root, { sign: cfg.keys.sign.x, box: cfg.keys.box.x });

  // The browser's token now works as that device, and the CLI lists it.
  const me = await (await fetch(env.url + '/v1/devices', { headers: { authorization: `Bearer ${done.token}` } })).json();
  assert.equal(me.current, done.device.id);
  assert.match(await ben.cli('device', 'list'), /web-chrome/);
  // A sealed message from the browser device, read by the primary's real CLI later, uses the same b2b1: proven above.
});

test('the group page: the folder section, its strict CSP, access for admins with Undo, and the served script', async (t) => {
  const env = await setup(t, { autoTick: false, hosted: true });
  const ben = await owner(env, t, 'ben@example.com', 'ben');
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  const group = Number((await ben.cli('group', 'new', 'Research', 'anna')).match(/number (\d+)/)[1]);
  const db = env.relay.db;
  env.relay.groups.join(db.prepare('SELECT * FROM bots WHERE id=?').get(anna.botId), group, { byOwner: true });
  const pageOf = (who) => who.b(`/app/groups/${group}?bot=${who.botId}`);

  // Hosted and not on Infinite: no folder at all.
  assert.doesNotMatch((await pageOf(ben)).text, /id="folder"/);
  db.prepare("UPDATE users SET infinite_at = 1 WHERE email IN ('ben@example.com', 'anna@example.com')").run();

  let page = await pageOf(ben);
  assert.match(page.text, /<h2 id="folder-h">Shared folder <span class="badge badge--info">Alpha<\/span><\/h2>[^]*Turn on the shared folder/);
  assert.doesNotMatch(page.text, /id="folder-app"/);
  const csp = page.headers.get('content-security-policy');
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.match(csp, /^default-src 'none'; script-src 'self' 'nonce-[^']+'; style-src 'self' 'unsafe-inline';[^]*connect-src 'self';[^]*frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|https?:/);
  for (const tag of page.text.match(/<script[^>]*>/g)) assert.ok(tag.includes(`nonce="${nonce}"`), tag);
  assert.doesNotMatch(page.text, /\son(click|load|error|submit)=/);
  assert.match((await pageOf(anna)).text, /The shared folder is off\. A group admin can turn it on\./);

  // On, then access: each change says what happened and offers Undo.
  assert.equal((await ben.b(`/app/groups/${group}/folder`, { method: 'POST', form: { bot: ben.botId, on: '1' } })).status, 303);
  page = await pageOf(ben);
  assert.match(page.text, /class="toast toast--undo"[^]*Shared folder on[^]*name="undo" value="1"/);
  assert.match(page.text, /Who can open it[^]*@ben[^]*No access[^]*Read[^]*Read and write[^]*@anna/);
  assert.match((await pageOf(anna)).text, /id="folder-app"/);
  assert.equal((await anna.b(`/app/groups/${group}/folder-access`, { method: 'POST', form: { bot: anna.botId, member: anna.botId, role: 'write' } })).status, 403);

  await ben.b(`/app/groups/${group}/folder-access`, { method: 'POST', form: { bot: ben.botId, member: ben.botId, role: 'write' } });
  await ben.b(`/app/groups/${group}/folder-access`, { method: 'POST', form: { bot: ben.botId, member: anna.botId, role: 'read' } });
  page = await pageOf(ben);
  assert.match(page.text, /Anna|anna/);
  assert.match(page.text, /can read the folder[^]*name="role" value="write"/);
  const grants = () => Object.fromEntries(db.prepare('SELECT b.handle, m.role FROM team_folder_members m JOIN bots b ON b.id = m.bot_id WHERE m.group_id = ?').all(group).map((r) => [r.handle, r.role]));
  assert.deepEqual(grants(), { ben: 'write', anna: 'read' });
  await ben.b(`/app/groups/${group}/folder-access`, { method: 'POST', form: { bot: ben.botId, member: anna.botId, role: 'remove', undo: '1' } });
  assert.deepEqual(grants(), { ben: 'write' });

  // Granted: the app mounts with public facts only, its words, and the versioned script.
  page = await pageOf(ben);
  const app = page.text.match(/<div class="card card--folder card--tab" data-tab="[^"]*" id="folder-app"[^>]*>/)[0];
  const cfg = JSON.parse(readFileSync(`${ben.home}/config.json`, 'utf8'));
  assert.match(app, new RegExp(`data-group="${group}" data-bot="\\d+" data-handle="ben" data-sign="${cfg.keys.sign.x}" data-box="${cfg.keys.box.x}"`));
  assert.match(app, /data-devices="\[&quot;primary&quot;\]"/);
  assert.doesNotMatch(page.text, new RegExp(cfg.token));
  const words = JSON.parse(page.text.match(/<script nonce="[^"]+" type="application\/json" id="folder-words">([^<]*)<\/script>/)[1]);
  assert.equal(words['Set up this browser'], 'Set up this browser');
  const src = page.text.match(/<script nonce="[^"]+" src="(\/app\/folders\.js\?v=[0-9a-f]{16})" defer><\/script>/)[1];
  const js = await ben.b(src);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  assert.match(js.headers.get('cache-control'), /immutable/);
  assert.equal(js.text, FOLDERS_JS);
  assert.match((await pageOf(anna)).text, /Your bot has no folder access/);

  // In Czech, the script's words come in Czech too.
  db.prepare("UPDATE users SET lang = 'cs' WHERE email = 'ben@example.com'").run();
  page = await pageOf(ben);
  assert.match(page.text, /Sdílená složka/);
  assert.equal(JSON.parse(page.text.match(/id="folder-words">([^<]*)</)[1])['Set up this browser'], 'Nastavit tento prohlížeč');

  // Turning it off says so, with Undo.
  await ben.b(`/app/groups/${group}/folder`, { method: 'POST', form: { bot: ben.botId } });
  page = await pageOf(ben);
  assert.match(page.text, /Sdílená složka je vypnutá[^]*name="on" value="1"/);
});

test('backfill opens older files on a newly paired browser; reopen undoes a reject; if_seq never makes a twin', async (t) => {
  const ben = await identity('ben', ['web-chrome', 'laptop']), anna = await identity('anna');
  const late = ben.devices.find((d) => d.name === 'web-chrome'), laptop = ben.devices.find((d) => d.name === 'laptop');
  late.late = true;
  const relay = fakeRelay(6, [ben, anna]);
  await new Promise((ok) => relay.server.listen(0, '127.0.0.1', ok));
  t.after(() => relay.server.close());
  const url = `http://127.0.0.1:${relay.server.address().port}`;
  const other = clientFor(url, 6, anna), web = clientFor(url, 6, ben, 'web-chrome');
  await other.refresh();

  // Anna writes before the browser is paired: no envelope for it, so it waits ("older files are on their way").
  const old = await other.write({ path: 'plan.md', data: enc.encode('one\ntwo\n') });
  late.late = false;
  await web.refresh();
  assert.deepEqual(await web.sync(), []);
  assert.ok(web.state.locked.has(old.file_id));

  // Ben's primary backfills: it hands over its own envelope's opening key, sealed to the browser.
  const primary = ben.devices[0], row = relay.rows.find((r) => r.file_id === old.file_id);
  const kind = `team-folder/2/6/${old.file_id}/1`, source = row.envelopes['ben:primary'];
  const handOver = async (from, envelope, sourceBox, k = kind) => core.seal({ v: 1, source_box: sourceBox, source_envelope: envelope, opening_key: await core.envelopeKey(envelope, { box: primary.keys.box.privateKey, boxPub: primary.box, peerSign: row.sign_key, meta: { from: row.sign_key, to: primary.box, kind: k } }) },
    { sign: from.keys.sign.privateKey, peerBox: late.box, meta: { from: from.sign, to: late.box, kind: `team-backfill/1/${k}` } });
  row.envelopes['ben:web-chrome'] = await handOver(primary, source, primary.box);
  row.backfills = { 'ben:web-chrome': { device: 'primary', sign: primary.sign, device_list: ben.list } };
  relay.bump(row);
  assert.deepEqual(await web.sync(), [old.file_id]);
  assert.equal(web.state.locked.size, 0);
  assert.equal(new TextDecoder().decode((await web.load(old.file_id, 1)).data), 'one\ntwo\n');
  // Forwarded: the laptop, which got that same proof, passes it on. The laptop signs only the outer envelope; the
  // author's signature over the primary's box key still opens the inner one.
  web.state.files.delete(old.file_id);
  row.envelopes['ben:web-chrome'] = await handOver(laptop, source, primary.box);
  row.backfills = { 'ben:web-chrome': { device: 'laptop', sign: laptop.sign, device_list: ben.list } };
  relay.bump(row);
  assert.deepEqual(await web.sync(), [old.file_id]);
  assert.equal(new TextDecoder().decode((await web.load(old.file_id, 1)).data), 'one\ntwo\n');

  // A backfill from a device that isn't Ben's own, or with the wrong source box, opens nothing.
  const before = web.state.unverified;
  row.backfills = { 'ben:web-chrome': { device: 'primary', sign: anna.root.sign, device_list: ben.list } };
  relay.bump(row);
  web.state.files.delete(old.file_id);
  await web.sync();
  row.envelopes['ben:web-chrome'] = await handOver(primary, source, anna.root.box);
  row.backfills = { 'ben:web-chrome': { device: 'primary', sign: primary.sign, device_list: ben.list } };
  relay.bump(row);
  await web.sync();
  // A device list signed by someone else's root is refused before the envelope is even opened.
  const fake = await identity('ben', ['web-chrome']);
  row.backfills = { 'ben:web-chrome': { device: 'primary', sign: fake.devices[0].sign, device_list: fake.list } };
  relay.bump(row);
  await web.sync();
  assert.equal(web.state.unverified, before + 3);
  assert.ok(!web.state.files.has(old.file_id));
  row.envelopes['ben:web-chrome'] = await handOver(primary, source, primary.box);
  row.backfills = { 'ben:web-chrome': { device: 'primary', sign: primary.sign, device_list: ben.list } };
  relay.bump(row);
  await web.sync();
  assert.ok(web.state.files.has(old.file_id));

  // Reject, then Undo: reopen brings the same suggestion back. After the file changes it can't be reopened.
  await other.sync();
  await other.write({ fileId: old.file_id, path: 'plan.md', data: enc.encode('ONE\ntwo\n'), base: 1, baseData: enc.encode('one\ntwo\n') });
  const sug = (await web.write({ fileId: old.file_id, path: 'plan.md', data: enc.encode('one!\ntwo\n'), base: 1, baseData: enc.encode('one\ntwo\n') })).suggestion;
  await web.resolve(sug, 'reject');
  await assert.rejects(other.resolve(sug, 'reopen'), (e) => e.status === 409);
  await web.resolve(sug, 'reopen');
  assert.equal(relay.suggestions.find((x) => x.proposal_id === sug.proposal_id).state, 'pending');
  await other.sync();
  assert.equal(other.pending()[0].proposal_id, sug.proposal_id);
  await web.resolve(sug, 'reject');
  await other.write({ fileId: old.file_id, path: 'plan.md', data: enc.encode('ONE\nTWO\n'), base: 2 });
  await web.sync();
  await assert.rejects(web.resolve(sug, 'reopen'), (e) => e.status === 409);

  // Two writers make the same new path: the second, guarded by if_seq, rereads and suggests instead of a twin.
  await other.write({ path: 'notes/same.md', data: enc.encode('from anna\n') });
  const twin = await web.write({ path: 'notes/same.md', data: enc.encode('from ben\n') });
  assert.deepEqual([twin.outcome, twin.with], ['suggestion', 'anna']);
  assert.ok(relay.ifSeqs.some((x) => x != null), 'creates carry if_seq');
  assert.equal(new Set(relay.rows.filter((r) => r.version === 1).map((r) => r.file_id)).size, relay.rows.filter((r) => r.version === 1).length);
  await web.sync();
  assert.equal(web.live().filter((f) => f.manifest.path === 'notes/same.md').length, 1);
  const s2 = await web.details(twin.suggestion);
  assert.deepEqual([s2.original.text, s2.current.text, s2.proposed.text, s2.base], ['', 'from anna\n', 'from ben\n', 0]);
});

test('accepting applies only the reviewed change to the latest version, and text merges up to 10 MiB', async (t) => {
  const ben = await identity('ben', ['web-chrome']), anna = await identity('anna');
  const relay = fakeRelay(8, [ben, anna]);
  await new Promise((ok) => relay.server.listen(0, '127.0.0.1', ok));
  t.after(() => relay.server.close());
  const url = `http://127.0.0.1:${relay.server.address().port}`;
  const web = clientFor(url, 8, ben, 'web-chrome'), other = clientFor(url, 8, anna);
  await web.refresh(); await other.refresh();
  const text = (c, id, v) => c.load(id, v).then((r) => new TextDecoder().decode(r.data));

  // Budget/Decision: Anna cut the budget; Ben, from the old text, decided to hire. Adjacent lines: a suggestion.
  const doc = await web.write({ path: 'plan.md', data: enc.encode('Budget 40\nDecision wait\n') });
  await other.sync();
  await other.write({ fileId: doc.file_id, path: 'plan.md', data: enc.encode('Budget 10\nDecision wait\n'), base: 1, baseData: enc.encode('Budget 40\nDecision wait\n') });
  const s = (await web.write({ fileId: doc.file_id, path: 'plan.md', data: enc.encode('Budget 40\nDecision hire\n'), base: 1, baseData: enc.encode('Budget 40\nDecision wait\n') })).suggestion;
  assert.ok(s);
  // Accepting keeps Budget 10 and changes only the decision.
  await other.sync();
  const shown = other.reviewed(await other.details(other.pending()[0]), 'Budget 10\nDecision wait\n');
  assert.deepEqual(shown, { ok: true, text: 'Budget 10\nDecision hire\n' });
  const yes = await other.accept(other.pending()[0]);
  assert.equal(yes.outcome, 'saved');
  assert.equal(await text(other, doc.file_id, yes.version), 'Budget 10\nDecision hire\n');

  // Same, when the latest moved on elsewhere after the review: it merges in, still with Budget 10.
  const doc2 = await web.write({ path: 'plan2.md', data: enc.encode('Title\n\nBudget 40\nDecision wait\n\nNotes\n') });
  await other.sync();
  const b2 = 'Title\n\nBudget 40\nDecision wait\n\nNotes\n';
  await other.write({ fileId: doc2.file_id, path: 'plan2.md', data: enc.encode(b2.replace('Budget 40', 'Budget 10')), base: 1, baseData: enc.encode(b2) });
  await web.write({ fileId: doc2.file_id, path: 'plan2.md', data: enc.encode(b2.replace('Decision wait', 'Decision hire')), base: 1, baseData: enc.encode(b2) });
  await other.write({ fileId: doc2.file_id, path: 'plan2.md', data: enc.encode(b2.replace('Budget 40', 'Budget 10').replace('Notes', 'Notes, from Anna')), base: 2 });
  await other.sync();
  const yes2 = await other.accept(other.pending().find((x) => x.file_id === doc2.file_id));
  assert.equal(await text(other, doc2.file_id, yes2.version), 'Title\n\nBudget 10\nDecision hire\n\nNotes, from Anna\n');

  // A base-0 create collision is the deliberate whole-document case.
  await other.write({ path: 'same.md', data: enc.encode('anna\n') });
  const c = (await web.write({ path: 'same.md', data: enc.encode('ben\n') })).suggestion;
  await other.sync();
  const yes3 = await other.accept(other.pending().find((x) => x.proposal_id === c.proposal_id));
  assert.equal(await text(other, c.file_id, yes3.version), 'ben\n');

  // A text file just under 10 MiB still merges (the old 2 MiB cap would have stopped it).
  const fill = (tag) => { const parts = []; for (let n = 0, i = 0; n < 10 * 1024 * 1024 - 2048; i++) { const l = `${tag} ${i} ${'x'.repeat(56)}\n`; parts.push(l); n += l.length; } return parts.join(''); };
  const big = fill('row');
  const f = await web.write({ path: 'data/big.csv', data: enc.encode(big) });
  await other.sync();
  await other.write({ fileId: f.file_id, path: 'data/big.csv', data: enc.encode('head\n' + big), base: 1, baseData: enc.encode(big) });
  const m = await web.write({ fileId: f.file_id, path: 'data/big.csv', data: enc.encode(big + 'tail\n'), base: 1, baseData: enc.encode(big) });
  assert.equal(m.outcome, 'merged');
  assert.equal(await text(web, f.file_id, m.version), 'head\n' + big + 'tail\n');
});

// ───── Download all files: one zip, built in the browser ─────
// A minimal reader, from the ZIP spec (APPNOTE 4.3): the end record, every central entry, and its local header must
// agree, and each file's bytes must match its CRC-32 (checked with zlib's, not the writer's).
function readZip(buf) {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), e = buf.length - 22;
  assert.equal(v.getUint32(e, true), 0x06054b50, 'end of central directory');
  const count = v.getUint16(e + 10, true), cdSize = v.getUint32(e + 12, true), cdAt = v.getUint32(e + 16, true);
  assert.equal(v.getUint16(e + 8, true), count);
  assert.equal(cdAt + cdSize, e, 'the central directory ends where the end record starts');
  const out = [];
  let p = cdAt;
  for (let i = 0; i < count; i++) {
    assert.equal(v.getUint32(p, true), 0x02014b50, 'central entry');
    const c = { flags: v.getUint16(p + 8, true), method: v.getUint16(p + 10, true), time: v.getUint16(p + 12, true), date: v.getUint16(p + 14, true), crc: v.getUint32(p + 16, true), csize: v.getUint32(p + 20, true), size: v.getUint32(p + 24, true) };
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), at = v.getUint32(p + 42, true);
    const raw = buf.subarray(p + 46, p + 46 + nlen);
    assert.equal(v.getUint32(at, true), 0x04034b50, 'local header');
    assert.deepEqual([v.getUint16(at + 6, true), v.getUint16(at + 8, true), v.getUint16(at + 10, true), v.getUint16(at + 12, true), v.getUint32(at + 14, true), v.getUint32(at + 18, true), v.getUint32(at + 22, true)], [c.flags, c.method, c.time, c.date, c.crc, c.csize, c.size]);
    const ln = v.getUint16(at + 26, true), lx = v.getUint16(at + 28, true);
    assert.deepEqual(buf.subarray(at + 30, at + 30 + ln), raw);
    const data = buf.subarray(at + 30 + ln + lx, at + 30 + ln + lx + c.csize);
    assert.equal(zlib.crc32(data), c.crc, 'CRC-32');
    out.push({ ...c, name: new TextDecoder('utf-8', { fatal: true }).decode(raw), data });
    p += 46 + nlen + xlen + clen;
  }
  assert.equal(p, e);
  return out;
}
const joinParts = (parts) => { const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0)); let at = 0; for (const x of parts) { out.set(x, at); at += x.length; } return out; };

test('the zip writer: stored files, UTF-8 names with their folders, CRC-32, DOS times, safe names', () => {
  const z = folderZip();
  assert.equal(z.crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(z.crc32(new Uint8Array(0)), 0);
  assert.equal(z.crc32(enc.encode('6789'), z.crc32(enc.encode('12345'))), 0xcbf43926, 'runs on');
  const big = new Uint8Array(nc.randomBytes(70_000));
  zlib.crc32(big) === z.crc32(big) || assert.fail('CRC-32 differs from zlib');
  const when = new Date(2026, 10, 21, 14, 37, 58).getTime();
  const files = readZip(joinParts(z.zip([
    { name: 'notes/plán týmu.md', data: enc.encode('# Plán\n'), mtime: when },
    { name: 'data/set.bin', data: big, mtime: 0 },
    { name: 'empty.txt', data: new Uint8Array(0), mtime: when },
    { name: '../../etc/../x/./y.txt', data: enc.encode('kept inside'), mtime: when },
    { name: 'notes/plán týmu.md', data: enc.encode('a twin'), mtime: when },
  ])));
  assert.deepEqual(files.map((f) => f.name), ['notes/plán týmu.md', 'data/set.bin', 'empty.txt', 'etc/x/y.txt']);
  for (const f of files) { assert.equal(f.method, 0, 'stored'); assert.equal(f.flags & 0x0800, 0x0800, 'UTF-8 names'); assert.equal(f.csize, f.size); }
  assert.equal(new TextDecoder().decode(files[0].data), '# Plán\n');
  assert.deepEqual(files[1].data, big);
  assert.equal(files[2].data.length, 0);
  const t0 = files[0];
  assert.deepEqual([(t0.date >> 9) + 1980, (t0.date >> 5) & 15, t0.date & 31, t0.time >> 11, (t0.time >> 5) & 63, (t0.time & 31) * 2], [2026, 11, 21, 14, 37, 58]);
  assert.equal((files[1].date >> 9) + 1980, 1980, 'before 1980 clamps to 1980');
  // An empty folder is still a valid (empty) zip.
  assert.deepEqual(readZip(joinParts(z.zip([]))), []);
  // The file name, from the group's name.
  assert.equal(z.fileName('Acme launch'), 'Acme launch');
  assert.equal(z.fileName('a/b:c*?"<>|\\d'), 'a b c d');
  assert.equal(z.fileName('...'), 'Shared folder');
  assert.equal(z.fileName('  '), 'Shared folder');
});

test('download all: the current files, decrypted and checked like one download, as one zip', async (t) => {
  const ben = await identity('ben', ['web-chrome']), anna = await identity('anna');
  const relay = fakeRelay(5, [ben, anna]);
  await new Promise((ok) => relay.server.listen(0, '127.0.0.1', ok));
  t.after(() => relay.server.close());
  const url = `http://127.0.0.1:${relay.server.address().port}`;
  const web = clientFor(url, 5, ben, 'web-chrome'), other = clientFor(url, 5, anna);
  await web.refresh(); await other.refresh();
  const plan = await other.write({ path: 'notes/plán.md', data: enc.encode('first\n') });
  await other.write({ fileId: plan.file_id, path: 'notes/plán.md', data: enc.encode('second\n'), base: 1, baseData: enc.encode('first\n') });
  const big = new Uint8Array(nc.randomBytes(core.CHUNK + 99));
  await other.write({ path: 'data/set.bin', data: big });
  const gone = await other.write({ path: 'old.txt', data: enc.encode('deleted') });
  await other.remove(gone.file_id);
  await web.sync();

  // What the page does: the live files (no deletions, no history), each loaded and checked, then zipped.
  const live = web.live().sort((a, b) => a.manifest.path.localeCompare(b.manifest.path));
  assert.deepEqual(live.map((f) => f.manifest.path), ['data/set.bin', 'notes/plán.md']);
  const entries = [];
  for (const f of live) { const r = await web.load(f.file_id, f.version); entries.push({ name: f.manifest.path, data: r.data, mtime: f.manifest.mtime }); }
  const files = readZip(joinParts(folderZip().zip(entries)));
  assert.deepEqual(files.map((f) => f.name), ['data/set.bin', 'notes/plán.md']);
  assert.deepEqual(files[0].data, big);
  assert.equal(new TextDecoder().decode(files[1].data), 'second\n', 'the newest version only');

  // Tampered ciphertext never makes it in: the load throws, as for a single download.
  const row = relay.rows.find((r) => r.file_id === plan.file_id && r.version === 2);
  const key = `${row.upload_id}/0`, good = relay.objects.get(key), bad = Buffer.from(good); bad[5] ^= 1;
  relay.objects.set(key, bad);
  await assert.rejects(web.load(plan.file_id, 2));
  relay.objects.set(key, good);
});

test('ending a group with a shared folder: its admin can download every file first, and ending never waits for it', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'b2b-folder-end-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = await setup(t, { dbPath: join(dir, 'relay.db'), autoTick: false });
  const ben = await owner(env, t, 'ben@example.com', 'ben');
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  const group = Number((await ben.cli('group', 'new', 'Acme launch', 'anna')).match(/number (\d+)/)[1]);
  const db = env.relay.db;
  env.relay.groups.join(db.prepare('SELECT * FROM bots WHERE id=?').get(anna.botId), group, { byOwner: true });
  const pageOf = (who) => who.b(`/app/groups/${group}?bot=${who.botId}`);
  const endRow = (html) => html.match(/<div class="setrow gend">[^]*?<\/form><\/div><\/div>/)?.[0] ?? '';
  const sync = (who) => who.cli('folder', 'sync', String(group), '--once');

  // No folder yet: ending looks as it always did.
  let row = endRow((await pageOf(ben)).text);
  assert.match(row, /End the group[^]*Everyone is out and it closes for good\./);
  assert.doesNotMatch(row, /data-folder-zip|deletes its copy/);

  // A folder, but no files in it yet: nothing to download.
  await ben.cli('folder', 'on', String(group));
  await ben.cli('folder', 'grant', String(group), '@ben', 'write');
  await ben.cli('folder', 'grant', String(group), '@anna', 'write');
  await sync(ben);
  assert.doesNotMatch(endRow((await pageOf(ben)).text), /data-folder-zip|deletes its copy/);

  // Files: the admin is offered Download all files first, with one line about what happens to them.
  writeFileSync(join(ben.home, 'shared', 'Acme launch', 'plan.md'), '# Plan\n');
  await sync(ben);
  let page = await pageOf(ben);
  row = endRow(page.text);
  assert.match(row, /bot2bot deletes its copy of the shared folder\. Everyone keeps the files already on their computer\.[^]*<button type="button" class="btn small ghost fzip" data-folder-zip><svg[^]*<span class="fzip__label">Download all files<\/span><\/button><form method="post" action="\/app\/groups\/\d+\/end" class="cm"/);
  assert.match(page.text, /id="folder-app" data-group="\d+"[^>]* data-name="Acme launch"/);
  // The button only shows once the folder script says this browser can build the zip.
  assert.match(page.text, /html:not\(\[data-fzip\]\) \.fzip\{display:none\}/);
  assert.match(FOLDERS_JS, /dataset\.fzip = ''/);
  // Not for members who can't end the group.
  page = await pageOf(anna);
  assert.doesNotMatch(page.text, /data-folder-zip|setrow gend/);

  // An admin whose bot has no access to the folder hears what happens, but can't download it here.
  db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND bot_id = ?').run('admin', group, anna.botId);
  await ben.cli('folder', 'revoke', String(group), '@anna');
  row = endRow((await pageOf(anna)).text);
  assert.match(row, /deletes its copy/);
  assert.doesNotMatch(row, /data-folder-zip/);

  // In Czech too.
  db.prepare("UPDATE users SET lang = 'cs' WHERE email = 'ben@example.com'").run();
  row = endRow((await pageOf(ben)).text);
  assert.match(row, /bot2bot smaže svou kopii sdílené složky\. Každému zůstanou soubory, které už má v počítači\.[^]*Stáhnout všechny soubory/);

  // Ending without downloading works as before, and the relay's encrypted copy goes with it.
  assert.ok(db.prepare('SELECT count(*) n FROM team_folder_revisions WHERE group_id = ?').get(group).n > 0);
  const ended = await ben.b(`/app/groups/${group}/end`, { method: 'POST', form: { bot: ben.botId } });
  assert.equal(ended.status, 303);
  assert.ok(db.prepare('SELECT ended_at FROM chat_groups WHERE id = ?').get(group).ended_at);
  assert.equal(db.prepare('SELECT count(*) n FROM team_folder_revisions WHERE group_id = ?').get(group).n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM team_folder_groups WHERE group_id = ?').get(group).n, 0);
});
