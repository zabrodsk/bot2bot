// The human side of b2b: accounts (email code login), a dashboard, self-serve bot setup,
// doorbell setup with a live test, and invite links. Server-rendered HTML, zero dependencies.
import { CONNECTOR_DOORBELL } from './connector.mjs';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';

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
  const { q, tx, log, clock, publicUrl, sha, token, humanCode, HttpError, validWebhook, sealKey, routes, L, mailer, devLogin, name, release, iso, banner, quietUntil, hosted, B, coverage, allowance, fetchImpl, erase, dropBetween, trustProxy } = ctx;
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
  const layout = (title, body, { user } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(product)}</title><meta name="robots" content="noindex"><style>${CSS}</style></head><body>
<header class="top"><a class="brand" href="${user ? '/app' : '/'}">${esc(product)}</a>${user ? `<nav>${user && q("SELECT 1 FROM bots WHERE user_id = ? AND vendor = 'web' AND disconnected_at IS NULL").get(user.id) ? '<a class="who" href="/app/inbox">Inbox</a>' : ''}<a class="who" href="/app/account">${esc(user.name)}</a><form method="post" action="/logout"><button class="link">Log out</button></form></nav>` : ''}</header>
${banner ? `<div class="sim" role="note">${esc(banner)}</div>` : ''}<main>${body}</main></body></html>`;
  const page = (res, status, html, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', ...headers }); res.end(html); };
  const redirect = (res, to) => { res.writeHead(303, { location: to, 'cache-control': 'no-store' }); res.end(); };
  const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };

  async function form(req) {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 16_000) throw new HttpError(413, 'form too large'); }
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) return raw ? JSON.parse(raw) : {};
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
    await mailer({ to: email, subject: `Your ${product} login code: ${code}`,
      text: `Your login code is ${code}\n\nOr open this link in the same browser: ${url}\n\nIt expires in 15 minutes. If you didn't ask for it, ignore this email.` });
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
    return layout('Connect', `<section class="card narrow"><h1>Connect ${esc(client.name)} to ${esc(product)}</h1>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<p>Your bot will be able to send and receive messages with people you connect with, as one ${esc(product)} bot. It can't see your account or anyone else's bots.</p>
<p class="muted small">Connected-app chats are not end-to-end encrypted: we pass the text on and delete it 7 days after delivery. For end-to-end encryption, set your bot up in private mode instead.</p>
<form method="post" action="/oauth/authorize" class="stack">${hidden}
${bots.length ? `<label>Which bot<select name="bot">${bots.map((b) => `<option value="${b.id}">@${esc(b.handle)}${b.disconnected_at ? ' (reconnect)' : ''}</option>`).join('')}<option value="new">A new bot</option></select></label>` : '<input type="hidden" name="bot" value="new">'}
<label>Name for a new bot<input name="handle" pattern="[a-z0-9][a-z0-9_-]{1,31}" value="${esc(suggested)}"></label>
<button class="btn" name="decision" value="allow">Connect</button><button class="link" name="decision" value="deny">Cancel</button></form></section>`, { user });
  }
  const quickMessage = `Add the custom MCP connector ${origin}/mcp (name: bot2bot) and sign me in. Then call its whoami tool and do the next step it gives you.`;
  const isPaused = (u) => liveBots(u).some((b) => b.paused_at);
  // One of my bots and one of its contacts, by bot id and the contact's bot id.
  const ownContact = (u, botId, peerId) => {
    const b = ownBot(u, botId);
    const c = q('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(b.id, Number(peerId));
    if (!c) throw new HttpError(404, 'Contact not found');
    return { b, c };
  };
  const person = (c) => `${esc(c.name || '@' + c.handle)}`;
  const verifiedPill = (v) => (v ? '<span class="pill ready">Email verified</span>' : '<span class="pill">Not verified</span>');

  // ───── pages ─────
  function landing(user) {
    return layout('Bot to bot', `<section class="hero"><h1>Let your AI bot message your friends' bots.</h1>
<p class="lead">Free and open source. Works with GrokBot today.</p>
<a class="btn" href="${user ? '/app' : '/login'}">${user ? 'Open your dashboard' : 'Get started'}</a>${hosted ? '<p><a class="link" href="/pricing">Pricing</a></p>' : ''}</section>`, { user });
  }

  // ───── plans ─────
  const dateStr = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  function pricingPage(user) {
    return layout('Pricing', `<section class="hero"><h1>Free to start</h1></section>
<section class="grid3 tiers">
<div class="card"><h2>Run it yourself</h2><p class="price">Free</p><ul class="ticks"><li>Open source, everything included</li><li>Your own server</li><li>No limits from us</li></ul><a class="btn ghost" href="#">Get the code</a></div>
<div class="card"><h2>We run it</h2><p class="price">Free</p><ul class="ticks"><li>${B.freeMessages} sent messages ${B.perWord}</li><li>Receiving is always free</li><li>No card</li></ul><a class="btn ghost" href="${user ? '/app' : '/login'}">${user ? 'Dashboard' : 'Start free'}</a></div>
<div class="card attention"><h2>Family</h2><p class="price">${esc(B.priceLabel)}</p><ul class="ticks"><li>No limit</li><li>Covers you and ${B.householdSize - 1} people</li><li>One payment, nothing renews by itself</li></ul>${B.stripeKey && B.priceId ? `<a class="btn" href="${user ? '/app/billing' : '/login'}">${user ? 'See my plan' : 'Start free'}</a>` : '<p class="pill">Coming soon</p>'}</div>
</section><p class="quiet small muted">Private mode is end-to-end encrypted between bots on every plan; quick connect is not. Friends who use the web inbox are always free; their chats are not end-to-end encrypted.</p>`, { user });
  }
  function planBanner(user) {
    if (!hosted) return '';
    const hasBot = liveBots(user).some((b) => b.vendor !== 'web');
    if (!hasBot) return '';
    const a = allowance(user);
    if (!a.limited) return '';
    if (a.left <= 0) return `<section class="card attention"><h2>You've used your ${a.limit} free messages ${B.periodWord}</h2><p>Your bot can't send until ${B.freePeriod === 'day' ? 'tomorrow (midnight UTC)' : dateStr(a.resets)}. Receiving still works. ${esc(B.priceLabel)} removes the limit for you and ${B.householdSize - 1} others.</p><a class="btn" href="/app/billing">Remove the limit</a></section>`;
    return `<p class="quiet small muted">${a.left} of ${a.limit} free messages left ${B.periodWord}. <a class="link" href="/app/billing">Plan</a></p>`;
  }
  function billingPage(user, { error = '', paid = false } = {}) {
    const c = allowance(user);
    const members = q('SELECT email FROM household_members WHERE payer_user_id = ? ORDER BY added_at').all(user.id);
    const canPay = !!(B.stripeKey && B.priceId);
    const status = c.state === 'paid' ? `Paid until ${dateStr(c.until)}.`
      : c.state === 'covered' ? `Covered by ${esc(c.payer)} until ${dateStr(c.until)}.`
      : `Free plan: ${c.used} of ${c.limit} messages sent ${B.periodWord}. It starts again ${B.freePeriod === 'day' ? 'at midnight UTC' : `on ${dateStr(c.resets)}`}. Receiving is never limited.`;
    return layout('Plan', `<p><a href="/app" class="link">← Dashboard</a></p>
<section class="card"><h1>Your plan</h1>${paid ? '<p class="okmsg" role="status">Thanks! Payment received.</p>' : ''}${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<p>${status}</p>
${c.state === 'covered' ? '' : canPay ? `<form method="post" action="/app/billing/checkout"><button class="btn">${c.state === 'paid' ? 'Add another year' : `Pay ${esc(B.priceLabel)}`}</button></form><p class="muted small">${c.state === 'paid' ? '' : 'No monthly limit for you and your household. '}One payment a year. No subscription, nothing renews by itself.</p>`
  : '<p class="muted small">The paid plan is coming soon.</p>'}</section>
<section class="card"><h2>Your household</h2><p>A paid plan covers you and up to ${B.householdSize - 1} people. Add the email they sign in with. They never see your conversations.</p>
${members.map((m) => `<div class="row"><span>${esc(m.email)}</span><form method="post" action="/app/billing/members" class="more"><input type="hidden" name="remove" value="${esc(m.email)}"><button class="link danger">Remove</button></form></div>`).join('')}
${members.length < B.householdSize - 1 ? `<form method="post" action="/app/billing/members" class="stack"><label>Email<input name="email" type="email" required autocomplete="off"></label><button class="btn small ghost">Add to my household</button></form>` : ''}
${c.state !== 'paid' && members.length ? '<p class="muted small">They have no limit once you have paid.</p>' : ''}</section>`, { user });
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
${sent ? `<p>We sent a 6-digit code to <b>${esc(email)}</b>. You can also click the link in the email.</p>
${devCode ? `<p class="dev">Dev mode: your code is <b>${esc(devCode)}</b></p>` : ''}
<form method="post" action="/login/verify" class="stack"><input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="next" value="${esc(next)}"><input type="hidden" name="tz" id="tz">
<label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required autofocus></label>
<button class="btn">Log in</button></form><script>try{document.getElementById('tz').value=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}</script>`
    : `<p>No password. We email you a code.</p><form method="post" action="/login" class="stack"><input type="hidden" name="next" value="${esc(next)}">
<label>Email<input name="email" type="email" autocomplete="email" required autofocus value="${esc(email)}"></label><button class="btn">Email me a code</button></form>`}
</section>`);
  }

  function dashboard(user) {
    const bots = myBots(user);
    const now = clock();
    if (!bots.length) {
      const code = pendingCode(user);
      if (code) return layout('Set up', `<section class="card"><p class="step">Private mode</p><h1>Connect your bot</h1>${waitingForBot({ plain: code.plain_code })}</section>`, { user });
      // Two ways in. Quick connect is one message to the bot; private mode installs a small tool for end-to-end encryption.
      return layout('Set up', `<section class="card"><h1>Connect your bot</h1><p>Pick one. You can switch later and keep your contacts.</p>
<div class="ways">
<div class="way"><span class="pill ready">Easiest</span><h2>Quick connect</h2><p>Paste this into your bot's chat. It adds ${esc(product)} as an app and asks you to sign in once.</p>
<div class="copy"><pre id="qc">${esc(quickMessage)}</pre><button class="btn small" data-copy="#qc">Copy message</button></div>
<p class="muted small">Not end-to-end encrypted: your bot hands us the text, and we delete it 7 days after delivery.</p>
<p class="wait" id="wait"><span class="dot"></span> Waiting for your bot…</p></div>
<div class="way"><span class="pill">End-to-end encrypted</span><h2>Private</h2><p>Your bot installs a small tool and makes its own keys. Only the bots can read messages.</p>
<form method="post" action="/app/bots" class="stack"><label>Bot name<input name="handle" required pattern="[a-z0-9][a-z0-9_-]{1,31}" placeholder="ben" value="${esc(user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32))}"></label>
<button class="btn ghost">Continue</button></form></div>
</div>
<div class="muted small">No AI bot? <form method="post" action="/app/web-inbox" class="inline"><button class="link">Use the web inbox instead</button></form>.</div>
<script>${COPY_JS}
(function poll(){ fetch('/app/status').then(r=>r.json()).then(d=>{ if(d.bots>0) location.href='/app'; else setTimeout(poll,2500); }).catch(()=>setTimeout(poll,4000)); })();</script></section>`, { user });
    }
    const rows = bots.map((b) => {
      const st = botStatus(b);
      return `<a class="row" href="${b.vendor === 'web' && !b.disconnected_at ? '/app/inbox' : `/app/bots/${b.id}`}"><b>@${esc(b.handle)}</b><span class="pill ${st.key}">${st.label}</span>${b.vendor === 'web' ? '' : `<span class="muted">last woken ${ago(b.last_ring_at, now)}</span>`}</a>`;
    }).join('');
    const botIds = bots.map((b) => b.id);
    const ph = botIds.map(() => '?').join(',');
    const contacts = q(`SELECT c.owner_bot, c.peer_bot, c.alias, c.blocked, c.approved_at, back.approved_at AS their_ok, back.blocked AS they_blocked,
        b.handle, b.vendor, b.box_pub, ob.box_pub AS my_box, ob.vendor AS my_vendor, c.codes_compared_at, c.can_ask, back.can_ask AS they_let_me_ask, u.name, u.email_verified_at, ob.handle AS my_handle
      FROM contacts c JOIN bots b ON b.id = c.peer_bot JOIN bots ob ON ob.id = c.owner_bot LEFT JOIN users u ON u.id = b.user_id
      LEFT JOIN contacts back ON back.owner_bot = c.peer_bot AND back.peer_bot = c.owner_bot
      WHERE c.owner_bot IN (${ph}) ORDER BY c.alias`).all(...botIds);
    const requests = contacts.filter((c) => !c.approved_at);
    const settled = contacts.filter((c) => c.approved_at);
    const activity = q(`SELECT m.*, fb.handle AS from_handle, tb.handle AS to_handle FROM messages m JOIN bots fb ON fb.id = m.from_bot JOIN bots tb ON tb.id = m.to_bot
      WHERE (m.from_bot IN (${ph}) OR m.to_bot IN (${ph})) AND m.kind != 'probe' ORDER BY m.created_at DESC LIMIT 15`).all(...botIds, ...botIds);
    const live = bots.filter((b) => !b.disconnected_at);
    const paused = live.some((b) => b.paused_at);
    const unread = live.some((b) => b.vendor === 'web') ? q(`SELECT count(*) AS n FROM messages WHERE to_bot IN (${ph}) AND status IN ('pending', 'claimed') AND kind != 'probe'`).get(...botIds).n : null;
    const multi = live.length > 1;
    // Honest labels: only bot-to-bot chats with keys on both sides are end-to-end encrypted.
    const lock = (c) => c.vendor === 'web' || c.my_vendor === 'web' ? '<span class="pill" title="They read on the web, so these messages pass through our server readable">Web inbox · not end-to-end encrypted</span>'
      : c.vendor === 'connector' || c.my_vendor === 'connector' ? '<span class="pill" title="A connected-app bot hands us plain text">Connected app · not end-to-end encrypted</span>'
      : c.box_pub && c.my_box ? `<span class="pill ready" title="Only the two bots can read these messages">${c.codes_compared_at ? 'Encrypted · codes compared' : 'End-to-end encrypted'}</span>`
      : '<span class="pill" title="One of the bots needs the latest b2b tool">Not encrypted yet</span>';
    // Ask their bot: what each side's bot may answer without asking its person first.
    const asks = (c, ids) => {
      const mine = JSON.parse(c.can_ask || '[]'), theirs = JSON.parse(c.they_let_me_ask || '[]');
      if (!mine.length && !theirs.length) return '';
      return `<div class="asks">${mine.length ? `<div class="small"><span class="muted">Their bot may ask yours about</span> ${mine.map((t) => `<span class="topic">${esc(t)}<form method="post" action="/app/contacts/disallow" class="inline">${ids}<input type="hidden" name="topic" value="${esc(t)}"><button class="x" aria-label="Stop letting ${esc(c.alias)} ask about ${esc(t)}" title="Stop">×</button></form></span>`).join(' ')}</div>` : ''}
${theirs.length ? `<div class="small"><span class="muted">Your bot may ask theirs about</span> ${theirs.map((t) => `<span class="topic">${esc(t)}</span>`).join(' ')}</div>` : ''}</div>`;
    };
    const contactRow = (c) => {
      const state = c.blocked ? '<span class="pill">Blocked</span>' : !c.their_ok ? '<span class="pill needs_test">Waiting for them</span>' : '';
      const ids = `<input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}">`;
      return `<div class="row"><b>${esc(c.alias)}</b><span class="muted">${c.name && c.name.toLowerCase() !== c.alias.toLowerCase() ? `${esc(c.name)} · ` : ''}@${esc(c.handle)}${multi ? ` · to @${esc(c.my_handle)}` : ''}</span>${c.email_verified_at ? '<span class="pill ready">Email verified</span>' : '<span class="pill">Not verified</span>'}${lock(c)}${state}
<details class="more"><summary aria-label="Options for ${esc(c.alias)}">•••</summary><div class="menu">
<form method="post" action="/app/contacts/block">${ids}${c.blocked ? '<input type="hidden" name="unblock" value="1"><button class="link">Unblock</button>' : '<button class="link">Block</button>'}</form>
<form method="post" action="/app/contacts/remove" data-confirm="Remove ${esc(c.alias)}? Your bots won't be able to message each other until you connect again.">${ids}<button class="link danger">Remove</button></form>
</div></details>${asks(c, ids)}</div>`;
    };
    return layout('Dashboard', `${paused ? `<section class="card banner"><div><h2>Everything is paused</h2><p>Your bot won't be woken and can't send. Messages from friends wait here for up to 7 days.</p></div>
<form method="post" action="/app/pause"><input type="hidden" name="on" value="0"><button class="btn">Resume</button></form></section>` : ''}
${planBanner(user)}
${requests.map((c) => `<section class="card attention"><h2>Did you mean to connect with ${person(c)}?</h2>
<p>Your bot @${esc(c.my_handle)} paired with <b>${person(c)}</b> (@${esc(c.handle)}) ${verifiedPill(c.email_verified_at)}. Nothing can be sent either way until you say yes.</p>
<div class="actions"><form method="post" action="/app/contacts/approve"><input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}"><button class="btn">Yes, connect</button></form>
<form method="post" action="/app/contacts/remove"><input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}"><button class="btn ghost">No, remove</button></form></div></section>`).join('')}
${unread !== null ? `<section class="card ${unread ? 'attention' : ''}"><div class="head"><div><h2>Inbox</h2><p class="muted">${unread ? `${unread} new message${unread > 1 ? 's' : ''}` : 'Nothing new'}</p></div><a class="btn" href="/app/inbox">Open inbox</a></div></section>` : ''}
${checklist(live, settled, paused)}
<section class="grid2">
<div class="card"><div class="head"><h2>Your bots</h2><form method="post" action="/app/bots/new"><button class="link">Add another</button></form></div>${rows}</div>
<div class="card"><div class="head"><h2>Contacts</h2>${live.length ? `<form method="post" action="/app/invites"><input type="hidden" name="bot" value="${live[0].id}"><button class="btn small">Invite a friend</button></form>` : ''}</div>
${settled.length ? settled.map(contactRow).join('') : '<p class="muted">No contacts yet. Invite a friend and their bot can message yours.</p>'}</div>
</section>
<section class="card"><h2>Recent activity</h2>${activity.length ? `<ul class="feed">${activity.map((m) => `<li><span class="muted">${ago(m.created_at, now)}</span> <b>@${esc(m.from_handle)}</b> → <b>@${esc(m.to_handle)}</b> <span class="pill">${esc(m.replied_at ? 'replied' : m.status === 'delivered' ? 'passed on' : m.status === 'dropped' ? 'not delivered' : m.status)}</span><div class="msg">${m.body_purged_at ? '<i>Text deleted after 7 days</i>' : m.sealed ? '<i>End-to-end encrypted. Only the bots can read it.</i>' : esc(m.text).slice(0, 220)}</div></li>`).join('')}</ul>` : '<p class="muted">Messages your bots send and receive show up here.</p>'}</section>
${live.length && !paused ? `<section class="quiet"><form method="post" action="/app/pause" data-confirm="Pause everything? Your bot won't be woken and can't send until you resume."><input type="hidden" name="on" value="1"><button class="link">Pause everything</button></form></section>` : ''}
<script>${CONFIRM_JS}</script>`, { user });
  }

  // Setup, step by step, until the first friend is connected.
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
    return `<section class="card attention"><div class="head"><h2>Set up @${esc(bot.handle)}</h2><span class="muted small">${done} of ${steps.length}</span></div>
<ol class="checklist">${steps.map((s) => `<li class="${s.done ? 'done' : s === next ? 'next' : ''}"><span class="tick" aria-hidden="true">${s.done ? '✓' : ''}</span>${esc(s.label)}${s.done ? '<span class="sr"> (done)</span>' : ''}</li>`).join('')}</ol>
${next.form ? `<form method="post" action="/app/invites"><input type="hidden" name="bot" value="${next.form}"><button class="btn">Invite a friend</button></form><p class="muted small">Or tell your bot "invite Anna". It gives you a link to send.</p>` : `<a class="btn" href="${next.href}">Continue</a>`}</section>`;
  }

  // GrokBot-style overview of a working bot: one tile per thing it has.
  function botTiles(user, b) {
    const n = q('SELECT count(*) AS n FROM contacts WHERE owner_bot = ? AND approved_at IS NOT NULL').get(b.id).n;
    const quiet = user.quiet_on && user.tz ? `${hhmm(user.quiet_start)} to ${hhmm(user.quiet_end)}` : 'Off';
    const tile = (title, value, sub, href) => `<${href ? `a href="${href}"` : 'div'} class="tile"><span class="tile__t">${title}</span><b>${value}</b><span class="muted small">${sub}</span></${href ? 'a' : 'div'}>`;
    return `<div class="tiles">
${tile('Doorbell', b.doorbell_verified_at ? 'On' : b.webhook_url ? 'Not tested' : 'Off', `Last woken ${ago(b.last_ring_at, clock())}`)}
${tile('Encryption', b.box_pub ? 'On' : 'Off', b.box_pub ? 'Only the bots can read messages' : b.vendor === 'connector' ? 'Connected app: not end-to-end' : 'Ask your bot to run "b2b keys"')}
${tile('Contacts', String(n), n === 1 ? 'friend connected' : 'friends connected', '/app')}
${tile('Quiet hours', quiet, quiet === 'Off' ? 'Messages can wake it any time' : 'Nobody wakes it at night', '/app/account')}
${tile('Backup check', b.backup_every_h ? `Every ${b.backup_every_h} h` : 'Off', b.last_claim_at ? `Last checked in ${ago(b.last_claim_at, clock())}` : 'Never checked in yet', '#backup')}
</div><p class="muted small">Your bot's own chats stay yours. Friends' bots only get what you send them.</p>`;
  }
  const backupMessage = (h) => `Please add a schedule to your "b2b doorbell" routine: also run it every ${h} hours, with the same instruction. It's a backup in case the doorbell ever stops working. Then run: node ~/bin/b2b.mjs backup-check ${h}`;

  function waitingForBot(code) {
    return `<p>Copy this message and paste it into your bot's chat in the GrokBot app.</p>
<div class="copy"><pre id="msg">${esc(setupMessage(code.plain || 'XXXX-XXXX'))}</pre><button class="btn small" data-copy="#msg">Copy message</button></div>
<p class="wait" id="wait"><span class="dot"></span> Waiting for your bot to join…</p>
<form method="post" action="/app/bots/cancel"><button class="link">Use a different name</button></form>
<script>${COPY_JS}
(function poll(){ fetch('/app/status').then(r=>r.json()).then(d=>{ if(d.bots>0) location.href='/app'; else setTimeout(poll,2500); }).catch(()=>setTimeout(poll,4000)); })();</script>`;
  }

  function botPage(user, b, { error = '' } = {}) {
    const st = botStatus(b);
    const step = st.key === 'needs_doorbell' ? 2 : st.key === 'needs_test' ? 3 : null;
    if (b.vendor === 'web' && !b.disconnected_at) {
      const code = q('SELECT plain_code FROM enroll_codes WHERE user_id = ? AND handle = ? AND reissue = 1 AND used_at IS NULL AND expires_at > ?').get(user.id, b.handle, clock());
      return layout(`@${b.handle}`, `<p><a href="/app/inbox" class="link">← Inbox</a></p><section class="card"><div class="head"><h1>Connect your AI bot</h1><span class="pill ready">Web inbox</span></div>
${code ? `<p>Paste this into your bot's chat. When it joins, it takes over as @${esc(b.handle)} and keeps all your contacts.</p><div class="copy"><pre id="msg">${esc(setupMessage(code.plain_code))}</pre><button class="btn small" data-copy="#msg">Copy message</button></div><script>${COPY_JS}</script>`
  : `<p>Right now you read and answer messages here. If you have GrokBot, it can do that for you and keep all your contacts.</p><form method="post" action="/app/bots/${b.id}/reconnect"><button class="btn">Connect GrokBot</button></form>`}</section>`, { user });
    }
    if (b.disconnected_at) {
      const code = q('SELECT plain_code FROM enroll_codes WHERE user_id = ? AND handle = ? AND reissue = 1 AND used_at IS NULL AND expires_at > ?').get(user.id, b.handle, clock());
      return layout(`@${b.handle}`, `<p><a href="/app" class="link">← Dashboard</a></p><section class="card"><div class="head"><h1>@${esc(b.handle)}</h1><span class="pill">Disconnected</span></div>
${code ? `<p>Paste this into your bot's chat to reconnect it.</p><div class="copy"><pre id="msg">${esc(setupMessage(code.plain_code))}</pre><button class="btn small" data-copy="#msg">Copy message</button></div><script>${COPY_JS}</script>`
  : `<p>This bot can't send or receive. Reconnecting gives it a new key; the old one stays cancelled.</p><form method="post" action="/app/bots/${b.id}/reconnect"><button class="btn">Reconnect</button></form>`}</section>`, { user });
    }
    return layout(`@${b.handle}`, `<p><a href="/app" class="link">← Dashboard</a></p>
<section class="card"><div class="head"><h1>@${esc(b.handle)}</h1><span class="pill ${st.key}">${st.label}</span></div>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
${step === 2 ? `<p class="step">Almost done</p><h2>Turn on the doorbell</h2>
${b.vendor === 'connector' ? `<p>Your bot needs a routine called <b>“b2b doorbell”</b>, so friends can wake it. Paste this into your bot's chat:</p>
<div class="copy"><pre id="dmsg">${esc(CONNECTOR_DOORBELL)}</pre><button class="btn small" data-copy="#dmsg">Copy message</button></div><script>${COPY_JS}</script>` : `<p>Your bot made a routine called <b>“b2b doorbell”</b>. It lets friends wake your bot.</p>`}
<ol class="howto"><li>In the GrokBot app, open your bot's details and find <b>Routines</b>.</li><li>Right-click <b>b2b doorbell</b> and choose <b>Webhook</b>.</li><li>Copy the address and the key into the boxes below.</li></ol>
<form method="post" action="/app/bots/${b.id}/doorbell" class="stack">
<label>Webhook address<input name="url" required placeholder="https://api2.cursor.sh/automations/webhook/…" autocomplete="off"></label>
<label>Key<input name="key" type="password" required autocomplete="off" placeholder="Paste the key"></label>
<p class="muted small">The key stays with us, encrypted. Never paste it into a chat.</p>
<button class="btn">Save and test</button></form>`
  : step === 3 ? `<p class="step">Last step</p><h2>Test the doorbell</h2><p>We ring your bot once. It should wake up on its own and check in. Don't type anything to your bot while this runs.</p>
<button class="btn" id="test">Ring my bot</button><p class="wait hidden" id="wait"><span class="dot"></span> <span id="waittext">Ringing…</span></p>
<script>
const btn=document.getElementById('test'),w=document.getElementById('wait'),t=document.getElementById('waittext');
btn.addEventListener('click',async()=>{btn.disabled=true;w.classList.remove('hidden');
 const r=await fetch('/app/bots/${b.id}/test',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json());
 if(r.error){t.textContent=r.error;btn.disabled=false;return;}
 t.textContent=r.status===200?'Rang. Waiting for your bot to wake up…':'The doorbell answered with '+r.status+'. Check the routine is turned on.';
 let n=0;(function poll(){fetch('/app/bots/${b.id}/state').then(r=>r.json()).then(d=>{ if(d.verified){t.textContent='It works. Your bot woke up on its own.';setTimeout(()=>location.replace('/app/bots/${b.id}'),1200);} else if(++n<60) setTimeout(poll,2000); else {t.textContent='No answer yet. Make sure the routine is on, then try again.';btn.disabled=false;} });})();});
if(new URLSearchParams(location.search).get('ring')==='1') btn.click();
</script>`
  : st.key === 'paused' ? `<p>Paused. This bot isn't woken and can't send. Resume from the dashboard.</p>`
  : `${botTiles(user, b)}
<form method="post" action="/app/invites" class="inline"><input type="hidden" name="bot" value="${b.id}"><button class="btn">Invite a friend</button></form>`}
</section>
${!step && st.key !== 'paused' ? `<section class="card" id="backup"><h2>Backup check</h2><p>The doorbell wakes your bot when a message comes in. A backup check also lets it look on a schedule, in case the doorbell ever breaks. Each check uses a little of your GrokBot usage, so it's off unless you want it.</p>
<form method="post" action="/app/bots/${b.id}/backup" class="pick"><label>Check every<select name="every">${[0, 2, 4, 8, 12, 24].map((h) => `<option value="${h}"${(b.backup_every_h || 0) === h ? ' selected' : ''}>${h ? `${h} hours` : 'Off'}</option>`).join('')}</select></label><button class="btn small ghost">Save</button></form>
${b.backup_every_h ? `<p>Paste this into your bot's chat:</p><div class="copy"><pre id="bmsg">${esc(backupMessage(b.backup_every_h))}</pre><button class="btn small" data-copy="#bmsg">Copy message</button></div><script>${COPY_JS}</script>` : ''}</section>` : ''}
${b.disconnected_at ? '' : st.key !== 'needs_doorbell' ? `<details class="card"><summary>Change doorbell</summary><form method="post" action="/app/bots/${b.id}/doorbell" class="stack">
<label>Webhook address<input name="url" required value="${esc(b.webhook_url || '')}"></label><label>New key<input name="key" type="password" required autocomplete="off"></label><button class="btn">Save</button></form></details>` : ''}
${b.disconnected_at ? '' : `<details class="card danger-zone"><summary>Disconnect this bot</summary><p>Your bot's access is cancelled right away. Its doorbell key is deleted, and anything still waiting is not delivered. Your contacts stay, and you can reconnect later.</p>
<form method="post" action="/app/bots/${b.id}/disconnect" data-confirm="Disconnect @${esc(b.handle)} now?"><button class="btn danger">Disconnect @${esc(b.handle)}</button></form></details>`}
<script>${CONFIRM_JS}</script>`, { user });
  }

  function invitePage(inv, inviter, user, bots, { done = false, error = '' } = {}) {
    const who = inviter.name ? `${esc(inviter.name)}` : `@${esc(inviter.handle)}`;
    const verified = inviter.email_verified_at ? `<span class="pill ready">Email verified</span>` : '<span class="pill">Not verified</span>';
    let action;
    const aliasField = `<label>What do you call them?<input name="alias" required maxlength="32" value="${esc((inviter.name || inviter.handle).split(' ')[0])}"></label>`;
    if (done === 'web') action = `<p>You're connected. When ${who} sends you something, we email you and it shows up in your inbox.</p><a class="btn" href="/app/inbox">Open my inbox</a>`;
    else if (done) action = `<p>You're connected. Your bot can now message ${who}'s bot.</p><a class="btn" href="/app">Go to your dashboard</a>`;
    else if (!user) action = `<p>Sign in with your email to connect. You don't need an AI bot: you can read and answer in your browser.</p><a class="btn" href="/login?next=${encodeURIComponent('/i/' + inv.plain)}">Continue</a>`;
    else if (!bots.length) action = `<form method="post" action="/i/${esc(inv.plain)}" class="stack"><input type="hidden" name="web" value="1">${aliasField}
<button class="btn">Connect with my web inbox</button></form><p class="muted small">Web inbox chats are not end-to-end encrypted. Have GrokBot? <a href="/app">Set up your bot first</a>, then open this link again.</p>`;
    else action = `<form method="post" action="/i/${esc(inv.plain)}" class="stack">
${bots.length > 1 ? `<label>Which bot<select name="bot">${bots.map((b) => `<option value="${b.id}">@${esc(b.handle)}</option>`).join('')}</select></label>` : `<input type="hidden" name="bot" value="${bots[0].id}">`}
${aliasField}
<button class="btn">Connect</button></form>`;
    return layout('Invitation', `<section class="card narrow center"><div class="avatar" aria-hidden="true">${esc((inviter.name || inviter.handle).slice(0, 1).toUpperCase())}</div>
<h1>${who} wants to connect</h1><p class="muted">@${esc(inviter.handle)} ${verified}</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}${action}
<p class="muted small">Once connected, you can send each other messages and questions. Messages are never commands to your bot. You can block anyone at any time.</p></section>`, { user });
  }

  function invitedPage(user, b, link) {
    return layout('Invite a friend', `<p><a href="/app" class="link">← Dashboard</a></p><section class="card"><h1>Invite a friend</h1>
<p>Send this link to a friend. It works once and expires in 7 days.</p>
<div class="copy"><pre id="link">${esc(link)}</pre><button class="btn small" data-copy="#link">Copy link</button></div>
<p class="muted small">When they open it, they'll see your name and that your email is verified.</p><script>${COPY_JS}</script></section>`, { user });
  }

  // ───── web inbox ─────
  // Opening the inbox counts as reading: waiting messages are marked seen for the sender.
  function markSeen(ids) {
    if (!ids.length) return;
    const ph = ids.map(() => '?').join(',');
    q(`UPDATE messages SET status = 'delivered', delivered_at = ?, next_ring_at = NULL, lease_until = NULL
       WHERE to_bot IN (${ph}) AND status IN ('pending', 'claimed') AND kind != 'probe'`).run(clock(), ...ids);
  }

  function inboxPage(user, { error = '', sent = '' } = {}) {
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
      return `<section class="card convo" id="c-${c.peer_bot}"><div class="head"><div><h2>${esc(c.alias)}</h2><p class="muted small">${c.name && c.name.toLowerCase() !== c.alias.toLowerCase() ? `${esc(c.name)} · ` : ''}@${esc(c.handle)} ${verifiedPill(c.email_verified_at)}</p></div>
${c.blocked ? '<span class="pill">Blocked</span>' : !c.their_ok ? '<span class="pill needs_test">Waiting for them</span>' : ''}</div>
${msgs.length ? `<ul class="thread">${msgs.map((m) => bubble(m, c)).join('')}</ul>` : `<p class="muted">No messages yet. Say hi.</p>`}
${c.blocked || paused ? '' : `<form method="post" action="/app/inbox/send" class="compose">${ids_}${ask ? `<input type="hidden" name="reply_to" value="${esc(ask.id)}">` : ''}
<label class="sr" for="t-${c.peer_bot}">Message to ${esc(c.alias)}</label><textarea id="t-${c.peer_bot}" name="text" rows="2" maxlength="4000" placeholder="${ask ? 'Answer in your own words' : `Message ${esc(c.alias)}`}" required></textarea>
<details class="extra"><summary>Add a link or ask a question</summary><label>Link<input name="link" type="url" placeholder="https://"></label>
<label>Answer options, separated by commas<input name="choices" placeholder="Yes, No, Maybe"></label></details>
<button class="btn small">Send</button></form>`}</section>`;
    }).join('');
    return layout('Inbox', `${paused ? `<section class="card banner"><div><h2>Everything is paused</h2><p>No emails, and you can't send. Messages still show up here.</p></div><form method="post" action="/app/pause"><input type="hidden" name="on" value="0"><button class="btn">Resume</button></form></section>` : ''}
${error ? `<p class="error card" role="alert">${esc(error)}</p>` : ''}${sent ? `<p class="okmsg card" role="status">Sent.</p>` : ''}
${cards ? '<p class="quiet small muted">Not end-to-end encrypted. You read these on the web, so they pass through our server in a form we could read. They are deleted 7 days after you see them.</p>' : ''}
${cards || `<section class="card"><h1>Your inbox</h1><p class="muted">When friends connect with you, their messages and questions show up here.</p></section>`}
${wbs.length ? `<p class="quiet small"><a class="link" href="/app/bots/${wbs[0].id}">Have GrokBot? Let it handle this for you</a></p>` : ''}`, { user });
  }

  function accountPage(user, { error = '', quietError = '' } = {}) {
    return layout('Account', `<p><a href="/app" class="link">← Dashboard</a></p>
<section class="card"><h1>Account</h1><p><b>${esc(user.name)}</b><br><span class="muted">${esc(user.email)}</span> ${verifiedPill(user.email_verified_at)}</p>
<p class="muted small">Friends see your name and that your email is verified. They never see the address itself.</p></section>
${hosted ? `<section class="card"><h2>Plan</h2><p><a class="btn ghost" href="/app/billing">See my plan</a></p></section>` : ''}
<section class="card"><h2>Quiet hours</h2><p>Nobody can wake your bot or email you during these hours. Messages wait and arrive when they end.</p>
${quietError ? `<p class="error" role="alert">${esc(quietError)}</p>` : ''}${!user.tz ? '<p class="muted small">Pick your time zone so we know when it\'s night for you.</p>' : ''}
<form method="post" action="/app/account/quiet" class="stack quietform">
<label class="check"><input type="checkbox" name="on" value="1"${user.quiet_on ? ' checked' : ''}> Quiet hours on</label>
<div class="row2"><label>From<input type="time" name="start" value="${hhmm(user.quiet_start ?? 1320)}" required></label><label>To<input type="time" name="end" value="${hhmm(user.quiet_end ?? 480)}" required></label></div>
<label>Time zone<select name="tz">${Intl.supportedValuesOf('timeZone').map((z) => `<option${z === (user.tz || 'UTC') ? ' selected' : ''}>${z}</option>`).join('')}</select></label>
<button class="btn small">Save</button></form>
${quietUntil(user, clock()) ? `<p class="muted small">It's quiet time now. Messages wait until ${hhmm(user.quiet_end)}.</p>` : ''}</section>
<section class="card"><h2>Your data</h2><p>Message text is deleted 7 days after delivery. Messages that can't be delivered expire after 7 days. The activity log is kept for 90 days.</p>
<a class="btn ghost" href="/app/account/export">Download my data</a></section>
<details class="card danger-zone"${error ? ' open' : ''}><summary>Delete my account</summary>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<p>This disconnects your bots, removes your contacts and erases message text. Copies your friends' bots already received stay with them.</p>
<form method="post" action="/app/account/delete" class="stack"><label>Type ${esc(user.email)} to confirm<input name="confirm" autocomplete="off" required></label><button class="btn danger">Delete my account</button></form></details>`, { user });
  }

  function exportData(user) {
    const bots = myBots(user);
    const ids = bots.map((b) => b.id);
    const ph = ids.map(() => '?').join(',') || 'NULL';
    return {
      exported_at: iso(clock()),
      account: { name: user.name, email: user.email, created_at: iso(user.created_at), email_verified_at: iso(user.email_verified_at) },
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
      q(`UPDATE bots SET token_hash = NULL, webhook_url = NULL, webhook_key = NULL, doorbell_verified_at = NULL, paused_at = NULL, disconnected_at = coalesce(disconnected_at, ?), display_name = 'Deleted user' WHERE id IN (${ph})`).run(t, ...ids);
      q(`DELETE FROM contacts WHERE owner_bot IN (${ph}) OR peer_bot IN (${ph})`).run(...ids, ...ids);
      erase(`from_bot IN (${ph}) OR to_bot IN (${ph})`, ...ids, ...ids);
      q(`UPDATE events SET detail = '{}' WHERE bot IN (${ph})`).run(...ids);
      q(`DELETE FROM invites WHERE from_bot IN (${ph}) AND used_at IS NULL`).run(...ids);
      q('UPDATE enroll_codes SET used_at = ?, plain_code = NULL WHERE user_id = ? AND used_at IS NULL').run(t, user.id);
      q('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      q('DELETE FROM login_codes WHERE email = ?').run(user.email);
      // Bot handles stay reserved so nobody can take over a deleted person's name.
      q("UPDATE users SET email = ?, name = 'Deleted user', email_verified_at = NULL WHERE id = ?").run(`deleted-${user.id}@deleted.invalid`, user.id);
    });
    log(null, 'account_deleted', { user: user.id });
  }

  // ───── router ─────
  return async function handleApp(req, res, url) {
    const p = url.pathname;
    const isApp = p === '/oauth/authorize' || p === '/' || p === '/pricing' || p === '/billing/stripe' || p === '/login' || p.startsWith('/login/') || p === '/logout' || p === '/app' || p.startsWith('/app/') || p.startsWith('/i/');
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
        const back = (qs) => { const u = new URL(keep.redirect_uri); for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v); if (keep.state) u.searchParams.set('state', keep.state); return redirect(res, u.toString()), true; };
        if (keep.response_type !== 'code' || keep.code_challenge_method !== 'S256' || keep.code_challenge.length < 43) return back({ error: 'invalid_request', error_description: 'PKCE (S256) and response_type=code are required' });
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
        q('INSERT INTO oauth_codes (code_hash, client_id, bot_id, redirect_uri, challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(sha(code), client.client_id, bot.id, keep.redirect_uri, keep.code_challenge, clock() + 5 * 60_000);
        log(bot.id, 'connector_authorized', { client: client.name.slice(0, 40) });
        return back({ code });
      }

      // Invite links work for logged-out visitors too.
      const im = p.match(/^\/i\/([A-Za-z0-9-]{9})$/);
      if (im) {
        const plain = im[1].toUpperCase();
        const inv = q('SELECT * FROM invites WHERE code_hash = ?').get(sha(plain));
        if (!inv || inv.used_at || inv.expires_at < clock()) return page(res, 404, layout('Invitation', `<section class="card narrow center"><h1>This invite has expired</h1><p>Ask your friend for a new link.</p></section>`, { user })), true;
        inv.plain = plain;
        const inviter = q('SELECT b.handle, u.name, u.email_verified_at, b.user_id FROM bots b LEFT JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(inv.from_bot);
        const bots = user ? liveBots(user).filter((b) => b.id !== inv.from_bot) : [];
        if (req.method === 'GET') return page(res, 200, invitePage(inv, inviter, user, bots)), true;
        if (!user) return redirect(res, `/login?next=${encodeURIComponent(p)}`), true;
        const f = await form(req);
        if (inviter.user_id === user.id) return page(res, 400, invitePage(inv, inviter, user, bots, { error: 'That is your own invite.' })), true;
        const useWeb = f.web === '1' && !bots.length;
        const bot = useWeb ? makeWebBot(user) : bots.find((b) => b.id === Number(f.bot));
        if (!bot) return page(res, 400, invitePage(inv, inviter, user, bots, { error: 'Pick one of your bots.' })), true;
        try {
          routes['POST /v1/invites/accept']({ me: bot, body: { code: plain, alias: String(f.alias || '').trim() }, byOwner: true });
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
        return page(res, 200, invitePage(inv, inviter, user, bots, { done: bot.vendor === 'web' ? 'web' : true })), true;
      }

      // Everything below needs a logged-in user.
      if (!user) return redirect(res, `/login?next=${encodeURIComponent(p)}`), true;

      if (p === '/app' && req.method === 'GET') return page(res, 200, dashboard(user)), true;
      if (p === '/app/status' && req.method === 'GET') return json(res, 200, { bots: myBots(user).length }), true;

      if ((p === '/app/bots' || p === '/app/bots/new') && req.method === 'POST') {
        const f = await form(req);
        if (p === '/app/bots/new') { q('UPDATE enroll_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(clock(), user.id); return redirect(res, '/app/bots/new-form'), true; }
        const handle = String(f.handle || '').trim().toLowerCase();
        if (!HANDLE_RE.test(handle)) return page(res, 400, dashboard(user).replace('<h1>Connect your bot</h1>', '<h1>Connect your bot</h1><p class="error">Use 2 to 32 lowercase letters, numbers, - or _.</p>')), true;
        if (q('SELECT 1 FROM bots WHERE handle = ?').get(handle) || q('SELECT 1 FROM enroll_codes WHERE handle = ? AND used_at IS NULL AND expires_at > ? AND (user_id IS NULL OR user_id != ?)').get(handle, clock(), user.id)) {
          return page(res, 409, dashboard(user).replace('<h1>Connect your bot</h1>', '<h1>Connect your bot</h1><p class="error">That name is taken. Try another.</p>')), true;
        }
        const code = humanCode();
        q('UPDATE enroll_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(clock(), user.id);
        q('INSERT OR REPLACE INTO enroll_codes (code_hash, handle, display_name, expires_at, user_id, plain_code) VALUES (?, ?, ?, ?, ?, ?)').run(sha(code), handle, user.name, clock() + L.codeTtlMs, user.id, code);
        log(null, 'enroll_code', { handle, by: 'user' });
        return redirect(res, '/app'), true;
      }
      if (p === '/app/bots/new-form' && req.method === 'GET') {
        return page(res, 200, layout('Add a bot', `<section class="card"><h1>Add another bot</h1><form method="post" action="/app/bots" class="stack"><label>Bot name<input name="handle" required pattern="[a-z0-9][a-z0-9_-]{1,31}"></label><button class="btn">Continue</button></form></section>`, { user })), true;
      }
      if (p === '/app/bots/cancel' && req.method === 'POST') { q('UPDATE enroll_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(clock(), user.id); return redirect(res, '/app'), true; }

      const bm = p.match(/^\/app\/bots\/(\d+)(\/[a-z]+)?$/);
      if (bm) {
        const b = ownBot(user, bm[1]);
        const sub = bm[2] || '';
        if (!sub && req.method === 'GET') return page(res, 200, botPage(user, b)), true;
        if (sub === '/state' && req.method === 'GET') return json(res, 200, { verified: !!b.doorbell_verified_at, last_ring_status: b.last_ring_status }), true;
        if (sub === '/doorbell' && req.method === 'POST') {
          const f = await form(req);
          try {
            const urlOk = validWebhook(String(f.url || '').trim());
            const key = String(f.key || '').trim();
            if (key.length < 8 || key.length > 512 || /[\r\n]/.test(key)) throw new HttpError(400, 'That key looks wrong. Copy it again from the Webhook window.');
            // Re-check after reading the form: a disconnect that happened meanwhile wins.
            const saved = tx(() => {
              const now_ = q('SELECT * FROM bots WHERE id = ?').get(b.id);
              if (now_.disconnected_at || now_.vendor === 'web' || now_.user_id !== user.id) return false;
              q("DELETE FROM messages WHERE to_bot = ? AND kind = 'probe' AND status != 'delivered'").run(b.id);
              q('UPDATE bots SET webhook_url = ?, webhook_key = ?, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1 WHERE id = ? AND disconnected_at IS NULL').run(urlOk, sealKey(key), b.id);
              return true;
            });
            if (!saved) throw new HttpError(409, 'This bot was disconnected. Reconnect it first.');
            log(b.id, 'doorbell_set', { host: new URL(urlOk).hostname, by: 'owner' });
          } catch (e) {
            if (e instanceof HttpError) return page(res, 400, botPage(user, b, { error: e.message.replace(/^webhook (url|host)/, 'The webhook address') })), true;
            throw e;
          }
          // Saving rings the bot straight away: one less thing to click.
          return redirect(res, `/app/bots/${b.id}?ring=1`), true;
        }
        if (sub === '/disconnect' && req.method === 'POST') {
          tx(() => {
            q('UPDATE bots SET token_hash = NULL, webhook_url = NULL, webhook_key = NULL, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1, disconnected_at = ? WHERE id = ?').run(clock(), b.id);
            q('UPDATE oauth_tokens SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL').run(clock(), b.id);
            erase(`status IN ('pending', 'claimed') AND (to_bot = ? OR from_bot = ?)`, b.id, b.id);
            q('DELETE FROM invites WHERE from_bot = ? AND used_at IS NULL').run(b.id);
            // Any setup code made before now (an upgrade or an earlier reconnect) stops working too.
            q('UPDATE enroll_codes SET used_at = ?, plain_code = NULL WHERE handle = ? AND used_at IS NULL').run(clock(), b.handle);
          });
          log(b.id, 'disconnected', { by: 'owner' });
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
          q('UPDATE bots SET backup_every_h = ? WHERE id = ?').run([2, 4, 8, 12, 24].includes(h) ? h : null, b.id);
          return redirect(res, `/app/bots/${b.id}#backup`), true;
        }
        if (sub === '/test' && req.method === 'POST') {
          if (b.disconnected_at || b.vendor === 'web') return json(res, 409, { error: 'This bot is not connected.' }), true;
          try { const r = await routes['POST /v1/doorbell/test']({ me: b, byOwner: true }); return json(res, 200, r), true; }
          catch (e) { if (e instanceof HttpError) return json(res, e.status, { error: e.message }), true; throw e; }
        }
      }

      if (p.startsWith('/app/contacts/') && req.method === 'POST') {
        const f = await form(req);
        const { b, c } = ownContact(user, f.bot, f.peer);
        const action = p.slice('/app/contacts/'.length);
        if (action === 'approve') {
          q('UPDATE contacts SET approved_at = ? WHERE owner_bot = ? AND peer_bot = ?').run(clock(), b.id, c.peer_bot);
          log(b.id, 'contact_approved', { peer: c.peer_bot });
        } else if (action === 'block') {
          const unblock = f.unblock === '1';
          q('UPDATE contacts SET blocked = ? WHERE owner_bot = ? AND peer_bot = ?').run(unblock ? 0 : 1, b.id, c.peer_bot);
          if (!unblock) dropBetween(b.id, c.peer_bot);
          log(b.id, unblock ? 'contact_unblocked' : 'contact_blocked', { peer: c.peer_bot, by: 'owner' });
        } else if (action === 'disallow') {
          // The dashboard can only take topics away; adding them is done by telling your own bot.
          const left = JSON.parse(c.can_ask || '[]').filter((t) => t !== String(f.topic || ''));
          q('UPDATE contacts SET can_ask = ? WHERE owner_bot = ? AND peer_bot = ?').run(JSON.stringify(left), b.id, c.peer_bot);
          log(b.id, 'ask_topic_removed', { peer: c.peer_bot, by: 'owner' });
        } else if (action === 'remove') {
          tx(() => {
            q('DELETE FROM contacts WHERE (owner_bot = ? AND peer_bot = ?) OR (owner_bot = ? AND peer_bot = ?)').run(b.id, c.peer_bot, c.peer_bot, b.id);
            dropBetween(b.id, c.peer_bot);
          });
          log(b.id, 'contact_removed', { peer: c.peer_bot, by: 'owner' });
        } else throw new HttpError(404, 'Page not found');
        return redirect(res, '/app'), true;
      }

      if (p === '/app/pause' && req.method === 'POST') {
        const f = await form(req);
        const on = f.on === '1';
        for (const b of liveBots(user)) {
          q('UPDATE bots SET paused_at = ? WHERE id = ?').run(on ? clock() : null, b.id);
          log(b.id, on ? 'paused' : 'resumed', { by: 'owner' });
          if (!on) release(b.id);
        }
        return redirect(res, '/app'), true;
      }

      if (p === '/app/web-inbox' && req.method === 'POST') {
        if (!webBots(user).length) makeWebBot(user);
        return redirect(res, '/app/inbox'), true;
      }
      if (p === '/app/inbox' && req.method === 'GET') {
        const wbs = webBots(user);
        if (!wbs.length) return redirect(res, '/app'), true;
        const ph_ = wbs.map(() => '?').join(',');
        erase(`to_bot IN (${ph_}) AND status IN ('pending', 'claimed') AND kind != 'probe' AND created_at <= ?`, ...wbs.map((b) => b.id), clock() - L.undeliveredExpiryMs);
        const html = inboxPage(user, { sent: url.searchParams.get('sent') });
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
        return redirect(res, `/app/inbox?sent=1#c-${c.peer_bot}`), true;
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
        if (f.remove) q('DELETE FROM household_members WHERE payer_user_id = ? AND email = ?').run(user.id, String(f.remove).toLowerCase());
        else {
          const email = String(f.email || '').trim().toLowerCase();
          const n = q('SELECT count(*) AS n FROM household_members WHERE payer_user_id = ?').get(user.id).n;
          if (!EMAIL_RE.test(email) || email === user.email) return page(res, 400, billingPage(user, { error: 'That email address looks wrong.' })), true;
          if (n >= B.householdSize - 1) return page(res, 400, billingPage(user, { error: `Your plan covers up to ${B.householdSize - 1} people.` })), true;
          q('INSERT OR IGNORE INTO household_members (payer_user_id, email, added_at) VALUES (?, ?, ?)').run(user.id, email, clock());
          if (user.paid_until > clock()) for (const b of q('SELECT b.id FROM bots b JOIN users x ON x.id = b.user_id WHERE x.email = ? AND b.disconnected_at IS NULL').all(email)) release(b.id);
        }
        return redirect(res, '/app/billing'), true;
      }

      if (p === '/app/account' && req.method === 'GET') return page(res, 200, accountPage(user)), true;
      if (p === '/app/account/quiet' && req.method === 'POST') {
        const f = await form(req);
        const start = parseHhmm(f.start), end = parseHhmm(f.end);
        if (start === null || end === null || !validTz(f.tz)) return page(res, 400, accountPage(user, { quietError: 'Check the times and the time zone.' })), true;
        q('UPDATE users SET quiet_on = ?, quiet_start = ?, quiet_end = ?, tz = ? WHERE id = ?').run(f.on === '1' ? 1 : 0, start, end, f.tz, user.id);
        if (f.on !== '1' || !quietUntil({ ...user, quiet_on: f.on === '1' ? 1 : 0, quiet_start: start, quiet_end: end, tz: f.tz }, clock())) for (const b of liveBots(user)) release(b.id);
        return redirect(res, '/app/account'), true;
      }
      if (p === '/app/account/export' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${product}-export.json"` });
        res.end(JSON.stringify(exportData(user), null, 2));
        return true;
      }
      if (p === '/app/account/delete' && req.method === 'POST') {
        const f = await form(req);
        if (String(f.confirm || '').trim().toLowerCase() !== user.email) return page(res, 400, accountPage(user, { error: 'Type your email address exactly to confirm.' })), true;
        deleteAccount(user);
        res.setHeader('set-cookie', sessionCookie('', 0));
        return page(res, 200, layout('Account deleted', '<section class="card narrow center"><h1>Your account is deleted</h1><p>Your bots are disconnected, contacts removed and message text erased. Copies your friends\' bots already received stay with them.</p></section>')), true;
      }

      if (p === '/app/invites' && req.method === 'POST') {
        const f = await form(req);
        const b = ownBot(user, f.bot);
        const plain = humanCode();
        if (b.disconnected_at) throw new HttpError(400, 'Reconnect this bot first.');
        q('INSERT INTO invites (code_hash, from_bot, alias, expires_at, by_owner) VALUES (?, ?, ?, ?, 1)').run(sha(plain), b.id, `friend-${plain.slice(0, 4).toLowerCase()}`, clock() + L.inviteTtlMs);
        log(b.id, 'invite_created', { via: 'link' });
        return page(res, 200, invitedPage(user, b, `${origin}/i/${plain}`)), true;
      }

      throw new HttpError(404, 'Page not found');
    } catch (e) {
      if (e instanceof HttpError) { page(res, e.status, layout('Error', `<section class="card narrow"><h1>${e.status === 404 ? 'Not found' : 'Something went wrong'}</h1><p>${esc(e.message)}</p><a class="btn" href="/app">Back</a></section>`)); return true; }
      throw e;
    }
  };
}

const CONFIRM_JS = `document.querySelectorAll('form[data-confirm]').forEach(f=>f.addEventListener('submit',e=>{if(!confirm(f.dataset.confirm))e.preventDefault();}));`;
const COPY_JS = `document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{const t=document.querySelector(b.dataset.copy).innerText;try{await navigator.clipboard.writeText(t);b.textContent='Copied';}catch(e){b.textContent='Select and copy';}setTimeout(()=>b.textContent=b.dataset.label||'Copy',1800);}));document.querySelectorAll('[data-copy]').forEach(b=>b.dataset.label=b.textContent);`;

const CSS = `
:root{--bg:#f6f6f4;--card:#fff;--ink:#111;--muted:#666;--line:#e6e6e3;--accent:#111;--ok:#1f7a3f;--warn:#9a6700;--err:#b42318;--r:14px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 ui-sans-serif,-apple-system,"SF Pro Text",system-ui,sans-serif}
a{color:inherit}main{max-width:960px;margin:0 auto;padding:24px 20px 80px}
.top{display:flex;justify-content:space-between;align-items:center;max-width:960px;margin:0 auto;padding:18px 20px}
.brand{font-weight:700;text-decoration:none;letter-spacing:-.02em;font-size:18px}.top nav{display:flex;gap:14px;align-items:center}.who{color:var(--muted);font-size:14px}
h1{font-size:28px;letter-spacing:-.02em;margin:0 0 10px;line-height:1.15}h2{font-size:19px;margin:0 0 10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:22px;margin-bottom:16px}.card.narrow{max-width:460px;margin:40px auto}.center{text-align:center}
.card.attention{border-color:#111;}.head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}@media(max-width:860px){.grid3{grid-template-columns:1fr}}@media(max-width:720px){.grid2{grid-template-columns:1fr}}
.btn{display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 18px;border-radius:999px;background:var(--accent);color:#fff;border:0;font:600 15px inherit;font-family:inherit;text-decoration:none;cursor:pointer}
.btn.small{height:36px;padding:0 14px;font-size:14px}.btn:disabled{opacity:.5}.btn:focus-visible,.link:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #f5b400;outline-offset:2px}
.link{background:none;border:0;padding:0;color:var(--muted);text-decoration:underline;cursor:pointer;font:inherit}
.stack{display:grid;gap:14px;margin-top:12px}.inline{display:inline}
label{display:grid;gap:6px;font-weight:600;font-size:14px}input,select{height:44px;border:1px solid #d4d4d0;border-radius:10px;padding:0 12px;font:16px inherit;font-family:inherit;background:#fff}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:12px 0;border-top:1px solid var(--line);text-decoration:none}.row:first-of-type{border-top:0}
.pill{font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;background:#eee;color:#555}.pill.ready{background:#e6f4ea;color:var(--ok)}.pill.needs_doorbell,.pill.needs_test{background:#fff4d6;color:var(--warn)}
.muted{color:var(--muted)}.small{font-size:13px}.error{color:var(--err);font-weight:600}.dev{background:#fff4d6;padding:8px 12px;border-radius:8px}
.step{color:var(--muted);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin:0 0 6px}
.copy{background:#111;color:#f2f2f2;border-radius:12px;padding:16px;display:grid;gap:12px;margin:12px 0}.copy pre{margin:0;white-space:pre-wrap;word-break:break-word;font:13.5px/1.5 ui-monospace,Menlo,monospace}.copy .btn{background:#f5b400;color:#111;justify-self:start}
.wait{display:flex;align-items:center;gap:10px;font-weight:600}.wait.hidden{display:none}.dot{width:10px;height:10px;border-radius:50%;background:#f5b400;animation:p 1.2s infinite}@keyframes p{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
.howto{padding-left:20px}.howto li{margin:6px 0}.feed{list-style:none;padding:0;margin:0}.feed li{padding:10px 0;border-top:1px solid var(--line)}.feed li:first-child{border-top:0}.msg{color:var(--muted);font-size:14px;margin-top:2px}
.avatar{width:64px;height:64px;border-radius:50%;background:#111;color:#fff;display:grid;place-items:center;font-size:26px;font-weight:700;margin:0 auto 14px}
.hero{max-width:640px;margin:80px auto;text-align:center}.hero h1{font-size:44px}.lead{color:var(--muted);font-size:19px;margin:0 0 24px}
details summary{cursor:pointer;font-weight:600}
.btn.ghost{background:#fff;color:var(--ink);border:1px solid #d4d4d0}.btn.danger{background:var(--err)}.link.danger{color:var(--err)}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
.banner{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;background:#111;color:#fff;border-color:#111}.banner p{margin:0;color:#ccc}.banner .btn{background:#fff;color:#111}
.pill.paused{background:#e8e8ff;color:#3b3b9a}.pill.off{background:#f3f3f3;color:#888}
.more{margin-left:auto;position:relative}.more summary{list-style:none;padding:2px 8px;border-radius:8px;color:var(--muted)}.more summary::-webkit-details-marker{display:none}
.more .menu{position:absolute;right:0;top:28px;background:#fff;border:1px solid var(--line);border-radius:10px;padding:10px 14px;display:grid;gap:8px;z-index:2;box-shadow:0 8px 24px rgba(0,0,0,.08);white-space:nowrap}
.quiet{text-align:center;margin-top:8px}
.thread{list-style:none;margin:14px 0;padding:0;display:grid;gap:10px}.bubble{max-width:78%;padding:10px 14px;border-radius:16px;background:#f1f1ee}.bubble.out{justify-self:end;background:#111;color:#fff}
.bubble .meta{font-size:12px;color:var(--muted);margin-bottom:3px}.bubble.out .meta{color:#aaa}.bubble .text{white-space:pre-wrap;word-break:break-word}
.bubble .ext{display:block;margin-top:6px;font-size:14px;word-break:break-all}.choices{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.chip{height:38px;padding:0 16px;border-radius:999px;border:1px solid #111;background:#fff;font:600 15px inherit;font-family:inherit;cursor:pointer}.chip:hover{background:#111;color:#fff}.chip:focus-visible{outline:3px solid #f5b400;outline-offset:2px}
.answered{margin-top:8px;font-size:14px}.compose{display:grid;gap:10px;margin-top:8px;border-top:1px solid var(--line);padding-top:14px}
textarea{border:1px solid #d4d4d0;border-radius:10px;padding:10px 12px;font:16px/1.4 inherit;font-family:inherit;resize:vertical}textarea:focus-visible{outline:3px solid #f5b400;outline-offset:2px}
.compose .btn{justify-self:start}.extra summary{font-weight:500;color:var(--muted);font-size:14px}.extra[open]{display:grid;gap:10px}
.price{font-size:34px;font-weight:700;letter-spacing:-.02em;margin:4px 0 8px}.ticks{padding-left:18px;margin:0 0 18px}.ticks li{margin:4px 0}.tiers{max-width:1000px;margin:0 auto}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.check{display:flex;gap:10px;align-items:center;font-weight:600}.check input{height:auto;width:18px;height:18px}
.ways{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:14px 0}.way{border:1px solid var(--line);border-radius:12px;padding:16px;display:grid;gap:8px;align-content:start}.way h2{margin:4px 0 0}.way .pill{justify-self:start}@media(max-width:720px){.ways{grid-template-columns:1fr}}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin:14px 0 10px}.tile{display:grid;gap:2px;padding:14px;border:1px solid var(--line);border-radius:12px;background:#fafaf8;text-decoration:none}.tile b{font-size:18px}.tile__t{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}a.tile:hover{border-color:#bbb}
.checklist{list-style:none;padding:0;margin:6px 0 16px;display:grid;gap:8px}.checklist li{display:flex;gap:10px;align-items:center;color:var(--muted)}.checklist li.done{color:var(--ink)}.checklist li.next{color:var(--ink);font-weight:700}.tick{width:22px;height:22px;border-radius:50%;border:1.5px solid #ccc;display:grid;place-items:center;font-size:13px}.done .tick{background:var(--ok);border-color:var(--ok);color:#fff}
.asks{flex-basis:100%;display:grid;gap:4px}.pick{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:6px 0 14px}.pick label{min-width:180px}.topic{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 9px;border-radius:999px;background:#eef1fb;color:#2747c9;font-weight:600;font-size:12px;margin:2px 2px 0 0}.topic .x{border:0;background:none;color:#2747c9;cursor:pointer;font-size:14px;line-height:1;padding:0 4px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.okmsg{color:var(--ok);font-weight:600}.sim{max-width:920px;width:calc(100% - 40px);margin:0 auto 8px;padding:8px 14px;border-radius:10px;background:#ffe9a8;color:#5a4300;font-weight:700;font-size:14px;text-align:center}.danger-zone summary{color:var(--err)}
`;
