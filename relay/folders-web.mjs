// Shared folders on the web (v2, docs/SHARED-FOLDERS-SPEC.md "Web version"). The browser is one of the owner's
// linked devices: it makes its own Ed25519 and X25519 keys (non-extractable, kept in IndexedDB), links with the
// same protocol as `b2b device link`, and does every bit of crypto itself. The relay only ever serves ciphertext.
//
// Each part below is a self-contained function: the page script is built from their source (FOLDERS_JS), and the
// tests call the very same functions under Node's WebCrypto, so what is tested is what the browser runs.
//   folderCrypto  b2b1 seal/unseal (byte for byte the CLI's), the device link codes, format 2 chunks, paths
//   folderMerge   line-based three-way merge (diff3) and line diffs for text files
//   folderClient  the relay API for one group: feed, upload, compare-and-swap commit, merge or suggest, history
//   folderRender  safe text previews (Markdown, JSON, CSV, code) built with DOM nodes only, never HTML strings
//   folderApp     the dashboard section: pairing, the tree, the viewer, the editor, suggestions, drag and drop, toasts
import { createHash } from 'node:crypto';

export function folderCrypto(webcrypto) {
  const subtle = webcrypto.subtle;
  const enc = new TextEncoder();
  const CHUNK = 4 * 1024 * 1024;
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };
  const bytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
  const b64 = (buf) => {
    const u = bytes(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  };
  const unb64 = (s) => {
    const t = String(s);
    if (!/^[A-Za-z0-9_-]*$/.test(t)) throw new Error('bad base64url');
    const bin = atob(t.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (t.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  const hex = (buf) => Array.from(bytes(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  const random = (n) => webcrypto.getRandomValues(new Uint8Array(n));
  const sha256 = async (data) => new Uint8Array(await subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));

  // ───── ChaCha20-Poly1305 (RFC 8439). WebCrypto has no ChaCha, and b2b1 uses it, so it lives here. ─────
  const rotl = (v, c) => (v << c) | (v >>> (32 - c));
  const qr = (x, a, b, c, d) => {
    x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 16); x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 12);
    x[a] += x[b]; x[d] = rotl(x[d] ^ x[a], 8); x[c] += x[d]; x[b] = rotl(x[b] ^ x[c], 7);
  };
  function chacha20(key, nonce, counter, data) {
    const kv = new DataView(key.buffer, key.byteOffset, 32), nv = new DataView(nonce.buffer, nonce.byteOffset, 12);
    const s = new Uint32Array(16), x = new Uint32Array(16), ks = new Uint8Array(64), kd = new DataView(ks.buffer);
    s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
    for (let i = 0; i < 8; i++) s[4 + i] = kv.getUint32(i * 4, true);
    s[12] = counter;
    for (let i = 0; i < 3; i++) s[13 + i] = nv.getUint32(i * 4, true);
    const out = new Uint8Array(data.length);
    for (let off = 0; off < data.length; off += 64) {
      x.set(s);
      for (let r = 0; r < 10; r++) {
        qr(x, 0, 4, 8, 12); qr(x, 1, 5, 9, 13); qr(x, 2, 6, 10, 14); qr(x, 3, 7, 11, 15);
        qr(x, 0, 5, 10, 15); qr(x, 1, 6, 11, 12); qr(x, 2, 7, 8, 13); qr(x, 3, 4, 9, 14);
      }
      for (let i = 0; i < 16; i++) kd.setUint32(i * 4, (x[i] + s[i]) >>> 0, true);
      const n = Math.min(64, data.length - off);
      for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ ks[i];
      s[12] += 1;
    }
    return out;
  }
  const le = (b) => { let n = 0n; for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]); return n; };
  function poly1305(otk, msg) {
    const r = le(otk.subarray(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn, s = le(otk.subarray(16, 32));
    const p = (1n << 130n) - 5n;
    let a = 0n;
    for (let i = 0; i < msg.length; i += 16) {
      const blk = msg.subarray(i, i + 16);
      a = ((a + le(blk) + (1n << BigInt(8 * blk.length))) * r) % p;
    }
    a = (a + s) & ((1n << 128n) - 1n);
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) { out[i] = Number(a & 0xffn); a >>= 8n; }
    return out;
  }
  const le64 = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
  const pad16 = (n) => new Uint8Array((16 - (n % 16)) % 16);
  const macData = (aad, ct) => concat(aad, pad16(aad.length), ct, pad16(ct.length), le64(aad.length), le64(ct.length));
  function aeadSeal(key, nonce, aad, plain) {
    const otk = chacha20(key, nonce, 0, new Uint8Array(32)), ct = chacha20(key, nonce, 1, plain);
    return concat(ct, poly1305(otk, macData(aad, ct)));
  }
  function aeadOpen(key, nonce, aad, sealed) {
    if (sealed.length < 16) throw new Error('ciphertext too short');
    const ct = sealed.subarray(0, -16), tag = sealed.subarray(-16);
    const want = poly1305(chacha20(key, nonce, 0, new Uint8Array(32)), macData(aad, ct));
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= want[i] ^ tag[i];
    if (diff) throw new Error('message authentication failed');
    return chacha20(key, nonce, 1, ct);
  }

  // ───── keys ─────
  async function newDeviceKeys() {
    const sign = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const box = await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    return { sign, box, pub: { sign: b64(await subtle.exportKey('raw', sign.publicKey)), box: b64(await subtle.exportKey('raw', box.publicKey)) } };
  }
  const signKey = (x) => subtle.importKey('raw', unb64(x), { name: 'Ed25519' }, false, ['verify']);
  const boxKey = (x) => subtle.importKey('raw', unb64(x), { name: 'X25519' }, false, []);
  const signBytes = async (priv, data) => new Uint8Array(await subtle.sign({ name: 'Ed25519' }, priv, data));
  async function verifySig(pub, sig, data) {
    try { return await subtle.verify({ name: 'Ed25519' }, await signKey(pub), sig, data); } catch { return false; }
  }
  async function hkdf(ikm, salt, info) {
    const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, k, 256));
  }

  // ───── b2b1, exactly as cli/b2b.mjs seal()/unseal() ─────
  // X25519 to the recipient's box key with a fresh key, HKDF-SHA256 (salt: ephemeral || recipient public key,
  // info "b2b1 message"), ChaCha20-Poly1305 with the header as AAD, Ed25519 over header || eph || nonce || ct.
  const header = ({ from, to, kind, replyTo }) => enc.encode(`b2b1|${from}|${to}|${kind}|${replyTo || ''}`);
  async function seal(payload, { sign, peerBox, meta }, fixed = {}) {
    const eph = fixed.eph ?? (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']));
    const ephX = b64(await subtle.exportKey('raw', eph.publicKey));
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: await boxKey(peerBox) }, eph.privateKey, 256));
    const key = await hkdf(shared, concat(unb64(ephX), unb64(peerBox)), 'b2b1 message');
    const nonce = fixed.nonce ?? random(12);
    const aad = header(meta);
    const ct = aeadSeal(key, nonce, aad, enc.encode(JSON.stringify(payload)));
    const sig = await signBytes(sign, concat(aad, unb64(ephX), nonce, ct));
    return `b2b1.${ephX}.${b64(nonce)}.${b64(ct)}.${b64(sig)}`;
  }
  // Returns the sender's JSON as it was sealed. Callers check its shape.
  // The sealed parts, after the sender's signature over header || eph || nonce || ct checks out.
  async function verified(sealed, peerSign, meta) {
    const parts = String(sealed).split('.');
    if (parts.length !== 5 || parts[0] !== 'b2b1') throw new Error('not a sealed message');
    const [, ephX, n, c, s] = parts;
    const nonce = unb64(n), ct = unb64(c), aad = header(meta);
    if (nonce.length !== 12 || !(await verifySig(peerSign, unb64(s), concat(aad, unb64(ephX), nonce, ct)))) throw new Error('signature does not match');
    return { ephX, nonce, ct, aad };
  }
  // This one envelope's ChaCha20-Poly1305 key, as only its recipient can derive it.
  async function openingKey(ephX, box, boxPub) {
    const shared = new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: await boxKey(ephX) }, box, 256));
    return hkdf(shared, concat(unb64(ephX), unb64(boxPub)), 'b2b1 message');
  }
  const parse = (bytes) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  async function unseal(sealed, { box, boxPub, peerSign, meta }) {
    const v = await verified(sealed, peerSign, meta);
    return parse(aeadOpen(await openingKey(v.ephX, box, boxPub), v.nonce, v.aad, v.ct));
  }
  // An envelope opened with its opening key, handed over by another device of the same identity (backfill).
  // The original author's signature is checked first, with the original kind and addressing; no long-term key moves.
  async function unsealWithKey(sealed, { key, peerSign, meta }) {
    const v = await verified(sealed, peerSign, meta), k = unb64(key);
    if (k.length !== 32) throw new Error('bad opening key');
    return parse(aeadOpen(k, v.nonce, v.aad, v.ct));
  }
  // For the device that backfills (the CLI); exported so tests can play that device.
  async function envelopeKey(sealed, { box, boxPub, peerSign, meta }) {
    const v = await verified(sealed, peerSign, meta);
    return b64(await openingKey(v.ephX, box, boxPub));
  }

  // ───── linked devices, as in relay/linked-devices.mjs and the CLI ─────
  const DEVICE_KEY = /^[A-Za-z0-9_-]{43}$/, DEVICE_NAME = /^[a-z][a-z0-9_-]{0,31}$/, DEVICE_ID = /^d_[a-f0-9]{24}$/;
  const deviceBytes = (kind, value) => enc.encode(`bot2bot devices v1 ${kind}\n${JSON.stringify(value)}`);
  const deviceHash = async (s) => hex(await sha256(s));
  const deviceCode = async (request) => (await deviceHash(deviceBytes('link code', request))).slice(0, 16).toUpperCase();
  const deviceReturnCode = async (request, root) => (await deviceHash(deviceBytes('return code', { request, root }))).slice(0, 16).toUpperCase();
  const deviceCheck = async (kind, value, signature, key) =>
    typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signature) && DEVICE_KEY.test(String(key)) && verifySig(key, unb64(signature), deviceBytes(kind, value));
  async function verifiedDevices(manifest, root) {
    const r = manifest?.roster;
    if (!r || r.v !== 1 || !root || r.root?.sign !== root.sign || r.root?.box !== root.box || !Number.isSafeInteger(r.revision) || r.revision < 1 || !Array.isArray(r.devices) || r.devices.length < 1 || r.devices.length > 4 || !(await deviceCheck('roster', r, manifest.signature, root.sign)))
      throw new Error('device list signature does not match the identity key');
    const ids = new Set(), names = new Set(), signs = new Set(), boxes = new Set();
    for (const d of r.devices) {
      if (!d || !(d.id === 'primary' || DEVICE_ID.test(d.id)) || !DEVICE_NAME.test(d.name) || !DEVICE_KEY.test(d.sign) || !DEVICE_KEY.test(d.box) || ids.has(d.id) || names.has(d.name) || signs.has(d.sign) || boxes.has(d.box)) throw new Error('invalid device list');
      ids.add(d.id); names.add(d.name); signs.add(d.sign); boxes.add(d.box);
    }
    const first = r.devices[0];
    if (first.id !== 'primary' || first.name !== 'primary' || first.sign !== root.sign || first.box !== root.box) throw new Error('device list has a different primary');
    return r.devices;
  }
  // An identity with no signed list is its primary device alone.
  const devicesOf = async (list, root) => (list ? verifiedDevices(list, root) : [{ id: 'primary', name: 'primary', sign: root.sign, box: root.box }]);
  async function linkRequest(keys, name, now = Date.now()) {
    if (!DEVICE_NAME.test(name) || name === 'primary') throw new Error('invalid device name');
    const token = `b2bd_${b64(random(32))}`;
    const request = { id: `d_${hex(random(12))}`, name, sign: keys.pub.sign, box: keys.pub.box, token_hash: await deviceHash(token), nonce: hex(random(16)), expires_at: now + 15 * 60_000 };
    return { token, request, proof: b64(await signBytes(keys.sign.privateKey, deviceBytes('request', request))) };
  }
  const pollProof = async (keys, id) => b64(await signBytes(keys.sign.privateKey, deviceBytes('poll', { id })));
  // The owner carries the primary's code back here. It commits to this request and the approving identity's keys,
  // so the relay can't slip in another identity.
  async function finishLink(pending, keys, poll, confirm) {
    if (poll?.status !== 'approved') throw Object.assign(new Error('not approved yet'), { code: 'waiting' });
    const root = poll.manifest?.roster?.root;
    const typed = String(confirm).toUpperCase().replace(/[^0-9A-F]/g, '');
    if (!root || typed !== (await deviceReturnCode(pending.request, root))) throw Object.assign(new Error('confirmation code does not match'), { code: 'mismatch' });
    const d = (await verifiedDevices(poll.manifest, root)).find((x) => x.id === pending.request.id);
    if (!d || d.sign !== keys.pub.sign || d.box !== keys.pub.box || d.token_hash !== (await deviceHash(pending.token)) || d.name !== pending.request.name) throw Object.assign(new Error('approved keys do not match'), { code: 'mismatch' });
    return { token: pending.token, handle: poll.handle, device: { id: d.id, name: d.name, root }, manifest: poll.manifest };
  }

  // ───── folder format 2 ─────
  const AAD = (group, fileId, version, i, n) => enc.encode(`b2b-folder/2|${group}|${fileId}|${version}|${i}|${n}`);
  const chunkNonce = (i) => { const b = new Uint8Array(12); new DataView(b.buffer).setBigUint64(4, BigInt(i), false); return b; };
  const chunkCount = (size) => Math.max(1, Math.ceil(size / CHUNK));
  const chunkLength = (size, i) => Math.min(CHUNK, size - i * CHUNK) + 16;
  const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  // Relative, "/" separators, no "..", no leading "/", at most 1024 bytes, NFC.
  function checkPath(path) {
    if (typeof path !== 'string' || !path || path !== path.normalize('NFC') || enc.encode(path).length > 1024 || path.startsWith('/') || /[\\\0-\x1f\x7f]/.test(path) || path.split('/').some((s) => !s || s === '.' || s === '..'))
      throw new Error('invalid path');
    return path;
  }
  async function encryptVersion({ group, fileId, version, data, path, mime, mtime, base }) {
    checkPath(path);
    const raw = random(32), key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
    const n = chunkCount(data.length);
    const manifest = { v: 2, path, size: data.length, sha256: hex(await sha256(data)), mime: mime || 'application/octet-stream', mtime: mtime ?? Date.now(), key: b64(raw), chunk_size: CHUNK, chunks: n, base };
    const chunk = async (i) => new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: chunkNonce(i), additionalData: AAD(group, fileId, version, i, n), tagLength: 128 }, key, data.subarray(i * CHUNK, (i + 1) * CHUNK)));
    return { manifest, chunk };
  }
  const tombstone = ({ path, mime, base }) => ({ v: 2, path: checkPath(path), size: 0, sha256: EMPTY_SHA, mime: mime || 'application/octet-stream', mtime: Date.now(), key: b64(random(32)), chunk_size: CHUNK, chunks: 0, base, deleted: true });
  function checkManifest(m) {
    if (!m || typeof m !== 'object' || m.v !== 2 || !Number.isSafeInteger(m.size) || m.size < 0 || !/^[0-9a-f]{64}$/.test(m.sha256) || typeof m.key !== 'string' || unb64(m.key).length !== 32 || m.chunk_size !== CHUNK || !Number.isSafeInteger(m.base) || m.base < 0)
      throw new Error('invalid manifest');
    checkPath(m.path);
    if (m.deleted ? m.chunks !== 0 : m.chunks !== chunkCount(m.size)) throw new Error('invalid manifest');
    return m;
  }
  // Every chunk opens with its own position and count bound in, then the whole thing matches its sha256, before
  // anything is shown or saved. Any mismatch throws and nothing comes out.
  async function decryptChunks({ key: rawKey, size, chunks: n, sha256: want }, aad, getChunk, onChunk = () => {}) {
    const key = await subtle.importKey('raw', unb64(rawKey), 'AES-GCM', false, ['decrypt']);
    const out = new Uint8Array(size);
    for (let i = 0; i < n; i++) {
      const ct = bytes(await getChunk(i));
      if (ct.length !== chunkLength(size, i)) throw new Error('chunk has the wrong size');
      let plain;
      try { plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: chunkNonce(i), additionalData: aad(i, n), tagLength: 128 }, key, ct)); }
      catch { throw new Error('chunk failed its check'); }
      out.set(plain, i * CHUNK);
      onChunk(i + 1, n);
    }
    if (hex(await sha256(out)) !== want) throw new Error('file failed its check');
    return out;
  }
  async function decryptVersion(manifest, { group, fileId, version }, getChunk, onChunk) {
    checkManifest(manifest);
    if (manifest.deleted) throw new Error('this version is a deletion');
    return decryptChunks(manifest, (i, n) => AAD(group, fileId, version, i, n), getChunk, onChunk);
  }
  // Suggestions (b2b-suggestion/1): four parts, each with its own key: the original, current and proposed text, and
  // the intent ({ edits: [{ old, new }], reason, path }). Same chunks, nonces and tags as versions.
  const PARTS = ['original', 'current', 'proposed', 'intent'];
  const SAAD = (group, fileId, proposal, part, i, n) => enc.encode(`b2b-suggestion/1|${group}|${fileId}|${proposal}|${part}|${i}|${n}`);
  async function encryptPart({ group, fileId, proposal, part, data }) {
    if (!PARTS.includes(part)) throw new Error('unknown part');
    const raw = random(32), key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']), n = chunkCount(data.length);
    const desc = { size: data.length, chunks: n, sha256: hex(await sha256(data)), key: b64(raw) };
    const chunk = async (i) => new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: chunkNonce(i), additionalData: SAAD(group, fileId, proposal, part, i, n), tagLength: 128 }, key, data.subarray(i * CHUNK, (i + 1) * CHUNK)));
    return { desc, chunk };
  }
  function checkSuggestion(m) {
    if (!m || m.v !== 1 || !Number.isSafeInteger(m.base) || !Number.isSafeInteger(m.observed) || !/^edit_[0-9a-f]{32}$/.test(m.logical_edit_id) || !m.parts) throw new Error('invalid suggestion');
    for (const p of PARTS) {
      const d = m.parts[p];
      if (!d || !Number.isSafeInteger(d.size) || d.size < 0 || d.chunks !== chunkCount(d.size) || !/^[0-9a-f]{64}$/.test(d.sha256) || typeof d.key !== 'string' || unb64(d.key).length !== 32) throw new Error('invalid suggestion');
    }
    return m;
  }
  const decryptPart = (desc, { group, fileId, proposal, part }, getChunk) => decryptChunks(desc, (i, n) => SAAD(group, fileId, proposal, part, i, n), getChunk);

  const ext = (path) => { const n = String(path).split('/').pop(); const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
  const TEXT = new Set(['md', 'markdown', 'txt', 'text', 'csv', 'tsv', 'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'zsh', 'bash', 'sql', 'ini', 'cfg', 'conf', 'log', 'env', 'tex', 'rst', 'org', 'adoc', 'vue', 'svelte', 'graphql', 'proto']);
  const MIME = { md: 'text/markdown', markdown: 'text/markdown', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', yaml: 'application/yaml', yml: 'application/yaml', toml: 'application/toml', html: 'text/html', xml: 'application/xml' };
  const mimeOf = (path) => MIME[ext(path)] || (TEXT.has(ext(path)) ? 'text/plain' : 'application/octet-stream');
  const isText = (path) => TEXT.has(ext(path));

  return { CHUNK, EMPTY_SHA, b64, unb64, hex, random, sha256, concat, chacha20, poly1305, aeadSeal, aeadOpen, newDeviceKeys, seal, unseal, unsealWithKey, envelopeKey,
    deviceBytes, deviceHash, deviceCode, deviceReturnCode, deviceCheck, verifiedDevices, devicesOf, linkRequest, pollProof, finishLink,
    AAD, SAAD, PARTS, chunkNonce, chunkCount, checkPath, encryptVersion, tombstone, checkManifest, decryptVersion, encryptPart, decryptPart, checkSuggestion, ext, mimeOf, isText };
}

// Line-based three-way merge (diff3). Edits that don't touch the same lines merge, and so do insertions at the same
// spot (kept in commit order); overlapping edits don't.
export function folderMerge() {
  const lines = (s) => (s === '' ? [] : s.match(/[^\n]*\n|[^\n]+$/g));
  // For each line of a, the line of b it matches in a longest common subsequence (Myers), or -1.
  // Gives up (null) on very different texts; the caller keeps both copies then.
  function matches(a, b, limit = 2000) {
    const map = new Int32Array(a.length).fill(-1);
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) { map[s] = s; s++; }
    let ea = a.length, eb = b.length;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; map[ea] = eb; }
    const A = a.slice(s, ea), B = b.slice(s, eb), n = A.length, m = B.length;
    if (!n || !m) return map;
    const max = n + m, off = max + 1, v = new Int32Array(2 * max + 3), trace = [];
    for (let d = 0; d <= max; d++) {
      if (d > limit) return null;
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && A[x] === B[y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) {
          for (let dd = d; dd > 0; dd--) {
            const t = trace[dd], at = (kk) => t[kk + dd + 1], kk = x - y;
            const pk = kk === -dd || (kk !== dd && at(kk - 1) < at(kk + 1)) ? kk + 1 : kk - 1;
            const px = at(pk), py = px - pk;
            while (x > px && y > py) { x--; y--; map[s + x] = s + y; }
            x = px; y = py;
          }
          while (x > 0 && y > 0) { x--; y--; map[s + x] = s + y; }
          return map;
        }
      }
    }
    return map;
  }
  function merge3(base, ours, theirs) {
    if (ours === theirs || theirs === base) return { clean: true, text: ours };
    if (ours === base) return { clean: true, text: theirs };
    const O = lines(base), A = lines(ours), B = lines(theirs);
    const ma = matches(O, A), mb = matches(O, B);
    if (!ma || !mb) return { clean: false };
    const out = [], same = (x, y) => x.length === y.length && x.every((l, i) => l === y[i]);
    let o = 0, a = 0, b = 0;
    for (;;) {
      let j = o;
      while (j < O.length && (ma[j] < 0 || mb[j] < 0)) j++;
      const ea = j < O.length ? ma[j] : A.length, eb = j < O.length ? mb[j] : B.length;
      const co = O.slice(o, j), ca = A.slice(a, ea), cb = B.slice(b, eb);
      if (co.length || ca.length || cb.length) {
        // Both inserted at the same spot (say, bullets or rows added at the end): keep both, theirs first, as committed.
        const take = same(ca, co) ? cb : same(cb, co) || same(ca, cb) ? ca : !co.length ? [...cb, ...ca] : null;
        if (!take) return { clean: false };
        for (const l of take) out.push(l);
      }
      if (j >= O.length) break;
      out.push(O[j]); o = j + 1; a = ea + 1; b = eb + 1;
    }
    return { clean: true, text: out.join('') };
  }
  // What changed from a to b, line by line: same, del and add, deletions before additions in each change.
  function diff(a, b) {
    const A = lines(a), B = lines(b), map = matches(A, B, 4000);
    if (!map) return [...A.map((line) => ({ t: 'del', line })), ...B.map((line) => ({ t: 'add', line }))];
    const out = [];
    let j = 0;
    for (let i = 0; i < A.length; i++) {
      if (map[i] < 0) { out.push({ t: 'del', line: A[i] }); continue; }
      while (j < map[i]) out.push({ t: 'add', line: B[j++] });
      out.push({ t: 'same', line: A[i] }); j++;
    }
    while (j < B.length) out.push({ t: 'add', line: B[j++] });
    return out;
  }
  // The reviewed change only: the hunks that turned original into proposed, each mapped onto target and applied
  // there. Every other line of target stays as it is, so nothing from original ever comes back. A hunk whose old
  // lines changed in target goes in line for line when its stretch kept its shape (the reviewer overrides it);
  // when a hunk can't be placed at all, { ok: false }.
  function apply(original, proposed, target) {
    const O = lines(original), P = lines(proposed), T = lines(target);
    const op = matches(O, P, 4000), ot = matches(O, T, 4000);
    if (!op || !ot) return { ok: false };
    const hunks = [];
    for (let i = 0, j = 0; i < O.length || j < P.length;) {
      if (i < O.length && op[i] === j) { i++; j++; continue; }
      let e = i;
      while (e < O.length && op[e] < 0) e++;
      const pe = e < O.length ? op[e] : P.length;
      hunks.push({ os: i, oe: e, add: P.slice(j, pe) });
      i = e; j = pe;
    }
    const place = ({ os, oe }) => {
      const inside = [];
      for (let k = os; k < oe; k++) inside.push(ot[k]);
      if (inside.length && inside.every((x, n) => x >= 0 && (!n || x === inside[n - 1] + 1))) return [inside[0], inside.at(-1) + 1];
      let a = os - 1, b = oe;
      while (a >= 0 && ot[a] < 0) a--;
      while (b < O.length && ot[b] < 0) b++;
      const gs = a + 1, ts = a >= 0 ? ot[a] + 1 : 0, te = b < O.length ? ot[b] : T.length;
      if (os === oe && gs === b) return [te, te]; // an insertion between two kept lines: after whatever target added there
      if (b - gs === te - ts) return [ts + (os - gs), ts + (oe - gs)];
      if (te === ts && os === gs && oe === b) return [ts, ts]; // target removed exactly those lines: the reviewed ones go back
      return null;
    };
    const spots = hunks.map(place);
    if (spots.some((x) => !x) || spots.some((x, n) => n && x[0] < spots[n - 1][1])) return { ok: false };
    const out = [];
    let at = 0;
    hunks.forEach((h, n) => { const [s0, e0] = spots[n]; for (; at < s0; at++) out.push(T[at]); out.push(...h.add); at = e0; });
    for (; at < T.length; at++) out.push(T[at]);
    return { ok: true, text: out.join('') };
  }
  return { lines, matches, merge3, diff, apply };
}

// The relay API for one group, as the browser device. Opens and checks everything it reads; seals everything it writes.
export function folderClient({ core, merge, fetch: fetchImpl, base = '', group, device, keys, pins = null, version = '0.30.0' }) {
  const root = `/v1/team-folders/${group}`;
  const bare = (h) => String(h ?? '').replace(/^@/, '').toLowerCase();
  const me = { handle: bare(device.handle), pub: keys.pub };
  const state = { info: null, trust: new Map(), files: new Map(), locked: new Set(), unverified: 0, seq: 0, proposals: new Map() };
  const url = (p) => new URL(p, base || globalThis.location?.href).toString();
  async function api(method, path, body) {
    const r = await fetchImpl(url(root + path), { method, credentials: 'omit', cache: 'no-store',
      headers: { authorization: `Bearer ${device.token}`, 'x-b2b-version': version, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    let data = null;
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw Object.assign(new Error(data?.error || `HTTP ${r.status}`), { status: r.status, data });
    return data;
  }
  // A member's own keys: pinned the first time this browser sees them, and the signed device list never goes back.
  async function trusted(handle, rootKeys, list) {
    const h = bare(handle);
    if (!rootKeys?.sign || !rootKeys?.box) throw new Error('no keys');
    const pin = (await pins?.get(h)) ?? null;
    if (pin && (pin.sign !== rootKeys.sign || pin.box !== rootKeys.box)) throw Object.assign(new Error(`@${h}'s keys changed`), { code: 'keys' });
    const devices = await core.devicesOf(list ?? null, rootKeys);
    const revision = list?.roster?.revision ?? 0;
    if (pin && revision < (pin.revision ?? 0)) throw Object.assign(new Error(`@${h}'s device list went backwards`), { code: 'keys' });
    if (h === me.handle && (rootKeys.sign !== device.root.sign || rootKeys.box !== device.root.box)) throw Object.assign(new Error('this bot\'s keys changed'), { code: 'keys' });
    if (!pin || revision > (pin.revision ?? 0)) await pins?.set(h, { sign: rootKeys.sign, box: rootKeys.box, revision });
    return devices;
  }
  async function refresh() {
    const info = await api('GET', '');
    const trust = new Map();
    for (const m of info.members ?? []) {
      try { trust.set(bare(m.handle), await trusted(m.handle, { sign: m.sign, box: m.box }, m.device_list)); } catch { /* sealing to them refuses below */ }
    }
    state.info = info; state.trust = trust;
    return info;
  }
  // The author device must be in its identity's signed device list, with the key that signed the envelope.
  async function author(row) {
    const devices = row.root_sign ? await trusted(row.author, { sign: row.root_sign, box: row.root_box }, row.device_list) : state.trust.get(bare(row.author));
    const d = devices?.find((x) => x.sign === row.sign_key && (!row.author_device || x.name === row.author_device || x.id === row.author_device));
    if (!d) throw Object.assign(new Error('unknown author device'), { code: 'author' });
    return d;
  }
  const kind = (fileId, v) => `team-folder/2/${group}/${fileId}/${v}`;
  // A row's manifest, from this device's own envelope, or from a backfill: another device of this same identity seals { v: 1, source_box, source_envelope, opening_key } to us
  // under team-backfill/1/<kind>. The source envelope must carry the original author's signature over its kind and
  // source_box (any well-formed box key: a device that received a copy may forward it on); its opening key opens only
  // that one envelope.
  async function manifestOf(row, kindText) {
    if (!row.backfill) return core.unseal(row.envelope, { box: keys.box.privateKey, boxPub: keys.pub.box, peerSign: row.sign_key, meta: { from: row.sign_key, to: keys.pub.box, kind: kindText } });
    // The descriptor carries the device list as it was when the copy was made: it must be signed by this identity's
    // own root (pinned at pairing), and name the giving device. A device revoked later still leaves its copies readable.
    const pin = (await pins?.get(me.handle)) ?? null;
    if (pin && (pin.sign !== device.root.sign || pin.box !== device.root.box)) throw Object.assign(new Error('this bot\'s keys changed'), { code: 'keys' });
    const snapshot = await core.devicesOf(row.backfill.device_list ?? null, device.root);
    const giver = snapshot.find((d) => (d.name === row.backfill.device || d.id === row.backfill.device) && d.sign === row.backfill.sign);
    if (!giver || giver.sign === keys.pub.sign) throw Object.assign(new Error('backfill from a device that is not ours'), { code: 'author' });
    const b = await core.unseal(row.envelope, { box: keys.box.privateKey, boxPub: keys.pub.box, peerSign: giver.sign, meta: { from: giver.sign, to: keys.pub.box, kind: `team-backfill/1/${kindText}` } });
    if (b?.v !== 1 || typeof b.source_box !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(b.source_box) || core.unb64(b.source_box).length !== 32 || typeof b.source_envelope !== 'string' || typeof b.opening_key !== 'string') throw new Error('invalid backfill');
    return core.unsealWithKey(b.source_envelope, { key: b.opening_key, peerSign: row.sign_key, meta: { from: row.sign_key, to: b.source_box, kind: kindText } });
  }
  async function open(row) {
    await author(row);
    const m = await manifestOf(row, kind(row.file_id, row.version));
    const manifest = core.checkManifest(m && m.v === 2 ? m : typeof m?.text === 'string' ? JSON.parse(m.text) : m);
    if (!!manifest.deleted !== !!row.deleted || (row.chunks != null && row.chunks !== manifest.chunks)) throw new Error('row does not match its manifest');
    return manifest;
  }
  const at = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0);
  const entry = (row, manifest) => ({ file_id: row.file_id, version: row.version, seq: row.seq, author: bare(row.author), author_device: row.author_device ?? null, at: at(row.created_at), manifest });
  // Follows the change feed. Rows sealed before this browser was paired have no envelope for it: counted, not shown.
  async function sync(wait = 0) {
    const r = await api('GET', `/changes?since=${state.seq}${wait ? `&wait=${wait}` : ''}`);
    const changed = [];
    for (const row of r.changes ?? []) {
      if (!row.envelope) { if (!state.files.has(row.file_id)) state.locked.add(row.file_id); continue; }
      let manifest;
      try { manifest = await open(row); } catch { state.unverified++; continue; }
      const had = state.files.get(row.file_id);
      if (!had || row.version > had.version) { state.files.set(row.file_id, entry(row, manifest)); state.locked.delete(row.file_id); changed.push(row.file_id); }
    }
    // Suggestions move on the same cursor: reread the ones that changed.
    const events = r.suggestion_events ?? [];
    for (const fileId of new Set(events.map((x) => x.file_id))) { try { await proposals(fileId); changed.push(fileId); } catch { /* next round */ } }
    for (const x of events) { const p = state.proposals.get(x.proposal_id); if (p && x.state) state.proposals.set(x.proposal_id, { ...p, state: x.state }); }
    if (Number.isSafeInteger(r.seq) && r.seq > state.seq) state.seq = r.seq;
    return changed;
  }
  async function fetchBytes(u) {
    const r = await fetchImpl(url(u), { credentials: 'omit', cache: 'no-store' });
    if (!r.ok) throw Object.assign(new Error(`chunk HTTP ${r.status}`), { status: r.status });
    return new Uint8Array(await r.arrayBuffer());
  }
  // One version's bytes, checked end to end. Remembers text bases for merging.
  async function load(fileId, v, onChunk) {
    const row = await api('GET', `/files/${fileId}/${v}`);
    if (row.file_id !== fileId || row.version !== Number(v)) throw new Error('unexpected version');
    const manifest = await open(row);
    if (manifest.deleted) return { row, manifest, data: null };
    const data = await core.decryptVersion(manifest, { group, fileId, version: row.version }, (i) => fetchBytes(row.urls[i]), onChunk);
    return { row, manifest, data };
  }
  async function history(fileId) {
    const r = await api('GET', `/files/${fileId}/history`);
    const out = [];
    for (const row of r.versions ?? []) {
      let manifest = null;
      if (row.envelope) try { manifest = await open(row); } catch { /* shown as unreadable */ }
      out.push({ ...entry(row, manifest), deleted: !!row.deleted, size: row.size });
    }
    return out.sort((x, y) => y.version - x.version);
  }
  // Every current recipient device, checked against its identity's signed list. Keyed "handle:device".
  async function envelopes(manifest, kindText) {
    const out = {};
    for (const r of state.info.recipients ?? []) {
      const devices = state.trust.get(bare(r.handle));
      if (!devices?.some((d) => (d.name === r.device || d.id === r.device) && d.box === r.box && d.sign === r.sign)) throw Object.assign(new Error(`can't check @${bare(r.handle)}'s keys`), { code: 'keys' });
      out[`${bare(r.handle)}:${r.device}`] = await core.seal(manifest, { sign: keys.sign.privateKey, peerBox: r.box, meta: { from: keys.pub.sign, to: r.box, kind: kindText } });
    }
    return out;
  }
  const newId = () => `f_${core.hex(core.random(16))}`;
  const requestId = () => `req_${core.hex(core.random(16))}`;
  const editId = () => `edit_${core.hex(core.random(16))}`;
  const encode = (t) => new TextEncoder().encode(t);
  // Uploads the chunks of one encrypted thing (a version or a suggestion part) and returns its upload id.
  async function upload(fileId, size, chunks, chunk, onProgress = () => {}) {
    const up = await api('POST', '/uploads', { file_id: fileId, size, chunks });
    for (let i = 0; i < chunks; i++) {
      const r = await fetchImpl(url(up.urls[i]), { method: 'PUT', body: new Blob([await chunk(i)]), credentials: 'omit', headers: { 'if-none-match': '*' } });
      if (!r.ok) throw Object.assign(new Error(`upload HTTP ${r.status}`), { status: r.status });
      onProgress(i + 1, chunks);
    }
    return up.upload_id;
  }
  // POSTs with a fresh request id each attempt. A changed roster refreshes and reseals; a stale base comes back as
  // { code: 'stale', current } for the caller to rebase.
  async function commit(path, body, manifest, kindText) {
    for (let attempt = 0; ; attempt++) {
      try { return await api('POST', path, { ...body, request_id: requestId(), roster: state.info.roster, envelopes: await envelopes(manifest, kindText) }); }
      catch (e) {
        if (e.status === 409 && Number.isSafeInteger(e.data?.current)) throw Object.assign(new Error('stale'), { code: 'stale', current: e.data.current });
        // A create guarded by if_seq, refused because the folder moved on since: the caller rereads.
        if (e.status === 409 && body.if_seq != null && (Number.isSafeInteger(e.data?.seq) || /if_seq|seq/i.test(e.message))) throw Object.assign(new Error('moved'), { code: 'moved', seq: e.data?.seq });
        if (e.status === 409 && attempt < 2) { await refresh(); continue; }
        throw e;
      }
    }
  }
  // One compare-and-swap commit at base. The same logical edit id rides along every rebase of one change.
  async function put({ fileId, path, data = null, base, mime, mtime, onProgress = () => {}, logical = editId(), resolve = null, ifSeq = null }) {
    if (!state.info) await refresh();
    if (state.info.role !== 'write') throw Object.assign(new Error('read only'), { code: 'read' });
    const v = base + 1;
    let manifest, upload_id = null;
    if (data) {
      const max = state.info.max_file_bytes ?? 100 * 1024 * 1024;
      if (data.length > max) throw Object.assign(new Error('file too large'), { code: 'big' });
      const q = state.info.quota;
      if (q && q.used + data.length + 16 * core.chunkCount(data.length) > q.max) throw Object.assign(new Error('quota'), { code: 'quota' });
      const prep = await core.encryptVersion({ group, fileId, version: v, data, path, mime: mime ?? core.mimeOf(path), mtime, base });
      manifest = prep.manifest;
      upload_id = await upload(fileId, data.length, manifest.chunks, prep.chunk, onProgress);
    } else manifest = core.tombstone({ path, mime: mime ?? core.mimeOf(path), base });
    const r = await commit(`/files/${fileId}`, { base, upload_id, logical_edit_id: logical, ...(resolve ? { resolve_proposal: resolve } : {}), ...(ifSeq != null ? { if_seq: ifSeq } : {}) }, manifest, kind(fileId, v));
    const row = { file_id: fileId, version: r.version, seq: r.seq, author: me.handle, author_device: device.device.name, created_at: Date.now() };
    state.files.set(fileId, entry(row, manifest));
    if (state.info.quota && data) state.info.quota.used += data.length + 16 * manifest.chunks;
    return { file_id: fileId, version: r.version, manifest };
  }
  const live = () => [...state.files.values()].filter((f) => !f.manifest.deleted);
  const byPath = (path) => live().find((f) => f.manifest.path === path);
  // A path nobody uses yet: "name 2.ext", "name 3.ext"…
  function freePath(path) {
    if (!byPath(path)) return path;
    const cut = path.lastIndexOf('.'), slash = path.lastIndexOf('/');
    const [stem, ext] = cut > slash + 1 ? [path.slice(0, cut), path.slice(cut)] : [path, ''];
    for (let n = 2; ; n++) if (!byPath(`${stem} ${n}${ext}`)) return `${stem} ${n}${ext}`;
  }
  const decode = (d) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(d); } catch { return null; } };
  const TEXT_MAX = 10 * 1024 * 1024;
  const mergeable = (path, d) => core.isText(path) && d.length <= TEXT_MAX && decode(d) !== null;

  // ───── suggestions: overlapping edits wait on the same document for someone to accept or reject them ─────
  const skind = (fileId, pid) => `team-suggestion/1/${group}/${fileId}/${pid}`;
  // What ours changed, as old → new hunks of lines.
  function intentOf(original, proposed, path) {
    const edits = [];
    let old = '', neu = '', open = false;
    for (const o of merge.diff(original, proposed)) {
      if (o.t === 'same') { if (open) edits.push({ old, new: neu }); old = ''; neu = ''; open = false; }
      else { open = true; if (o.t === 'del') old += o.line; else neu += o.line; }
    }
    if (open) edits.push({ old, new: neu });
    return { edits, reason: 'overlap', path };
  }
  async function suggest({ fileId, path, base, observed, original, current, proposed, logical = editId() }) {
    const pid = `p_${core.hex(core.random(16))}`, texts = { original, current, proposed, intent: JSON.stringify(intentOf(original, proposed, path)) };
    const parts = {}, uploads = {};
    for (const part of core.PARTS) {
      const data = encode(texts[part]), x = await core.encryptPart({ group, fileId, proposal: pid, part, data });
      parts[part] = x.desc;
      uploads[part] = await upload(fileId, data.length, x.desc.chunks, x.chunk);
    }
    const manifest = { v: 1, base, observed, logical_edit_id: logical, parts };
    const r = await commit('/suggestions', { proposal_id: pid, file_id: fileId, base, observed, logical_edit_id: logical, uploads }, manifest, skind(fileId, pid));
    const p = { proposal_id: pid, file_id: fileId, base, observed, logical_edit_id: logical, state: r.state ?? 'pending', author: me.handle, author_device: device.device.name, at: Date.now(), seq: r.seq, manifest,
      original: { version: base, text: original }, current: { version: observed, text: current }, proposed: { text: proposed }, intent: JSON.parse(texts.intent) };
    state.proposals.set(pid, p);
    return p;
  }
  async function openProposal(row) {
    await author(row);
    const m = core.checkSuggestion(await manifestOf(row, skind(row.file_id, row.proposal_id)));
    if (m.base !== row.base || m.observed !== row.observed || m.logical_edit_id !== row.logical_edit_id) throw new Error('row does not match its manifest');
    return m;
  }
  // The suggestions this device can open, checked like versions. Sealed before this browser was paired: skipped.
  async function proposals(fileId = null) {
    const r = await api('GET', `/suggestions${fileId ? `?file_id=${fileId}` : ''}`);
    for (const row of r.suggestions ?? []) {
      if (!row.envelope || !/^p_[0-9a-f]{32}$/.test(row.proposal_id)) continue;
      const had = state.proposals.get(row.proposal_id);
      let manifest = had?.manifest;
      if (!manifest) try { manifest = await openProposal(row); } catch { state.unverified++; continue; }
      state.proposals.set(row.proposal_id, { ...had, ...row, author: bare(row.author), at: at(row.created_at), manifest, envelope: undefined });
    }
    return [...state.proposals.values()];
  }
  const pending = () => [...state.proposals.values()].filter((p) => p.state === 'pending' && state.files.has(p.file_id) && !state.files.get(p.file_id).manifest.deleted);
  // The four texts, opened and checked, once.
  async function details(p) {
    if (p.proposed) return p;
    const row = await api('GET', `/suggestions/${p.proposal_id}`), ctx = { group, fileId: p.file_id, proposal: p.proposal_id };
    const text = {};
    for (const part of core.PARTS) text[part] = decode(await core.decryptPart(p.manifest.parts[part], { ...ctx, part }, (i) => fetchBytes(row.urls[part][i])));
    const full = { ...p, original: { version: p.base, text: text.original }, current: { version: p.observed, text: text.current }, proposed: { text: text.proposed }, intent: JSON.parse(text.intent || '{}') };
    state.proposals.set(p.proposal_id, full);
    return full;
  }
  // What accepting would make of the version the reviewer saw: the reviewed change (original → proposed) mapped onto
  // it, leaving every other line as it is. A base-0 create collision is the one whole-document case.
  const whole = (p) => p.base === 0 && p.original.text === '';
  const reviewed = (p, onto) => (whole(p) ? { ok: true, text: p.proposed.text } : merge.apply(p.original.text, p.proposed.text, onto));
  // Accepting re-checks the latest version: if it moved on since the reviewer looked, the reviewed result merges into
  // it when the lines don't touch, and otherwise nothing is committed and it comes back to look at again.
  // text/basedOn: the reviewer's own edit of the whole document, written against that version (a guarded replace).
  async function accept(p0, { text = null, basedOn = null } = {}) {
    const p = await details(p0), logical = editId();
    let from = p.observed, fromText = p.current.text, want;
    if (text != null) { from = basedOn; fromText = decode((await load(p.file_id, basedOn)).data); want = text; }
    else {
      const r = reviewed(p, p.current.text);
      if (!r.ok) return { outcome: 'suggestion', suggestion: p, moved: true };
      want = r.text;
    }
    for (let round = 0; round < 4; round++) {
      await sync();
      const f = state.files.get(p.file_id);
      let out = want;
      if (f && !f.manifest.deleted && f.version !== from) {
        const m = merge.merge3(fromText, want, decode((await load(f.file_id, f.version)).data));
        if (!m.clean) return { outcome: 'suggestion', suggestion: p, moved: true };
        out = m.text;
      }
      try {
        const r = await put({ fileId: p.file_id, path: f && !f.manifest.deleted ? f.manifest.path : p.intent?.path ?? f?.manifest.path, data: encode(out), base: f?.version ?? 0, logical, resolve: p.proposal_id });
        state.proposals.set(p.proposal_id, { ...state.proposals.get(p.proposal_id), state: 'accepted', resolved_version: r.version });
        return { ...r, outcome: 'saved', before: f?.version ?? 0 };
      } catch (e) { if (e.code !== 'stale') throw e; }
    }
    throw new Error('the file keeps changing');
  }
  // Reject (anyone who may edit), withdraw (its author), or reopen (whoever rejected it, within 10 minutes, while the
  // file hasn't changed): the relay refuses the rest, and the error says so.
  async function resolve(p0, decision) {
    const p = await details(p0);
    // A reopen names the head it saw when it rejected, so a file changed since then can't be reopened; the others
    // reread the head first.
    const had = state.proposals.get(p.proposal_id);
    if (decision !== 'reopen') await sync();
    const base = decision === 'reopen' && had?.rejected_base != null ? had.rejected_base : state.files.get(p.file_id)?.version ?? 0;
    await api('POST', `/suggestions/${p.proposal_id}/resolve`, { decision, base, request_id: requestId() });
    state.proposals.set(p.proposal_id, { ...state.proposals.get(p.proposal_id), state: { reject: 'rejected', withdraw: 'withdrawn', reopen: 'pending' }[decision], ...(decision === 'reject' ? { rejected_base: base } : {}) });
    return p;
  }
  const again = (p) => suggest({ fileId: p.file_id, path: p.intent?.path ?? state.files.get(p.file_id)?.manifest.path, base: p.base, observed: p.observed, original: p.original.text, current: p.current.text, proposed: p.proposed.text });

  // Writes a file: a new one (no fileId) or a new version on top of base. When someone else saved first, it rereads
  // and rebases (up to three times): edits elsewhere merge, insertions at the same spot keep both in commit order.
  // When the same lines changed, ours becomes a suggestion on the document, never a second file:
  //   { outcome: 'saved' | 'merged' | 'suggestion', with: who saved first }
  // A binary that changed underneath stops with { code: 'changed' }: nothing is lost, theirs stays.
  async function write({ fileId = null, path, data, base = 0, baseData = null, mime, mtime, onProgress }) {
    if (!fileId) return create({ path, data, mime, mtime, onProgress });
    const id = fileId, logical = editId();
    let ours = data, at = base, original = baseData, merged = false, theirs = null;
    for (let round = 0; round < 4; round++) {
      try {
        const done = await put({ fileId: id, path, data: ours, base: at, mime, mtime, onProgress, logical });
        return { ...done, outcome: merged ? 'merged' : 'saved', with: theirs, before: at };
      } catch (e) {
        if (e.code !== 'stale') throw e;
        const cur = await load(id, e.current);
        theirs = bare(cur.row.author);
        if (!cur.data) { at = e.current; continue; } // they deleted it; ours brings it back
        if (!mergeable(path, ours) || !mergeable(cur.manifest.path, cur.data)) throw Object.assign(new Error('changed'), { code: 'changed', with: theirs });
        if (original == null && at > 0) original = (await load(id, at)).data ?? new Uint8Array(0);
        const m = merge.merge3(decode(original ?? new Uint8Array(0)), decode(ours), decode(cur.data));
        if (m.clean) { ours = encode(m.text); original = cur.data; at = e.current; merged = true; continue; }
        const s = await suggest({ fileId: id, path: cur.manifest.path, base: at, observed: e.current, original: decode(original ?? new Uint8Array(0)), current: decode(cur.data), proposed: decode(ours), logical });
        return { file_id: id, outcome: 'suggestion', suggestion: s, with: theirs };
      }
    }
    throw new Error('the file keeps changing');
  }
  // A new file, guarded by the feed seq this device last saw, so two writers can't both create the same path. When
  // the relay refuses, it rereads: if the path now exists, ours becomes a suggestion on that file, never a twin.
  async function create({ path, data, mime, mtime, onProgress }) {
    const id = newId(), logical = editId();
    for (let round = 0; round < 4; round++) {
      const there = byPath(path);
      if (there) {
        if (!mergeable(path, data)) throw Object.assign(new Error('changed'), { code: 'changed', with: there.author });
        const cur = await load(there.file_id, there.version);
        if (!mergeable(there.manifest.path, cur.data)) throw Object.assign(new Error('changed'), { code: 'changed', with: there.author });
        if (decode(cur.data) === decode(data)) return { file_id: there.file_id, version: there.version, manifest: there.manifest, outcome: 'saved', with: there.author, before: there.version };
        const s = await suggest({ fileId: there.file_id, path: there.manifest.path, base: 0, observed: there.version, original: '', current: decode(cur.data), proposed: decode(data), logical });
        return { file_id: there.file_id, outcome: 'suggestion', suggestion: s, with: there.author };
      }
      try {
        const done = await put({ fileId: id, path, data, base: 0, mime, mtime, onProgress, logical, ifSeq: state.seq });
        return { ...done, outcome: 'saved', before: 0 };
      } catch (e) { if (e.code !== 'moved') throw e; await sync(); }
    }
    throw new Error('the folder keeps changing');
  }
  async function remove(fileId) {
    for (let round = 0; round < 3; round++) {
      const f = state.files.get(fileId);
      try { return await put({ fileId, path: f.manifest.path, base: f.version, mime: f.manifest.mime }); }
      catch (e) { if (e.code !== 'stale') throw e; const cur = await load(fileId, e.current); state.files.set(fileId, entry(cur.row, cur.manifest)); if (cur.manifest.deleted) return { file_id: fileId, version: e.current }; }
    }
    throw new Error('the file keeps changing');
  }
  // A restore is a new version with an old version's content.
  async function restore(fileId, v) {
    const old = await load(fileId, v);
    if (!old.data) throw new Error('that version is a deletion');
    for (let round = 0; round < 3; round++) {
      const f = state.files.get(fileId);
      try { return await put({ fileId, path: f?.manifest.deleted ? old.manifest.path : f?.manifest.path ?? old.manifest.path, data: old.data, base: f?.version ?? 0, mime: old.manifest.mime }); }
      catch (e) { if (e.code !== 'stale') throw e; const cur = await load(fileId, e.current); state.files.set(fileId, entry(cur.row, cur.manifest)); }
    }
    throw new Error('the file keeps changing');
  }
  return { state, api, refresh, sync, load, history, put, write, remove, restore, live, byPath, freePath, newId, me, decode, suggest, proposals, pending, details, reviewed, accept, resolve, again };
}

// Text previews (Markdown, JSON, CSV, numbered code), built from DOM nodes and textContent only: a file can never
// inject markup or script into the page.
export function folderRender(document) {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const safeLink = (href) => {
    let u;
    try { u = new URL(href, 'https://relative.invalid/'); } catch { return null; }
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol) || u.hostname === 'relative.invalid') return null;
    const a = el('a'); a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
    return a;
  };
  // ───── Markdown: the common parts (headings, lists and tasks, quotes, code, tables, links, emphasis) ─────
  const INLINE = [
    ['code', /`([^`\n]+)`/], ['img', /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/], ['link', /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/],
    ['auto', /<(https?:\/\/[^>\s]+)>/], ['url', /\bhttps?:\/\/[^\s<]*[^\s<.,:;"')\]]/], ['strong', /\*\*(?=\S)([^]*?\S)\*\*|__(?=\S)([^]*?\S)__/],
    ['em', /\*(?=[^\s*])([^]*?[^\s*])\*|(?<![\w])_(?=\S)([^]*?\S)_(?![\w])/], ['del', /~~(?=\S)([^]*?\S)~~/], ['br', / {2,}\n|\\\n/],
  ];
  function inline(text, parent) {
    while (text) {
      let best = null;
      for (const [k, re] of INLINE) { const m = re.exec(text); if (m && (!best || m.index < best.m.index)) best = { k, m }; }
      if (!best) { parent.append(text); return; }
      const { k, m } = best;
      if (m.index) parent.append(text.slice(0, m.index));
      if (k === 'code') parent.append(el('code', null, m[1]));
      else if (k === 'img') parent.append(el('span', 'md__img', m[1] || m[2]));
      else if (k === 'br') parent.append(el('br'));
      else if (k === 'link' || k === 'auto' || k === 'url') {
        const href = k === 'link' ? m[2] : k === 'auto' ? m[1] : m[0], a = safeLink(href);
        if (a && k === 'link') inline(m[1], a); else if (a) a.textContent = href;
        if (a) parent.append(a); else if (k === 'link') inline(m[1], parent); else parent.append(href);
      } else { const e = el(k); inline(m[1] ?? m[2], e); parent.append(e); }
      text = text.slice(m.index + m[0].length);
    }
  }
  const FENCE = /^ {0,3}(`{3,}|~{3,})/, HEAD = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/, RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/, QUOTE = /^ {0,3}>/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/, ROW = /^\s*\|.*\|\s*$/, SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
  const blank = (l) => /^\s*$/.test(l), indent = (l) => l.match(/^\s*/)[0].length;
  const starts = (L, i) => FENCE.test(L[i]) || HEAD.test(L[i]) || RULE.test(L[i]) || QUOTE.test(L[i]) || ITEM.test(L[i]) || (ROW.test(L[i]) && SEP.test(L[i + 1] ?? ''));
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  function blocks(L, parent) {
    let i = 0;
    while (i < L.length) {
      const line = L[i];
      let m;
      if (blank(line)) { i++; continue; }
      if ((m = line.match(FENCE))) {
        const buf = []; i++;
        while (i < L.length && !L[i].trimStart().startsWith(m[1])) buf.push(L[i++]);
        i++;
        const pre = el('pre'); pre.append(el('code', null, buf.join('\n'))); parent.append(pre);
      } else if ((m = line.match(HEAD))) { const h = el(`h${Math.min(6, m[1].length + 2)}`); inline(m[2], h); parent.append(h); i++; }
      else if (RULE.test(line)) { parent.append(el('hr')); i++; }
      else if (QUOTE.test(line)) {
        const buf = [];
        while (i < L.length && QUOTE.test(L[i])) buf.push(L[i++].replace(/^ {0,3}> ?/, ''));
        const q = el('blockquote'); blocks(buf, q); parent.append(q);
      } else if (ROW.test(line) && SEP.test(L[i + 1] ?? '')) {
        const table = el('table'), head = el('thead'), body = el('tbody'), tr = el('tr');
        for (const c of cells(line)) { const th = el('th'); inline(c, th); tr.append(th); }
        head.append(tr); i += 2;
        while (i < L.length && ROW.test(L[i])) { const r = el('tr'); for (const c of cells(L[i++])) { const td = el('td'); inline(c, td); r.append(td); } body.append(r); }
        table.append(head, body); const wrap = el('div', 'md__table'); wrap.append(table); parent.append(wrap);
      } else if ((m = line.match(ITEM))) i = list(L, i, parent);
      else {
        const buf = [line]; i++;
        while (i < L.length && !blank(L[i]) && !starts(L, i)) buf.push(L[i++]);
        const p = el('p'); inline(buf.join('\n'), p); parent.append(p);
      }
    }
  }
  function list(L, i, parent) {
    const first = L[i].match(ITEM), ind = first[1].length, ordered = /\d/.test(first[2]);
    const ul = el(ordered ? 'ol' : 'ul');
    if (ordered && parseInt(first[2], 10) !== 1) ul.start = parseInt(first[2], 10);
    while (i < L.length) {
      const m = L[i].match(ITEM);
      if (!m || m[1].length !== ind || /\d/.test(m[2]) !== ordered) break;
      const li = el('li'), body = [m[3]];
      i++;
      while (i < L.length && (blank(L[i]) ? i + 1 < L.length && !blank(L[i + 1]) && indent(L[i + 1]) > ind : indent(L[i]) > ind)) body.push(L[i++]);
      const task = body[0].match(/^\[([ xX])\]\s+(.*)$/);
      if (task) { const cb = el('input'); cb.type = 'checkbox'; cb.disabled = true; cb.checked = task[1] !== ' '; li.className = 'md__task'; li.append(cb, ' '); body[0] = task[2]; }
      const rest = body.slice(1).map((l) => l.slice(Math.min(indent(l), ind + 2)));
      if (rest.some((l) => !blank(l))) { const p = el('span'); inline(body[0], p); li.append(p); blocks(rest, li); } else inline(body[0], li);
      ul.append(li);
      while (i < L.length && blank(L[i]) && L[i + 1] && ITEM.test(L[i + 1]) && L[i + 1].match(ITEM)[1].length === ind) i++;
    }
    parent.append(ul);
    return i;
  }
  function markdown(src) {
    const root = el('div', 'md');
    blocks(String(src).replace(/\r\n?/g, '\n').split('\n'), root);
    return root;
  }
  // ───── JSON: pretty, with keys, strings, numbers and literals told apart. Invalid JSON shows as it is. ─────
  function json(src) {
    let value;
    try { value = JSON.parse(src); } catch { return null; }
    const pre = el('pre', 'fcode fjson');
    const put = (v, depth) => {
      const pad = '  '.repeat(depth);
      if (Array.isArray(v) || (v && typeof v === 'object')) {
        const arr = Array.isArray(v), entries = arr ? v.map((x, i) => [i, x]) : Object.entries(v);
        if (!entries.length) { pre.append(arr ? '[]' : '{}'); return; }
        pre.append(arr ? '[\n' : '{\n');
        entries.forEach(([k, x], i) => {
          pre.append(pad + '  ');
          if (!arr) { pre.append(el('span', 'fjson__key', JSON.stringify(k)), ': '); }
          put(x, depth + 1);
          pre.append(i < entries.length - 1 ? ',\n' : '\n');
        });
        pre.append(pad + (arr ? ']' : '}'));
      } else pre.append(el('span', typeof v === 'string' ? 'fjson__str' : typeof v === 'number' ? 'fjson__num' : 'fjson__lit', JSON.stringify(v)));
    };
    put(value, 0);
    return pre;
  }
  // ───── CSV and TSV: a table, quotes respected, the first row as its header ─────
  function rows(src, sep) {
    const out = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (q) { if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
      else if (c === '"' && !cell) q = true;
      else if (c === sep) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
      else cell += c;
    }
    if (cell || row.length) { row.push(cell); out.push(row); }
    return out;
  }
  function table(src, sep, limit = 1000) {
    const all = rows(src, sep);
    if (!all.length) return null;
    const wrap = el('div', 'md__table ftable'), t = el('table'), head = el('thead'), body = el('tbody'), tr = el('tr');
    for (const c of all[0]) tr.append(el('th', null, c));
    head.append(tr);
    for (const r of all.slice(1, limit + 1)) { const x = el('tr'); for (const c of r) { const td = el('td', null, c); if (/^-?[\d.,]+%?$/.test(c.trim())) td.className = 'is-num'; x.append(td); } body.append(x); }
    t.append(head, body); wrap.append(t);
    return { node: wrap, rows: all.length - 1, shown: Math.min(limit, all.length - 1) };
  }
  // ───── any other text: numbered lines ─────
  function code(src) {
    const all = String(src).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
    // Very long files (up to 10 MiB) stay one text node: thousands of numbered elements would freeze the page.
    if (all.length > 20000) return el('pre', 'fcode', all.join('\n'));
    const pre = el('pre', 'fcode fcode--lines');
    for (const line of all) pre.append(el('span', 'fcode__line', line), '\n');
    return pre;
  }
  return { markdown, json, table, code, safeLink };
}

// The "Shared folder" section on the group page: reading, editing and reviewing text documents together. The server renders #folder-app with public facts only (group,
// bot handle and keys, role, device names, display names); everything secret stays in this browser.
export function folderApp({ folderCrypto, folderMerge, folderClient, folderRender }) {
  const root = document.getElementById('folder-app');
  if (!root) return;
  const W = JSON.parse(document.getElementById('folder-words')?.textContent || '{}');
  const say = (k, v = {}) => String(W[k] ?? k).replace(/\{(\w+)\}/g, (m, x) => (v[x] ?? m));
  const d = root.dataset, group = Number(d.group), handle = d.handle, lang = d.lang || 'en';
  const people = JSON.parse(d.people || '{}'), taken = JSON.parse(d.devices || '[]');
  const rootKeys = { sign: d.sign, box: d.box };
  const head = document.getElementById('folder-actions');
  let core, merge, render, client = null, alive = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const ICONS = {
    file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    chev: 'm9 18 6-6-6-6', plus: 'M5 12h14M12 5v14', up: 'M12 19V5M5 12l7-7 7 7', check: 'M20 6 9 17l-5-5', x: 'M18 6 6 18M6 6l12 12',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1', down: 'M12 5v14M5 12l7 7 7-7',
  };
  const icon = (name) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[name]); s.append(p);
    return s;
  };
  const button = (label, cls = 'btn small', ic = null) => { const b = el('button', cls); b.type = 'button'; if (ic) b.append(icon(ic)); b.append(label); return b; };
  // Busy, pairing or a file open: the group page's 30 s refresh waits.
  const holds = new Set();
  const hold = (why, on) => { if (on) holds.add(why); else holds.delete(why); if (holds.size) root.dataset.hold = '1'; else delete root.dataset.hold; };

  // ───── what, undo, next: one short line at the bottom, with Undo or the next step ─────
  let toastTimer = 0;
  function toast(what, action = null) {
    document.querySelectorAll('body > .toast').forEach((t) => t.remove());
    const t = el('div', `toast${action ? ' toast--undo' : ''}`); t.setAttribute('role', 'status');
    t.append(icon('check'), el('span', 'toast__what', what));
    if (action) {
      const b = el('button', 'toast__undo', action.label ?? say('Undo')); b.type = 'button';
      b.addEventListener('click', () => { t.remove(); action.run(); });
      t.append(b);
    }
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), action ? 9000 : 4600);
  }
  const fail = (e) => toast(e?.code === 'big' ? say('Over 100 MB. Split it or zip it smaller.') : e?.code === 'quota' ? say('The folder is full. Delete something first.') : e?.code === 'keys' ? say('Someone’s keys changed. Check with them before saving here.') : e?.code === 'read' ? say('You can read this folder, not change it.') : say('That didn’t work. Try again.'));

  // ───── formats ─────
  const nf = (n, unit) => new Intl.NumberFormat(lang, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: n < 10 ? 1 : 0 }).format(n);
  const size = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? nf(n / 1024, 'kilobyte') : n < 1024 ** 3 ? nf(n / 1024 ** 2, 'megabyte') : nf(n / 1024 ** 3, 'gigabyte'));
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const ago = (t) => {
    const s = Math.round((t - Date.now()) / 1000), a = Math.abs(s);
    return a < 45 ? say('just now') : a < 3600 ? rtf.format(Math.round(s / 60), 'minute') : a < 86400 ? rtf.format(Math.round(s / 3600), 'hour') : a < 30 * 86400 ? rtf.format(Math.round(s / 86400), 'day') : new Date(t).toLocaleDateString(lang);
  };
  const who = (h) => (h === client?.me.handle ? say('You') : people[h] ?? `@${h}`);
  const base = (p) => p.split('/').pop();
  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

  // ───── this browser's keys and token, per bot, in IndexedDB (CryptoKeys stay non-extractable) ─────
  const db = (() => {
    let p;
    const open = () => (p ??= new Promise((ok, no) => { const r = indexedDB.open('b2b-folders', 1); r.onupgradeneeded = () => { r.result.createObjectStore('devices'); r.result.createObjectStore('pins'); }; r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }));
    const run = async (store, mode, fn) => { const x = await open(); return new Promise((ok, no) => { const t = x.transaction(store, mode), r = fn(t.objectStore(store)); t.oncomplete = () => ok(r?.result); t.onerror = () => no(t.error); }); };
    return { get: (s, k) => run(s, 'readonly', (o) => o.get(k)), set: (s, k, v) => run(s, 'readwrite', (o) => o.put(v, k)), del: (s, k) => run(s, 'readwrite', (o) => o.delete(k)) };
  })();
  const pins = { get: (h) => db.get('pins', h), set: (h, v) => db.set('pins', h, v) };
  const browserName = () => { const u = navigator.userAgent; return /Edg\//.test(u) ? 'edge' : /OPR\//.test(u) ? 'opera' : /Firefox\//.test(u) ? 'firefox' : /Chrome\//.test(u) ? 'chrome' : /Safari\//.test(u) ? 'safari' : 'browser'; };
  const deviceName = () => { const b = `web-${browserName()}`; if (!taken.includes(b)) return b; for (let n = 2; ; n++) if (!taken.includes(`${b}-${n}`)) return `${b}-${n}`; };
  async function post(path, body) {
    const r = await fetch(path, { method: 'POST', credentials: 'omit', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw Object.assign(new Error(data?.error || `HTTP ${r.status}`), { status: r.status });
    return data;
  }

  // ───── pairing: one clear step ─────
  function codeBlock(text) {
    const box = el('div', 'code'), top = el('div', 'code__head'), pre = el('pre', 'code__pre', text);
    const copy = el('button', 'copybtn'); copy.type = 'button';
    const ic = el('span', 'copybtn__icon'); ic.append(icon('copy'), icon('check'));
    const label = el('span', 'copybtn__label', say('Copy'));
    copy.append(ic, label);
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(text); copy.dataset.state = 'copied'; label.textContent = say('Copied'); setTimeout(() => { delete copy.dataset.state; label.textContent = say('Copy'); }, 2000); } catch { label.textContent = say('Select it'); } });
    top.append(el('span', 'code__title', say('Message for your bot')), copy);
    box.append(top, pre);
    return box;
  }
  async function pairView(note = '') {
    head?.replaceChildren();
    const rec = (await db.get('devices', handle)) ?? null;
    const pending = rec?.pending && rec.pending.request.expires_at > Date.now() + 30_000 ? rec : null;
    const box = el('div', 'fpair');
    box.append(el('h3', 'fpair__title', say('Open the folder in this browser')));
    if (note) box.append(el('p', 'fpair__note', note));
    if (!pending) {
      box.append(el('p', 'muted', say('This browser becomes one of your bot’s devices, so files stay end-to-end encrypted here too.')));
      if (taken.length >= 4) { box.append(el('p', 'fpair__note', say('Your bot already has 4 devices. Ask it to remove one, then come back.'))); root.replaceChildren(box); return; }
      const start = button(say('Set up this browser'), 'btn');
      start.addEventListener('click', async () => {
        start.disabled = true;
        try {
          const keys = await core.newDeviceKeys();
          const link = await core.linkRequest(keys, deviceName());
          await post('/v1/devices/link', { request: link.request, proof: link.proof });
          await db.set('devices', handle, { keys, pending: link });
          pairView();
        } catch { start.disabled = false; toast(say('That didn’t work. Try again.')); }
      });
      box.append(start);
      root.replaceChildren(box);
      return;
    }
    hold('pair', true);
    const { keys, pending: link } = pending;
    const code = await core.deviceCode(link.request);
    const steps = el('ol', 'walk fpair__walk');
    const step = (n, title, ...body) => { const li = el('li', 'walk__step'), main = el('div'); li.append(el('span', 'walk__n', String(n))); main.append(el('p', 'walk__t', title), ...body); li.append(main); steps.append(li); };
    step(1, say('Send this to your bot'), codeBlock(`Please approve my browser as your linked device, then tell me the code you get back:\nb2b device approve ${link.request.id} ${code} --owner-ok`));
    const form = el('form', 'fpair__form'), input = el('input', 'fpair__code'), go = el('button', 'btn', say('Open the folder'));
    input.autocomplete = 'off'; input.spellcheck = false; input.maxLength = 24; input.placeholder = 'XXXX XXXX XXXX XXXX'; input.setAttribute('aria-label', say('Code from your bot'));
    input.setAttribute('autocapitalize', 'characters');
    const status = el('p', 'fpair__status', say('Waiting for your bot…')); status.setAttribute('role', 'status');
    form.append(input, go);
    step(2, say('Type the code your bot sends back'), form, status);
    const again = button(say('Start again'), 'btn small ghost');
    again.addEventListener('click', async () => { alive = false; await db.del('devices', handle); hold('pair', false); alive = true; pairView(); });
    box.append(steps, again);
    root.replaceChildren(box);
    let approved = null;
    const poll = async () => {
      try {
        const r = await post('/v1/devices/link/poll', { id: link.request.id, proof: await core.pollProof(keys, link.request.id) });
        if (r.status === 'approved' && !approved) { approved = r; status.textContent = say('Your bot approved it. Type the code it sent you.'); input.focus(); }
      } catch (e) { if (e.status === 404 || e.status === 410) { await db.del('devices', handle); hold('pair', false); pairView(say('That request expired. Start again.')); return false; } }
      return true;
    };
    (async () => { while (alive && root.contains(form) && !approved) { if (!(await poll())) return; await sleep(3000); } })();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      go.disabled = true;
      try {
        if (!approved) await poll();
        if (!approved) { status.textContent = say('Your bot hasn’t approved it yet.'); return; }
        const done = await core.finishLink(link, keys, approved, input.value);
        if (done.handle !== handle || done.device.root.sign !== rootKeys.sign || done.device.root.box !== rootKeys.box) throw Object.assign(new Error('other bot'), { code: 'mismatch' });
        await db.set('devices', handle, { keys, token: done.token, device: done.device, handle: done.handle });
        hold('pair', false);
        toast(say('This browser is paired'));
        start();
      } catch (err) { status.textContent = err.code === 'mismatch' ? say('That code doesn’t match. Check your bot’s reply.') : say('That didn’t work. Try again.'); }
      finally { go.disabled = false; }
    });
  }

  // ───── the folder ─────
  const open = new Set(), fresh = new Set();
  let focusId = null, rec = null, quota, tree, note, prog;
  function progress(text, done, total) {
    if (text == null) { prog.hidden = true; hold('busy', false); return; }
    hold('busy', true);
    prog.hidden = false;
    prog.querySelector('.fprog__what').textContent = text;
    prog.querySelector('.meter__fill').style.width = `${Math.round((100 * done) / Math.max(1, total))}%`;
  }
  function build() {
    const add = button(say('New note'), 'btn small ghost', 'plus'), up = button(say('Upload'), 'btn small', 'up');
    const pick = el('input'); pick.type = 'file'; pick.multiple = true; pick.hidden = true;
    up.addEventListener('click', () => pick.click());
    pick.addEventListener('change', () => { const list = [...pick.files].map((file) => ({ file, rel: file.name })); pick.value = ''; upload(list, ''); });
    add.addEventListener('click', () => newNote(''));
    head?.replaceChildren(...(client.state.info.role === 'write' ? [add, up, pick] : [el('span', 'badge', say('Read only'))]));
    prog = el('div', 'fprog'); prog.hidden = true; prog.setAttribute('role', 'status');
    const track = el('div', 'meter__track'); track.append(el('div', 'meter__fill'));
    prog.append(el('span', 'fprog__what'), track);
    tree = el('ul', 'ftree'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', say('Files'));
    note = el('p', 'fnote');
    quota = el('div', 'ffoot');
    const app = el('div', 'fapp');
    app.append(prog, tree, note, quota);
    root.replaceChildren(app);
    drops(app);
    keys(tree);
  }
  function nodes() {
    const top = { path: '', dirs: new Map(), files: [] };
    for (const f of client.live()) {
      let n = top;
      const parts = f.manifest.path.split('/');
      parts.slice(0, -1).forEach((p, i) => { if (!n.dirs.has(p)) n.dirs.set(p, { path: parts.slice(0, i + 1).join('/'), name: p, dirs: new Map(), files: [] }); n = n.dirs.get(p); });
      n.files.push(f);
    }
    return top;
  }
  const byName = (a, b) => a.localeCompare(b, lang, { numeric: true, sensitivity: 'base' });
  function draw() {
    const top = nodes(), flagged = new Set(client.pending().map((x) => x.file_id));
    const flags = (n) => n.files.some((f) => flagged.has(f.file_id)) || [...n.dirs.values()].some(flags);
    tree.replaceChildren();
    const count = (n) => n.files.length + [...n.dirs.values()].reduce((s, x) => s + count(x), 0);
    const row = (level, parent, { id, label, meta, dir, expanded, f, flag }) => {
      const li = el('li', 'ftree__item'); li.setAttribute('role', 'treeitem'); li.setAttribute('aria-level', String(level)); li.tabIndex = -1; li.dataset.id = id;
      if (dir != null) { li.dataset.dir = dir; li.setAttribute('aria-expanded', String(expanded)); } else li.dataset.dirOf = dirOf(f.manifest.path);
      if (fresh.has(id)) li.classList.add('is-fresh');
      const line = el('div', 'frow');
      line.style.setProperty('--level', String(level - 1));
      const ic = el('span', 'frow__icon'); ic.append(icon(dir != null ? 'chev' : 'file')); if (dir != null) ic.classList.add('frow__chev');
      const main = el('span', 'frow__main'), nm = el('span', 'frow__name', label);
      main.append(nm);
      if (flag) { const b = el('span', 'badge badge--warning frow__flag', say('Needs a decision')); if (dir != null) { b.className = 'frow__dot'; b.textContent = ''; b.setAttribute('aria-label', say('Needs a decision')); } nm.append(b); }
      main.append(el('span', 'frow__meta', meta));
      line.append(ic, main);
      li.append(line);
      parent.append(li);
      return li;
    };
    const walk = (n, level, parent) => {
      for (const sub of [...n.dirs.values()].sort((a, b) => byName(a.name, b.name))) {
        const id = `dir:${sub.path}`, expanded = open.has(sub.path);
        const li = row(level, parent, { id, label: sub.name, meta: String(count(sub)), dir: sub.path, expanded, flag: !expanded && flags(sub) });
        if (expanded) { const g = el('ul', 'ftree__group'); g.setAttribute('role', 'group'); li.append(g); walk(sub, level + 1, g); }
      }
      for (const f of n.files.sort((a, b) => byName(base(a.manifest.path), base(b.manifest.path))))
        row(level, parent, { id: f.file_id, label: base(f.manifest.path), meta: `${size(f.manifest.size)} · ${who(f.author)} · ${ago(f.at)}`, f, flag: flagged.has(f.file_id) });
    };
    walk(top, 1, tree);
    const items = [...tree.querySelectorAll('[role=treeitem]')];
    (items.find((x) => x.dataset.id === focusId) ?? items[0])?.setAttribute('tabindex', '0');
    tree.hidden = !items.length;
    root.querySelector('.fempty')?.remove();
    if (!items.length) {
      const empty = el('div', 'fempty');
      empty.append(el('p', 'fempty__title', say('Nothing here yet')));
      if (client.state.info.role === 'write') {
        empty.append(el('p', 'muted', say('Drop files here or start a note.')));
        const row2 = el('div', 'fempty__act'), add = button(say('New note'), 'btn small ghost', 'plus'), up = button(say('Upload'), 'btn small', 'up');
        add.addEventListener('click', () => newNote('')); up.addEventListener('click', () => head.querySelector('input[type=file]').click());
        row2.append(add, up); empty.append(row2);
      }
      tree.after(empty);
    }
    const s = client.state;
    note.textContent = s.locked.size ? say('Older files are on their way.') : s.unverified ? say('Some changes couldn’t be checked, so they’re hidden.') : '';
    note.hidden = !note.textContent;
    const q = s.info.quota;
    quota.replaceChildren();
    if (q?.max) {
      const m = el('div', 'meter meter--compact'), top2 = el('div', 'meter__top'), track = el('div', 'meter__track'), fill = el('div', 'meter__fill');
      top2.append(el('span', 'meter__title', say('Space')), el('span', 'meter__caption', say('{used} of {max}', { used: size(q.used), max: size(q.max) })));
      fill.style.width = `${Math.min(100, (100 * q.used) / q.max)}%`;
      track.append(fill); const bar = el('div', 'meter__bar'); bar.append(track);
      m.append(top2, bar); quota.append(m);
    }
    const me = el('p', 'ffoot__me'), forget = button(say('Forget this browser'), 'linkbtn');
    me.append(say('This browser: {name}', { name: rec.device.name }), ' · ', forget);
    forget.addEventListener('click', () => {
      const sure = button(say('Forget'), 'linkbtn linkbtn--danger'), no = button(say('Cancel'), 'linkbtn');
      forget.replaceWith(no, ' ', sure);
      no.addEventListener('click', () => draw());
      sure.addEventListener('click', async () => { alive = false; await db.del('devices', handle); client = null; toast(say('This browser forgot its keys')); alive = true; pairView(); });
    });
    quota.append(me);
    fresh.clear();
  }
  // Arc tree view keys: arrows move, right/left open and close, Home/End, Enter opens.
  function keys(t) {
    const visible = () => [...t.querySelectorAll('[role=treeitem]')].filter((x) => x.offsetParent !== null);
    const focus = (x) => { if (!x) return; t.querySelectorAll('[tabindex="0"]').forEach((y) => y.setAttribute('tabindex', '-1')); x.setAttribute('tabindex', '0'); x.focus(); focusId = x.dataset.id; };
    const act = (li) => { focusId = li.dataset.id; if (li.dataset.dir != null) { if (open.has(li.dataset.dir)) open.delete(li.dataset.dir); else open.add(li.dataset.dir); draw(); t.querySelector(`[data-id="${CSS.escape(focusId)}"]`)?.focus(); } else view(client.state.files.get(li.dataset.id)); };
    t.addEventListener('click', (e) => { const li = e.target.closest('[role=treeitem]'); if (li) act(li); });
    t.addEventListener('keydown', (e) => {
      const li = e.target.closest('[role=treeitem]'); if (!li) return;
      const all = visible(), i = all.indexOf(li), dir = li.dataset.dir;
      const k = e.key;
      if (k === 'ArrowDown') focus(all[i + 1]); else if (k === 'ArrowUp') focus(all[i - 1]); else if (k === 'Home') focus(all[0]); else if (k === 'End') focus(all.at(-1));
      else if (k === 'ArrowRight' && dir != null) { if (!open.has(dir)) act(li); else focus(all[i + 1]); }
      else if (k === 'ArrowLeft') { if (dir != null && open.has(dir)) act(li); else focus(li.parentElement.closest('[role=treeitem]')); }
      else if (k === 'Enter' || k === ' ') act(li); else return;
      e.preventDefault();
    });
  }

  // ───── upload: the button, or drop files and whole folders anywhere on the folder ─────
  const JUNK = /^(\.DS_Store|~\$.*|\.~lock\..*#|.*\.swp|.*\.tmp|.*\.crdownload)$/;
  function drops(zone) {
    let depth = 0;
    const target = (e) => e.target.closest?.('[role=treeitem]');
    const dirFor = (li) => (li ? (li.dataset.dir ?? li.dataset.dirOf ?? '') : '');
    const mark = (li) => { zone.querySelectorAll('.is-target').forEach((x) => x.classList.remove('is-target')); if (li?.dataset.dir != null) li.classList.add('is-target'); };
    const files = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    zone.addEventListener('dragenter', (e) => { if (!files(e) || client?.state.info.role !== 'write') return; e.preventDefault(); depth++; zone.classList.add('is-drop'); zone.dataset.drop = dirFor(target(e)) ? say('Drop into {name}', { name: base(dirFor(target(e))) }) : say('Drop to upload'); });
    zone.addEventListener('dragover', (e) => { if (!files(e) || client?.state.info.role !== 'write') return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; const li = target(e); mark(li); zone.dataset.drop = dirFor(li) ? say('Drop into {name}', { name: base(dirFor(li)) }) : say('Drop to upload'); });
    zone.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; zone.classList.remove('is-drop'); mark(null); } });
    zone.addEventListener('drop', async (e) => {
      if (!files(e) || client?.state.info.role !== 'write') return;
      e.preventDefault(); depth = 0; zone.classList.remove('is-drop');
      const dir = dirFor(target(e)); mark(null);
      const entries = [...e.dataTransfer.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.() ?? null);
      const plain = [...e.dataTransfer.files];
      const list = [];
      if (entries.length && entries.every(Boolean)) for (const en of entries) await walkEntry(en, '', list);
      else for (const file of plain) list.push({ file, rel: file.name });
      upload(list, dir);
    });
  }
  async function walkEntry(entry, prefix, out) {
    if (entry.isFile) out.push({ file: await new Promise((ok, no) => entry.file(ok, no)), rel: prefix + entry.name });
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) { const batch = await new Promise((ok, no) => reader.readEntries(ok, no)); if (!batch.length) break; for (const x of batch) await walkEntry(x, `${prefix}${entry.name}/`, out); }
    }
  }
  async function upload(list, dir) {
    list = list.filter((x) => !x.rel.split('/').some((p) => JUNK.test(p)));
    if (!list.length || !client) return;
    const done = [], waiting = [], skipped = [];
    try {
      for (const [n, { file, rel }] of list.entries()) {
        const path = (dir ? `${dir}/${rel}` : rel).normalize('NFC');
        try { core.checkPath(path); } catch { continue; }
        if (file.size > (client.state.info.max_file_bytes ?? 100 * 1024 * 1024)) { toast(say('{name} is over 100 MB. Split it or zip it smaller.', { name: file.name })); continue; }
        progress(say('Uploading {name}…', { name: file.name }), n, list.length);
        const had = client.byPath(path), data = new Uint8Array(await file.arrayBuffer());
        let r;
        try { r = await client.write({ fileId: had?.file_id, path, data, base: had?.version ?? 0, mtime: file.lastModified, onProgress: (i, t) => progress(say('Uploading {name}…', { name: file.name }), n + i / t, list.length) }); }
        catch (e) { if (e.code === 'changed') { skipped.push(file.name); continue; } throw e; }
        if (r.outcome === 'suggestion') { waiting.push(r.file_id); continue; }
        done.push({ id: r.file_id, before: had?.version ?? 0 });
        fresh.add(r.file_id);
        for (let p = dirOf(r.manifest.path); p; p = dirOf(p)) open.add(p);
      }
    } catch (e) { fail(e); }
    finally { progress(null); draw(); }
    if (skipped.length) { toast(say('Someone changed {name} first. Upload it again to replace theirs.', { name: skipped[0] })); return; }
    if (waiting.length && !done.length) { toast(say('Someone changed it first. Yours waits as a suggestion'), { label: say('Review'), run: () => view(client.state.files.get(waiting[0]), 'decide') }); return; }
    if (!done.length) return;
    const undo = { run: () => busy(async () => { for (const x of done.reverse()) await (x.before ? client.restore(x.id, x.before) : client.remove(x.id)); toast(say('Undone')); }) };
    toast(done.length === 1 ? say('Uploaded {name}', { name: base(client.state.files.get(done[0].id).manifest.path) }) : say('Uploaded {n} files', { n: done.length }), undo);
  }
  async function busy(fn) {
    hold('busy', true);
    try { await fn(); } catch (e) { fail(e); } finally { hold('busy', false); draw(); }
  }

  // ───── the viewer: preview, history, edit, download, delete, and decisions on suggestions ─────
  const dlg = el('dialog', 'fview'); dlg.setAttribute('aria-labelledby', 'fview-t');
  let urls = [], current = null;
  const clearUrls = () => { urls.forEach((u) => URL.revokeObjectURL(u)); urls = []; };
  const dirty = () => !!dlg.querySelector('textarea')?.dataset.dirty;
  dlg.addEventListener('close', () => { clearUrls(); current = null; hold('view', false); dlg.replaceChildren(); });
  dlg.addEventListener('cancel', (e) => { if (dirty()) e.preventDefault(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg && !dirty()) dlg.close(); });
  const blobUrl = (data, type) => { const u = URL.createObjectURL(new Blob([data], { type })); urls.push(u); return u; };
  function frame({ title, meta }) {
    const box = el('div', 'fview__in'), top = el('header', 'fview__head'), id = el('div', 'fview__id');
    const h = el('h3', 'fview__title', title); h.id = 'fview-t';
    id.append(h, el('p', 'fview__meta', meta));
    const x = el('button', 'iconbtn'); x.type = 'button'; x.setAttribute('aria-label', say('Close')); x.append(icon('x')); x.addEventListener('click', () => { if (!dirty()) dlg.close(); });
    top.append(id, x);
    const bar = el('div', 'fview__bar'), body = el('div', 'fview__body'), foot = el('footer', 'fview__foot');
    box.append(top, bar, body, foot);
    dlg.replaceChildren(box);
    if (!dlg.open) { dlg.showModal(); hold('view', true); }
    return { body, foot, bar, h, id };
  }
  // Arc segmented control, for the viewer's views.
  function seg(parent, list, pick, on = list[0][0]) {
    const g = el('div', 'seg fview__tabs'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', say('Show'));
    const track = el('div', 'seg__track'), sel = el('span', 'seg__sel'); sel.setAttribute('aria-hidden', 'true');
    track.append(sel); g.append(track); parent.append(g);
    const put = (b) => { sel.style.width = `${b.offsetWidth}px`; sel.style.transform = `translateX(${b.offsetLeft - 3}px)`; };
    const bs = list.map(([key, label, dot]) => {
      const b = button(label, ''); b.dataset.key = key; b.setAttribute('aria-pressed', String(key === on));
      if (dot) b.append(el('span', 'seg__dot'));
      b.addEventListener('click', () => { bs.forEach((x) => x.setAttribute('aria-pressed', String(x === b))); put(b); pick(key); });
      track.append(b);
      return b;
    });
    requestAnimationFrame(() => { put(bs.find((b) => b.dataset.key === on) ?? bs[0]); requestAnimationFrame(() => g.classList.add('ready')); });
    return g;
  }
  const metaOf = (f) => `${size(f.manifest.size)} · ${who(f.author)} · ${ago(f.at)}`;
  const suggestionFor = (fileId) => client.pending().find((s) => s.file_id === fileId);
  const canWrite = () => client.state.info.role === 'write';
  async function view(f, tab = 'preview') {
    if (!f) return;
    clearUrls();
    current = { f, data: null };
    const { body, foot, bar } = frame({ title: base(f.manifest.path), meta: metaOf(f) });
    const sug = suggestionFor(f.file_id);
    const dl = button(say('Download'), 'btn small', 'down');
    const edit = button(say('Edit'), 'btn small ghost');
    const del = button(say('Delete'), 'btn small ghost fview__del');
    edit.hidden = !canWrite() || !core.isText(f.manifest.path) || f.manifest.size > 10 * 1024 * 1024;
    del.hidden = !canWrite();
    foot.append(del, el('span', 'fview__gap'), edit, dl);
    const show = (k) => { foot.hidden = k === 'decide'; return k === 'preview' ? preview(f, body) : k === 'history' ? historyOf(f, body) : decide(sug, body); };
    seg(bar, [['preview', say('Preview')], ...(sug ? [['decide', say('Needs a decision'), true]] : []), ['history', say('History')]], show, sug && tab !== 'history' && tab !== 'preview-only' ? 'decide' : tab === 'history' ? 'history' : 'preview');
    dl.addEventListener('click', () => busy(async () => { const data = await bytesOf(f); const a = el('a'); a.href = blobUrl(data, f.manifest.mime); a.download = base(f.manifest.path); document.body.append(a); a.click(); a.remove(); toast(say('Downloaded {name}', { name: base(f.manifest.path) })); }));
    edit.addEventListener('click', async () => { const data = await bytesOf(f); editor({ f, text: client.decode(data) ?? '', data }); });
    del.addEventListener('click', () => busy(async () => {
      const before = f.version;
      await client.remove(f.file_id);
      dlg.close();
      toast(say('Deleted {name}', { name: base(f.manifest.path) }), { run: () => busy(async () => { await client.restore(f.file_id, before); fresh.add(f.file_id); toast(say('Brought back {name}', { name: base(f.manifest.path) })); }) });
    }));
    show(sug && tab !== 'history' && tab !== 'preview-only' ? 'decide' : tab === 'history' ? 'history' : 'preview');
  }
  // One file's bytes, once per open viewer. Big files count their chunks in the viewer's own line.
  async function bytesOf(f) {
    if (current?.f === f && current.data) return current.data;
    const line = () => dlg.querySelector('.fview__wait');
    const r = await client.load(f.file_id, f.version, (i, t) => { if (t > 1 && line()) line().textContent = `${say('Opening {name}…', { name: base(f.manifest.path) })} ${Math.round((100 * i) / t)} %`; });
    if (current?.f === f) current.data = r.data;
    return r.data;
  }
  // Text, read well: Markdown rendered, JSON pretty, CSV and TSV as a table, anything else with line numbers.
  function rendered(path, text) {
    const x = core.ext(path);
    if (text.length > 2 * 1024 * 1024) return render.code(text); // big: shown as text, fast
    if (x === 'md' || x === 'markdown') return render.markdown(text);
    if (x === 'json') return render.json(text) ?? render.code(text);
    if (x === 'csv' || x === 'tsv') {
      const t = render.table(text, x === 'csv' ? ',' : '\t');
      if (!t) return render.code(text);
      const box = el('div'); box.append(t.node);
      if (t.shown < t.rows) box.append(el('p', 'fview__more', say('Showing the first {n} rows. Download it for the rest.', { n: t.shown })));
      return box;
    }
    return render.code(text);
  }
  async function preview(f, body) {
    body.replaceChildren(el('p', 'fview__wait muted', say('Opening {name}…', { name: base(f.manifest.path) })));
    if (!core.isText(f.manifest.path)) { const none = el('div', 'fview__none'); none.append(el('p', 'muted', say('No preview for this kind of file. Download it to open it.'))); body.replaceChildren(none); return; }
    let data;
    try { data = await bytesOf(f); } catch { body.replaceChildren(el('p', 'fview__bad', say('This file didn’t pass its check, so it isn’t shown.'))); return; }
    if (current?.f !== f) return;
    const text = client.decode(data);
    body.replaceChildren(text === null ? el('p', 'muted', say('No preview for this kind of file. Download it to open it.')) : rendered(f.manifest.path, text));
  }
  async function historyOf(f, body) {
    body.replaceChildren(el('p', 'fview__wait muted', say('Loading history…')));
    let list;
    try { list = await client.history(f.file_id); } catch { body.replaceChildren(el('p', 'fview__bad', say('That didn’t work. Try again.'))); return; }
    const ul = el('ul', 'fhist');
    const now = client.state.files.get(f.file_id)?.version;
    for (const v of list) {
      const li = el('li', 'fhist__row'), main = el('div', 'fhist__main');
      main.append(el('span', 'fhist__v', say('Version {n}', { n: v.version })), el('span', 'fhist__meta', `${v.deleted ? say('Deleted') : v.manifest ? size(v.manifest.size) : say('Locked')} · ${who(v.author)} · ${ago(v.at)}`));
      li.append(main);
      if (v.version === now) li.append(el('span', 'badge badge--info', say('Current')));
      else if (!v.deleted && v.manifest && canWrite()) {
        const b = button(say('Restore'), 'btn small ghost');
        b.addEventListener('click', () => busy(async () => {
          const before = client.state.files.get(f.file_id)?.version;
          await client.restore(f.file_id, v.version);
          fresh.add(f.file_id);
          toast(say('Restored version {n}', { n: v.version }), before ? { run: () => busy(async () => { await client.restore(f.file_id, before); toast(say('Undone')); }) } : null);
          view(client.state.files.get(f.file_id), 'history');
        }));
        li.append(b);
      }
      ul.append(li);
    }
    body.replaceChildren(ul);
  }
  // ───── a suggestion: someone's change to the same lines, waiting for a yes or no ─────
  function diffView(from, to) {
    const ops = merge.diff(from, to), box = el('div', 'fdiff'), near = new Set();
    ops.forEach((o, i) => { if (o.t !== 'same') for (let k = i - 3; k <= i + 3; k++) near.add(k); });
    let skipped = 0;
    const flush = () => { if (skipped) { box.append(el('div', 'fdiff__skip', say('{n} lines unchanged', { n: skipped }))); skipped = 0; } };
    ops.forEach((o, i) => {
      if (o.t === 'same' && !near.has(i)) { skipped++; return; }
      flush();
      const row = el('div', `fdiff__row fdiff__row--${o.t}`);
      row.append(el('span', 'fdiff__sign', o.t === 'add' ? '+' : o.t === 'del' ? '−' : ''), el('span', 'fdiff__text', o.line.replace(/\n$/, '')));
      if (o.t !== 'same') row.setAttribute('aria-label', `${o.t === 'add' ? say('Added') : say('Removed')}: ${o.line}`);
      box.append(row);
    });
    flush();
    return box;
  }
  async function decide(s0, body) {
    body.replaceChildren(el('p', 'fview__wait muted', say('Loading the suggestion…')));
    let s;
    try { s = await client.details(s0); } catch { body.replaceChildren(el('p', 'fview__bad', say('This file didn’t pass its check, so it isn’t shown.'))); return; }
    const box = el('div', 'fsug'), mine = s.author === client.me.handle;
    box.append(el('p', 'fsug__who', say('{who} suggested a change {when}', { who: who(s.author), when: ago(s.at) })));
    const pane = el('div', 'fsug__pane');
    const views = [['changes', say('Changes')], ['original', say('Original')], ['current', say('Current')], ['proposed', say('Suggested')]];
    // Changes: what accepting does to the current text (only the reviewed lines), not the author's whole snapshot.
    const r = client.reviewed(s, s.current.text), changes = () => (r.ok ? diffView(s.current.text, r.text) : diffView(s.original.text, s.proposed.text));
    seg(box, views, (k) => pane.replaceChildren(k === 'changes' ? changes() : render.code(k === 'original' ? s.original.text : k === 'current' ? s.current.text : s.proposed.text)));
    pane.replaceChildren(changes());
    box.append(pane);
    const back = () => view(client.state.files.get(s.file_id), 'preview-only');
    const undoAgain = { run: () => busy(async () => { await client.again(s); toast(say('Undone')); }) };
    if (canWrite()) {
      const act = el('div', 'fsug__act'), no = button(mine ? say('Withdraw') : say('Reject'), 'btn small ghost'), change = button(say('Edit first'), 'btn small ghost'), yes = button(say('Accept'), 'btn small');
      act.append(no, el('span', 'fview__gap'), change, yes);
      box.append(act);
      yes.addEventListener('click', () => busy(async () => {
        const r = await client.accept(s);
        if (r.outcome === 'suggestion') { toast(say('It changed again. Edit it to fit'), { label: say('Edit first'), run: () => change.click() }); return; }
        fresh.add(s.file_id);
        toast(say('Accepted the suggestion'), { run: () => busy(async () => { await client.restore(s.file_id, r.before); toast(say('Undone')); }) });
        back();
      }));
      no.addEventListener('click', () => busy(async () => {
        await client.resolve(s, mine ? 'withdraw' : 'reject');
        // Undo of a reject reopens the same suggestion (the relay allows it for 10 minutes, while the file is unchanged).
        const reopen = { run: () => busy(async () => {
          try { await client.resolve(s, 'reopen'); toast(say('Undone')); view(client.state.files.get(s.file_id), 'decide'); }
          catch (e) { if (e.status >= 400 && e.status < 500) toast(say('That can’t be undone anymore. The file changed or time ran out.')); else throw e; }
        }) };
        toast(mine ? say('Withdrew your suggestion') : say('Rejected the suggestion'), mine ? undoAgain : reopen);
        back();
      }));
      // Edit first: the latest version with the suggestion applied where it still fits, ready to adjust and accept.
      change.addEventListener('click', async () => {
        const f = client.state.files.get(s.file_id), latest = client.decode((await client.load(f.file_id, f.version)).data);
        const m = client.reviewed(s, latest);
        editor({ f, text: m.ok ? m.text : latest, data: new TextEncoder().encode(latest), from: s });
      });
    } else if (mine) {
      const act = el('div', 'fsug__act'), out = button(say('Withdraw'), 'btn small ghost');
      act.append(out); box.append(act);
      out.addEventListener('click', () => busy(async () => { await client.resolve(s, 'withdraw'); toast(say('Withdrew your suggestion'), undoAgain); back(); }));
    }
    body.replaceChildren(box);
  }
  // Markdown and text: edit here, saved with compare-and-swap. A save that meets someone else's change merges when the
  // lines don't touch; when they do, ours waits as a suggestion on the same document.
  function editor({ f = null, text, data = null, dir = '', from = null }) {
    clearUrls();
    current = f ? { f, data } : null;
    const path = () => (f ? f.manifest.path : name.value);
    const { body, foot, bar, h } = frame({ title: f ? base(f.manifest.path) : say('New note'), meta: f ? metaOf(f) : say('End-to-end encrypted') });
    let name = null;
    if (!f) {
      name = el('input', 'fview__name'); name.value = client.freePath(dir ? `${dir}/${say('Untitled.md')}` : say('Untitled.md')).split('/').pop(); name.setAttribute('aria-label', say('Name'));
      name.spellcheck = false;
      h.replaceChildren(name);
    }
    const area = el('textarea', 'fview__edit'); area.value = text; area.spellcheck = true; area.setAttribute('aria-label', f ? base(f.manifest.path) : say('New note'));
    const status = el('span', 'fview__status');
    const count = () => { const n = area.value ? area.value.split('\n').length : 0; status.textContent = `${area.dataset.dirty ? say('Unsaved changes') + ' · ' : ''}${say('{n} lines', { n })}`; };
    let counting = 0;
    area.addEventListener('input', () => { area.dataset.dirty = '1'; clearTimeout(counting); counting = setTimeout(count, 250); });
    // Tab indents, like a code editor; Shift+Tab leaves the field, so keyboard users are never trapped.
    area.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); const t = core.ext(path()) === 'md' ? '  ' : '\t'; area.setRangeText(t, area.selectionStart, area.selectionEnd, 'end'); area.dispatchEvent(new Event('input')); }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); go(); }
    });
    const pane = el('div', 'fview__pane');
    const previewable = () => ['md', 'markdown', 'json', 'csv', 'tsv'].includes(core.ext(path()));
    if (previewable()) seg(bar, [['write', say('Edit')], ['preview', say('Preview')]], (k) => { if (k === 'write') { pane.replaceChildren(area); area.focus(); } else pane.replaceChildren(rendered(path(), area.value)); });
    pane.append(area);
    body.replaceChildren(pane);
    const cancel = button(say('Cancel'), 'btn small ghost'), save = button(say('Save'), 'btn small');
    foot.append(status, el('span', 'fview__gap'), cancel, save);
    count();
    cancel.addEventListener('click', () => (f ? view(client.state.files.get(f.file_id) ?? f, from ? 'decide' : 'preview') : dlg.close()));
    const go = () => busy(async () => {
      save.disabled = true;
      try {
        const bytes = new TextEncoder().encode(area.value);
        if (f) {
          const r = from
            ? await client.accept(from, { text: area.value, basedOn: f.version })
            : await client.write({ fileId: f.file_id, path: f.manifest.path, data: bytes, base: f.version, baseData: data });
          delete area.dataset.dirty;
          fresh.add(f.file_id);
          if (r.outcome === 'suggestion' && from) { toast(say('It changed again. Edit it to fit')); return; }
          if (r.outcome === 'suggestion') {
            toast(say('{who} changed the same lines. Yours waits as a suggestion', { who: who(r.with) }), { label: say('Review'), run: () => view(client.state.files.get(f.file_id), 'decide') });
            view(client.state.files.get(f.file_id), 'decide');
            return;
          }
          const undo = { run: () => busy(async () => { await client.restore(f.file_id, r.before); toast(say('Undone')); }) };
          toast(from ? say('Accepted the suggestion') : r.outcome === 'merged' ? say('Saved, with {who}’s changes merged in', { who: who(r.with) }) : say('Saved {name}', { name: base(f.manifest.path) }), undo);
          view(client.state.files.get(f.file_id), 'preview-only');
        } else {
          let p = (dir ? `${dir}/${name.value.trim()}` : name.value.trim()).normalize('NFC');
          if (!/\.[a-z0-9]+$/i.test(p)) p += '.md';
          try { core.checkPath(p); } catch { toast(say('Pick a name without slashes at the ends.')); name.focus(); return; }
          p = client.freePath(p);
          const r = await client.write({ path: p, data: bytes, base: 0 });
          fresh.add(r.file_id);
          delete area.dataset.dirty;
          if (r.outcome === 'suggestion') {
            toast(say('{who} made {name} first. Yours waits as a suggestion', { who: who(r.with), name: base(p) }), { label: say('Review'), run: () => view(client.state.files.get(r.file_id), 'decide') });
            view(client.state.files.get(r.file_id), 'decide');
            return;
          }
          toast(say('Saved {name}', { name: base(p) }), { run: () => busy(async () => { await client.remove(r.file_id); toast(say('Undone')); }) });
          view(client.state.files.get(r.file_id));
        }
      } finally { save.disabled = false; }
    });
    save.addEventListener('click', go);
    (name ?? area).focus();
  }
  const newNote = (dir) => editor({ text: '', dir });

  // ───── start: paired or not, then live ─────
  async function start() {
    rec = await db.get('devices', handle);
    if (!rec?.token) return pairView();
    if (rec.device.root.sign !== rootKeys.sign || rec.device.root.box !== rootKeys.box) { await db.del('devices', handle); return pairView(say('Your bot has new keys. Set this browser up again.')); }
    root.replaceChildren(el('p', 'fnote muted', say('Opening the folder…')));
    client = folderClient({ core, merge, fetch: (...a) => fetch(...a), base: location.origin, group, device: { token: rec.token, handle, device: rec.device, root: rec.device.root }, keys: rec.keys, pins });
    try { await client.refresh(); await client.sync(0); await client.proposals().catch(() => {}); }
    catch (e) {
      if (e.status === 401) { await db.del('devices', handle); return pairView(say('This browser was removed from your bot’s devices. Set it up again.')); }
      root.replaceChildren(el('p', 'fnote', e.status === 403 ? say('Your bot doesn’t have access to this folder yet.') : e.status === 404 ? say('The shared folder is off.') : say('Can’t reach the folder right now.')));
      return;
    }
    build(); draw();
    let errors = 0;
    const mine = client;
    while (alive && client === mine) {
      if (document.hidden) { await sleep(1500); continue; }
      try { const ch = await client.sync(25); errors = 0; if (ch.length && client === mine) { ch.forEach((id) => fresh.add(id)); if (holds.has('busy')) continue; draw(); } }
      catch (e) { if (e.status === 401) { await db.del('devices', handle); return pairView(say('This browser was removed from your bot’s devices. Set it up again.')); } await sleep(Math.min(30_000, 2000 * 2 ** errors++)); }
    }
  }
  (async () => {
    try {
      if (!crypto?.subtle || !window.indexedDB || !window.DecompressionStream) throw new Error('old');
      await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
      await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
      core = folderCrypto(crypto); merge = folderMerge(); render = folderRender(document);
    } catch { root.replaceChildren(el('p', 'fnote', say('This browser can’t open the folder. Try a current Chrome, Edge, Safari or Firefox.'))); return; }
    document.body.append(dlg);
    start();
  })();
}

// The page script, served at /app/folders.js. Built from the functions above, so tests and browser share one source.
export const FOLDERS_JS = `(${folderApp.toString()})({ folderCrypto: ${folderCrypto.toString()}, folderMerge: ${folderMerge.toString()}, folderClient: ${folderClient.toString()}, folderRender: ${folderRender.toString()} });`;
export const FOLDERS_JS_HASH = createHash('sha256').update(FOLDERS_JS).digest('hex').slice(0, 16);
