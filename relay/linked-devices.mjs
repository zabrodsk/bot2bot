// Linked identities keep the original signing key as their trust anchor. No private keys live here.
import { createHash, createPublicKey, verify } from 'node:crypto';
// Public device records only. Domain separation keeps these signatures separate from message signatures.
const DEVICE_KEY = /^[A-Za-z0-9_-]{43}$/;
const DEVICE_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const DEVICE_ID = /^d_[a-f0-9]{24}$/;
const DEVICE_SEAL = /^b2b1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/;
const deviceHash = (s) => createHash('sha256').update(s).digest('hex');
const deviceBytes = (kind, value) => Buffer.from(`bot2bot devices v1 ${kind}\n${JSON.stringify(value)}`);
const devicePublic = (x) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
const deviceCheck = (kind, value, signature, key) => {
  try { return typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signature) && verify(null, deviceBytes(kind, value), devicePublic(key), Buffer.from(signature, 'base64url')); } catch { return false; }
};
const deviceCode = (request) => deviceHash(deviceBytes('link code', request)).slice(0, 16).toUpperCase();
const deviceReturnCode = (request, root) => deviceHash(deviceBytes('return code', { request, root })).slice(0, 16).toUpperCase();
function verifiedDevices(manifest, root) {
  const r = manifest?.roster;
  if (!r || r.v !== 1 || !root || r.root?.sign !== root.sign || r.root?.box !== root.box || !Number.isSafeInteger(r.revision) || r.revision < 1 || !Array.isArray(r.devices) || r.devices.length < 1 || r.devices.length > 4 || !deviceCheck('roster', r, manifest.signature, root.sign)) throw new Error('device list signature does not match the identity key');
  const ids = new Set(), names = new Set(), signs = new Set(), boxes = new Set();
  for (const d of r.devices) {
    if (!d || !(d.id === 'primary' || DEVICE_ID.test(d.id)) || !DEVICE_NAME.test(d.name) || !DEVICE_KEY.test(d.sign) || !DEVICE_KEY.test(d.box) || ids.has(d.id) || names.has(d.name) || signs.has(d.sign) || boxes.has(d.box)) throw new Error('invalid device list');
    ids.add(d.id); names.add(d.name); signs.add(d.sign); boxes.add(d.box);
  }
  const first = r.devices[0];
  if (first.id !== 'primary' || first.name !== 'primary' || first.sign !== root.sign || first.box !== root.box) throw new Error('device list has a different primary');
  return r.devices;
}
function deviceEnvelope(sealed) {
  if (typeof sealed !== 'string' || !sealed.startsWith('b2bd1.')) return null;
  if (sealed.length > 90_000) throw new Error('device message is too large');
  const e = JSON.parse(Buffer.from(sealed.slice(6), 'base64url').toString('utf8'));
  if (e?.v !== 1 || !e.copies || typeof e.copies !== 'object' || Array.isArray(e.copies) || Object.keys(e.copies).length < 1 || Object.keys(e.copies).length > 4 || !Object.entries(e.copies).every(([id, s]) => (id === 'primary' || DEVICE_ID.test(id)) && typeof s === 'string' && s.length <= 64_000 && DEVICE_SEAL.test(s))) throw new Error('invalid device envelopes');
  return e;
}

export function migrateLinkedDevices(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS device_rosters (bot_id INTEGER PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE, manifest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS linked_devices (id TEXT PRIMARY KEY, bot_id INTEGER NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, root_token_hash TEXT NOT NULL, sign_pub TEXT NOT NULL, box_pub TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS device_links (id TEXT PRIMARY KEY, request TEXT NOT NULL, proof TEXT NOT NULL, expires_at INTEGER NOT NULL, bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS device_handled_seen (message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, device_id TEXT NOT NULL, PRIMARY KEY(message_id, device_id));`);
  // Filter before LIMIT so a newly linked device cannot consume envelopes made before it joined.
  // Checking the actual copy also survives message retention and reused SQLite rowids.
  db.function('b2b_device_can_open', (sealed, id) => {
    if (id === 'primary' || sealed == null) return 1;
    try { return deviceEnvelope(sealed)?.copies[id] ? 1 : 0; } catch { return 0; }
  });
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  for (const col of ['claim_device', 'handled_device']) if (!cols.includes(col)) db.exec(`ALTER TABLE messages ADD COLUMN ${col} TEXT`);
  if (!db.prepare('PRAGMA table_info(linked_devices)').all().some((c) => c.name === 'held_briefs')) db.exec('ALTER TABLE linked_devices ADD COLUMN held_briefs INTEGER');
  // Reconnecting or deleting the identity must never leave another machine authorized under it.
  db.exec(`CREATE TRIGGER IF NOT EXISTS devices_reset AFTER UPDATE OF sign_pub, box_pub, token_hash ON bots
    WHEN OLD.sign_pub IS NOT NEW.sign_pub OR OLD.box_pub IS NOT NEW.box_pub OR OLD.token_hash IS NOT NEW.token_hash BEGIN
      DELETE FROM device_rosters WHERE bot_id = NEW.id;
      DELETE FROM linked_devices WHERE bot_id = NEW.id;
      DELETE FROM device_links WHERE bot_id = NEW.id;
    END;`);
}
export function createLinkedDevices({ q, tx, clock, HttpError, sha, L }) {
  const fail = (status, text) => { throw new HttpError(status, text); };
  const rootOf = (b) => ({ sign: b.sign_pub, box: b.box_pub });
  const roster = (id) => { const r = q('SELECT manifest FROM device_rosters WHERE bot_id = ?').get(id); return r ? JSON.parse(r.manifest) : null; };
  const botFor = (handle) => q('SELECT * FROM bots WHERE handle = ?').get(String(handle).replace(/^@/, ''));
  const active = (b) => roster(b.id)?.roster.devices ?? [{ id: 'primary', name: 'primary', ...rootOf(b) }];
  const deviceId = (me) => me.device_id ?? 'primary';
  const primary = (me) => { if (me.device_id) fail(403, 'Only the primary device approves or revokes devices and runs the doorbell.'); if (!me.box_pub || !me.sign_pub || me.disconnected_at || me.removed_at) fail(403, 'An active private-mode identity is required.'); };
  function authenticate(hash) {
    const d = q('SELECT * FROM linked_devices WHERE token_hash = ? AND revoked_at IS NULL').get(hash);
    if (!d) return;
    const b = q('SELECT * FROM bots WHERE id = ?').get(d.bot_id);
    if (!b || b.disconnected_at || b.removed_at || b.token_hash !== d.root_token_hash || !active(b).some((x) => x.id === d.id && x.sign === d.sign_pub && x.box === d.box_pub)) return;
    return { ...b, device_id: d.id, device_name: d.name };
  }
  function saveRoster(me, manifest, expected) {
    try { verifiedDevices(manifest, rootOf(me)); } catch (e) { fail(400, e.message); }
    const old = roster(me.id);
    if (manifest.roster.revision !== (old?.roster.revision ?? 0) + 1 || JSON.stringify(manifest.roster.devices) !== JSON.stringify(expected)) fail(409, 'The device list changed. List devices and try again.');
    q('INSERT INTO device_rosters (bot_id, manifest) VALUES (?, ?) ON CONFLICT(bot_id) DO UPDATE SET manifest = excluded.manifest').run(me.id, JSON.stringify(manifest));
  }
  function requestById(id) {
    const r = q('SELECT * FROM device_links WHERE id = ? AND expires_at > ?').get(String(id), clock());
    if (!r) fail(404, 'Device link is missing or expired. Start again on the new machine.');
    return r;
  }
  function handledFor(me, consume = false) {
    if (!roster(me.id) || me.paused_at) return [];
    const id = deviceId(me);
    const rows = q(`SELECT m.id, m.handled_device FROM messages m WHERE m.to_bot = ? AND m.status = 'delivered'
      AND m.kind NOT IN ('probe','group_event') AND m.handled_device IS NOT NULL AND m.handled_device != ? AND m.body_purged_at IS NULL
      AND b2b_device_can_open(m.sealed, ?) AND NOT EXISTS (SELECT 1 FROM device_handled_seen s WHERE s.message_id = m.id AND s.device_id = ?)
      ORDER BY m.created_at LIMIT 50`).all(me.id, id, id, id);
    const out = rows.map((m) => ({ id: m.id, device: m.handled_device === 'primary' ? 'primary' : q('SELECT name FROM linked_devices WHERE id = ? AND bot_id = ?').get(m.handled_device, me.id)?.name ?? 'revoked device' }));
    if (consume) for (const m of rows) q('INSERT OR IGNORE INTO device_handled_seen VALUES (?, ?)').run(m.id, id);
    return out;
  }
  const routes = {
    'POST /v1/devices/handled': ({ me }) => ({ handled: handledFor(me, true) }),
    'POST /v1/devices/link': ({ body }) => tx(() => {
      const r = body?.request;
      if (!r || !DEVICE_ID.test(r.id) || !DEVICE_NAME.test(r.name) || r.name === 'primary' || !DEVICE_KEY.test(r.sign) || !DEVICE_KEY.test(r.box) || !/^[a-f0-9]{64}$/.test(r.token_hash) || !/^[a-f0-9]{32}$/.test(r.nonce) || !Number.isSafeInteger(r.expires_at) || r.expires_at <= clock() || r.expires_at > clock() + 16 * 60_000 || !deviceCheck('request', r, body.proof, r.sign)) fail(400, 'Invalid device link request.');
      q('DELETE FROM device_links WHERE expires_at <= ?').run(clock());
      if (q('SELECT count(*) AS n FROM device_links').get().n >= 1000) fail(429, 'Too many device links. Try later.');
      const old = q('SELECT request FROM device_links WHERE id = ?').get(r.id);
      if (old && old.request !== JSON.stringify(r)) fail(409, 'Device link id is already in use.');
      q('INSERT OR IGNORE INTO device_links (id, request, proof, expires_at) VALUES (?, ?, ?, ?)').run(r.id, JSON.stringify(r), body.proof, r.expires_at);
      return { id: r.id };
    }),
    'POST /v1/devices/link/poll': ({ body }) => {
      const row = requestById(body?.id), request = JSON.parse(row.request);
      if (!deviceCheck('poll', { id: request.id }, body.proof, request.sign)) fail(403, 'Device proof required.');
      if (!row.bot_id) return { status: 'waiting' };
      const bot = q('SELECT * FROM bots WHERE id = ?').get(row.bot_id), manifest = roster(row.bot_id);
      if (!bot || bot.disconnected_at || bot.removed_at || !manifest?.roster.devices.some((d) => d.id === request.id)) fail(410, 'Device approval is no longer active.');
      return { status: 'approved', handle: bot.handle, manifest };
    },
    'GET /v1/devices': ({ me }) => ({ handle: me.handle, current: deviceId(me), root: rootOf(me), manifest: roster(me.id), devices: active(me), removed_by_owner: removedByOwner(me) }),
    'GET /v1/devices/link/:id': ({ me, params }) => { primary(me); const r = requestById(params.id); if (r.bot_id && r.bot_id !== me.id) fail(403, 'Already linked to another identity.'); return { request: JSON.parse(r.request), proof: r.proof }; },
    'POST /v1/devices/approve': ({ me, body }) => tx(() => {
      primary(me);
      const row = requestById(body?.id), r = JSON.parse(row.request);
      if (row.bot_id) fail(409, 'This device link has already been approved.');
      if (body.code !== deviceCode(r)) fail(403, 'Device code does not match.');
      const ds = active(me);
      if (ds.length >= 4 || ds.some((d) => d.name === r.name || d.id === r.id)) fail(409, 'Device name is in use or the four-device limit was reached.');
      const next = [...ds, { id: r.id, name: r.name, sign: r.sign, box: r.box, token_hash: r.token_hash }];
      saveRoster(me, body.manifest, next);
      q('INSERT INTO linked_devices (id, bot_id, name, token_hash, root_token_hash, sign_pub, box_pub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(r.id, me.id, r.name, r.token_hash, me.token_hash, r.sign, r.box, clock());
      q('UPDATE device_links SET bot_id = ? WHERE id = ?').run(me.id, r.id);
      return { ok: true };
    }),
    'POST /v1/devices/revoke': ({ me, body }) => tx(() => {
      primary(me); const ds = active(me), d = ds.find((x) => x.name === body?.name);
      if (!d || d.id === 'primary') fail(400, 'Name a linked device. The primary cannot be revoked here.');
      saveRoster(me, body.manifest, ds.filter((x) => x.id !== d.id));
      q('UPDATE linked_devices SET revoked_at = ? WHERE id = ? AND bot_id = ?').run(clock(), d.id, me.id);
      // A revoked reader's unfinished lease returns to the other devices immediately.
      q("UPDATE messages SET status = 'pending', lease_until = NULL, lease_token = NULL, claim_device = NULL WHERE to_bot = ? AND status = 'claimed' AND claim_device = ?").run(me.id, d.id);
      return { ok: true };
    }),
  };
  // Called inside the existing direct/group send transactions, including internal connector sends.
  function validate(sealed, me, recipientId) {
    const recipient = q('SELECT * FROM bots WHERE id = ?').get(recipientId);
    const mine = roster(me.id), theirs = roster(recipientId);
    let e; try { e = deviceEnvelope(sealed); } catch (err) { fail(400, err.message); }
    if (!e) {
      if (sealed && (mine || theirs || me.device_id)) fail(409, 'This identity uses linked devices. Update the b2b tool and send again; no message was sent.');
      return typeof sealed === 'string' && sealed.length <= L.sealedMax && DEVICE_SEAL.test(sealed);
    }
    try {
      if (e.sender) verifiedDevices(e.sender, rootOf(me));
      if (JSON.stringify(e.sender ?? null) !== JSON.stringify(mine) || e.from !== deviceId(me)) throw new Error('Sender device list changed. Refresh it and send again.');
      const ids = active(recipient).map((d) => d.id).sort();
      if (e.revision !== (theirs?.roster.revision ?? 0) || JSON.stringify(Object.keys(e.copies).sort()) !== JSON.stringify(ids)) throw new Error('Recipient device list changed. Refresh it and send again.');
      const signing = active(me).find((d) => d.id === e.from);
      if (!signing) throw new Error('Sender device is revoked.');
    } catch (err) { fail(409, err.message); }
    return true;
  }
  function decorate(value) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) { value.forEach(decorate); return value; }
    if (typeof value.sealed === 'string' && value.sealed.startsWith('b2bd1.')) {
      const e = deviceEnvelope(value.sealed);
      if (e.sender) { const b = q('SELECT id FROM bots WHERE sign_pub = ? AND box_pub = ?').get(e.sender.roster.root.sign, e.sender.roster.root.box); value.device_current = b ? roster(b.id) : null; }
    }
    for (const [k, v] of Object.entries(value)) if (k !== 'device_current') decorate(v);
    return value;
  }
  function install(all) {
    Object.assign(all, routes);
    const meRoute = all['GET /v1/me'];
    all['GET /v1/me'] = (ctx) => {
      const result = meRoute(ctx);
      if (ctx.me.device_id) {
        result.inbox_pending = q("SELECT count(*) AS n FROM messages WHERE to_bot = ? AND status IN ('pending','claimed') AND kind != 'probe' AND b2b_device_can_open(sealed, ?)").get(ctx.me.id, ctx.me.device_id).n;
        result.inbox_ready = ctx.me.paused_at ? 0 : q("SELECT count(*) AS n FROM messages WHERE to_bot = ? AND status = 'pending' AND coalesce(note, '') != 'key_check' AND b2b_device_can_open(sealed, ?)").get(ctx.me.id, ctx.me.device_id).n;
      }
      if (roster(ctx.me.id)) result.device_handled_pending = handledFor(ctx.me).length;
      return result;
    };
    for (const key of ['GET /v1/contacts', 'GET /v1/groups', 'GET /v1/groups/:group']) {
      const base = all[key];
      all[key] = (ctx) => {
        const result = base(ctx);
        const mine = roster(ctx.me.id); if (mine) result.devices = mine;
        const add = (c) => { const b = botFor(c.handle); if (b) { const r = roster(b.id); if (r) c.devices = r; if (c.your_own_bot) c.platform = b.platform; } };
        result.contacts?.forEach(add); result.members?.forEach(add); result.groups?.forEach((g) => g.members?.forEach(add));
        return result;
      };
    }
    const claim = all['POST /v1/inbox/claim'];
    all['POST /v1/inbox/claim'] = (ctx) => {
      if (ctx.body?.devices !== 1 && q("SELECT 1 FROM messages WHERE to_bot = ? AND status IN ('pending','claimed') AND sealed LIKE 'b2bd1.%' LIMIT 1").get(ctx.me.id)) fail(409, 'A message uses linked devices. Update the b2b tool before reading it.');
      const out = claim(ctx), id = deviceId(ctx.me);
      for (const m of out.messages) q('UPDATE messages SET claim_device = ? WHERE id = ? AND lease_token = ?').run(id, m.id, m.lease);
      if (roster(ctx.me.id) && !ctx.me.paused_at) out.handled = handledFor(ctx.me, true);
      return out;
    };
    for (const key of ['POST /v1/messages/:id/ack', 'POST /v1/messages/:id/hold']) {
      const base = all[key];
      all[key] = (ctx) => {
        const m = q('SELECT * FROM messages WHERE id = ?').get(String(ctx.params.id).split('~')[0]);
        if (m?.to_bot === ctx.me.id && m.status === 'claimed' && m.claim_device && m.claim_device !== deviceId(ctx.me)) fail(409, 'Another device holds this message.');
        const result = base(ctx);
        if (key.endsWith('/ack') && !result.already) q('UPDATE messages SET handled_device = ? WHERE id = ?').run(deviceId(ctx.me), result.id);
        return result;
      };
    }
    for (const key of Object.keys(all).filter((k) => / \/v1\/(doorbell|watch|keys|group-browser)(\/|$)/.test(k))) {
      const base = all[key]; all[key] = (ctx) => { if (ctx.me?.device_id) primary(ctx.me); return base(ctx); };
    }
    for (const key of Object.keys(all)) {
      const base = all[key]; all[key] = (ctx) => { const value = base(ctx); return value?.then ? value.then(decorate) : decorate(value); };
    }
  }
  // Devices the owner cut off on the dashboard that the signed list still names: the primary finishes with device revoke.
  const removedByOwner = (b) => {
    const ids = new Set(active(b).map((d) => d.id));
    return q('SELECT id, name FROM linked_devices WHERE bot_id = ? AND revoked_at IS NOT NULL ORDER BY created_at').all(b.id).filter((d) => ids.has(d.id)).map((d) => d.name);
  };
  // The owner's dashboard: the bot's computers, each linked one with when it was linked and whether it's cut off.
  function forOwner(b) {
    if (!roster(b.id)) return [];
    const rows = new Map(q('SELECT id, created_at, revoked_at FROM linked_devices WHERE bot_id = ?').all(b.id).map((r) => [r.id, r]));
    return active(b).map((d) => (d.id === 'primary' ? { id: d.id, name: d.name, primary: true }
      : { id: d.id, name: d.name, linked_at: rows.get(d.id)?.created_at ?? null, off: !rows.get(d.id) || !!rows.get(d.id).revoked_at }));
  }
  // Cutting a device off from the dashboard: its token stops working at once and what it was reading goes back to the
  // other devices. The signed list changes only on the primary (device revoke), so Undo can let it back in until then.
  function setOff(b, id, off) {
    return tx(() => {
      const d = q('SELECT * FROM linked_devices WHERE id = ? AND bot_id = ?').get(String(id), b.id);
      if (!d || !active(b).some((x) => x.id === d.id && x.sign === d.sign_pub && x.box === d.box_pub)) fail(404, 'That computer is no longer linked.');
      if (off === !!d.revoked_at) return { changed: false, name: d.name };
      q('UPDATE linked_devices SET revoked_at = ? WHERE id = ?').run(off ? clock() : null, d.id);
      if (off) q("UPDATE messages SET status = 'pending', lease_until = NULL, lease_token = NULL, claim_device = NULL WHERE to_bot = ? AND status = 'claimed' AND claim_device = ?").run(b.id, d.id);
      return { changed: true, name: d.name };
    });
  }
  function ownCodex(me, to) {
    if (!/^my codex$/i.test(to)) return to;
    const matches = q(`SELECT b.handle FROM contacts c JOIN bots b ON b.id = c.peer_bot
      JOIN contacts back ON back.owner_bot = b.id AND back.peer_bot = c.owner_bot
      WHERE c.owner_bot = ? AND b.user_id = ? AND b.platform = 'codex' AND b.removed_at IS NULL AND b.disconnected_at IS NULL
      AND c.blocked = 0 AND back.blocked = 0 AND c.approved_at IS NOT NULL AND back.approved_at IS NOT NULL`).all(me.id, me.user_id ?? -1);
    if (matches.length !== 1) fail(409, matches.length ? `Which Codex identity? Ask your owner to choose: ${matches.map((m) => '@' + m.handle).join(', ')}.` : 'No active Codex identity of your owner is in contacts.');
    return '@' + matches[0].handle;
  }
  return { routes, install, authenticate, validate, ownCodex, forOwner, setOff, active, roster };
}
