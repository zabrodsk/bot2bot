// Approve from your phone. A coding agent that is blocked on a permission, or finished while its owner is away,
// puts a card on the owner's phone page; the owner's answer goes back to the agent's own session.
//
// The relay only carries it. A phone makes two key pairs in its browser (P-256: one to sign, one to receive) and
// the owner tells their bot the phone's code at the keyboard, so the bot pins those keys itself. A card is
// encrypted by the bot to each phone, and an answer is signed by the phone and checked by the bot, bound to the one
// request it answers. So the relay can't read a card, and neither the relay nor another bot can approve anything:
// whatever is stored here, an answer without the phone's signature is worth nothing to the bot.
import { createPublicKey, createPrivateKey, generateKeyPairSync, createHash, sign } from 'node:crypto';
import { phonePage, PHONE_SW, phoneManifest } from './phone-page.mjs';

export const PHONE_LIMITS = { devices: 5, openCards: 30, cardsPerHour: 240, boxBytes: 24 * 1024, replyBytes: 4 * 1024, ttlMinMs: 30_000, ttlMaxMs: 30 * 60_000, holdMs: 25_000, keepMs: 24 * 3_600_000, linked: 20 };
const DEV = /^dev_[A-Za-z0-9_-]{16}$/;
const CARD = /^apr_[A-Za-z0-9_-]{22}$/;
const KINDS = ['permission', 'done', 'info', 'test'];
const DECISIONS = ['allow', 'deny', 'reply'];
const bytes = (s, min, max) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && s.length <= Math.ceil(max * 4 / 3) + 2 && (() => { const b = Buffer.from(s, 'base64url'); return b.length >= min && b.length <= max && b.toString('base64url') === s; })();
// A P-256 public key as browsers export it ("raw": 0x04, x, y), checked to be a point on the curve.
function p256(raw) {
  if (!bytes(raw, 65, 65)) return null;
  const b = Buffer.from(raw, 'base64url');
  if (b[0] !== 4) return null;
  try { return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b.subarray(1, 33).toString('base64url'), y: b.subarray(33).toString('base64url') }, format: 'jwk' }); } catch { return null; }
}
// The code the owner reads on their phone and tells their bot: 60 bits of both public keys' hash. The bot computes it
// again from the keys the relay hands it, so a key the relay swapped would not match what the owner read out.
export function phoneCode(signPub, boxPub) {
  const h = createHash('sha256').update(`b2b-phone/1|${signPub}|${boxPub}`).digest();
  let bits = 0n;
  for (let i = 0; i < 8; i++) bits = (bits << 8n) | BigInt(h[i]);
  let out = '';
  for (let i = 0; i < 12; i++) out += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Number((bits >> BigInt(59 - i * 5)) & 31n)];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}
// Where browsers' push services live. A subscription anywhere else is refused, so this never calls an address of
// someone's choosing.
const PUSH_HOSTS = [/(^|\.)googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.services\.mozilla\.com$/];

export function migratePhone(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS phone_devices (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, sign_pub TEXT NOT NULL, box_pub TEXT NOT NULL,
    code TEXT NOT NULL, created_at INTEGER NOT NULL, seen_at INTEGER, push_endpoint TEXT, linked TEXT NOT NULL DEFAULT '[]'
  ); CREATE INDEX IF NOT EXISTS phone_devices_user ON phone_devices(user_id);
  CREATE TABLE IF NOT EXISTS phone_cards (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), bot_id INTEGER NOT NULL REFERENCES bots(id), kind TEXT NOT NULL, boxes TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, answer TEXT, answered_at INTEGER, closed_at INTEGER
  ); CREATE INDEX IF NOT EXISTS phone_cards_user ON phone_cards(user_id, expires_at);
  CREATE TABLE IF NOT EXISTS phone_vapid (id INTEGER PRIMARY KEY CHECK (id = 1), public_key TEXT NOT NULL, private_jwk TEXT NOT NULL);`);
}

export function createPhone({ q, tx, clock, token, HttpError, publicUrl = '', fetchImpl = fetch, allowLocalWebhooks = false, log = () => {}, limits = {} }) {
  const L = { ...PHONE_LIMITS, ...limits };
  const waiters = new Map(); // card id → the bot requests held open for its answer
  const sweep = () => q('DELETE FROM phone_cards WHERE expires_at < ?').run(clock() - L.keepMs);
  const ownerOf = (me) => { if (!me.user_id) throw new HttpError(403, 'This bot has no owner account, so there is no phone to ask. Connect it from the dashboard first.'); return me.user_id; };
  const devicesOf = (userId) => q('SELECT * FROM phone_devices WHERE user_id = ? ORDER BY created_at').all(userId);
  const deviceOf = (userId, id) => { const d = typeof id === 'string' && DEV.test(id) && q('SELECT * FROM phone_devices WHERE id = ? AND user_id = ?').get(id, userId); if (!d) throw new HttpError(404, 'That phone is not set up on this account.'); return d; };
  const state = (c, t = clock()) => (c.answered_at ? 'answered' : c.closed_at ? 'closed' : c.expires_at <= t ? 'expired' : 'open');
  const forBot = (c) => ({ id: c.id, state: state(c), expires_at: c.expires_at, ...(c.answered_at ? { answer: JSON.parse(c.answer) } : {}) });
  const wake = (id) => { for (const fn of waiters.get(id) ?? []) fn(); };

  // ───── push: a notification with no content, signed the way browsers' push services ask (VAPID) ─────
  function vapid() {
    let v = q('SELECT * FROM phone_vapid WHERE id = 1').get();
    if (!v) {
      const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const j = publicKey.export({ format: 'jwk' });
      const raw = Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url');
      q('INSERT OR IGNORE INTO phone_vapid (id, public_key, private_jwk) VALUES (1, ?, ?)').run(raw, JSON.stringify(privateKey.export({ format: 'jwk' })));
      v = q('SELECT * FROM phone_vapid WHERE id = 1').get();
    }
    return { publicKey: v.public_key, privateKey: createPrivateKey({ key: JSON.parse(v.private_jwk), format: 'jwk' }) };
  }
  function pushTarget(endpoint) {
    let u;
    try { u = new URL(String(endpoint)); } catch { return null; }
    if (String(endpoint).length > 2000 || u.username || u.password) return null;
    const local = allowLocalWebhooks && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    return local || (u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname.toLowerCase()))) ? u : null;
  }
  async function ring(device) {
    const u = pushTarget(device.push_endpoint);
    if (!u) return false;
    const v = vapid();
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const body = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: u.origin, exp: Math.floor(clock() / 1000) + 6 * 3600, sub: /^https:/.test(publicUrl) ? publicUrl : 'mailto:push@bot2bot.link' })}`;
    const jwt = `${body}.${sign('sha256', Buffer.from(body), { key: v.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    try {
      const r = await fetchImpl(u, { method: 'POST', headers: { authorization: `vapid t=${jwt}, k=${v.publicKey}`, ttl: '300', urgency: 'high', 'content-length': '0' }, signal: AbortSignal.timeout(10_000) });
      // The browser dropped this subscription: stop ringing it. The phone page asks again when it's next open.
      if (r.status === 404 || r.status === 410) q('UPDATE phone_devices SET push_endpoint = NULL WHERE id = ? AND push_endpoint = ?').run(device.id, device.push_endpoint);
      return r.status >= 200 && r.status < 300;
    } catch { return false; }
  }

  // ───── what a bot does ─────
  const routes = {
    // The owner's phones and their public keys. The bot pins the one whose code its owner read out.
    'GET /v1/phone/devices': ({ me }) => ({ page: `${publicUrl}/app/phone`,
      devices: devicesOf(ownerOf(me)).map((d) => ({ id: d.id, name: d.name, sign: d.sign_pub, box: d.box_pub, created_at: d.created_at, push: !!d.push_endpoint })) }),
    'POST /v1/phone/devices/:id/linked': ({ me, params, body }) => tx(() => {
      const d = deviceOf(ownerOf(me), params.id);
      const had = JSON.parse(d.linked || '[]').filter((h) => h !== me.handle);
      const linked = body?.linked === false ? had : [...had, me.handle].slice(-L.linked);
      q('UPDATE phone_devices SET linked = ? WHERE id = ?').run(JSON.stringify(linked), d.id);
      return { id: d.id, linked: linked.includes(me.handle) };
    }),
    'POST /v1/phone/cards': ({ me, body }) => {
      const userId = ownerOf(me);
      const t = clock();
      const made = tx(() => {
        sweep();
        if (!body || typeof body.id !== 'string' || !CARD.test(body.id) || !KINDS.includes(body.kind)) throw new HttpError(400, 'a card needs an id (apr_…) and a kind');
        const ttl = Math.round(Number(body.ttl) * 1000);
        if (!(ttl >= L.ttlMinMs && ttl <= L.ttlMaxMs)) throw new HttpError(400, `ttl is ${L.ttlMinMs / 1000} to ${L.ttlMaxMs / 1000} seconds`);
        const boxes = body.boxes && typeof body.boxes === 'object' && !Array.isArray(body.boxes) ? Object.entries(body.boxes) : [];
        const mine = new Map(devicesOf(userId).map((d) => [d.id, d]));
        if (!boxes.length || boxes.length > L.devices) throw new HttpError(400, 'a card is encrypted to at least one of the owner\'s phones');
        for (const [id, b] of boxes) {
          if (!mine.has(id)) throw new HttpError(400, 'a card can only go to its owner\'s own phones');
          if (!b || typeof b !== 'object' || Object.keys(b).some((k) => !['eph', 'iv', 'ct'].includes(k)) || !bytes(b.eph, 65, 65) || !bytes(b.iv, 12, 12) || !bytes(b.ct, 17, L.boxBytes)) throw new HttpError(400, 'expected a bounded encrypted card');
        }
        if (q('SELECT count(*) AS n FROM phone_cards WHERE bot_id = ? AND answered_at IS NULL AND closed_at IS NULL AND expires_at > ?').get(me.id, t).n >= L.openCards) throw new HttpError(429, 'too many cards are waiting for your owner already');
        if (q('SELECT count(*) AS n FROM phone_cards WHERE bot_id = ? AND created_at > ?').get(me.id, t - 3_600_000).n >= L.cardsPerHour) throw new HttpError(429, 'too many cards in the last hour');
        if (q('SELECT 1 FROM phone_cards WHERE id = ?').get(body.id)) throw new HttpError(409, 'that card id was used already');
        q('INSERT INTO phone_cards (id, user_id, bot_id, kind, boxes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(body.id, userId, me.id, body.kind, JSON.stringify(Object.fromEntries(boxes)), t, t + ttl);
        return { id: body.id, expires_at: t + ttl, devices: boxes.map(([id]) => mine.get(id)) };
      });
      log(me.id, 'phone_card', { kind: body.kind, devices: made.devices.length });
      const rung = made.devices.filter((d) => d.push_endpoint);
      for (const d of rung) void ring(d);
      return { id: made.id, expires_at: made.expires_at, devices: made.devices.length, notified: rung.length };
    },
    // Held open until the owner answers (or a little while passes: the bot asks again).
    'GET /v1/phone/cards/:id': ({ me, params, url, res }) => {
      const read = () => { const c = CARD.test(String(params.id)) && q('SELECT * FROM phone_cards WHERE id = ? AND bot_id = ?').get(params.id, me.id); if (!c) throw new HttpError(404, 'no such card'); return c; };
      const c = read();
      const hold = Math.min(Math.max(Number(url?.searchParams.get('wait')) || 0, 0) * 1000, L.holdMs);
      if (!hold || state(c) !== 'open') return forBot(c);
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true; clearTimeout(timer);
          const set = waiters.get(c.id); set?.delete(finish); if (set && !set.size) waiters.delete(c.id);
          try { resolve(forBot(read())); } catch { resolve({ id: c.id, state: 'closed', expires_at: c.expires_at }); }
        };
        const timer = setTimeout(finish, Math.min(hold, Math.max(0, c.expires_at - clock()) + 50));
        timer.unref?.();
        if (!waiters.has(c.id)) waiters.set(c.id, new Set());
        waiters.get(c.id).add(finish);
        res?.on('close', () => { if (!res.writableEnded) finish(); });
      });
    },
    // The bot stopped waiting (its owner is back at the keyboard, or it gave up): the card leaves the phone.
    'POST /v1/phone/cards/:id/close': ({ me, params }) => {
      const c = CARD.test(String(params.id)) && q('SELECT * FROM phone_cards WHERE id = ? AND bot_id = ?').get(params.id, me.id);
      if (!c) throw new HttpError(404, 'no such card');
      if (!c.answered_at && !c.closed_at) q('UPDATE phone_cards SET closed_at = ? WHERE id = ?').run(clock(), c.id);
      wake(c.id);
      return { id: c.id, state: state(q('SELECT * FROM phone_cards WHERE id = ?').get(c.id)) };
    },
  };

  // ───── what the owner's phone page does (signed in on the dashboard) ─────
  function addDevice(user, f) {
    if (!p256(f.sign) || !p256(f.box) || f.sign === f.box) throw new HttpError(400, 'This browser must supply two P-256 public keys.');
    const name = String(f.name ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) || 'Phone';
    return tx(() => {
      const had = q('SELECT * FROM phone_devices WHERE user_id = ? AND sign_pub = ? AND box_pub = ?').get(user.id, f.sign, f.box);
      if (had) return { id: had.id, code: had.code, name: had.name };
      if (devicesOf(user.id).length >= L.devices) throw new HttpError(429, `You can set up ${L.devices} phones. Remove one first.`);
      const d = { id: token('dev_', 12), code: phoneCode(f.sign, f.box) };
      q('INSERT INTO phone_devices (id, user_id, name, sign_pub, box_pub, code, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(d.id, user.id, name, f.sign, f.box, d.code, clock(), clock());
      return { id: d.id, code: d.code, name };
    });
  }
  function removeDevice(user, id) {
    const d = deviceOf(user.id, id);
    q('DELETE FROM phone_devices WHERE id = ?').run(d.id);
    return { removed: true };
  }
  function setPush(user, id, endpoint) {
    const d = deviceOf(user.id, id);
    if (!endpoint) { q('UPDATE phone_devices SET push_endpoint = NULL WHERE id = ?').run(d.id); return { push: false }; }
    if (!pushTarget(endpoint)) throw new HttpError(400, 'That is not a browser push address.');
    q('UPDATE phone_devices SET push_endpoint = ? WHERE id = ?').run(String(endpoint), d.id);
    return { push: true };
  }
  // What the page shows: this account's phones, and the cards waiting (as ciphertext for the phone that asks).
  function view(user, deviceId) {
    const t = clock();
    const device = deviceId ? q('SELECT * FROM phone_devices WHERE id = ? AND user_id = ?').get(String(deviceId), user.id) : null;
    if (device) q('UPDATE phone_devices SET seen_at = ? WHERE id = ?').run(t, device.id);
    const cards = q(`SELECT c.*, b.handle FROM phone_cards c JOIN bots b ON b.id = c.bot_id WHERE c.user_id = ? AND c.closed_at IS NULL
      AND ((c.answered_at IS NULL AND c.expires_at > ?) OR c.answered_at > ?) ORDER BY c.created_at DESC LIMIT 40`).all(user.id, t, t - 10 * 60_000);
    return {
      now: t, known: !!device,
      devices: devicesOf(user.id).map((d) => ({ id: d.id, name: d.name, code: d.code, created_at: d.created_at, push: !!d.push_endpoint, linked: JSON.parse(d.linked || '[]') })),
      cards: cards.map((c) => ({ id: c.id, kind: c.kind, bot: `@${c.handle}`, created_at: c.created_at, expires_at: c.expires_at,
        box: device ? JSON.parse(c.boxes)[device.id] ?? null : null,
        ...(c.answered_at ? { answered: { decision: JSON.parse(c.answer).decision, at: c.answered_at, here: JSON.parse(c.answer).device === device?.id } } : {}) })),
    };
  }
  // The answer is stored as the phone signed it. The relay can't check the signature's meaning (the request it is
  // bound to is inside the card it can't read); the bot does, against the keys it pinned.
  function answer(user, id, f) {
    const out = tx(() => {
      const c = typeof id === 'string' && CARD.test(id) && q('SELECT * FROM phone_cards WHERE id = ? AND user_id = ?').get(id, user.id);
      if (!c) throw new HttpError(404, 'This request is gone.');
      const d = deviceOf(user.id, f.device);
      if (state(c) !== 'open') throw new HttpError(409, state(c) === 'answered' ? 'This was answered already.' : 'This request ended before you answered.');
      if (!JSON.parse(c.boxes)[d.id]) throw new HttpError(403, 'This request was not sent to this phone.');
      if (c.kind === 'info') throw new HttpError(400, 'This one can only be answered at the keyboard.');
      if (!DECISIONS.includes(f.decision) || !bytes(f.sig, 64, 64)) throw new HttpError(400, 'Expected a signed answer.');
      const reply = f.decision === 'reply';
      if (reply && (!bytes(f.reply_iv, 12, 12) || !bytes(f.reply_ct, 17, L.replyBytes + 16))) throw new HttpError(400, 'Expected a bounded encrypted reply.');
      const a = { device: d.id, decision: f.decision, sig: f.sig, ...(reply ? { reply: { iv: f.reply_iv, ct: f.reply_ct } } : {}) };
      q('UPDATE phone_cards SET answer = ?, answered_at = ? WHERE id = ?').run(JSON.stringify(a), clock(), c.id);
      return { id: c.id, bot: c.bot_id, decision: f.decision };
    });
    log(out.bot, 'phone_answer', { decision: out.decision });
    wake(out.id);
    return { answered: true };
  }
  const forget = (userId, botIds = []) => {
    q('DELETE FROM phone_devices WHERE user_id = ?').run(userId);
    q(`DELETE FROM phone_cards WHERE user_id = ?${botIds.length ? ` OR bot_id IN (${botIds.map(() => '?').join(',')})` : ''}`).run(userId, ...botIds);
  };
  return { routes, sweep, vapid: () => vapid().publicKey, addDevice, removeDevice, setPush, view, answer, forget,
    page: (opts) => phonePage({ ...opts, vapid: vapid().publicKey }), sw: PHONE_SW, manifest: phoneManifest };
}
