// b2b relay: stores messages between paired bots and wakes the recipient's bot
// through its webhook routine (the "doorbell"). Zero dependencies (node:sqlite).
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv, createPublicKey } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, migrateApp } from './app.mjs';
import { createConnector, migrateConnector } from './connector.mjs';
import { messageEmail } from './email.mjs';
import { migrateGovernance, createGovernance } from './governance.mjs';
import { migrateEvents, createEvents } from './events.mjs';
import { createSafePost, checkCallbackUrl } from './doorbells.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export const LIMITS = {
  textMax: 4000,
  linksMax: 5,
  linkMax: 2000,
  sendPerHour: 60,
  sendPerContactPer10Min: 12,
  leaseMs: 10 * 60_000,
  ringFloorMs: 20_000,          // coalesce rings to one per bot per 20 s
  urgentFloorMs: 5_000,
  backoffMs: [0, 30_000, 120_000, 300_000, 900_000, 3_600_000, 3_600_000, 3_600_000],
  codeTtlMs: 24 * 3_600_000,
  joinTtlMs: 15 * 60_000,        // a bot's "approve me" link (private mode setup without a code)
  joinsOpenMax: 500,             // open join links across the whole relay
  inviteTtlMs: 7 * 24 * 3_600_000,
  probeTtlMs: 10 * 60_000,
  wakesPerDay: 60,             // per recipient bot; protects the owner's GrokBot usage
  dedupWindowMs: 10 * 60_000,  // identical sends within this window are treated as retries
  acceptFailuresPerHour: 10,
  notAnsweringAfterRings: 4,
  refusedRetryMs: 60_000,
  bodyRetentionMs: 7 * 24 * 3_600_000,     // message text is deleted 7 days after delivery
  undeliveredExpiryMs: 7 * 24 * 3_600_000, // undelivered messages expire after 7 days
  metadataRetentionMs: 90 * 24 * 3_600_000, // event log kept 90 days
  pausedRecheckMs: 60_000,
  loginEmailsPerHour: 200,        // across the whole relay
  loginEmailsPerIpPerHour: 10,
  oauthRegisterPerIpPerHour: 20,
  oauthRegisterPerHour: 500,
  choicesMax: 6,
  choiceMax: 40,
  webNotifyEveryMs: 15 * 60_000, // at most one "you have a message" email per person per 15 min
  sealedMax: 48_000,             // an end-to-end encrypted message, as the relay sees it
  removedGraceMs: 3_600_000,     // a removed bot can be brought back for an hour, then it's gone
};

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const token = (prefix, n = 24) => `${prefix}${randomBytes(n).toString('base64url')}`;
const humanCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
};
const now = () => Date.now();
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
// The b2b tool says its version on every call (x-b2b-version) since 0.19.0. Tools from before don't say it,
// so they count as 0.18.0 at most; a stored '' means "an older tool that didn't say".
export const TOOL_VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
export const SILENT_TOOL = '0.18.0';
export const newerVersion = (a, b) => {
  const [x, y] = [a, b].map((v) => String(v).split('.').map((n) => Number(n) || 0));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

// Quiet hours: nobody is woken or emailed at night in their own timezone. Returns when it ends, or null.
export function localMinutes(tz, t) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t));
  return Number(parts.find((p) => p.type === 'hour').value) * 60 + Number(parts.find((p) => p.type === 'minute').value);
}
export function quietUntil(user, t) {
  // Without a known timezone we can't tell when night is, so nothing is held.
  if (!user?.quiet_on || !user.tz) return null;
  const s = user.quiet_start, e = user.quiet_end;
  if (s == null || e == null || s === e) return null;
  let now;
  try { now = localMinutes(user.tz, t); } catch { now = localMinutes('UTC', t); }
  const inside = s < e ? now >= s && now < e : now >= s || now < e;
  if (!inside) return null;
  return t + ((e - now + 1440) % 1440) * 60_000;
}
const ALIAS_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u;
// What an owner tells their bot about someone while inviting or accepting them (saved as that contact's notes).
function inviteNotes(v) {
  if (v == null) return null;
  if (typeof v !== 'string') throw new HttpError(400, 'notes must be text');
  const t = v.normalize('NFC').trim();
  if (t.length > 280) throw new HttpError(400, 'notes can be up to 280 characters');
  return t || null;
}
// End-to-end encryption: the relay stores each bot's two public keys and carries sealed messages it can't open.
const SEALED_RE = /^b2b1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/;
const TAG_RE = /^[A-Za-z0-9_-]{16,64}$/;
// Topics for "ask their bot": short words like "availability" or "wishlist".
const TOPIC_RE = /^[\p{L}\p{N}][\p{L}\p{N} '&-]{0,39}$/u;
const TOPICS_MAX = 10;
function validKeys(k) {
  if (k === undefined || k === null) return null;
  const ok = (x, type) => {
    if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(x)) return false;
    try { createPublicKey({ key: { kty: 'OKP', crv: type, x }, format: 'jwk' }); return true; } catch { return false; }
  };
  if (!ok(k.sign, 'Ed25519') || !ok(k.box, 'X25519')) throw new HttpError(400, 'keys must be {sign: Ed25519, box: X25519} public keys (base64url)');
  return { sign: k.sign, box: k.box };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS bots (
      id INTEGER PRIMARY KEY,
      handle TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      token_hash TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      webhook_url TEXT, webhook_key TEXT,
      doorbell_verified_at INTEGER,
      last_ring_at INTEGER, last_ring_status INTEGER,
      last_claim_at INTEGER,
      wake_day TEXT, wake_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS enroll_codes (
      code_hash TEXT PRIMARY KEY, handle TEXT NOT NULL, display_name TEXT NOT NULL,
      expires_at INTEGER NOT NULL, used_at INTEGER, reissue INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS invites (
      code_hash TEXT PRIMARY KEY, from_bot INTEGER NOT NULL REFERENCES bots(id),
      alias TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, used_by INTEGER
    );
    CREATE TABLE IF NOT EXISTS contacts (
      owner_bot INTEGER NOT NULL REFERENCES bots(id), peer_bot INTEGER NOT NULL REFERENCES bots(id),
      alias TEXT NOT NULL, created_at INTEGER NOT NULL, blocked INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_bot, peer_bot), UNIQUE (owner_bot, alias)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_bot INTEGER NOT NULL REFERENCES bots(id), to_bot INTEGER NOT NULL REFERENCES bots(id),
      kind TEXT NOT NULL, text TEXT NOT NULL, links TEXT NOT NULL DEFAULT '[]',
      reply_to TEXT, urgent INTEGER NOT NULL DEFAULT 0, client_id TEXT,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL,           -- pending | claimed | delivered | dropped
      lease_until INTEGER, lease_token TEXT, claim_count INTEGER NOT NULL DEFAULT 0,
      first_claimed_at INTEGER, delivered_at INTEGER, note TEXT,
      ring_count INTEGER NOT NULL DEFAULT 0, next_ring_at INTEGER, first_rung_at INTEGER,
      replied_at INTEGER,
      UNIQUE (from_bot, client_id)
    );
    CREATE INDEX IF NOT EXISTS messages_inbox ON messages (to_bot, status, created_at);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, bot INTEGER, kind TEXT NOT NULL, detail TEXT
    );
    -- Private mode setup without a code (0.14): the bot makes its keys and asks to join; its owner opens
    -- the link, signs in and says yes; the bot collects its token once. No token is stored here.
    CREATE TABLE IF NOT EXISTS join_requests (
      code_hash TEXT PRIMARY KEY, poll_hash TEXT UNIQUE NOT NULL, sign_pub TEXT NOT NULL, box_pub TEXT NOT NULL, name TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, approved_bot INTEGER, approved_at INTEGER, denied_at INTEGER, collected_at INTEGER
    );
  `);
  // Additive migrations for databases created by older versions.
  const addColumn = (table, col, def) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addColumn('bots', 'wake_day', 'TEXT');
  addColumn('bots', 'wake_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('enroll_codes', 'reissue', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('messages', 'lease_token', 'TEXT');
  addColumn('bots', 'doorbell_gen', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('messages', 'probe_gen', 'INTEGER');
  addColumn('contacts', 'privacy_on', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('contacts', 'gen', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('bots', 'tool_version', 'TEXT');
  addColumn('bots', 'removed_at', 'INTEGER');
  return db;
}

export function createRelay({ mailer = async () => {}, devLogin = false, adminEnroll = false, banner = '', hosted = false, billing = {}, trustProxy = false, productName = 'bot2bot', setupBotUrl = 'https://x.ai/bot/d_op9BSVjlxk2eYrCmAVL', webInbox = false, privacyPilot = false, siteDir = '', stickersDir, redirectHosts = [], keySecret, limits = {}, cliDir = join(here, 'cli'), minTool = '0.10.0', dbPath = ':memory:', adminToken, publicUrl = '', webhookHosts = ['api2.cursor.sh'], allowLocalWebhooks = false, fetchImpl = fetch, clock = now } = {}) {
  if (!adminToken || adminToken.length < 16) throw new Error('ADMIN_TOKEN (16+ chars) is required');
  const L = { ...LIMITS, ...limits };
  // What an owner sends a friend: get a bot first (the setup bot does it all), then open the invite.
  const inviteMessage = (link) => `Let's connect our AI bots on ${productName}, so they can message each other for us.
1. Add the setup bot to your Grok Bot: ${setupBotUrl} (it walks you through it in a few minutes).
2. Then open my invite: ${link}`;
  // Webhook keys are encrypted at rest when a separate secret is configured.
  const encKey = keySecret ? createHash('sha256').update(keySecret).digest() : null;
  const sealKey = (plain) => {
    if (!encKey) return plain;
    const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', encKey, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return `enc:v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
  };
  const openKey = (stored) => {
    if (!stored?.startsWith('enc:v1:')) return stored;
    if (!encKey) throw new Error('webhook key is encrypted but no key secret is configured');
    const [, , iv, tag, ct] = stored.split(':');
    const d = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url')); d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  };
  const today = () => new Date(clock()).toISOString().slice(0, 10);
  // Hosted tier: everyone gets a number of free sent messages a month; a yearly payment (which covers a
  // household) removes the limit. Receiving is never limited, and web inboxes are always free.
  // Self-hosted relays have no plans at all.
  const B = { priceLabel: '€24 a year', freeMessages: 50, freePeriod: 'day', householdSize: 6, ...billing };
  if (!Number.isInteger(B.freeMessages) || B.freeMessages < 0) throw new Error('FREE_MESSAGES must be a whole number (0 or more)');
  if (!['day', 'month'].includes(B.freePeriod)) throw new Error('FREE_PERIOD must be day or month');
  // Words for the period, used everywhere the allowance is shown.
  B.periodWord = B.freePeriod === 'day' ? 'today' : 'this month';
  B.perWord = B.freePeriod === 'day' ? 'a day' : 'a month';
  function coverage(user, t = clock()) {
    if (!hosted) return { state: 'self_hosted' };
    if (user?.paid_until > t) return { state: 'paid', until: user.paid_until };
    const payer = user && q(`SELECT u.* FROM household_members h JOIN users u ON u.id = h.payer_user_id WHERE h.email = ? AND u.paid_until > ? ORDER BY u.paid_until DESC`).get(user.email, t);
    if (payer) return { state: 'covered', until: payer.paid_until, payer: payer.name };
    return { state: 'free' };
  }
  // Free messages count what a person's bots send this UTC day (or calendar month). Web inbox replies don't count.
  function allowance(user, bot = null, t = clock()) {
    const c = coverage(user, t);
    if (c.state !== 'free') return { ...c, limited: false };
    const d = new Date(t);
    const daily = B.freePeriod === 'day';
    const start = daily ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) : Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const resets = daily ? start + 86_400_000 : Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const used = user
      ? q("SELECT count(*) AS n FROM messages m JOIN bots b ON b.id = m.from_bot WHERE b.user_id = ? AND m.via = 'bot' AND m.kind != 'probe' AND m.created_at >= ?").get(user.id, start).n
      : q("SELECT count(*) AS n FROM messages WHERE from_bot = ? AND via = 'bot' AND kind != 'probe' AND created_at >= ?").get(bot?.id ?? 0, start).n;
    return { ...c, limited: true, limit: B.freeMessages, used, left: Math.max(0, B.freeMessages - used), resets };
  }
  const db = openDb(dbPath);
  migrateApp(db);
  migrateConnector(db);
  migrateGovernance(db);
  migrateEvents(db);
  const q = (sql) => db.prepare(sql);
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  // The one place that erases message content. Waiting messages become "not delivered".
  // Every content column is listed here so a new one can't be forgotten in some other path.
  const erase = (where, ...params) => q(`UPDATE messages SET status = CASE WHEN status IN ('pending', 'claimed') THEN 'dropped' ELSE status END,
      next_ring_at = NULL, lease_until = NULL, text = '', links = '[]', choices = NULL, sealed = NULL, content_tag = NULL, topic = NULL, note = NULL, body_purged_at = coalesce(body_purged_at, ?)
      WHERE ${where}`).run(clock(), ...params);
  // Blocking or removing someone drops whatever is still waiting, in both directions.
  const dropBetween = (a, b) => erase(`status IN ('pending', 'claimed') AND ((from_bot = ? AND to_bot = ?) OR (from_bot = ? AND to_bot = ?))`, a, b, b, a);
  const bumpGen = (botId) => q('UPDATE contacts SET gen = max(gen + 1, ?) WHERE owner_bot = ? OR peer_bot = ?').run(clock(), botId, botId);
  const bumpPair = (a, b) => q('UPDATE contacts SET gen = max(gen + 1, ?) WHERE (owner_bot = ? AND peer_bot = ?) OR (owner_bot = ? AND peer_bot = ?)').run(clock(), a, b, b, a);
  // Internal owner control. The dashboard authenticates the owner before calling this.
  const setPrivacyInTx = (ownerBot, peerBot, on) => {
    if (!db.isTransaction) throw new Error('setPrivacyInTx requires a transaction');
    if (on && !governance.inPilot(ownerBot)) throw new HttpError(404, 'Page not found');
    const c = contact(ownerBot, peerBot);
    if (!c) throw new HttpError(404, 'contact not found');
    if (!!c.privacy_on === !!on && (!governance.inPilot(ownerBot) || governance.effectiveMode(c) === (on ? 'asks' : 'handles'))) return;
    q('UPDATE contacts SET privacy_on = ? WHERE owner_bot = ? AND peer_bot = ?').run(on ? 1 : 0, ownerBot, peerBot);
    if (governance.inPilot(ownerBot)) q('UPDATE contacts SET mode_override = ? WHERE owner_bot = ? AND peer_bot = ?').run(on ? 'asks' : 'handles', ownerBot, peerBot);
    bumpPair(ownerBot, peerBot);
  };
  const setPrivacy = (ownerBot, peerBot, on) => tx(() => setPrivacyInTx(ownerBot, peerBot, on));
  const VIA = new Set(['doorbell', 'manual', 'schedule']);
  const log = (bot, kind, detail = {}) => q('INSERT INTO events (ts, bot, kind, detail) VALUES (?, ?, ?, ?)').run(clock(), bot ?? null, kind, JSON.stringify(detail));

  // New keys make old safety-code checks meaningless, and anything still waiting was sealed to the old key.
  function setKeys(bot, keys) {
    const changed = (keys?.sign ?? null) !== (bot.sign_pub ?? null) || (keys?.box ?? null) !== (bot.box_pub ?? null);
    if (!changed) return false;
    q('UPDATE bots SET sign_pub = ?, box_pub = ?, keys_at = ? WHERE id = ?').run(keys?.sign ?? null, keys?.box ?? null, clock(), bot.id);
    q('UPDATE contacts SET codes_compared_at = NULL WHERE owner_bot = ? OR peer_bot = ?').run(bot.id, bot.id);
    bumpGen(bot.id);
    erase(`to_bot = ? AND status IN ('pending', 'claimed') AND sealed IS NOT NULL`, bot.id);
    log(bot.id, 'keys_set', { first: !bot.box_pub });
    return true;
  }
  const botByToken = (raw) => (raw ? q('SELECT * FROM bots WHERE token_hash = ?').get(sha(raw)) : undefined);
  const contact = (owner, peer) => q('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(owner, peer);

  function resolveRecipient(me, to) {
    if (typeof to !== 'string' || !to.trim()) throw new HttpError(400, 'to is required (a contact alias or @handle)');
    const name = to.trim();
    let row;
    if (name.startsWith('@')) {
      row = q('SELECT c.*, b.handle FROM contacts c JOIN bots b ON b.id = c.peer_bot WHERE c.owner_bot = ? AND b.handle = ?').get(me.id, name.slice(1).toLowerCase());
    } else {
      row = q('SELECT c.*, b.handle FROM contacts c JOIN bots b ON b.id = c.peer_bot WHERE c.owner_bot = ? AND lower(c.alias) = lower(?)').get(me.id, name);
    }
    if (!row) throw new HttpError(404, `no contact called "${name}". Run "b2b contacts" to see contacts, or pair first with an invite code.`);
    const back = contact(row.peer_bot, me.id);
    const peerBot = q('SELECT disconnected_at FROM bots WHERE id = ?').get(row.peer_bot);
    if (!back || back.blocked || row.blocked || peerBot?.disconnected_at) throw new HttpError(403, 'this contact is not reachable');
    if (!row.approved_at) throw new HttpError(403, `your owner hasn't approved "${row.alias}" as a contact yet. Ask them to approve it on their dashboard: ${publicUrl}/app`);
    if (!back.approved_at) throw new HttpError(403, `"${row.alias}" hasn't approved you as a contact yet. Their owner has to approve it on their dashboard first.`);
    return row;
  }

  function validWebhook(url) {
    let u;
    try { u = new URL(url); } catch { throw new HttpError(400, 'webhook url is not a valid URL'); }
    const host = u.hostname.toLowerCase();
    const local = allowLocalWebhooks && (host === '127.0.0.1' || host === 'localhost');
    if (u.username || u.password || u.hash) throw new HttpError(400, 'webhook url must not contain credentials or a fragment');
    if (!local && (u.protocol !== 'https:' || !webhookHosts.includes(host))) {
      throw new HttpError(400, `webhook host must be one of: ${webhookHosts.join(', ')} (https)`);
    }
    if (!local && !u.pathname.startsWith('/automations/webhook/')) throw new HttpError(400, 'webhook url must be a GrokBot routine webhook (…/automations/webhook/<id>)');
    return u.toString();
  }

  // A Grok routine webhook, or an OpenClaw gateway's /hooks/wake on any public HTTPS host.
  function doorbellTarget(raw, kind) {
    let u = null; try { u = new URL(raw); } catch { /* validWebhook explains */ }
    if (kind === 'hook' || (u && /\/hooks\/wake$/.test(u.pathname) && !webhookHosts.includes(u.hostname.toLowerCase()))) return { url: validHook(raw), kind: 'hook' };
    return { url: validWebhook(raw), kind: 'grok_webhook' };
  }
  function validHook(url) {
    let u;
    try { u = checkCallbackUrl(url, { allowLocal: allowLocalWebhooks }); } catch (e) { throw new HttpError(400, `webhook url: ${e.message}`); }
    if (!/\/hooks\/wake$/.test(u.pathname)) throw new HttpError(400, 'an OpenClaw doorbell is the gateway\'s /hooks/wake address (https://…/hooks/wake)');
    return u.toString();
  }

  // ───── doorbell ─────
  // Outside addresses (ChatGPT callbacks, OpenClaw gateways) only through safePost: public HTTPS, no redirects.
  const safePost = createSafePost({ allowLocal: allowLocalWebhooks });
  const events = createEvents({ q, tx, clock, sealKey, openKey, safePost, log, allowLocal: allowLocalWebhooks });
  const inflight = new Set();
  async function ring(bot, reason, { floorMs = L.urgentFloorMs } = {}) {
    if (!bot.webhook_url || bot.disconnected_at || inflight.has(bot.id)) return { skipped: true };
    if (bot.paused_at && reason !== 'test') return { skipped: 'paused by owner' };
    const t0 = clock();
    if (bot.last_ring_at && t0 - bot.last_ring_at < floorMs) return { skipped: 'cooldown' };
    if (bot.wake_day === today() && bot.wake_count >= L.wakesPerDay) {
      log(bot.id, 'wake_budget_exhausted', { limit: L.wakesPerDay, reason });
      return { skipped: 'wake budget for today is used up' };
    }
    inflight.add(bot.id);
    const pending = q("SELECT count(*) AS n FROM messages WHERE to_bot = ? AND status = 'pending'").get(bot.id).n;
    const urgent = q("SELECT count(*) AS n FROM messages WHERE to_bot = ? AND status = 'pending' AND urgent = 1").get(bot.id).n > 0;
    const ringId = token('ring_', 6);
    const started = clock();
    const day = today();
    q('UPDATE bots SET last_ring_at = ?, wake_count = CASE WHEN wake_day = ? THEN wake_count + 1 ELSE 1 END, wake_day = ? WHERE id = ?').run(started, day, day, bot.id);
    try {
      // Never put message content in the ring: the bot pulls it with its own token.
      const res = bot.doorbell_kind === 'mcp_events' ? await events.deliver(bot, { pending, urgent })
        : bot.doorbell_kind === 'hook' ? await safePost(bot.webhook_url, { event: 'b2b_pending', pending, urgent, ring_id: ringId, reason, mode: 'now',
          text: 'bot2bot: messages from a friend\'s bot may be waiting. Check your bot2bot inbox and tell your owner who they are from and what they say.' }, { authorization: `Bearer ${openKey(bot.webhook_key)}` })
        : await fetchImpl(bot.webhook_url, {
          method: 'POST',
          headers: { authorization: `Bearer ${openKey(bot.webhook_key)}`, 'content-type': 'application/json' },
          body: JSON.stringify({ event: 'b2b_pending', pending, urgent, ring_id: ringId, reason }),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
      if (typeof res.body?.cancel === 'function') try { await res.body.cancel(); } catch { /* ignore */ }
      q('UPDATE bots SET last_ring_status = ? WHERE id = ?').run(res.status, bot.id);
      // A refused ring (4xx: paused routine, bad key) didn't wake anyone: don't charge it to the wake budget.
      // A 5xx is ambiguous (the run may have started), so it stays charged.
      if (res.status >= 400 && res.status < 500) {
        q('UPDATE bots SET wake_count = max(wake_count - 1, 0) WHERE id = ? AND wake_day = ?').run(bot.id, day);
        // A refused ring (e.g. paused routine) costs nothing, so retry every minute for the first hour
        // instead of waiting for the backoff schedule; the message arrives soon after the owner resumes.
        if (reason === 'pending') q(`UPDATE messages SET ring_count = max(ring_count - 1, 0), next_ring_at = ?
                                     WHERE to_bot = ? AND status = 'pending' AND created_at > ?`).run(clock() + L.refusedRetryMs, bot.id, clock() - 3_600_000);
      }
      log(bot.id, 'ring', { reason, pending, status: res.status, ms: clock() - started, ring_id: ringId });
      return { status: res.status };
    } catch (e) {
      // Only refund when the request certainly never reached the routine; timeouts and resets may have woken it.
      const code = e?.cause?.code || e?.code;
      const neverArrived = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_INVALID_URL', 'never_arrived', 'blocked', 'bad_url'].includes(code);
      q(`UPDATE bots SET last_ring_status = 0${neverArrived ? ', wake_count = max(wake_count - 1, 0)' : ''} WHERE id = ?`).run(bot.id);
      log(bot.id, 'ring_failed', { reason, pending, error: String(e?.name || 'error') });
      return { error: 'webhook request failed' };
    } finally {
      inflight.delete(bot.id);
    }
  }

  // One scheduler pass: release expired leases, then ring every bot with due messages.
  async function tick() {
    const t = clock();
    governance.expire(t);
    retention(t);
    const expired = q("SELECT id, to_bot FROM messages WHERE status = 'claimed' AND lease_until <= ?").all(t);
    for (const m of expired) {
      q("UPDATE messages SET status = 'pending', lease_until = NULL, next_ring_at = ? WHERE id = ? AND status = 'claimed'").run(t, m.id);
      log(m.to_bot, 'lease_expired', { message: m.id });
    }
    const due = q(`SELECT to_bot, max(urgent) AS urgent FROM messages
                   WHERE status = 'pending' AND next_ring_at IS NOT NULL AND next_ring_at <= ? GROUP BY to_bot`).all(t);
    const results = [];
    for (const d of due) {
      const bot = q('SELECT * FROM bots WHERE id = ?').get(d.to_bot);
      if (!bot) continue;
      if (bot.disconnected_at) { erase(`to_bot = ? AND status IN ('pending', 'claimed')`, bot.id); continue; }
      if (bot.paused_at) {
        // Owner paused everything: hold the messages, check again later, never ring.
        q("UPDATE messages SET next_ring_at = ? WHERE to_bot = ? AND status = 'pending' AND next_ring_at <= ?").run(t + L.pausedRecheckMs, bot.id, t);
        continue;
      }
      const quiet = bot.user_id ? quietUntil(q('SELECT * FROM users WHERE id = ?').get(bot.user_id), t) : null;
      if (quiet) {
        // Night for the owner: hold everything until their quiet hours end. Urgent doesn't override.
        q("UPDATE messages SET next_ring_at = ? WHERE to_bot = ? AND status = 'pending' AND next_ring_at <= ?").run(quiet, bot.id, t);
        continue;
      }
      if (bot.vendor === 'web') { results.push(notifyWeb(bot, t)); continue; }
      if (!bot.webhook_url) continue;
      const floor = d.urgent ? L.urgentFloorMs : L.ringFloorMs;
      if (bot.last_ring_at && t - bot.last_ring_at < floor) continue;
      if (bot.wake_day === today() && bot.wake_count >= L.wakesPerDay) {
        // Budget spent: messages stay queued; the bot sees them the next time it runs for any reason.
        q("UPDATE messages SET next_ring_at = ? WHERE to_bot = ? AND status = 'pending' AND next_ring_at <= ?").run(t + 3_600_000, bot.id, t);
        log(bot.id, 'wake_budget_exhausted', { limit: L.wakesPerDay });
        continue;
      }
      // Schedule the next ring for every due message before ringing (one ring covers all).
      const msgs = q("SELECT id, ring_count FROM messages WHERE to_bot = ? AND status = 'pending' AND next_ring_at <= ?").all(bot.id, t);
      for (const m of msgs) {
        const n = m.ring_count + 1;
        const next = n < L.backoffMs.length ? t + L.backoffMs[n] : null; // null = give up ringing
        q('UPDATE messages SET ring_count = ?, next_ring_at = ?, first_rung_at = coalesce(first_rung_at, ?) WHERE id = ?').run(n, next, t, m.id);
        if (next === null) log(bot.id, 'ring_gave_up', { message: m.id });
      }
      results.push(ring(bot, 'pending', { floorMs: floor }));
    }
    return Promise.all(results);
  }

  // People without a bot get a short email (never the message itself) and read it in their web inbox.
  async function notifyWeb(bot, t) {
    if (bot.disconnected_at || inflight.has(bot.id)) return;
    const due = q(`SELECT m.id, fb.display_name, u.name FROM messages m JOIN bots fb ON fb.id = m.from_bot LEFT JOIN users u ON u.id = fb.user_id
                   WHERE m.to_bot = ? AND m.status = 'pending' AND m.next_ring_at <= ? AND m.created_at > ?`).all(bot.id, t, t - L.undeliveredExpiryMs);
    if (!due.length) return;
    const owner = bot.user_id && q('SELECT * FROM users WHERE id = ?').get(bot.user_id);
    const setDue = (when) => q("UPDATE messages SET next_ring_at = ? WHERE to_bot = ? AND status = 'pending' AND next_ring_at <= ?").run(when, bot.id, t);
    if (!owner?.email_verified_at) { setDue(null); return; }
    // Throttled: try again when the 15-minute window ends; everything waiting goes in that one email.
    if (owner.last_notified_at && t - owner.last_notified_at < L.webNotifyEveryMs) { setDue(owner.last_notified_at + L.webNotifyEveryMs); return; }
    const names = [...new Set(due.map((m) => m.name || m.display_name))];
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
    inflight.add(bot.id);
    try {
      await mailer({ to: owner.email, ...messageEmail({ product: productName, who, inboxUrl: `${publicUrl}/app/inbox`, home: publicUrl, logo: siteDir ? `${publicUrl}/icon-192.png` : '' }) });
      q('UPDATE users SET last_notified_at = ? WHERE id = ?').run(t, owner.id);
      q("UPDATE messages SET next_ring_at = NULL, first_rung_at = coalesce(first_rung_at, ?), ring_count = ring_count + 1 WHERE to_bot = ? AND status = 'pending' AND next_ring_at <= ?").run(t, bot.id, t);
      log(bot.id, 'web_notified', { messages: due.length });
    } catch {
      // Email failed: retry with backoff, give up after a few tries (the message still waits in the inbox).
      const tries = q("SELECT max(ring_count) AS n FROM messages WHERE to_bot = ? AND status = 'pending' AND next_ring_at <= ?").get(bot.id, t).n + 1;
      q("UPDATE messages SET ring_count = ?, next_ring_at = ? WHERE to_bot = ? AND status = 'pending' AND next_ring_at <= ?")
        .run(tries, tries < 5 ? t + 60_000 * 5 ** (tries - 1) : null, bot.id, t);
      log(bot.id, 'web_notify_failed', { tries });
    } finally { inflight.delete(bot.id); }
  }

  // Privacy: delete message text a week after delivery, expire undelivered mail, trim old logs.
  let lastRetention = 0;
  function retention(t) {
    if (t - lastRetention < 10 * 60_000) return;
    lastRetention = t;
    governance.retention(t);
    events.retention(t);
    const expired = q(`UPDATE messages SET status = 'dropped', next_ring_at = NULL, lease_until = NULL, note = coalesce(note, 'expired')
                       WHERE status IN ('pending', 'claimed') AND kind != 'probe' AND created_at < ?`).run(t - L.undeliveredExpiryMs);
    if (expired.changes) log(null, 'expired', { count: Number(expired.changes) });
    q("DELETE FROM messages WHERE kind = 'probe' AND created_at < ?").run(t - L.probeTtlMs);
    erase(`body_purged_at IS NULL AND (status = 'dropped' OR (status = 'delivered' AND delivered_at < ?))`, t - L.bodyRetentionMs);
    q('DELETE FROM events WHERE ts < ?').run(t - L.metadataRetentionMs);
    q('DELETE FROM sessions WHERE expires_at < ?').run(t);
    q('DELETE FROM login_codes WHERE expires_at < ?').run(t - 86_400_000);
    q('DELETE FROM join_requests WHERE expires_at < ?').run(t - 86_400_000);
    q('DELETE FROM oauth_clients WHERE created_at < ? AND client_id NOT IN (SELECT client_id FROM oauth_tokens) AND client_id NOT IN (SELECT client_id FROM oauth_codes WHERE used_at IS NULL)').run(t - 7 * 86_400_000);
    // A bot its owner removed an hour ago leaves for good: off its friends' contact lists, and its name is free again.
    for (const b of q("SELECT id, handle FROM bots WHERE removed_at IS NOT NULL AND removed_at < ? AND instr(handle, '~') = 0").all(t - L.removedGraceMs)) {
      tx(() => {
        for (const c of q('SELECT peer_bot FROM contacts WHERE owner_bot = ?').all(b.id)) { bumpPair(b.id, c.peer_bot); dropBetween(b.id, c.peer_bot); }
        governance.deleteDataInTx([b.id]);
        q('DELETE FROM contacts WHERE owner_bot = ? OR peer_bot = ?').run(b.id, b.id);
        q('UPDATE bots SET handle = ? WHERE id = ?').run(`${b.handle}~${b.id}`, b.id);
      });
      log(b.id, 'removed_for_good', {});
    }
  }
  // Called after an owner approves, unblocks or resumes, so held messages go out now.
  function release(botId) {
    q("UPDATE messages SET next_ring_at = ? WHERE to_bot = ? AND status = 'pending'").run(clock(), botId);
    setImmediate(() => { void tick(); });
  }

  // ───── route handlers ─────
  // Runs inside the caller's transaction; the caller wakes recipients after commit.
  function enqueue(me, body, ctx = {}) {
    const ownerWeb = ctx?.actor === 'owner_web';
    const pilot = governance.inPilot(me);
    const decision = pilot && ctx?.actor === 'owner_decision' && ctx.decisionId
      ? q("SELECT * FROM privacy_requests WHERE id = ? AND owner_bot = ? AND state = 'PENDING_OWNER' AND expires_at > ?").get(ctx.decisionId, me.id, clock()) : null;
    if (me.paused_at) throw new HttpError(403, `your owner paused ${productName}. Nothing can be sent until they resume it on their dashboard.`);
    const peer = resolveRecipient(me, body.to);
    const recipient = q('SELECT webhook_url, vendor, box_pub FROM bots WHERE id = ?').get(peer.peer_bot);
    const kind = body.kind ?? 'note';
    if (!['note', 'ask', 'reply'].includes(kind)) throw new HttpError(400, 'kind must be note, ask or reply');
    // Between two bots that have keys, only sealed messages are accepted, so nothing readable ever reaches us.
    const sealed = body.sealed ?? null;
    const tag = body.content_tag ?? null;
    let text = '', links = [], choices = [];
    if (sealed !== null) {
      if (ownerWeb || typeof sealed !== 'string' || sealed.length > L.sealedMax || !SEALED_RE.test(sealed)) throw new HttpError(400, 'sealed message is malformed');
      if (tag !== null && (typeof tag !== 'string' || !TAG_RE.test(tag))) throw new HttpError(400, 'content_tag is malformed');
      if (!recipient.box_pub) throw new HttpError(400, "their bot can't read encrypted messages yet; send it as plain text");
      if (!me.box_pub) throw new HttpError(400, 'this bot has no keys, so its sealed messages could never be checked. Run: node ~/bin/b2b.mjs keys');
      if (body.text || (Array.isArray(body.links) && body.links.length) || (Array.isArray(body.choices) && body.choices.length)) throw new HttpError(400, 'send either a sealed message or plain text, not both');
    } else {
      if (!ownerWeb && me.box_pub && recipient.box_pub) throw new HttpError(400, 'messages between bots are end-to-end encrypted and this one was not. Update the tool (node ~/bin/b2b.mjs update), then send again.');
      text = typeof body.text === 'string' ? body.text.trim() : '';
      links = Array.isArray(body.links) ? body.links.map(String) : [];
      if (!text && !links.length) throw new HttpError(400, 'text or links required');
      choices = Array.isArray(body.choices) ? body.choices.map((c) => String(c).trim()).filter(Boolean) : [];
      if (choices.length && kind !== 'ask') throw new HttpError(400, 'choices only go with a question (--ask)');
      if (choices.length > L.choicesMax || choices.some((c) => c.length > L.choiceMax)) throw new HttpError(400, `up to ${L.choicesMax} choices, each under ${L.choiceMax} characters`);
      if (new Set(choices.map((c) => c.toLowerCase())).size !== choices.length) throw new HttpError(400, 'choices must be different from each other');
      if (body.topic != null && (typeof body.topic !== 'string' || !TOPIC_RE.test(body.topic.trim().toLowerCase()) || kind !== 'ask')) throw new HttpError(400, 'a topic is a short word or phrase, and only goes with a question');
      if (text.length > L.textMax) throw new HttpError(413, `text is longer than ${L.textMax} characters`);
      if (links.length > L.linksMax) throw new HttpError(413, `at most ${L.linksMax} links`);
      for (const l of links) {
        let u; try { u = new URL(l); } catch { throw new HttpError(400, `not a valid link: ${l.slice(0, 80)}`); }
        if (!['http:', 'https:'].includes(u.protocol) || l.length > L.linkMax) throw new HttpError(400, 'links must be http(s) URLs under 2000 chars');
      }
    }
    let replyTo = null;
    if (kind === 'reply' || body.reply_to) {
      const orig = q('SELECT * FROM messages WHERE id = ?').get(String(body.reply_to || ''));
      if (!orig || orig.to_bot !== me.id || orig.from_bot !== peer.peer_bot) throw new HttpError(400, 'reply_to must be a message you received from this contact');
      replyTo = orig.id;
    }
    const clientId = body.client_id ? String(body.client_id).slice(0, 64) : null;
    if (!ownerWeb && !decision && clientId?.startsWith('privacy:') && (!pilot || body.approval !== clientId.slice(8))) throw new HttpError(403, 'privacy client_id requires an approval');
    const t = clock();
    const choicesJson = choices.length ? JSON.stringify(choices) : null;
    const answer = (m, to) => ({ id: m.id, status: m.status, duplicate: true, to: `@${to}`, recipient_can_be_woken: true, encrypted: !!m.sealed });
    if (clientId) {
      // Explicit idempotency key: a genuine retry returns the original; reuse for something else is an error.
      // For sealed messages the sender's content tag stands in for the text we can't see.
      const dup = q('SELECT m.*, b.handle FROM messages m JOIN bots b ON b.id = m.to_bot WHERE m.from_bot = ? AND m.client_id = ?').get(me.id, clientId);
      if (dup) {
        const sameContent = sealed !== null
          ? dup.sealed !== null && (dup.sealed === sealed || (tag !== null && dup.content_tag === tag))
          : dup.sealed === null && dup.text === text && dup.links === JSON.stringify(links) && (dup.choices ?? null) === choicesJson;
        if ((clientId.startsWith('privacy:') && !ownerWeb && !decision && dup.privacy_request_id !== body.approval) || dup.to_bot !== peer.peer_bot || !sameContent || dup.kind !== kind || (dup.reply_to ?? null) !== replyTo || !!dup.urgent !== !!body.urgent) {
          throw new HttpError(409, 'client_id was already used for a different message');
        }
        return answer(dup, dup.handle);
      }
    }
    const ownerDecision = decision && decision.peer_bot === peer.peer_bot && decision.contact_gen === peer.gen;
    const approval = pilot && body.approval != null ? governance.checkApproval(me, peer, body.approval, body) : null;
    if (!ownerWeb && !ownerDecision && !approval && (pilot ? governance.effectiveMode(peer) === 'asks' : peer.privacy_on)) {
      throw new HttpError(403, 'owner_approval_required: your owner approves messages to this contact first. For now, pass the matter to your owner.' + (pilot ? ' Use propose_reply.' : ''));
    }
    // For end-to-end pairs the bot seals the owner-approved answer. The relay cannot check
    // that sealed content matches the approved candidate; the approval is single-use and pair-bound.
    if (approval && (!sealed || !me.box_pub || !recipient.box_pub)) throw new HttpError(400, 'approved end-to-end replies must be sealed');
    if (!approval && !ownerDecision && !clientId && !body.again && (sealed === null || tag !== null)) {
      // No key: a bot that retries after a lost response would send the same thing twice: treat as one.
      const same = sealed !== null
        ? q(`SELECT id, status, sealed FROM messages WHERE from_bot = ? AND to_bot = ? AND kind = ? AND content_tag = ? AND coalesce(reply_to, '') = ? AND urgent = ? AND created_at > ?`)
          .get(me.id, peer.peer_bot, kind, tag, replyTo ?? '', body.urgent ? 1 : 0, t - L.dedupWindowMs)
        : q(`SELECT id, status, sealed FROM messages WHERE from_bot = ? AND to_bot = ? AND kind = ? AND sealed IS NULL AND text = ? AND links = ?
              AND coalesce(reply_to, '') = ? AND coalesce(choices, '') = ? AND urgent = ? AND created_at > ?`)
          .get(me.id, peer.peer_bot, kind, text, JSON.stringify(links), replyTo ?? '', choicesJson ?? '', body.urgent ? 1 : 0, t - L.dedupWindowMs);
      if (same) return answer(same, peer.handle);
    }
    if (q('SELECT count(*) AS n FROM messages WHERE from_bot = ? AND created_at > ?').get(me.id, t - 3_600_000).n >= L.sendPerHour) throw new HttpError(429, 'sending too fast (hourly limit)');
    if (q('SELECT count(*) AS n FROM messages WHERE from_bot = ? AND to_bot = ? AND created_at > ?').get(me.id, peer.peer_bot, t - 600_000).n >= L.sendPerContactPer10Min) throw new HttpError(429, 'too many messages to this contact in 10 minutes');
    if (hosted && !ownerWeb && me.vendor !== 'web') {
      const a = allowance(me.user_id && q('SELECT * FROM users WHERE id = ?').get(me.user_id), me, t);
      if (a.limited && a.left <= 0) {
        const when = B.freePeriod === 'day' ? 'at midnight UTC' : `on ${new Date(a.resets).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })}`;
        throw new HttpError(402, `your ${a.limit} free messages for ${B.periodWord} are used up. They come back ${when}. Receiving still works. Your owner can remove the limit (${B.priceLabel}) at ${publicUrl}/app/billing`);
      }
    }
    const id = token('msg_', 9);
    // Plain messages carry their "ask their bot" topic and "answered by the bot" mark in the open; sealed ones inside the seal.
    const topic = sealed === null && body.topic ? body.topic.trim().toLowerCase() : null;
    q(`INSERT INTO messages (id, from_bot, to_bot, kind, text, links, reply_to, urgent, client_id, created_at, status, next_ring_at, choices, via, sealed, content_tag, topic, auto)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`).run(id, me.id, peer.peer_bot, kind, text, JSON.stringify(links), replyTo, body.urgent ? 1 : 0, clientId, t, t,
      choicesJson, ownerWeb ? 'web' : 'bot', sealed, sealed !== null ? tag : null, topic, sealed === null && body.auto && kind === 'reply' ? 1 : 0);
    if (approval) governance.consumeApproval(approval, id);
    if (replyTo) q('UPDATE messages SET replied_at = ? WHERE id = ?').run(t, replyTo);
    log(me.id, 'sent', { message: id, to: peer.handle, kind, encrypted: sealed !== null });
    return { id, status: 'queued', to: `@${peer.handle}`, encrypted: sealed !== null, recipient_can_be_woken: !!recipient.webhook_url, recipient_uses_web_inbox: recipient.vendor === 'web' };
  }

  function visibleReply(messageId, botId) {
    return q(`SELECT r.id, r.text, r.sealed, r.auto, r.created_at FROM messages r
             JOIN bots b ON b.id = r.to_bot
             JOIN contacts c ON c.owner_bot = r.to_bot AND c.peer_bot = r.from_bot
             JOIN contacts back ON back.owner_bot = r.from_bot AND back.peer_bot = r.to_bot
             WHERE r.reply_to = ? AND r.to_bot = ? AND r.status IN ('pending', 'claimed', 'delivered')
               AND coalesce(r.note, '') != 'key_check' AND (r.status = 'delivered' OR r.created_at > ?)
               AND r.body_purged_at IS NULL AND b.paused_at IS NULL AND c.blocked = 0 AND back.blocked = 0
             ORDER BY r.created_at LIMIT 1`).get(messageId, botId, clock() - L.undeliveredExpiryMs);
  }

  const routes = {
    'POST /admin/enroll': ({ body, admin }) => {
      if (!admin) throw new HttpError(401, 'admin token required');
      if (!adminEnroll) throw new HttpError(403, 'admin enrollment is off: owners connect their own bots from the dashboard (set ALLOW_ADMIN_ENROLL=1 on a private self-hosted relay)');
      const handle = String(body.handle || '').toLowerCase();
      if (!HANDLE_RE.test(handle)) throw new HttpError(400, 'handle must be 2-32 chars: a-z 0-9 _ -');
      const display = String(body.display_name || handle).slice(0, 64);
      if (q('SELECT 1 FROM bots WHERE handle = ?').get(handle)) throw new HttpError(409, 'handle already enrolled');
      const code = humanCode();
      q('INSERT OR REPLACE INTO enroll_codes (code_hash, handle, display_name, expires_at) VALUES (?, ?, ?, ?)').run(sha(code), handle, display, clock() + L.codeTtlMs);
      log(null, 'enroll_code', { handle });
      return { code, handle, expires_at: iso(clock() + L.codeTtlMs) };
    },
    'POST /admin/reissue': ({ body, admin }) => {
      if (!admin) throw new HttpError(401, 'admin token required');
      if (!adminEnroll) throw new HttpError(403, 'admin enrollment is off: owners reconnect their bots from the dashboard');
      const bot = q('SELECT * FROM bots WHERE handle = ?').get(String(body.handle || '').toLowerCase());
      if (!bot) throw new HttpError(404, 'no such handle');
      const code = humanCode();
      q('UPDATE enroll_codes SET used_at = ? WHERE handle = ? AND used_at IS NULL').run(clock(), bot.handle);
      q('INSERT OR REPLACE INTO enroll_codes (code_hash, handle, display_name, expires_at, reissue) VALUES (?, ?, ?, ?, 1)').run(sha(code), bot.handle, bot.display_name, clock() + L.codeTtlMs);
      log(bot.id, 'reissue_code', {});
      return { code, handle: bot.handle, expires_at: iso(clock() + L.codeTtlMs), note: 'Enrolling with this code replaces (revokes) the old token.' };
    },
    // Lets the owner register a routine's webhook without the key ever passing through a bot chat.
    'POST /admin/doorbell': async ({ body, admin }) => {
      if (!admin) throw new HttpError(401, 'admin token required');
      const bot = q('SELECT * FROM bots WHERE handle = ?').get(String(body.handle || '').toLowerCase());
      if (!bot) throw new HttpError(404, 'no such handle');
      const { url, kind } = doorbellTarget(String(body.url || ''), body.kind);
      const key = String(body.key || '').trim();
      if (key.length < 8 || key.length > 512 || /[\r\n]/.test(key)) throw new HttpError(400, 'webhook key looks wrong');
      q("DELETE FROM messages WHERE to_bot = ? AND kind = 'probe' AND status != 'delivered'").run(bot.id);
      events.revokeAll(bot.id);
      q('UPDATE bots SET webhook_url = ?, webhook_key = ?, doorbell_kind = ?, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1 WHERE id = ?').run(url, sealKey(key), kind, bot.id);
      log(bot.id, 'doorbell_set', { host: new URL(url).hostname, by: 'admin' });
      return { ok: true, handle: bot.handle, next: 'the bot (or admin) should now run a doorbell test' };
    },
    'POST /admin/doorbell/test': async ({ body, admin }) => {
      if (!admin) throw new HttpError(401, 'admin token required');
      const bot = q('SELECT * FROM bots WHERE handle = ?').get(String(body.handle || '').toLowerCase());
      if (!bot) throw new HttpError(404, 'no such handle');
      return routes['POST /v1/doorbell/test']({ me: bot });
    },
    'GET /admin/events': ({ admin, url }) => {
      if (!admin) throw new HttpError(401, 'admin token required');
      const since = Number(url.searchParams.get('since') || 0);
      const rows = q('SELECT e.*, b.handle FROM events e LEFT JOIN bots b ON b.id = e.bot WHERE e.id > ? ORDER BY e.id LIMIT 500').all(since);
      return { events: rows.map((r) => ({ id: r.id, ts: iso(r.ts), handle: r.handle, kind: r.kind, detail: JSON.parse(r.detail || '{}') })) };
    },
    'GET /admin/bots': ({ admin }) => {
      if (!admin) throw new HttpError(401, 'admin token required');
      return { bots: q('SELECT handle, display_name, created_at, webhook_url IS NOT NULL AS doorbell, doorbell_verified_at, last_ring_at, last_ring_status, last_claim_at FROM bots').all()
        .map((b) => ({ ...b, doorbell: !!b.doorbell, created_at: iso(b.created_at), doorbell_verified_at: iso(b.doorbell_verified_at), last_ring_at: iso(b.last_ring_at), last_claim_at: iso(b.last_claim_at) })) };
    },

    'POST /v1/enroll': ({ body }) => tx(() => {
      const keys = validKeys(body.keys);
      const code = String(body.code || '').trim().toUpperCase();
      const row = q('SELECT * FROM enroll_codes WHERE code_hash = ?').get(sha(code));
      if (!row || row.used_at || row.expires_at < clock()) throw new HttpError(400, 'enrollment code is invalid, used or expired');
      const raw = token('b2b_');
      q('UPDATE enroll_codes SET used_at = ? WHERE handle = ? AND used_at IS NULL').run(clock(), row.handle);
      if (row.reissue) {
        const switching = q('SELECT id FROM bots WHERE handle = ?').get(row.handle);
        if (switching) events.revokeAll(switching.id);
        q(`UPDATE bots SET token_hash = ?, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1, disconnected_at = NULL, vendor = 'grokbot',
           webhook_url = CASE WHEN doorbell_kind = 'mcp_events' THEN NULL ELSE webhook_url END, doorbell_kind = CASE WHEN doorbell_kind = 'mcp_events' THEN NULL ELSE doorbell_kind END WHERE handle = ?`).run(sha(raw), row.handle);
        // A bot moving from the connected app to private mode: its app sign-in ends here.
        q('UPDATE oauth_tokens SET revoked_at = ? WHERE bot_id = (SELECT id FROM bots WHERE handle = ?) AND revoked_at IS NULL').run(clock(), row.handle);
      } else {
        if (q('SELECT 1 FROM bots WHERE handle = ?').get(row.handle)) throw new HttpError(409, 'handle already enrolled');
        q('INSERT INTO bots (handle, display_name, token_hash, created_at) VALUES (?, ?, ?, ?)').run(row.handle, row.display_name, sha(raw), clock());
      }
      if (row.user_id) q('UPDATE bots SET user_id = ? WHERE handle = ?').run(row.user_id, row.handle);
      const bot = q('SELECT * FROM bots WHERE handle = ?').get(row.handle);
      if (!setKeys(bot, keys) && row.reissue) bumpGen(bot.id);
      log(bot.id, row.reissue ? 're_enrolled' : 'enrolled', { encrypted: !!keys });
      return { token: raw, handle: row.handle, display_name: row.display_name, encryption: keys ? 'on' : 'off' };
    }),

    // Private mode without a code: the bot asks to join with its public keys and gets a link for its owner.
    // The owner signs in and says yes on that page (app.mjs); the bot then collects its token by polling.
    'POST /v1/join': ({ body }) => {
      const keys = validKeys(body.keys);
      if (!keys) throw new HttpError(400, 'keys are required');
      const name = String(body.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || null;
      if (q('SELECT count(*) AS n FROM join_requests WHERE approved_at IS NULL AND denied_at IS NULL AND expires_at > ?').get(clock()).n >= L.joinsOpenMax) throw new HttpError(429, 'too many bots are joining right now; try again in a few minutes');
      const code = humanCode();
      const poll = token('jp_');
      q('INSERT INTO join_requests (code_hash, poll_hash, sign_pub, box_pub, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sha(code), sha(poll), keys.sign, keys.box, name, clock(), clock() + L.joinTtlMs);
      log(null, 'join_requested', {});
      return { link: `${publicUrl}/app/link/${code}`, poll, expires_at: iso(clock() + L.joinTtlMs), every_s: 3 };
    },
    'POST /v1/join/poll': ({ body }) => tx(() => {
      const r = q('SELECT * FROM join_requests WHERE poll_hash = ?').get(sha(String(body.poll || '')));
      if (!r) throw new HttpError(404, 'unknown join request');
      if (r.denied_at) throw new HttpError(403, 'your owner said no');
      if (r.collected_at) throw new HttpError(409, 'this join request was already used');
      if (!r.approved_at) {
        if (r.expires_at < clock()) throw new HttpError(410, 'the link expired before your owner opened it');
        return { status: 'waiting', expires_at: iso(r.expires_at) };
      }
      const bot = q('SELECT * FROM bots WHERE id = ?').get(r.approved_bot);
      if (!bot || bot.disconnected_at || bot.sign_pub !== r.sign_pub || bot.box_pub !== r.box_pub) throw new HttpError(409, 'this bot was changed on the dashboard since; ask your owner for a new link');
      const raw = token('b2b_');
      q('UPDATE bots SET token_hash = ? WHERE id = ?').run(sha(raw), bot.id);
      q('UPDATE join_requests SET collected_at = ? WHERE code_hash = ?').run(clock(), r.code_hash);
      log(bot.id, 'enrolled', { encrypted: true, via: 'join' });
      return { status: 'joined', token: raw, handle: bot.handle, display_name: bot.display_name, encryption: 'on' };
    }),

    // For bots connected before encryption existed. Replacing keys needs a reconnect from the owner's dashboard.
    'POST /v1/keys': ({ me, body }) => tx(() => {
      const keys = validKeys(body.keys);
      if (!keys) throw new HttpError(400, 'keys are required');
      if (me.box_pub) {
        if (me.box_pub === keys.box && me.sign_pub === keys.sign) return { ok: true, already: true };
        throw new HttpError(409, `this bot already has keys. To make new ones, your owner reconnects the bot on their dashboard: ${publicUrl}/app`);
      }
      setKeys(me, keys);
      return { ok: true, encryption: 'on' };
    }),

    'GET /v1/me': ({ me }) => ({
      handle: me.handle, display_name: me.display_name,
      doorbell: { configured: !!me.webhook_url, verified: !!me.doorbell_verified_at, verified_at: iso(me.doorbell_verified_at), last_ring_at: iso(me.last_ring_at), last_ring_status: me.last_ring_status },
      inbox_pending: q("SELECT count(*) AS n FROM messages WHERE to_bot = ? AND status IN ('pending','claimed')").get(me.id).n,
      wakes_today: me.wake_day === today() ? me.wake_count : 0, wakes_per_day: L.wakesPerDay,
      contacts: q('SELECT count(*) AS n FROM contacts WHERE owner_bot = ?').get(me.id).n,
      paused: !!me.paused_at,
      owner: me.user_id ? 'verified account' : 'no account (self-hosted)',
      encryption: me.box_pub ? 'on' : 'off',
      backup_check_every_hours: me.backup_every_h ?? null,
      last_check_in: iso(me.last_claim_at),
      tool: toolInfo(),
      plan: hosted ? (({ state, limit, used, resets }) => ({ state, free_messages: limit, period: B.freePeriod, used_in_period: used, used_this_month: used, resets: iso(resets) }))(allowance(me.user_id && q('SELECT * FROM users WHERE id = ?').get(me.user_id), me)) : undefined,
    }),

    'POST /v1/invites': ({ me, body }) => {
      const alias = String(body.alias || '').trim();
      if (!ALIAS_RE.test(alias)) throw new HttpError(400, 'alias must be 1-32 letters/numbers (e.g. "anna")');
      if (q('SELECT 1 FROM contacts WHERE owner_bot = ? AND lower(alias) = lower(?)').get(me.id, alias)) throw new HttpError(409, `you already have a contact called "${alias}"`);
      const open = q('SELECT count(*) AS n FROM invites WHERE from_bot = ? AND used_at IS NULL AND expires_at > ?').get(me.id, clock()).n;
      if (open >= 10) throw new HttpError(429, 'too many open invites');
      const basket = governance.basketName(me.id, body.basket);
      const notes = inviteNotes(body.notes);
      const code = humanCode();
      q('INSERT INTO invites (code_hash, from_bot, alias, expires_at, by_owner, basket, notes) VALUES (?, ?, ?, ?, 0, ?, ?)').run(sha(code), me.id, alias, clock() + L.inviteTtlMs, basket, notes);
      log(me.id, 'invite_created', { alias, by: 'bot' });
      const link = `${publicUrl}/i/${code}`;
      return { code, alias, link, message: inviteMessage(link), expires_at: iso(clock() + L.inviteTtlMs), owner_must_approve: !!me.user_id, ...(basket ? { basket } : {}) };
    },

    // A contact only becomes usable when each side's human owner has said yes. An owner says yes by
    // creating or accepting the invite in the browser, or later on the dashboard. Bots without an
    // owner account (private self-hosted relays) are approved by their operator.
    'POST /v1/invites/accept': ({ me, body, byOwner = false }) => { let failedAccept = null; try { return tx(() => {
      const code = String(body.code || '').trim().toUpperCase();
      const alias = String(body.alias || '').trim();
      if (!ALIAS_RE.test(alias)) throw new HttpError(400, 'alias must be 1-32 letters/numbers (what you call the inviter, e.g. "son")');
      const fails = q("SELECT count(*) AS n FROM events WHERE bot = ? AND kind = 'accept_failed' AND ts > ?").get(me.id, clock() - 3_600_000).n;
      if (fails >= L.acceptFailuresPerHour) throw new HttpError(429, 'too many wrong invite codes; try again in an hour');
      const inv = q('SELECT * FROM invites WHERE code_hash = ?').get(sha(code));
      if (!inv || inv.used_at || inv.expires_at < clock()) { failedAccept = me.id; throw new HttpError(400, 'invite code is invalid, used or expired'); }
      if (inv.from_bot === me.id) throw new HttpError(400, 'you cannot accept your own invite');
      if (contact(me.id, inv.from_bot)) throw new HttpError(409, 'you are already paired with this bot');
      if (q('SELECT 1 FROM contacts WHERE owner_bot = ? AND lower(alias) = lower(?)').get(me.id, alias)) throw new HttpError(409, `you already have a contact called "${alias}"`);
      if (q('SELECT 1 FROM contacts WHERE owner_bot = ? AND lower(alias) = lower(?)').get(inv.from_bot, inv.alias)) throw new HttpError(409, 'the inviter already used that alias; ask for a new invite');
      const basket = governance.basketName(me.id, body.basket);
      const notes = inviteNotes(body.notes);
      q('UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ?').run(clock(), me.id, inv.code_hash);
      const inviter = q('SELECT * FROM bots WHERE id = ?').get(inv.from_bot);
      const t = clock();
      const inviterOk = !inviter.user_id || inv.by_owner ? t : null;
      const mineOk = !me.user_id || byOwner ? t : null;
      q('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at, gen, privacy_on) VALUES (?, ?, ?, ?, ?, ?, ?)').run(inv.from_bot, me.id, inv.alias, t, inviterOk, t, governance.inPilot(inviter) ? 1 : 0);
      q('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at, gen, privacy_on) VALUES (?, ?, ?, ?, ?, ?, ?)').run(me.id, inv.from_bot, alias, t, mineOk, t, governance.inPilot(me) ? 1 : 0);
      governance.placeInBasket(inv.from_bot, me.id, inv.basket);
      governance.placeInBasket(me.id, inv.from_bot, basket);
      // What each owner said about the other while inviting or accepting goes to their own bot, as notes.
      if (inv.notes) q('UPDATE contacts SET notes = ? WHERE owner_bot = ? AND peer_bot = ?').run(inv.notes, inv.from_bot, me.id);
      if (notes) q('UPDATE contacts SET notes = ? WHERE owner_bot = ? AND peer_bot = ?').run(notes, me.id, inv.from_bot);
      log(me.id, 'paired', { with: inviter.handle, by: byOwner ? 'owner' : 'bot', waiting: [!mineOk && 'me', !inviterOk && 'them'].filter(Boolean) });
      return { paired_with: `@${inviter.handle}`, inviter_name: inviter.display_name, your_alias_for_them: alias, ...(basket ? { basket } : {}),
        waiting_for_your_owner: !mineOk, waiting_for_them: !inviterOk,
        approve_at: !mineOk ? `${publicUrl}/app` : undefined };
    }); } catch (e) { if (failedAccept) log(failedAccept, 'accept_failed', {}); throw e; } },

    'GET /v1/settings': ({ me }) => governance.getSettings(me.id),
    'PATCH /v1/settings': ({ me, body }) => governance.applySettings(me.id, body.ops),
    'POST /v1/decisions': ({ me, body }) => tx(() => governance.recordDecisionInTx(me.id, body)),
    'POST /v1/requests': ({ me, body }) => tx(() => governance.proposeReplyInTx(me.id, body)),
    'GET /v1/requests': ({ me }) => ({ requests: governance.openRequests(me.id) }),
    'GET /v1/requests/:id': ({ me, params }) => governance.getRequest(me.id, params.id),

    'GET /v1/contacts': ({ me }) => ({
      contacts: q(`SELECT c.*, b.handle, b.display_name, b.vendor, b.sign_pub, b.box_pub, b.keys_at, c.codes_compared_at, c.privacy_on, c.can_ask, back.can_ask AS they_let_me_ask, c.blocked, c.approved_at, back.approved_at AS their_ok, b.webhook_url IS NOT NULL AS has_doorbell
                   FROM contacts c JOIN bots b ON b.id = c.peer_bot LEFT JOIN contacts back ON back.owner_bot = c.peer_bot AND back.peer_bot = c.owner_bot
                   WHERE c.owner_bot = ? ORDER BY c.alias`).all(me.id)
        .map((c) => ({ alias: c.alias, handle: `@${c.handle}`, display_name: c.display_name, blocked: !!c.blocked, owner_approves_first: governance.inPilot(me) ? governance.effectiveMode(c) === 'asks' : !!c.privacy_on, can_wake: !!c.has_doorbell,
          uses: c.vendor === 'web' ? 'web_inbox' : c.vendor === 'connector' ? 'connected_app' : 'bot', keys: c.box_pub ? { sign: c.sign_pub, box: c.box_pub } : null, keys_since: iso(c.keys_at), codes_compared: !!c.codes_compared_at,
          may_ask_you_about: JSON.parse(c.can_ask || '[]'), you_may_ask_about: JSON.parse(c.they_let_me_ask || '[]'),
          status: c.blocked ? 'blocked' : !c.approved_at ? 'waiting_for_your_owner' : !c.their_ok ? 'waiting_for_them' : 'active' })),
    }),

    'POST /v1/contacts/block': ({ me, body }) => tx(() => {
      const c = resolveContactLoose(me, body.contact);
      if (governance.inPilot(me)) return governance.applySettingsInTx(me.id, [{ op: 'block', contact: c.peer_bot, on: !body.unblock }]);
      // A bot may block on its own, but only its human can lift a block (on the dashboard).
      if (body.unblock && me.user_id) throw new HttpError(403, `only your owner can unblock a contact, on their dashboard: ${publicUrl}/app`);
      q('UPDATE contacts SET blocked = ? WHERE owner_bot = ? AND peer_bot = ?').run(body.unblock ? 0 : 1, me.id, c.peer_bot);
      bumpPair(me.id, c.peer_bot);
      if (!body.unblock) { dropBetween(me.id, c.peer_bot); log(me.id, 'contact_blocked', { peer: c.peer_bot, by: 'bot' }); }
      return { ok: true, blocked: !body.unblock };
    }),

    // Ask their bot: the bot records what its owner lets this contact's bot ask about directly. The owner sees
    // and can shorten the list on the dashboard. The topic of each question travels sealed; we never see it.
    'POST /v1/contacts/allow': ({ me, body }) => {
      const c = resolveContactLoose(me, body.contact);
      const topics = Array.isArray(body.topics) ? [...new Set(body.topics.map((t) => String(t).trim().toLowerCase()).filter(Boolean))] : null;
      if (!topics || topics.length > TOPICS_MAX || topics.some((t) => !TOPIC_RE.test(t))) throw new HttpError(400, `topics must be up to ${TOPICS_MAX} short words or phrases (letters and numbers, under 40 characters)`);
      if ((governance.inPilot(me) || c.privacy_on) && topics.some((t) => !JSON.parse(c.can_ask || '[]').includes(t))) throw new HttpError(403, 'owner_only: your owner manages what this contact may ask about. You can only remove topics.');
      q('UPDATE contacts SET can_ask = ? WHERE owner_bot = ? AND peer_bot = ?').run(JSON.stringify(topics), me.id, c.peer_bot);
      log(me.id, 'ask_topics_set', { peer: c.peer_bot, count: topics.length });
      return { ok: true, topics };
    },

    // The owner checked how often their routine also checks in on a schedule (a backup for the doorbell).
    'POST /v1/backup-check': ({ me, body }) => {
      const h = body.every_hours === null || body.every_hours === 0 ? null : Number(body.every_hours);
      if (h !== null && ![2, 4, 8, 12, 24].includes(h)) throw new HttpError(400, 'every_hours must be 2, 4, 8, 12, 24, or 0 for off');
      q('UPDATE bots SET backup_every_h = ? WHERE id = ?').run(h, me.id);
      return { ok: true, every_hours: h };
    },

    // The bot's owner said a contact's new key is fine: messages held for that check go out again.
    'POST /v1/contacts/trust': ({ me, body }) => {
      const c = resolveContactLoose(me, body.contact);
      q('UPDATE contacts SET codes_compared_at = NULL WHERE owner_bot = ? AND peer_bot = ?').run(me.id, c.peer_bot);
      const n = Number(q("UPDATE messages SET note = NULL, next_ring_at = ? WHERE to_bot = ? AND from_bot = ? AND status = 'pending' AND note = 'key_check'").run(clock(), me.id, c.peer_bot).changes);
      log(me.id, 'key_trusted', { peer: c.peer_bot, released: n });
      if (n) setImmediate(() => { void tick(); });
      return { ok: true, released: n };
    },

    // Only shown on the dashboard. The real check is the code each bot computes from the keys it holds.
    'POST /v1/contacts/compared': ({ me, body }) => {
      const c = resolveContactLoose(me, body.contact);
      q('UPDATE contacts SET codes_compared_at = ? WHERE owner_bot = ? AND peer_bot = ?').run(body.matches ? clock() : null, me.id, c.peer_bot);
      log(me.id, body.matches ? 'codes_compared' : 'codes_differ', { peer: c.peer_bot });
      return { ok: true };
    },

    'POST /v1/messages': ({ me, body, viaWeb = false }) => {
      const result = tx(() => enqueue(me, body, { actor: viaWeb ? 'owner_web' : 'bot' }));
      if (!result.duplicate) setImmediate(() => { void tick(); });
      return result;
    },

    'GET /v1/messages/:id': ({ me, params }) => {
      const m = q('SELECT m.*, f.handle AS from_handle, t.handle AS to_handle, t.last_ring_status AS to_ring_status, t.paused_at AS to_paused, t.vendor AS to_vendor, t.user_id AS to_user FROM messages m JOIN bots f ON f.id = m.from_bot JOIN bots t ON t.id = m.to_bot WHERE m.id = ?').get(params.id);
      if (!m || (m.from_bot !== me.id && m.to_bot !== me.id)) throw new HttpError(404, 'message not found');
      const reply = visibleReply(m.id, me.id);
      return {
        id: m.id, from: `@${m.from_handle}`, to: `@${m.to_handle}`, kind: m.kind, encrypted: !!m.sealed, reply_to: m.reply_to,
        status: reply ? 'replied'
          : m.status === 'delivered' ? (m.to_vendor === 'web' ? 'seen' : 'passed_on')
          : m.status === 'claimed' ? 'picked_up'
          : m.status === 'dropped' ? 'not_delivered'
          : m.status === 'pending' && m.note === 'key_check' ? 'key_check'
          : m.to_paused ? 'held'
          : m.status === 'pending' && m.to_user && quietUntil(q('SELECT * FROM users WHERE id = ?').get(m.to_user), clock()) ? 'quiet_hours'
          : m.to_vendor === 'web' ? 'in_web_inbox'
          : !m.first_rung_at ? 'queued'
          : m.to_ring_status !== null && (m.to_ring_status < 200 || m.to_ring_status >= 300) ? 'doorbell_off'
          : m.next_ring_at === null ? 'stalled'
          : m.ring_count >= L.notAnsweringAfterRings ? 'not_answering' : 'rung',
        choices: m.choices && !m.body_purged_at && (m.from_bot === me.id || m.status === 'delivered') ? JSON.parse(m.choices) : undefined,
        created_at: iso(m.created_at), first_rung_at: iso(m.first_rung_at), ring_count: m.ring_count,
        first_claimed_at: iso(m.first_claimed_at), delivered_at: iso(m.delivered_at), note: m.note === 'key_check' ? null : m.note,
        reply: reply && m.from_bot === me.id ? { id: reply.id, text: reply.sealed ? undefined : reply.text, sealed: reply.sealed ?? undefined, auto: !!reply.auto, at: iso(reply.created_at) } : undefined,
      };
    },

    'GET /v1/received': ({ me, url }) => {
      const from = url.searchParams.get('from');
      const peer = from ? resolveRecipientNoBlockCheck(me, from) : null;
      if (from && !peer) throw new HttpError(404, `no contact called "${from}"`);
      const rows = q(`SELECT m.id, m.kind, m.text, m.sealed, m.reply_to, m.created_at, m.replied_at, c.alias, b.handle FROM messages m
                      JOIN bots b ON b.id = m.from_bot LEFT JOIN contacts c ON c.owner_bot = m.to_bot AND c.peer_bot = m.from_bot
                      WHERE m.to_bot = ? AND m.kind != 'probe' AND m.status = 'delivered' ${peer ? 'AND m.from_bot = ?' : ''}
                      ORDER BY m.created_at DESC LIMIT 10`).all(...(peer ? [me.id, peer.peer_bot] : [me.id]));
      return { messages: rows.map((m) => ({ id: m.id, from: m.alias, from_handle: `@${m.handle}`, kind: m.kind, reply_to: m.reply_to, text: m.sealed ? undefined : m.text.slice(0, 200), sealed: m.sealed ?? undefined, at: iso(m.created_at), replied: !!m.replied_at })) };
    },

    'GET /v1/sent': ({ me }) => ({
      messages: q('SELECT m.id, m.kind, m.status, m.ring_count, m.created_at, m.delivered_at, m.replied_at, c.alias FROM messages m LEFT JOIN contacts c ON c.owner_bot = m.from_bot AND c.peer_bot = m.to_bot WHERE m.from_bot = ? ORDER BY m.created_at DESC LIMIT 20').all(me.id)
        .map((m) => ({ id: m.id, to: m.alias, kind: m.kind, status: visibleReply(m.id, me.id) ? 'replied' : m.status, created_at: iso(m.created_at), delivered_at: iso(m.delivered_at) })),
    }),

    // Each claim also says which tool is newest, so the doorbell run updates the tool on its own.
    'POST /v1/inbox/claim': ({ me, body }) => ({ tool: toolInfo(), ...tx(() => {
      const t = clock();
      if (me.paused_at) return { lease_seconds: L.leaseMs / 1000, paused: true, messages: [] };
      const limit = Math.min(Math.max(Number(body.limit) || 10, 1), 25);
      q("UPDATE messages SET status = 'pending', lease_until = NULL WHERE to_bot = ? AND status = 'claimed' AND lease_until <= ?").run(me.id, t);
      // Re-check permission at delivery time: messages from contacts blocked since sending are dropped.
      erase(`to_bot = ? AND status = 'pending' AND kind != 'probe' AND (created_at <= ?
         OR from_bot IN (SELECT peer_bot FROM contacts WHERE owner_bot = ? AND blocked = 1)
         OR from_bot IN (SELECT owner_bot FROM contacts WHERE peer_bot = ? AND blocked = 1)
         OR NOT EXISTS (SELECT 1 FROM contacts WHERE owner_bot = ? AND peer_bot = messages.from_bot))`, me.id, t - L.undeliveredExpiryMs, me.id, me.id, me.id);
      // Messages held because the sender's key changed stay put until the owner trusts the new key.
      const rows = q(`SELECT m.*, b.handle AS from_handle, b.sign_pub AS from_sign, b.box_pub AS from_box, c.alias AS from_alias, u.name AS from_person, u.email_verified_at AS from_verified FROM messages m
                      JOIN bots b ON b.id = m.from_bot LEFT JOIN contacts c ON c.owner_bot = m.to_bot AND c.peer_bot = m.from_bot LEFT JOIN users u ON u.id = b.user_id
                      WHERE m.to_bot = ? AND m.status = 'pending' AND coalesce(m.note, '') != 'key_check' ORDER BY m.created_at LIMIT ?`).all(me.id, limit);
      for (const m of rows) {
        m.lease = token('lease_', 6);
        q("UPDATE messages SET status = 'claimed', lease_until = ?, lease_token = ?, claim_count = claim_count + 1, first_claimed_at = coalesce(first_claimed_at, ?), next_ring_at = NULL WHERE id = ?").run(t + L.leaseMs, m.lease, t, m.id);
        log(me.id, 'claimed', { message: m.id, since_sent_ms: t - m.created_at, since_first_ring_ms: m.first_rung_at ? t - m.first_rung_at : null, claim_count: m.claim_count + 1, via: VIA.has(body.via) ? body.via : null });
      }
      q('UPDATE bots SET last_claim_at = ? WHERE id = ?').run(t, me.id);
      const probeVerified = rows.some((m) => m.kind === 'probe' && (m.probe_gen ?? 0) === me.doorbell_gen && t - m.created_at <= L.probeTtlMs && me.webhook_url);
      if (probeVerified) {
        q('UPDATE bots SET doorbell_verified_at = ? WHERE id = ?').run(t, me.id);
        log(me.id, 'doorbell_verified', { via: VIA.has(body.via) ? body.via : null });
      }
      return {
        lease_seconds: L.leaseMs / 1000,
        messages: rows.map((m) => ({
          from_person: m.kind === 'probe' ? null : (m.from_person ?? null), from_verified: !!m.from_verified,
          id: m.id, lease: m.lease, kind: m.kind, from: m.kind === 'probe' ? 'b2b relay' : (m.from_alias ?? `@${m.from_handle}`), from_handle: `@${m.from_handle}`,
          text: m.sealed ? undefined : m.text, links: m.sealed ? undefined : JSON.parse(m.links), reply_to: m.reply_to, urgent: !!m.urgent,
          sealed: m.sealed ?? undefined, from_keys: m.sealed && m.from_box ? { sign: m.from_sign, box: m.from_box } : undefined,
          topic: m.topic ?? undefined, auto: m.auto ? true : undefined,
          choices: m.choices ? JSON.parse(m.choices) : undefined, typed_on_web: m.via === 'web',
          sent_at: iso(m.created_at), seen_before: m.claim_count > 0,
        })),
      };
    }) }),

    'POST /v1/messages/:id/ack': ({ me, params, body }) => tx(() => {
      const [id, leaseFromId] = String(params.id).split('~');
      const lease = leaseFromId ? `lease_${leaseFromId}` : body.lease;
      const m = q('SELECT * FROM messages WHERE id = ?').get(id);
      if (!m || m.to_bot !== me.id) throw new HttpError(404, 'message not found');
      if (m.status === 'delivered') return { id: m.id, status: 'delivered', already: true };
      if (m.status === 'dropped') throw new HttpError(409, 'message was withdrawn');
      const t = clock();
      // Fencing: only the run holding the current, unexpired claim may complete the message.
      if (m.status !== 'claimed' || !lease || lease !== m.lease_token || !(m.lease_until > t)) {
        throw new HttpError(409, 'this receipt is out of date (another run has this message, or it was never picked up). Skip it; run inbox again.');
      }
      const receiptContact = contact(me.id, m.from_bot);
      const note = (governance.inPilot(me) ? receiptContact && governance.effectiveMode(receiptContact) === 'asks' : receiptContact?.privacy_on)
        ? ['failed security check', 'could not be opened by a connected-app bot'].includes(body.note) ? body.note : 'received'
        : body.note ? String(body.note).slice(0, 280) : null;
      q("UPDATE messages SET status = 'delivered', delivered_at = ?, lease_until = NULL, next_ring_at = NULL, note = ? WHERE id = ? AND lease_token = ?").run(t, note, m.id, lease);
      log(me.id, 'delivered', { message: m.id, since_sent_ms: t - m.created_at });
      return { id: m.id, status: 'delivered' };
    }),

    // The bot saw a new key on a sender and won't open the message until its owner says so. It waits unread.
    'POST /v1/messages/:id/hold': ({ me, params, body }) => tx(() => {
      const [id, leaseFromId] = String(params.id).split('~');
      const lease = leaseFromId ? `lease_${leaseFromId}` : body.lease;
      const m = q('SELECT * FROM messages WHERE id = ?').get(id);
      if (!m || m.to_bot !== me.id) throw new HttpError(404, 'message not found');
      if (m.status !== 'claimed' || !lease || lease !== m.lease_token || !(m.lease_until > clock())) throw new HttpError(409, 'this receipt is out of date; run inbox again');
      q("UPDATE messages SET status = 'pending', lease_until = NULL, lease_token = NULL, next_ring_at = NULL, note = 'key_check' WHERE id = ?").run(id);
      log(me.id, 'held_for_key_check', { message: id });
      return { id, status: 'held' };
    }),

    'POST /v1/doorbell': ({ me, body }) => {
      const { url, kind } = doorbellTarget(String(body.url || ''), body.kind);
      q("DELETE FROM messages WHERE to_bot = ? AND kind = 'probe' AND status != 'delivered'").run(me.id);
      const key = String(body.key || '');
      if (key.length < 8 || key.length > 512 || /[\r\n]/.test(key)) throw new HttpError(400, 'webhook key looks wrong (8-512 chars, one line)');
      events.revokeAll(me.id);
      q('UPDATE bots SET webhook_url = ?, webhook_key = ?, doorbell_kind = ?, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1 WHERE id = ?').run(url, sealKey(key), kind, me.id);
      log(me.id, 'doorbell_set', { host: new URL(url).hostname });
      return { ok: true, verified: false, next: 'run "b2b doorbell test", then do nothing; the routine run must pick up the test message' };
    },

    'DELETE /v1/doorbell': ({ me }) => {
      events.revokeAll(me.id);
      q('UPDATE bots SET webhook_url = NULL, webhook_key = NULL, doorbell_kind = NULL, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1 WHERE id = ?').run(me.id);
      return { ok: true };
    },

    // The test drops a probe message into the bot's own inbox and rings. Only a
    // claim of that probe proves the routine really runs (HTTP 200 alone does not).
    'POST /v1/doorbell/test': async ({ me, byOwner = false }) => {
      if (me.paused_at && !byOwner) throw new HttpError(403, 'your owner paused everything; the doorbell can only be tested from their dashboard');
      if (!me.webhook_url) throw new HttpError(400, 'no doorbell set; run "b2b doorbell set <url> --key <key>" first');
      const t = clock();
      q("DELETE FROM messages WHERE to_bot = ? AND kind = 'probe' AND status != 'delivered'").run(me.id);
      const id = token('msg_', 9);
      const bot = q('SELECT * FROM bots WHERE id = ?').get(me.id);
      if (bot.wake_day === today() && bot.wake_count >= L.wakesPerDay) throw new HttpError(429, 'wake budget for today is used up');
      q(`INSERT INTO messages (id, from_bot, to_bot, kind, text, created_at, status, ring_count, first_rung_at, probe_gen)
         VALUES (?, ?, ?, 'probe', ?, ?, 'pending', 1, ?, ?)`).run(id, me.id, me.id,
        'Doorbell test from the b2b relay. Nothing to tell your owner; just acknowledge this message.', t, t, bot.doorbell_gen);
      q('UPDATE bots SET doorbell_verified_at = NULL WHERE id = ?').run(me.id);
      const r = await ring(bot, 'test', { floorMs: L.urgentFloorMs });
      return { ...r, probe: id, next: 'Wait ~1 minute. The routine run should pick up the test message. Then "b2b doorbell status" shows verified.' };
    },
  };

  function resolveContactLoose(me, name) {
    const r = resolveRecipientNoBlockCheck(me, name);
    if (!r) throw new HttpError(404, 'contact not found');
    return r;
  }
  function resolveRecipientNoBlockCheck(me, to) {
    const name = String(to || '').trim();
    if (name.startsWith('@')) return q('SELECT c.* FROM contacts c JOIN bots b ON b.id = c.peer_bot WHERE c.owner_bot = ? AND b.handle = ?').get(me.id, name.slice(1).toLowerCase());
    return q('SELECT * FROM contacts WHERE owner_bot = ? AND lower(alias) = lower(?)').get(me.id, name);
  }

  const cliSource = () => readFileSync(join(cliDir, 'b2b.mjs'), 'utf8');
  const cliSignature = () => { try { return readFileSync(join(cliDir, 'b2b.mjs.sig'), 'utf8'); } catch { throw new HttpError(404, 'this relay has no signed release of the tool'); } };
  const setupTemplate = () => readFileSync(join(here, 'SETUP-FOR-BOTS.md'), 'utf8');
  const skillTemplate = () => readFileSync(join(here, 'skill', 'SKILL.md'), 'utf8');
  const setupGuide = () => setupTemplate().replaceAll('{{RELAY}}', publicUrl);
  const skillFile = () => skillTemplate().replaceAll('{{RELAY}}', publicUrl);
  // The doorbell routine's instruction, as the guide gives it. The tool hands it out (with the skill) only when it
  // matches what that signed release expects, so a relay can't change what bots are told to do.
  const doorbellTemplate = () => setupTemplate().split('## 3. Doorbell')[1].match(/^> (.+)$/m)[1];
  // The newest tool is the signed release this relay serves. Older tools update themselves to it; a tool older
  // than minTool gets an "update first" answer (426) on every call, which even the oldest tools print as it is.
  let latestTool;
  const toolInfo = () => ({ latest: (latestTool ??= cliSource().match(/^const VERSION = '([\d.]+)';$/m)?.[1] ?? null), min: minTool });
  const toolTooOld = (v) => newerVersion(minTool, v || SILENT_TOOL);
  const updateFirst = () => `this b2b tool is too old for this relay. Update it with: node ~/bin/b2b.mjs update (it checks the signature), then run the same command again. If that fails, reinstall it: mkdir -p ~/bin && curl -fsSL ${publicUrl}/cli/b2b.mjs -o ~/bin/b2b.mjs`;

  function match(method, path) {
    for (const key of Object.keys(routes)) {
      const [m, pattern] = key.split(' ');
      if (m !== method) continue;
      const a = pattern.split('/'); const b = path.split('/');
      if (a.length !== b.length) continue;
      const params = {};
      if (a.every((seg, i) => (seg.startsWith(':') ? ((params[seg.slice(1)] = decodeURIComponent(b[i])), true) : seg === b[i]))) return { handler: routes[key], params, key };
    }
    return undefined;
  }

  // The private-mode doorbell instruction, straight from the guide, so a bot switching from quick connect uses the same words.
  const privateDoorbell = () => doorbellTemplate().replaceAll('{{RELAY}}', publicUrl);
  const handleConnector = createConnector({ q, tx, log, clock, publicUrl, sha, token, humanCode, routes, HttpError, L, privateDoorbell, trustProxy,
    // MCP Events store signing secrets: only offered when they can be encrypted at rest (or in local tests).
    events: keySecret || allowLocalWebhooks ? events : null });
  const site = makeSite(siteDir);
  const redirects = new Set(redirectHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  const governance = createGovernance({ db, q, tx, clock, token, HttpError, publicUrl, privacyPilot,
    resolveRecipient, enqueue, bumpGen, bumpPair, dropBetween, release, ring, L });
  const { inPilot, effectiveMode, applyOwnerOps, applyOwnerOpsInTx, decideProposal, decideProposalInTx,
    decideRequest, decideRequestInTx, getSettings, getRequest, openRequests, wakeRequest, wakeOwner, wakeSettings } = governance;
  const handleApp = createApp({ events, governance, inPilot, effectiveMode, applyOwnerOps, applyOwnerOpsInTx,
    decideProposal, decideProposalInTx, decideRequest, decideRequestInTx, getSettings, getRequest, openRequests, wakeRequest, wakeOwner, wakeSettings, toolInfo, toolTooOld, stickersDir, setPrivacyInTx, bumpGen, bumpPair, setKeys, validKeys, setupBotUrl, inviteMessage, webInbox, site: !!site, q, tx, log, clock, publicUrl, sha, token, humanCode, HttpError, validWebhook, doorbellTarget, sealKey, routes, L, mailer, devLogin, name: productName, release, iso, banner, quietUntil, hosted, B, coverage, allowance, fetchImpl, erase, dropBetween, trustProxy });
  const adminHash = sha(adminToken);
  async function handle(req, res) {
    const url = new URL(req.url, 'http://relay');
    const send = (status, data, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(data, null, 2) : data);
    };
    try {
      // Old addresses (www, the Railway one) send people to the real domain. Bots and API calls keep working on any address.
      if (redirects.size && publicUrl && redirects.has(String(req.headers.host || '').toLowerCase()) && isPageVisit(req, url)) {
        res.writeHead(301, { location: publicUrl + url.pathname + url.search }); return res.end();
      }
      if (await handleConnector(req, res, url)) return;
      if (await handleApp(req, res, url)) return;
      if (req.method === 'GET' && url.pathname === '/api') return send(200, { service: 'b2b relay', cli: `${publicUrl}/cli/b2b.mjs`, setup: `${publicUrl}/setup`, tool: toolInfo() });
      if (req.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/cli/b2b.mjs') return send(200, cliSource(), 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/cli/b2b.mjs.sig') return send(200, cliSignature(), 'text/plain; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/cli/texts') return send(200, { skill: skillTemplate(), doorbell: doorbellTemplate() });
      if (req.method === 'GET' && url.pathname === '/setup') return send(200, setupGuide(), 'text/markdown; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/skill') return send(200, skillFile(), 'text/markdown; charset=utf-8');
      // The setup bot's full guide. A Grok Bot template copy can arrive without its skill, so the template's short
      // instruction tells the bot to read this first.
      if (req.method === 'GET' && url.pathname === '/setup-bot') return send(200, readFileSync(join(here, 'setup-bot', 'SKILL.md'), 'utf8').replaceAll('{{RELAY}}', publicUrl), 'text/markdown; charset=utf-8');
      if (site && site.serve(req, res, url)) return;
      const found = match(req.method, url.pathname);
      if (!found && site && isPageVisit(req, url)) return site.notFound(req, res);
      if (!found) throw new HttpError(404, 'not found');
      let body = {};
      if (['POST', 'PATCH'].includes(req.method)) {
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (raw.length > 64_000) throw new HttpError(413, 'body too large'); }
        if (raw) { try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'body must be JSON'); } }
      }
      if (['PATCH /v1/settings', 'POST /v1/requests', 'POST /v1/decisions'].includes(found.key) && (!body || typeof body !== 'object' || Array.isArray(body))) throw new HttpError(400, 'body must be a JSON object');
      const auth = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const admin = auth.length > 0 && auth.length === adminToken.length && timingSafeEqual(Buffer.from(sha(auth)), Buffer.from(adminHash));
      const me = botByToken(auth);
      const open = ['POST /v1/enroll', 'POST /v1/join', 'POST /v1/join/poll'].includes(found.key) || found.key.startsWith('POST /admin') || found.key.startsWith('GET /admin');
      if (!open && !me) throw new HttpError(401, 'missing or invalid bot token');
      // Which tool this bot runs, for its owner's dashboard; one too old to keep going is asked to update first.
      if (me) {
        const said = String(req.headers['x-b2b-version'] || '');
        const v = TOOL_VERSION_RE.test(said) ? said : '';
        if (me.tool_version !== v) q('UPDATE bots SET tool_version = ? WHERE id = ?').run(v, me.id);
        if (toolTooOld(v)) throw new HttpError(426, updateFirst());
      }
      const result = await found.handler({ req, url, body, me, admin, params: found.params });
      return send(200, result);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.message });
      console.error(e);
      return send(500, { error: 'internal error' });
    }
  }

  return { handle, tick, db, ring, enqueue, governance, inPilot, effectiveMode, applyOwnerOps, applyOwnerOpsInTx, decideProposal, decideProposalInTx, decideRequest, decideRequestInTx, getSettings, getRequest, openRequests, wakeRequest, wakeOwner, wakeSettings, setPrivacy, setPrivacyInTx, retention: (t = clock()) => { lastRetention = 0; retention(t); } };
}

// ───── the landing site ─────
// The hosted server also serves the static website (built from site/v2/simple) on the same domain as the dashboard.
// Server routes always win; the site only answers paths nothing else handled.
const SITE_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };
const MACHINE = /^\/(v1|admin|mcp|oauth|\.well-known|cli|billing)(\/|$)|^\/(setup|skill|healthz|api)$/;
// A person's browser asking for a page, not a bot or an API client.
// AI agents can ask for a docs page as Markdown: Accept: text/markdown, ranked above text/html (or without it).
const wantsMarkdown = (req) => {
  const a = String(req.headers.accept || '').toLowerCase();
  const md = a.indexOf('text/markdown');
  const html = a.indexOf('text/html');
  return md !== -1 && (html === -1 || md < html);
};
// /docs/quickstart/ -> /docs/quickstart.md, /docs/ -> /docs/index.md
const docsMarkdownPath = (p) => (/^\/docs(\/|$)/.test(p) && !/\.[a-z0-9]+$/i.test(p) ? `/docs/${p.replace(/^\/docs\/?/, '').replace(/\/$/, '') || 'index'}.md` : null);
const isPageVisit = (req, url) => (req.method === 'GET' || req.method === 'HEAD') && !MACHINE.test(url.pathname) && String(req.headers.accept || '').includes('text/html');

function makeSite(dir) {
  if (!dir || !existsSync(join(dir, 'index.html'))) return null;
  const root = resolve(dir);
  const isFile = (f) => { try { return statSync(f).isFile(); } catch { return false; } };
  const sendFile = (req, res, status, f, path, extra = {}) => {
    const ext = extname(f);
    const cache = /^\/(_astro|fonts)\//.test(path) ? 'public, max-age=31536000, immutable' : ext === '.html' || ext === '.md' ? 'no-cache' : 'public, max-age=3600';
    res.writeHead(status, { 'content-type': SITE_TYPES[ext] || 'application/octet-stream', 'cache-control': cache, 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin', ...extra });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(f));
  };
  return {
    serve(req, res, url) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return false;
      let p; try { p = decodeURIComponent(url.pathname); } catch { return false; }
      if (p.includes('\0')) return false;
      const md = docsMarkdownPath(p);
      const mdFile = md && resolve(root, '.' + md);
      if (mdFile && mdFile.startsWith(root + sep) && isFile(mdFile)) {
        // Docs pages come in two forms; say which, so caches keep them apart and agents can find the Markdown.
        if (wantsMarkdown(req)) return sendFile(req, res, 200, mdFile, md, { vary: 'Accept' }), true;
        const html = resolve(root, '.' + (p.endsWith('/') ? p + 'index.html' : p + '/index.html'));
        if (p.endsWith('/') && isFile(html)) return sendFile(req, res, 200, html, p, { vary: 'Accept', link: `<${md}>; rel="alternate"; type="text/markdown"` }), true;
      }
      const f = resolve(root, '.' + (p.endsWith('/') ? p + 'index.html' : p));
      if (!f.startsWith(root + sep)) return false;
      if (isFile(f)) return sendFile(req, res, 200, f, p), true;
      if (!p.endsWith('/') && isFile(join(f, 'index.html'))) { res.writeHead(301, { location: url.pathname + '/' + url.search }); res.end(); return true; }
      return false;
    },
    notFound(req, res) {
      const f = join(root, '404.html');
      if (isFile(f)) return sendFile(req, res, 404, f, '/404.html');
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Not found');
    },
  };
}

// Login emails: Resend if RESEND_API_KEY is set, otherwise printed to the server log (development).
function makeMailer() {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'bot2bot <login@bot2bot.example>';
  if (!key) return async ({ to, subject, text }) => { console.log(`[mail] to=${to} subject=${subject}\n${text}`); };
  return async ({ to, subject, text, html }) => {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, text, ...(html ? { html } : {}) }), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) { console.error('[mail] send failed', r.status); throw new Error('mail failed'); }
  };
}

// ───── main ─────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const relay = createRelay({
    dbPath: process.env.DB_PATH || join(here, 'data', 'relay.db'),
    adminToken: process.env.ADMIN_TOKEN,
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
    webhookHosts: (process.env.WEBHOOK_HOSTS || 'api2.cursor.sh').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    allowLocalWebhooks: process.env.ALLOW_LOCAL_WEBHOOKS === '1',
    keySecret: process.env.WEBHOOK_KEY_SECRET || undefined,
    devLogin: process.env.ALLOW_DEV_LOGIN === '1',
    adminEnroll: process.env.ALLOW_ADMIN_ENROLL === '1',
    hosted: process.env.HOSTED === '1',
    trustProxy: process.env.TRUST_PROXY === '1',
    billing: { stripeKey: process.env.STRIPE_SECRET_KEY, priceId: process.env.STRIPE_PRICE_ID, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
      ...(process.env.PRICE_LABEL ? { priceLabel: process.env.PRICE_LABEL } : {}),
      ...(process.env.FREE_MESSAGES ? { freeMessages: Number(process.env.FREE_MESSAGES) } : {}),
      ...(process.env.FREE_PERIOD ? { freePeriod: process.env.FREE_PERIOD } : {}) },
    productName: process.env.PRODUCT_NAME || 'bot2bot',
    ...(process.env.SETUP_BOT_URL ? { setupBotUrl: process.env.SETUP_BOT_URL } : {}),
    // Bots whose tool is older than this must update before anything else works (they're told how).
    ...(TOOL_VERSION_RE.test(process.env.MIN_CLI_VERSION || '') ? { minTool: process.env.MIN_CLI_VERSION } : {}),
    webInbox: process.env.WEB_INBOX === '1',
    privacyPilot: process.env.PRIVACY_PILOT === '1' ? true : (process.env.PRIVACY_PILOT || '').split(',').map((s) => s.trim()).filter(Boolean),
    siteDir: process.env.SITE_DIR || '',
    redirectHosts: (process.env.REDIRECT_HOSTS || '').split(','),
    mailer: makeMailer(),
  });
  const port = Number(process.env.PORT || 8787);
  http.createServer(relay.handle).listen(port, () => console.log(`b2b relay listening on :${port}`));
  setInterval(() => { relay.tick().catch((e) => console.error('tick', e)); }, 2_000).unref?.();
  setInterval(() => {}, 1 << 30); // keep alive
}
