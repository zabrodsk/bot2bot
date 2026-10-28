// The human side of b2b: accounts (email code login), a dashboard, self-serve bot setup,
// doorbell setup with a live test, and invite links. Server-rendered HTML, zero dependencies.
import { CONNECTOR_DOORBELL, ENCRYPTION_MESSAGE, safeText } from './connector.mjs';
import { loginEmail } from './email.mjs';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function migrateApp(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      created_at INTEGER NOT NULL, email_verified_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS login_codes (
      id INTEGER PRIMARY KEY, email TEXT NOT NULL, code_hash TEXT NOT NULL, link_hash TEXT UNIQUE NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
  `);
  const addColumn = (table, col, def) => {
    if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    return true;
  };
  addColumn('bots', 'user_id', 'INTEGER');
  addColumn('enroll_codes', 'user_id', 'INTEGER');
  // The one-time code is kept readable until used, so the owner's dashboard can show the setup message again.
  addColumn('enroll_codes', 'plain_code', 'TEXT');
  // Consent and control (0.6). Contacts made before approvals existed count as approved.
  if (addColumn('contacts', 'approved_at', 'INTEGER')) db.exec('UPDATE contacts SET approved_at = created_at WHERE approved_at IS NULL');
  addColumn('invites', 'by_owner', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('bots', 'paused_at', 'INTEGER');
  addColumn('bots', 'disconnected_at', 'INTEGER');
  addColumn('messages', 'body_purged_at', 'INTEGER');
  // Web inbox (0.7): people without a bot get a "web" bot row, so contacts and delivery work the same.
  addColumn('bots', 'vendor', "TEXT NOT NULL DEFAULT 'grokbot'");
  addColumn('messages', 'choices', 'TEXT');
  addColumn('messages', 'via', "TEXT NOT NULL DEFAULT 'bot'");
  addColumn('users', 'last_notified_at', 'INTEGER');
  // Quiet hours (0.8): on by default, 22:00 to 08:00 in the person's own timezone.
  addColumn('users', 'tz', 'TEXT');
  addColumn('users', 'quiet_on', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('users', 'quiet_start', 'INTEGER NOT NULL DEFAULT 1320');
  addColumn('users', 'quiet_end', 'INTEGER NOT NULL DEFAULT 480');
  // Hosted plan (0.9): one yearly payment covers the payer and up to five people they add by email.
  addColumn('users', 'paid_until', 'INTEGER');
  db.exec(`
    CREATE TABLE IF NOT EXISTS household_members (
      payer_user_id INTEGER NOT NULL REFERENCES users(id), email TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (payer_user_id, email)
    );
    CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
  `);
  // Audit fixes (0.9.1): login links work only in the browser that asked; per-IP mail limits.
  addColumn('login_codes', 'browser_hash', 'TEXT');
  addColumn('login_codes', 'ip_hash', 'TEXT');
  // End-to-end encryption (0.10): each bot's public keys; sealed messages the relay can't read; a sender-made tag
  // that lets retries be recognised without seeing the text; whether two owners compared safety codes.
  addColumn('bots', 'sign_pub', 'TEXT');
  addColumn('bots', 'box_pub', 'TEXT');
  addColumn('bots', 'keys_at', 'INTEGER');
  addColumn('messages', 'sealed', 'TEXT');
  addColumn('messages', 'content_tag', 'TEXT');
  addColumn('contacts', 'codes_compared_at', 'INTEGER');
  // Ask their bot (0.11): topics a person lets a contact's bot ask their bot about directly. The list is
  // set by the person's own bot; on the dashboard it can only be shortened. Backup check (0.11): how often
  // the owner set their routine to check in on its own, shown on the dashboard.
  addColumn('contacts', 'can_ask', "TEXT NOT NULL DEFAULT '[]'");
  addColumn('bots', 'backup_every_h', 'INTEGER');
  // Connected app (0.12): plain messages carry an "ask their bot" topic and an "answered by the bot" mark.
  addColumn('messages', 'topic', 'TEXT');
  addColumn('messages', 'auto', 'INTEGER NOT NULL DEFAULT 0');
  // Profile photos (0.17): a small square JPEG the person uploads, shown to friends who said yes to them.
  addColumn('users', 'photo', 'BLOB');
  addColumn('users', 'photo_at', 'INTEGER');
  // Or one of the drawn robots instead of a photo.
  addColumn('users', 'avatar', 'TEXT');
  // Older relays logged whatever a bot sent as "via"; keep only the known values.
  db.exec(`UPDATE events SET detail = json_remove(detail, '$.via') WHERE kind IN ('claimed', 'doorbell_verified') AND json_valid(detail)
           AND json_extract(detail, '$.via') IS NOT NULL AND json_extract(detail, '$.via') NOT IN ('doorbell', 'manual', 'schedule')`);
}

const validTz = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const parseHhmm = (s) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
// Only same-site paths: no "//host", no "/\host", no control characters.
const safeNext = (n) => (typeof n === 'string' && /^\/(?![\/\\])[^\s\x00-\x1f]*$/.test(n) ? n : '/app');

const SESSION_MS = 30 * 24 * 3_600_000;
const LOGIN_TTL_MS = 15 * 60_000;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ago = (ms, now) => {
  if (!ms) return 'never';
  const s = Math.round((now - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

export function createApp(ctx) {
  const { events = null, inPilot = () => false, effectiveMode, governance, getSettings, getRequest, openRequests, applyOwnerOps, decideRequest, decideProposal, stickersDir, setPrivacyInTx, bumpGen, bumpPair, setKeys, setupBotUrl = 'https://x.ai/bot/d_op9BSVjlxk2eYrCmAVL', inviteMessage = (l) => l, webInbox = false, site = false, q, tx, log, clock, publicUrl, sha, token, humanCode, HttpError, validWebhook, doorbellTarget = (u) => ({ url: validWebhook(u), kind: 'grok_webhook' }), sealKey, routes, L, mailer, devLogin, name, release, iso, banner, quietUntil, hosted, B, coverage, allowance, fetchImpl, erase, dropBetween, trustProxy } = ctx;
  const product = name || 'bot2bot';
  const origin = publicUrl || '';

  // ───── sessions ─────
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf('='); return [c.slice(0, i), decodeURIComponent(c.slice(i + 1))]; }));
  const currentUser = (req) => {
    const t = cookies(req).b2b_session;
    if (!t) return null;
    const s = q('SELECT * FROM sessions WHERE token_hash = ?').get(sha(t));
    if (!s || s.expires_at < clock()) return null;
    return q('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
  };
  const secure = origin.startsWith('https://');
  const sessionCookie = (raw, maxAge) => `b2b_session=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  function startSession(res, userId) {
    const raw = token('s_', 24);
    q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(raw), userId, clock(), clock() + SESSION_MS);
    res.setHeader('set-cookie', sessionCookie(raw, SESSION_MS / 1000));
  }

  // ───── rendering ─────
  // Signed-in pages: a sidebar (places, your bots, you) beside a full-width page with one header.
  // On phones the sidebar folds into a top bar and the places move to a bar at the bottom.
  // Signed-out pages: the brand on top and one centred column.
  const head = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f3f5f8">
<title>${esc(title)} · ${esc(product)}</title><meta name="robots" content="noindex"><style>${site ? FONTS : ''}${CSS}</style></head>`;
  const brand = (href) => `<a class="brand" href="${href}">${ICON.bot}<span>${esc(product)}</span></a>`;
  const sim = banner ? `<div class="sim" role="note">${esc(banner)}</div>` : '';
  const layout = (title, body, { user, bar = {}, tab = '', width = 'full', actions = '' } = {}) => {
    if (!user) return `${head(title)}<body class="out"><header class="topbar">${brand('/')}</header>${sim}<main class="col col--narrow">${body}</main>${site ? LEGAL : ''}<script>${UI_JS}</script></body></html>`;
    const hasWeb = !!q("SELECT 1 FROM bots WHERE user_id = ? AND vendor = 'web' AND disconnected_at IS NULL").get(user.id);
    const place = (key, href, label) => `<a class="tabs__item" href="${href}"${tab === key ? ' aria-current="page"' : ''}>${label}</a>`;
    const gov = govBots(user).length > 0;
    const waiting = gov ? pendingFor(user) : 0;
    const nav = `<nav class="tabs" aria-label="Main"><span class="tabs__sel" aria-hidden="true"></span>${place('home', '/app', 'Overview')}${gov ? place('people', '/app/people', 'People') + place('requests', '/app/requests', `Requests${waiting ? `<span class="tabs__count" aria-hidden="true">${waiting}</span><span class="sr"> (${waiting} waiting)</span>` : ''}`) : ''}${place('activity', '/app/activity', 'Activity')}${hasWeb ? place('inbox', '/app/inbox', 'Inbox') : ''}${place('account', '/app/account', 'Account')}${hosted ? place('plan', '/app/billing', 'Plan') : ''}</nav>`;
    const planName = hosted ? { paid: 'Paid', covered: 'Covered' }[allowance(user).state] || 'Free' : '';
    const face = avatar(user.name || user.email, 'md', photoUrl(user.id, user.photo_at, user.avatar));
    const me = `<details class="more umenu"><summary class="umenu__trigger" aria-label="Your account">${face}</summary>
<div class="umenu__panel"><div class="umenu__head">${face}<div class="umenu__id"><span class="umenu__row"><span class="umenu__fullname">${esc(user.name)}</span>${planName ? `<span class="umenu__plan">${planName}</span>` : ''}</span><span class="umenu__email">${esc(user.email)}</span></div></div>
<div class="umenu__sep"></div><a class="umenu__item" href="/app/account">${ICON.person}Account</a>${hosted ? `<a class="umenu__item" href="/app/billing">${ICON.card}Plan</a>` : ''}
<div class="umenu__sep"></div><form method="post" action="/logout"><button class="umenu__item">${ICON.logout}Log out</button></form></div></details>`;
    const back = bar.back ? `<a class="crumb" href="${esc(bar.back)}">${ICON.back}${esc(bar.backLabel || 'Overview')}</a>` : '';
    const ownH1 = /<h1[\s>]/.test(body);
    const pagehead = ownH1 ? (back ? `<header class="pagehead">${back}</header>` : '') : `<header class="pagehead"><div class="pagehead__text">${back}<h1>${esc(bar.title ?? title)}</h1>${bar.sub ? `<p class="pagehead__sub">${esc(bar.sub)}</p>` : ''}</div>${actions ? `<div class="pagehead__actions">${actions}</div>` : ''}</header>`;
    const note = takeNotice(user);
    return `${head(title)}<body class="in"><header class="top"><div class="top__in">${brand('/app')}${nav}${me}</div></header>
<main class="page">${sim}<div class="col col--${width}">${pagehead}${body}</div>${site ? LEGAL : ''}</main>${note ? toast(note) : ''}<script>${UI_JS}</script></body></html>`;
  };
  // Artwork made for bot2bot (isometric scenes). Only shown when the file is there.
  const art = (name, cls = '') => ART.has(name) ? `<div class="art ${cls}"><img src="/art/${name}.jpg" alt="" width="${name === 'asleep' ? 800 : name === 'home' ? 1536 : 1200}" height="${name === 'asleep' ? 800 : name === 'home' ? 864 : 800}" decoding="async"></div>` : '';
  const setupBot = setupBotUrl;
  // With the landing site on this server, its legal pages are one link away from every dashboard page.
  const LEGAL = '<footer class="legal"><a href="/privacy/">Privacy</a><a href="/terms/">Terms</a><a href="/cookies/">Cookies</a><a href="/legal/">Legal notice</a></footer>';
  const page = (res, status, html, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', ...headers }); res.end(html); };
  const redirect = (res, to) => { res.writeHead(303, { location: to, 'cache-control': 'no-store' }); res.end(); };
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  // Every change is confirmed where it happened: a short line at the bottom of the next page, with Undo when the
  // change can simply be put back, gone on its own after a few seconds. Kept in memory for two minutes per person;
  // the relay runs as one process, and a lost confirmation only loses the line, never the change.
  const notices = new Map();
  const tell = (user, n) => {
    if (notices.size > 5000) for (const [k, v] of notices) if (clock() - v.at > 120_000) notices.delete(k);
    notices.set(user.id, { ...n, at: clock() });
  };
  const takeNotice = (user) => { const n = notices.get(user.id); notices.delete(user.id); return n && clock() - n.at < 120_000 ? n : null; };
  // An undo is the same form posted back with the earlier values; undo=1 keeps an undo from offering another.
  const undoForm = (action, fields, label = 'Undo') => ({ action, fields, label });
  const toast = (n) => {
    const hidden = (o) => Object.entries(o).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v ?? '')}">`).join('');
    const undo = n.undo ? `<form method="post" action="${esc(n.undo.action)}">${hidden({ ...n.undo.fields, undo: '1' })}<button class="toast__undo">${esc(n.undo.label)}</button></form>` : '';
    return `<div class="toast${undo ? ' toast--undo' : ''}" role="status">${ICON.check}<span class="toast__what">${esc(n.what)}</span>${undo}</div>`;
  };

  async function form(req, max = 16_000) {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > max) throw new HttpError(413, 'form too large'); }
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      let value; try { value = raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON form.'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object.');
      return value;
    }
    return Object.fromEntries(new URLSearchParams(raw));
  }
  // CSRF: state-changing requests must come from our own pages.
  function sameOrigin(req) {
    const o = req.headers.origin || req.headers.referer || '';
    if (!o) return false;
    try { const u = new URL(o); return origin ? u.origin === new URL(origin).origin : u.host === req.headers.host; } catch { return false; }
  }

  // ───── login ─────
  const clientIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || '';
  async function sendLogin(email, req, res) {
    const hour = clock() - 3_600_000;
    const ipHash = sha(`ip:${clientIp(req)}`);
    if (q('SELECT count(*) AS n FROM login_codes WHERE created_at > ?').get(hour).n >= L.loginEmailsPerHour) throw new HttpError(429, 'Too many sign-ins right now. Try again in a few minutes.');
    if (q('SELECT count(*) AS n FROM login_codes WHERE ip_hash = ? AND created_at > ?').get(ipHash, hour).n >= L.loginEmailsPerIpPerHour) throw new HttpError(429, 'Too many login emails from here. Try again in an hour.');
    const recent = q('SELECT count(*) AS n FROM login_codes WHERE email = ? AND created_at > ?').get(email, hour).n;
    if (recent >= 5) throw new HttpError(429, 'Too many login emails. Try again in an hour.');
    const code = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
    const link = token('l_', 24);
    // The link only works in this browser (a cookie nonce), so nobody can send you a link to their account.
    const nonce = token('n_', 18);
    res.setHeader('set-cookie', `b2b_login=${nonce}; Path=/login; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_TTL_MS / 1000}${secure ? '; Secure' : ''}`);
    q('INSERT INTO login_codes (email, code_hash, link_hash, created_at, expires_at, browser_hash, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)').run(email, sha(code), sha(link), clock(), clock() + LOGIN_TTL_MS, sha(nonce), ipHash);
    const url = `${origin}/login/link?t=${link}`;
    await mailer({ to: email, ...loginEmail({ product, code, url, minutes: LOGIN_TTL_MS / 60_000, home: origin, logo: site ? `${origin}/icon-192.png` : '' }) });
    return devLogin ? code : null;
  }
  function finishLogin(res, email, next, tz) {
    let user = q('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      const nm = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
      q('INSERT INTO users (email, name, created_at, email_verified_at) VALUES (?, ?, ?, ?)').run(email, nm, clock(), clock());
      user = q('SELECT * FROM users WHERE email = ?').get(email);
      log(null, 'user_created', { user: user.id });
    }
    if (!user.tz && tz && validTz(tz)) q('UPDATE users SET tz = ? WHERE id = ?').run(tz, user.id);
    startSession(res, user.id);
    return redirect(res, safeNext(next));
  }

  // ───── data helpers ─────
  const myBots = (u) => q('SELECT * FROM bots WHERE user_id = ? ORDER BY created_at').all(u.id);
  const ownBot = (u, id) => { const b = q('SELECT * FROM bots WHERE id = ?').get(Number(id)); if (!b || b.user_id !== u.id) throw new HttpError(404, 'Bot not found'); return b; };
  const pendingCode = (u) => q('SELECT * FROM enroll_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY expires_at DESC').get(u.id, clock());
  const setupMessage = (code) => `Please set yourself up for ${product}. Read the guide with: curl -fsSL ${origin}/setup
Then install the tool and join with code ${code}. Add the "b2b messaging" skill from ${origin}/skill. Make a routine called "b2b doorbell" with a webhook trigger, using the instruction from the guide. Don't print any keys or tokens in this chat.`;
  const botStatus = (b) => b.disconnected_at ? { key: 'off', label: 'Disconnected' }
    : b.paused_at ? { key: 'paused', label: 'Paused' }
    : b.vendor === 'web' ? { key: 'ready', label: 'Web inbox' }
    : !b.webhook_url ? { key: 'needs_doorbell', label: 'Doorbell off' } : b.doorbell_verified_at ? { key: 'ready', label: 'Ready' } : { key: 'needs_test', label: 'Doorbell not tested' };
  // Arc badge tones: success for ready, warning for a step that's missing, info for paused.
  const toneOf = (key) => key === 'ready' ? 'success' : key === 'needs_doorbell' || key === 'needs_test' ? 'warning' : key === 'paused' ? 'info' : 'neutral';
  const badge = (label, tone = 'neutral') => `<span class="badge badge--${tone}">${esc(label)}</span>`;
  // Arc avatar: initials on a muted disc.
  // Arc avatar: the initial sits underneath, so a photo that fails to load falls back to it.
  const avatar = (name, size = 'sm', src = '') => `<span class="avatar avatar--${size}${String(src).startsWith('/stickers/') ? ' avatar--cut' : ''}" aria-hidden="true">${esc(String(name || '?').trim().slice(0, 1).toUpperCase())}${src ? `<img src="${esc(src)}" alt="" decoding="async">` : ''}</span>`;
  // A picture is a drawn robot, a die-cut sticker from the set, or the person's own photo.
  const stickers = stickerSet(stickersDir || fileURLToPath(new URL('./public/stickers/', import.meta.url)));
  const isSticker = (pic) => typeof pic === 'string' && pic.startsWith('sticker:') && stickers().has(pic.slice(8));
  const photoUrl = (userId, at, pic) => pic && ROBOT.has(pic) ? `/avatars/${pic}.svg` : isSticker(pic) ? `/stickers/${pic.slice(8)}.png` : userId && at ? `/app/photo/${userId}?v=${at}` : '';
  const hasPicture = (u) => !!(u.photo_at && (u.photo || ROBOT.has(u.avatar) || isSticker(u.avatar)));
  // Arc presence dot: shape and colour change together, so a bot's state never rests on colour alone.
  const presence = (key) => `<span class="pdot" data-status="${key === 'ready' ? 'available' : key === 'needs_doorbell' || key === 'needs_test' ? 'away' : 'offline'}" aria-hidden="true"></span>`;
  // Arc code block with a copy button: every message you paste into your bot.
  const codeBlock = (id, title, text) => `<div class="code"><div class="code__head"><span class="code__title">${ICON.chat}${esc(title)}</span><button type="button" class="copybtn" data-copy="#${id}"><span class="copybtn__icon">${ICON.copy}${ICON.check}</span><span class="copybtn__label">Copy</span></button></div><pre class="code__pre" id="${id}">${esc(text)}</pre></div>`;
  // Arc stepper: done, current and next steps on one connected track.
  const stepper = (steps, current, dir = 'h') => `<ol class="stepper stepper--${dir}">${steps.map((label, i) => {
    const st = i < current ? 'complete' : i === current ? 'current' : 'upcoming';
    return `<li class="step" data-status="${st}"${st === 'current' ? ' aria-current="step"' : ''}><span class="step__marker">${st === 'current' ? '<span class="step__ring"></span>' : ''}<span class="step__disc">${st === 'complete' ? ICON.check : i + 1}</span></span><span class="step__label">${esc(label)}${st === 'complete' ? '<span class="sr"> (done)</span>' : ''}</span>${i < steps.length - 1 ? `<span class="step__conn"><span class="step__fill"${i < current ? ' data-on' : ''}></span></span>` : ''}</li>`;
  }).join('')}</ol>`;
  // Arc confirm morph: the button turns into its own question, so a destructive tap needs a second, deliberate one.
  const confirmMorph = ({ action, fields = '', label, icon = '', prompt, confirm, pending, tone = 'danger' }) => `<form method="post" action="${action}" class="cm" data-tone="${tone}" data-state="idle">${fields}<div class="cm__surface">
<div class="cm__face" data-face="idle"><button type="button" class="cm__trigger">${icon}${esc(label)}</button></div>
<div class="cm__face" data-face="ask" role="group" aria-label="${esc(prompt)}" hidden><span class="cm__prompt">${esc(prompt)}</span><button type="button" class="cm__secondary">Cancel</button><button class="cm__confirm">${esc(confirm)}</button></div>
<div class="cm__face" data-face="pending" hidden><span class="cm__status"><span class="cm__spin" aria-hidden="true"></span>${esc(pending)}</span></div></div></form>`;
  // Arc usage meter: how much of the free allowance is used, and how close it is to the limit.
  const usageMeter = (a, { compact = false } = {}) => {
    const used = Math.min(a.used, a.limit), left = Math.max(0, a.left);
    const status = left <= 0 ? 'over' : used / a.limit >= 0.9 ? 'near' : 'ok';
    const bar = `<div class="meter__bar" role="img" aria-label="${left} of ${a.limit} free messages left ${esc(B.periodWord)}"><div class="meter__track"><div class="meter__fill" style="width:${(used / a.limit * 100).toFixed(1)}%"></div></div></div>`;
    // The compact meter is one line and a thin bar; it only shows a badge when the allowance runs low.
    if (compact) return `<div class="meter meter--compact" role="group" aria-labelledby="meter-t"><div class="meter__top"><span class="meter__title" id="meter-t">Free messages</span>${status === 'ok' ? '' : `<span class="meter__badge" data-status="${status}"><span class="meter__icon">${ICON.alert}</span>${status === 'over' ? 'Used up' : 'Almost used up'}</span>`}<span class="meter__caption"><b>${left}</b> left of ${a.limit} ${esc(B.periodWord)}</span></div>${bar}</div>`;
    return `<div class="meter" role="group" aria-labelledby="meter-t"><div class="meter__top"><span class="meter__title" id="meter-t">Free messages</span><span class="meter__badge" data-status="${status}">${status === 'ok' ? '' : `<span class="meter__icon">${ICON.alert}</span>`}${status === 'over' ? 'Used up' : status === 'near' ? 'Almost used up' : `${used} sent`}</span></div>
<p class="meter__total"><span class="meter__amount">${left}</span><span class="meter__caption">left of ${a.limit} ${esc(B.periodWord)}</span></p>
<div class="meter__bar" role="img" aria-label="${left} of ${a.limit} free messages left ${esc(B.periodWord)}"><div class="meter__track"><div class="meter__fill" style="width:${(used / a.limit * 100).toFixed(1)}%"></div></div></div></div>`;
  };
  const liveBots = (u) => myBots(u).filter((b) => !b.disconnected_at);
  const webBots = (u) => liveBots(u).filter((b) => b.vendor === 'web');
  // A person without an AI bot gets a "web" bot: same contacts and delivery, read in the browser.
  function makeWebBot(u) {
    const base = (u.name || u.email.split('@')[0]).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'friend';
    let handle = base.length < 2 ? `${base}-web` : base;
    for (let n = 2; q('SELECT 1 FROM bots WHERE handle = ?').get(handle) || q('SELECT 1 FROM enroll_codes WHERE handle = ? AND used_at IS NULL').get(handle); n++) handle = `${base}-${n}`;
    q("INSERT INTO bots (handle, display_name, token_hash, created_at, user_id, vendor) VALUES (?, ?, NULL, ?, ?, 'web')").run(handle, u.name, clock(), u.id);
    const b = q('SELECT * FROM bots WHERE handle = ?').get(handle);
    log(b.id, 'web_inbox_created', {});
    return b;
  }
  // Quick connect: a bot that uses bot2bot through the GrokBot app (no tool, no keys on its computer).
  function makeConnectorBot(u, wanted) {
    const handle = String(wanted || '').trim().toLowerCase();
    if (!HANDLE_RE.test(handle)) throw new HttpError(400, 'Use 2 to 32 lowercase letters, numbers, - or _.');
    if (q('SELECT 1 FROM bots WHERE handle = ?').get(handle) || q('SELECT 1 FROM enroll_codes WHERE handle = ? AND used_at IS NULL').get(handle)) throw new HttpError(409, 'That name is taken. Try another.');
    q("INSERT INTO bots (handle, display_name, token_hash, created_at, user_id, vendor) VALUES (?, ?, NULL, ?, ?, 'connector')").run(handle, u.name || handle, clock(), u.id);
    const b = q('SELECT * FROM bots WHERE handle = ?').get(handle);
    log(b.id, 'connector_bot_created', {});
    return b;
  }
  // Consent for a connected app (OAuth). The app gets one bot of this person's, nothing else.
  function authorizePage(user, client, params, { error = '' } = {}) {
    const bots = myBots(user).filter((b) => b.vendor === 'connector');
    const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    const suggested = (user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'my') + '-bot';
    // A disconnected bot waiting to come back is the likely choice; otherwise a new bot, so nobody hands an
    // existing bot to an app by accident. Apps name themselves (Grok Bot signs in as "Cursor"), so that's small print.
    const back = bots.find((b) => b.disconnected_at);
    return layout('Connect', `<section class="card">
<p class="muted small">Requested by the app "${esc(client.name)}".</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<p>Your bot will be able to send and receive messages with people you connect with, as one ${esc(product)} bot. It can't see your account or anyone else's bots.</p>
<p class="muted small">Connected-app chats are not end-to-end encrypted: we pass the text on and delete it 7 days after delivery. For end-to-end encryption, set your bot up in private mode instead.</p>
<form method="post" action="/oauth/authorize" class="stack">${hidden}
${bots.length ? `<label>Which bot<select name="bot" id="pick"><option value="new"${back ? '' : ' selected'}>A new bot</option>${bots.map((b) => `<option value="${b.id}"${b === back ? ' selected' : ''}>@${esc(b.handle)}${b.disconnected_at ? ' (reconnect)' : ''}</option>`).join('')}</select></label>` : '<input type="hidden" name="bot" value="new">'}
<label id="newname"${back ? ' hidden' : ''}>Name for the new bot<input name="handle" pattern="[a-z0-9][a-z0-9_-]{1,31}" value="${esc(suggested)}"></label>
<button class="btn" name="decision" value="allow">Connect</button><button class="link" name="decision" value="deny">Cancel</button></form></section>
${bots.length ? `<script>const p=document.getElementById('pick'),n=document.getElementById('newname');p.addEventListener('change',()=>{n.hidden=p.value!=='new';});</script>` : ''}`, { user, width: 'narrow', bar: { title: `Connect your bot to ${product}` } });
  }
  const quickMessage = `Add the custom MCP connector ${origin}/mcp (name: bot2bot) and sign me in. Then call its whoami tool and do the next step it gives you.`;
  // Private mode is the default: one message, no code to copy. The bot makes its own keys and gives its owner
  // a link; the owner signs in there and says yes, the same one sign-in as quick connect.
  const privateMessage = `Set yourself up for ${product} in private mode (end-to-end encrypted). Read the guide with: curl -fsSL ${origin}/setup
Install the tool, then run: node ~/bin/b2b.mjs join ${origin}
Give me the link it prints so I can approve you, then run the same join command again: it waits until I've said yes. Add the "b2b messaging" skill from ${origin}/skill and make the "b2b doorbell" routine from the guide. Don't print any keys or tokens in this chat.`;
  const isPaused = (u) => liveBots(u).some((b) => b.paused_at);
  // One of my bots and one of its contacts, by bot id and the contact's bot id.
  const ownContact = (u, botId, peerId) => {
    const b = ownBot(u, botId);
    const c = q('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(b.id, Number(peerId));
    if (!c) throw new HttpError(404, 'Contact not found');
    return { b, c };
  };
  const person = (c) => `${esc(c.name || '@' + c.handle)}`;
  const verifiedPill = (v) => (v ? badge('Email verified', 'success') : badge('Not verified'));
  // Arc alert: icon, title, description, and the one action that resolves it.
  const alertBox = (tone, title, desc, action = '') => `<section class="alert alert--${tone}" role="${tone === 'danger' ? 'alert' : 'status'}"><span class="alert__icon">${ICON.alert}</span><div class="alert__copy"><h2 class="alert__title">${title}</h2>${desc ? `<p class="alert__desc">${desc}</p>` : ''}</div>${action ? `<div class="alert__action">${action}</div>` : ''}</section>`;

  // ───── pages ─────
  function landing(user) {
    return layout('Bot to bot', `<section class="hero"><h1>Let your AI bot message your friends' bots.</h1>
<p class="lead">Free and open source. Works with GrokBot today.</p>
<a class="btn" href="${user ? '/app' : '/login'}">${user ? 'Open your dashboard' : 'Get started'}</a>${hosted ? '<p><a class="link" href="/pricing">Pricing</a></p>' : ''}</section>`, { user, bar: { title: product } });
  }

  // ───── plans ─────
  const dateStr = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  function pricingPage(user) {
    return layout('Pricing', `${user ? '' : '<section class="hero"><h1>Free to start</h1></section>'}
<section class="grid3 tiers">
<div class="card"><h2>Run it yourself</h2><p class="price">Free</p><ul class="ticks"><li>Open source, everything included</li><li>Your own server</li><li>No limits from us</li></ul><a class="btn ghost" href="#">Get the code</a></div>
<div class="card"><h2>We run it</h2><p class="price">Free</p><ul class="ticks"><li>${B.freeMessages} sent messages ${B.perWord}</li><li>Receiving is always free</li><li>No card</li></ul><a class="btn ghost" href="${user ? '/app' : '/login'}">${user ? 'Dashboard' : 'Start free'}</a></div>
<div class="card attention"><h2>Family</h2><p class="price">${esc(B.priceLabel)}</p><ul class="ticks"><li>No limit</li><li>Covers you and ${B.householdSize - 1} people</li><li>One payment, nothing renews by itself</li></ul>${B.stripeKey && B.priceId ? `<a class="btn" href="${user ? '/app/billing' : '/login'}">${user ? 'See my plan' : 'Start free'}</a>` : '<p>' + badge('Coming soon') + '</p>'}</div>
</section><p class="quiet small muted">Private mode is end-to-end encrypted between bots on every plan; quick connect is not. Friends who use the web inbox are always free; their chats are not end-to-end encrypted.</p>`, { user, bar: { title: 'Free to start' } });
  }
  // The free plan: one line under the overview title, plus an alert once the messages are used up.
  function planState(user) {
    if (!hosted || !liveBots(user).some((b) => b.vendor !== 'web')) return { alert: '', meter: '' };
    const a = allowance(user);
    if (!a.limited) return { alert: '', meter: '' };
    const alert = a.left > 0 ? '' : alertBox('warning', `You've used your ${a.limit} free messages ${B.periodWord}`,
      `Your bot can't send until ${B.freePeriod === 'day' ? 'tomorrow (midnight UTC)' : dateStr(a.resets)}. Receiving still works. ${esc(B.priceLabel)} removes the limit for you and ${B.householdSize - 1} others.`,
      '<a class="btn small" href="/app/billing">Remove the limit</a>');
    return { alert, meter: `<a class="card card--meter" href="/app/billing">${usageMeter(a, { compact: true })}</a>` };
  }
  function billingPage(user, { error = '', paid = false } = {}) {
    const c = allowance(user);
    const members = q('SELECT email FROM household_members WHERE payer_user_id = ? ORDER BY added_at').all(user.id);
    const canPay = !!(B.stripeKey && B.priceId);
    const status = c.state === 'paid' ? `Paid until ${dateStr(c.until)}.`
      : c.state === 'covered' ? `Covered by ${esc(c.payer)} until ${dateStr(c.until)}.`
      : `Free plan: ${c.used} of ${c.limit} messages sent ${B.periodWord}. It starts again ${B.freePeriod === 'day' ? 'at midnight UTC' : `on ${dateStr(c.resets)}`}. Receiving is never limited.`;
    return layout('Plan', `<section class="card"><h2>Your plan</h2>${paid ? '<p class="okmsg" role="status">Thanks! Payment received.</p>' : ''}${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
${c.limited ? `<div class="card__block">${usageMeter(c)}</div>` : ''}<p>${status}</p>
${c.state === 'covered' ? '' : canPay ? `<form method="post" action="/app/billing/checkout"><button class="btn">${c.state === 'paid' ? 'Add another year' : `Pay ${esc(B.priceLabel)}`}</button></form><p class="muted small">${c.state === 'paid' ? '' : 'No monthly limit for you and your household. '}One payment a year. No subscription, nothing renews by itself.</p>`
  : '<p class="muted small">The paid plan is coming soon.</p>'}</section>
<section class="card"><h2>Your household</h2><p>A paid plan covers you and up to ${B.householdSize - 1} people. Add the email they sign in with. They never see your conversations.</p>
${members.map((m) => `<div class="row"><span>${esc(m.email)}</span><form method="post" action="/app/billing/members" class="more"><input type="hidden" name="remove" value="${esc(m.email)}"><button class="link danger">Remove</button></form></div>`).join('')}
${members.length < B.householdSize - 1 ? `<form method="post" action="/app/billing/members" class="stack"><label>Email<input name="email" type="email" required autocomplete="off"></label><button class="btn small ghost">Add to my household</button></form>` : ''}
${c.state !== 'paid' && members.length ? '<p class="muted small">They have no limit once you have paid.</p>' : ''}</section>`, { user, tab: 'plan', width: 'read', bar: { title: 'Plan', sub: 'What you can send and who your plan covers' } });
  }
  // Stripe sends this after a payment. We check its signature before trusting anything in it.
  function verifyStripe(raw, header) {
    if (!B.webhookSecret || !header) return false;
    const parts = Object.fromEntries(String(header).split(',').map((kv) => kv.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k, v]));
    const sigs = String(header).split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
    const t = Number(parts.t);
    if (!t || Math.abs(clock() / 1000 - t) > 300) return false;
    const want = createHmac('sha256', B.webhookSecret).update(`${t}.${raw}`).digest('hex');
    return sigs.some((sg) => sg.length === want.length && timingSafeEqual(Buffer.from(sg), Buffer.from(want)));
  }

  function loginPage({ email = '', sent = false, error = '', next = '', devCode = null } = {}) {
    return layout('Log in', `<section class="card narrow"><h1>${sent ? 'Check your email' : 'Log in or sign up'}</h1>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
${sent ? `<p>We sent a 6-digit code to <b>${esc(email)}</b>. Type it below, or click the link in the email.</p><p class="muted small">Wrong address? <a class="link" href="/login${next ? `?next=${encodeURIComponent(next)}` : ''}">Use a different email</a>.</p>
${devCode ? `<p class="dev">Dev mode: your code is <b>${esc(devCode)}</b></p>` : ''}
<form method="post" action="/login/verify" class="stack"><input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="next" value="${esc(next)}"><input type="hidden" name="tz" id="tz">
<div class="otp" role="group" aria-label="6-digit code"><input type="hidden" name="code">${[0, 1, 2, 3, 4, 5].map((i) => `<input class="otp__slot" inputmode="numeric" aria-label="Digit ${i + 1} of 6"${i ? ' autocomplete="off"' : ' autocomplete="one-time-code" autofocus'}>`).join('')}</div>
<noscript><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required aria-label="6-digit code"></noscript>
<button class="btn">Log in</button></form><script>try{document.getElementById('tz').value=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}</script>`
    : `<p>No password. We email you a code.</p><form method="post" action="/login" class="stack"><input type="hidden" name="next" value="${esc(next)}">
<label>Email<input name="email" type="email" autocomplete="email" required autofocus value="${esc(email)}"></label><button class="btn">Email me a code</button></form>${site ? '<p class="muted small">By signing up you agree to the <a class="link" href="/terms/">terms</a>. Here’s how we handle <a class="link" href="/privacy/">your data</a>.</p>' : ''}`}
</section>`);
  }

  // No bot yet: the setup bot first (it does everything with you), doing it yourself second.
  function setupChoices({ message = privateMessage, quick = quickMessage, invite = null } = {}) {
    return `<section class="card"><div class="way"><div class="way__head"><h2>Add the setup bot</h2>${badge('Easiest', 'info')}</div>
<p class="muted">A Grok Bot that sets everything up with you: sign-in, your bot, the doorbell and a test.${invite ? ` Tell it you have an invite from ${invite}.` : ''}</p>
<a class="btn blue wide" href="${esc(setupBot)}" target="_blank" rel="noopener">Add the setup bot${ICON.out}</a></div>
<div class="way"><details class="diy"><summary>Or paste one message into your bot</summary>
<p class="muted" style="margin-top:10px">Paste this into your bot's chat in Grok Bot. It installs a small tool, makes its own keys and gives you a link to approve it. Only the bots can read your messages.</p>
${codeBlock('pm', 'Message for your bot', message)}
<details class="diy"><summary class="muted small">Bot can't run commands? Quick connect</summary>
<p class="muted small" style="margin-top:8px">It adds ${esc(product)} as an app and asks you to sign in once. Quick connect is not end-to-end encrypted: your bot hands us the text, and we delete it 7 days after delivery.</p>
${codeBlock('qc', 'Message for your bot', quick)}</details></details></div></section>`;
  }

  // Messages, newest first, as an Arc data table. The overview shows a few, the activity page shows 30.
  function activityTable(user, limit) {
    const bots = myBots(user);
    const now = clock();
    const ids = bots.map((b) => b.id);
    const ph = ids.map(() => '?').join(',') || 'NULL';
    const rows = q(`SELECT m.*, fb.handle AS from_handle, tb.handle AS to_handle FROM messages m JOIN bots fb ON fb.id = m.from_bot JOIN bots tb ON tb.id = m.to_bot
      WHERE (m.from_bot IN (${ph}) OR m.to_bot IN (${ph})) AND m.kind != 'probe' ORDER BY m.created_at DESC LIMIT ?`).all(...ids, ...ids, limit);
    const mine = new Set(ids);
    const row = (m) => {
      const out = mine.has(m.from_bot);
      const label = m.replied_at ? 'Replied' : m.status === 'delivered' ? (out ? 'Passed on' : 'Received') : m.status === 'dropped' ? 'Not delivered' : 'Waiting';
      const text = m.body_purged_at ? 'Text deleted after 7 days' : m.sealed ? 'End-to-end encrypted' : String(m.text).slice(0, 140);
      return `<li class="line" data-dir="${out ? 'out' : 'in'}"><span class="line__main"><span class="line__title"><span class="handle">@${esc(m.from_handle)}</span> → <span class="handle">@${esc(m.to_handle)}</span></span><span class="line__sub">${m.kind === 'ask' ? 'Question · ' : ''}${esc(text)} · ${label}</span></span><span class="line__end">${esc(ago(m.created_at, now))}</span></li>`;
    };
    const sealed = rows.some((m) => m.sealed && !m.body_purged_at);
    return { n: rows.length, html: `<ul class="list">${rows.map(row).join('')}</ul>${sealed ? '<p class="card__foot">End-to-end encrypted messages show no text here. Only the bots can read them.</p>' : ''}` };
  }
  const emptyState = (icon, title, text, action = '') => `<div class="empty"><span class="empty__icon">${ICON[icon]}</span><h3>${title}</h3><p>${text}</p>${action ? `<div class="empty__action">${action}</div>` : ''}</div>`;
  const REFRESH_NOTE = `<p class="note">${ICON.refresh}Updated just now · refreshes every 30 s</p>`;

  function dashboard(user) {
    const bots = myBots(user);
    const now = clock();
    if (!bots.length) {
      const code = pendingCode(user);
      if (code) return layout('Set up', `${art('setup', 'small')}<section class="card"><h2>Connect your bot</h2>${waitingForBot({ plain: code.plain_code })}</section>`, { user, tab: 'home', width: 'read', bar: { title: 'Connect your bot', sub: 'Private mode' } });
      return layout('Set up', `${art('setup', 'small')}${setupChoices()}
<p class="wait" id="wait" style="justify-content:center"><span class="dot dot--live"></span> Waiting for your bot…</p>
<script>(function poll(){ fetch('/app/status').then(r=>r.json()).then(d=>{ if(d.bots>0) location.href='/app'; else setTimeout(poll,2500); }).catch(()=>setTimeout(poll,4000)); })();</script>`, { user, tab: 'home', width: 'read', bar: { title: 'Connect your Grok Bot', sub: 'Takes a few minutes' } });
    }
    const botIds = bots.map((b) => b.id);
    const ph = botIds.map(() => '?').join(',');
    const contacts = q(`SELECT c.owner_bot, c.peer_bot, c.alias, c.blocked, c.privacy_on, c.circle_id, (SELECT name FROM circles WHERE id = c.circle_id) AS circle_name, c.mode_override, c.approved_at, back.approved_at AS their_ok, back.blocked AS they_blocked,
        b.handle, b.vendor, b.box_pub, ob.box_pub AS my_box, ob.vendor AS my_vendor, c.codes_compared_at, c.can_ask, back.can_ask AS they_let_me_ask, u.name, u.email_verified_at, u.id AS peer_user, u.photo_at, u.avatar, ob.handle AS my_handle,
        (SELECT max(created_at) FROM messages m WHERE (m.from_bot = c.owner_bot AND m.to_bot = c.peer_bot) OR (m.from_bot = c.peer_bot AND m.to_bot = c.owner_bot)) AS last_at
      FROM contacts c JOIN bots b ON b.id = c.peer_bot JOIN bots ob ON ob.id = c.owner_bot LEFT JOIN users u ON u.id = b.user_id
      LEFT JOIN contacts back ON back.owner_bot = c.peer_bot AND back.peer_bot = c.owner_bot
      WHERE c.owner_bot IN (${ph}) ORDER BY c.alias`).all(...botIds);
    const requests = contacts.filter((c) => !c.approved_at);
    const settled = contacts.filter((c) => c.approved_at);
    const live = bots.filter((b) => !b.disconnected_at);
    const paused = live.some((b) => b.paused_at);
    const multi = live.length > 1;
    const pending = pendingCode(user);
    const plan = planState(user);
    const waiting = pendingFor(user);
    // Honest labels: only bot-to-bot chats with keys on both sides are end-to-end encrypted.
    const lock = (c) => c.vendor === 'web' || c.my_vendor === 'web' ? 'Web inbox · not end-to-end encrypted'
      : c.vendor === 'connector' || c.my_vendor === 'connector' ? 'Connected app · not end-to-end encrypted'
      : c.box_pub && c.my_box ? (c.codes_compared_at ? 'Encrypted · codes compared' : 'End-to-end encrypted')
      : 'Not encrypted yet';
    // What each side's bot may answer without asking its person first, said about the people.
    const asks = (c, ids) => {
      const mine = JSON.parse(c.can_ask || '[]'), theirs = JSON.parse(c.they_let_me_ask || '[]');
      if (!mine.length && !theirs.length) return '';
      return `<div class="asks">${mine.length ? `<div><span class="muted">${esc(c.alias)} can ask about</span> ${mine.map((t) => `<span class="topic">${esc(t)}<form method="post" action="/app/contacts/disallow" class="inline">${ids}<input type="hidden" name="topic" value="${esc(t)}"><button class="x" aria-label="Stop letting ${esc(c.alias)} ask about ${esc(t)}" title="Stop">×</button></form></span>`).join(' ')}</div>` : ''}
${theirs.length ? `<div><span class="muted">You can ask ${esc(c.alias)} about</span> ${theirs.map((t) => `<span class="topic">${esc(t)}</span>`).join(' ')}</div>` : ''}</div>`;
    };
    const aiBots = live.filter((b) => b.vendor !== 'web');
    const ready = aiBots.filter((b) => botStatus(b).key === 'ready').length;
    const botRow = (b) => {
      const st = botStatus(b);
      const label = b.vendor === 'web' ? 'Web inbox' : st.key === 'ready' ? (b.last_ring_at ? 'Ready' : 'Ready, asleep') : st.label;
      const mode = b.vendor === 'web' ? 'Read in your browser' : b.vendor === 'connector' ? 'Quick connect' : 'Private mode';
      return `<li><a class="line line--link" href="${b.vendor === 'web' && !b.disconnected_at ? '/app/inbox' : `/app/bots/${b.id}`}">${presence(st.key)}
<span class="line__main"><span class="line__title handle">@${esc(b.handle)}</span><span class="line__sub">${label} · ${mode}</span></span>${ICON.chev}</a></li>`;
    };
    const friendRow = (c) => {
      const ids = `<input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}">`;
      const state = c.blocked ? 'Blocked' : !c.their_ok ? 'Waiting for them' : 'Connected';
      const id = `f-${c.owner_bot}-${c.peer_bot}`;
      const topics = asks(c, ids);
      // Pilot owners manage this per basket on People. Outside it, existing protection stays visible so it can be turned off.
      const asksFirst = !inPilot(user) && !!c.privacy_on;
      const basketRow = inPilot(user) && c.my_vendor !== 'web' ? `<div><dt>Basket</dt><dd>${c.circle_name ? `<span class="hand basket-word">${esc(c.circle_name)}</span>` : 'Not sorted yet'}${effectiveMode(c) === 'asks' ? ' · asks you first' : ''} · <a href="/app/people/${c.owner_bot}/${c.peer_bot}">Change</a></dd></div>` : '';
      const askFirst = asksFirst ? `<form method="post" action="/app/contacts/privacy" class="setrow setrow--flush acc__setting">${ids}
<div><p class="setrow__label" id="${id}-ask">Ask me before my bot writes to ${esc(c.alias)}</p><p class="setrow__desc">Your bot can't send them anything until you say yes. Approving from here comes next.</p></div>
<label class="switch"><input type="checkbox" role="switch" name="on" value="1" aria-labelledby="${id}-ask" data-autosave${asksFirst ? ' checked' : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span></label><noscript><button class="btn small ghost">Save</button></noscript></form>` : '';
      return `<li class="acc" data-open="false"><button type="button" class="acc__head" aria-expanded="false" aria-controls="${id}">${avatar(c.alias, 'md', c.their_ok && !c.they_blocked ? photoUrl(c.peer_user, c.photo_at, c.avatar) : '')}
<span class="line__main"><span class="line__title item__title">${esc(c.alias)}</span><span class="line__sub">${state} · ${c.last_at ? `last message ${esc(ago(c.last_at, now))}` : 'no messages yet'}</span></span>${ICON.chevDown}</button>
<div class="acc__panel" id="${id}" role="region" aria-label="${esc(c.alias)}" inert><div class="acc__inner"><div class="acc__body">
<dl class="kv"><div><dt>Their bot</dt><dd><span class="handle">@${esc(c.handle)}</span>${c.name && c.name.toLowerCase() !== c.alias.toLowerCase() ? ` · ${esc(c.name)}` : ''}</dd></div>
<div><dt>Email</dt><dd>${c.email_verified_at ? 'Verified' : 'Not verified'}</dd></div>
<div><dt>Encryption</dt><dd>${esc(lock(c))}</dd></div>${multi ? `<div><dt>Your bot</dt><dd><span class="handle">@${esc(c.my_handle)}</span></dd></div>` : ''}
${basketRow}${topics ? `<div><dt>Topics</dt><dd>${topics}</dd></div>` : ''}</dl>
${askFirst}<div class="acc__actions"><form method="post" action="/app/contacts/block">${ids}${c.blocked ? '<input type="hidden" name="unblock" value="1"><button class="btn small ghost">Unblock</button>' : '<button class="btn small ghost">Block</button>'}</form>
${confirmMorph({ action: '/app/contacts/remove', fields: ids, label: 'Remove', prompt: `Remove ${c.alias}?`, confirm: 'Remove', pending: 'Removing' })}</div>
</div></div></div></li>`;
    };
    const inviteForm = (cls) => live.length ? `<form method="post" action="/app/invites"><input type="hidden" name="bot" value="${live[0].id}"><button class="btn${cls ? ` ${cls}` : ''}" data-busy><span class="btn__label">${ICON.invite}Invite a friend</span><span class="btn__spin" aria-hidden="true"></span></button></form>` : '';
    const sub = paused ? 'Everything is paused' : [`${ready ? `${ready} bot${ready > 1 ? 's' : ''} ready` : 'Setting up'}`, `${settled.length} friend${settled.length === 1 ? '' : 's'}`].join(' · ');
    const alerts = [
      paused ? alertBox('info', 'Everything is paused', "Your bot won't be woken and can't send. Messages from friends wait here for up to 7 days.", '<form method="post" action="/app/pause"><input type="hidden" name="on" value="0"><button class="btn small">Resume</button></form>') : '',
      plan.alert,
      waiting ? alertBox('info', waiting === 1 ? 'Your bot needs your okay' : `Your bot needs your okay on ${waiting} things`, 'A reply or a change is waiting for you.', '<a class="btn small" href="/app/requests">See what it is</a>') : '',
      pending ? `<section class="card"><div class="card__head"><h2>Connect @${esc(pending.handle)}</h2>${badge('Private mode', 'info')}</div>${waitingForBot({ plain: pending.plain_code }, bots.length)}</section>` : '',
      ...requests.map((c) => alertBox('warning', `Did you mean to connect with ${person(c)}?`,
        `Your bot <span class="handle">@${esc(c.my_handle)}</span> paired with <b>${person(c)}</b> (<span class="handle">@${esc(c.handle)}</span>) ${verifiedPill(c.email_verified_at)}. Nothing can be sent either way until you say yes.`,
        `<form method="post" action="/app/contacts/approve"><input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}"><button class="btn small">Yes, connect</button></form>
<form method="post" action="/app/contacts/remove"><input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}"><button class="btn small ghost">No, remove</button></form>`)),
    ].filter(Boolean).join('');
    const first = (user.name || '').trim().split(/\s+/)[0];
    return layout('Overview', `${alerts ? `<div class="stack-alerts">${alerts}</div>` : ''}
${checklist(live, settled, paused)}
<section class="group" aria-labelledby="friends-h"><div class="group__head"><h2 id="friends-h">Friends <span class="count">${settled.length}</span></h2></div>
<div class="card card--list">${settled.length ? `<ul class="list">${settled.map(friendRow).join('')}</ul>` : emptyState('people', 'No friends yet', 'Invite someone and their bot can message yours.', inviteForm('small'))}</div></section>
<section class="group" aria-labelledby="bots-h"><div class="group__head"><h2 id="bots-h">Your bots <span class="count">${bots.length}</span></h2><form method="post" action="/app/bots/new"><button class="btn small ghost">${ICON.plus}Add a bot</button></form></div>
<div class="card card--list"><ul class="list">${bots.map(botRow).join('')}</ul></div></section>
${plan.meter}
<div class="foot">${live.length && !paused ? confirmMorph({ action: '/app/pause', fields: '<input type="hidden" name="on" value="1">', label: 'Pause everything', icon: ICON.pause, prompt: 'Pause all your bots?', confirm: 'Pause', pending: 'Pausing', tone: 'neutral' }) : ''}${REFRESH_NOTE}</div>
<script>${REFRESH_JS}</script>`, { user, tab: 'home', bar: { title: first ? `Hi, ${first}` : 'Overview', sub }, actions: inviteForm('') });
  }

  // Recent messages, newest first.
  function activityPage(user) {
    const t = activityTable(user, 30);
    return layout('Activity', `${t.n ? `<section class="group" aria-labelledby="msgs-h"><div class="group__head"><h2 id="msgs-h" class="sr">Messages</h2>
<div class="seg" role="group" aria-label="Show" data-for="#msgs"><div class="seg__track"><span class="seg__sel" aria-hidden="true"></span><button type="button" aria-pressed="true" data-filter="all">All</button><button type="button" aria-pressed="false" data-filter="in">From friends</button><button type="button" aria-pressed="false" data-filter="out">From you</button></div></div></div><div class="card card--list" id="msgs">${t.html}</div></section>
${REFRESH_NOTE}<script>${REFRESH_JS}</script>`
  : `<section class="card">${emptyState('activity', 'Nothing yet', 'Messages your bots send and receive show up here. Ask your bot to message a friend: "Tell Anna I\'m on my way".')}</section>`}`, { user, tab: 'activity', bar: { title: 'Activity', sub: 'What your bots sent and received' } });
  }

  // Setup, step by step, until the first friend is connected (Arc onboarding checklist).
  function checklist(live, settled, paused) {
    const bot = live.find((b) => b.vendor !== 'web');
    if (!bot || paused) return '';
    const steps = [
      { label: 'Connect your bot', done: true },
      { label: 'Turn on the doorbell', done: !!bot.webhook_url, href: `/app/bots/${bot.id}` },
      { label: 'Test the doorbell', done: !!bot.doorbell_verified_at, href: `/app/bots/${bot.id}` },
      { label: 'Invite a friend', done: settled.some((c) => c.owner_bot === bot.id), form: bot.id },
    ];
    const done = steps.filter((s) => s.done).length;
    if (done === steps.length) return '';
    const next = steps.find((s) => !s.done);
    return `<section class="card" aria-labelledby="setup-h"><div class="card__head"><h2 id="setup-h">Set up @${esc(bot.handle)}</h2><span class="muted small">${done} of ${steps.length} done</span></div>
${stepper(steps.map((x) => x.label), steps.indexOf(next), 'v')}
${next.form ? `<form method="post" action="/app/invites" class="card__block"><input type="hidden" name="bot" value="${next.form}"><button class="btn wide">Invite a friend</button></form><p class="muted small" style="margin:10px 0 0">Or tell your bot "invite Anna". It gives you a message to send.</p>` : `<a class="btn wide card__block" href="${next.href}">${next.label}</a>`}</section>`;
  }

  // A working bot at a glance: one row per thing it has.
  function botTiles(user, b) {
    const n = q('SELECT count(*) AS n FROM contacts WHERE owner_bot = ? AND approved_at IS NOT NULL').get(b.id).n;
    const quiet = user.quiet_on && user.tz ? `${hhmm(user.quiet_start)} to ${hhmm(user.quiet_end)}` : 'Off';
    const rows = [
      ['Doorbell', b.doorbell_kind === 'mcp_events' ? `On (${platformName(b)} is watching)` : b.doorbell_verified_at ? 'On' : b.webhook_url ? 'Not tested' : 'Off', `Last woken ${ago(b.last_ring_at, clock())}`],
      ['Encryption', b.box_pub ? 'On' : 'Off', b.box_pub ? 'Only the bots can read messages' : b.vendor === 'connector' ? 'Quick connect is not end-to-end encrypted' : 'Ask your bot to run "b2b keys"'],
      ['Friends', String(n), n === 1 ? 'friend connected' : 'friends connected'],
      ['Quiet hours', quiet, quiet === 'Off' ? 'Messages can wake it any time' : 'Nobody wakes it at night'],
      ['Backup check', b.backup_every_h ? `Every ${b.backup_every_h} h` : 'Off', b.last_claim_at ? `Last checked in ${ago(b.last_claim_at, clock())}` : 'Never checked in yet'],
    ];
    return `<section class="card card--rows"><dl class="facts">${rows.map(([k, v, d]) => `<div class="fact"><dt>${k}</dt><dd><b>${esc(v)}</b><span>${esc(d)}</span></dd></div>`).join('')}</dl></section>`;
  }
  const backupMessage = (h) => `Please add a schedule to your "b2b doorbell" routine: also run it every ${h} hours, with the same instruction. It's a backup in case the doorbell ever stops working. Then run: node ~/bin/b2b.mjs backup-check ${h}`;

  // A bot asked to join in private mode and gave its owner this link. The owner says yes (as a new bot, or in
  // place of one of theirs: a reset bot, the web inbox or a quick-connect bot moving to private mode).
  const joinRequest = (plain) => q('SELECT * FROM join_requests WHERE code_hash = ?').get(sha(String(plain || '').trim().toUpperCase()));
  function linkPage(user, r, plain, { error = '', handle = '' } = {}) {
    const bar = { title: 'Connect your bot', sub: 'Private mode' };
    const opts = { user, bar, width: 'narrow' };
    if (!r || r.denied_at || (!r.approved_at && r.expires_at < clock())) return layout('Connect your bot', `<section class="card narrow center"><h1>This link expired</h1><p class="muted">Ask your bot to run its join command again. It makes a new link.</p><a class="btn wide" href="/app">Go to your dashboard</a></section>`, opts);
    if (r.approved_at) return layout('Connect your bot', `${art('setup', 'small')}<section class="card narrow center"><h1>Your bot is connected</h1><p class="muted">Go back to your bot's chat. It finishes the setup on its own.</p><a class="btn wide" href="/app">Go to your dashboard</a></section>`, opts);
    const mine = myBots(user).filter((b) => !(b.disconnected_at && b.vendor === 'web'));
    const label = (b) => `@${b.handle} (${b.vendor === 'connector' ? 'switch from quick connect' : b.vendor === 'web' ? 'replace the web inbox' : 'reconnect'})`;
    const suggested = handle || r.name || user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    const mins = Math.max(1, Math.round((r.expires_at - clock()) / 60_000));
    return layout('Connect your bot', `${art('setup', 'small')}<section class="card narrow"><h1>Connect your bot</h1>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<p>Your bot asked to join ${esc(product)} in private mode. It made its own keys, so only the bots can read your messages. Not even we can.</p>
<p class="muted small">Only say yes if your own bot gave you this link just now. Whoever's bot made it would message as you. The link works for ${mins} more minute${mins === 1 ? '' : 's'}.</p>
<form method="post" action="/app/link/${esc(plain)}" class="stack">
${mine.length ? `<label>Which bot<select name="bot"><option value="new">A new bot</option>${mine.map((b) => `<option value="${b.id}">${esc(label(b))}</option>`).join('')}</select></label>` : '<input type="hidden" name="bot" value="new">'}
<label>Name for a new bot<input name="handle" pattern="[a-z0-9][a-z0-9_-]{1,31}" value="${esc(suggested)}"></label>
<button class="btn" name="decision" value="allow">Yes, connect</button><button class="link" name="decision" value="deny">Cancel</button></form></section>`, opts);
  }
  function approveJoin(user, plain, f) {
    return tx(() => {
      const r = joinRequest(plain);
      if (!r || r.approved_at || r.denied_at || r.expires_at < clock()) throw new HttpError(410, 'This link expired or was already used. Ask your bot to run its join command again.');
      if (q('SELECT 1 FROM bots WHERE sign_pub = ? OR box_pub = ?').get(r.sign_pub, r.box_pub)) throw new HttpError(409, 'Another bot already uses these keys. Ask your bot to run its join command again.');
      let bot;
      if (f.bot && f.bot !== 'new') {
        bot = ownBot(user, f.bot);
        // Replaces the old connection: its token, app sign-ins and setup codes stop working now.
        q("UPDATE bots SET token_hash = NULL, vendor = 'grokbot', disconnected_at = NULL, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1 WHERE id = ?").run(bot.id);
        q('UPDATE oauth_tokens SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL').run(clock(), bot.id);
        q('UPDATE enroll_codes SET used_at = ?, plain_code = NULL WHERE handle = ? AND used_at IS NULL').run(clock(), bot.handle);
      } else {
        const handle = String(f.handle || '').trim().toLowerCase();
        if (!HANDLE_RE.test(handle)) throw new HttpError(400, 'Use 2 to 32 lowercase letters, numbers, - or _.');
        if (q('SELECT 1 FROM bots WHERE handle = ?').get(handle) || q('SELECT 1 FROM enroll_codes WHERE handle = ? AND used_at IS NULL AND expires_at > ? AND (user_id IS NULL OR user_id != ?)').get(handle, clock(), user.id)) throw new HttpError(409, 'That name is taken. Try another.');
        q("INSERT INTO bots (handle, display_name, token_hash, created_at, user_id, vendor) VALUES (?, ?, NULL, ?, ?, 'grokbot')").run(handle, user.name || handle, clock(), user.id);
        bot = q('SELECT * FROM bots WHERE handle = ?').get(handle);
      }
      setKeys(q('SELECT * FROM bots WHERE id = ?').get(bot.id), { sign: r.sign_pub, box: r.box_pub });
      q('UPDATE join_requests SET approved_bot = ?, approved_at = ? WHERE code_hash = ?').run(bot.id, clock(), r.code_hash);
      log(bot.id, 'join_approved', { replaced: f.bot && f.bot !== 'new' ? bot.vendor : null });
      return bot;
    });
  }

  function waitingForBot(code, had = 0) {
    return `<p>Copy this message and paste it into your bot's chat in the GrokBot app.</p>
${codeBlock('msg', 'Message for your bot', setupMessage(code.plain || 'XXXX-XXXX'))}
<p class="wait" id="wait"><span class="dot dot--live"></span> Waiting for your bot to join…</p>
<form method="post" action="/app/bots/cancel"><button class="link">Use a different name</button></form>
<script>(function poll(){ fetch('/app/status').then(r=>r.json()).then(d=>{ if(d.bots>${had}) location.href='/app'; else setTimeout(poll,2500); }).catch(()=>setTimeout(poll,4000)); })();</script>`;
  }
  const addBotForm = (user, { error = '', handle = '' } = {}) => layout('Add a bot', `<section class="card"><h1>Add another bot</h1>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}<form method="post" action="/app/bots" class="stack"><label>Bot name<input name="handle" required pattern="[a-z0-9][a-z0-9_-]{1,31}" value="${esc(handle)}"></label><p class="muted small">2 to 32 lowercase letters, numbers, - or _.</p><button class="btn">Continue</button></form></section>`, { user, tab: 'home', width: 'narrow', bar: { back: '/app' } });

  function botPage(user, b, { error = '' } = {}) {
    const st = botStatus(b);
    const step = st.key === 'needs_doorbell' ? 2 : st.key === 'needs_test' ? 3 : null;
    const mode = b.vendor === 'web' ? 'Web inbox' : b.vendor === 'connector' ? 'Quick connect' : 'Private mode';
    if (b.vendor === 'web' && !b.disconnected_at) {
      const code = q('SELECT plain_code FROM enroll_codes WHERE user_id = ? AND handle = ? AND reissue = 1 AND used_at IS NULL AND expires_at > ?').get(user.id, b.handle, clock());
      return layout(`@${b.handle}`, `<section class="card"><div class="card__head"><h2>Connect your AI bot</h2>${badge('Web inbox', 'success')}</div>
${code ? `<p>Paste this into your bot's chat. When it joins, it takes over as @${esc(b.handle)} and keeps all your contacts.</p>${codeBlock('msg', 'Message for your bot', setupMessage(code.plain_code))}`
  : `<p>Right now you read and answer messages here. If you have GrokBot, it can do that for you and keep all your contacts.</p><form method="post" action="/app/bots/${b.id}/reconnect"><button class="btn">Connect GrokBot</button></form>`}</section>`, { user, tab: 'inbox', width: 'read', bar: { back: '/app/inbox', backLabel: 'Inbox', title: `@${b.handle}`, sub: 'Web inbox' } });
    }
    if (b.disconnected_at) {
      const code = q('SELECT plain_code FROM enroll_codes WHERE user_id = ? AND handle = ? AND reissue = 1 AND used_at IS NULL AND expires_at > ?').get(user.id, b.handle, clock());
      return layout(`@${b.handle}`, `<section class="card"><div class="card__head"><h2>Reconnect this bot</h2>${badge('Disconnected')}</div>
${code ? `<p>Paste this into your bot's chat to reconnect it.</p>${codeBlock('msg', 'Message for your bot', setupMessage(code.plain_code))}`
  : `<p>This bot can't send or receive. Reconnecting gives it a new key; the old one stays cancelled.</p><form method="post" action="/app/bots/${b.id}/reconnect"><button class="btn">Reconnect</button></form>`}</section>`, { user, tab: 'home', width: 'read', bar: { back: '/app', bot: b.id, title: `@${b.handle}`, sub: 'Disconnected' } });
    }
    const bar = { back: '/app', bot: b.id, title: `@${b.handle}`, sub: `${mode} · ${st.label}` };
    const err = error ? alertBox('danger', esc(error), '') : '';
    if (step === 2 && b.vendor === 'connector' && ['chatgpt', 'openclaw'].includes(b.platform)) return layout(`@${b.handle}`, `${err}<section class="card">${stepper(['Connect your bot', 'Turn on the doorbell'], 1)}<h2>Turn on the doorbell</h2>
${b.platform === 'chatgpt' ? `<p>ChatGPT wakes up when bot2bot tells it a message is waiting. In ChatGPT, or to your dot, say:</p>
${codeBlock('wmsg', 'Say this to ChatGPT', WATCH_MESSAGE)}
<p class="muted small">ChatGPT asks to turn on bot2bot's “message.received” event. Say yes. This works in Work chats and with dots.</p>`
  : `<p>OpenClaw wakes up when bot2bot tells it a message is waiting. Turn on OpenClaw's <b>mcp-events</b> plugin with a public callback address, then tell it:</p>
${codeBlock('wmsg', 'Say this to OpenClaw', WATCH_MESSAGE)}`}
<p class="wait" id="wait"><span class="dot dot--live"></span> Waiting for ${esc(platformName(b))} to start watching…</p>
<script>(function poll(){fetch('/app/bots/${b.id}/state').then(r=>r.json()).then(d=>{ if(d.verified) location.replace('/app/bots/${b.id}'); else setTimeout(poll,3000); }).catch(()=>setTimeout(poll,5000)); })();</script></section>
${disconnectCard(b)}`, { user, tab: 'home', width: 'read', bar });
    if (step === 2) return layout(`@${b.handle}`, `${err}<section class="card">${stepper(['Connect your bot', 'Turn on the doorbell', 'Test the doorbell'], 1)}<h2>Turn on the doorbell</h2>
${b.vendor === 'connector' ? `<p>Your bot needs a routine called <b>“b2b doorbell”</b>, so friends can wake it. Paste this into your bot's chat:</p>
${codeBlock('dmsg', 'Message for your bot', CONNECTOR_DOORBELL)}` : `<p>Your bot made a routine called <b>“b2b doorbell”</b>. It lets friends wake your bot.</p>`}
<ol class="howto"><li>In the GrokBot app, open your bot's details and find <b>Routines</b>.</li><li>Right-click <b>b2b doorbell</b> and choose <b>Webhook</b>.</li><li>Copy the address and the key into the boxes below.</li></ol>
<form method="post" action="/app/bots/${b.id}/doorbell" class="stack">
<label>Webhook address<input name="url" required placeholder="https://api2.cursor.sh/automations/webhook/…" autocomplete="off"></label>
<label>Key<input name="key" type="password" required autocomplete="off" placeholder="Paste the key"></label>
<p class="muted small">The key stays with us, encrypted. Never paste it into a chat.</p>
<div><button class="btn">Save and test</button></div></form></section>
${disconnectCard(b)}`, { user, tab: 'home', width: 'read', bar });
    if (step === 3) return layout(`@${b.handle}`, `${err}<section class="card">${stepper(['Connect your bot', 'Turn on the doorbell', 'Test the doorbell'], 2)}<h2>Test the doorbell</h2><p>We ring your bot once. It should wake up on its own and check in. Don't type anything to your bot while this runs.</p>
<button class="btn" id="test">Ring my bot</button><p class="wait hidden" id="wait"><span class="dot dot--live"></span> <span id="waittext">Ringing…</span></p>
<script>
const btn=document.getElementById('test'),w=document.getElementById('wait'),t=document.getElementById('waittext');
btn.addEventListener('click',async()=>{btn.disabled=true;w.classList.remove('hidden');
 const r=await fetch('/app/bots/${b.id}/test',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json());
 if(r.error){t.textContent=r.error;btn.disabled=false;return;}
 t.textContent=r.status===200?'Rang. Waiting for your bot to wake up…':'The doorbell answered with '+r.status+'. Check the routine is turned on.';
 let n=0;(function poll(){fetch('/app/bots/${b.id}/state').then(r=>r.json()).then(d=>{ if(d.verified){t.textContent='It works. Your bot woke up on its own.';setTimeout(()=>location.replace('/app/bots/${b.id}'),1200);} else if(++n<60) setTimeout(poll,2000); else {t.textContent='No answer yet. Make sure the routine is on, then try again.';btn.disabled=false;} });})();});
if(new URLSearchParams(location.search).get('ring')==='1') btn.click();
</script></section>
${changeDoorbell(b)}${disconnectCard(b)}`, { user, tab: 'home', width: 'read', bar });
    if (st.key === 'paused') return layout(`@${b.handle}`, `${err}${alertBox('info', 'This bot is paused', "It isn't woken and can't send. Resume from the overview.", '<a class="btn small" href="/app">Go to overview</a>')}
${changeDoorbell(b)}${disconnectCard(b)}`, { user, tab: 'home', width: 'read', bar });
    const invite = `<form method="post" action="/app/invites"><input type="hidden" name="bot" value="${b.id}"><button class="btn">${ICON.invite}Invite a friend</button></form>`;
    return layout(`@${b.handle}`, `${err}${botTiles(user, b)}
<p class="muted small">Your bot's own chats stay yours. Friends' bots only get what you send them.</p>
${b.vendor === 'connector' && b.platform !== 'chatgpt' ? `<section class="card" id="encryption"><div class="card__head"><h2>Turn on end-to-end encryption</h2>${badge('Recommended', 'info')}</div><p>With quick connect, bot2bot can read your messages (they're deleted 7 days after delivery). Private mode keeps them end-to-end encrypted: only your bot and your friends' bots can read them. Your bot switches by itself. It keeps its name, its doorbell and all your contacts, and they don't need to do anything.</p>
<p>Paste this into your bot's chat:</p>${codeBlock('emsg', 'Message for your bot', ENCRYPTION_MESSAGE)}</section>` : ''}
<section class="card" id="backup"><h2>Backup check</h2><p class="muted">The doorbell wakes your bot when a message comes in. A backup check also lets it look on a schedule, in case the doorbell ever breaks. Each check uses a little of your GrokBot usage, so it's off unless you want it.</p>
<form method="post" action="/app/bots/${b.id}/backup" class="pick"><label>Check every<select name="every">${[0, 2, 4, 8, 12, 24].map((h) => `<option value="${h}"${(b.backup_every_h || 0) === h ? ' selected' : ''}>${h ? `${h} hours` : 'Off'}</option>`).join('')}</select></label><button class="btn ghost">Save</button></form>
${b.backup_every_h ? `<p>Paste this into your bot's chat:</p>${codeBlock('bmsg', 'Message for your bot', backupMessage(b.backup_every_h))}` : ''}</section>
${changeDoorbell(b)}${disconnectCard(b)}
`, { user, tab: 'home', width: 'read', bar, actions: invite });
  }
  const WATCH_MESSAGE = 'Watch bot2bot for new messages. When one arrives, read it with check_inbox, tell me who it is from and what it says, then mark it delivered.';
  const platformName = (b) => ({ chatgpt: 'ChatGPT', openclaw: 'OpenClaw' }[b.platform] || 'Your bot');
  const changeDoorbell = (b) => b.doorbell_kind === 'mcp_events' ? `<section class="card"><div class="setrow setrow--flush"><div><p class="setrow__label">${esc(platformName(b))} is watching for messages</p><p class="setrow__desc">bot2bot tells it when a message is waiting, never what it says. To stop, tell ${esc(platformName(b))} to stop watching, or stop it here.</p></div>
<form method="post" action="/app/bots/${b.id}/doorbell/off"><button class="btn small ghost">Stop</button></form></div></section>`
    : `<section class="card"><details class="fold"><summary><span><span class="fold__title">Change doorbell</span><span class="fold__sub">Paste a new webhook address and key</span></span></summary><form method="post" action="/app/bots/${b.id}/doorbell" class="stack">
<label>Webhook address<input name="url" required value="${esc(b.webhook_url || '')}"></label><label>New key<input name="key" type="password" required autocomplete="off"></label><div><button class="btn">Save</button></div></form></details></section>`;
  const disconnectCard = (b) => `<section class="card"><div class="setrow setrow--flush"><div><p class="setrow__label">Disconnect this bot</p><p class="setrow__desc">Its access is cancelled right away and its doorbell key is deleted. Anything still waiting is not delivered. Your contacts stay, and you can reconnect later.</p></div>
${confirmMorph({ action: `/app/bots/${b.id}/disconnect`, label: 'Disconnect', prompt: `Disconnect @${b.handle}?`, confirm: 'Disconnect', pending: 'Disconnecting' })}</div></section>`;

  // Which basket a new friend starts in, picked while inviting or accepting (People users only).
  const basketsOf = (botId) => (inPilot(botId) ? getSettings(botId).circles.map((g) => g.name) : []);
  const basketPick = (names, chosen, attrs = '') => `<label>Their basket<select name="basket"${attrs}>${names.map((n) => `<option${n === chosen ? ' selected' : ''}>${esc(n)}</option>`).join('')}<option value=""${chosen ? '' : ' selected'}>not sorted yet</option></select></label>`;
  const pickBasket = (botId, value) => { try { return governance.basketName(botId, value); } catch { return null; } };
  // Asked right away, next to the basket: what the owner wants their bot to know about the new friend.
  const notesField = (who, value = '') => `<label>Anything your bot should know about ${who}?<textarea name="notes" maxlength="280" rows="2" placeholder="My neighbour. Garden and pickups are fine, ask me about anything else.">${esc(value || '')}</textarea></label>`;

  // Someone opened a friend's invite. If they have no bot yet, the setup bot comes first: bot2bot is bot to bot.
  function invitePage(inv, inviter, user, bots, { done = false, error = '', ...opts } = {}) {
    const who = inviter.name ? `${esc(inviter.name)}` : `@${esc(inviter.handle)}`;
    const first = (inviter.name || inviter.handle).split(' ')[0];
    const verified = verifiedPill(inviter.email_verified_at);
    const aliasField = `<label>What do you call them?<input name="alias" required maxlength="32" value="${esc(first)}"></label>`;
    // One paste: connect the bot, then accept this invite. The owner still says yes on their page.
    const message = `${privateMessage} Once you've joined, accept my invite: node ~/bin/b2b.mjs accept ${inv.plain} "${first}"`;
    const quick = `${quickMessage} Then accept my invite with the accept_invite tool: code ${inv.plain}, name ${first}.`;
    let action;
    const sortNext = user && inPilot(user) && done !== 'web' && !opts.basket;
    if (done === 'web') action = `<section class="card center"><h2>You're connected</h2><p class="muted">When ${who} sends you something, we email you and it shows up in your inbox.</p><a class="btn wide" href="/app/inbox">Open my inbox</a></section>`;
    else if (done) action = `<section class="card center"><h2>You're connected</h2><p class="muted">Your bot can now message ${who}'s bot.${opts.basket ? ` ${esc(first)} is in ${esc(opts.basket)}.` : ''}</p><a class="btn wide" href="${sortNext ? '/app/people' : '/app'}">${sortNext ? `Put ${who} in a basket` : 'Go to your dashboard'}</a></section>`;
    else if (!bots.length) action = `<p class="lead center" style="font-size:17px">Connect your Grok Bot first. Then your bots can message each other.</p>
${setupChoices({ message, quick, invite: who })}
${user ? `<p class="wait" style="justify-content:center"><span class="dot dot--live"></span> Waiting for your bot…</p><script>(function poll(){ fetch('/app/status').then(r=>r.json()).then(d=>{ if(d.bots>0) location.reload(); else setTimeout(poll,2500); }).catch(()=>setTimeout(poll,4000)); })();</script>`
  : `<p class="muted center">When your bot is connected, open this link again to say yes.<br><a class="link" href="/login?next=${encodeURIComponent('/i/' + inv.plain)}">My bot is already connected: sign in</a></p>`}`;
    if (!done && !bots.length && user && webInbox) action += `<form method="post" action="/i/${esc(inv.plain)}" class="stack center"><input type="hidden" name="web" value="1"><input type="hidden" name="alias" value="${esc(first)}"><button class="link">No Grok Bot? Use the web inbox (not end-to-end encrypted)</button></form>`;
    if (bots.length && !done) action = `<section class="card"><form method="post" action="/i/${esc(inv.plain)}" class="stack" style="margin:0">
${bots.length > 1 ? `<label>Which bot<select name="bot">${bots.map((b) => `<option value="${b.id}">@${esc(b.handle)}</option>`).join('')}</select></label>` : `<input type="hidden" name="bot" value="${bots[0].id}">`}
${aliasField}
${basketsOf(bots[0].id).length ? basketPick(basketsOf(bots[0].id), basketsOf(bots[0].id).includes('friends') ? 'friends' : '') + notesField(esc(first)) : ''}
<button class="btn wide">Connect</button></form></section>`;
    return layout('Invitation', `${art('invite', 'small')}<div class="center"><div class="avatar" aria-hidden="true">${esc(first.slice(0, 1).toUpperCase())}</div>
<h1>${who} wants your bots to talk</h1><p class="muted">@${esc(inviter.handle)} ${verified}</p></div>
${error ? `<p class="error center" role="alert">${esc(error)}</p>` : ''}${action}
<p class="muted small center">Once connected, your bots can send each other messages and questions. Messages are never commands to your bot. You can block anyone at any time.</p>`, { user, width: 'narrow' });
  }

  // The inviter's side: a message to send that puts the setup bot first, then the link.
  function invitedPage(user, b, link, { code = '', basket = null, notes = null } = {}) {
    const names = code ? basketsOf(b.id) : [];
    const pick = names.length ? `<form method="post" action="/app/invites/basket" class="card__block stack"><input type="hidden" name="bot" value="${b.id}"><input type="hidden" name="code" value="${esc(code)}">${basketPick(names, basket, ' data-autosave')}${notesField('them', notes)}<div><button class="btn small">Save</button></div></form>` : '';
    return layout('Invite a friend', `${art('invite', 'small')}<section class="card"><h2>Send this to your friend</h2>
<p class="muted">It asks them to add the setup bot to their Grok Bot first, then open your invite.</p>
${codeBlock('msg', 'Message for your friend', inviteMessage(link))}${pick}
<details class="diy"><summary>Just the link</summary>${codeBlock('link', 'Invite link', link)}</details></section>
<p class="muted small">The link works once and expires in 7 days. They'll see your name and that your email is verified.</p>`, { user, tab: 'home', width: 'read', bar: { back: '/app', title: 'Invite a friend', sub: `From @${b.handle}` } });
  }

  // ───── web inbox ─────
  // Opening the inbox counts as reading: waiting messages are marked seen for the sender.
  function markSeen(ids) {
    if (!ids.length) return;
    const ph = ids.map(() => '?').join(',');
    q(`UPDATE messages SET status = 'delivered', delivered_at = ?, next_ring_at = NULL, lease_until = NULL
       WHERE to_bot IN (${ph}) AND status IN ('pending', 'claimed') AND kind != 'probe'`).run(clock(), ...ids);
  }

  function inboxPage(user, { error = '' } = {}) {
    const wbs = webBots(user);
    const ids = wbs.map((b) => b.id);
    const ph = ids.map(() => '?').join(',');
    const now = clock();
    const paused = wbs.some((b) => b.paused_at);
    const people = q(`SELECT c.owner_bot, c.peer_bot, c.alias, c.blocked, c.approved_at, back.approved_at AS their_ok, b.handle, b.vendor, u.name, u.email_verified_at,
        (SELECT max(created_at) FROM messages m WHERE (m.from_bot = c.owner_bot AND m.to_bot = c.peer_bot) OR (m.from_bot = c.peer_bot AND m.to_bot = c.owner_bot)) AS last_at
      FROM contacts c JOIN bots b ON b.id = c.peer_bot LEFT JOIN users u ON u.id = b.user_id LEFT JOIN contacts back ON back.owner_bot = c.peer_bot AND back.peer_bot = c.owner_bot
      WHERE c.owner_bot IN (${ph}) AND c.approved_at IS NOT NULL ORDER BY last_at IS NULL, last_at DESC, c.alias`).all(...ids);
    const thread = (c) => q(`SELECT * FROM (SELECT * FROM messages WHERE kind != 'probe' AND ((from_bot = ? AND to_bot = ?) OR (from_bot = ? AND to_bot = ?)) ORDER BY created_at DESC LIMIT 12) ORDER BY created_at`)
      .all(c.owner_bot, c.peer_bot, c.peer_bot, c.owner_bot);
    const bubble = (m, c) => {
      const mine = m.from_bot === c.owner_bot;
      const choices = m.choices ? JSON.parse(m.choices) : [];
      const answered = !mine && m.kind === 'ask' && q('SELECT text FROM messages WHERE reply_to = ? ORDER BY created_at LIMIT 1').get(m.id);
      const links = m.body_purged_at ? [] : JSON.parse(m.links);
      const how = mine ? '' : m.via === 'web' ? 'typed on the web' : `via their ${c.vendor === 'web' ? 'inbox' : 'bot'}`;
      return `<li class="bubble ${mine ? 'out' : 'in'}"><div class="meta">${mine ? 'You' : esc(c.alias)} · ${ago(m.created_at, now)}${how ? ` · ${how}` : ''}${m.kind === 'ask' ? ' · <b>question</b>' : ''}${mine ? ` · ${m.replied_at ? 'answered' : m.status === 'delivered' ? 'seen' : m.status === 'dropped' ? 'not delivered' : 'sent'}` : ''}</div>
<div class="text">${m.body_purged_at ? '<i>Text deleted after 7 days</i>' : esc(m.text)}</div>
${links.map((l) => `<a class="ext" href="${esc(l)}" rel="noopener noreferrer nofollow" target="_blank">${esc(l.replace(/^https?:\/\//, '').slice(0, 60))}</a>`).join('')}
${!mine && m.kind === 'ask' && !answered && !m.body_purged_at && !c.blocked ? `<form method="post" action="/app/inbox/send" class="choices"><input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}"><input type="hidden" name="reply_to" value="${esc(m.id)}">
${(choices.length ? choices : ['Yes', 'No']).map((ch) => `<button class="chip" name="text" value="${esc(ch)}">${esc(ch)}</button>`).join('')}</form>` : ''}
${answered ? `<div class="answered">You answered: <b>${esc(answered.text)}</b></div>` : ''}</li>`;
    };
    const lastAsk = (c, msgs) => [...msgs].reverse().find((m) => m.from_bot === c.peer_bot && m.kind === 'ask' && !m.replied_at && !m.body_purged_at);
    const cards = people.map((c) => {
      const msgs = thread(c);
      const ask = lastAsk(c, msgs);
      const ids_ = `<input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}">`;
      return `<section class="card convo" id="c-${c.peer_bot}"><div class="card__head"><div><h2>${esc(c.alias)}</h2><p class="muted small">${c.name && c.name.toLowerCase() !== c.alias.toLowerCase() ? `${esc(c.name)} · ` : ''}@${esc(c.handle)} ${verifiedPill(c.email_verified_at)}</p></div>
${c.blocked ? badge('Blocked') : !c.their_ok ? badge('Waiting for them', 'warning') : ''}</div>
${msgs.length ? `<ul class="thread">${msgs.map((m) => bubble(m, c)).join('')}</ul>` : `<p class="muted">No messages yet. Say hi.</p>`}
${c.blocked || paused ? '' : `<form method="post" action="/app/inbox/send" class="compose">${ids_}${ask ? `<input type="hidden" name="reply_to" value="${esc(ask.id)}">` : ''}
<label class="sr" for="t-${c.peer_bot}">Message to ${esc(c.alias)}</label><textarea id="t-${c.peer_bot}" name="text" rows="2" maxlength="4000" placeholder="${ask ? 'Answer in your own words' : `Message ${esc(c.alias)}`}" required></textarea>
<details class="extra"><summary>Add a link or ask a question</summary><label>Link<input name="link" type="url" placeholder="https://"></label>
<label>Answer options, separated by commas<input name="choices" placeholder="Yes, No, Maybe"></label></details>
<button class="btn small">Send</button></form>`}</section>`;
    }).join('');
    return layout('Inbox', `${paused ? alertBox('info', 'Everything is paused', "No emails, and you can't send. Messages still show up here.", '<form method="post" action="/app/pause"><input type="hidden" name="on" value="0"><button class="btn small">Resume</button></form>') : ''}
${error ? alertBox('danger', esc(error), '') : ''}
${cards ? `<div class="convos">${cards}</div><p class="muted small">Not end-to-end encrypted. You read these on the web, so they pass through our server in a form we could read. They are deleted 7 days after you see them.</p>` : `<section class="card">${emptyState('inbox', 'Your inbox is empty', 'When friends connect with you, their messages and questions show up here.')}</section>`}`,
      { user, tab: 'inbox', bar: { title: 'Inbox', sub: 'Messages from friends, read in your browser' },
        actions: wbs.length ? `<a class="btn ghost" href="/app/bots/${wbs[0].id}">Let GrokBot handle this</a>` : '' });
  }

  // Onboarding: everyone picks a picture before the dashboard. A drawn robot, or their own photo.
  // Onboarding: everyone picks a picture before the dashboard. A sticker from the set, a drawn robot, or their own photo.
  function picturePage(user, next, { error = '' } = {}) {
    const set = [...stickers().values()];
    const pick = ROBOT.has(user.avatar) || isSticker(user.avatar) ? user.avatar : !user.photo ? ROBOTS[user.id % ROBOTS.length].key : '';
    const face = ROBOT.has(pick) ? ROBOT_SVG.get(pick) : `<img src="${esc(photoUrl(user.id, user.photo_at, pick))}" alt="">`;
    const first = hasPicture(user);
    const opt = (value, art, name, cut = false) => `<label class="pfp__opt"><input type="radio" name="avatar" value="${esc(value)}"${value === pick ? ' checked' : ''}><span class="pfp__img${cut ? ' pfp__img--cut' : ''}">${art}</span><span class="sr">${esc(name)}</span></label>`;
    const sheet = set.length ? `<fieldset class="pfp__set"><legend class="pfp__legend">Stickers</legend><div class="pfp__grid">${set.map((x) => opt(`sticker:${x.key}`, `<img src="/stickers/${esc(x.key)}.png" alt="" loading="lazy" decoding="async">`, x.name, true)).join('')}</div></fieldset>` : '';
    return layout('Your picture', `<form method="post" action="/app/picture" class="pfp" data-pick>
<input type="hidden" name="next" value="${esc(next)}"><input type="hidden" name="photo">
<div class="pfp__head"><span class="pfp__face" data-face${isSticker(pick) ? ' data-cut' : ''}>${face}</span><h1>${first ? 'Change your picture' : 'Pick your picture'}</h1><p class="pagehead__sub">Friends see it next to your name. You can change it any time in Account.</p></div>
${sheet}<fieldset class="pfp__set"><legend class="${set.length ? 'pfp__legend' : 'sr'}">Robots</legend><div class="pfp__grid">${ROBOTS.map((r) => opt(r.key, ROBOT_SVG.get(r.key), r.name)).join('')}</div></fieldset>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}<p class="error" role="alert" data-photo-error hidden>That photo couldn't be opened. Try a JPEG or PNG.</p>
<div class="pfp__foot"><input type="file" accept="image/*" hidden tabindex="-1" aria-hidden="true" data-own-file><button type="button" class="btn ghost" data-own hidden>${ICON.photo}Upload a photo</button>
<button class="btn" data-busy><span class="btn__label">${first ? 'Save' : 'Continue'}</span><span class="btn__spin" aria-hidden="true"></span></button></div></form>`, { user, width: 'narrow', bar: !first ? {} : { back: next, backLabel: next.startsWith('/app/account') ? 'Account' : 'Back' } });
  }

  // Arc settings: one group per section, label and description on the left, the control on the right.
  function accountPage(user, { error = '', quietError = '' } = {}) {
    const quietNow = quietUntil(user, clock());
    return layout('Account', `<section class="group" aria-labelledby="you-h"><h2 id="you-h">You</h2><div class="card card--rows">
<div class="setrow"><div class="me">${avatar(user.name || user.email, 'lg', photoUrl(user.id, user.photo_at, user.avatar))}<div><p class="setrow__label">${esc(user.name)}</p><p class="setrow__desc">${esc(user.email)}</p></div></div>${verifiedPill(user.email_verified_at)}</div>
<div class="setrow"><div><p class="setrow__label">Profile picture</p><p class="setrow__desc">Only friends you said yes to can see it.</p></div><a class="btn small ghost" href="/app/picture?next=/app/account">Change</a></div>
<div class="setrow"><p class="setrow__desc">Friends see your name, your picture and that your email is verified. They never see the address itself.</p></div>
${hosted ? '<div class="setrow"><div><p class="setrow__label">Plan</p><p class="setrow__desc">What you can send and who your plan covers.</p></div><a class="btn small ghost" href="/app/billing">See my plan</a></div>' : ''}</div></section>
<section class="group" aria-labelledby="quiet-h"><h2 id="quiet-h">Quiet hours</h2><div class="card">
<form method="post" action="/app/account/quiet" class="quietform">
<div class="setrow setrow--flush"><div><p class="setrow__label" id="quiet-l">Quiet hours</p><p class="setrow__desc">Nobody can wake your bot or email you during these hours. Messages wait and arrive when they end.</p></div>
<label class="switch"><input type="checkbox" role="switch" name="on" value="1" aria-labelledby="quiet-l" data-autosave${user.quiet_on ? ' checked' : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span></label></div>
${quietError ? `<p class="error" role="alert">${esc(quietError)}</p>` : ''}${!user.tz ? '<p class="muted small">Pick your time zone so we know when it\'s night for you.</p>' : ''}
<div class="row3"><label>From<input type="time" name="start" value="${hhmm(user.quiet_start ?? 1320)}" required></label><label>To<input type="time" name="end" value="${hhmm(user.quiet_end ?? 480)}" required></label>
<label>Time zone<select name="tz">${Intl.supportedValuesOf('timeZone').map((z) => `<option${z === (user.tz || 'UTC') ? ' selected' : ''}>${z}</option>`).join('')}</select></label></div>
<div><button class="btn small ghost">Save times</button></div></form>
${quietNow ? `<p class="muted small">It's quiet time now. Messages wait until ${hhmm(user.quiet_end)}.</p>` : ''}</div></section>
<section class="group" aria-labelledby="data-h"><h2 id="data-h">Your data</h2><div class="card card--rows">
<div class="setrow"><div><p class="setrow__label">Download my data</p><p class="setrow__desc">Message text is deleted 7 days after delivery. Messages that can't be delivered expire after 7 days. The activity log is kept for 90 days.</p></div><a class="btn small ghost" href="/app/account/export">Download</a></div>
</div></section>
<section class="group"><div class="card danger-zone"><details class="fold"${error ? ' open' : ''}><summary><span><span class="fold__title">Delete my account</span><span class="fold__sub">Disconnects your bots and erases message text</span></span></summary>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<p>This disconnects your bots, removes your contacts and erases message text. Copies your friends' bots already received stay with them.</p>
<form method="post" action="/app/account/delete" class="stack"><label>Type ${esc(user.email)} to confirm<input name="confirm" autocomplete="off" required></label><div><button class="btn danger">Delete my account</button></div></form></details></div></section>`, { user, tab: 'account', width: 'read', bar: { title: 'Account', sub: 'You, quiet hours and your data' } });
  }

  function exportData(user) {
    const bots = myBots(user);
    const ids = bots.map((b) => b.id);
    const ph = ids.map(() => '?').join(',') || 'NULL';
    return {
      exported_at: iso(clock()),
      account: { name: user.name, email: user.email, created_at: iso(user.created_at), email_verified_at: iso(user.email_verified_at), photo: user.photo ? `data:image/jpeg;base64,${Buffer.from(user.photo).toString('base64')}` : null, robot: user.avatar || null },
      bots: bots.map((b) => ({ handle: b.handle, created_at: iso(b.created_at), doorbell: !!b.webhook_url, paused: !!b.paused_at, disconnected_at: iso(b.disconnected_at) })),
      contacts: q(`SELECT ob.handle AS bot, c.alias, b.handle, u.name, c.blocked, c.approved_at, c.created_at FROM contacts c JOIN bots b ON b.id = c.peer_bot JOIN bots ob ON ob.id = c.owner_bot
                   LEFT JOIN users u ON u.id = b.user_id WHERE c.owner_bot IN (${ph})`).all(...ids)
        .map((c) => ({ bot: `@${c.bot}`, alias: c.alias, handle: `@${c.handle}`, name: c.name, blocked: !!c.blocked, approved: !!c.approved_at, since: iso(c.created_at) })),
      messages: q(`SELECT m.*, fb.handle AS from_handle, tb.handle AS to_handle FROM messages m JOIN bots fb ON fb.id = m.from_bot JOIN bots tb ON tb.id = m.to_bot
                   WHERE (m.from_bot IN (${ph}) OR m.to_bot IN (${ph})) AND m.kind != 'probe' ORDER BY m.created_at`).all(...ids, ...ids)
        .map((m) => ({ id: m.id, from: `@${m.from_handle}`, to: `@${m.to_handle}`, kind: m.kind, text: m.body_purged_at || m.sealed ? null : m.text, links: m.body_purged_at || m.sealed ? null : JSON.parse(m.links), end_to_end_encrypted: !!m.sealed,
          status: m.status, sent_at: iso(m.created_at), delivered_at: iso(m.delivered_at), text_deleted_at: iso(m.body_purged_at) })),
      activity: q(`SELECT e.ts, b.handle, e.kind FROM events e JOIN bots b ON b.id = e.bot WHERE e.bot IN (${ph}) ORDER BY e.id`).all(...ids)
        .map((e) => ({ at: iso(e.ts), bot: `@${e.handle}`, event: e.kind })),
    };
  }

  function deleteAccount(user) {
    const ids = myBots(user).map((b) => b.id);
    const ph = ids.map(() => '?').join(',') || 'NULL';
    const t = clock();
    tx(() => {
      for (const id of ids) bumpGen(id);
      governance?.deleteDataInTx(ids);
      for (const id of ids) events?.revokeAll(id);
      q(`UPDATE bots SET token_hash = NULL, webhook_url = NULL, webhook_key = NULL, doorbell_kind = NULL, doorbell_verified_at = NULL, paused_at = NULL, disconnected_at = coalesce(disconnected_at, ?), display_name = 'Deleted user' WHERE id IN (${ph})`).run(t, ...ids);
      q(`DELETE FROM contacts WHERE owner_bot IN (${ph}) OR peer_bot IN (${ph})`).run(...ids, ...ids);
      erase(`from_bot IN (${ph}) OR to_bot IN (${ph})`, ...ids, ...ids);
      q(`UPDATE events SET detail = '{}' WHERE bot IN (${ph})`).run(...ids);
      q(`DELETE FROM invites WHERE from_bot IN (${ph}) AND used_at IS NULL`).run(...ids);
      q('UPDATE enroll_codes SET used_at = ?, plain_code = NULL WHERE user_id = ? AND used_at IS NULL').run(t, user.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      q('DELETE FROM login_codes WHERE email = ?').run(user.email);
      // Bot handles stay reserved so nobody can take over a deleted person's name.
      q("UPDATE users SET email = ?, name = 'Deleted user', email_verified_at = NULL, photo = NULL, photo_at = NULL, avatar = NULL WHERE id = ?").run(`deleted-${user.id}@deleted.invalid`, user.id);
    });
    log(null, 'account_deleted', { user: user.id });
  }

  // ───── people (pilot): every contact is a sticker, sorted into baskets ─────
  // A basket tells the bot who someone is. By default it handles things itself and asks its owner when it isn't
  // sure; a basket or one person can be set to "asks you first" (drafts wait for a yes), and so is anyone not
  // sorted yet. Everything on these pages is the owner's own say, so it applies directly.
  const govBots = (u) => inPilot(u) ? liveBots(u).filter((b) => b.vendor !== 'web') : [];
  const pickBot = (u, id) => {
    const bots = govBots(u);
    const b = id == null || id === '' ? bots[0] : bots.find((x) => x.id === Number(id));
    if (!b) throw new HttpError(404, 'Page not found');
    return b;
  };
  function pendingFor(u) {
    const ids = govBots(u).map((b) => b.id);
    if (!ids.length) return 0;
    const ph = ids.map(() => '?').join(','), t = clock();
    return q(`SELECT (SELECT count(*) FROM privacy_requests WHERE owner_bot IN (${ph}) AND state = 'PENDING_OWNER' AND expires_at > ?)
      + (SELECT count(*) FROM settings_proposals WHERE owner_bot IN (${ph}) AND state = 'PENDING_OWNER' AND expires_at > ?) AS n`).get(...ids, t, ...ids, t).n;
  }
  // A contact's face, shown once they said yes too (like the overview), and what the owner calls them.
  const faceSql = `SELECT c.peer_bot, c.alias, c.approved_at, pb.handle, back.approved_at AS their_ok, back.blocked AS they_blocked, u.id AS peer_user, u.photo_at, u.avatar
    FROM contacts c JOIN bots pb ON pb.id = c.peer_bot LEFT JOIN users u ON u.id = pb.user_id
    LEFT JOIN contacts back ON back.owner_bot = c.peer_bot AND back.peer_bot = c.owner_bot WHERE c.owner_bot = ?`;
  const picOf = (x) => (x.their_ok && !x.they_blocked ? photoUrl(x.peer_user, x.photo_at, x.avatar) : '');
  function peopleOf(b) {
    const s = getSettings(b.id);
    const extra = new Map(q(faceSql).all(b.id).map((r) => [r.peer_bot, r]));
    // Contacts still waiting for the owner's yes live on the overview, not here.
    const people = s.contacts.filter((c) => extra.get(c.peer_bot)?.approved_at)
      .map((c) => ({ ...c, pic: picOf(extra.get(c.peer_bot)) })).sort((x, y) => x.alias.localeCompare(y.alias));
    return { ...s, people };
  }
  function peerFace(botId, peerId) {
    const r = q(`${faceSql} AND c.peer_bot = ?`).get(botId, peerId);
    if (r) return { alias: r.alias, pic: picOf(r) };
    const pb = q('SELECT handle FROM bots WHERE id = ?').get(peerId);
    return { alias: pb ? `@${pb.handle}` : 'Someone', pic: '' };
  }
  const TILTS = [-4, 3, -2, 5, -5, 2, 4, -3, 1, -1];
  // A sticker: the picture cut out (one from the sticker set) or on a disc with a white edge (a robot, a photo,
  // or just the initial). No name until hover, keyboard focus or a long press; screen readers get the label.
  const stickerArt = (name, src) => String(src).startsWith('/stickers/')
    ? `<img class="stk__img" src="${esc(src)}" alt="" draggable="false" decoding="async">`
    : `<span class="stk__img stk__disc">${src ? `<img src="${esc(src)}" alt="" draggable="false" decoding="async">` : `<span class="stk__initial">${esc(String(name || '?').trim().slice(0, 1).toUpperCase())}</span>`}</span>`;
  const sticker = ({ seed = 0, name, src = '', href = '', label = name, data = '', note = true }) => {
    const inner = `${stickerArt(name, src)}${note ? `<span class="stk__name" aria-hidden="true">${esc(String(name).toLowerCase())}</span>` : ''}`;
    const style = `--tilt:${TILTS[seed % TILTS.length]}deg`;
    return href ? `<a class="stk" href="${esc(href)}" draggable="false" aria-label="${esc(label)}" style="${style}"${data}>${inner}</a>`
      : `<span class="stk" role="img" aria-label="${esc(label)}" style="${style}"${data}>${inner}</span>`;
  };
  // Hand-drawn marks from the sticker sheet: a question mark for "asks you first", a cross, an arrow.
  const HAND = {
    check: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.6c1.2 1 2.1 2 2.9 3.2C7.6 8.4 9.9 5.6 13.2 3.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ask: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.6 5.8c.1-1.6 1.3-2.6 2.6-2.5 1.5.1 2.4 1.1 2.3 2.3-.1 1.4-1.4 1.8-2.1 2.6-.4.4-.4 1-.4 1.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="12.6" r="1.05" fill="currentColor"/></svg>',
    x: '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    arrow: '<svg viewBox="0 0 34 30" fill="none" aria-hidden="true"><path d="M30 4C22 4 12 8 8 22" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3.5 16.5 8 23l5.5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  // The relay's validation messages are written for bots; the owner gets these.
  const ownerError = (e) => ({
    'circle name already exists': 'You already have a basket with that name.',
    'at most 12 circles': 'You can have up to 12 baskets.',
    'name must be 1 to 24 characters': 'Give the basket a name of up to 24 characters.',
    'default circles cannot be deleted': 'The family, friends and work baskets stay. You can rename them.',
    'topic must be a short word or phrase, up to 40 characters': 'A topic is a short word or phrase, up to 40 characters.',
    'at most 10 topics': 'Up to 10 topics per person.',
    'rule text must be 1 to 200 characters': 'A rule can be up to 200 characters.',
    'purpose must be up to 60 characters': 'Keep who they are to 60 characters.',
    'notes must be up to 280 characters': 'Notes can be up to 280 characters.',
    'request revision changed; review the current draft': 'Your bot changed the draft while you were looking. Here is the new one.',
  })[e.message] || e.message.replace(/^\w/, (x) => x.toUpperCase()).replace(/([^.])$/, '$1.');
  const basketMenu = (b, g) => `<details class="more bmenu"><summary class="iconbtn" aria-label="Change the ${esc(g.name)} basket">${ICON.dots}</summary><div class="menu">
<form method="post" action="/app/people/baskets" class="bmenu__rename"><input type="hidden" name="bot" value="${b.id}"><input type="hidden" name="circle" value="${g.id}"><label class="sr" for="rn-${g.id}">New name</label><input id="rn-${g.id}" name="name" value="${esc(g.name)}" maxlength="24" required autocomplete="off"><button>Rename</button></form>
<form method="post" action="/app/people/mode" class="bmenu__mode"><input type="hidden" name="bot" value="${b.id}"><input type="hidden" name="circle" value="${g.id}"><input type="hidden" name="mode" value="${g.mode === 'asks' ? 'handles' : 'asks'}"><button role="menuitemcheckbox" aria-checked="${g.mode === 'asks'}">Asks you first</button></form>
${g.is_default ? '' : `<form method="post" action="/app/people/baskets" id="del-${g.id}"><input type="hidden" name="bot" value="${b.id}"><input type="hidden" name="circle" value="${g.id}"><input type="hidden" name="delete" value="1"><button class="danger" data-reveal>Remove basket</button></form>
<div class="menu__confirm" hidden><p>Everyone in it goes back to not sorted yet, so your bot asks you first.</p><div class="menu__actions"><button type="button" data-unreveal>Cancel</button><button class="danger" form="del-${g.id}">Remove</button></div></div>`}</div></details>`;
  const asksTag = `<span class="tag" data-mode="asks">${HAND.ask}<span>asks you first</span></span>`;

  function peoplePage(user, b, { error = '' } = {}) {
    const s = peopleOf(b);
    const bots = govBots(user);
    const ids = `<input type="hidden" name="bot" value="${b.id}">`;
    const count = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;
    const where = (c) => (c.circle ? `in ${c.circle.name}` : 'not sorted yet');
    const stk = (c) => sticker({ seed: c.peer_bot, name: c.alias, src: c.pic, href: `/app/people/${b.id}/${c.peer_bot}`, label: `${c.alias}, ${where(c)}`,
      data: ` data-peer="${c.peer_bot}" data-name="${esc(c.alias)}" data-in="${c.circle?.id ?? ''}"` });
    const loose = s.people.filter((c) => !c.circle);
    const pool = `<div class="pool" data-drop="" aria-label="Not sorted yet, ${count(loose.length)}"><span class="pool__label" aria-hidden="true"><span class="hand">not sorted yet</span>${loose.length ? asksTag : ''}</span>
${loose.map(stk).join('')}${loose.length ? `<span class="pool__hint hand" aria-hidden="true"><span class="js-only">drag them into a basket</span><span class="no-js">tap someone to sort them</span>${HAND.arrow}</span>`
  : `<span class="pool__empty hand">${s.people.length ? 'everyone’s sorted' : 'nobody here yet'}</span>`}</div>`;
    const basket = (g) => {
      const inside = s.people.filter((c) => c.circle?.id === g.id);
      return `<section class="basket" data-drop="${g.id}" data-mode="${g.mode}" aria-label="${esc(g.name)}, ${count(inside.length)}${g.mode === 'asks' ? ', asks you first' : ''}">
<div class="basket__head"><h2 class="basket__name hand">${esc(g.name)}</h2>${basketMenu(b, g)}</div>${g.mode === 'asks' ? `<div class="basket__tag">${asksTag}</div>` : ''}
<div class="pile">${inside.map(stk).join('')}</div></section>`;
    };
    const add = s.circles.length >= 12 ? '' : `<form method="post" action="/app/people/baskets" class="basket basket--new" style="--span3:span ${3 - (s.circles.length % 3)};--span2:span ${2 - (s.circles.length % 2)}">${ids}<label class="sr" for="nb">Name a new basket</label><input id="nb" name="name" maxlength="24" required autocomplete="off" placeholder="+ new basket"><button class="nb__add">Add</button></form>`;
    const pick = bots.length > 1 ? `<nav class="botpick" aria-label="Which bot">${bots.map((x) => `<a href="/app/people?bot=${x.id}"${x.id === b.id ? ' aria-current="page"' : ''}>@${esc(x.handle)}</a>`).join('')}</nav>` : '';
    const invite = s.people.length ? '' : `<form method="post" action="/app/invites" class="people__invite"><input type="hidden" name="bot" value="${b.id}"><p>When someone connects with you, they land here.</p><button class="btn small ghost">${ICON.invite}Invite a friend</button></form>`;
    const data = JSON.stringify({ bot: b.id, baskets: s.circles.map((g) => ({ id: g.id, name: g.name, mode: g.mode })) }).replace(/</g, '\\u003c');
    return layout('People', `${error ? alertBox('danger', esc(error), '') : ''}<section class="sheet people" id="people-board" aria-label="Your baskets">
${pick}${pool}${invite}<div class="baskets">${s.circles.map(basket).join('')}${add}</div>
<p class="people__how">Your bot handles each basket on its own and asks you when it isn't sure.</p>
<p class="sr" id="stk-help">Press Enter to move them to another basket, or Space to open their page.</p>
<script type="application/json" id="people-data">${data}</script></section><script>${PEOPLE_JS}</script>`, { user, tab: 'people', bar: { title: 'People' } });
  }

  // One person: their basket, what they can ask about, notes for the bot, and rules (learned ones say so).
  const DAYS_SAID = { mon: 'Mondays', tue: 'Tuesdays', wed: 'Wednesdays', thu: 'Thursdays', fri: 'Fridays', sat: 'Saturdays', sun: 'Sundays' };
  const ruleText = (r) => r.source === 'learned' && r.topic && r.days
    ? `${r.answer === 'share' ? 'Shares' : 'Doesn\'t share'} ${r.topic} on ${r.days.map((d) => DAYS_SAID[d] || d).join(' and ')}` : r.text;
  function personPage(user, b, peerId, { error = '' } = {}) {
    const s = peopleOf(b);
    const c = s.people.find((x) => x.peer_bot === Number(peerId));
    if (!c) throw new HttpError(404, 'Contact not found');
    const base = `/app/people/${b.id}/${c.peer_bot}`;
    // The switch is theirs alone; when the basket (or not being sorted yet) already asks first, it shows that and waits.
    const own = c.mode_override === 'asks', held = !own && c.effective_mode === 'asks';
    const modeLine = own ? `Your bot asks you before it answers ${esc(c.alias)}.`
      : !c.circle ? `${esc(c.alias)} isn't in a basket yet, so your bot asks you first.`
      : held ? `Your bot asks you first for everyone in <span class="hand basket-word">${esc(c.circle.name)}</span>.`
      : 'Your bot handles it and asks you when it isn\'t sure.';
    const chip = (v, name, on, asks) => `<label class="bchip"><input type="radio" name="circle" value="${v}"${on ? ' checked' : ''} data-autosave><span class="hand">${esc(name)}</span>${asks ? `<span class="bchip__ask" aria-label="asks you first" title="asks you first">${HAND.ask}</span>` : ''}</label>`;
    const rules = c.rules.map((r) => `<li class="rule${(r.source === 'learned' || r.via === 'bot') && !r.owner_seen_at ? ' is-new' : ''}"><span class="rule__text">${esc(ruleText(r))}</span>
<span class="rule__meta">${r.source === 'learned' ? '<span class="hand">learned</span><span>from your answers</span>' : r.via === 'bot' ? '<span>Added by your bot</span>' : '<span>Set by you</span>'}</span>
${!r.owner_seen_at && (r.source === 'learned' || r.via === 'bot') ? `<form method="post" action="${base}/rules"><input type="hidden" name="seen" value="${esc(r.id)}"><button class="link">Seen</button></form>` : ''}
<form method="post" action="${base}/rules"><input type="hidden" name="remove" value="${esc(r.id)}"><button class="link" aria-label="Remove rule: ${esc(ruleText(r))}">Remove</button></form></li>`).join('');
    return layout(c.alias, `${error ? alertBox('danger', esc(error), '') : ''}<section class="sheet person" aria-labelledby="person-h">
<div class="person__art">${sticker({ seed: c.peer_bot, name: c.alias, src: c.pic, label: c.alias, note: false })}<div class="person__names"><h1 class="person__name hand" id="person-h">${esc(c.alias)}</h1>${c.purpose ? `<p class="person__note hand">${esc(c.purpose)}</p>` : ''}<p class="person__handle handle">${esc(c.handle)}</p></div></div>
<div class="person__body">
<form method="post" action="${base}/basket" class="pblock" id="basket"><fieldset class="bchips"><legend class="row-label">Basket</legend>
${chip('', 'not sorted yet', !c.circle, true)}${s.circles.map((g) => chip(g.id, g.name, c.circle?.id === g.id, g.mode === 'asks')).join('')}</fieldset>
<div class="setrow setrow--flush setrow--keep"><div><p class="setrow__label" id="ask-first">Asks you first</p><p class="setrow__desc">${modeLine}</p></div>
<label class="switch"><input type="checkbox" role="switch" name="mode" value="asks" aria-labelledby="ask-first" data-autosave${own || held ? ' checked' : ''}${held ? ' disabled' : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span></label></div>
<noscript><div><button class="btn small ghost">Save</button></div></noscript></form>
<form method="post" action="${base}/about" class="pblock" id="about">
<label>Who they are<input name="purpose" maxlength="60" autocomplete="off" value="${esc(c.purpose || '')}" placeholder="football friend"></label>
<label>Notes for your bot<textarea name="notes" maxlength="280" rows="3" placeholder="Only football. Anything else, ask me.">${esc(c.notes || '')}</textarea></label>
<div><button class="btn small ghost">Save</button></div></form>
<section class="pblock" id="topics" aria-labelledby="topics-h"><h2 class="row-label" id="topics-h">${esc(c.alias)} can ask about</h2><div class="tchips">
${c.topics.map((t) => `<form method="post" action="${base}/topics" class="tchip"><span>${esc(t)}</span><input type="hidden" name="remove" value="${esc(t)}"><button aria-label="Stop ${esc(c.alias)} asking about ${esc(t)}">${HAND.x}</button></form>`).join('')}
${c.topics.length < 10 ? `<form method="post" action="${base}/topics" class="tchip-add"><label class="sr" for="nt">New topic</label><input id="nt" name="add" maxlength="40" required autocomplete="off" placeholder="+ add a topic"><noscript><button class="btn small ghost">Add topic</button></noscript></form>` : ''}</div></section>
<section class="pblock" id="rules" aria-labelledby="rules-h"><h2 class="row-label" id="rules-h">Rules</h2>
${rules ? `<ul class="rules">${rules}</ul>` : ''}
<form method="post" action="${base}/rules" class="rule-add"><label class="sr" for="nr">New rule</label><input id="nr" name="add" maxlength="200" required autocomplete="off" placeholder="Never says yes to a meeting without me"><button class="btn small ghost">Add rule</button></form></section>
</div></section>`, { user, tab: 'people', bar: { back: `/app/people?bot=${b.id}`, backLabel: 'People' } });
  }

  // ───── requests (pilot): replies waiting for a yes, and changes the bot can't make alone ─────
  function requestCard(r) {
    const who = peerFace(r.owner_bot, r.peer_bot);
    const inbound = r.inbound_message_id ? q('SELECT text, links, sealed, body_purged_at FROM messages WHERE id = ?').get(r.inbound_message_id) : null;
    // Their words are data: escaped, invisible and control characters shown, links as plain text.
    const theirs = !inbound ? '' : inbound.body_purged_at ? `<p class="ask__theirs ask__theirs--quiet">Their message was deleted after 7 days.</p>`
      : inbound.sealed ? `<p class="ask__theirs ask__theirs--quiet">End-to-end encrypted, so only your bot could read their message.</p>`
      : `<figure class="ask__theirs"><figcaption>${esc(who.alias)}'s bot wrote</figcaption><blockquote>${esc(safeText(inbound.text))}</blockquote>${JSON.parse(inbound.links || '[]').map((l) => `<p class="ask__link">${esc(safeText(l))}</p>`).join('')}</figure>`;
    const d = r.draft;
    const draft = d ? `<div class="ask__draft"><p class="ask__label">${r.state === 'PENDING_OWNER' ? 'Your bot\'s draft' : r.state === 'ENQUEUED' ? 'What was sent' : 'The answer'}</p><p class="ask__text">${esc(d.text)}</p>${d.links.map((l) => `<a class="ext" href="${esc(l)}" rel="noopener noreferrer nofollow" target="_blank">${esc(l.replace(/^https?:\/\//, '').slice(0, 60))}</a>`).join('')}</div>` : '';
    const q_ = r.question ? esc(r.question) : r.inbound_message_id ? `${esc(who.alias)} wrote to you. Send your bot's answer?` : `Your bot wants to write to ${esc(who.alias)}. Send it?`;
    const act = `/app/requests/${esc(r.id)}`;
    const rev = `<input type="hidden" name="revision" value="${r.revision}">`;
    const own = (action, summary, text) => `<details class="ask__more" name="own-${esc(r.id)}"><summary class="btn ghost">${summary}</summary><form method="post" action="${act}" class="ask__own">${rev}<input type="hidden" name="action" value="${action}">${action === 'edit' && d?.links.length ? `<input type="hidden" name="links" value="${esc(d.links.join('\n'))}">` : ''}
<label class="sr" for="${action}-${esc(r.id)}">${action === 'edit' ? 'Your edit' : 'Your answer'}</label><textarea id="${action}-${esc(r.id)}" name="text" rows="4" maxlength="4000" required${action === 'write' ? ` placeholder="Write it in your words"` : ''}>${esc(text)}</textarea><button class="btn">Send this</button></form></details>`;
    const done = {
      ENQUEUED: ['sent', `Sent to ${esc(who.alias)}.`],
      APPROVED: ['okay', `Okayed. Your bot sends it end-to-end encrypted the next time it runs.`],
      DECLINED: ['declined', 'Declined. Nothing was sent.'],
      EXPIRED: ['expired', 'This waited 24 hours, so it expired. Nothing was sent.'],
      CANCELLED: ['cancelled', `Something changed with ${esc(who.alias)}, so this was cancelled. Nothing was sent.`],
    }[r.state];
    const body = r.state === 'PENDING_OWNER' ? `<div class="ask__actions" role="group" aria-label="Your answer">
<form method="post" action="${act}">${rev}<input type="hidden" name="action" value="send"><button class="btn">Send once</button></form>
${own('edit', 'Edit', d?.text || '')}${own('write', 'Write my own', '')}
<form method="post" action="${act}">${rev}<input type="hidden" name="action" value="decline"><button class="btn ghost">Decline</button></form></div>
<p class="ask__why">Nothing goes to ${esc(who.alias)} until you choose.</p>`
      : `<span class="ask__stamp" aria-hidden="true">${done[0]}</span><div class="ask__done"><p role="status">${done[1]}</p></div>`;
    return `<article class="ask" id="${esc(r.id)}" aria-label="${r.inbound_message_id ? `Reply to ${esc(who.alias)}` : `Message to ${esc(who.alias)}`}">
<div class="ask__top">${sticker({ seed: r.peer_bot, name: who.alias, src: who.pic, label: who.alias, note: false })}<div class="ask__who"><span class="hand">${r.inbound_message_id ? `${esc(who.alias.toLowerCase())} asked` : `to ${esc(who.alias.toLowerCase())}`}</span><time datetime="${new Date(r.created_at).toISOString()}">${esc(ago(r.created_at, clock()))}</time></div></div>
<p class="ask__q">${q_}</p>${r.topic && r.state === 'PENDING_OWNER' ? `<p class="ask__topic"><span class="hand">${esc(r.topic)}</span> Your bot remembers your answer, so it asks less next time.</p>` : ''}${theirs}${draft}${body}</article>`;
  }
  // Settings changes in words, from the stored operations.
  function describeOp(b, o) {
    const who = o.contact != null ? (q('SELECT alias FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(b.id, o.contact)?.alias ?? 'someone') : '';
    const grp = o.circle_name ?? (o.circle != null ? (q('SELECT name FROM circles WHERE id = ? AND owner_bot = ?').get(o.circle, b.id)?.name ?? 'a basket') : '');
    const rule = o.rule ? q('SELECT text FROM contact_rules WHERE id = ? AND owner_bot = ?').get(o.rule, b.id)?.text : null;
    switch (o.op) {
      case 'move': return o.circle == null ? `Take ${who} out of their basket` : `Put ${who} in ${grp}`;
      case 'set_mode': return o.contact != null
        ? (o.mode === 'handles' ? `Let your bot handle ${who} without asking you first` : o.mode === 'asks' ? `Your bot asks you first about ${who}` : `${who} goes by their basket again`)
        : (o.mode === 'handles' ? `Let your bot handle everyone in ${grp} without asking you first` : `Your bot asks you first about everyone in ${grp}`);
      case 'add_circle': return `Add a basket called ${o.name}${o.mode === 'asks' ? ', where your bot asks you first' : ''}`;
      case 'rename_circle': return `Rename ${grp} to ${o.name}`;
      case 'delete_circle': return `Remove the ${grp} basket`;
      case 'set_purpose': return o.purpose ? `Note who ${who} is: ${o.purpose}` : `Clear who ${who} is`;
      case 'set_notes': return `Change your notes for ${who}`;
      case 'add_topic': return `Let ${who} ask about ${o.topic}`;
      case 'remove_topic': return `Stop ${who} asking about ${o.topic}`;
      case 'add_rule': return `Add a rule for ${who}: ${o.text}`;
      case 'remove_rule': return rule ? `Remove your rule: ${rule}` : 'Remove one of your rules';
      case 'block': return o.on ? `Block ${who}` : `Unblock ${who}`;
      case 'pause': return o.on ? 'Pause your bots' : 'Resume your bots';
      case 'quiet_hours': return o.on ? `Quiet hours from ${hhmm(o.start)} to ${hhmm(o.end)}` : 'Turn quiet hours off';
      case 'ack_learned': return 'Mark learned rules as seen';
      default: return 'Change a setting';
    }
  }
  function proposalCard(b, p) {
    const ops = typeof p.ops === 'string' ? JSON.parse(p.ops) : p.ops;
    const act = `/app/proposals/${esc(p.id)}`;
    const done = { APPROVED: ['changed', 'Done. Your bot has the new settings.'], DECLINED: ['declined', 'Declined. Nothing changed.'], EXPIRED: ['expired', 'This waited 7 days, so it expired. Nothing changed.'] }[p.state];
    return `<article class="ask ask--change" id="${esc(p.id)}" aria-label="A change your bot wants">
<div class="ask__top"><div class="ask__who"><span class="hand">your bot asks</span><time datetime="${new Date(p.created_at).toISOString()}">${esc(ago(p.created_at, clock()))}</time></div></div>
<p class="ask__q">${ops.length === 1 ? 'Okay to change this?' : `Okay to change these ${ops.length} things?`}</p>
<ul class="changes">${ops.map((o) => `<li>${esc(describeOp(b, o))}</li>`).join('')}</ul>
${p.state === 'PENDING_OWNER' ? `<p class="ask__why">Your bot can't do this alone, because it gives it more freedom.</p><div class="ask__actions" role="group" aria-label="Your answer">
<form method="post" action="${act}"><input type="hidden" name="decision" value="approve"><button class="btn">Approve</button></form>
<form method="post" action="${act}"><input type="hidden" name="decision" value="decline"><button class="btn ghost">Decline</button></form></div>`
  : `<span class="ask__stamp" aria-hidden="true">${done[0]}</span><div class="ask__done"><p role="status">${done[1]}</p></div>`}</article>`;
  }
  function requestsPage(user) {
    const bots = govBots(user);
    const reqs = bots.flatMap((b) => openRequests(b.id, { owner: true }));
    const props = bots.flatMap((b) => q("SELECT * FROM settings_proposals WHERE owner_bot = ? AND state = 'PENDING_OWNER' AND expires_at > ? ORDER BY created_at, id").all(b.id, clock()).map((p) => [b, p]));
    const body = reqs.length || props.length
      ? `${reqs.length ? `<section class="group" aria-labelledby="replies-h"><h2 id="replies-h">Replies</h2><div class="asks-list">${reqs.map(requestCard).join('')}</div></section>` : ''}
${props.length ? `<section class="group" aria-labelledby="changes-h"><h2 id="changes-h">Changes</h2><div class="asks-list">${props.map(([b, p]) => proposalCard(b, p)).join('')}</div></section>` : ''}`
      : `<section class="card">${emptyState('check', 'Nothing waiting', 'When your bot needs your okay, it shows up here.')}</section>`;
    return layout('Requests', `<p class="pnote">For end-to-end chats, the relay can read drafts you send here for approval.</p>${body}`, { user, tab: 'requests', width: 'read', bar: { title: 'Requests', sub: 'What your bot wants you to okay' } });
  }
  const oneRequestPage = (user, r, { error = '' } = {}) => layout('Request', `${error ? alertBox('danger', esc(error), '') : ''}<p class="pnote">For end-to-end chats, the relay can read drafts you send here for approval.</p>${requestCard(r)}`,
    { user, tab: 'requests', width: 'read', bar: { back: '/app/requests', backLabel: 'Requests', title: r.inbound_message_id ? `Reply to ${peerFace(r.owner_bot, r.peer_bot).alias}` : `Message to ${peerFace(r.owner_bot, r.peer_bot).alias}` } });
  const oneProposalPage = (user, b, p, { error = '' } = {}) => layout('Change', `${error ? alertBox('danger', esc(error), '') : ''}${proposalCard(b, p)}`,
    { user, tab: 'requests', width: 'read', bar: { back: '/app/requests', backLabel: 'Requests', title: 'A change from your bot' } });

  // ───── router ─────
  return async function handleApp(req, res, url) {
    const p = url.pathname;
    // With the landing site on the same server, it answers / and /pricing instead of the built-in pages.
    const isApp = p === '/oauth/authorize' || (!site && (p === '/' || p === '/pricing')) || p === '/billing/stripe' || p === '/login' || p.startsWith('/login/') || p === '/logout' || p === '/app' || p.startsWith('/app/') || p.startsWith('/i/') || p.startsWith('/art/') || p.startsWith('/avatars/') || p.startsWith('/stickers/') || p.startsWith('/hand/');
    if (!isApp) return false;
    try {
      if (p === '/billing/stripe' && req.method === 'POST') {
        let raw = '';
        for await (const c of req) { raw += c; if (raw.length > 256_000) throw new HttpError(413, 'too large'); }
        if (!hosted || !verifyStripe(raw, req.headers['stripe-signature'])) return json(res, 400, { error: 'bad signature' }), true;
        const ev = JSON.parse(raw);
        if (q('SELECT 1 FROM billing_events WHERE id = ?').get(String(ev.id))) return json(res, 200, { ok: true, duplicate: true }), true;
        q('INSERT INTO billing_events (id, received_at) VALUES (?, ?)').run(String(ev.id), clock());
        const sess = ev.data?.object;
        if (ev.type === 'checkout.session.completed' && sess?.payment_status === 'paid') {
          const u = q('SELECT * FROM users WHERE id = ?').get(Number(sess.client_reference_id));
          if (u) {
            const from = Math.max(u.paid_until || 0, clock());
            q('UPDATE users SET paid_until = ? WHERE id = ?').run(from + 365 * 86_400_000, u.id);
            log(null, 'paid', { user: u.id, event: String(ev.id) });
            // Wake everyone this payment covers who has messages waiting.
            const covered = [u.email, ...q('SELECT email FROM household_members WHERE payer_user_id = ?').all(u.id).map((m) => m.email)];
            for (const e of covered) for (const b of q("SELECT b.id FROM bots b JOIN users x ON x.id = b.user_id WHERE x.email = ? AND b.disconnected_at IS NULL").all(e)) release(b.id);
          }
        }
        return json(res, 200, { ok: true }), true;
      }
      const rm = p.match(/^\/avatars\/([a-z]+)\.svg$/);
      if (rm && req.method === 'GET') {
        if (!ROBOT.has(rm[1])) throw new HttpError(404, 'Not found');
        res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=604800', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
        res.end(ROBOT_SVG.get(rm[1]));
        return true;
      }
      const sm = p.match(/^\/stickers\/([a-z0-9][a-z0-9-]{0,39})\.png$/);
      if (sm && req.method === 'GET') {
        if (!stickers().has(sm[1])) throw new HttpError(404, 'Not found');
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
        res.end(readFileSync(join(stickers.dir, `${sm[1]}.png`)));
        return true;
      }
      const hm = p.match(/^\/hand\/(caveat-latin|caveat-latin-ext)\.woff2$/);
      if (hm && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable', 'access-control-allow-origin': '*' });
        res.end(readFileSync(new URL(`./public/hand/${hm[1]}.woff2`, import.meta.url)));
        return true;
      }
      if (p.startsWith('/stickers/') || p.startsWith('/hand/')) throw new HttpError(404, 'Not found');
      const am = p.match(/^\/art\/([a-z]+)\.jpg$/);
      if (am && req.method === 'GET') {
        if (!ART.has(am[1])) throw new HttpError(404, 'Not found');
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
        res.end(readFileSync(new URL(`./public/art/${am[1]}.jpg`, import.meta.url)));
        return true;
      }
      if (req.method === 'POST' && !sameOrigin(req)) throw new HttpError(403, 'Please use the website to do that.');
      const user = currentUser(req);

      if (p === '/' && req.method === 'GET') return page(res, 200, landing(user)), true;
      if (p === '/pricing' && req.method === 'GET') return page(res, hosted ? 200 : 404, hosted ? pricingPage(user) : layout('Not found', '<section class="card narrow"><h1>Not found</h1><p>This server is self-hosted and free.</p></section>')), true;

      if (p === '/login' && req.method === 'GET') return page(res, 200, loginPage({ next: url.searchParams.get('next') || '' })), true;
      if (p === '/login' && req.method === 'POST') {
        const f = await form(req);
        const email = String(f.email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return page(res, 400, loginPage({ email, error: 'That email address looks wrong.', next: f.next })), true;
        try { const devCode = await sendLogin(email, req, res); return page(res, 200, loginPage({ email, sent: true, next: f.next, devCode })), true; }
        catch (e) { if (e instanceof HttpError) return page(res, e.status, loginPage({ email, error: e.message, next: f.next })), true; throw e; }
      }
      if (p === '/login/verify' && req.method === 'POST') {
        const f = await form(req);
        const email = String(f.email || '').trim().toLowerCase();
        const row = q('SELECT * FROM login_codes WHERE email = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC').get(email, clock());
        if (!row || row.attempts >= 5) return page(res, 400, loginPage({ email, error: 'That code expired. Ask for a new one.', next: f.next })), true;
        if (row.code_hash !== sha(String(f.code || '').trim())) {
          q('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
          return page(res, 400, loginPage({ email, sent: true, error: 'Wrong code. Try again.', next: f.next })), true;
        }
        q('UPDATE login_codes SET used_at = ? WHERE id = ?').run(clock(), row.id);
        return finishLogin(res, email, f.next, f.tz), true;
      }
      if (p === '/login/link') {
        // GET only shows a button, so email scanners that open links can't use them up.
        const t = req.method === 'POST' ? String((await form(req)).t || '') : url.searchParams.get('t') || '';
        const row = q('SELECT * FROM login_codes WHERE link_hash = ? AND used_at IS NULL AND expires_at > ?').get(sha(t), clock());
        if (!row) return page(res, 400, loginPage({ error: 'That link expired. Ask for a new one.' })), true;
        const nonce = cookies(req).b2b_login;
        if (row.browser_hash && (!nonce || sha(nonce) !== row.browser_hash)) {
          return page(res, 400, loginPage({ error: 'Open the link in the same browser where you asked for it, or type the 6-digit code from the email there.' })), true;
        }
        if (req.method !== 'POST') return page(res, 200, layout('Log in', `<section class="card narrow center"><h1>Continue to ${esc(product)}</h1>
<form method="post" action="/login/link"><input type="hidden" name="t" value="${esc(t)}"><button class="btn">Log in</button></form></section>`)), true;
        q('UPDATE login_codes SET used_at = ? WHERE id = ?').run(clock(), row.id);
        return finishLogin(res, row.email, '/app'), true;
      }
      if (p === '/logout' && req.method === 'POST') {
        const t = cookies(req).b2b_session; if (t) q('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
        res.setHeader('set-cookie', sessionCookie('', 0)); return redirect(res, '/'), true;
      }

      // Connected app sign-in (OAuth authorize). Needs a logged-in person; they pick which bot the app acts as.
      if (p === '/oauth/authorize') {
        const params = req.method === 'POST' ? await form(req) : Object.fromEntries(url.searchParams);
        const keep = Object.fromEntries(['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'].map((k) => [k, String(params[k] ?? '')]));
        const client = q('SELECT * FROM oauth_clients WHERE client_id = ?').get(keep.client_id);
        if (!client || !JSON.parse(client.redirect_uris).includes(keep.redirect_uri)) throw new HttpError(400, 'This app is not registered with this address.');
        // Every answer names us as the issuer (RFC 9207), so the app can tell which server it came from.
        const back = (qs) => { const u = new URL(keep.redirect_uri); for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v); if (keep.state) u.searchParams.set('state', keep.state); u.searchParams.set('iss', origin); return redirect(res, u.toString()), true; };
        if (keep.response_type !== 'code' || keep.code_challenge_method !== 'S256' || keep.code_challenge.length < 43) return back({ error: 'invalid_request', error_description: 'PKCE (S256) and response_type=code are required' });
        if (keep.resource && ![`${origin}/mcp`, origin, `${origin}/`].includes(keep.resource)) return back({ error: 'invalid_target', error_description: `resource must be ${origin}/mcp` });
        if (!user) return redirect(res, `/login?next=${encodeURIComponent(`/oauth/authorize?${new URLSearchParams(keep)}`)}`), true;
        if (req.method === 'GET') return page(res, 200, authorizePage(user, client, keep)), true;
        if (params.decision !== 'allow') return back({ error: 'access_denied' });
        let bot;
        try {
          bot = params.bot && params.bot !== 'new' ? ownBot(user, params.bot) : makeConnectorBot(user, params.handle);
          if (bot.vendor !== 'connector') throw new HttpError(400, 'Pick one of your connected-app bots.');
        } catch (e) { if (e instanceof HttpError) return page(res, 400, authorizePage(user, client, keep, { error: e.message })), true; throw e; }
        if (bot.disconnected_at) q('UPDATE bots SET disconnected_at = NULL WHERE id = ?').run(bot.id);
        const code = token('ac_', 24);
        q('INSERT INTO oauth_codes (code_hash, client_id, bot_id, redirect_uri, challenge, expires_at, resource) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sha(code), client.client_id, bot.id, keep.redirect_uri, keep.code_challenge, clock() + 5 * 60_000, keep.resource || null);
        // Which assistant this is, from the name the app registered with (a hint for setup steps, never for trust).
        const platform = /chatgpt|openai/i.test(client.name) ? 'chatgpt' : /openclaw|clawd|moltbot/i.test(client.name) ? 'openclaw' : null;
        if (platform) q('UPDATE bots SET platform = ? WHERE id = ?').run(platform, bot.id);
        log(bot.id, 'connector_authorized', { client: client.name.slice(0, 40) });
        return back({ code });
      }

      // Invite links work for logged-out visitors too.
      const im = p.match(/^\/i\/([A-Za-z0-9-]{9})$/);
      if (im) {
        const plain = im[1].toUpperCase();
        const inv = q('SELECT * FROM invites WHERE code_hash = ?').get(sha(plain));
        if (inv && inv.used_at && user && inv.used_by && q('SELECT 1 FROM bots WHERE id = ? AND user_id = ?').get(inv.used_by, user.id)) return redirect(res, '/app'), true;
        if (!inv || inv.used_at || inv.expires_at < clock()) return page(res, 404, layout('Invitation', `<section class="card narrow center"><h1>This invite has expired</h1><p>Ask your friend for a new link.</p></section>`, { user })), true;
        inv.plain = plain;
        const inviter = q('SELECT b.handle, u.name, u.email_verified_at, b.user_id FROM bots b LEFT JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(inv.from_bot);
        const bots = user ? liveBots(user).filter((b) => b.id !== inv.from_bot) : [];
        if (req.method === 'GET') return page(res, 200, invitePage(inv, inviter, user, bots)), true;
        if (!user) return redirect(res, `/login?next=${encodeURIComponent(p)}`), true;
        const f = await form(req);
        if (inviter.user_id === user.id) return page(res, 400, invitePage(inv, inviter, user, bots, { error: 'That is your own invite.' })), true;
        // The web inbox is off unless an operator turns it on (WEB_INBOX=1): bot2bot is for bots.
        const bot = webInbox && f.web === '1' && !bots.length ? makeWebBot(user) : bots.find((b) => b.id === Number(f.bot));
        if (!bot) return page(res, 400, invitePage(inv, inviter, user, bots, { error: bots.length ? 'Pick one of your bots.' : 'Connect your Grok Bot first.' })), true;
        let accepted;
        try {
          accepted = routes['POST /v1/invites/accept']({ me: bot, body: { code: plain, alias: String(f.alias || '').trim(), basket: f.basket || null, notes: f.notes ?? null }, byOwner: true });
          // Dashboard links don't know the friend's name up front: name them for the inviter now.
          // (Invites a bot made already carry the name its owner uses.)
          if (inv.alias.startsWith('friend-')) {
          const base = (user.name || bot.handle).split(' ')[0].slice(0, 24) || bot.handle;
          let alias = base, n = 2;
          while (q('SELECT 1 FROM contacts WHERE owner_bot = ? AND lower(alias) = lower(?) AND peer_bot != ?').get(inv.from_bot, alias, bot.id)) alias = `${base} ${n++}`;
          q('UPDATE contacts SET alias = ? WHERE owner_bot = ? AND peer_bot = ?').run(alias, inv.from_bot, bot.id);
          }
        }
        catch (e) { if (e instanceof HttpError) return page(res, e.status, invitePage(inv, inviter, user, bots, { error: e.message })), true; throw e; }
        return page(res, 200, invitePage(inv, inviter, user, bots, { done: bot.vendor === 'web' ? 'web' : true, basket: accepted?.basket })), true;
      }

      // Everything below needs a logged-in user.
      if (!user) return redirect(res, `/login?next=${encodeURIComponent(p)}`), true;

      // No picture yet: pick one first, then carry on to the page they asked for.
      if (req.method === 'GET' && !hasPicture(user) && /^\/app(\/(activity|inbox|account|billing|people|requests|bots\/\d+))?$/.test(p)) return redirect(res, `/app/picture?next=${encodeURIComponent(p + url.search)}`), true;
      if (p === '/app' && req.method === 'GET') return page(res, 200, dashboard(user)), true;
      if (p === '/app/status' && req.method === 'GET') return json(res, 200, { bots: myBots(user).length }), true;

      const lm = p.match(/^\/app\/link\/([A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/);
      if (lm) {
        const plain = lm[1].toUpperCase();
        if (req.method === 'GET') return page(res, 200, linkPage(user, joinRequest(plain), plain)), true;
        if (req.method === 'POST') {
          const f = await form(req);
          if (f.decision !== 'allow') {
            q('UPDATE join_requests SET denied_at = ? WHERE code_hash = ? AND approved_at IS NULL').run(clock(), sha(plain));
            tell(user, { what: 'Declined. That bot isn\'t linked.' });
            return redirect(res, '/app'), true;
          }
          try { approveJoin(user, plain, f); }
          catch (e) { if (e instanceof HttpError) return page(res, e.status, linkPage(user, joinRequest(plain), plain, { error: e.message, handle: f.handle })), true; throw e; }
          return redirect(res, `/app/link/${plain}`), true;
        }
      }

      if ((p === '/app/bots' || p === '/app/bots/new') && req.method === 'POST') {
        const f = await form(req);
        if (p === '/app/bots/new') { q('UPDATE enroll_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(clock(), user.id); return redirect(res, '/app/bots/new-form'), true; }
        const handle = String(f.handle || '').trim().toLowerCase();
        const adding = myBots(user).length > 0;
        if (adding && !HANDLE_RE.test(handle)) return page(res, 400, addBotForm(user, { error: 'Use 2 to 32 lowercase letters, numbers, - or _. No spaces.', handle: f.handle })), true;
        if (!HANDLE_RE.test(handle)) return page(res, 400, dashboard(user).replace('<h2>Connect your bot</h2>', '<h2>Connect your bot</h2><p class="error">Use 2 to 32 lowercase letters, numbers, - or _.</p>')), true;
        if (q('SELECT 1 FROM bots WHERE handle = ?').get(handle) || q('SELECT 1 FROM enroll_codes WHERE handle = ? AND used_at IS NULL AND expires_at > ? AND (user_id IS NULL OR user_id != ?)').get(handle, clock(), user.id)) {
          if (adding) return page(res, 409, addBotForm(user, { error: 'That name is taken. Try another.', handle })), true;
          return page(res, 409, dashboard(user).replace('<h2>Connect your bot</h2>', '<h2>Connect your bot</h2><p class="error">That name is taken. Try another.</p>')), true;
        }
        const code = humanCode();
        q('UPDATE enroll_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(clock(), user.id);
        q('INSERT OR REPLACE INTO enroll_codes (code_hash, handle, display_name, expires_at, user_id, plain_code) VALUES (?, ?, ?, ?, ?, ?)').run(sha(code), handle, user.name, clock() + L.codeTtlMs, user.id, code);
        log(null, 'enroll_code', { handle, by: 'user' });
        return redirect(res, '/app'), true;
      }
      if (p === '/app/bots/new-form' && req.method === 'GET') {
        return page(res, 200, addBotForm(user)), true;
      }
      if (p === '/app/bots/cancel' && req.method === 'POST') {
        q('UPDATE enroll_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(clock(), user.id);
        tell(user, { what: 'Setup cancelled' });
        return redirect(res, '/app'), true;
      }

      const bm = p.match(/^\/app\/bots\/(\d+)(\/[a-z]+(?:\/off)?)?$/);
      if (bm) {
        const b = ownBot(user, bm[1]);
        const sub = bm[2] || '';
        if (!sub && req.method === 'GET') return page(res, 200, botPage(user, b)), true;
        if (sub === '/state' && req.method === 'GET') return json(res, 200, { verified: !!b.doorbell_verified_at, last_ring_status: b.last_ring_status }), true;
        if (sub === '/doorbell' && req.method === 'POST') {
          const f = await form(req);
          try {
            const { url: urlOk, kind } = doorbellTarget(String(f.url || '').trim());
            const key = String(f.key || '').trim();
            if (key.length < 8 || key.length > 512 || /[\r\n]/.test(key)) throw new HttpError(400, 'That key looks wrong. Copy it again from the Webhook window.');
            // Re-check after reading the form: a disconnect that happened meanwhile wins.
            const saved = tx(() => {
              const now_ = q('SELECT * FROM bots WHERE id = ?').get(b.id);
              if (now_.disconnected_at || now_.vendor === 'web' || now_.user_id !== user.id) return false;
              q("DELETE FROM messages WHERE to_bot = ? AND kind = 'probe' AND status != 'delivered'").run(b.id);
              events?.revokeAll(b.id);
              q('UPDATE bots SET webhook_url = ?, webhook_key = ?, doorbell_kind = ?, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1 WHERE id = ? AND disconnected_at IS NULL').run(urlOk, sealKey(key), kind, b.id);
              return true;
            });
            if (!saved) throw new HttpError(409, 'This bot was disconnected. Reconnect it first.');
            log(b.id, 'doorbell_set', { host: new URL(urlOk).hostname, by: 'owner' });
          } catch (e) {
            if (e instanceof HttpError) return page(res, 400, botPage(user, b, { error: e.message.replace(/^webhook (url|host)/, 'The webhook address') })), true;
            throw e;
          }
          // Saving rings the bot straight away: one less thing to click.
          tell(user, { what: 'Doorbell saved' });
          return redirect(res, `/app/bots/${b.id}?ring=1`), true;
        }
        // ChatGPT or OpenClaw watching for messages: stop every subscription (they can ask to watch again).
        if (sub === '/doorbell/off' && req.method === 'POST') {
          tx(() => {
            events?.revokeAll(b.id);
            q('UPDATE bots SET webhook_url = NULL, webhook_key = NULL, doorbell_kind = NULL, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1 WHERE id = ?').run(b.id);
          });
          log(b.id, 'doorbell_removed', { by: 'owner' });
          tell(user, { what: 'Stopped watching' });
          return redirect(res, `/app/bots/${b.id}`), true;
        }
        if (sub === '/disconnect' && req.method === 'POST') {
          tx(() => {
            bumpGen(b.id);
            events?.revokeAll(b.id);
            q('UPDATE bots SET token_hash = NULL, webhook_url = NULL, webhook_key = NULL, doorbell_kind = NULL, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1, disconnected_at = ? WHERE id = ?').run(clock(), b.id);
            q('UPDATE oauth_tokens SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL').run(clock(), b.id);
            erase(`status IN ('pending', 'claimed') AND (to_bot = ? OR from_bot = ?)`, b.id, b.id);
            q('DELETE FROM invites WHERE from_bot = ? AND used_at IS NULL').run(b.id);
            // Any setup code made before now (an upgrade or an earlier reconnect) stops working too.
            q('UPDATE enroll_codes SET used_at = ?, plain_code = NULL WHERE handle = ? AND used_at IS NULL').run(clock(), b.handle);
          });
          log(b.id, 'disconnected', { by: 'owner' });
          tell(user, { what: `Disconnected @${b.handle}`, undo: undoForm(`/app/bots/${b.id}/reconnect`, {}, 'Reconnect') });
          return redirect(res, `/app/bots/${b.id}`), true;
        }
        if (sub === '/reconnect' && req.method === 'POST') {
          if (!b.disconnected_at && b.vendor !== 'web') return redirect(res, `/app/bots/${b.id}`), true;
          const code = humanCode();
          q('UPDATE enroll_codes SET used_at = ? WHERE handle = ? AND used_at IS NULL').run(clock(), b.handle);
          q('INSERT INTO enroll_codes (code_hash, handle, display_name, expires_at, reissue, user_id, plain_code) VALUES (?, ?, ?, ?, 1, ?, ?)').run(sha(code), b.handle, b.display_name, clock() + L.codeTtlMs, user.id, code);
          log(b.id, 'reissue_code', { by: 'owner' });
          return redirect(res, `/app/bots/${b.id}`), true;
        }
        if (sub === '/backup' && req.method === 'POST') {
          const f = await form(req);
          const h = Number(f.every || 0);
          const every = [2, 4, 8, 12, 24].includes(h) ? h : null;
          q('UPDATE bots SET backup_every_h = ? WHERE id = ?').run(every, b.id);
          tell(user, { what: every ? `Backs up every ${every} hours` : 'Backups off', undo: f.undo === '1' || every === b.backup_every_h ? null : undoForm(`/app/bots/${b.id}/backup`, { every: b.backup_every_h ?? 0 }) });
          return redirect(res, `/app/bots/${b.id}#backup`), true;
        }
        if (sub === '/test' && req.method === 'POST') {
          if (b.disconnected_at || b.vendor === 'web') return json(res, 409, { error: 'This bot is not connected.' }), true;
          try { const r = await routes['POST /v1/doorbell/test']({ me: b, byOwner: true }); return json(res, 200, r), true; }
          catch (e) { if (e instanceof HttpError) return json(res, e.status, { error: e.message }), true; throw e; }
        }
      }

      if (p === '/app/contacts/privacy' && req.method === 'POST') {
        const f = await form(req);
        const { b, c } = ownContact(user, f.bot, f.peer);
        const on = f.on === '1';
        if (!inPilot(user) && (on || !c.privacy_on)) throw new HttpError(404, 'Page not found');
        tx(() => {
          setPrivacyInTx(b.id, c.peer_bot, on);
          if (!!c.privacy_on !== on) log(b.id, on ? 'privacy_on' : 'privacy_off', { peer: c.peer_bot, by: 'owner' });
        });
        tell(user, on ? { what: `Asks you first for ${c.alias}`, undo: f.undo === '1' ? null : undoForm('/app/contacts/privacy', { bot: b.id, peer: c.peer_bot }) }
          : { what: `Writes to ${c.alias} without asking`, undo: inPilot(user) && f.undo !== '1' ? undoForm('/app/contacts/privacy', { bot: b.id, peer: c.peer_bot, on: '1' }) : null });
        return redirect(res, `/app#f-${b.id}-${c.peer_bot}`), true;
      }
      if (p.startsWith('/app/contacts/') && req.method === 'POST') {
        const f = await form(req);
        const { b, c } = ownContact(user, f.bot, f.peer);
        const action = p.slice('/app/contacts/'.length);
        if (action === 'approve') {
          q('UPDATE contacts SET approved_at = ? WHERE owner_bot = ? AND peer_bot = ?').run(clock(), b.id, c.peer_bot);
          log(b.id, 'contact_approved', { peer: c.peer_bot });
          tell(user, { what: `${c.alias} connected` });
        } else if (action === 'block') {
          const unblock = f.unblock === '1';
          tx(() => {
            q('UPDATE contacts SET blocked = ? WHERE owner_bot = ? AND peer_bot = ?').run(unblock ? 0 : 1, b.id, c.peer_bot);
            bumpPair(b.id, c.peer_bot);
            if (!unblock) dropBetween(b.id, c.peer_bot);
          });
          log(b.id, unblock ? 'contact_unblocked' : 'contact_blocked', { peer: c.peer_bot, by: 'owner' });
          tell(user, unblock ? { what: `Unblocked ${c.alias}`, undo: f.undo === '1' ? null : undoForm('/app/contacts/block', { bot: b.id, peer: c.peer_bot }) }
            : { what: `Blocked ${c.alias}`, undo: f.undo === '1' ? null : undoForm('/app/contacts/block', { bot: b.id, peer: c.peer_bot, unblock: '1' }) });
        } else if (action === 'disallow') {
          // The dashboard can only take topics away; adding them is done by telling your own bot.
          const left = JSON.parse(c.can_ask || '[]').filter((t) => t !== String(f.topic || ''));
          q('UPDATE contacts SET can_ask = ? WHERE owner_bot = ? AND peer_bot = ?').run(JSON.stringify(left), b.id, c.peer_bot);
          log(b.id, 'ask_topic_removed', { peer: c.peer_bot, by: 'owner' });
          tell(user, { what: `${c.alias} can't ask about ${String(f.topic || '')}` });
        } else if (action === 'remove') {
          tx(() => {
            bumpPair(b.id, c.peer_bot);
            q('DELETE FROM contacts WHERE (owner_bot = ? AND peer_bot = ?) OR (owner_bot = ? AND peer_bot = ?)').run(b.id, c.peer_bot, c.peer_bot, b.id);
            dropBetween(b.id, c.peer_bot);
          });
          log(b.id, 'contact_removed', { peer: c.peer_bot, by: 'owner' });
          tell(user, { what: `Removed ${c.alias}` });
        } else throw new HttpError(404, 'Page not found');
        return redirect(res, '/app'), true;
      }

      if (p === '/app/pause' && req.method === 'POST') {
        const f = await form(req);
        const on = f.on === '1';
        for (const b of liveBots(user)) {
          tx(() => {
            if (on) bumpGen(b.id);
            q('UPDATE bots SET paused_at = ? WHERE id = ?').run(on ? clock() : null, b.id);
          });
          log(b.id, on ? 'paused' : 'resumed', { by: 'owner' });
          if (!on) release(b.id);
        }
        tell(user, on ? { what: 'Paused', undo: f.undo === '1' ? null : undoForm('/app/pause', { on: '0' }) }
          : { what: 'Resumed', undo: f.undo === '1' ? null : undoForm('/app/pause', { on: '1' }) });
        return redirect(res, '/app'), true;
      }

      // People and requests: pilot owners only, each for their own bots. Changes made here are the owner's.
      if (p === '/app/people' && req.method === 'GET') return page(res, 200, peoplePage(user, pickBot(user, url.searchParams.get('bot')))), true;
      const pa = p.match(/^\/app\/people\/(move|mode|baskets|restore)$/);
      if (pa && req.method === 'POST') {
        const f = await form(req);
        const b = pickBot(user, f.bot);
        const id = (v) => (v === '' || v == null ? null : Number(v));
        const undone = f.undo === '1';
        const group = (cid) => q('SELECT * FROM circles WHERE id = ? AND owner_bot = ?').get(cid, b.id);
        const contact = (peer) => q('SELECT alias, circle_id FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(b.id, peer);
        const before = pa[1] === 'move' ? contact(Number(f.peer)) : pa[1] === 'restore' ? null : f.circle ? group(Number(f.circle)) : null;
        const members = pa[1] === 'baskets' && f.delete === '1' && before ? q('SELECT peer_bot FROM contacts WHERE owner_bot = ? AND circle_id = ?').all(b.id, before.id).map((r) => r.peer_bot) : [];
        const restore = pa[1] === 'restore' ? String(f.peers || '').split(',').filter((x) => /^\d+$/.test(x)).map(Number).slice(0, 500) : [];
        const ops = pa[1] === 'move' ? [{ op: 'move', contact: Number(f.peer), circle: id(f.circle) }]
          : pa[1] === 'mode' ? [{ op: 'set_mode', circle: Number(f.circle), mode: f.mode }]
          : pa[1] === 'restore' ? [{ op: 'add_circle', name: String(f.name ?? ''), mode: f.mode === 'asks' ? 'asks' : 'handles' }, ...restore.map((peer) => ({ op: 'move', contact: peer, circle: String(f.name ?? '') }))]
          : f.delete === '1' ? [{ op: 'delete_circle', circle: Number(f.circle) }]
          : f.circle ? [{ op: 'rename_circle', circle: Number(f.circle), name: String(f.name ?? '') }]
          : [{ op: 'add_circle', name: String(f.name ?? ''), mode: 'handles' }];
        let result;
        try { result = applyOwnerOps(b.id, ops); }
        catch (e) { if (e instanceof HttpError && e.status !== 404) return page(res, e.status, peoplePage(user, b, { error: ownerError(e) })), true; throw e; }
        const back = (u) => (undone ? {} : { undo: u });
        if (pa[1] === 'move') {
          const peer = Number(f.peer), now = contact(peer), g = now.circle_id ? group(now.circle_id) : null;
          tell(user, { what: g ? `Moved ${now.alias} to ${g.name}` : `Moved ${now.alias} to not sorted yet`, ...back(undoForm('/app/people/move', { bot: b.id, peer, circle: before.circle_id ?? '' })) });
        } else if (pa[1] === 'mode') {
          const g = group(Number(f.circle));
          tell(user, { what: g.mode === 'asks' ? `${g.name} asks you first` : `Your bot handles ${g.name}`, ...back(undoForm('/app/people/mode', { bot: b.id, circle: g.id, mode: before.mode })) });
        } else if (pa[1] === 'restore') {
          tell(user, { what: `${String(f.name)} is back` });
        } else if (f.delete === '1') {
          tell(user, { what: `Removed ${before.name}`, undo: undoForm('/app/people/restore', { bot: b.id, name: before.name, mode: before.mode, peers: members.join(',') }) });
        } else if (f.circle) {
          tell(user, { what: `Renamed to ${String(f.name).trim()}`, ...back(undoForm('/app/people/baskets', { bot: b.id, circle: before.id, name: before.name })) });
        } else {
          const added = result.applied.find((o) => o.op === 'add_circle');
          tell(user, { what: `Added ${added.name}`, ...back(undoForm('/app/people/baskets', { bot: b.id, circle: added.id, delete: '1' })) });
        }
        return redirect(res, `/app/people?bot=${b.id}`), true;
      }
      const pm = p.match(/^\/app\/people\/(\d+)\/(\d+)(?:\/(basket|about|topics|rules))?$/);
      if (pm) {
        const b = pickBot(user, pm[1]);
        const peer = Number(pm[2]);
        if (!pm[3] && req.method === 'GET') return page(res, 200, personPage(user, b, peer)), true;
        if (pm[3] && req.method === 'POST') {
          const f = await form(req);
          personPage(user, b, peer); // 404 unless this is one of their people
          const undone = f.undo === '1';
          const was = getSettings(b.id).contacts.find((c) => c.peer_bot === peer);
          if (pm[3] === 'rules' && f.restore != null) {
            const n = q('UPDATE contact_rules SET removed_at = NULL WHERE id = ? AND owner_bot = ? AND peer_bot = ? AND removed_at IS NOT NULL').run(String(f.restore), b.id, peer).changes;
            if (!n) throw new HttpError(404, 'Rule not found');
            tell(user, { what: 'Rule is back' });
            return redirect(res, `/app/people/${b.id}/${peer}#rules`), true;
          }
          if (pm[3] === 'rules' && f.seen != null) {
            const n = q(`UPDATE contact_rules SET owner_seen_at = coalesce(owner_seen_at, ?)
              WHERE id = ? AND owner_bot = ? AND peer_bot = ? AND removed_at IS NULL`).run(clock(), String(f.seen), b.id, peer).changes;
            if (!n) throw new HttpError(404, 'Rule not found');
            return redirect(res, `/app/people/${b.id}/${peer}#rules`), true;
          }
          // One line each: the relay keeps purpose and notes on a single line.
          const line = (v) => String(v ?? '').replace(/\s*[\r\n]+\s*/g, ' ');
          const ops = pm[3] === 'basket' ? [{ op: 'move', contact: peer, circle: f.circle ? Number(f.circle) : null }, { op: 'set_mode', contact: peer, mode: f.mode === '' || f.mode == null ? null : f.mode }]
            : pm[3] === 'about' ? [{ op: 'set_purpose', contact: peer, purpose: line(f.purpose) }, { op: 'set_notes', contact: peer, notes: line(f.notes) }]
            : pm[3] === 'topics' ? [f.remove != null ? { op: 'remove_topic', contact: peer, topic: String(f.remove) } : { op: 'add_topic', contact: peer, topic: String(f.add ?? '') }]
            : [f.remove != null ? { op: 'remove_rule', rule: String(f.remove) } : { op: 'add_rule', contact: peer, text: line(f.add) }];
          if (pm[3] === 'rules' && f.remove != null && !q('SELECT 1 FROM contact_rules WHERE id = ? AND owner_bot = ? AND peer_bot = ?').get(String(f.remove), b.id, peer)) throw new HttpError(404, 'Rule not found');
          let result;
          try { result = applyOwnerOps(b.id, ops); }
          catch (e) { if (e instanceof HttpError && e.status !== 404) return page(res, e.status, personPage(user, b, peer, { error: ownerError(e) })), true; throw e; }
          const now = getSettings(b.id).contacts.find((c) => c.peer_bot === peer), base = `/app/people/${b.id}/${peer}`;
          const back = (u) => (undone ? {} : { undo: u });
          if (pm[3] === 'basket') {
            tell(user, { what: now.mode_override === 'asks' ? 'Asks you first' : now.circle ? `Moved to ${now.circle.name}` : 'Moved to not sorted yet',
              ...back(undoForm(`${base}/basket`, { circle: was.circle?.id ?? '', mode: was.mode_override ?? '' })) });
          } else if (pm[3] === 'about') {
            tell(user, { what: 'Saved', ...back(undoForm(`${base}/about`, { purpose: was.purpose ?? '', notes: was.notes ?? '' })) });
          } else if (pm[3] === 'topics') {
            const t = ops[0].topic.trim().toLowerCase();
            tell(user, f.remove != null ? { what: `Removed ${t}`, ...back(undoForm(`${base}/topics`, { add: t })) }
              : { what: `Added ${t}`, ...back(undoForm(`${base}/topics`, { remove: t })) });
          } else if (f.remove != null) {
            tell(user, { what: 'Rule removed', ...back(undoForm(`${base}/rules`, { restore: String(f.remove) })) });
          } else {
            const added = result.applied.find((o) => o.op === 'add_rule');
            tell(user, { what: 'Rule added', ...back(undoForm(`${base}/rules`, { remove: added?.id ?? added?.rule ?? '' })) });
          }
          return redirect(res, `/app/people/${b.id}/${peer}#${pm[3]}`), true;
        }
      }
      if (p === '/app/requests' && req.method === 'GET') {
        if (!govBots(user).length) throw new HttpError(404, 'Page not found');
        return page(res, 200, requestsPage(user)), true;
      }
      // The links a bot gives its owner. Only the owner of that bot can open them.
      const rq = p.match(/^\/app\/(requests|proposals)\/([A-Za-z0-9_-]{4,64})$/);
      if (rq) {
        const row = q(`SELECT owner_bot FROM ${rq[1] === 'requests' ? 'privacy_requests' : 'settings_proposals'} WHERE id = ?`).get(rq[2]);
        const b = row && govBots(user).find((x) => x.id === row.owner_bot);
        if (!b) throw new HttpError(404, 'Page not found');
        const f = req.method === 'POST' ? await form(req) : null;
        if (rq[1] === 'requests') {
          if (f) {
            const action = String(f.action || '');
            const draft = { text: String(f.text ?? '').replace(/\r\n/g, '\n'), links: String(f.links || '').split('\n').map((l) => l.trim()).filter(Boolean) };
            let r;
            try { r = decideRequest(b.id, rq[2], { action, revision: Number(f.revision), ...(action === 'edit' || action === 'write' ? { draft } : {}) }); }
            catch (e) { if (e instanceof HttpError && e.status !== 404) return page(res, e.status, oneRequestPage(user, getRequest(b.id, rq[2], { owner: true }), { error: ownerError(e) })), true; throw e; }
            const who = peerFace(b.id, r.peer_bot).alias;
            tell(user, { what: { ENQUEUED: `Sent to ${who}`, APPROVED: `Okayed. Your bot sends it to ${who}`, DECLINED: 'Declined' }[r.state] || 'Already decided' });
            return redirect(res, '/app/requests'), true;
          }
          if (req.method === 'GET') return page(res, 200, oneRequestPage(user, getRequest(b.id, rq[2], { owner: true }))), true;
        } else {
          const prop = () => q('SELECT * FROM settings_proposals WHERE id = ?').get(rq[2]);
          if (f) {
            let r;
            try { r = decideProposal(b.id, rq[2], String(f.decision || '')); }
            catch (e) { if (e instanceof HttpError) return page(res, e.status === 404 ? 409 : e.status, oneProposalPage(user, b, prop(), { error: `This change doesn't fit any more: ${ownerError(e)} Ask your bot again.` })), true; throw e; }
            tell(user, { what: { APPROVED: 'Done. Your bot has the new settings', DECLINED: 'Declined' }[r.state] || 'Already decided' });
            return redirect(res, '/app/requests'), true;
          }
          if (req.method === 'GET') { governance.expire(); return page(res, 200, oneProposalPage(user, b, prop())), true; }
        }
      }

      if (p === '/app/activity' && req.method === 'GET') return page(res, 200, activityPage(user)), true;
      if (p === '/app/web-inbox' && req.method === 'POST') {
        if (webInbox && !webBots(user).length) makeWebBot(user);
        return redirect(res, webBots(user).length ? '/app/inbox' : '/app'), true;
      }
      if (p === '/app/inbox' && req.method === 'GET') {
        const wbs = webBots(user);
        if (!wbs.length) return redirect(res, '/app'), true;
        const ph_ = wbs.map(() => '?').join(',');
        erase(`to_bot IN (${ph_}) AND status IN ('pending', 'claimed') AND kind != 'probe' AND created_at <= ?`, ...wbs.map((b) => b.id), clock() - L.undeliveredExpiryMs);
        const html = inboxPage(user);
        markSeen(wbs.map((b) => b.id));
        return page(res, 200, html), true;
      }
      if (p === '/app/inbox/send' && req.method === 'POST') {
        const f = await form(req);
        const { b, c } = ownContact(user, f.bot, f.peer);
        if (b.vendor !== 'web') throw new HttpError(404, 'Page not found');
        const peer = q('SELECT handle FROM bots WHERE id = ?').get(c.peer_bot);
        const choices = String(f.choices || '').split(',').map((x) => x.trim()).filter(Boolean);
        const body = { to: `@${peer.handle}`, text: String(f.text || ''), links: f.link ? [String(f.link).trim()] : [],
          kind: f.reply_to ? 'reply' : choices.length ? 'ask' : 'note', reply_to: f.reply_to || undefined, choices: f.reply_to ? undefined : choices };
        try { routes['POST /v1/messages']({ me: q('SELECT * FROM bots WHERE id = ?').get(b.id), body, viaWeb: true }); }
        catch (e) { if (e instanceof HttpError) return page(res, e.status, inboxPage(user, { error: e.message.replace(/^\w/, (x) => x.toUpperCase()) })), true; throw e; }
        tell(user, { what: `Sent to ${c.alias}` });
        return redirect(res, `/app/inbox#c-${c.peer_bot}`), true;
      }

      if (p === '/app/billing' && req.method === 'GET') {
        if (!hosted) return redirect(res, '/app'), true;
        return page(res, 200, billingPage(user, { paid: url.searchParams.get('paid') === '1' })), true;
      }
      if (p === '/app/billing/checkout' && req.method === 'POST') {
        if (!hosted || !B.stripeKey || !B.priceId) return page(res, 400, billingPage(user, { error: 'Payments are not set up on this server yet.' })), true;
        const body = new URLSearchParams({ mode: 'payment', 'line_items[0][price]': B.priceId, 'line_items[0][quantity]': '1',
          client_reference_id: String(user.id), customer_email: user.email,
          success_url: `${origin}/app/billing?paid=1`, cancel_url: `${origin}/app/billing` });
        const r = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', body,
          headers: { authorization: `Bearer ${B.stripeKey}`, 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(15_000) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || !String(data.url || '').startsWith('https://checkout.stripe.com/')) return page(res, 502, billingPage(user, { error: 'The payment page could not be opened. Try again in a minute.' })), true;
        return redirect(res, data.url), true;
      }
      if (p === '/app/billing/members' && req.method === 'POST') {
        if (!hosted) return redirect(res, '/app'), true;
        const f = await form(req);
        if (f.remove) {
          const gone = String(f.remove).toLowerCase();
          q('DELETE FROM household_members WHERE payer_user_id = ? AND email = ?').run(user.id, gone);
          tell(user, { what: `Removed ${gone}`, undo: f.undo === '1' ? null : undoForm('/app/billing/members', { email: gone }) });
        } else {
          const email = String(f.email || '').trim().toLowerCase();
          const n = q('SELECT count(*) AS n FROM household_members WHERE payer_user_id = ?').get(user.id).n;
          if (!EMAIL_RE.test(email) || email === user.email) return page(res, 400, billingPage(user, { error: 'That email address looks wrong.' })), true;
          if (n >= B.householdSize - 1) return page(res, 400, billingPage(user, { error: `Your plan covers up to ${B.householdSize - 1} people.` })), true;
          q('INSERT OR IGNORE INTO household_members (payer_user_id, email, added_at) VALUES (?, ?, ?)').run(user.id, email, clock());
          tell(user, { what: `Added ${email}`, undo: f.undo === '1' ? null : undoForm('/app/billing/members', { remove: email }) });
          if (user.paid_until > clock()) for (const b of q('SELECT b.id FROM bots b JOIN users x ON x.id = b.user_id WHERE x.email = ? AND b.disconnected_at IS NULL').all(email)) release(b.id);
        }
        return redirect(res, '/app/billing'), true;
      }

      if (p === '/app/account' && req.method === 'GET') return page(res, 200, accountPage(user)), true;
      if (p === '/app/picture' && req.method === 'GET') return page(res, 200, picturePage(user, safeNext(url.searchParams.get('next')))), true;
      // The page crops and shrinks a photo to a 256px square JPEG before it is sent; the server only checks it is one.
      if (p === '/app/picture' && req.method === 'POST') {
        const f = await form(req, 400_000);
        const next = safeNext(f.next);
        if (f.photo) {
          const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(f.photo));
          const jpg = m && Buffer.from(m[1], 'base64');
          if (!jpg || jpg.length > 200_000 || jpg[0] !== 0xff || jpg[1] !== 0xd8 || jpg[2] !== 0xff) return page(res, 400, picturePage(user, next, { error: 'That photo couldn\'t be used. Try a JPEG or PNG.' })), true;
          q('UPDATE users SET photo = ?, avatar = NULL, photo_at = ? WHERE id = ?').run(jpg, clock(), user.id);
        } else if (ROBOT.has(f.avatar) || isSticker(f.avatar)) q('UPDATE users SET avatar = ?, photo = NULL, photo_at = ? WHERE id = ?').run(f.avatar, clock(), user.id);
        else if (!hasPicture(user)) return page(res, 400, picturePage(user, next, { error: 'Pick a picture or upload a photo.' })), true;
        // A picked picture can be swapped back; a replaced photo is gone.
        const was = user.avatar || null; // a photo clears avatar
        tell(user, { what: 'Picture saved', undo: was && was !== f.avatar && f.undo !== '1' ? undoForm('/app/picture', { avatar: was, next }) : null });
        return redirect(res, next), true;
      }
      // Only the person and friends who said yes to them can see their photo.
      const photo = /^\/app\/photo\/(\d+)$/.exec(p);
      if (photo && req.method === 'GET') {
        const id = Number(photo[1]);
        const ok = id === user.id || q(`SELECT 1 FROM contacts c JOIN bots theirs ON theirs.id = c.owner_bot JOIN bots mine ON mine.id = c.peer_bot
          WHERE theirs.user_id = ? AND mine.user_id = ? AND c.approved_at IS NOT NULL AND c.blocked = 0 LIMIT 1`).get(id, user.id);
        const row = ok && q('SELECT photo FROM users WHERE id = ?').get(id);
        if (!row?.photo) { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return true; }
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" });
        res.end(Buffer.from(row.photo));
        return true;
      }
      if (p === '/app/account/quiet' && req.method === 'POST') {
        const f = await form(req);
        const start = parseHhmm(f.start), end = parseHhmm(f.end);
        if (start === null || end === null || !validTz(f.tz)) return page(res, 400, accountPage(user, { quietError: 'Check the times and the time zone.' })), true;
        q('UPDATE users SET quiet_on = ?, quiet_start = ?, quiet_end = ?, tz = ? WHERE id = ?').run(f.on === '1' ? 1 : 0, start, end, f.tz, user.id);
        tell(user, { what: f.on === '1' ? `Quiet ${hhmm(start)} to ${hhmm(end)}` : 'Quiet hours off',
          undo: f.undo === '1' ? null : undoForm('/app/account/quiet', { ...(user.quiet_on ? { on: '1' } : {}), start: hhmm(user.quiet_start ?? 1320), end: hhmm(user.quiet_end ?? 480), tz: user.tz || f.tz }) });
        if (f.on !== '1' || !quietUntil({ ...user, quiet_on: f.on === '1' ? 1 : 0, quiet_start: start, quiet_end: end, tz: f.tz }, clock())) for (const b of liveBots(user)) release(b.id);
        return redirect(res, '/app/account'), true;
      }
      if (p === '/app/account/export' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${product}-export.json"` });
        res.end(JSON.stringify({ ...exportData(user), ...(inPilot(user) ? { governance: governance.exportData(myBots(user).map((b) => b.id)) } : {}) }, null, 2));
        return true;
      }
      if (p === '/app/account/delete' && req.method === 'POST') {
        const f = await form(req);
        if (String(f.confirm || '').trim().toLowerCase() !== user.email) return page(res, 400, accountPage(user, { error: 'Type your email address exactly to confirm.' })), true;
        deleteAccount(user);
        res.setHeader('set-cookie', sessionCookie('', 0));
        return page(res, 200, layout('Account deleted', '<section class="card narrow center"><h1>Your account is deleted</h1><p>Your bots are disconnected, contacts removed and message text erased. Copies your friends\' bots already received stay with them.</p><a class="btn wide" href="/">Back to ' + esc(product) + '</a></section>')), true;
      }

      if (p === '/app/invites' && req.method === 'POST') {
        const f = await form(req);
        const b = ownBot(user, f.bot);
        const plain = humanCode();
        if (b.disconnected_at) throw new HttpError(400, 'Reconnect this bot first.');
        // New friends start in friends unless the owner picks another basket on the next page.
        const basket = pickBasket(b.id, f.basket ?? 'friends');
        q('INSERT INTO invites (code_hash, from_bot, alias, expires_at, by_owner, basket) VALUES (?, ?, ?, ?, 1, ?)').run(sha(plain), b.id, `friend-${plain.slice(0, 4).toLowerCase()}`, clock() + L.inviteTtlMs, basket);
        log(b.id, 'invite_created', { via: 'link' });
        return page(res, 200, invitedPage(user, b, `${origin}/i/${plain}`, { code: plain, basket })), true;
      }
      if (p === '/app/invites/basket' && req.method === 'POST') {
        const f = await form(req);
        const b = ownBot(user, f.bot);
        const plain = String(f.code || '').trim().toUpperCase();
        const inv = q('SELECT * FROM invites WHERE code_hash = ? AND from_bot = ? AND used_at IS NULL AND expires_at > ?').get(sha(plain), b.id, clock());
        if (!inv) throw new HttpError(404, 'That invite was used or has expired.');
        const basket = pickBasket(b.id, f.basket || null);
        const notes = f.notes === undefined ? inv.notes : String(f.notes).normalize('NFC').trim().slice(0, 280) || null;
        q('UPDATE invites SET basket = ?, notes = ? WHERE code_hash = ?').run(basket, notes, inv.code_hash);
        tell(user, { what: notes !== inv.notes ? 'Saved for your bot' : basket ? `They'll be in ${basket}` : 'They\'ll be not sorted yet' });
        return page(res, 200, invitedPage(user, b, `${origin}/i/${plain}`, { code: plain, basket, notes })), true;
      }

      throw new HttpError(404, 'Page not found');
    } catch (e) {
      if (e instanceof HttpError) { page(res, e.status, layout('Error', `<section class="card narrow"><h1>${e.status === 404 ? 'Not found' : 'Something went wrong'}</h1><p>${esc(e.message)}</p><a class="btn" href="/app">Back</a></section>`)); return true; }
      throw e;
    }
  };
}

// Icons: lucide shapes (ISC), 1.75 stroke as Arc asks. The bot mark is the brand, so it stays filled.
const svg = (inner, fill = false) => `<svg viewBox="0 0 24 24" aria-hidden="true" ${fill ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"'}>${inner}</svg>`;
// Default profile pictures: the bot2bot robot, twelve ways. Drawn here, so there are no files to ship or license.
const ROBOTS = [
  { key: 'classic', name: 'Classic robot', bg: '#dfe6ff', head: 'white', eyes: 'pill', ball: '#2747c9' },
  { key: 'night', name: 'Night robot', bg: '#cfd8f6', head: 'ink', eyes: 'pill', ball: '#2747c9' },
  { key: 'blossom', name: 'Blossom robot', bg: '#ffe0ea', head: 'white', eyes: 'happy', ball: '#ef7fa3' },
  { key: 'sleepy', name: 'Sleepy robot', bg: '#e6e9ef', head: 'white', eyes: 'sleepy', ball: '#b9c1cd' },
  { key: 'mint', name: 'Mint robot', bg: '#d5f2e3', head: 'white', eyes: 'dots', ball: '#1f9d6b' },
  { key: 'sunny', name: 'Winking robot', bg: '#ffedc2', head: 'white', eyes: 'wink', ball: '#f0a020', tilt: -8 },
  { key: 'coral', name: 'Coral robot', bg: '#ffe3d8', head: 'coral', eyes: 'pill', ball: '#ffffff' },
  { key: 'lilac', name: 'Surprised robot', bg: '#e9e2ff', head: 'white', eyes: 'wide', ball: '#7a5cff' },
  { key: 'sky', name: 'Blue robot', bg: '#d4eefa', head: 'blue', eyes: 'happy', ball: '#ffffff' },
  { key: 'visor', name: 'Visor robot', bg: '#1a2230', head: 'white', eyes: 'visor', ball: '#4f74ff' },
  { key: 'leaf', name: 'Curious robot', bg: '#e3f1d3', head: 'white', eyes: 'side', ball: '#5a9e3a', tilt: 7 },
  { key: 'shy', name: 'Shy robot', bg: '#f3f5f8', head: 'white', eyes: 'shy', ball: '#ef7fa3' },
];
const ROBOT = new Map(ROBOTS.map((r) => [r.key, r]));
const HEADS = { white: ['#ffffff', '#e6eaf1', '#c3cad5', '#1a2230'], ink: ['#2a3446', '#141a25', '#3b475e', '#ffffff'], coral: ['#ff9d84', '#f2775b', '#f6a893', '#ffffff'], blue: ['#4565e6', '#2747c9', '#8ea4f5', '#ffffff'] };
function robotSvg(r) {
  const [top, bottom, stem, eye] = HEADS[r.head];
  const g = `rg-${r.key}`;
  const pill = (x) => `<rect class="e" x="${x}" y="52" width="7" height="12" rx="3.5" fill="${eye}"/>`;
  const arc = (x) => `<path class="e" d="M${x} 61q5.5-7 11 0" fill="none" stroke="${eye}" stroke-width="3.2" stroke-linecap="round"/>`;
  const eyes = {
    pill: pill(36) + pill(53),
    happy: arc(33) + arc(52),
    sleepy: `<rect class="e" x="33" y="57" width="11" height="3.2" rx="1.6" fill="${eye}"/><rect class="e" x="52" y="57" width="11" height="3.2" rx="1.6" fill="${eye}"/>`,
    dots: `<circle class="e" cx="39.5" cy="58" r="4.4" fill="${eye}"/><circle class="e" cx="56.5" cy="58" r="4.4" fill="${eye}"/>`,
    wink: pill(36) + arc(51),
    wide: `<ellipse class="e" cx="39.5" cy="58" rx="4.6" ry="7" fill="${eye}"/><ellipse class="e" cx="56.5" cy="58" rx="4.6" ry="7" fill="${eye}"/>`,
    visor: `<rect x="29" y="51.5" width="38" height="13" rx="6.5" fill="#1a2230"/><rect class="e" x="36" y="55" width="7" height="6" rx="3" fill="${r.ball}"/><rect class="e" x="53" y="55" width="7" height="6" rx="3" fill="${r.ball}"/>`,
    side: pill(40) + pill(57),
    shy: `<rect class="e" x="36" y="54" width="7" height="9" rx="3.5" fill="${eye}"/><rect class="e" x="53" y="54" width="7" height="9" rx="3.5" fill="${eye}"/><ellipse cx="31" cy="67" rx="4.5" ry="2.6" fill="#ef7fa3" opacity=".45"/><ellipse cx="65" cy="67" rx="4.5" ry="2.6" fill="#ef7fa3" opacity=".45"/>`,
  }[r.eyes];
  return `<svg viewBox="6 7 84 84" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="${g}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>`
    + `<rect width="96" height="96" fill="${r.bg}"/>`
    + `<g${r.tilt ? ` transform="rotate(${r.tilt} 48 62)"` : ''}><path d="M48 38V25" stroke="${stem}" stroke-width="3" stroke-linecap="round"/><circle class="b" cx="48" cy="21" r="5.2" fill="${r.ball}"/>`
    + `<rect x="20" y="38" width="56" height="44" rx="17" fill="url(#${g})"/>${eyes}</g></svg>`;
}
const ROBOT_SVG = new Map(ROBOTS.map((r) => [r.key, robotSvg(r)]));
const ICON = {
  photo: svg('<rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10.5" r="1.8"/><path d="m21 16-4.5-4.5L8 20"/>'),
  bot: svg('<circle cx="12" cy="3.2" r="1.7"/><rect x="11.2" y="3.5" width="1.6" height="4" rx=".8"/><path fill-rule="evenodd" d="M7.5 7.5h9A4.5 4.5 0 0 1 21 12v4a4.5 4.5 0 0 1-4.5 4.5h-9A4.5 4.5 0 0 1 3 16v-4a4.5 4.5 0 0 1 4.5-4.5Zm1.6 4a1.1 1.1 0 0 0-1.1 1.1v2.3a1.1 1.1 0 0 0 2.2 0v-2.3a1.1 1.1 0 0 0-1.1-1.1Zm5.8 0a1.1 1.1 0 0 0-1.1 1.1v2.3a1.1 1.1 0 0 0 2.2 0v-2.3a1.1 1.1 0 0 0-1.1-1.1Z"/>', true),
  overview: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
  activity: svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  inbox: svg('<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/>'),
  person: svg('<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>'),
  card: svg('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>'),
  people: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
  invite: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>'),
  plus: svg('<path d="M5 12h14M12 5v14"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  alert: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  dots: svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>', true),
  chev: svg('<path d="m9 18 6-6-6-6"/>'),
  out: svg('<path d="M7 17 17 7M7 7h10v10"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  updown: svg('<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>'),
  chevDown: svg('<path d="m6 9 6 6 6-6"/>'),
  arrowUp: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
};
// The people page: drag a sticker into a basket (mouse or finger), or press Enter on it for "Move to…".
// Every move is the same form post as without JavaScript; the page it answers with replaces the board and the
// stickers glide from where they were (FLIP). A long press shows a name on phones.
function peopleScript() {
  if (window.__people) return;
  window.__people = true;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const fine = matchMedia('(hover: hover) and (pointer: fine)');
  const spring = getComputedStyle(document.documentElement).getPropertyValue('--ease-spring').trim() || 'ease-out';
  const STK = '#people-board .pool .stk, #people-board .pile .stk';
  const live = document.createElement('div');
  live.className = 'sr'; live.setAttribute('aria-live', 'polite'); document.body.append(live);
  const say = (t) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); };
  const data = () => JSON.parse($('#people-data').textContent);
  const wire = () => $$(STK).forEach((el) => el.setAttribute('aria-describedby', 'stk-help'));
  wire();
  if (!reduce.matches) $$(STK).forEach((el, i) => { el.style.animationDelay = `${i * 45}ms`; el.classList.add('settle'); el.addEventListener('animationend', () => { el.classList.remove('settle'); el.style.animationDelay = ''; }, { once: true }); });

  // Posts a form and puts the page the server answers with in place of this one.
  async function post(action, fields, from = {}) {
    let res, html;
    try { res = await fetch(action, { method: 'POST', body: new URLSearchParams(fields) }); html = await res.text(); } catch { location.reload(); return false; }
    const fresh = new DOMParser().parseFromString(html, 'text/html').querySelector('.col');
    if (!fresh) { location.reload(); return false; }
    const before = {};
    $$('#people-board [data-peer]').forEach((el) => { before[el.dataset.peer] = el.getBoundingClientRect(); });
    Object.assign(before, from);
    $('.col').replaceChildren(...fresh.childNodes);
    const said = fresh.ownerDocument.querySelector('.toast');
    $('body > .toast')?.remove();
    if (said) document.body.append(said);
    wire();
    if (!reduce.matches) $$('#people-board [data-peer]').forEach((el) => {
      const a = before[el.dataset.peer];
      if (!a) return;
      const b = el.getBoundingClientRect();
      const dx = a.left + a.width / 2 - (b.left + b.width / 2), dy = a.top + a.height / 2 - (b.top + b.height / 2), s = a.width / b.width;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(s - 1) < 0.01) return;
      const dropped = !!from[el.dataset.peer];
      el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})${dropped ? ' rotate(-6deg)' : ''}`, zIndex: 20 }, { transform: 'none', zIndex: 20 }], { duration: dropped ? 620 : 520, easing: spring });
    });
    return res.ok;
  }
  async function moveTo(el, circle, from) {
    const d = data(), peer = el.dataset.peer, name = el.dataset.name;
    if (String(el.dataset.in) === String(circle)) return;
    const ok = await post('/app/people/move', { bot: d.bot, peer, circle }, from ? { [peer]: from } : {});
    const g = d.baskets.find((x) => String(x.id) === String(circle));
    if (ok) say(!g ? `${name} is not sorted yet, so your bot asks you first.` : g.mode === 'asks' ? `${name} is in ${g.name}. Your bot asks you first.` : `${name} is in ${g.name}.`);
    return ok;
  }

  // Peel: a sticker tilts toward the pointer, like lifting one edge.
  document.addEventListener('pointermove', (e) => {
    if (!fine.matches || reduce.matches || drag) return;
    const el = e.target.closest?.(STK);
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--ry', `${(((e.clientX - r.left) / r.width - 0.5) * 18).toFixed(1)}deg`);
    el.style.setProperty('--rx', `${(-((e.clientY - r.top) / r.height - 0.5) * 18).toFixed(1)}deg`);
  });
  document.addEventListener('pointerout', (e) => {
    const el = e.target.closest?.('.stk');
    if (el && !el.contains(e.relatedTarget)) { el.style.removeProperty('--rx'); el.style.removeProperty('--ry'); }
  });

  // Drag, with pointer events so a mouse and a finger work the same.
  let press = null, drag = null, suppress = false;
  document.addEventListener('dragstart', (e) => { if (e.target.closest?.('.stk')) e.preventDefault(); });
  document.addEventListener('contextmenu', (e) => { if (e.target.closest?.(STK)) e.preventDefault(); });
  document.addEventListener('pointerdown', (e) => {
    const el = e.target.closest(STK);
    if (!el || (e.pointerType === 'mouse' && e.button !== 0)) return;
    closeMenu();
    press = { el, x: e.clientX, y: e.clientY, id: e.pointerId };
    try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    if (e.pointerType !== 'mouse') press.timer = setTimeout(() => { el.classList.add('is-named'); if (press) press.named = true; }, 420);
  });
  document.addEventListener('pointermove', (e) => {
    if (!press || e.pointerId !== press.id) return;
    if (!drag && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) startDrag(e);
    if (drag) moveDrag(e);
  });
  function startDrag(e) {
    clearTimeout(press.timer);
    const el = press.el, r = el.getBoundingClientRect();
    const g = document.createElement('div');
    g.className = 'drag-ghost';
    g.style.width = `${r.width}px`; g.style.height = `${r.height}px`; g.style.setProperty('--s', `${r.width}px`);
    g.append(el.querySelector('.stk__img').cloneNode(true));
    document.body.append(g);
    el.classList.add('is-peeled'); el.classList.remove('is-named');
    const tilt = parseFloat(getComputedStyle(el).getPropertyValue('--tilt')) || 0;
    drag = { g, r, ox: press.x - r.left, oy: press.y - r.top, vx: 0, lastX: e.clientX, tilt, over: null };
  }
  function moveDrag(e) {
    drag.vx = drag.vx * 0.7 + (e.clientX - drag.lastX) * 0.3;
    drag.lastX = e.clientX;
    const sway = reduce.matches ? 0 : Math.max(-14, Math.min(14, drag.vx * 1.4));
    drag.g.style.transform = `translate(${e.clientX - drag.ox}px, ${e.clientY - drag.oy}px) rotate(${drag.tilt + sway}deg) scale(${reduce.matches ? 1 : 1.12})`;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('#people-board [data-drop]') || null;
    if (over !== drag.over) { drag.over?.classList.remove('is-over'); over?.classList.add('is-over'); drag.over = over; }
  }
  function endPress(e, cancelled) {
    if (!press || e.pointerId !== press.id) return;
    clearTimeout(press.timer);
    const { el } = press;
    if (press.named) { suppress = true; setTimeout(() => el.classList.remove('is-named'), 1400); }
    if (drag) {
      suppress = true;
      const { g, over, r, tilt } = drag;
      over?.classList.remove('is-over');
      const target = !cancelled && over ? over.dataset.drop : null;
      if (target !== null && target !== String(el.dataset.in)) {
        const from = g.getBoundingClientRect();
        g.remove();
        moveTo(el, target, from).then((ok) => { if (ok === false) el.classList.remove('is-peeled'); });
      } else if (reduce.matches) { g.remove(); el.classList.remove('is-peeled'); }
      else {
        const a = g.animate([{ transform: g.style.transform }, { transform: `translate(${r.left}px, ${r.top}px) rotate(${tilt}deg)` }], { duration: 420, easing: spring });
        a.onfinish = () => { g.remove(); el.classList.remove('is-peeled'); };
      }
      drag = null;
    }
    press = null;
  }
  document.addEventListener('pointerup', (e) => endPress(e, false));
  document.addEventListener('pointercancel', (e) => endPress(e, true));
  // After a drag or a long press, the tap that ends it doesn't open their page.
  document.addEventListener('click', (e) => { if (suppress && e.target.closest?.('.stk')) { e.preventDefault(); suppress = false; } }, true);

  // "Move to…": Enter on a sticker; Space opens their page.
  const menu = document.createElement('div');
  menu.className = 'mv'; menu.setAttribute('role', 'menu'); menu.hidden = true;
  document.body.append(menu);
  let anchor = null;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  function openMenu(el) {
    anchor = el;
    const d = data(), cur = String(el.dataset.in);
    const item = (to, name, asks) => `<button type="button" role="menuitemradio" aria-checked="${cur === String(to)}" data-to="${to}" tabindex="-1"><span class="hand">${esc(name)}</span>${asks ? '<span class="mv__mode">asks you first</span>' : ''}</button>`;
    menu.innerHTML = `<div class="mv__title" id="mv-title">Move ${esc(el.dataset.name)} to</div>${d.baskets.map((g) => item(g.id, g.name, g.mode === 'asks')).join('')}${item('', 'not sorted yet', true)}<hr><a role="menuitem" tabindex="-1" href="${esc(el.getAttribute('href'))}">Open ${esc(el.dataset.name)}'s page</a>`;
    menu.setAttribute('aria-labelledby', 'mv-title');
    menu.hidden = false;
    const r = el.getBoundingClientRect(), w = menu.offsetWidth;
    const left = Math.max(8, Math.min(r.left + scrollX + r.width / 2 - w / 2, document.documentElement.clientWidth - w - 8));
    menu.style.left = `${left}px`; menu.style.top = `${r.bottom + scrollY + 8}px`;
    menu.style.setProperty('--ox', `${r.left + r.width / 2 - left}px`);
    const items = $$('[role^="menuitem"]', menu);
    (items.find((i) => i.getAttribute('aria-checked') === 'true') || items[0]).focus();
  }
  function closeMenu(restore) {
    if (menu.hidden) return;
    menu.hidden = true;
    if (restore && anchor?.isConnected) anchor.focus();
  }
  document.addEventListener('keydown', (e) => {
    const el = e.target.closest?.(STK);
    if (el && e.key === 'Enter') { e.preventDefault(); openMenu(el); }
    if (el && e.key === ' ') { e.preventDefault(); location.href = el.href; }
  });
  menu.addEventListener('keydown', (e) => {
    const items = $$('[role^="menuitem"]', menu), i = items.indexOf(document.activeElement);
    const go = (n) => { e.preventDefault(); items[(n + items.length) % items.length].focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') { e.preventDefault(); closeMenu(true); }
    else if (e.key === 'Tab') closeMenu(false);
  });
  menu.addEventListener('click', async (e) => {
    const to = e.target.closest('[data-to]');
    if (!to) return;
    const peer = anchor.dataset.peer;
    closeMenu(false);
    if (await moveTo(anchor, to.dataset.to)) document.querySelector(`#people-board [data-peer="${peer}"]`)?.focus();
  });
  document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(false); });

  // "Asks you first" in a basket's menu: same form, no reload.
  document.addEventListener('submit', async (e) => {
    const f = e.target.closest?.('#people-board .bmenu__mode');
    if (!f) return;
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(f));
    if (!(await post(f.action, fields))) return;
    $(`#people-board .bmenu__mode input[name="circle"][value="${fields.circle}"]`)?.closest('.basket')?.querySelector('.bmenu summary')?.focus();
    const g = data().baskets.find((x) => String(x.id) === fields.circle);
    if (g) say(g.mode === 'asks' ? `${g.name}: your bot asks you first.` : `${g.name}: your bot handles it and asks you when it isn't sure.`);
  });
}
const PEOPLE_JS = `(${peopleScript.toString()})();`;
// Sticker profile pictures: die-cut PNGs listed in public/stickers/index.json, as "key" strings or {key, name}
// objects (or {stickers: [...]}). Read again whenever the list or the folder changes, so a new set shows up
// without a restart. Without a list, or with an empty one, the twelve robots are the choice.
const STICKER_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
function stickerSet(dir) {
  let seen = null, set = new Map();
  const read = () => {
    let stamp;
    try { stamp = `${statSync(join(dir, 'index.json')).mtimeMs}:${statSync(dir).mtimeMs}`; } catch { stamp = 'none'; }
    if (stamp === seen) return set;
    seen = stamp; set = new Map();
    try {
      const raw = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
      for (const it of Array.isArray(raw) ? raw : Array.isArray(raw?.stickers) ? raw.stickers : []) {
        const key = typeof it === 'string' ? it : it?.key ?? it?.id ?? String(it?.file ?? '').replace(/\.png$/, '');
        const name = typeof it === 'string' ? '' : String(it?.name ?? it?.label ?? '');
        if (typeof key === 'string' && STICKER_KEY.test(key) && existsSync(join(dir, `${key}.png`))) set.set(key, { key, name: name.slice(0, 60) || 'Sticker' });
      }
    } catch { /* no list yet: robots only */ }
    return set;
  };
  read.dir = dir;
  return read;
}
const ART = new Set(['home', 'invite', 'setup', 'asleep'].filter((n) => existsSync(new URL(`./public/art/${n}.jpg`, import.meta.url))));
// Live pages refresh every 30 s, but never while you're typing, have a menu open or are answering a confirm.
const REFRESH_JS = `setInterval(()=>{if(document.visibilityState!=='visible'||document.querySelector('details[open],.cm[data-state=ask],.acc[data-open=true]')||/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||''))return;location.reload();},30000);`;
// The behaviour of the Arc components above, in plain JS. Every page loads it once.
const UI_JS = `(function(){const $$=(s,r=document)=>[...r.querySelectorAll(s)];document.documentElement.classList.add('js');
/* Button loading (Arc): on submit the label gives way to a spinner, focus stays, and a second press is swallowed. */
$$('form').forEach(f=>{const b=f.querySelector('.btn[data-busy]');if(!b)return;f.addEventListener('submit',e=>{if(b.getAttribute('aria-busy')==='true'){e.preventDefault();return;}b.setAttribute('aria-busy','true');b.setAttribute('aria-disabled','true');});});
addEventListener('pageshow',()=>$$('.btn[data-busy][aria-busy]').forEach(b=>{b.removeAttribute('aria-busy');b.removeAttribute('aria-disabled');}));
/* Arc avatar: a photo still downloading fades in from a soft blur; one that fails leaves the initial showing. */
$$('.avatar img').forEach(im=>{if(im.complete){if(!im.naturalWidth)im.remove();return;}im.dataset.loading='';im.addEventListener('load',()=>delete im.dataset.loading);im.addEventListener('error',()=>im.remove());});
/* Picture picker: a robot springs into the preview and blinks; a photo is cropped to its middle square, shrunk to 256px and sent as a JPEG. */
$$('form[data-pick]').forEach(f=>{const face=f.querySelector('[data-face]'),file=f.querySelector('[data-own-file]'),own=f.querySelector('[data-own]'),out=f.querySelector('input[name=photo]'),err=f.querySelector('[data-photo-error]');
const show=(html,cut)=>{face.innerHTML=html;face.toggleAttribute('data-cut',!!cut);face.classList.remove('go');void face.offsetWidth;face.classList.add('go');};
f.addEventListener('change',e=>{const r=e.target;if(r.name!=='avatar')return;out.value='';if(err)err.hidden=true;const p=r.closest('label').querySelector('.pfp__img');show(p.innerHTML,p.classList.contains('pfp__img--cut'));});
own.hidden=false;own.addEventListener('click',()=>file.click());
file.addEventListener('change',()=>{const x=file.files[0];if(!x)return;const u=URL.createObjectURL(x),im=new Image();
im.onload=()=>{const w=im.naturalWidth,h=im.naturalHeight,s=Math.min(w,h),c=document.createElement('canvas');c.width=c.height=256;const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,256,256);g.imageSmoothingQuality='high';g.drawImage(im,(w-s)/2,(h-s)/2,s,s,0,0,256,256);URL.revokeObjectURL(u);file.value='';
out.value=c.toDataURL('image/jpeg',.86);$$('input[name=avatar]',f).forEach(r=>r.checked=false);if(err)err.hidden=true;show('<img alt="" src="'+out.value+'">');};
im.onerror=()=>{URL.revokeObjectURL(u);file.value='';if(err)err.hidden=false;};im.src=u;});});
/* Menus: close on a press outside or Escape; a menu's inline confirm resets when it closes. */
const reset=d=>{const m=d.querySelector('.menu[data-confirming]');if(m){delete m.dataset.confirming;m.querySelector('.menu__confirm').hidden=true;}};
document.addEventListener('click',e=>{$$('details.more[open]').forEach(d=>{if(!d.contains(e.target)){d.open=false;reset(d);}});});
document.addEventListener('keydown',e=>{if(e.key==='Escape')$$('details.more[open]').forEach(d=>{d.open=false;reset(d);d.querySelector('summary').focus();});});
$$('details.more').forEach(d=>d.addEventListener('toggle',()=>{if(!d.open)reset(d);}));
$$('[data-reveal]').forEach(b=>b.addEventListener('click',e=>{e.preventDefault();const m=b.closest('.menu'),c=m.querySelector('.menu__confirm');m.dataset.confirming='';c.hidden=false;c.querySelector('button:not([type=button])').focus();}));
$$('[data-unreveal]').forEach(b=>b.addEventListener('click',()=>reset(b.closest('details'))));
/* Notices: dismissed by hand; pages that swap their content in place bring new ones along. */
/* Copy button: icon and label swap to Copied, the width never changes. */
$$('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{const t=document.querySelector(b.dataset.copy).innerText,l=b.querySelector('.copybtn__label');try{await navigator.clipboard.writeText(t);b.dataset.state='copied';l.textContent='Copied';}catch(e){l.textContent='Select it';}clearTimeout(b.t);b.t=setTimeout(()=>{delete b.dataset.state;l.textContent='Copy';},1800);}));
/* Confirm morph: the pill springs between its faces; Escape, Cancel, a press outside or 6 s of silence put it back. */
$$('.cm').forEach(f=>{const s=f.querySelector('.cm__surface'),face={},trig=f.querySelector('.cm__trigger'),yes=f.querySelector('.cm__confirm');$$('.cm__face',f).forEach(x=>face[x.dataset.face]=x);let at=0,timer;
const show=k=>{const from=s.getBoundingClientRect().width;for(const n in face)face[n].hidden=n!==k;f.dataset.state=k;s.style.width='';const to=s.getBoundingClientRect().width;s.style.width=from+'px';s.offsetWidth;s.style.width=to+'px';};
const rest=()=>{clearTimeout(timer);show('idle');};
trig.addEventListener('click',()=>{show('ask');at=Date.now();yes.focus();clearTimeout(timer);timer=setTimeout(()=>{if(f.dataset.state==='ask'&&!f.matches(':hover'))rest();},6000);});
f.querySelector('.cm__secondary').addEventListener('click',()=>{rest();trig.focus();});
f.addEventListener('submit',e=>{if(f.dataset.state!=='ask'||Date.now()-at<280){e.preventDefault();return;}show('pending');});
f.addEventListener('keydown',e=>{if(e.key==='Escape'&&f.dataset.state==='ask'){e.stopPropagation();rest();trig.focus();}});
document.addEventListener('pointerdown',e=>{if(f.dataset.state==='ask'&&!f.contains(e.target))rest();});});
/* Accordion rows: the panel opens to its own height; closed panels are inert, so focus never lands inside. */
$$('.acc__head').forEach(h=>h.addEventListener('click',()=>{const a=h.closest('.acc'),o=a.dataset.open!=='true',pn=a.querySelector('.acc__panel');a.dataset.open=String(o);h.setAttribute('aria-expanded',String(o));if(o)pn.removeAttribute('inert');else pn.setAttribute('inert','');}));
const hashed=location.hash?document.getElementById(location.hash.slice(1)):null;if(hashed?.classList.contains('acc__panel'))hashed.closest('.acc').querySelector('.acc__head').click();
/* Tabs: the highlight glides from the section you left to the one you opened. */
$$('.tabs').forEach(n=>{const sel=n.querySelector('.tabs__sel'),cur=n.querySelector('[aria-current]');if(!cur){sel.style.opacity='0';return;}
const at=el=>({x:el.offsetLeft,w:el.offsetWidth}),put=p=>{sel.style.width=p.w+'px';sel.style.transform='translateX('+p.x+'px)';};
let from=null;try{from=JSON.parse(sessionStorage.getItem('tab-from'));sessionStorage.removeItem('tab-from');}catch(e){}
put(from||at(cur));sel.offsetWidth;n.classList.add('ready');if(from)requestAnimationFrame(()=>put(at(cur)));
$$('a',n).forEach(a=>a.addEventListener('click',()=>{try{sessionStorage.setItem('tab-from',JSON.stringify(at(cur)));}catch(e){}put(at(a));}));addEventListener('resize',()=>put(at(cur)));});
/* Switch that saves as soon as it changes. */
$$('[data-autosave]').forEach(i=>i.addEventListener('change',()=>i.form.requestSubmit()));
/* Sortable table: one column at a time, aria-sort says which and which way. */
$$('th[data-sort]').forEach(th=>th.querySelector('button').addEventListener('click',()=>{const t=th.closest('table'),k=th.dataset.sort,num=th.dataset.type==='num',cur=th.getAttribute('aria-sort');const dir=cur?(cur==='ascending'?'descending':'ascending'):(num?'descending':'ascending');
$$('th[data-sort]',t).forEach(x=>x.removeAttribute('aria-sort'));th.setAttribute('aria-sort',dir);const tb=t.tBodies[0];[...tb.rows].sort((a,b)=>{const x=a.dataset[k],y=b.dataset[k],c=num?Number(x)-Number(y):x.localeCompare(y);return dir==='ascending'?c:-c;}).forEach(r=>tb.appendChild(r));}));
/* Segmented control: the selection glides under the chosen label and filters the rows it controls. */
$$('.seg').forEach(g=>{const sel=g.querySelector('.seg__sel'),bs=$$('button',g),scope=document.querySelector(g.dataset.for);const on=()=>bs.find(b=>b.getAttribute('aria-pressed')==='true')||bs[0];
const put=b=>{sel.style.width=b.offsetWidth+'px';sel.style.transform='translateX('+(b.offsetLeft-3)+'px)';};
bs.forEach(b=>b.addEventListener('click',()=>{bs.forEach(x=>x.setAttribute('aria-pressed',String(x===b)));put(b);const v=b.dataset.filter;if(scope)$$('[data-dir]',scope).forEach(r=>r.hidden=v!=='all'&&r.dataset.dir!==v);}));
put(on());requestAnimationFrame(()=>g.classList.add('ready'));addEventListener('resize',()=>put(on()));});
/* One-time code: six slots fill one hidden field; typing moves on, Backspace moves back, a paste fills them all. */
$$('.otp').forEach(g=>{const hid=g.querySelector('input[type=hidden]'),sl=$$('.otp__slot',g);
const sync=()=>{hid.value=sl.map(x=>x.value).join('');sl.forEach(x=>x.dataset.filled=String(!!x.value));if(hid.value.length===6)g.closest('form').requestSubmit();};
const fill=(i,v)=>{v.split('').slice(0,6-i).forEach((d,j)=>{sl[i+j].value=d;});sl[Math.min(5,i+v.length)].focus();sync();};
sl.forEach((x,i)=>{x.addEventListener('input',()=>{const v=x.value.replace(/[^0-9]/g,'');if(v.length>1)return fill(i,v);x.value=v;if(v&&i<5)sl[i+1].focus();sync();});
x.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!x.value&&i>0){sl[i-1].value='';sl[i-1].focus();sync();e.preventDefault();}else if(e.key==='ArrowLeft'&&i>0)sl[i-1].focus();else if(e.key==='ArrowRight'&&i<5)sl[i+1].focus();});
x.addEventListener('paste',e=>{const v=(e.clipboardData.getData('text')||'').replace(/[^0-9]/g,'');if(v){e.preventDefault();fill(i,v);}});});});
})();`;

// With the landing site on this server, the dashboard uses its faces (Mona for text, Hubot for page titles).
const FONTS = `@font-face{font-family:"Hubot";src:url(/fonts/hubot-display.woff2) format("woff2");font-weight:400 640;font-display:swap}
@font-face{font-family:"Mona";src:url(/fonts/mona-text.woff2) format("woff2");font-weight:400 600;font-display:swap}`;

const CSS = `
/* Arc UI (MIT, uiarc.dev) ported to plain CSS: foundation tokens on the bot2bot palette, then user menu, avatar,
   button, badge, alert, sortable data table, dropdown menu, confirm morph, segmented control, switch, stepper,
   usage meter, code block, copy button, OTP input, input, select and empty state. Weights are 400 and 500 only. */
:root{color-scheme:light;
--background:#f3f5f8;--surface:#fff;--surface-raised:#fff;--surface-muted:#eef1f5;--foreground:#1a2230;--text-secondary:#586377;--text-muted:#6b7588;
--border:#dde2e9;--border-subtle:#eaedf2;--border-strong:#c3cad5;--accent:#2747c9;--accent-strong:#1d379f;--accent-subtle:rgb(39 71 201 / .08);--accent-foreground:#fff;
--success:oklch(49% .15 150);--warning:oklch(56% .15 70);--danger:oklch(54% .2 25);
--control-on:var(--foreground);--control-glyph:var(--background);
--font-display:"Hubot","Mona",ui-sans-serif,system-ui,-apple-system,sans-serif;--font-body:"Mona",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;--font-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
--text-xs:12px;--text-sm:14px;--text-base:16px;--text-lg:18px;--text-xl:22px;--text-2xl:28px;--tracking-display:-.03em;--tracking-body:-.01em;--leading-body:1.45;
--radius-control:12px;--radius-panel:16px;--radius-surface:20px;--radius-pill:999px;
--control-height-sm:36px;--control-height-md:44px;--control-height-lg:50px;
--shadow-resting:0 1px 2px rgb(26 34 48 / .06);--shadow-floating:0 18px 40px -18px rgb(26 34 48 / .28),0 2px 6px rgb(26 34 48 / .06);
--duration-instant:120ms;--duration-fast:160ms;--duration-standard:240ms;--duration-spring:580ms;--ease-standard:cubic-bezier(.22,1,.36,1);
--ease-spring:linear(0,.0213,.0739,.1443,.2235,.305,.3849,.4606,.5305,.594,.6508,.7011,.7452,.7836,.8168,.8454,.8699,.8907,.9084,.9234,.9361,.9467,.9557,.9632,.9694,.9747,.979,.9826,.9857,.9882,.9902,.992,.9934,.9946,.9955,.9963,1);
--control-track:#c3cad5;--control-track-hover:#b3bbc8;--control-thumb:#fff;--control-thumb-shadow:0 1px 2px rgb(26 34 48 / .18),0 0 0 .5px rgb(26 34 48 / .06)}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--background);color:var(--foreground);font:400 var(--text-sm)/var(--leading-body) var(--font-body);letter-spacing:var(--tracking-body);-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
a{color:inherit}p{margin:0 0 12px}b,strong{font-weight:500}
h1{margin:0;font:500 var(--text-2xl)/1.1 var(--font-display);letter-spacing:var(--tracking-display)}
h2{margin:0 0 8px;font-size:var(--text-base);font-weight:500;letter-spacing:-.015em;line-height:1.3}h3{margin:0;font-size:var(--text-base);font-weight:500}
:focus-visible{outline:2px solid color-mix(in oklab,var(--accent) 72%,transparent);outline-offset:2px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.muted{color:var(--text-secondary)}.small{font-size:var(--text-xs)}.center{text-align:center}.inline{display:inline}
.handle{font-family:var(--font-mono);font-size:.92em;letter-spacing:0}

/* ── Top bar: the brand, the sections as tabs, and you ── */
.top{position:sticky;top:0;z-index:40;background:color-mix(in oklab,var(--background) 86%,transparent);-webkit-backdrop-filter:saturate(1.4) blur(14px);backdrop-filter:saturate(1.4) blur(14px);border-bottom:1px solid color-mix(in oklab,var(--border) 70%,transparent)}
.top__in{display:flex;align-items:center;gap:20px;max-width:760px;margin:0 auto;padding:12px 20px;padding-top:max(12px,env(safe-area-inset-top))}
.brand{display:inline-flex;align-items:center;gap:9px;font:500 var(--text-lg)/1 var(--font-display);letter-spacing:var(--tracking-display);text-decoration:none}.brand svg{width:22px;height:22px}
/* Tabs (Arc segmented control, as navigation): the highlight glides from the section you left. */
.tabs{position:relative;isolation:isolate;display:flex;gap:2px;margin-right:auto;padding:3px;border-radius:999px;background:color-mix(in oklab,var(--foreground) 5%,transparent)}
.tabs__item{position:relative;z-index:1;display:inline-flex;align-items:center;min-height:30px;padding:0 13px;border-radius:999px;color:var(--text-secondary);font-weight:500;text-decoration:none;white-space:nowrap;transition:color var(--duration-fast) var(--ease-standard)}
.tabs__item[aria-current="page"]{color:var(--foreground)}@media (hover:hover) and (pointer:fine){.tabs__item:hover{color:var(--foreground)}}
.tabs__sel{position:absolute;z-index:0;top:3px;bottom:3px;left:0;width:0;border-radius:999px;background:var(--surface);box-shadow:var(--shadow-resting),0 0 0 .5px color-mix(in oklab,var(--foreground) 8%,transparent)}
.tabs.ready .tabs__sel{transition:transform 520ms var(--ease-spring),width 520ms var(--ease-spring)}
/* Status dot: the bot's state at a glance. */
.dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--border-strong)}
.dot--live{background:var(--accent);animation:pulse 1.4s ease-in-out infinite}@keyframes pulse{50%{opacity:.3}}

/* ── Page: one centred column that settles in on arrival ── */
.page{min-width:0;padding:36px 20px 40px}
.col{width:100%;max-width:720px;margin:0 auto;display:grid;gap:28px;align-content:start;animation:page-in 420ms var(--ease-standard) both}.col>*{min-width:0}
.col--narrow{max-width:480px}@keyframes page-in{from{opacity:0;transform:translateY(8px)}}
body.in .legal{max-width:720px;margin:48px auto 0}
.pagehead{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px}
.pagehead__text{display:grid;gap:6px;min-width:0}.pagehead__sub{margin:0;color:var(--text-secondary)}
.pagehead__actions{display:flex;flex-wrap:wrap;gap:8px}.pagehead__actions form{margin:0}
.crumb{display:inline-flex;align-items:center;gap:4px;margin-left:-4px;color:var(--text-secondary);text-decoration:none;font-weight:500;font-size:var(--text-sm)}.crumb svg{width:16px;height:16px}.crumb:hover{color:var(--foreground)}
.note{display:flex;align-items:center;gap:6px;margin:0;color:var(--text-muted);font-size:var(--text-xs)}.note svg{width:13px;height:13px}
.legal{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:40px;font-size:var(--text-xs)}.legal a{color:var(--text-muted);text-decoration:none}.legal a:hover{color:var(--foreground);text-decoration:underline}
body.out{min-height:100vh;display:flex;flex-direction:column}body.out .topbar{padding:20px clamp(16px,3vw,40px)}
body.out main{flex:1;display:grid;gap:16px;align-content:start;padding:24px 16px 48px}body.out .legal{justify-content:center;margin:0 auto 28px}
.sim{margin:0 0 16px;padding:8px 14px;border-radius:var(--radius-control);background:color-mix(in oklab,var(--warning) 16%,var(--surface));color:var(--foreground);font-weight:500;text-align:center}

/* ── Cards (Arc surface): a border, no shadow ── */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-surface);padding:24px;min-width:0}
.card>:last-child{margin-bottom:0}.card.narrow{max-width:480px;width:100%;margin-inline:auto}
.card--flush{padding:0;overflow:visible}
.card__head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.card__head h2{margin:0;display:flex;align-items:center;gap:8px}.card__head form{margin:0}
.card__foot{margin:0;padding:12px 20px;border-top:1px solid var(--border-subtle);color:var(--text-muted);font-size:var(--text-xs)}
.card--flush>.card__head{padding:16px 16px 12px 20px;margin:0;min-height:60px}
.count{display:inline-grid;place-items:center;min-width:22px;height:22px;padding:0 7px;border-radius:var(--radius-pill);background:var(--surface-muted);color:var(--text-secondary);font-size:var(--text-xs);font-weight:500;font-variant-numeric:tabular-nums}
.card.attention{border-color:var(--foreground)}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}@media(max-width:860px){.grid3{grid-template-columns:1fr}}

/* ── Groups: a heading, then one card of rows ── */
.stack-alerts{display:grid;gap:12px}
.group{display:grid;gap:10px}.group__head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:36px;padding:0 4px}
.group__head h2{margin:0;display:flex;align-items:center;gap:8px}.group__head form{margin:0}
.card--list{padding:0;overflow:hidden}
.foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}

/* ── Lines: one row, one title, one quiet line under it ── */
.list{list-style:none;margin:0;padding:0}.list>li+li{border-top:1px solid var(--border-subtle)}
.line{display:flex;align-items:center;gap:14px;min-height:64px;padding:12px 20px;text-decoration:none;color:inherit}
.line__main{display:grid;flex:1;min-width:0;gap:1px}.line__title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.line__sub{font-size:var(--text-xs);color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.line__end{flex:none;color:var(--text-muted);font-size:var(--text-xs);font-variant-numeric:tabular-nums}
.line>svg,.acc__head>svg{width:16px;height:16px;flex:none;color:var(--text-muted);transition:transform var(--duration-standard) var(--ease-standard),color var(--duration-fast) var(--ease-standard)}
.line--link,.acc__head{transition:background-color var(--duration-fast) var(--ease-standard)}
@media (hover:hover) and (pointer:fine){.line--link:hover,.acc__head:hover{background:color-mix(in oklab,var(--foreground) 2.5%,var(--surface));--presence-surface:color-mix(in oklab,var(--foreground) 2.5%,var(--surface))}.line--link:hover>svg,.acc__head:hover>svg{color:var(--foreground)}}

/* ── Accordion row (Arc accordion): the panel opens to its own height, the chevron turns ── */
.acc__head{display:flex;align-items:center;gap:14px;width:100%;min-height:64px;padding:12px 20px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.acc__head:focus-visible{outline-offset:-2px}
.acc[data-open="true"]>.acc__head>svg{transform:rotate(180deg);color:var(--foreground)}
.acc__panel{display:grid;grid-template-rows:0fr;transition:grid-template-rows 360ms var(--ease-standard)}
.acc[data-open="true"]>.acc__panel{grid-template-rows:1fr}
.acc__inner{min-height:0;overflow:hidden}
.acc__body{padding:2px 20px 18px 62px;opacity:0;transform:translateY(-6px);transition:opacity 220ms var(--ease-standard),transform 360ms var(--ease-standard)}
.acc[data-open="true"] .acc__body{opacity:1;transform:none;transition-delay:60ms}
.kv{display:grid;gap:8px;margin:0 0 16px}.kv>div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px}
.kv dt{color:var(--text-muted)}.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.acc__setting{margin:0 0 16px}.acc__actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.acc__actions form{margin:0}
@media (max-width:560px){.acc__body{padding-left:20px}.kv>div{grid-template-columns:1fr;gap:0}}

/* ── Avatar (Arc) ── */
.avatar{position:relative;display:inline-grid;flex:none;place-items:center;border:2px solid #fff;border-radius:var(--radius-pill);background:var(--surface-muted);box-shadow:0 1px 1px rgb(0 0 0 / .08),0 3px 8px rgb(0 0 0 / .1);color:var(--foreground);font-size:var(--text-xs);font-weight:500;line-height:1}
.avatar--sm{width:28px;height:28px;font-size:11px}.avatar--md{width:34px;height:34px;font-size:13px}.avatar--lg{width:48px;height:48px;font-size:var(--text-sm)}
.avatar img{position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;object-fit:cover;pointer-events:none;transition:opacity var(--duration-standard) var(--ease-standard),filter var(--duration-standard) var(--ease-standard)}
.avatar img[data-loading]{opacity:0;filter:blur(4px);transition:none}.avatar--lg{border-width:3px}
/* A sticker from the set is already cut out with its own white edge: no disc, just its shadow. */
.avatar--cut{border:0;background:none;box-shadow:none;filter:drop-shadow(0 1px 1px rgb(0 0 0 / .1)) drop-shadow(0 3px 5px rgb(0 0 0 / .12))}.avatar--cut img{border-radius:0;object-fit:contain}
.me{display:flex;align-items:center;gap:14px;min-width:0}
/* Picture picker: the chosen robot lands in the preview on a spring and blinks once. */
.pfp{display:grid;gap:24px}.pfp__head{display:grid;justify-items:center;gap:8px;text-align:center}.pfp__head h1{margin:10px 0 0}
.pfp__face{display:block;width:112px;height:112px;border:6px solid #fff;border-radius:var(--radius-pill);overflow:hidden;background:var(--surface-muted);filter:drop-shadow(0 1px 1px rgb(0 0 0 / .08)) drop-shadow(0 8px 14px rgb(0 0 0 / .1))}
.pfp__face svg,.pfp__face img{display:block;width:100%;height:100%;object-fit:cover}
.pfp__face[data-cut]{width:132px;height:132px;border:0;border-radius:0;overflow:visible;background:none}.pfp__face[data-cut] img{object-fit:contain}
.pfp__set{display:grid;gap:12px;min-width:0;margin:0;padding:0;border:0}.pfp__legend{margin-bottom:12px;padding:0;color:var(--text-secondary);font-weight:500}
.pfp__face.go>*{animation:pfp-in 520ms cubic-bezier(.34,1.56,.64,1) both}.pfp__face.go .e{transform-box:fill-box;transform-origin:center;animation:pfp-blink 300ms 380ms ease-in-out}
@keyframes pfp-in{from{opacity:.4;transform:scale(.82);filter:blur(4px)}}@keyframes pfp-blink{50%{transform:scaleY(.12)}}
.pfp__grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin:0;padding:0;border:0;min-width:0}
.pfp__opt{position:relative;display:block;min-width:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.pfp__opt input{position:absolute;opacity:0;pointer-events:none}
.pfp__img{position:relative;display:block;width:100%;aspect-ratio:1;border:3px solid #fff;border-radius:var(--radius-pill);overflow:hidden;box-shadow:0 1px 1px rgb(0 0 0 / .08),0 4px 10px rgb(0 0 0 / .1);transition:box-shadow var(--duration-fast) var(--ease-standard),transform 220ms cubic-bezier(.34,1.56,.64,1)}
.pfp__img svg{position:absolute;inset:0;display:block;width:100%;height:100%}
.pfp__opt input:checked+.pfp__img{box-shadow:0 0 0 2px var(--background),0 0 0 4px var(--foreground)}
.pfp__opt input:focus-visible+.pfp__img{box-shadow:0 0 0 2px var(--background),0 0 0 4px var(--accent)}
.pfp__img--cut{border:0;overflow:visible;box-shadow:none;filter:drop-shadow(0 1px 1px rgb(0 0 0 / .08)) drop-shadow(0 5px 9px rgb(0 0 0 / .1))}.pfp__img--cut img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
.pfp__opt input:checked+.pfp__img--cut,.pfp__opt input:focus-visible+.pfp__img--cut{box-shadow:none;outline:2px solid var(--foreground);outline-offset:3px}.pfp__opt input:focus-visible+.pfp__img--cut{outline-color:var(--accent)}
.pfp__opt:active .pfp__img{transform:scale(.94)}
@media (hover:hover) and (pointer:fine){.pfp__opt:hover .pfp__img{transform:scale(1.05)}}
.pfp__foot{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}.pfp__foot .btn:last-child{min-width:140px;margin-left:auto}
@media (max-width:640px){.pfp__grid{grid-template-columns:repeat(4,minmax(0,1fr))}.pfp__foot{flex-direction:column-reverse}.pfp__foot .btn{width:100%}}
.who{display:flex;align-items:center;gap:12px;min-width:0}.who__text{min-width:0}
/* Presence dot (Arc user menu): solid when ready, a ring when a step is missing or it's off. */
.pdot{--dot-color:var(--success);position:relative;display:inline-block;width:10px;height:10px;flex:none;border-radius:50%;background:var(--dot-color);transition:background-color var(--duration-standard) var(--ease-standard)}
.pdot::before{content:"";position:absolute;inset:0;margin:auto;width:46%;height:46%;border-radius:50%;background:var(--presence-surface,var(--surface));transform:scale(0);transition:transform var(--duration-spring) var(--ease-spring),background-color var(--duration-fast) var(--ease-standard)}
.pdot[data-status="away"]{--dot-color:var(--warning)}.pdot[data-status="offline"]{--dot-color:var(--text-muted)}
.pdot[data-status="away"]::before,.pdot[data-status="offline"]::before{transform:scale(1)}

/* ── User menu (Arc): you, your plan, and the way out ── */
.umenu{flex:none}.umenu__trigger{display:flex;align-items:center;padding:3px;border-radius:999px;cursor:pointer;transition:background-color var(--duration-fast) var(--ease-standard)}
@media (hover:hover) and (pointer:fine){.umenu__trigger:hover{background:var(--surface-muted)}}
.umenu[open]>.umenu__trigger{background:var(--surface-muted)}
.umenu__panel{position:absolute;right:0;top:calc(100% + 8px);z-index:60;width:15.5rem;padding:4px;border:.5px solid var(--border);border-radius:10px;background:var(--surface-raised);box-shadow:var(--shadow-floating);line-height:1.3;transform-origin:top right;animation:menu-in var(--duration-fast) var(--ease-standard)}
.umenu__head{display:flex;align-items:center;gap:10px;padding:8px}.umenu__id{display:grid;gap:2px;min-width:0;flex:1}
.umenu__row{display:flex;align-items:center;gap:6px;min-width:0}.umenu__fullname{min-width:0;overflow:hidden;font-size:13px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.umenu__plan{flex:none;height:17px;padding:0 5px;border:.5px solid color-mix(in oklab,var(--foreground) 9%,transparent);border-radius:4px;background:color-mix(in oklab,var(--foreground) 4%,transparent);color:var(--text-secondary);font-size:11px;font-weight:500;line-height:16px}
.umenu__email{overflow:hidden;font-size:12px;color:var(--text-muted);text-overflow:ellipsis;white-space:nowrap}
.umenu__sep{height:1px;margin:4px -4px;background:color-mix(in oklab,var(--foreground) 7%,transparent)}.umenu form{margin:0}
.umenu__item{display:flex;align-items:center;gap:10px;width:100%;height:32px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--foreground);font:inherit;font-size:13px;text-align:left;text-decoration:none;cursor:pointer}
.umenu__item svg{width:16px;height:16px;flex:none;color:var(--text-secondary)}.umenu__item:hover,.umenu__item:focus-visible{outline:none;background:color-mix(in oklab,var(--foreground) 6%,transparent)}.umenu__item:hover svg{color:var(--foreground)}

/* ── Badge (Arc): a short status word with a faint tint ── */
.badge{display:inline-flex;align-items:center;min-height:24px;padding:0 9px;border:1px solid var(--badge-border,var(--border));border-radius:var(--radius-pill);background:var(--badge-bg,var(--surface-muted));color:var(--badge-fg,var(--text-secondary));font-size:var(--text-xs);font-weight:500;line-height:1;white-space:nowrap;vertical-align:middle}
.badge--success{--badge-fg:var(--success);--badge-bg:color-mix(in oklab,var(--success) 10%,var(--surface));--badge-border:color-mix(in oklab,var(--success) 25%,var(--border))}
.badge--warning{--badge-fg:var(--warning);--badge-bg:color-mix(in oklab,var(--warning) 11%,var(--surface));--badge-border:color-mix(in oklab,var(--warning) 27%,var(--border))}
.badge--info{--badge-fg:var(--accent-strong);--badge-bg:var(--accent-subtle);--badge-border:color-mix(in oklab,var(--accent) 24%,var(--border))}
.badge--danger{--badge-fg:var(--danger);--badge-bg:color-mix(in oklab,var(--danger) 10%,var(--surface));--badge-border:color-mix(in oklab,var(--danger) 26%,var(--border))}

/* ── Alert (Arc): what needs you, with the action that resolves it ── */
/* ── Notice: what just happened, how to take it back, what next. Settles in once; reduced motion just shows it ── */
.toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));z-index:60;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);padding:9px 16px 9px 14px;border-radius:999px;background:var(--foreground);color:var(--background);box-shadow:var(--shadow-floating,0 8px 24px rgb(0 0 0/.18));font-size:var(--text-sm);font-weight:500;transform:translateX(-50%);animation:toast-in 380ms var(--ease-spring) both,toast-out 220ms ease-in 4s forwards}
.toast--undo{padding-right:6px;animation-delay:0s,8s}.toast:hover,.toast:focus-within{animation-play-state:paused}
.toast>svg{flex:none;width:16px;height:16px;color:var(--success)}.toast__what{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toast form{margin:0}
.toast__undo{min-height:30px;padding:0 12px;border:0;border-radius:999px;background:color-mix(in oklab,var(--background) 16%,transparent);color:inherit;font:inherit;cursor:pointer}
@media (hover:hover) and (pointer:fine){.toast__undo:hover{background:color-mix(in oklab,var(--background) 26%,transparent)}}
@keyframes toast-in{from{opacity:0;transform:translate(-50%,12px) scale(.96)}}@keyframes toast-out{to{opacity:0;transform:translate(-50%,6px);visibility:hidden}}
@keyframes toast-fade{from{opacity:0}}@keyframes toast-gone{to{opacity:0;visibility:hidden}}
@media (prefers-reduced-motion:reduce){.toast{animation-name:toast-fade,toast-gone}}
.alert{display:flex;align-items:flex-start;gap:12px;padding:16px 18px;border:1px solid var(--border);border-radius:var(--radius-panel);background:var(--surface)}
.alert__icon{display:grid;flex:none;margin-top:1px}.alert__icon svg{width:18px;height:18px}
.alert--info .alert__icon{color:var(--accent)}.alert--warning .alert__icon{color:var(--warning)}.alert--danger .alert__icon{color:var(--danger)}.alert--success .alert__icon{color:var(--success)}
.alert--warning{border-color:color-mix(in oklab,var(--warning) 35%,var(--border))}.alert--danger{border-color:color-mix(in oklab,var(--danger) 35%,var(--border))}
.alert__copy{flex:1;min-width:0}.alert__title{margin:0;font-size:var(--text-sm);font-weight:500;line-height:1.4}.alert__desc{margin:4px 0 0;color:var(--text-secondary)}
.alert__action{display:flex;flex-wrap:wrap;gap:8px;flex:none}.alert__action form{margin:0}
@media (max-width:640px){.alert{flex-wrap:wrap}.alert__action{flex-basis:100%;padding-left:30px}}

/* ── Button (Arc): primary is ink, secondary (.ghost) sits on the surface, danger keeps the surface with a red label.
   Loading keeps the button focusable, hides the label and spins in its place, so the width never moves. ── */
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:var(--control-height-md);padding:0 16px;border:1px solid transparent;border-radius:18px;background:var(--foreground);border-color:var(--foreground);color:var(--background);font:inherit;font-size:var(--text-sm);font-weight:500;line-height:1.4;white-space:nowrap;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent;
transition:color var(--duration-fast) var(--ease-standard),background-color var(--duration-fast) var(--ease-standard),border-color var(--duration-fast) var(--ease-standard),opacity var(--duration-fast) var(--ease-standard),box-shadow var(--duration-fast) var(--ease-standard),transform 120ms cubic-bezier(.34,1.56,.64,1)}
.btn svg{width:16px;height:16px;flex:none}.btn:active:not(:disabled):not([aria-busy=true]){transform:scale(.97)}.btn:disabled{opacity:.52;cursor:not-allowed}
.btn.small{min-height:var(--control-height-sm);padding:0 12px}.btn.wide{width:100%}.btn.wide:active:not(:disabled){transform:scale(.985)}
.btn.blue{background:var(--accent);border-color:var(--accent);color:var(--accent-foreground)}
.btn.ghost{background:var(--surface);color:var(--foreground);border-color:var(--border)}
.btn.danger{background:var(--surface);color:var(--danger);border-color:var(--border)}
.btn.ghost:disabled,.btn.danger:disabled{opacity:1;color:var(--text-muted);background:var(--surface-muted)}
.btn:active:not(:disabled){opacity:.84}.btn.ghost:active:not(:disabled),.btn.danger:active:not(:disabled){opacity:1;background:var(--surface-muted)}.btn.danger:active:not(:disabled){border-color:var(--danger)}
@media (hover:hover) and (pointer:fine){.btn:hover:not(:disabled){opacity:.91;box-shadow:var(--shadow-resting)}.btn.ghost:hover:not(:disabled){opacity:1;background:var(--surface-muted)}.btn.danger:hover:not(:disabled){opacity:1;border-color:var(--danger);background:var(--surface-muted)}}
.btn__label{display:inline-flex;align-items:center;gap:8px;transition:opacity var(--duration-fast) var(--ease-standard)}
.btn__spin{position:absolute;inset:0;display:grid;place-items:center;opacity:0;transform:scale(.6);transition:opacity var(--duration-fast) var(--ease-standard),transform 260ms cubic-bezier(.34,1.56,.64,1);pointer-events:none}
.btn__spin::before{content:"";width:16px;height:16px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:btn-spin .7s linear infinite}
.btn[aria-busy=true]{cursor:progress}.btn[aria-busy=true] .btn__label{opacity:0}.btn[aria-busy=true] .btn__spin{opacity:1;transform:none}
@keyframes btn-spin{to{transform:rotate(360deg)}}
.iconbtn{display:grid;place-items:center;width:32px;height:32px;border-radius:10px;color:var(--text-muted);cursor:pointer;list-style:none}.iconbtn svg{width:18px;height:18px}.iconbtn::-webkit-details-marker{display:none}
@media (hover:hover) and (pointer:fine){.iconbtn:hover{background:var(--surface-muted);color:var(--foreground)}}
.link{background:none;border:0;padding:0;color:var(--text-secondary);text-decoration:underline;text-underline-offset:.2em;text-decoration-color:var(--border-strong);cursor:pointer;font:inherit}.link:hover{color:var(--foreground)}.link.danger{color:var(--danger)}

/* ── Dropdown menu (Arc): a raised panel that grows from its trigger ── */
.more{position:relative}.more>summary{list-style:none}.more>summary::-webkit-details-marker{display:none}
.more .menu{position:absolute;right:0;top:calc(100% + 6px);z-index:40;display:grid;min-width:180px;padding:5px;border:1px solid var(--border);border-radius:var(--radius-panel);background:var(--surface-raised);box-shadow:var(--shadow-floating);white-space:nowrap;text-align:left;transform-origin:top right;animation:menu-in var(--duration-fast) var(--ease-standard)}
.more .menu--up{top:auto;bottom:calc(100% + 6px);left:0;right:0;transform-origin:bottom center}
.more .menu form{margin:0}
.more .menu a,.more .menu button{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:0 11px;border:0;border-radius:calc(var(--radius-panel) - 6px);background:none;color:var(--foreground);font:inherit;font-size:var(--text-sm);text-decoration:none;cursor:pointer;text-align:left}
.more .menu svg{width:16px;height:16px;color:var(--text-secondary)}.more .menu .danger{color:var(--danger)}
.more .menu a:hover,.more .menu button:hover{background:var(--surface-muted)}.more .menu .danger:hover{background:color-mix(in oklab,var(--danger) 8%,var(--surface))}
.more .menu[data-confirming]>:not(.menu__confirm){display:none}
.menu__confirm{display:grid;gap:10px;width:15rem;padding:8px 8px 4px;white-space:normal}.menu__confirm p{margin:0;font-size:var(--text-sm);color:var(--text-secondary)}
.menu__actions{display:flex;justify-content:flex-end;gap:4px}.more .menu .menu__actions button{width:auto;min-height:32px;padding:0 12px;border-radius:999px}
.more .menu .menu__actions button.danger{background:color-mix(in oklab,var(--danger) 13%,transparent)}
@keyframes menu-in{from{opacity:0;transform:translateY(-4px) scale(.97)}}
.menu--up{animation-name:menu-up}@keyframes menu-up{from{opacity:0;transform:translateY(4px) scale(.97)}}

/* ── Confirm morph (Arc): one neutral pill whose width springs between its faces ── */
.cm{display:inline-flex;max-width:100%;margin:0;vertical-align:middle}
.cm__surface{position:relative;display:flex;height:var(--control-height-sm);max-width:100%;overflow:clip;border-radius:999px;background:var(--surface-raised);box-shadow:var(--shadow-resting);transition:width var(--duration-spring) var(--ease-spring)}
.cm__surface::after{content:"";position:absolute;inset:0;border:1px solid var(--border);border-radius:inherit;pointer-events:none}
.cm__face{display:flex;flex:none;height:100%;align-items:center;gap:2px;padding:0 4px;white-space:nowrap}.cm__face[data-face="idle"]{padding:0}.cm__face[hidden]{display:none}
.cm__face:not([data-face="idle"]){animation:cm-in var(--duration-standard) var(--ease-standard)}@keyframes cm-in{from{opacity:0;filter:blur(2px)}}
.cm__trigger{display:inline-flex;height:100%;align-items:center;gap:8px;padding:0 16px 0 14px;border:0;border-radius:999px;background:transparent;color:var(--foreground);font:inherit;font-weight:500;cursor:pointer}
.cm__trigger svg{width:16px;height:16px;color:var(--text-secondary)}
.cm__prompt{padding:0 8px 0 12px;font-weight:500}
.cm__secondary,.cm__confirm{display:inline-flex;height:calc(var(--control-height-sm) - 8px);align-items:center;padding:0 12px;border:0;border-radius:999px;font:inherit;font-weight:500;cursor:pointer;touch-action:manipulation;transition:background-color var(--duration-fast) var(--ease-standard),color var(--duration-fast) var(--ease-standard)}
.cm__secondary{background:transparent;color:var(--text-secondary)}
.cm__confirm{background:color-mix(in oklab,var(--danger) 13%,transparent);color:var(--danger)}.cm[data-tone="neutral"] .cm__confirm{background:var(--accent);color:var(--accent-foreground)}
.cm__status{display:inline-flex;align-items:center;gap:8px;padding:0 16px 0 12px;color:var(--text-secondary);font-weight:500}
.cm__spin{width:14px;height:14px;border:1.5px solid currentColor;border-right-color:transparent;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
.cm :focus-visible{outline:none}.cm__trigger:focus-visible{background:color-mix(in oklab,var(--foreground) 6%,transparent)}.cm__secondary:focus-visible{background:color-mix(in oklab,var(--foreground) 8%,transparent);color:var(--foreground)}
.cm__confirm:focus-visible{background:color-mix(in oklab,var(--danger) 20%,transparent)}.cm[data-tone="neutral"] .cm__confirm:focus-visible{background:var(--accent-strong)}
@media (hover:hover) and (pointer:fine){.cm__trigger:hover{background:color-mix(in oklab,var(--foreground) 5%,transparent)}.cm__secondary:hover{background:color-mix(in oklab,var(--foreground) 7%,transparent);color:var(--foreground)}
.cm__confirm:hover{background:color-mix(in oklab,var(--danger) 18%,transparent)}.cm[data-tone="neutral"] .cm__confirm:hover{background:var(--accent-strong)}}

/* ── Segmented control (Arc): the selection glides, labels only change colour ── */
.seg{display:inline-flex;max-width:100%;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--surface-muted)}
.seg__track{position:relative;isolation:isolate;display:flex;gap:2px;padding:3px;border-radius:inherit}
.seg button{position:relative;z-index:1;min-height:30px;padding:0 12px;border:0;border-radius:calc(var(--radius-control) - 4px);background:transparent;color:var(--text-muted);font:inherit;font-weight:500;white-space:nowrap;cursor:pointer;transition:color var(--duration-fast) var(--ease-standard)}
.seg button[aria-pressed="true"]{color:var(--foreground)}@media (hover:hover) and (pointer:fine){.seg button:hover{color:var(--foreground)}}
.seg__sel{position:absolute;z-index:0;top:3px;bottom:3px;left:3px;width:0;border:1px solid var(--border);border-radius:calc(var(--radius-control) - 4px);background:var(--surface);box-shadow:var(--shadow-resting)}
.seg.ready .seg__sel{transition:transform var(--duration-spring) var(--ease-spring),width var(--duration-spring) var(--ease-spring)}

/* ── Switch (Arc): the thumb slides inside a fixed track ── */
.switch{position:relative;display:inline-flex;flex:none;align-items:center;min-height:var(--control-height-md);cursor:pointer}
.switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;opacity:0;cursor:pointer}
.switch__track{position:relative;display:flex;width:42px;height:24px;align-items:center;padding:3px;border-radius:999px;background:var(--control-track);isolation:isolate;transition:background-color var(--duration-fast) var(--ease-standard)}
.switch__track::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--control-on);opacity:0;transition:opacity var(--duration-standard) var(--ease-standard)}
.switch__thumb{width:18px;height:18px;border-radius:50%;background:var(--control-thumb);box-shadow:var(--control-thumb-shadow);transition:transform var(--duration-spring) var(--ease-spring)}
.switch input:checked+.switch__track::before{opacity:1}.switch input:checked+.switch__track .switch__thumb{transform:translateX(18px)}
.switch input:focus-visible+.switch__track{outline:2px solid color-mix(in oklab,var(--accent) 72%,transparent);outline-offset:2px}
@media (hover:hover) and (pointer:fine){.switch:has(input:disabled){cursor:default}.switch input:disabled{cursor:default}.switch input:disabled+.switch__track{opacity:.45}
.switch:hover input:not(:checked)+.switch__track{background:var(--control-track-hover)}}

/* ── Stepper (Arc): markers on one track; the fill grows from each finished step ── */
.stepper{--marker:28px;--halo:4px;display:grid;margin:0;padding:0;list-style:none}
.stepper--h{grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);margin:4px 0 24px}
.step{position:relative;min-width:0}
.stepper--h .step{display:grid;justify-items:start;row-gap:12px;padding-inline-end:16px}
.stepper--v .step{display:grid;grid-template-columns:var(--marker) minmax(0,1fr);column-gap:12px;align-items:start}.stepper--v .step:not(:last-child){padding-bottom:20px}
.step__marker{position:relative;display:grid;width:var(--marker);height:var(--marker);place-items:center}
.step__ring{position:absolute;inset:calc(var(--halo) * -1);border-radius:50%;background:var(--accent-subtle)}
.step__disc{position:relative;display:grid;width:100%;height:100%;place-items:center;border-radius:50%;background:var(--surface);box-shadow:inset 0 0 0 1px var(--border-strong);color:var(--text-muted);font-size:var(--text-xs);font-weight:500;font-variant-numeric:tabular-nums;line-height:1}
.step__disc svg{width:14px;height:14px;stroke-width:2.25}
.step[data-status="current"] .step__disc{box-shadow:inset 0 0 0 1.5px var(--accent);color:var(--foreground)}
.step[data-status="complete"] .step__disc{background:var(--accent);box-shadow:inset 0 0 0 1px var(--accent);color:var(--accent-foreground)}
.step__label{display:block;color:var(--text-muted);font-weight:500;line-height:20px}.stepper--v .step__label{padding-top:4px}
.step[data-status="complete"] .step__label{color:var(--text-secondary)}.step[data-status="current"] .step__label{color:var(--foreground)}
.step__conn{position:absolute;overflow:hidden;border-radius:999px;background:var(--border);pointer-events:none}
.stepper--h .step__conn{top:calc(var(--marker) / 2 - 1px);left:calc(var(--marker) + var(--halo) + 4px);right:calc(var(--halo) + 4px);height:2px}
.stepper--v .step__conn{top:calc(var(--marker) + var(--halo) + 2px);bottom:calc(var(--halo) + 2px);left:calc(var(--marker) / 2 - 1px);width:2px}
.step__fill{position:absolute;inset:0;background:var(--accent);transform:scaleX(0);transform-origin:left center}.stepper--v .step__fill{transform:scaleY(0);transform-origin:center top}
.step__fill[data-on]{transform:none}
@media (max-width:560px){.stepper--h .step__label{font-size:var(--text-xs);line-height:16px}}

/* ── Usage meter (Arc): what's used of the free allowance ── */
.meter{display:grid;gap:12px;min-width:0}
.meter__top{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:28px}
.meter__title{font-size:var(--text-base);font-weight:500}
.meter__badge{display:inline-flex;flex:none;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;background:var(--surface-muted);color:var(--text-secondary);font-size:var(--text-xs);font-weight:500;white-space:nowrap}
.meter__icon{display:grid}.meter__icon svg{width:14px;height:14px}
.meter__badge[data-status="near"]{background:color-mix(in oklab,var(--warning) 14%,var(--surface));color:var(--foreground)}.meter__badge[data-status="near"] .meter__icon{color:var(--warning)}
.meter__badge[data-status="over"]{background:color-mix(in oklab,var(--danger) 12%,var(--surface));color:var(--foreground)}.meter__badge[data-status="over"] .meter__icon{color:var(--danger)}
.meter__total{display:flex;align-items:baseline;gap:8px;margin:0}
.meter__amount{font:500 36px/1.1 var(--font-display);letter-spacing:var(--tracking-display);font-variant-numeric:tabular-nums}.meter__caption{color:var(--text-secondary)}
.meter__bar{padding-block:5px}.meter__track{position:relative;height:14px;overflow:hidden;border-radius:999px;background:color-mix(in oklab,var(--foreground) 7%,var(--surface))}
.meter__fill{position:absolute;inset:0 auto 0 0;background:var(--accent);transition:width var(--duration-spring) var(--ease-spring)}
.meter__note{margin:14px 0 0;font-size:var(--text-xs)}
.card--meter{display:block;padding:16px 20px;text-decoration:none;color:inherit;transition:border-color var(--duration-fast) var(--ease-standard)}@media (hover:hover) and (pointer:fine){.card--meter:hover{border-color:var(--border-strong)}}
.meter--compact{gap:10px}.meter--compact .meter__top{min-height:0;justify-content:flex-start}.meter--compact .meter__title{font-size:var(--text-sm);margin-right:auto}
.meter--compact .meter__caption{font-size:var(--text-sm)}.meter--compact .meter__caption b{color:var(--foreground);font-weight:500;font-variant-numeric:tabular-nums}
.meter--compact .meter__bar{padding:0}.meter--compact .meter__track{height:6px}

/* ── Code block and copy button (Arc) ── */
.code{margin:12px 0;overflow:hidden;border:1px solid var(--border);border-radius:var(--radius-panel);background:var(--surface)}
.code__head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;padding:6px 8px 6px 14px;border-bottom:1px solid var(--border-subtle);background:var(--surface-raised)}
.code__title{display:flex;align-items:center;gap:8px;min-width:0;color:var(--text-secondary);font-weight:500}.code__title svg{width:16px;height:16px;flex:none;color:var(--text-muted)}
.code__pre{margin:0;padding:16px;white-space:pre-wrap;word-break:break-word;font:13px/1.7 var(--font-mono);color:var(--foreground);background:color-mix(in oklab,var(--surface-muted) 40%,var(--surface))}
.copybtn{display:inline-flex;flex:none;align-items:center;gap:8px;min-height:var(--control-height-sm);padding:0 12px;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--surface);color:var(--foreground);font:inherit;font-weight:500;cursor:pointer;transition:background-color var(--duration-fast) var(--ease-standard),border-color var(--duration-fast) var(--ease-standard),transform var(--duration-spring) var(--ease-spring)}
.copybtn:active{transform:scale(.97);transition-duration:var(--duration-fast),var(--duration-fast),var(--duration-instant)}
@media (hover:hover) and (pointer:fine){.copybtn:hover{background:var(--surface-muted);border-color:var(--border-strong)}}
.copybtn__icon{display:grid;width:16px;height:16px}.copybtn__icon svg{grid-area:1/1;width:16px;height:16px;transition:opacity var(--duration-fast) var(--ease-standard),transform var(--duration-standard) var(--ease-standard)}
.copybtn__icon svg:last-child{opacity:0;transform:scale(.6);color:var(--success)}
.copybtn[data-state="copied"] .copybtn__icon svg:first-child{opacity:0;transform:scale(.6)}.copybtn[data-state="copied"] .copybtn__icon svg:last-child{opacity:1;transform:none}
.copybtn__label{min-width:4.2em;text-align:left}

/* ── OTP input (Arc): six slots, a filled one takes the accent ── */
.otp{display:flex;justify-content:center;gap:8px}
.otp__slot{width:46px;height:52px;min-width:0;padding:0;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--surface);color:var(--foreground);caret-color:var(--accent);font:500 var(--text-lg)/1 var(--font-body);font-variant-numeric:tabular-nums;text-align:center}
@media (hover:hover) and (pointer:fine){.otp__slot:hover:not([data-filled="true"]){border-color:var(--border-strong);background:var(--surface-muted)}}
.otp__slot[data-filled="true"]{border-color:var(--accent);background:var(--accent-subtle)}
.otp__slot:focus-visible{outline:none;border-color:var(--accent-strong);box-shadow:inset 0 0 0 1px var(--accent-strong)}
@media (max-width:360px){.otp{gap:6px}.otp__slot{width:40px;height:46px}}

/* ── Empty state (Arc) ── */
.empty{display:flex;flex-direction:column;align-items:center;text-align:center;padding:40px 20px 44px}
.empty__icon{display:grid;place-items:center;width:44px;height:44px;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--surface-muted);color:var(--text-secondary)}.empty__icon svg{width:20px;height:20px}
.empty h3{margin:16px 0 0}.empty p{max-width:22rem;margin:6px 0 0;color:var(--text-secondary);text-wrap:balance}.empty__action{margin-top:16px}.empty__action form{margin:0}

/* ── Forms ── */
.stack{display:grid;gap:14px;margin-top:12px}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
label{display:grid;gap:6px;font-weight:500;font-size:var(--text-sm)}
input,select,textarea{font:inherit;font-size:16px;color:var(--foreground);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--radius-control);transition:border-color var(--duration-fast) var(--ease-standard),background-color var(--duration-fast) var(--ease-standard)}
input::placeholder,textarea::placeholder{color:var(--text-muted)}
select{appearance:none;padding-right:36px;cursor:pointer;background:var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236b7588' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 12px center/16px}
@media (hover:hover) and (pointer:fine){input:hover:not(:disabled):not(.otp__slot),textarea:hover:not(:disabled){border-color:var(--foreground)}select:hover{background-color:var(--surface-muted)}}
input,select{height:var(--control-height-md);padding:0 12px;min-width:0}textarea{padding:10px 12px;line-height:1.4;resize:vertical}
@media (min-width:641px){input,select,textarea{font-size:var(--text-sm)}}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:none;border-color:var(--foreground)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.row3{display:grid;grid-template-columns:1fr 1fr 2fr;gap:12px}@media(max-width:560px){.row3{grid-template-columns:1fr 1fr}.row3 label:last-child{grid-column:1/-1}}
.pick{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:6px 0 14px}.pick label{min-width:180px}
.error{color:var(--danger);font-weight:500}.okmsg{color:var(--success);font-weight:500;margin:0}.dev{background:color-mix(in oklab,var(--warning) 12%,var(--surface));padding:10px 14px;border-radius:var(--radius-control)}

/* ── Settings groups (Arc settings rows) ── */
.group{display:grid;gap:10px}.group>h2{margin:0;padding-left:4px}
.card--rows{padding:0 20px}
.setrow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0}.setrow+.setrow{border-top:1px solid var(--border-subtle)}
.setrow p{margin:0}.setrow--flush{padding:0}.quietform .row3{margin:18px 0 14px}.card__block{margin:16px 0}.stack>.btn.small{justify-self:start}.setrow__label{font-weight:500}.setrow__desc{color:var(--text-secondary);font-size:var(--text-sm)}
.fold>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none}.fold>summary::-webkit-details-marker{display:none}
.fold>summary::after{content:"";width:8px;height:8px;margin-right:4px;border:1.75px solid var(--text-muted);border-top:0;border-left:0;transform:rotate(45deg);transition:transform var(--duration-standard) var(--ease-standard);flex:none}
.fold[open]>summary::after{transform:rotate(-135deg)}.fold[open]>summary{margin-bottom:14px}
.fold__title{display:block;font-weight:500}.fold__sub{display:block;font-size:var(--text-xs);color:var(--text-muted)}
.danger-zone .fold__title{color:var(--danger)}

/* ── Facts (a bot at a glance) ── */
.facts{margin:0}.fact{display:grid;grid-template-columns:160px minmax(0,1fr);gap:16px;padding:14px 0}.fact+.fact{border-top:1px solid var(--border-subtle)}
.fact dt{color:var(--text-secondary)}.fact dd{margin:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}.fact dd b{font-weight:500}.fact dd span{color:var(--text-muted);font-size:var(--text-xs)}
@media (max-width:560px){.fact{grid-template-columns:1fr;gap:2px}}


.wait{display:flex;align-items:center;gap:10px;font-weight:500;color:var(--text-secondary)}.wait.hidden{display:none}
.howto{padding-left:20px}.howto li{margin:6px 0}
.way{display:grid;gap:8px}.way+.way{border-top:1px solid var(--border-subtle);margin-top:20px;padding-top:20px}.way h2{margin:0}.way__head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.diy>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;font-weight:500;padding:2px 0;cursor:pointer}.diy>summary::-webkit-details-marker{display:none}
.diy>summary::after{content:"+";font-size:20px;font-weight:400;color:var(--text-muted)}.diy[open]>summary::after{content:"\\2013"}
details summary{cursor:pointer}

/* ── Inbox ── */
.convos{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,460px),1fr));gap:16px;align-items:start}
.thread{list-style:none;margin:14px 0;padding:0;display:grid;gap:10px}
.bubble{max-width:82%;padding:10px 14px;border-radius:16px;background:var(--surface-muted)}.bubble.out{justify-self:end;background:var(--foreground);color:var(--background)}
.bubble .meta{font-size:var(--text-xs);color:var(--text-secondary);margin-bottom:3px}.bubble.out .meta{color:color-mix(in oklab,var(--background) 70%,var(--foreground))}
.bubble .text{white-space:pre-wrap;word-break:break-word}.bubble .ext{display:block;margin-top:6px;word-break:break-all}
.choices{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.chip{height:var(--control-height-sm);padding:0 14px;border-radius:var(--radius-pill);border:1px solid var(--border-strong);background:var(--surface);color:var(--foreground);font:inherit;font-weight:500;cursor:pointer}.chip:hover{background:var(--surface-muted)}
.answered{margin-top:8px}.compose{display:grid;gap:10px;margin-top:8px;border-top:1px solid var(--border-subtle);padding-top:14px}.compose .btn{justify-self:start}
.extra summary{color:var(--text-secondary)}.extra[open]{display:grid;gap:10px}

/* ── Signed-out and focused pages ── */
.art{margin:0 auto;max-width:520px;width:100%}.art img{display:block;width:100%;height:auto;-webkit-mask-image:radial-gradient(ellipse 58% 54% at 50% 47%,#000 40%,transparent 100%);mask-image:radial-gradient(ellipse 58% 54% at 50% 47%,#000 40%,transparent 100%)}
.art.small{max-width:340px}
.hero{max-width:640px;margin:48px auto;text-align:center}.hero h1{font-size:40px;margin-bottom:12px}.lead{color:var(--text-secondary);font-size:var(--text-lg);margin:0 0 24px}
.center>.avatar{width:64px;height:64px;margin:0 auto 14px;font-size:26px;background:var(--foreground);color:var(--background);box-shadow:none}
.card h1,.center h1{margin-bottom:8px}
.price{font-size:32px;font-weight:500;letter-spacing:-.03em;margin:4px 0 8px}.ticks{padding-left:18px;margin:0 0 18px}.ticks li{margin:4px 0}.tiers{width:100%}
.row{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:12px 0;border-top:1px solid var(--border-subtle)}.row form{margin:0}
.quiet{text-align:center}

/* ── Phones: the tabs move under the brand and can scroll ── */
@media (max-width:640px){
.top__in{flex-wrap:wrap;gap:10px 12px;padding:10px 16px 10px}.brand{margin-right:auto}
.tabs{order:3;flex:1 0 100%;margin:0;overflow-x:auto;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}.tabs__item{flex:1;justify-content:center}
.page{padding:24px 16px 36px}
.pagehead__actions{width:100%}.pagehead__actions form,.pagehead__actions .btn{flex:1}.pagehead__actions .btn{width:100%}
h1{font-size:24px}}
@media (max-width:560px){.setrow{flex-wrap:wrap}.setrow--keep{flex-wrap:nowrap}}
/* ── Stickers (Arc tokens): people are die-cut stickers on white, tilted a little. Names, baskets and small notes are
   handwritten (Caveat, SIL OFL, served from /hand/). A name stays hidden until hover, keyboard focus or a long press. ── */
@font-face{font-family:"Caveat";src:url(/hand/caveat-latin.woff2) format("woff2");font-weight:400 700;font-display:swap;unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Caveat";src:url(/hand/caveat-latin-ext.woff2) format("woff2");font-weight:400 700;font-display:swap;unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF}
:root{--font-hand:"Caveat","Segoe Print","Bradley Hand",cursive;--pen:var(--accent);--pen-subtle:var(--accent-subtle);
--stick-shadow:drop-shadow(0 1px 1px rgb(0 0 0 / .08)) drop-shadow(0 8px 14px rgb(0 0 0 / .1));--lift-shadow:drop-shadow(0 2px 2px rgb(0 0 0 / .07)) drop-shadow(0 20px 22px rgb(0 0 0 / .16))}
.hand{font-family:var(--font-hand);font-weight:500;letter-spacing:0}
.js-only{display:none}.js .js-only{display:inline}.js .no-js{display:none}
.tabs__count{display:inline-grid;place-items:center;min-width:18px;height:18px;margin-left:6px;padding:0 5px;border-radius:999px;background:var(--accent);color:var(--accent-foreground);font-size:11px;font-weight:500;line-height:1;font-variant-numeric:tabular-nums}
.sheet{position:relative;min-width:0;background:var(--surface);border-radius:28px;padding:28px;box-shadow:0 0 0 1px rgb(26 34 48 / .06),0 1px 2px rgb(26 34 48 / .04)}
.lede{margin:6px 0 0;color:var(--text-secondary);max-width:46ch}

.stk{--s:92px;--tilt:0deg;--rx:0deg;--ry:0deg;--lift:0px;--scale:1;position:relative;display:block;width:var(--s);height:var(--s);flex:none;border-radius:50%;color:inherit;text-decoration:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
a.stk{touch-action:none;cursor:grab}
.stk__img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;filter:var(--stick-shadow);transform:perspective(500px) translateY(var(--lift)) rotate(var(--tilt)) rotateX(var(--rx)) rotateY(var(--ry)) scale(var(--scale));transition:transform 420ms var(--ease-spring),filter 240ms var(--ease-standard),opacity 200ms var(--ease-standard)}
.stk__disc{display:grid;place-items:center;overflow:hidden;border:calc(var(--s) * .055) solid #fff;border-radius:50%;background:var(--surface-muted)}
.stk__disc img{display:block;width:100%;height:100%;object-fit:cover}
.stk__initial{font:500 calc(var(--s) * .38)/1 var(--font-display);color:var(--text-secondary)}
a.stk:hover,a.stk:focus-visible,.stk.is-named{z-index:5}
a.stk:hover .stk__img,a.stk:focus-visible .stk__img{--lift:-5px;--scale:1.05;filter:var(--lift-shadow)}
a.stk:focus-visible{outline:none}a.stk:focus-visible::before{content:"";position:absolute;inset:-6px;border:2px dashed var(--pen);border-radius:50%;opacity:.55}
.stk.is-peeled .stk__img{filter:brightness(0);opacity:.06;transform:rotate(var(--tilt));transition:none}
.stk__name{position:absolute;left:50%;top:calc(100% - 6px);z-index:2;translate:-50% 0;rotate:-4deg;white-space:nowrap;pointer-events:none;font:500 24px/1 var(--font-hand);color:var(--pen);clip-path:inset(0 100% 0 0);transition:clip-path 360ms var(--ease-standard)}
a.stk:hover .stk__name,a.stk:focus-visible .stk__name,.stk.is-named .stk__name{clip-path:inset(-10px -10px -10px -10px)}
.stk.is-peeled .stk__name{display:none}
.drag-ghost{position:fixed;left:0;top:0;z-index:100;pointer-events:none;will-change:transform}
.drag-ghost>.stk__img{transform:none;filter:var(--lift-shadow)}
.settle{animation:settle 720ms var(--ease-spring) backwards}@keyframes settle{from{transform:translateY(-12px) rotate(-5deg) scale(1.08)}}

/* People: the sticker pool, baskets with a handwritten mode tag, "+ new basket" */
.botpick{display:flex;flex-wrap:wrap;gap:6px;margin-top:24px}.botpick a{display:inline-flex;align-items:center;min-height:30px;padding:0 12px;border-radius:999px;background:var(--surface-muted);color:var(--text-secondary);font-family:var(--font-mono);font-size:13px;text-decoration:none}.botpick a[aria-current]{background:var(--foreground);color:var(--background)}
.pool{position:relative;margin-top:0;padding:44px 8px 40px;min-height:176px;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:22px 30px;border-radius:22px;transition:background-color 200ms var(--ease-standard)}
.pool::before{content:"";position:absolute;inset:0;border:1.5px dashed var(--border-strong);border-radius:inherit;pointer-events:none}
.pool.is-over{background:var(--pen-subtle)}
.pool__label{position:absolute;left:16px;top:6px;display:flex;align-items:center;gap:10px}.pool__label>.hand{font-size:22px;color:var(--text-secondary);rotate:-2deg}.pool__label .tag{font-size:17px}
.pool__hint{position:absolute;right:14px;bottom:4px;display:flex;align-items:flex-end;gap:2px;font-size:21px;color:var(--pen);rotate:-3deg;pointer-events:none}
.pool__hint svg{width:34px;height:30px;translate:0 10px}
.pool__empty{font-size:24px;color:var(--text-secondary);rotate:-2deg}
.pool .stk{--s:104px}.pool .stk:nth-of-type(odd){translate:0 -6px}.pool .stk:nth-of-type(3n){translate:0 8px}
.people__invite{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;margin:14px 0 0;padding:0 4px}.people__invite p{margin:0;color:var(--text-secondary)}
.baskets{margin-top:18px;display:grid;gap:14px;grid-template-columns:repeat(3,minmax(0,1fr))}
.basket{position:relative;min-width:0;min-height:150px;margin:0;padding:14px 14px 16px;border-radius:22px;background:var(--surface-muted);display:flex;flex-direction:column;transition:background-color 200ms var(--ease-standard),box-shadow 200ms var(--ease-standard),transform 300ms var(--ease-spring)}
.basket.is-over{background:var(--pen-subtle);box-shadow:inset 0 0 0 1.5px var(--pen);transform:scale(1.015)}
.basket__head{display:flex;align-items:flex-start;justify-content:space-between;gap:6px;min-height:30px}
.basket__name{margin:0;min-width:0;font-size:28px;line-height:1;font-weight:500;overflow-wrap:anywhere}
.basket__tag{align-self:flex-start;margin:8px 0 0}
.tag{display:inline-flex;white-space:nowrap;align-items:center;gap:5px;padding:2px 11px 3px 8px;border:0;border-radius:999px;background:var(--surface);color:var(--foreground);font:500 19px/1.2 var(--font-hand);letter-spacing:0;rotate:-2.5deg;box-shadow:0 0 0 1px rgb(26 34 48 / .08),0 2px 4px rgb(26 34 48 / .06)}
.tag svg{width:15px;height:15px;flex:none}.tag[data-mode="asks"]{color:var(--pen);rotate:2deg}
.pile{flex:1;display:flex;flex-wrap:wrap;align-items:center;align-content:center;row-gap:4px;padding:14px 4px 6px 10px}
.pile .stk{--s:66px;margin-left:-18px}.pile .stk:first-child{margin-left:0}.pile .stk__name{font-size:21px}
.basket--new{grid-column:var(--span3,auto);min-height:64px;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:center;gap:6px;padding:10px 14px;background:none;border:1.5px dashed var(--border-strong);text-align:center}
.basket--new input{width:100%;max-width:220px;height:auto;padding:2px 4px;border:0;border-bottom:1.5px solid transparent;border-radius:0;background:none;color:var(--pen);font:500 26px/1.2 var(--font-hand);letter-spacing:0;text-align:center}
.basket--new input::placeholder{color:var(--text-secondary)}.basket--new input:focus::placeholder{color:var(--border-strong)}
.basket--new input:hover:not(:disabled),.basket--new input:focus-visible{border-color:transparent;border-bottom-color:var(--pen)}
.nb__add{display:none}.basket--new:focus-within .nb__add{display:inline-flex}
.nb__add{align-items:center;min-height:32px;padding:0 14px;border:0;border-radius:999px;background:var(--foreground);color:var(--background);font:inherit;font-weight:500;cursor:pointer}
.people__how{margin:16px 4px 0;color:var(--text-secondary);font-size:var(--text-sm)}
.basket-word{font-size:1.25em;line-height:1}
.bmenu .iconbtn{width:30px;height:30px}.bmenu .menu{min-width:240px}
.bmenu__mode{margin:0}.bmenu__mode button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%}.bmenu__mode button::after{content:"";flex:none;width:30px;height:18px;border-radius:999px;background:var(--border-strong) radial-gradient(circle at 9px 50%,#fff 6px,transparent 6.5px);transition:background-color var(--duration-fast) var(--ease-standard)}.bmenu__mode button[aria-checked="true"]::after{background:var(--pen) radial-gradient(circle at 21px 50%,#fff 6px,transparent 6.5px)}
.bmenu__rename{display:flex;gap:6px;padding:4px}.bmenu__rename input{flex:1;height:36px}.more .menu .bmenu__rename button{width:auto;flex:none;background:var(--surface-muted)}
.mv{position:absolute;z-index:90;min-width:210px;padding:6px;border-radius:var(--radius-panel);background:var(--surface);box-shadow:0 0 0 1px rgb(26 34 48 / .08),var(--shadow-floating);transform-origin:var(--ox,20px) 0;animation:menu-in 220ms var(--ease-standard)}
.mv[hidden]{display:none}.mv__title{padding:8px 10px 6px;color:var(--text-secondary);font-size:13px}
.mv [role^="menuitem"]{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:7px 10px;border:0;border-radius:10px;background:none;color:inherit;font:inherit;font-size:15px;text-align:left;text-decoration:none;cursor:pointer}
.mv [role="menuitemradio"] .hand{margin-right:auto;font-size:22px;line-height:1.1}
.mv [role^="menuitem"]:hover,.mv [role^="menuitem"]:focus-visible{outline:none;background:var(--surface-muted)}
.mv [aria-checked="true"]::after{content:"";flex:none;width:7px;height:7px;border-radius:50%;background:var(--pen)}
.mv hr{height:1px;margin:6px 4px;border:0;background:var(--border-subtle)}.mv__mode{color:var(--text-secondary);font-size:12px}

/* A person: the big sticker and their name in handwriting, then basket, topics, notes and rules */
.person{display:grid;grid-template-columns:200px minmax(0,1fr);gap:8px 32px;align-items:start}
.person__art{display:grid;justify-items:center;gap:6px;padding-top:6px}.person__art .stk{--s:184px}
.person__names{display:grid;justify-items:center;text-align:center;min-width:0}
.person__name{margin:0;color:var(--pen);font:500 52px/1 var(--font-hand);letter-spacing:0;rotate:-4deg;overflow-wrap:anywhere}
.person__note{margin:4px 0 0;color:var(--text-secondary);font-size:22px;line-height:1;rotate:-2deg}
.person__handle{margin:12px 0 0;color:var(--text-muted);font-size:var(--text-xs)}
.person__body{display:grid;gap:28px;padding-top:6px;min-width:0}
.pblock{display:grid;gap:10px;min-width:0;margin:0;scroll-margin-top:90px}.pblock>div{min-width:0}
.row-label{margin:0;color:var(--text-secondary);font-size:13px;font-weight:400;letter-spacing:var(--tracking-body);line-height:1.4}
.bchips{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;border:0;min-width:0}.bchips legend{width:100%;margin-bottom:10px;padding:0}
.bchip{position:relative;display:inline-flex;align-items:center;gap:4px;min-height:38px;padding:0 14px;border-radius:999px;background:var(--surface-muted);cursor:pointer;transition:background-color var(--duration-fast) var(--ease-standard),box-shadow var(--duration-fast) var(--ease-standard)}
.bchip input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}.bchip .hand{font-size:21px;line-height:1}
.bchip:has(input:checked){background:var(--surface);box-shadow:inset 0 0 0 1.5px var(--pen);color:var(--pen)}.bchip:has(input:focus-visible){outline:2px solid var(--ring,var(--pen));outline-offset:2px}
.bchip__ask{display:inline-flex;color:var(--pen)}.bchip__ask svg{width:14px;height:14px}
@media (hover:hover) and (pointer:fine){.bchip:hover{background:var(--surface)}}
.pnote{margin:0;color:var(--text-secondary)}
.tchips{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.tchip{display:inline-flex;align-items:center;gap:4px;height:34px;margin:0;padding:0 5px 0 13px;border-radius:999px;background:var(--surface);box-shadow:inset 0 0 0 1px var(--border)}
.tchip button{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:none;color:var(--text-secondary);cursor:pointer}.tchip button svg{width:12px;height:12px}
.tchip button:hover{background:var(--surface-muted);color:var(--foreground)}
.tchip-add{margin:0}.tchip-add input{width:160px;height:34px;padding:0 13px;border:1.5px dashed var(--border-strong);border-radius:999px;background:none;font-size:var(--text-sm)}
.tchip-add input:focus-visible{border-style:solid;border-color:var(--pen)}
.rules{display:grid;gap:8px;margin:0;padding:0;list-style:none}
.rule{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:4px 12px;padding:12px 12px 12px 16px;border-radius:16px;background:var(--surface-muted)}
.rule__text{overflow-wrap:anywhere}.rule form{grid-column:2;grid-row:1/span 2;margin:0}
.rule__meta{grid-column:1;display:flex;align-items:center;gap:8px;color:var(--text-secondary);font-size:13px}
.rule__meta .hand{display:inline-block;color:var(--pen);font-size:20px;line-height:1;rotate:-3deg}
.rule.is-new{background:var(--surface);box-shadow:inset 0 0 0 1.5px var(--pen);animation:stick-on 700ms var(--ease-spring) both}
@keyframes stick-on{0%{opacity:0;transform:translateY(-10px) rotate(-3deg) scale(1.06)}40%{opacity:1}}
.rule--empty{color:var(--text-secondary)}
.rule-add{display:flex;gap:8px;margin:0}.rule-add input{flex:1}

/* A question for you: a reply waiting for a yes, or a change the bot can't make alone */
.asks-list{display:grid;gap:16px}
.ask{position:relative;min-width:0;padding:20px;border-radius:22px;background:var(--surface);box-shadow:0 0 0 1px rgb(26 34 48 / .08),0 18px 40px -22px rgb(26 34 48 / .28),0 2px 6px rgb(26 34 48 / .04)}
.ask__top{display:flex;align-items:center;gap:14px;min-height:40px}.ask__top .stk{--s:64px}
.ask__topic{margin:-4px 0 0;color:var(--text-secondary);font-size:var(--text-sm)}.ask__topic .hand{margin-right:6px;color:var(--pen);font-size:20px}
.ask__who{display:grid}.ask__who .hand{color:var(--pen);font-size:24px;line-height:1.05}.ask__who time{color:var(--text-secondary);font-size:13px}
.ask__q{max-width:34ch;margin:14px 0 0;font-size:19px;line-height:1.4;letter-spacing:-.008em}
.ask__theirs{margin:14px 0 0;padding:12px 14px;border-radius:14px;background:var(--surface-muted)}
.ask__theirs figcaption,.ask__label{margin:0 0 4px;color:var(--text-secondary);font-size:var(--text-xs)}
.ask__theirs blockquote{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.ask__link{margin:6px 0 0;color:var(--text-secondary);font-family:var(--font-mono);font-size:12px;overflow-wrap:anywhere}
.ask__theirs--quiet{color:var(--text-secondary)}
.ask__draft{margin:12px 0 0;padding:12px 14px;border-radius:14px;box-shadow:inset 0 0 0 1.5px var(--pen)}
.ask__text{margin:0;font-size:var(--text-base);white-space:pre-wrap;overflow-wrap:anywhere}.ask__draft .ext{display:block;margin-top:6px;overflow-wrap:anywhere}
.ask__actions{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px;margin-top:18px}.ask__actions form{margin:0}
.ask__more>summary{list-style:none}.ask__more>summary::-webkit-details-marker{display:none}
.ask__more[open]{flex-basis:100%}.ask__more[open]>summary{background:var(--surface-muted)}
.ask__own{display:grid;gap:10px;margin-top:10px}.ask__own .btn{justify-self:start}
.ask__why{margin:12px 0 0;color:var(--text-secondary)}
.ask__done{margin-top:16px}.ask__done p{max-width:44ch;margin:0}
.ask__stamp{position:absolute;right:18px;top:16px;color:var(--pen);font:500 26px/1 var(--font-hand);rotate:6deg;animation:stamp 520ms var(--ease-spring) both}
@keyframes stamp{from{opacity:0;transform:scale(1.5) rotate(-8deg)}}
.changes{display:grid;gap:6px;margin:12px 0 0;padding-left:20px}

@media (max-width:640px){
.sheet{padding:20px 18px;border-radius:24px}
.pool{gap:18px 20px;padding:42px 6px 40px;min-height:160px}.pool .stk{--s:80px}
.baskets{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.basket{min-height:150px;padding:12px 10px}.basket__name{font-size:26px}.tag{font-size:17px}
.pile{padding-left:6px}.pile .stk{--s:54px}.pile__empty{font-size:18px}.basket--new{grid-column:var(--span2,auto)}.basket--new input{font-size:24px}
.person{grid-template-columns:1fr}.person__art{grid-template-columns:auto minmax(0,1fr);justify-items:start;align-items:center;gap:4px 16px;padding-top:0}
.person__art .stk{--s:120px}.person__names{justify-items:start;text-align:left}.person__name{font-size:44px}
.rule{grid-template-columns:1fr}.rule form{grid-column:1;grid-row:auto}
.rule-add{flex-direction:column}.rule-add input{flex:none}.rule-add .btn{align-self:flex-start}
.ask{padding:18px 16px}.ask__q{font-size:18px}
.ask__actions>*{flex:1 1 100%}.ask__actions .btn{width:100%}.ask__own .btn{justify-self:stretch}}
@media (hover:none){a.stk:hover .stk__img{--lift:0px;--scale:1;filter:var(--stick-shadow)}a.stk:hover .stk__name{clip-path:inset(0 100% 0 0)}.stk.is-named .stk__name{clip-path:inset(-10px -10px -10px -10px)}}
@media (prefers-reduced-motion:reduce){.stk__img{--rx:0deg!important;--ry:0deg!important}.settle,.rule.is-new,.ask__stamp{animation:none}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:1ms!important;animation-iteration-count:1!important;transition-duration:1ms!important}.btn:active{transform:none!important}.btn__spin{transform:none}.avatar img[data-loading]{filter:none}.pfp__face.go>*,.pfp__face.go .e{animation:none}}
`;
