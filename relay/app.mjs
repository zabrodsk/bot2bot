// The human side of b2b: accounts (email code login), a dashboard, self-serve bot setup,
// doorbell setup with a live test, and invite links. Server-rendered HTML, zero dependencies.
import { consentMarkup, replayPage, ANALYTICS_CSP } from './analytics.mjs';
import { webhookKey, AGENTS } from './doorbells.mjs';
import { ASSISTANT, platformForApp } from './platforms.mjs';
import { CONNECTOR_DOORBELL, ENCRYPTION_MESSAGE, safeText, isDotApp, wakeOnly, isSender, senderLabel, SENDER } from './connector.mjs';
import { nextQuestion, QUESTION_BY_ID } from './feedback-questions.mjs';
import { loginEmail, DOORBELL_VIDEO } from './email.mjs';
import { t as translator, langFromHeader, normLang } from './i18n.mjs';
import { setupPrompts } from './setup-prompts.mjs';
import { messageState } from './message-state.mjs';
import { pageRequest, isHeadPage } from './page-request.mjs';
import { isBig, bigParts, filesArt } from './bigupdate.mjs';
import { randomBytes } from 'node:crypto';
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
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), rating INTEGER, text TEXT NOT NULL DEFAULT '',
      via TEXT, lang TEXT, created_at INTEGER NOT NULL
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
  // Dashboard invites keep their code until used, so the overview can list them and open them again.
  addColumn('invites', 'plain_code', 'TEXT');
  addColumn('invites', 'created_at', 'INTEGER');
  addColumn('invites', 'saved_at', 'INTEGER');
  addColumn('bots', 'paused_at', 'INTEGER');
  addColumn('bots', 'disconnected_at', 'INTEGER');
  addColumn('messages', 'body_purged_at', 'INTEGER');
  // Web inbox (0.7): people without a bot get a "web" bot row, so contacts and delivery work the same.
  addColumn('bots', 'vendor', "TEXT NOT NULL DEFAULT 'grokbot'");
  addColumn('messages', 'choices', 'TEXT');
  addColumn('messages', 'via', "TEXT NOT NULL DEFAULT 'bot'");
  addColumn('users', 'last_notified_at', 'INTEGER');
  addColumn('users', 'nudged_at', 'INTEGER'); // the last reminder email: the doorbell one or the hosted gift one (L.nudgeGapMs)
  // Quiet hours (0.8): on by default, 22:00 to 08:00 in the person's own timezone.
  addColumn('users', 'tz', 'TEXT');
  addColumn('users', 'infinite_at', 'INTEGER');
  // A plan name and a line for one person, set by the operator for fun. Only words: the limits stay the free plan's.
  addColumn('users', 'tier_name', 'TEXT');
  addColumn('users', 'tier_note', 'TEXT');
  addColumn('users', 'tier_theme', 'TEXT'); // a look for their Plan card: 'golf'
  addColumn('users', 'name_set_at', 'INTEGER');
  addColumn('users', 'seen_update', 'TEXT');
  // The newest update one of their bots told them about, and when (server.mjs newsFor).
  addColumn('users', 'bot_news', 'TEXT');
  addColumn('users', 'bot_news_at', 'INTEGER');
  addColumn('users', 'lang', 'TEXT');
  addColumn('users', 'theme', 'TEXT');
  addColumn('users', 'feedback_asked_at', 'INTEGER');
  addColumn('users', 'feedback_questions', 'TEXT'); // JSON list of the feature questions already asked
  addColumn('feedback', 'question', 'TEXT');
  addColumn('feedback', 'answer', 'INTEGER');
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
  `);
  // Audit fixes (0.9.1): login links work only in the browser that asked; per-IP mail limits.
  addColumn('login_codes', 'browser_hash', 'TEXT');
  addColumn('login_codes', 'ip_hash', 'TEXT');
  addColumn('login_codes', 'next', 'TEXT');
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
// A string for inline client scripts, in single quotes like the rest of them.
const jsq = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\x3c')}'`;

export function createApp(ctx) {
  const { originFor = () => publicUrl || '', analyticsKey = '', reviewLogin = null, status = null, founder = () => null, connectFounder = null, linkOwnBots = () => 0, events = null, groups = null, latestUpdate = null, board = null, feedbackTo = '', markActive = () => {}, usage = null, hostedAdmin = null, payments = null, files = null, invites = null, hostedInvites = null, adminEmails = [], renameBot = () => { throw new HttpError(501, 'Renaming is not available here.'); }, toolInfo = () => ({ latest: null, min: null }), channelFor = () => 'stable', toolTooOld = () => false, privateDoorbell, inPilot = () => false, effectiveMode, governance, getSettings, getRequest, openRequests, applyOwnerOps, decideRequest, decideProposal, stickersDir, setPrivacyInTx, bumpGen, bumpPair, setKeys, setupBotUrl = 'https://x.ai/bot/d_op9BSVjlxk2eYrCmAVL', inviteMessage = (l) => l, webInbox = false, site = false, q, tx, log, clock, publicUrl, sha, token, humanCode, HttpError, validWebhook, doorbellTarget = (u) => ({ url: validWebhook(u), kind: 'grok_webhook' }), watching = () => false, sealKey, routes, L, mailer, devLogin, name, release, iso, banner, quietUntil, hosted, B, coverage, allowance, fetchImpl, erase, dropBetween, trustProxy } = ctx;
  const product = name || 'bot2bot';
  const origin = publicUrl || '';

  // ───── sessions ─────
  const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(/;\s*/).filter(Boolean).flatMap((c) => { const i = c.indexOf('='); if (i < 1) return []; try { return [[c.slice(0, i), decodeURIComponent(c.slice(i + 1))]]; } catch { return []; } }));
  const currentUser = (req) => {
    const t = cookies(req).b2b_session;
    if (!t) return null;
    const s = q('SELECT * FROM sessions WHERE token_hash = ?').get(sha(t));
    if (!s || s.expires_at < clock()) return null;
    return q('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
  };
  const secure = origin.startsWith('https://');
  // b2b_in is a readable, non-secret marker that lives and dies with the session, so the static
  // site can say "Platform" instead of "Sign in" without asking the server.
  const sessionCookie = (raw, maxAge) => [`b2b_session=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`, `b2b_in=${raw ? 1 : ''}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`];
  // Language: a signed-in person's own choice (none means English); signed out, the language they picked here
  // (the lang cookie), else their browser's first choice.
  const T = (user) => translator(user?.lang);
  const reqLang = (req) => { const c = cookies(req).lang; return c === 'cs' || c === 'en' ? c : langFromHeader(req.headers['accept-language']); };
  const langCookie = (lang) => `lang=${normLang(lang)}; Path=/; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`;
  function startSession(res, userId) {
    const raw = token('s_', 24);
    q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha(raw), userId, clock(), clock() + SESSION_MS);
    res.setHeader('set-cookie', sessionCookie(raw, SESSION_MS / 1000));
  }

  // ───── rendering ─────
  // Signed-in pages: a sidebar (places, your bots, you) beside a full-width page with one header.
  // On phones the sidebar folds into a top bar and the places move to a bar at the bottom.
  // Signed-out pages: the brand on top and one centred column.
  // Appearance: no choice follows the device; Light or Dark (picked in Account) pins it.
  const THEME_COLOR = { light: '#f3f5f8', dark: '#0e131b' };
  const head = (title, tr, theme = null) => `<!doctype html><html lang="${tr.lang}"${THEME_COLOR[theme] ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><script>addEventListener('pagereveal',(e)=>{if(e.viewTransition)document.documentElement.classList.add('vt');});</script>
${THEME_COLOR[theme] ? `<meta name="theme-color" content="${THEME_COLOR[theme]}">` : Object.entries(THEME_COLOR).map(([k, c]) => `<meta name="theme-color" content="${c}" media="(prefers-color-scheme: ${k})">`).join('')}
<title>${esc(title)} · ${esc(product)}</title><meta name="robots" content="noindex"><style>${site ? FONTS : ''}${CSS}</style></head>`;
  const brand = (href) => `<a class="brand" href="${href}">${ICON.bot}<span>${esc(product)}</span></a>`;
  const sim = banner ? `<div class="sim" role="note">${esc(banner)}</div>` : '';
  // Signed out, the other language is one tap away at the top; it is remembered in the lang cookie.
  const langSwitch = (tr) => { const to = tr.lang === 'cs' ? 'en' : 'cs'; return `<a class="langswitch" href="/lang/${to}" hreflang="${to}" lang="${to}">${to === 'cs' ? 'Čeština' : 'English'}</a>`; };
  const layout = (title, body, { user, tr = user ? T(user) : translator('en'), bar = {}, tab = '', width = 'full', outWidth = 'narrow', actions = '' } = {}) => {
    if (!user) return `${head(title, tr)}<body class="out"><header class="topbar">${brand('/')}${langSwitch(tr)}</header>${sim}<main class="col col--${outWidth}">${body}</main>${site ? legal(tr) : ''}<script>${uiJs(tr)}</script></body></html>`;
    const hasWeb = !!q("SELECT 1 FROM bots WHERE user_id = ? AND vendor = 'web' AND disconnected_at IS NULL").get(user.id);
    const place = (key, href, label) => `<a class="tabs__item" href="${href}"${tab === key ? ' aria-current="page"' : ''}>${label}</a>`;
    const gov = govBots(user).length > 0;
    const waiting = gov ? pendingFor(user) : 0;
    const nav = `<nav class="tabs" aria-label="${tr('Main')}"><span class="tabs__sel" aria-hidden="true"></span>${place('home', '/app', tr('Overview'))}${gov ? place('people', '/app/people', tr('People')) : ''}${place('activity', '/app/activity', tr('Activity'))}${hasWeb ? place('inbox', '/app/inbox', tr('Inbox')) : ''}${place('account', '/app/account', tr('Settings'))}${hosted ? place('plan', '/app/billing', tr('Plan')) : ''}</nav>`;
    const planState_ = hosted ? allowance(user).state : '';
    const planName = hosted ? { paid: tr('Paid'), covered: tr('Covered'), infinite: 'Infinite' }[planState_] || (user.tier_name ? esc(user.tier_name) : tr('Free')) : '';
    const planLook = planState_ === 'infinite' ? ' umenu__plan--infinite' : planState_ === 'free' && user.tier_name && user.tier_theme === 'golf' ? ' umenu__plan--golf' : '';
    const face = avatar(user.name || user.email, 'md', photoUrl(user.id, user.photo_at, user.avatar));
    const me = `<details class="more umenu"><summary class="umenu__trigger" aria-label="${tr('Your account')}">${face}</summary>
<div class="umenu__panel"><div class="umenu__head">${face}<div class="umenu__id"><span class="umenu__row"><span class="umenu__fullname">${esc(user.name)}</span>${planName ? `<span class="umenu__plan${planLook}">${planState_ === 'infinite' ? '<span class="inf" aria-hidden="true">∞</span>' : ''}${planName}</span>` : ''}</span><span class="umenu__email">${esc(user.email)}</span></div></div>
<div class="umenu__sep"></div><a class="umenu__item" href="/app/account">${ICON.person}${tr('Settings')}</a>${boardPages ? `<a class="umenu__item" href="/feedback">${ICON.bulb}${tr('Ideas and bugs')}</a>` : ''}<a class="umenu__item" href="/app/feedback">${ICON.chat}${tr('Send feedback')}</a>${admin ? admin.menuLink(user) : ''}${promo ? promo.menuLink(tr) : ''}${hosted ? `<a class="umenu__item" href="/app/billing">${ICON.card}${tr('Plan')}</a>` : ''}
<div class="umenu__sep"></div><form method="post" action="/logout"><button class="umenu__item">${ICON.logout}${tr('Log out')}</button></form></div></details>`;
    const back = bar.back ? `<a class="crumb" href="${esc(bar.back)}">${ICON.back}${esc(bar.backLabel || tr('Overview'))}</a>` : '';
    const ownH1 = /<h1[\s>]/.test(body);
    const pagehead = ownH1 ? (back ? `<header class="pagehead">${back}</header>` : '') : `<header class="pagehead"><div class="pagehead__text">${back}${bar.rename ? nameEdit(bar.title, bar.rename, tr) : `<h1>${esc(bar.title ?? title)}</h1>`}${bar.sub ? `<p class="pagehead__sub">${esc(bar.sub)}</p>` : ''}</div>${actions ? `<div class="pagehead__actions">${actions}</div>` : ''}</header>`;
    const note = takeNotice(user);
    // One dialog at most: what's new first, then (on the Overview, once a bot is connected) inviting friends, then feedback.
    // Never while a bot's doorbell is still being set up: that page has the owner's attention.
    const gift = !isHeadPage() && !news0(user) && tab === 'home' && promo && hasPicture(user) && liveBots(user).length && !liveBots(user).some((b) => settingUp(b, tr)) ? promo.splash(user, tr) : '';
    const news = news0(user) ? whatsNewDialog(tr) : gift || (!isHeadPage() && tab === 'home' && feedbackDue(user) ? feedbackDialog(user, tr) : '');
    return `${head(title, tr, user.theme)}<body class="in"><header class="top"><div class="top__in">${brand('/app')}${nav}${me}</div></header>
<main class="page">${sim}<div class="col col--${width}">${pagehead}${body}${bar.bot ? connectionMarker(myBots(user).find((b) => b.id === bar.bot), tr) : ''}</div>${site ? legal(tr) : ''}</main>${note ? toast(note, tr) : ''}${news}<script>${uiJs(tr)}</script></body></html>`;
  };
  const news0 = (user) => latestUpdate && user.seen_update !== latestUpdate.iso && hasPicture(user);
  // Arc dialog: what changed since their last visit, once. One change is one line; more are a short list.
  // Got it, Escape or a click outside closes it and remembers it was seen.
  const whatsNewDialog = (tr) => {
    const items = latestUpdate.items.map((i) => (typeof i === 'string' ? i : (tr.lang === 'cs' && i.cs) || i.en));
    const body = items.length === 1 ? `<p class="dlg__one">${esc(items[0])}</p>` : `<ul class="dlg__list">${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
    // A big update: its own title, the robots passing a message, and its points.
    const big = isBig(latestUpdate.items[0]) ? bigParts(latestUpdate.items[0], tr.lang) : null;
    return `<dialog class="dlg${big ? ' dlg--big' : ''}" id="whatsnew" aria-labelledby="wn-h"><form method="post" action="/app/whatsnew" class="dlg__in"><input type="hidden" name="id" value="${esc(latestUpdate.iso)}">
${big ? `${big.art}<h2 id="wn-h" class="dlg__title bigup__title">${big.title}</h2><p class="bigup__lead">${big.lead}</p>${big.points}` : `<h2 id="wn-h" class="dlg__title">${tr('What&#39;s new')}</h2>${body}`}
<div class="dlg__foot"><a class="link" href="/changelog/">${tr('See all changes')}</a><button class="btn" autofocus>${tr('Got it')}</button></div></form></dialog>
<script>(()=>{const d=document.getElementById('whatsnew');if(!d||!d.showModal)return;const f=d.querySelector('form');let done=false;
const seen=()=>{if(done)return;done=true;fetch('/app/whatsnew',{method:'POST',body:new URLSearchParams(new FormData(f)),keepalive:true}).catch(()=>{});};
f.addEventListener('submit',(e)=>{e.preventDefault();seen();d.close();});d.addEventListener('close',seen);
d.addEventListener('click',(e)=>{if(e.target===d)d.close();});d.showModal();})();</script>`;
  };
  // ───── service dashboard (hosted only) ─────
  // The operator's dashboard lives in hosted-admin.mjs, which the open-source relay doesn't include.
  const admin = hostedAdmin && usage ? hostedAdmin.createAdmin({ q, clock, layout, toolInfo, usage, adminEmails, icon: ICON.overview }) : null;
  // Feedback. The form is always one click away (account menu); the popup asks once someone has really used
  // bot2bot: an account at least 3 days old with a friend connected, and never more than once in 60 days.
  const FEEDBACK_AFTER_MS = 3 * 86_400_000, FEEDBACK_EVERY_MS = 60 * 86_400_000;
  const feedbackDue = (user) => !!user && hasPicture(user) && clock() - user.created_at >= FEEDBACK_AFTER_MS
    && clock() - (user.feedback_asked_at || 0) >= FEEDBACK_EVERY_MS
    && !!q('SELECT 1 FROM contacts c JOIN bots b ON b.id = c.owner_bot WHERE b.user_id = ? AND c.approved_at IS NOT NULL LIMIT 1').get(user.id);
  // What this person uses, for picking a question about something they know.
  const feedbackContext = (user) => {
    const ids = myBots(user).map((b) => b.id), ph = ids.map(() => '?').join(',') || 'NULL';
    const n = (sql, ...a) => q(sql).get(...a).n;
    return {
      bots: ids.length, lang: user.lang === 'cs' ? 'cs' : 'en', quiet: !!(user.quiet_on && user.tz), sawUpdate: !!user.seen_update,
      freePlan: hosted && allowance(user).state === 'free',
      doorbell: !!n(`SELECT count(*) AS n FROM bots WHERE id IN (${ph}) AND doorbell_verified_at IS NOT NULL`, ...ids),
      contacts: n(`SELECT count(*) AS n FROM contacts WHERE owner_bot IN (${ph}) AND approved_at IS NOT NULL`, ...ids),
      sorted: n(`SELECT count(*) AS n FROM contacts WHERE owner_bot IN (${ph}) AND circle_id IS NOT NULL`, ...ids),
      received: n(`SELECT count(*) AS n FROM messages WHERE to_bot IN (${ph}) AND kind NOT IN ('probe', 'group_event')`, ...ids),
      invited: n(`SELECT count(*) AS n FROM invites WHERE from_bot IN (${ph})`, ...ids),
      asked: n(`SELECT count(*) AS n FROM contacts WHERE owner_bot IN (${ph}) AND mode_override = 'asks'`, ...ids),
    };
  };
  const askedQuestions = (user) => { try { return JSON.parse(user.feedback_questions || '[]'); } catch { return []; } };
  const questionFor = (user) => nextQuestion(feedbackContext(user), askedQuestions(user), user.id);
  const markAsked = (user, id) => { const was = askedQuestions(user); if (id && !was.includes(id)) { user.feedback_questions = JSON.stringify([...was, id]); q('UPDATE users SET feedback_questions = ? WHERE id = ?').run(user.feedback_questions, user.id); } };
  // A small mark pops up from the option you pick: a pink heart, a smile, a little cloud.
  const RATE_MARK = {
    3: '<svg class="rate__mark rate__mark--love" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.7 4.5c2 0 3.6 1.1 5.3 3.1 1.7-2 3.3-3.1 5.3-3.1 3.7 0 5.8 3.8 4.3 7.2C19.5 16.4 12 21 12 21Z"/></svg>',
    2: '<svg class="rate__mark rate__mark--okay" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><circle class="rate__eye" cx="8.6" cy="10" r="1.3"/><circle class="rate__eye" cx="15.4" cy="10" r="1.3"/><path class="rate__mouth" d="M8.2 14.6c2.3 1.8 5.3 1.8 7.6 0"/></svg>',
    1: '<svg class="rate__mark rate__mark--meh" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18.5h10.2a4.3 4.3 0 0 0 .6-8.6A6 6 0 0 0 6.3 11 3.8 3.8 0 0 0 7 18.5Z"/></svg>',
  };
  const choice = (name, opts, picked) => `<div class="rate__opts">${opts.map(([v, l]) => `<label class="rate__opt"><input type="radio" name="${name}" value="${v}"${String(picked) === String(v) ? ' checked' : ''}><span>${name === 'rating' ? RATE_MARK[v] : ''}${l}</span></label>`).join('')}</div>`;
  // One general question, then one about a single part of bot2bot they use, then room for anything else.
  const feedbackFields = (tr, { rating = '', text = '', question = null } = {}) => `<fieldset class="rate"><legend class="rate__legend">${tr('How is bot2bot working for you?')}</legend>
${choice('rating', [[3, tr('Love it')], [2, tr('It&#39;s okay')], [1, tr('Not great')]], rating)}</fieldset>
${question ? `<fieldset class="rate"><input type="hidden" name="question" value="${esc(question.id)}"><legend class="rate__legend">${esc(tr.lang === 'cs' ? question.cs : question.en)}</legend>
${choice('answer', [[3, tr('Yes')], [2, tr('Mostly')], [1, tr('No')]], '')}</fieldset>` : ''}
<label class="field">${tr('What would make it better?')}<textarea name="text" maxlength="2000" rows="4" placeholder="${tr('Anything at all. We read every message.')}">${esc(text)}</textarea></label>`;
  // Arc dialog, asked once (it counts as asked when it shows). Send stores it; Not now just closes.
  const feedbackDialog = (user, tr) => {
    q('UPDATE users SET feedback_asked_at = ? WHERE id = ?').run(clock(), user.id);
    const question = questionFor(user);
    markAsked(user, question?.id);
    return `<dialog class="dlg" id="feedback" aria-labelledby="fb-h"><form method="post" action="/app/feedback" class="dlg__in"><input type="hidden" name="via" value="popup">
<h2 id="fb-h" class="dlg__title">${tr('Got a minute?')}</h2>${feedbackFields(tr, { question })}
<div class="dlg__foot"><button type="button" class="btn ghost" data-close>${tr('Not now')}</button><button class="btn">${tr('Send')}</button></div></form></dialog>
<script>(()=>{const d=document.getElementById('feedback');if(!d||!d.showModal)return;d.querySelector('[data-close]').addEventListener('click',()=>d.close());
d.addEventListener('click',(e)=>{if(e.target===d)d.close();});setTimeout(()=>d.showModal(),1200);})();</script>`;
  };
  // Artwork made for bot2bot (isometric scenes). Only shown when the file is there.
  const art = (name, cls = '') => ART.has(name) ? `<div class="art ${cls}"><img src="/art/${name}.jpg" alt="" width="${name === 'asleep' ? 800 : name === 'home' ? 1536 : 1200}" height="${name === 'asleep' ? 800 : name === 'home' ? 864 : 800}" decoding="async"></div>` : '';
  const setupBot = setupBotUrl;
  // A dead end (an expired link, a missing page) still has a way on.
  const onward = (user, tr) => `<div class="actions"><a class="btn ghost wide" href="${user ? '/app' : '/'}">${user ? tr('Go to overview') : tr('Go to {product}', { product: esc(product) })}</a></div>`;
  // With the landing site on this server, its legal pages are one link away from every dashboard page.
  const legal = (tr) => `<footer class="legal"><a href="/cookies/" class="cookie-settings" data-cookie-settings>${tr('Cookie settings')}</a><a href="/privacy/">${tr('Privacy')}</a><a href="/terms/">${tr('Terms')}</a><a href="/cookies/">${tr('Cookies')}</a><a href="/legal/">${tr('Legal notice')}</a><a href="/changelog/">${tr('What&#39;s new')}</a>${boardPages ? `<a href="/feedback">${tr('Ideas and bugs')}</a>` : ''}${status ? `<a href="/status">${tr('Status')}</a>` : ''}<a href="/app/feedback">${tr('Send feedback')}</a></footer>`;
  const page = (res, status, html, headers = {}) => {
    if (site && analyticsKey && replayPage(new URL(res.req.url, 'http://localhost').pathname) && html.includes('class="in"')) {
      html = html.replace('</body>', () => consentMarkup(translator(html.includes('<html lang="cs"') ? 'cs' : 'en'), analyticsKey) + '</body>');
      headers['content-security-policy'] = ANALYTICS_CSP;
    }
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin', ...headers }); res.end(html); };
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
  const takeNotice = (user) => { const n = notices.get(user.id); if (!isHeadPage()) notices.delete(user.id); return n && clock() - n.at < 120_000 ? n : null; };
  // An undo is the same form posted back with the earlier values; undo=1 keeps an undo from offering another.
  const undoForm = (action, fields, label = '') => ({ action, fields, label });
  const toast = (n, tr) => {
    const hidden = (o) => Object.entries(o).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v ?? '')}">`).join('');
    const undo = n.undo ? `<form method="post" action="${esc(n.undo.action)}">${hidden({ ...n.undo.fields, undo: '1' })}<button class="toast__undo">${esc(n.undo.label || tr('Undo'))}</button></form>` : '';
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
    try { const u = new URL(o); return origin ? u.origin === new URL(originFor(req)).origin : u.host === req.headers.host; } catch { return false; }
  }

  // ───── login ─────
  const clientIp = (req) => (trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket?.remoteAddress || '';
  async function sendLogin(email, req, res, next = '') {
    const hour = clock() - 3_600_000;
    const ipHash = sha(`ip:${clientIp(req)}`);
    const nonce = token('n_', 18);
    const cookie = `b2b_login=${nonce}; Path=/login; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
    // The same request again within seconds (a double tap, Enter and a click) is the same sign-in: no second email,
    // so the code in the first one still works. The link moves to this browser, which got the page.
    const dup = q('SELECT id FROM login_codes WHERE email = ? AND ip_hash = ? AND used_at IS NULL AND attempts = 0 AND created_at > ? ORDER BY created_at DESC').get(email, ipHash, clock() - 30_000);
    if (dup) {
      res.setHeader('set-cookie', cookie);
      q('UPDATE login_codes SET browser_hash = ?, next = ? WHERE id = ?').run(sha(nonce), String(next || '').slice(0, 500), dup.id);
      return null;
    }
    if (q('SELECT count(*) AS n FROM login_codes WHERE created_at > ?').get(hour).n >= L.loginEmailsPerHour) throw new HttpError(429, 'Too many sign-ins right now. Try again in a few minutes.');
    if (q('SELECT count(*) AS n FROM login_codes WHERE ip_hash = ? AND created_at > ?').get(ipHash, hour).n >= L.loginEmailsPerIpPerHour) throw new HttpError(429, 'Too many login emails from here. Try again in an hour.');
    const recent = q('SELECT count(*) AS n FROM login_codes WHERE email = ? AND created_at > ?').get(email, hour).n;
    if (recent >= 5) throw new HttpError(429, 'Too many login emails. Try again in an hour.');
    const code = String(100000 + (randomBytes(4).readUInt32BE(0) % 900000));
    const link = token('l_', 24);
    // The link only works in this browser (a cookie nonce), so nobody can send you a link to their account.
    res.setHeader('set-cookie', cookie);
    q('INSERT INTO login_codes (email, code_hash, link_hash, created_at, expires_at, browser_hash, ip_hash, next) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(email, sha(code), sha(link), clock(), clock() + LOGIN_TTL_MS, sha(nonce), ipHash, String(next || '').slice(0, 500));
    // The link opens where sign-in started: its cookie lives on that address (bot2bot.link or the old www host).
    const url = `${originFor(req)}/login/link?t=${link}`;
    // In the language they chose for their account, else the language of the page they asked from.
    const known = q('SELECT lang FROM users WHERE email = ?').get(email);
    const lang = known?.lang ? normLang(known.lang) : reqLang(req);
    await mailer({ to: email, ...loginEmail({ product, code, url, minutes: LOGIN_TTL_MS / 60_000, home: origin, logo: site ? `${origin}/icon-192.png` : '', lang }) });
    return devLogin ? code : null;
  }
  function finishLogin(req, res, email, next, tz, lang) {
    let user = q('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      const nm = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 40);
      // New people start with nothing to catch up on: the "What's new" note is for those who were here before.
      // Their language is the one they signed up in (English is stored as none).
      q('INSERT INTO users (email, name, created_at, email_verified_at, seen_update, lang) VALUES (?, ?, ?, ?, ?, ?)').run(email, nm, clock(), clock(), latestUpdate?.iso ?? null, lang === 'cs' ? 'cs' : null);
      user = q('SELECT * FROM users WHERE email = ?').get(email);
      usage?.captureAcquisition(user.id, req);
      log(null, 'user_created', { user: user.id });
      usage?.noteCountry(user.id, req, { signup: true }); // the country only (hosted), never the address
    }
    if (!user.tz && tz && validTz(tz)) q('UPDATE users SET tz = ? WHERE id = ?').run(tz, user.id);
    startSession(res, user.id);
    return redirect(res, safeNext(next));
  }

  // ───── data helpers ─────
  // Removed bots are gone from the dashboard; export and account deletion still see them until they leave for good.
  const myBots = (u, { all = false } = {}) => q(`SELECT * FROM bots WHERE user_id = ?${all ? '' : ' AND removed_at IS NULL'} ORDER BY created_at`).all(u.id);
  const ownBot = (u, id, { removed = false } = {}) => { const b = q('SELECT * FROM bots WHERE id = ?').get(Number(id)); if (!b || b.user_id !== u.id || (!!b.removed_at !== removed)) throw new HttpError(404, 'Bot not found'); return b; };
  const pendingCode = (u) => q('SELECT * FROM enroll_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY expires_at DESC').get(u.id, clock());
  const setupMessage = (code) => `Help me set you up on ${product}. ${prompts.helping}
Read the guide with: curl -fsSL ${origin}/setup
Then install the tool and join with code ${code}. Add the "b2b messaging" skill from ${origin}/skill. Make a routine called "b2b doorbell" with a webhook trigger, using the instruction from the guide.
${prompts.helpAfter()}
Don't print any keys or tokens in this chat.`;
  // Another assistant (joined with --agent other) usually can't be woken from outside: it sees messages when its
  // owner talks to it, so there's no doorbell step for it. If it can take webhooks, it sets one with "b2b doorbell set".
  // An assistant we know by name (Poke, Instinct…) or another app on quick connect sets its own doorbell from its tool:
  // an email to its own address, its inbound API, or a recurring check. Until it does, it sees messages when you talk to it.
  const noDoorbell = (b) => (b.platform === 'other' || b.platform === 't3code' || !!ASSISTANT[b.platform]) && !b.webhook_url;
  // A connected app that isn't Grok Bot (it signed in under another name) can't be woken at all, so it has no doorbell step.
  const doorbellless = (b) => b.vendor === 'connector' && !b.webhook_url && originOf(b, T({})).key === 'app';
  // Still on its doorbell step: joined, but friends' bots can't wake it yet.
  const settingUp = (b, tr) => b.vendor !== 'web' && ['needs_doorbell', 'needs_test'].includes(botStatus(b, tr).key) && !doorbellless(b);
  // Grok Bot's routines list, on a computer. The owner clicks b2b doorbell there.
  const GROK_ROUTINES = 'https://cursor.com/grok-bot/link/v1/sidebar?tab=routines';
  const botStatus = (b, tr) => b.disconnected_at ? { key: 'off', label: tr('Disconnected') }
    : b.paused_at ? { key: 'paused', label: tr('Paused') }
    : b.vendor === 'web' ? { key: 'ready', label: tr('Web inbox') }
    : isSender(b) ? { key: 'ready', label: tr('Connected') }
    : noDoorbell(b) ? { key: 'ready', label: tr('Connected') }
    : !b.webhook_url ? { key: 'needs_doorbell', label: AGENTS[b.platform] ? tr('Watcher off') : tr('Doorbell off') } : b.doorbell_verified_at ? { key: 'ready', label: tr('Ready') } : { key: 'needs_test', label: tr('Doorbell not tested') };
  const connectionMarker = (b, tr) => b && b.vendor !== 'web' && !b.disconnected_at && !b.paused_at && (botStatus(b, tr).key === 'ready' || doorbellless(b))
    ? `<span hidden data-analytics-connected="${b.id}" data-vendor="${esc(b.vendor)}"></span>` : '';
  // Arc badge tones: success for ready, warning for a step that's missing, info for paused.
  const toneOf = (key) => key === 'ready' ? 'success' : key === 'needs_doorbell' || key === 'needs_test' ? 'warning' : key === 'paused' ? 'info' : 'neutral';
  // Arc input: a labelled single-line field with optional helper copy and an error row (role=alert, aria-invalid).
  let fieldN = 0;
  const field = ({ label, name, value = '', description = '', error = '', attrs = '' }) => {
    const id = `f${++fieldN}`;
    const desc = description ? `<span class="field__desc" id="${id}-d">${description}</span>` : '';
    const err = error ? `<span class="field__error" id="${id}-e" role="alert">${esc(error)}</span>` : '';
    const by = [description && `${id}-d`, error && `${id}-e`].filter(Boolean).join(' ');
    return `<label class="field">${esc(label)}<input name="${name}" value="${esc(value)}"${by ? ` aria-describedby="${by}"` : ''}${error ? ' aria-invalid="true"' : ''} ${attrs}>${desc}${err}</label>`;
  };
  const badge = (label, tone = 'neutral') => `<span class="badge badge--${tone}">${esc(label)}</span>`;
  // Arc avatar: initials on a muted disc.
  // Arc avatar: the initial sits underneath, so a photo that fails to load falls back to it.
  const avatar = (name, size = 'sm', src = '') => `<span class="avatar avatar--${size}${String(src).startsWith('/stickers/') ? ' avatar--cut' : ''}" aria-hidden="true">${esc(String(name || '?').trim().slice(0, 1).toUpperCase())}${src ? `<img src="${esc(src)}" alt="" decoding="async">` : ''}</span>`;
  // A picture is a drawn robot, a die-cut sticker from the set, or the person's own photo.
  const stickers = stickerSet(stickersDir || fileURLToPath(new URL('./public/stickers/', import.meta.url)));
  const isSticker = (pic) => typeof pic === 'string' && pic.startsWith('sticker:') && stickers().has(pic.slice(8));
  const photoUrl = (userId, at, pic) => pic && ROBOT.has(pic) ? `/avatars/${pic}.svg` : isSticker(pic) ? `/stickers/${pic.slice(8)}.png` : userId && at ? `/app/photo/${userId}?v=${at}` : '';
  // A person's name as they write it: one line, up to 40 characters.
  const cleanName = (v) => String(v ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  // Their bots introduce them by this name too (a bot keeps a name its owner gave it on purpose).
  const setName = (u, name) => tx(() => {
    q('UPDATE bots SET display_name = ? WHERE user_id = ? AND display_name = ?').run(name, u.id, u.name);
    q('UPDATE users SET name = ?, name_set_at = ? WHERE id = ?').run(name, clock(), u.id);
    u.name = name;
  });
  // A bot name to suggest: their first name plus -bot (diacritics dropped), with a number if that's taken.
  const suggestHandle = (u) => {
    const slug = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
    const base = `${slug(String(u.name || '').trim().split(/\s+/)[0]) || slug(u.email.split('@')[0]) || 'my'}-bot`;
    for (let n = 1; n < 100; n++) { const h = n === 1 ? base : `${base}-${n}`; if (!q('SELECT 1 FROM bots WHERE handle = ?').get(h)) return h; }
    return base;
  };
  const hasPicture = (u) => !!(u.photo_at && (u.photo || ROBOT.has(u.avatar) || isSticker(u.avatar)));
  // The public feedback board (hosted only): the pages live in hosted-board.mjs. Photos stay private there, so only
  // drawn robots and stickers show; everyone else gets their initial.
  const boardPages = board ? board.pages({ layout, avatar, avatarSrc: (pic) => photoUrl(null, null, pic), form, page, redirect, json, tell, icon: ICON }) : null;
  // Invite links and their bonus (hosted only): the pages live in hosted-invites.mjs.
  const promo = invites && hostedInvites ? hostedInvites.invitePages({ invites, layout, esc, avatar, photoUrl, icon: ICON, stickers: { has: (k) => stickers().has(k) }, clock }) : null;
  // Arc presence dot: shape and colour change together, so a bot's state never rests on colour alone.
  const presence = (key) => `<span class="pdot" data-status="${key === 'ready' ? 'available' : key === 'needs_doorbell' || key === 'needs_test' ? 'away' : 'offline'}" aria-hidden="true"></span>`;
  // Arc code block with a copy button: every message you paste into your bot.
  const codeBlock = (id, title, text, tr, icon = ICON.chat) => `<div class="code"><div class="code__head"><span class="code__title">${icon}${esc(title)}</span><button type="button" class="copybtn" data-copy="#${id}"><span class="copybtn__icon">${ICON.copy}${ICON.check}</span><span class="copybtn__label">${tr('Copy')}</span></button></div><pre class="code__pre" id="${id}">${esc(text)}</pre></div>`;
  // Arc stepper: done, current and next steps on one connected track.
  const stepper = (steps, current, dir, tr) => `<ol class="stepper stepper--${dir}">${steps.map((label, i) => {
    const st = i < current ? 'complete' : i === current ? 'current' : 'upcoming';
    return `<li class="step" data-status="${st}"${st === 'current' ? ' aria-current="step"' : ''}><span class="step__marker">${st === 'current' ? '<span class="step__ring"></span>' : ''}<span class="step__disc">${st === 'complete' ? ICON.check : i + 1}</span></span><span class="step__label">${esc(label)}${st === 'complete' ? `<span class="sr"> (${tr('done')})</span>` : ''}</span>${i < steps.length - 1 ? `<span class="step__conn"><span class="step__fill"${i < current ? ' data-on' : ''}></span></span>` : ''}</li>`;
  }).join('')}</ol>`;
  // Arc confirm morph: the button turns into its own question, so a destructive tap needs a second, deliberate one.
  const confirmMorph = ({ action, fields = '', label, icon = '', prompt, confirm, pending, tone = 'danger', tr }) => `<form method="post" action="${action}" class="cm" data-tone="${tone}" data-state="idle">${fields}<div class="cm__surface">
<div class="cm__face" data-face="idle"><button type="button" class="cm__trigger">${icon}${esc(label)}</button></div>
<div class="cm__face" data-face="ask" role="group" aria-label="${esc(prompt)}" hidden><span class="cm__prompt">${esc(prompt)}</span><button type="button" class="cm__secondary">${tr('Cancel')}</button><button class="cm__confirm">${esc(confirm)}</button></div>
<div class="cm__face" data-face="pending" hidden><span class="cm__status"><span class="cm__spin" aria-hidden="true"></span>${esc(pending)}</span></div></div></form>`;
  // Arc usage meter: how much of the free allowance is used, and how close it is to the limit.
  // The free period in words ("today", "this month"), and how often the allowance comes ("a day", "a month").
  const periodWord = (tr) => (B.freePeriod === 'day' ? tr('today') : tr('this month'));
  const perWord = (tr) => (B.freePeriod === 'day' ? tr('a day') : tr('a month'));
  const usageMeter = (a, { compact = false, tr }) => {
    const used = Math.min(a.used, a.limit), left = Math.max(0, a.left);
    const status = left <= 0 ? 'over' : used / a.limit >= 0.9 ? 'near' : 'ok';
    const label = tr('{left} of {limit} free messages left {period}', { left, limit: a.limit, period: esc(periodWord(tr)) });
    const bar = `<div class="meter__bar" role="img" aria-label="${label}"><div class="meter__track"><div class="meter__fill" style="width:${(used / a.limit * 100).toFixed(1)}%"></div></div></div>`;
    // The compact meter is one line and a thin bar; it only shows a badge when the allowance runs low.
    if (compact) return `<div class="meter meter--compact" role="group" aria-labelledby="meter-t"><div class="meter__top"><span class="meter__title" id="meter-t">${tr('Free messages')}</span>${status === 'ok' ? '' : `<span class="meter__badge" data-status="${status}"><span class="meter__icon">${ICON.alert}</span>${status === 'over' ? tr('Used up') : tr('Almost used up')}</span>`}<span class="meter__caption">${tr('<b>{left}</b> left of {limit} {period}', { left, limit: a.limit, period: esc(periodWord(tr)) })}</span></div>${bar}</div>`;
    return `<div class="meter" role="group" aria-labelledby="meter-t"><div class="meter__top"><span class="meter__title" id="meter-t">${tr('Free messages')}</span><span class="meter__badge" data-status="${status}">${status === 'ok' ? '' : `<span class="meter__icon">${ICON.alert}</span>`}${status === 'over' ? tr('Used up') : status === 'near' ? tr('Almost used up') : tr('{n} sent', { n: used })}</span></div>
<p class="meter__total"><span class="meter__amount">${left}</span><span class="meter__caption">${tr('left of {limit} {period}', { limit: a.limit, period: esc(periodWord(tr)) })}</span></p>
${bar}</div>`;
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
  // Send only (bot2bot.link/send): one sender per chat app and name (the app's own, unless the owner picked one, as
  // with two Gemini accounts). Connecting again with the same name brings the same one back.
  function senderBot(u, label, name = label) {
    const had = q("SELECT * FROM bots WHERE user_id = ? AND vendor = 'connector' AND platform = ? AND chat_app = ? AND display_name = ? AND removed_at IS NULL ORDER BY created_at DESC").get(u.id, SENDER, label, name);
    if (had) { if (had.disconnected_at) q('UPDATE bots SET disconnected_at = NULL WHERE id = ?').run(had.id); return had; }
    const slug = (v) => String(v).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const base = `${slug(u.name || u.email.split('@')[0]).slice(0, 18) || 'my'}-${slug(name).slice(0, 12) || 'chat'}`;
    let handle = base;
    for (let n = 2; q('SELECT 1 FROM bots WHERE handle = ?').get(handle) || q('SELECT 1 FROM enroll_codes WHERE handle = ? AND used_at IS NULL').get(handle); n++) handle = `${base}-${n}`;
    q("INSERT INTO bots (handle, display_name, token_hash, created_at, user_id, vendor, platform, chat_app) VALUES (?, ?, NULL, ?, ?, 'connector', ?, ?)").run(handle, name, clock(), u.id, SENDER, label);
    const b = q('SELECT * FROM bots WHERE handle = ?').get(handle);
    log(b.id, 'sender_created', { app: label });
    return b;
  }
  // Who's signing in, and a way to sign in as someone else (two bot2bot accounts in one chat app, or the wrong one).
  // Who asked and who's signing in sit under the buttons, apart from the decision itself.
  const signedInAs = (user, tr, params, client) => `<div class="card__aside"><p>${tr('Requested by the app "{name}".', { name: esc(client.name) })}</p><form method="post" action="/logout">${tr('Signed in as {email}.', { email: esc(user.email) })} <input type="hidden" name="next" value="${esc(`/oauth/authorize?${new URLSearchParams(params)}`)}"><button class="link">${tr('Use another account')}</button></form></div>`;
  // Yes and no side by side. Yes comes first in the form, so Enter connects.
  const decide = (tr, yes) => `<div class="decide"><button class="btn" name="decision" value="allow">${yes}</button><button class="btn ghost" name="decision" value="deny">${tr('Cancel')}</button></div>`;
  function sendAuthorizePage(user, client, params, name = '') {
    const tr = T(user);
    const app = esc(senderLabel(client.name));
    const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    const none = !liveBots(user).some((b) => b.vendor !== 'web' && !isSender(b));
    return layout(tr('Connect'), `<section class="card">
<h1>${tr('Let {app} send to your bots?', { app })}</h1>
<p>${tr("When you ask, {app} sends briefs, notes and files to your own bots. It can't read your messages, see your account or reach your friends.", { app })}</p>
${name && name !== senderLabel(client.name) ? `<p>${tr('Your bots see it as {name}.', { name: esc(name) })}</p>` : ''}${none ? `<p>${tr('You have no bots yet. Connect one too, so it has somewhere to send.')}</p>` : ''}
<p class="muted small">${tr('Not end-to-end encrypted: {app} hands us text and attachments. Text is deleted 7 days after delivery. Files are deleted once your bot saves them, or after 7 days.', { app })}</p>
<form method="post" action="/oauth/authorize" class="stack">${hidden}
${decide(tr, tr('Connect'))}</form>
${signedInAs(user, tr, params, client)}</section>`, { user, width: 'narrow', bar: { title: tr('Send to your bots') } });
  }
  // Consent for a connected app (OAuth). The app gets one bot of this person's, nothing else.
  function authorizePage(user, client, params, { error = '', send = false, name = '' } = {}) {
    const tr = T(user);
    // A dot in private mode can sign ChatGPT in again, for wake-ups only: its messages stay end-to-end encrypted.
    const dotApp = isDotApp(client);
    const bots = myBots(user).filter((b) => (b.vendor === 'connector' && !isSender(b)) || (dotApp && wakeOnly(b)));
    const hidden = Object.entries(params).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    const suggested = name || suggestHandle(user);
    // A disconnected bot waiting to come back is the likely choice; otherwise a new bot, so nobody hands an
    // existing bot to an app by accident. Apps name themselves (Grok Bot signs in as "Cursor"), so that's small print.
    const back = bots.find((b) => b.disconnected_at);
    return layout(tr('Connect'), `<section class="card">
${error ? `<p class="error" role="alert">${esc(tr.msg(error))}</p>` : ''}
<p>${tr('Your bot can message the people you connect with.')} ${tr("It can't see your account or anyone else's bots.")}</p>
<p class="muted small">${tr('Not end-to-end encrypted: we pass the text on and delete it 7 days after delivery. Want end-to-end encryption? Set your bot up in private mode instead.')}</p>
<form method="post" action="/oauth/authorize" class="stack">${hidden}
<label>${tr('Which bot')}<select name="bot" id="pick"><option value="new"${back || send ? '' : ' selected'}>${tr('A new bot')}</option>${bots.map((b) => `<option value="${b.id}"${b === back && !send ? ' selected' : ''}>@${esc(b.handle)}${b.disconnected_at ? ` (${tr('reconnect')})` : wakeOnly(b) ? ` (${tr('wake-ups only, stays end-to-end encrypted')})` : ''}</option>`).join('')}<option value="send"${send ? ' selected' : ''}>${tr('Send only: it hands things to my bots')}</option></select></label>
<label id="newname"${back || send ? ' hidden' : ''}>${tr('Name for the new bot')}<input name="handle" pattern="[a-z0-9][a-z0-9_-]{1,31}" value="${esc(suggested)}"></label>
${decide(tr, tr('Connect'))}</form>
${signedInAs(user, tr, params, client)}</section>
<script>const p=document.getElementById('pick'),n=document.getElementById('newname');p.addEventListener('change',()=>{n.hidden=p.value!=='new';});</script>`, { user, width: 'narrow', bar: { title: tr('Connect your bot to {product}', { product }) } });
  }
  // What people paste into their assistant (setup-prompts.mjs, shared with the website).
  const prompts = setupPrompts({ origin, product });
  const agentTool = prompts.agentTool;
  const WATCH_INSTALL = `Update the bot2bot tool: ${agentTool}
Then run: node ~/bin/b2b.mjs watch --install and do what it says. Don't print any keys or tokens.`;
  // A setup choice's heading: the assistants' marks, then its name.
  const diyName = (marks, label) => `<span class="diy__name">${marks.length ? `<span class="diy__marks">${marks.join('')}</span>` : ''}${label}</span>`;
  // Hermes Agent, Claude Code, Codex and Cursor, each on its own: on a computer that stays on, with the watcher that wakes it.
  const agentWay = (tr, after = '', ids = ['ahm', 'acc', 'acx', 'acu']) => [
    ['ahm', MARK.hermes, 'Hermes Agent', prompts.hermes(after)],
    ['acc', MARK.claude, 'Claude Code', prompts.agent('claude-code', after)],
    ['acx', MARK.codex, 'Codex', prompts.agent('codex', after)],
    ['acu', MARK.cursor, 'Cursor', prompts.agent('cursor', after)],
  ].filter(([id]) => ids.includes(id)).map(([id, mark, agent, text]) => `<details class="diy"><summary>${diyName([mark], id === 'ahm' || id === 'acu' ? `${agent} ${badge(tr('Beta'), 'info')}` : agent)}</summary>
<p class="muted" style="margin-top:10px">${tr('On a computer that stays on, paste this into {agent}. It installs a small tool, gives you a link to approve it and starts a watcher that wakes it when a message comes in. Only the bots can read your messages.', { agent })}</p>
${codeBlock(id, tr('Message for {agent}', { agent }), text, tr, mark)}</details>`).join('\n');
  // Every assistant but Grok Bot, in the order the site lists them: dots, OpenClaw, Hermes Agent, Instinct, the coding
  // agents on a computer that stays on, then other bots (in beta) that add bot2bot as an app, or paste one message if they run commands.
  const otherWays = (tr, { after = '', invite = null } = {}) => `<details class="diy"><summary>${diyName([MARK.dots], 'OpenAI dots')}</summary>
<p class="muted" style="margin-top:10px">${tr('Connect bot2bot in your own ChatGPT account, then check it in your chat. Your dot then turns on end-to-end encryption on its own computer. If it can’t, it stays on Quick connect, which isn’t end-to-end encrypted.')}</p>
<a class="btn wide" href="/connect/chatgpt${invite ? `?invite=${encodeURIComponent(invite.split('/').at(-1))}` : ''}">${tr('Connect dots')}</a></details>
<details class="diy"><summary>${diyName([MARK.openclaw], 'OpenClaw')}</summary>
<p class="muted" style="margin-top:10px">${tr('Paste this into OpenClaw. It installs a small tool and the skill, gives you a link to approve it and sets up its doorbell. Only the bots can read your messages.')}</p>
${codeBlock('om', tr('Message for OpenClaw'), prompts.openclaw(after), tr, MARK.openclaw)}</details>
${agentWay(tr, after, ['ahm'])}
<details class="diy"><summary>${diyName([MARK.instinct], 'Instinct')}</summary>
<p class="muted" style="margin-top:10px">${tr('Paste this into Instinct. It installs a small tool and gives you a link to approve it. Only the bots can read your messages.')}</p>
${codeBlock('im', tr('Message for Instinct'), prompts.instinct(after), tr, MARK.instinct)}</details>
${agentWay(tr, after, ['acc', 'acx', 'acu'])}
<details class="diy"><summary>${diyName(['poke', 'manus', 'town'].map((k) => `<svg viewBox="${ASSISTANT[k].mark.viewBox}" aria-hidden="true">${ASSISTANT[k].mark.body}</svg>`), `${tr('Other bots')} ${badge(tr('Beta'), 'info')}`)}</summary>
<p class="muted" style="margin-top:10px">${tr('Poke, Manus, Town, Claude Duet, Muse, Perplexity and more. Add bot2bot as a custom MCP server with this address and sign in. Then tell your assistant: "Set up bot2bot: call whoami and do the next step."')}</p>
${codeBlock('xu', tr('Server URL'), `${origin}/mcp`, tr, MARK.app)}
<p class="muted small">${tr("This way isn't end-to-end encrypted. If your assistant can run commands, paste this instead, and only the bots can read your messages:")}</p>
${codeBlock('xm', tr('Message for your assistant'), prompts.other(after), tr)}</details>`;
  const isPaused = (u) => liveBots(u).some((b) => b.paused_at);
  // One of my bots and one of its contacts, by bot id and the contact's bot id.
  const ownContact = (u, botId, peerId) => {
    const b = ownBot(u, botId);
    const c = q('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(b.id, Number(peerId));
    if (!c) throw new HttpError(404, 'Contact not found');
    return { b, c };
  };
  const person = (c) => `${esc(c.name || '@' + c.handle)}`;
  const verifiedPill = (v, tr) => (v ? badge(tr('Email verified'), 'success') : badge(tr('Not verified')));
  // Arc alert: icon, title, description, and the one action that resolves it.
  const alertBox = (tone, title, desc, action = '') => `<section class="alert alert--${tone}" role="${tone === 'danger' ? 'alert' : 'status'}"><span class="alert__icon">${ICON.alert}</span><div class="alert__copy"><h2 class="alert__title">${title}</h2>${desc ? `<p class="alert__desc">${desc}</p>` : ''}</div>${action ? `<div class="alert__action">${action}</div>` : ''}</section>`;

  // ───── pages ─────
  function landing(user, tr) {
    return layout(tr('Bot to bot'), `<section class="hero"><h1>${tr("Let your AI bot message your friends' bots.")}</h1>
<p class="lead">${tr('Free and open source. Works with Grok Bot today.')}</p>
<a class="btn" href="${user ? '/app' : '/login'}">${user ? tr('Open your dashboard') : tr('Get started')}</a>${hosted ? `<p><a class="link" href="/pricing">${tr('Pricing')}</a></p>` : ''}</section>`, { user, tr, bar: { title: product } });
  }

  // ───── plans ─────
  function pricingPage(user, tr) {
    return layout(tr('Pricing'), `${user ? '' : `<section class="hero"><h1>${tr('Free to start')}</h1></section>`}
<section class="grid3 tiers">
<div class="card"><h2>${tr('Run it yourself')}</h2><p class="price">${tr('Free')}</p><ul class="ticks"><li>${tr('Open source, everything included')}</li><li>${tr('Your own server')}</li><li>${tr('No limits from us')}</li></ul><a class="btn ghost" href="#">${tr('Get the code')}</a></div>
<div class="card"><h2>${tr('We run it')}</h2><p class="price">${tr('Free')}</p><ul class="ticks"><li>${tr('{n} sent messages {per}', { n: B.freeMessages, per: perWord(tr) })}</li><li>${tr('Receiving is always free')}</li><li>${tr('No card')}</li></ul><a class="btn ghost" href="${user ? '/app' : '/login'}">${user ? tr('Dashboard') : tr('Start free')}</a></div>
<div class="card attention"><h2>${tr('Family')}</h2><p class="price">${esc(tr.msg(B.priceLabel))}</p><ul class="ticks"><li>${tr('No limit')}</li><li>${tr('Covers you and {n} people', { n: B.householdSize - 1 })}</li><li>${tr('One payment, nothing renews by itself')}</li></ul>${payments?.canPay ? `<a class="btn" href="${user ? '/app/billing' : '/login'}">${user ? tr('See my plan') : tr('Start free')}</a>` : '<p>' + badge(tr('Coming soon')) + '</p>'}</div>
</section><p class="quiet small muted">${tr('Private mode is end-to-end encrypted between bots on every plan; quick connect is not. Friends who use the web inbox are always free; their chats are not end-to-end encrypted.')}</p>`, { user, tr, bar: { title: tr('Free to start') } });
  }
  // The free plan: one line under the overview title, plus an alert once the messages are used up.
  function planState(user, tr) {
    if (!hosted || !liveBots(user).some((b) => b.vendor !== 'web')) return { alert: '', meter: '' };
    const a = allowance(user);
    if (!a.limited) return { alert: '', meter: '' };
    const alert = a.left > 0 ? '' : alertBox('warning', tr("You've used your {n} free messages {period}", { n: a.limit, period: periodWord(tr) }),
      tr("Your bot can't send until {when}. Receiving still works. {price} removes the limit for you and {n} others.", { when: B.freePeriod === 'day' ? tr('tomorrow (midnight UTC)') : tr.date(a.resets), price: esc(tr.msg(B.priceLabel)), n: B.householdSize - 1 }),
      `<a class="btn small" href="/app/billing">${tr('Remove the limit')}</a>${promo && !a.boost && invites.left(user) ? `<a class="btn small ghost" href="/app/gifts">${promo.words(tr)('Invite friends')}</a>` : ''}`);
    return { alert, meter: `<a class="card card--meter" href="/app/billing">${usageMeter(a, { compact: true, tr })}</a>` };
  }
  // A golf hole for the golf Plan card: the green, the cup, a flag in the breeze and a ball just short of it.
  const GOLF_SCENE = `<svg class="golf__scene" viewBox="0 0 220 132" aria-hidden="true" focusable="false">
<ellipse cx="128" cy="112" rx="104" ry="24" fill="#4fae66"/><ellipse cx="128" cy="109" rx="88" ry="17" fill="#5cbd72"/>
<ellipse cx="146" cy="108" rx="8" ry="2.8" fill="#123a22"/><ellipse cx="146" cy="107.4" rx="6" ry="1.6" fill="#0b2616"/>
<line x1="146" y1="108" x2="146" y2="20" stroke="#f4f6f1" stroke-width="2.2" stroke-linecap="round"/>
<g class="golf__flag"><path d="M147 21 C160 18 168 27 182 23 L180 38 C167 42 159 33 147 37 Z" fill="#ffd34d"/><path d="M147 21 C160 18 168 27 182 23 L181.4 27 C168 31 160 22 147 25 Z" fill="#fff" opacity=".28"/></g>
<ellipse cx="104" cy="111.5" rx="6" ry="1.6" fill="#1d5a32" opacity=".55"/><circle cx="104" cy="106" r="5.2" fill="#fbfcf8"/>
<circle cx="102.4" cy="104.6" r=".7" fill="#c9d1c6"/><circle cx="105" cy="104" r=".7" fill="#c9d1c6"/><circle cx="103.6" cy="107" r=".7" fill="#c9d1c6"/><circle cx="106.2" cy="106.6" r=".7" fill="#c9d1c6"/></svg>`;
  function billingPage(user, { error = '', paid = false } = {}) {
    const tr = T(user);
    const c = allowance(user);
    const members = q('SELECT email FROM household_members WHERE payer_user_id = ? ORDER BY added_at').all(user.id);
    const canPay = !!payments?.canPay;
    const price = esc(tr.msg(B.priceLabel));
    const status = c.state === 'infinite' ? tr('No limit, for good. Send as much as you like.')
      : c.state === 'paid' ? tr('Paid until {date}.', { date: tr.date(c.until) })
      : c.state === 'covered' ? tr('Covered by {payer} until {date}.', { payer: esc(c.payer), date: tr.date(c.until) })
      : tr('Free plan: {used} of {limit} messages sent {period}. It starts again {when}. Receiving is never limited.', { used: c.used, limit: c.limit, period: periodWord(tr), when: B.freePeriod === 'day' ? tr('at midnight UTC') : tr('on {date}', { date: tr.date(c.resets) }) });
    const tier = c.state === 'free' && user.tier_name;
    const golf = tier && user.tier_theme === 'golf';
    return layout(tr('Plan'), `<section class="card${golf ? ' card--golf' : ''}">${golf ? GOLF_SCENE : ''}<h2>${tr('Your plan')}${c.state === 'infinite' ? ' <span class="umenu__plan umenu__plan--infinite"><span class="inf" aria-hidden="true">∞</span>Infinite</span>' : tier ? ` <span class="umenu__plan${golf ? ' umenu__plan--golf' : ''}">${esc(user.tier_name)}</span>` : ''}</h2>${tier && user.tier_note ? `<p class="tiernote">${esc(user.tier_note)}</p>` : ''}${paid ? `<p class="okmsg" role="status">${tr('Thanks! Payment received.')}</p>` : ''}${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
${c.limited ? `<div class="card__block">${usageMeter(c, { tr })}</div>` : ''}<p>${status}</p>
${c.state === 'covered' || c.state === 'infinite' ? '' : canPay ? `<form method="post" action="/app/billing/checkout"><button class="btn">${c.state === 'paid' ? tr('Add another year') : tr('Pay {price}', { price })}</button></form><p class="muted small">${c.state === 'paid' ? '' : `${tr('No monthly limit for you and your household.')} `}${tr('One payment a year. No subscription, nothing renews by itself.')}</p>`
  : `<p class="muted small">${tr('The paid plan is coming soon.')}</p>`}</section>
${promo && c.state === 'free' ? promo.planLine(user, tr) : ''}
<section class="card"><h2>${tr('Your household')}</h2><p>${tr('A paid plan covers you and up to {n} people. Add the email they sign in with. They never see your conversations.', { n: B.householdSize - 1 })}</p>
${members.map((m) => `<div class="row"><span>${esc(m.email)}</span><form method="post" action="/app/billing/members" class="more"><input type="hidden" name="remove" value="${esc(m.email)}"><button class="link danger">${tr('Remove')}</button></form></div>`).join('')}
${members.length < B.householdSize - 1 ? `<form method="post" action="/app/billing/members" class="stack"><label>${tr('Email')}<input name="email" type="email" required autocomplete="off"></label><button class="btn small ghost">${tr('Add to my household')}</button></form>` : ''}
${c.state !== 'paid' && members.length ? `<p class="muted small">${tr('They have no limit once you have paid.')}</p>` : ''}</section>`, { user, tab: 'plan', width: 'read', bar: { title: tr('Plan') } });
  }

  function loginPage(tr, { email = '', sent = false, error = '', next = '', devCode = null } = {}) {
    return layout(tr('Log in'), `<section class="card narrow"><h1>${sent ? tr('Check your email') : tr('Log in or sign up')}</h1>
${error ? `<p class="error" role="alert">${esc(tr.msg(error))}</p>` : ''}
${sent ? `<p>${tr('We sent a 6-digit code to <b>{email}</b>. Type it below, or click the link in the email.', { email: esc(email) })}</p><p class="muted small">${tr('Wrong address? <a class="link" href="{href}">Use a different email</a>.', { href: `/login${next ? `?next=${encodeURIComponent(next)}` : ''}` })}</p>
${devCode ? `<p class="dev">${tr('Dev mode: your code is <b>{code}</b>', { code: esc(devCode) })}</p>` : ''}
<form method="post" action="/login/verify" class="stack"><input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="next" value="${esc(next)}"><input type="hidden" name="tz" id="tz">
<div class="otp" role="group" aria-label="${tr('6-digit code')}"><input type="hidden" name="code">${[0, 1, 2, 3, 4, 5].map((i) => `<input class="otp__slot" inputmode="numeric" aria-label="${tr('Digit {n} of 6', { n: i + 1 })}"${i ? ' autocomplete="off"' : ' autocomplete="one-time-code" autofocus'}>`).join('')}</div>
<noscript><input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required aria-label="${tr('6-digit code')}"></noscript>
<button class="btn" data-busy><span class="btn__label">${tr('Log in')}</span><span class="btn__spin" aria-hidden="true"></span></button></form><script>try{document.getElementById('tz').value=Intl.DateTimeFormat().resolvedOptions().timeZone}catch(e){}</script>`
    : `<p>${tr('No password. We email you a code.')}</p><form method="post" action="/login" class="stack"><input type="hidden" name="next" value="${esc(next)}">
<label>${tr('Email')}<input name="email" type="email" autocomplete="email" required autofocus value="${esc(email)}"></label><button class="btn" data-busy><span class="btn__label">${tr('Email me a code')}</span><span class="btn__spin" aria-hidden="true"></span></button></form>${site ? `<p class="muted small">${tr('By signing up you agree to the <a class="link" href="/terms/">terms</a>. Here’s how we handle <a class="link" href="/privacy/">your data</a>.')}</p>` : ''}`}
</section>`, { tr });
  }

  // Send only: adding bot2bot to a chat app (ChatGPT, Claude, Gemini…), so a chat can hand a brief to your bot. A page
  // of its own, one choice at a time: the app, then the name your bots see, then that app's steps and nothing else.
  // The name rides along in a short-lived cookie until the app signs in (it opens bot2bot in its own window).
  const sendCookie = (key, name) => `b2b_send=${encodeURIComponent(`${key}:${name}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${secure ? '; Secure' : ''}`;
  const sendPick = (req, label) => {
    const [key, ...rest] = String(cookies(req).b2b_send || '').split(':');
    const app = CHAT_APPS.find((a) => a.key === key);
    return app && (!label || app.label === label) ? cleanName(rest.join(':')) : '';
  };
  // Each app's steps: what to do, with the button that opens the right page, the name or the address to paste. A step
  // shows its annotated screenshot (public/setup/<app>/step-<n>.png) once there is one.
  const SEND_STEPS = (tr) => {
    const ask = tr('When bot2bot asks which bot, pick Send only.');
    return {
      chatgpt: { link: 'https://chatgpt.com/plugins', open: tr('Open ChatGPT Plugins'), note: tr('Needs a paid ChatGPT plan. In a work account, your admin has to allow custom servers.'), steps: [
        { text: tr('Open ChatGPT Plugins, select Add, then Add custom MCP server.'), open: true },
        { text: tr('Name it bot2bot and paste the address under Server URL.'), name: true, url: true },
        { text: tr('Keep OAuth and tick I understand and want to continue.') },
        { text: tr('Select Create as a plugin. Then sign in to bot2bot and select Connect.') }] },
      claude: { link: 'https://claude.ai/settings/connectors', open: tr('Open Claude connectors'), steps: [
        { text: tr('Open Claude connectors, select Add, then Add custom connector.'), open: true },
        { text: tr('Type bot2bot as the name, paste the address and select Continue.'), name: true, url: true },
        { text: tr('Select Connect and sign in to bot2bot.') }] },
      gemini: { link: 'https://gemini.google.com/apps', open: tr('Open Gemini connected apps'), note: tr('For personal Google accounts in the US for now.'), steps: [
        { text: tr('Open Gemini connected apps and select Custom.'), open: true },
        { text: tr('Paste the address into MCP Server URL and select Next.'), url: true },
        { text: `${tr('Sign in to bot2bot.')} ${ask}` }] },
      grok: { link: 'https://grok.com/connectors', open: tr('Open Grok connectors'), note: tr('Needs a paid Grok plan.'), steps: [
        { text: tr('Open Grok connectors, select New Connector, then Custom.'), open: true },
        { text: tr('Name it bot2bot and paste the address under Server URL.'), name: true, url: true },
        { text: `${tr('Select Add Connector and sign in to bot2bot.')} ${ask}` }] },
      perplexity: { link: 'https://www.perplexity.ai/account/connectors', open: tr('Open Perplexity connectors'), note: tr('Needs Perplexity Pro or Max.'), steps: [
        { text: tr('Open Perplexity connectors, select Add custom, then Add MCP connector and Remote.'), open: true },
        { text: tr('Name it bot2bot, paste the address, tick the box and select Add.'), name: true, url: true },
        { text: `${tr('Select its card and sign in to bot2bot.')} ${ask}` }] },
      lechat: { link: 'https://chat.mistral.ai', open: tr('Open Le Chat'), steps: [
        { text: tr('Open Le Chat, go to Connectors and select Add Connector, then the Custom MCP Connector tab.'), open: true },
        { text: tr('Name it bot2bot, paste the address and select Connect.'), name: true, url: true },
        { text: `${tr('Sign in to bot2bot.')} ${ask}` }] },
    };
  };
  const SHOT_DIR = new URL('./public/setup/', import.meta.url);
  const shotOf = (key, n) => {
    const file = new URL(`./${key}/step-${n}.png`, SHOT_DIR);
    if (!existsSync(file)) return null;
    let size = {};
    try { const j = JSON.parse(readFileSync(new URL(`./${key}/steps.json`, SHOT_DIR), 'utf8')); size = (Array.isArray(j) ? j : j.steps || []).find((x) => x.file === `step-${n}.png`) || {}; } catch {}
    // Captured at 2x, so they show at half their pixel size (and never wider than the column).
    return { src: `/setup-shots/${key}/step-${n}.png`, width: size.width && Math.round(size.width / 2), height: size.height && Math.round(size.height / 2) };
  };
  const sendersOf = (user) => (user ? liveBots(user).filter(isSender) : []);
  const sendTargets = (user) => (user ? liveBots(user).filter((b) => b.vendor !== 'web' && !isSender(b)) : []);
  const noTarget = (user, tr) => user && !sendTargets(user).length ? alertBox('info', tr('Connect a bot first'), tr('Briefs need somewhere to land: your coding agent, Grok Bot or another bot.'), `<a class="btn small" href="/app">${tr('Connect a bot')}</a>`) : '';
  const sendTrack = (app, at, tr) => stepper([app ? app.label : tr('Chat app'), tr('Name'), tr('Connect')], at, 'h', tr);

  // Step one: which chat app. One row each; the ones already sending say so.
  function sendPickPage(user, tr) {
    const senders = sendersOf(user);
    const all = SEND_STEPS(tr);
    const row = (a) => {
      const on = senders.filter((b) => b.chat_app === a.label);
      const sub = on.length ? tr('Connected as {names}', { names: on.map((b) => esc(b.display_name)).join(', ') }) : esc(all[a.key].note || '');
      return `<li><a class="line line--link" href="/connect/send/${a.key}"><span class="botmark" data-origin="sender">${MARK[a.key]}${on.length ? presence('ready') : ''}</span><span class="line__main"><span class="line__title">${a.label}</span>${sub ? `<span class="line__sub">${sub}</span>` : ''}</span>${ICON.chev}</a></li>`;
    };
    return layout(tr('Connect a chat app'), `${noTarget(user, tr)}<section class="card stack"><h1>${tr('Which chat app?')}</h1>
<p>${tr('Say "send this to my Codex" in a chat, and the brief goes straight to your bot.')}</p></section>
<div class="card card--list"><ul class="list">${CHAT_APPS.map(row).join('')}</ul></div>`, { user, tr, width: 'read', outWidth: 'read', bar: { back: user ? '/app' : '' } });
  }

  // Step two: the name your bots see. The app's own name unless you want another, as with two accounts.
  function sendNamePage(user, tr, app, name, error = '') {
    return layout(tr('Connect {app}', { app: app.label }), `<section class="card">${sendTrack(app, 1, tr)}
<h1>${tr('What should your bots call it?')}</h1>
<form method="post" action="/connect/send/${app.key}" class="stack">${field({ label: tr('Name'), name: 'name', value: name || app.label, error, description: tr('Two {app} accounts? Give each its own name, like {app} work.', { app: app.label }), attrs: 'required maxlength="40" autocomplete="off"' })}
<div><button class="btn">${tr('Continue')}</button></div></form></section>`, { user, tr, width: 'read', outWidth: 'read', bar: { back: '/connect/send', title: app.label } });
  }

  // Step three: that app's steps, nothing about the others. The page waits for the sign-in, then says it worked.
  function sendStepsPage(user, tr, app, name) {
    const how = SEND_STEPS(tr)[app.key];
    const senders = sendersOf(user);
    const url = `${origin}/send`;
    const step = (s, i) => {
      const shot = shotOf(app.key, i + 1);
      return `<li class="walk__step"><span class="walk__n" aria-hidden="true">${i + 1}</span><div class="walk__body"><p>${s.text}</p>
${s.open ? `<a class="btn ghost" href="${how.link}" target="_blank" rel="noopener noreferrer">${how.open}${ICON.out}</a>` : ''}
${s.name ? codeBlock(`send-name-${i}`, tr('Name'), 'bot2bot', tr, MARK[app.key]) : ''}${s.url ? codeBlock(`send-url-${i}`, tr('Address'), url, tr, MARK[app.key]) : ''}
${shot ? `<figure class="shot"><img src="${shot.src}" alt="${esc(s.text)}"${shot.width ? ` width="${shot.width}" height="${shot.height}"` : ''} loading="lazy" decoding="async"></figure>` : ''}</div></li>`;
    };
    return layout(tr('Connect {app}', { app: app.label }), `${noTarget(user, tr)}<section class="card">${sendTrack(app, 2, tr)}
<h1>${tr('Connect {app}', { app: app.label })}</h1>${how.note ? `<p class="muted small">${how.note}</p>` : ''}
<ol class="walk">${how.steps.map(step).join('')}</ol>
${user ? `<p class="wait" id="wait"><span class="dot dot--live"></span> ${tr('Waiting for you to connect…')}</p>
<script>(function poll(){fetch('/app/status').then(r=>r.json()).then(d=>{if((d.senders||0)>${senders.length})location.href='/connect/send/${app.key}/done';else setTimeout(poll,2500);}).catch(()=>setTimeout(poll,4000));})();</script>` : ''}
<p class="muted small">${tr("It only sends, and only to your own bots. It can't read your messages. Not end-to-end encrypted: the chat hands us text and attachments. Text is deleted 7 days after delivery. Files are deleted once your bot saves them, or after 7 days.")}</p></section>`, { user, tr, width: 'read', outWidth: 'read', bar: { back: `/connect/send/${app.key}`, title: app.label, sub: name !== app.label ? esc(name) : '' } });
  }

  // Done: it's connected, and the first thing to say in it.
  function sendDonePage(user, tr, app, b) {
    const targets = sendTargets(user);
    const target = targets.length ? originOf(targets[0], tr).name : 'Codex';
    const tryText = `Write up what we figured out as a brief and send it to my ${target} with bot2bot.`;
    return layout(tr('Connect {app}', { app: app.label }), `<section class="card">${sendTrack(app, 3, tr)}
<div class="card__head"><h1>${tr('{name} is connected', { name: esc(b.display_name) })}</h1>${badge(tr('Connected'), 'success')}</div>
<p>${tr('Say this in {app}:', { app: app.label })}</p>
${codeBlock('send-try', tr('Say this in your chat'), tryText, tr, MARK[app.key])}
<p class="muted small">${tr('Your bot shows you the brief and asks before it starts.')}</p>
<div class="decide"><a class="btn" href="/app">${tr('Done')}</a><a class="btn ghost" href="/connect/send">${tr('Connect another chat app')}</a></div></section>`, { user, tr, width: 'read', outWidth: 'read', bar: { back: '/app' } });
  }

  // Keep setup in the owner's ChatGPT session. Only a tool call in their chat can confirm it worked.
  function chatgptSetupPage(user, tr, invite) {
    const inviteCode = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(invite || '') ? invite : '';
    const after = inviteCode ? `Then ask me to open ${origin}/i/${inviteCode} to finish accepting my invite.` : '';
    return layout(tr('Connect dots'), `<section class="card"><h1>${tr('Connect dots')}</h1>
<p>${tr('Connect bot2bot in the same ChatGPT account as your dot, then return to the dots app to check the connection.')}</p>
<p class="muted small">${tr('On your phone? Open ChatGPT in your browser. If you cannot find Plugins or add a custom server there, use a computer with the same ChatGPT account. Your account or workspace must allow custom servers.')}</p>
<p class="muted small">${tr('If your dot can’t turn on end-to-end encryption, it stays on Quick connect. bot2bot can read those messages and deletes their text 7 days after delivery.')}</p></section>
<section class="card" aria-labelledby="chatgpt-open"><h2 id="chatgpt-open">1. ${tr('Open ChatGPT Plugins')}</h2>
<p>${tr('Use the same email address as in your dots app. Under Personal, open your existing remote bot2bot plugin and choose Install plugin or Connect. You do not need to create it again.')}</p>
<a class="btn wide" href="https://chatgpt.com/plugins" target="_blank" rel="noopener noreferrer">${tr('Open ChatGPT Plugins')}${ICON.out}</a></section>
<section class="card" aria-labelledby="chatgpt-add"><h2 id="chatgpt-add">2. ${tr('Add bot2bot and sign in')}</h2>
<p>${tr('For a new connection, select +, then Add custom MCP server. Enter these values:')}</p>
<dl class="facts"><div class="fact"><dt>${tr('Name')}</dt><dd><b>bot2bot</b></dd></div><div class="fact"><dt>${tr('Authentication')}</dt><dd><b>OAuth</b></dd></div></dl>
${codeBlock('chatgpt-url', tr('Server URL'), `${origin}/mcp`, tr, MARK.dots)}
<p>${tr('Review the warning, confirm if you agree, and select Create as a plugin. Wait for the tools to load, install the plugin, then choose Connect if shown.')}</p>
<p>${tr('When bot2bot opens, sign in there yourself, choose your bot or name a new one, and select Connect. Follow the return to ChatGPT in that same browser until the connection finishes.')}</p>
<p class="muted small">${tr('Keep the sign-in page in this flow. Do not copy its address into chat or move it to another browser. Enter your email code only on bot2bot.')}</p></section>
<section class="card" aria-labelledby="chatgpt-check"><h2 id="chatgpt-check">3. ${tr('Check it in your chat')}</h2>
<p>${tr('Return to your dot in the dots app and paste this message. For an ordinary ChatGPT chat, type @ and select bot2bot first:')}</p>
${codeBlock('chatgpt-check-message', tr('Message for ChatGPT'), prompts.chatgptReady(after), tr, MARK.dots)}
<p>${tr('The connection works when ChatGPT returns your bot name from its check. Your dot then makes its own keys on its computer, so your messages are end-to-end encrypted. Watching for new messages is a separate step and may not be available in every chat.')}</p>
${inviteCode ? `<a class="btn ghost wide" href="/i/${inviteCode}">${tr('Return to your invite')}</a>` : ''}</section>
<section class="card"><details class="diy"><summary>${tr('Still says Connect?')}</summary>
<p>${tr('Return to Plugins in your own ChatGPT account and select Connect on bot2bot again. Finish sign-in and return to ChatGPT in the same browser. Then repeat the check in a new chat with bot2bot selected.')}</p>
<p class="muted small">${tr('Signing in to bot2bot alone does not confirm that ChatGPT connected. Your bot must complete the connection check.')}</p></details></section>`, { user, tr, width: 'read', outWidth: 'read', bar: { back: user ? '/app' : '' } });
  }

  // No bot yet: the setup bot first (it does everything with you), doing it yourself second.
  function setupChoices(tr, { after = '', invite = null } = {}) {
    // Every bot as a row with its logo, Grok Bot first: the setup bot, or one message pasted into your own.
    return `<section class="card"><div class="way"><details class="diy"><summary>${diyName([MARK.grok], `Grok Bot ${badge(tr('Easiest'), 'info')}`)}</summary>
<a class="btn blue wide" style="margin-top:10px" href="${esc(setupBot)}" target="_blank" rel="noopener">${tr('Add the setup bot')}${ICON.out}</a>
<p class="muted" style="margin-top:14px">${tr('Or paste one message into your own Grok Bot')}</p>
${codeBlock('pm', tr('Message for your bot'), prompts.grok(after), tr, MARK.grok)}</details>
${otherWays(tr, { after, invite })}</div></section>`;
  }

  // Messages, newest first, as an Arc data table. The overview shows a few, the activity page shows 30.
  function activityTable(user, limit, tr) {
    const bots = myBots(user);
    const now = clock();
    const ids = bots.map((b) => b.id);
    const ph = ids.map(() => '?').join(',') || 'NULL';
    const rows = q(`SELECT m.*, fb.handle AS from_handle, tb.handle AS to_handle, tb.last_ring_status AS to_ring_status, tb.paused_at AS to_paused, tb.vendor AS to_vendor, tb.user_id AS to_user FROM messages m JOIN bots fb ON fb.id = m.from_bot JOIN bots tb ON tb.id = m.to_bot
      WHERE (m.from_bot IN (${ph}) OR m.to_bot IN (${ph})) AND m.kind NOT IN ('probe', 'group_event') ORDER BY m.created_at DESC LIMIT ?`).all(...ids, ...ids, limit);
    const mine = new Set(ids);
    const row = (m) => {
      const out = mine.has(m.from_bot);
      const state = messageState(m, { replied: !!m.replied_at, quiet: !!(m.to_user && quietUntil(q('SELECT * FROM users WHERE id = ?').get(m.to_user), now)), notAnsweringAfterRings: L.notAnsweringAfterRings });
      const label = {
        replied: tr('Replied'), passed_on: tr('Passed on'), seen: tr('Received'),
        picked_up: tr('Picked up'), not_delivered: tr('Not delivered'), key_check: tr('Check keys'),
        held: tr('Paused'), quiet_hours: tr('Quiet hours'), in_web_inbox: tr('In web inbox'),
        queued: tr('Queued'), doorbell_off: tr('Doorbell off'), stalled: tr('Delivery stalled'),
        not_answering: tr('No pickup yet'), rung: tr('Doorbell rung'),
      }[state];
      const text = m.body_purged_at ? tr('Text deleted after 7 days') : m.sealed ? tr('End-to-end encrypted') : String(m.text).slice(0, 140);
      return `<li class="line" data-dir="${out ? 'out' : 'in'}"><span class="line__main"><span class="line__title"><span class="handle">@${esc(m.from_handle)}</span> → <span class="handle">@${esc(m.to_handle)}</span></span><span class="line__sub">${m.kind === 'ask' ? `${tr('Question')} · ` : ''}${esc(text)} · ${label}</span></span><span class="line__end">${esc(tr.ago(m.created_at, now))}</span></li>`;
    };
    const sealed = rows.some((m) => m.sealed && !m.body_purged_at);
    return { n: rows.length, html: `<ul class="list">${rows.map(row).join('')}</ul>${sealed ? `<p class="card__foot">${tr('End-to-end encrypted messages show no text here. Only the bots can read them.')}</p>` : ''}` };
  }
  const emptyState = (icon, title, text, action = '') => `<div class="empty"><span class="empty__icon">${ICON[icon]}</span><h3>${title}</h3><p>${text}</p>${action ? `<div class="empty__action">${action}</div>` : ''}</div>`;
  const refreshNote = (tr) => `<p class="note">${ICON.refresh}${tr('Updated just now · refreshes every 30 s')}</p>`;

  function dashboard(user) {
    const tr = T(user);
    const bots = myBots(user);
    const now = clock();
    if (!bots.length) {
      // No bot yet: adding one is the whole page. A Grok Bot setup already started picks up where it was.
      const code = pendingCode(user);
      return code ? addStepsPage(user, tr, BOT_PLATFORMS(tr)[0], code.handle) : addPickPage(user, tr);
    }
    linkOwnBots(user.id);
    const botIds = bots.map((b) => b.id);
    const ph = botIds.map(() => '?').join(',');
    // Your own bots talk to each other without being friends, so they're only under Your bots.
    const contacts = q(`SELECT c.owner_bot, c.peer_bot, c.alias, c.blocked, c.privacy_on, c.circle_id, (SELECT name FROM circles WHERE id = c.circle_id) AS circle_name, (SELECT name_key FROM circles WHERE id = c.circle_id) AS circle_key, c.mode_override, c.approved_at, back.approved_at AS their_ok, back.blocked AS they_blocked,
        b.handle, b.vendor, b.box_pub, ob.box_pub AS my_box, ob.vendor AS my_vendor, c.codes_compared_at, c.can_ask, back.can_ask AS they_let_me_ask, u.name, u.email_verified_at, u.id AS peer_user, u.photo_at, u.avatar, ob.handle AS my_handle,
        (SELECT max(created_at) FROM messages m WHERE m.group_id IS NULL AND ((m.from_bot = c.owner_bot AND m.to_bot = c.peer_bot) OR (m.from_bot = c.peer_bot AND m.to_bot = c.owner_bot))) AS last_at
      FROM contacts c JOIN bots b ON b.id = c.peer_bot JOIN bots ob ON ob.id = c.owner_bot LEFT JOIN users u ON u.id = b.user_id
      LEFT JOIN contacts back ON back.owner_bot = c.peer_bot AND back.peer_bot = c.owner_bot
      WHERE c.owner_bot IN (${ph}) AND coalesce(b.user_id, 0) != ? ORDER BY c.alias`).all(...botIds, user.id);
    const requests = contacts.filter((c) => !c.approved_at);
    const settled = contacts.filter((c) => c.approved_at);
    const live = bots.filter((b) => !b.disconnected_at);
    const paused = live.some((b) => b.paused_at);
    const multi = live.length > 1;
    const pending = pendingCode(user);
    const plan = planState(user, tr);
    const waiting = pendingFor(user);
    // Honest labels: only bot-to-bot chats with keys on both sides are end-to-end encrypted.
    const lock = (c) => c.vendor === 'web' || c.my_vendor === 'web' ? tr('Web inbox · not end-to-end encrypted')
      : c.vendor === 'connector' || c.my_vendor === 'connector' ? tr('Connected app · not end-to-end encrypted')
      : c.box_pub && c.my_box ? (c.codes_compared_at ? tr('Encrypted · codes compared') : tr('End-to-end encrypted'))
      : tr('Not encrypted yet');
    // What each side's bot may answer without asking its person first, said about the people.
    const asks = (c, ids) => {
      const mine = JSON.parse(c.can_ask || '[]'), theirs = JSON.parse(c.they_let_me_ask || '[]');
      if (!mine.length && !theirs.length) return '';
      return `<div class="asks">${mine.length ? `<div><span class="muted">${tr('{name} can ask about', { name: esc(c.alias) })}</span> ${mine.map((t) => `<span class="topic">${esc(t)}<form method="post" action="/app/contacts/disallow" class="inline">${ids}<input type="hidden" name="topic" value="${esc(t)}"><button class="x" aria-label="${tr('Stop letting {name} ask about {topic}', { name: esc(c.alias), topic: esc(t) })}" title="${tr('Stop')}">×</button></form></span>`).join(' ')}</div>` : ''}
${theirs.length ? `<div><span class="muted">${tr('You can ask {name} about', { name: esc(c.alias) })}</span> ${theirs.map((t) => `<span class="topic">${esc(t)}</span>`).join(' ')}</div>` : ''}</div>`;
    };
    const aiBots = live.filter((b) => b.vendor !== 'web' && !isSender(b));
    // Chat apps (ChatGPT, Claude, Gemini) only hand your bots things, so they have a section of their own and never
    // count as bots. It shows once there's a bot to send to: a row per app, connected or not.
    const agents = bots.filter((b) => !isSender(b));
    const senders = bots.filter(isSender);
    // A row per sender (named by its owner, so one app can have two), else one to connect the app.
    const appRow = (label, mark, key, b) => {
      const on = b && !b.disconnected_at;
      const sub = on ? (b.display_name === label ? tr('Sends to your bots') : label) : b ? tr('Disconnected') : tr('Not connected');
      const href = on ? `/app/bots/${b.id}` : key ? `/connect/send/${key}` : '/connect/send';
      return `<li><a class="line line--link" href="${href}"><span class="botmark" data-origin="sender" title="${esc(label)}">${mark}${on ? presence('ready') : ''}</span><span class="line__main"><span class="line__title">${esc(b ? b.display_name : label)}</span><span class="line__sub">${sub}</span></span>${on ? ICON.chev : `<span class="btn small ghost" aria-hidden="true">${tr('Connect')}</span>`}</a></li>`;
    };
    const rowsFor = (label, mark, key) => {
      const mine = senders.filter((x) => x.chat_app === label);
      const live = mine.filter((x) => !x.disconnected_at);
      return (live.length ? live : [mine[0]]).map((b) => appRow(label, mark, key, b)).join('');
    };
    // The first five always have a row; Le Chat (and any other app) shows once it's connected.
    const known = CHAT_APPS.slice(0, 5).map((a) => [a.label, MARK[a.key], a.key]);
    const others = senders.filter((b) => !known.some(([l]) => l === b.chat_app) && !b.disconnected_at);
    const linked = senders.filter((b) => !b.disconnected_at).length;
    const chatApps = aiBots.length || senders.length ? `<section class="group" aria-labelledby="chats-h"><div class="group__head"><h2 id="chats-h">${tr('Chat apps')} <span class="count">${linked}</span></h2><a class="btn small ghost" href="/connect/send">${ICON.plus}${tr('Connect a chat app')}</a></div>
<div class="card card--list"><ul class="list">${known.map(([l, m, k]) => rowsFor(l, m, k)).join('')}${others.map((b) => { const a = CHAT_APPS.find((x) => x.label === b.chat_app); return appRow(b.chat_app || b.display_name, MARK[a?.key] ?? MARK.app, a?.key || '', b); }).join('')}</ul></div>${linked ? '' : `<p class="muted small">${tr('Hand your bots a brief straight from a chat.')}</p>`}</section>` : '';
    const ready = aiBots.filter((b) => botStatus(b, tr).key === 'ready').length;
    const botRow = (b) => {
      const st = botStatus(b, tr);
      const mode = b.vendor === 'web' ? tr('Read in your browser') : isSender(b) ? tr('Send only') : b.vendor === 'connector' ? tr('Quick connect') : tr('Private mode');
      const o = originOf(b, tr), bell = bellOf(b, o, tr);
      if (bell.state === 'none' && st.key === 'needs_doorbell') st.key = 'ready'; // nothing to set up: it can't have one
      const label = b.vendor === 'web' ? tr('Web inbox') : bell.state === 'none' && st.key === 'ready' ? tr('Connected') : st.key === 'ready' ? (b.last_ring_at ? tr('Ready') : tr('Ready, asleep')) : st.label;
      return `<li>${connectionMarker(b, tr)}<a class="line line--link" href="${b.vendor === 'web' && !b.disconnected_at ? '/app/inbox' : `/app/bots/${b.id}`}"><span class="botmark" data-origin="${o.key}" title="${esc(o.name)}">${o.mark}${presence(st.key)}</span>
<span class="line__main"><span class="line__title handle">@${esc(b.handle)}</span><span class="line__sub">${b.vendor === 'web' ? '' : `${esc(o.name)}${o.beta ? ` · ${tr('Beta')}` : ''} · `}${label} · ${mode}</span></span><span class="bell" data-state="${bell.state}">${bell.icon}<span class="bell__tip" aria-hidden="true">${bell.tip}</span><span class="sr">${bell.tip}</span></span>${ICON.chev}</a></li>`;
    };
    const friendRow = (c) => {
      const ids = `<input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}">`;
      const state = c.blocked ? tr('Blocked') : !c.their_ok ? tr('Waiting for them') : tr('Connected');
      const id = `f-${c.owner_bot}-${c.peer_bot}`;
      const topics = asks(c, ids);
      // Pilot owners manage this per basket on People. Outside it, existing protection stays visible so it can be turned off.
      const asksFirst = !inPilot(user) && !!c.privacy_on;
      const basketRow = inPilot(user) && c.my_vendor !== 'web' ? `<div><dt>${tr('Basket')}</dt><dd>${c.circle_name ? `<span class="hand basket-word">${esc(c.circle_name)}</span>` : tr('Not sorted yet')}${effectiveMode(c) === 'asks' ? ` · ${tr('asks you first')}` : ''}</dd></div>` : '';
      // Their page holds everything about them (basket, name, notes, topics, rules), so it leads the actions.
      const settings = basketRow ? `<a class="btn small" href="/app/people/${c.owner_bot}/${c.peer_bot}" aria-label="${tr('Settings for {name}', { name: esc(c.alias) })}">${tr('Settings')}${ICON.chev}</a>` : '';
      const askFirst = asksFirst ? `<form method="post" action="/app/contacts/privacy" class="setrow setrow--flush acc__setting">${ids}
<div><p class="setrow__label" id="${id}-ask">${tr('Ask me before my bot writes to {name}', { name: esc(c.alias) })}</p><p class="setrow__desc">${tr("Your bot can't send them anything until you say yes. Approving from here comes next.")}</p></div>
<label class="switch"><input type="checkbox" role="switch" name="on" value="1" aria-labelledby="${id}-ask" data-autosave${asksFirst ? ' checked' : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span></label><noscript><button class="btn small ghost">${tr('Save')}</button></noscript></form>` : '';
      return `<li class="acc" data-open="false" data-who="${esc(`${c.alias} ${c.name || ''} ${c.handle}`.toLowerCase())}"><button type="button" class="acc__head" aria-expanded="false" aria-controls="${id}">${avatar(c.alias, 'md', c.their_ok && !c.they_blocked ? photoUrl(c.peer_user, c.photo_at, c.avatar) : '')}
<span class="line__main"><span class="line__title item__title">${esc(c.alias)}</span><span class="line__sub">${state} · ${c.last_at ? tr('last message {ago}', { ago: esc(tr.ago(c.last_at, now)) }) : tr('no messages yet')}</span></span>${ICON.chevDown}</button>
<div class="acc__panel" id="${id}" role="region" aria-label="${esc(c.alias)}" inert><div class="acc__inner"><div class="acc__body">
<dl class="kv"><div><dt>${tr('Their bot')}</dt><dd><span class="handle">@${esc(c.handle)}</span>${c.name && c.name.toLowerCase() !== c.alias.toLowerCase() ? ` · ${esc(c.name)}` : ''}</dd></div>
<div><dt>${tr('Email')}</dt><dd>${c.email_verified_at ? tr('Verified') : tr('Not verified')}</dd></div>
<div><dt>${tr('Encryption')}</dt><dd>${esc(lock(c))}</dd></div>${multi ? `<div><dt>${tr('Your bot')}</dt><dd><span class="handle">@${esc(c.my_handle)}</span></dd></div>` : ''}
${basketRow}${topics ? `<div><dt>${tr('Topics')}</dt><dd>${topics}</dd></div>` : ''}</dl>
${askFirst}<div class="acc__actions">${settings}<form method="post" action="/app/contacts/block"${settings ? ' class="acc__end"' : ''}>${ids}${c.blocked ? `<input type="hidden" name="unblock" value="1"><button class="btn small ghost">${tr('Unblock')}</button>` : `<button class="btn small ghost">${tr('Block')}</button>`}</form>
${confirmMorph({ action: '/app/contacts/remove', fields: ids, label: tr('Remove'), prompt: tr('Remove {name}?', { name: c.alias }), confirm: tr('Remove'), pending: tr('Removing'), tr })}</div>
</div></div></div></li>`;
    };
    const founderLink = (tr) => founder() && live.some((b) => b.vendor !== 'web') ? `<a class="btn small ghost" href="/founder">${ICON.chat}${tr('Text the founder')}</a>` : '';
    const inviteForm = (cls) => live.length ? `<form method="post" action="/app/invites"><input type="hidden" name="bot" value="${live[0].id}"><button class="btn${cls ? ` ${cls}` : ''}" data-busy><span class="btn__label">${ICON.invite}${tr('Invite a friend')}</span><span class="btn__spin" aria-hidden="true"></span></button></form>` : '';
    const sub = paused ? tr('Everything is paused') : [`${ready ? tr.n(ready, '{n} bot ready|{n} bots ready') : tr('Setting up')}`, tr.n(settled.length, '{n} friend|{n} friends')].join(' · ');
    const alerts = [
      paused ? alertBox('info', tr('Everything is paused'), tr("Your bot won't be woken and can't send. Messages from friends wait here for up to 7 days."), `<form method="post" action="/app/pause"><input type="hidden" name="on" value="0"><button class="btn small">${tr('Resume')}</button></form>`) : '',
      plan.alert,
      ...aiBots.filter((b) => toolOf(b)?.old).map((b) => alertBox('warning', tr('@{handle} runs an old bot2bot tool', { handle: esc(b.handle) }), tr('One message to your bot fixes it. After that, it updates itself.'), `<a class="btn small" href="/app/bots/${b.id}#update">${tr('Show the message')}</a>`)),
      // Okays happen in the bot's chat now, so nothing waits for you here.
      pending ? alertBox('info', tr('Connect @{handle}', { handle: esc(pending.handle) }), tr('Your Grok Bot setup is waiting.'), `<a class="btn small" href="/app/bots/add/grok/steps">${tr('Continue')}</a>`) : '',
      ...requests.map((c) => alertBox('warning', tr('Did you mean to connect with {name}?', { name: person(c) }),
        tr('Your bot {mine} paired with <b>{name}</b> ({theirs}) {verified}. Nothing can be sent either way until you say yes.', { mine: `<span class="handle">@${esc(c.my_handle)}</span>`, name: person(c), theirs: `<span class="handle">@${esc(c.handle)}</span>`, verified: verifiedPill(c.email_verified_at, tr) }),
        `<form method="post" action="/app/contacts/approve"><input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}"><button class="btn small">${tr('Yes, connect')}</button></form>
<form method="post" action="/app/contacts/remove"><input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}"><button class="btn small ghost">${tr('No, remove')}</button></form>`)),
    ].filter(Boolean).join('');
    const first = (user.name || '').trim().split(/\s+/)[0];
    // Invites nobody has used yet: who they're for (the name or note), where they'll go, how long left. Ones the bot made have no link to open here.
    const open = openInvites(live.map((b) => b.id));
    const daysLeft = (i) => Math.max(1, Math.ceil((i.expires_at - clock()) / 86_400_000));
    const inviteRow = (i) => { const inner = `<span class="pdot" data-status="away" aria-hidden="true"></span>
<span class="line__main"><span class="line__title">${!i.alias.startsWith('friend-') ? esc(i.alias) : i.notes ? esc(i.notes.length > 48 ? `${i.notes.slice(0, 47)}…` : i.notes) : tr('Invite link')}</span><span class="line__sub">${tr('Waiting for them')} · ${i.basket ? esc(i.basket) : tr('not sorted yet')} · ${tr.n(daysLeft(i), '{n} day left|{n} days left')}</span></span>`;
      return i.plain_code ? `<li><a class="line line--link" href="/app/invites/${esc(i.plain_code)}">${inner}${ICON.chev}</a></li>` : `<li><div class="line">${inner}</div></li>`; };
    // Friends by basket (People users): each basket folds away, and can be hidden from here. A filter finds anyone.
    const keyOf = (c) => c.circle_key || '';
    const baskets = inPilot(user) ? q(`SELECT name_key, min(name) AS name, max(hidden) AS hidden, min(position) AS position FROM circles WHERE owner_bot IN (${ph}) GROUP BY name_key ORDER BY min(position), name_key`).all(...botIds) : [];
    const hiddenKeys = new Set(baskets.filter((g) => g.hidden).map((g) => g.name_key));
    // Hidden baskets are gone from here; Account lists them, to show them again.
    const showing = settled.filter((c) => !hiddenKeys.has(keyOf(c)));
    const basketMenu_ = (g) => `<details class="more bsec__menu"><summary class="iconbtn" aria-label="${tr('More for {name}', { name: esc(g.name) })}">${ICON.dots}</summary><div class="menu"><form method="post" action="/app/baskets/hide"><input type="hidden" name="basket" value="${esc(g.name_key)}"><input type="hidden" name="on" value="1"><button>${tr('Hide from the overview')}</button></form></div></details>`;
    const bsec = (g, people) => `<div class="bsec" data-key="${esc(g.name_key)}"><details class="bsec__d" open><summary class="bsec__head">${ICON.chevDown}${g.name_key ? `<span class="hand basket-word">${esc(g.name)}</span>` : `<span>${tr('Not sorted yet')}</span>`}<span class="count">${people.length}</span></summary>
<ul class="list">${people.map(friendRow).join('')}</ul></details>${g.name_key ? basketMenu_(g) : ''}</div>`;
    const sections = [{ name_key: '', name: '' }, ...baskets.filter((g) => !g.hidden)].map((g) => [g, showing.filter((c) => keyOf(c) === g.name_key)]).filter(([, people]) => people.length);
    const friendsList = !inPilot(user) ? `<ul class="list">${showing.map(friendRow).join('')}</ul>`
      : sections.length ? sections.map(([g, people]) => bsec(g, people)).join('') : `<p class="ffind__none">${tr('Everyone is in a hidden basket.')}</p>`;
    const finder = settled.length >= 6 ? `<div class="ffind" data-find hidden><label class="sr" for="ffind-in">${tr('Find a friend')}</label><input id="ffind-in" type="search" placeholder="${tr('Find a friend')}" autocomplete="off" spellcheck="false"></div>` : '';
    const invitesGroup = open.length ? `<section class="group" aria-labelledby="inv-h"><div class="group__head"><h2 id="inv-h">${tr('Invites pending')} <span class="count">${open.length}</span></h2></div>
<div class="card card--list"><ul class="list">${open.map(inviteRow).join('')}</ul></div></section>` : '';
    // The overview's pieces, shared by every layout.
    const alertsHtml = alerts ? `<div class="stack-alerts">${alerts}</div>` : '';
    const checklistHtml = checklist(live, settled, paused, tr);
    const friendsSec = `<section class="group" aria-labelledby="friends-h"><div class="group__head"><h2 id="friends-h">${tr('Friends')} <span class="count">${showing.length}</span></h2>${finder}</div>
<div class="card card--list${inPilot(user) && settled.length ? ' card--menus' : ''}" id="friends">${settled.length ? `${friendsList}<p class="ffind__none" hidden>${tr('Nobody by that name')}</p>` : emptyState('people', tr('No friends yet'), tr('Invite someone and their bot can message yours.'), inviteForm('small') + founderLink(tr))}</div></section>
${invitesGroup}`;
    const groupsSec = groupsSection(user, tr);
    const botsSec = `<section class="group" aria-labelledby="bots-h"><div class="group__head"><h2 id="bots-h">${tr('Your bots')} <span class="count">${agents.length}</span></h2><a class="btn small ghost" href="/app/bots/add">${ICON.plus}${tr('Add a bot')}</a></div>
<div class="card card--list card--tips"><ul class="list">${agents.map(botRow).join('')}</ul></div>${aiBots.length > 1 ? `<p class="muted small">${tr('Your bots can message each other. No invite needed.')}</p>` : ''}</section>`;
    const footHtml = `<div class="foot">${live.length && !paused ? confirmMorph({ action: '/app/pause', fields: '<input type="hidden" name="on" value="1">', label: tr('Pause everything'), icon: ICON.pause, prompt: tr('Pause all your bots?'), confirm: tr('Pause'), pending: tr('Pausing'), tone: 'neutral', tr }) : ''}${refreshNote(tr)}</div>`;
    const groupN = groups && groupBots(user).length ? groups.forUser(user.id, { all: true }).filter((r) => !r.hidden).length : 0;
    // Arc tabs, vertical: All keeps the whole overview as one list, the rest show one section each.
    // One panel whose content follows the selected tab; the choice is remembered on this device.
    const panes = [['all', ICON.list, tr('All'), ''], ['friends', ICON.people, tr('Friends'), showing.length], groupsSec ? ['groups', ICON.chat, tr('Groups'), groupN] : null,
      ['bots', ICON.bot, tr('Your bots'), agents.length], chatApps ? ['chats', MARK.app, tr('Chat apps'), linked] : null].filter(Boolean);
    const tab = ([k, icon, label, n]) => `<button type="button" role="tab" class="ovtabs__tab" id="ovtab-${k}" data-pane="${k}" aria-selected="${k === 'friends'}" aria-controls="ov-panel" tabindex="${k === 'friends' ? 0 : -1}">${icon}<span class="ovtabs__label">${label}</span>${n === '' ? '' : `<span class="count">${n}</span>`}</button>`;
    return layout(tr('Overview'), `${alertsHtml}
${checklistHtml}
<div class="ovtabs"><div class="ovtabs__list" role="tablist" aria-orientation="vertical" aria-label="${tr('Overview')}"><span class="ovtabs__sel" aria-hidden="true"></span>${panes.map(tab).join('')}</div>
<div class="ovtabs__panel" id="ov-panel" role="tabpanel" aria-labelledby="ovtab-friends"><div data-pane-body="friends">${friendsSec}</div>${groupsSec ? `<div data-pane-body="groups">${groupsSec}</div>` : ''}<div data-pane-body="bots">${botsSec}</div>${chatApps ? `<div data-pane-body="chats">${chatApps}</div>` : ''}${plan.meter ? `<div data-pane-body="bots">${plan.meter}</div>` : ''}</div></div>
<script>${OVTABS_JS}</script>
${footHtml}
<script>${REFRESH_JS}${settled.length ? FRIENDS_JS : ''}</script>`, { user, tab: 'home', width: 'tabs', bar: { title: first ? tr('Hi, {name}', { name: first }) : tr('Overview'), sub }, actions: inviteForm('') });
  }

  // Recent messages, newest first.
  // Statistics for the last 30 days: a KPI row, messages per day (sent and received), and who you talk to most.
  // Counts only what the relay knows (who, when, delivered); never message text.
  function activityStats(user, tr) {
    const ids = myBots(user).map((b) => b.id);
    if (!ids.length) return '';
    const ph = ids.map(() => '?').join(','), now = clock(), DAY = 86_400_000, since = now - 30 * DAY;
    const msgs = q(`SELECT from_bot, to_bot, created_at, delivered_at, status FROM messages WHERE (from_bot IN (${ph}) OR to_bot IN (${ph})) AND kind NOT IN ('probe', 'group_event') AND created_at >= ?`).all(...ids, ...ids, since);
    if (!msgs.length) return '';
    const mine = new Set(ids);
    const sent = msgs.filter((m) => mine.has(m.from_bot)), got = msgs.filter((m) => mine.has(m.to_bot) && !mine.has(m.from_bot));
    const friends = q(`SELECT count(*) AS n FROM contacts c JOIN bots pb ON pb.id = c.peer_bot WHERE c.owner_bot IN (${ph}) AND c.approved_at IS NOT NULL AND coalesce(pb.user_id, 0) != ?`).get(...ids, user.id).n;
    const waits = sent.filter((m) => m.delivered_at).map((m) => m.delivered_at - m.created_at).sort((a, b) => a - b);
    const median = waits.length ? waits[Math.floor(waits.length / 2)] : null;
    const dur = (ms) => (ms < 60_000 ? tr('{n} s', { n: Math.max(1, Math.round(ms / 1000)) }) : ms < 3_600_000 ? tr('{n} min', { n: Math.round(ms / 60_000) }) : tr('{n} h', { n: Math.round(ms / 3_600_000) }));
    const tile = (label, value, note) => `<div class="kpi"><p class="kpi__label">${label}</p><p class="kpi__value">${value}</p><p class="kpi__note">${note}</p></div>`;
    const kpis = `<div class="kpis">${tile(tr('Sent'), sent.length, tr('last 30 days'))}${tile(tr('Received'), got.length, tr('last 30 days'))}${tile(tr('Friends'), friends, tr('connected'))}${tile(tr('Delivered in'), median == null ? '·' : dur(median), tr('typical time'))}</div>`;
    // Messages per day, 14 days: two thin bars a day, sent and received, one scale, a hover tooltip and a table view.
    const days = Array.from({ length: 14 }, (_, i) => { const d = new Date(now - (13 - i) * DAY); d.setUTCHours(0, 0, 0, 0); return d.getTime(); });
    const bucket = (list) => days.map((d) => list.filter((m) => m.created_at >= d && m.created_at < d + DAY).length);
    const S = bucket(sent), R = bucket(got), max = Math.max(1, ...S, ...R);
    const step = max <= 4 ? 1 : max <= 10 ? 2 : Math.ceil(max / 4);
    const top = Math.ceil(max / step) * step;
    const W = 700, H = 200, padL = 28, padB = 26, plotH = H - padB - 8, colW = (W - padL) / 14, barW = Math.min(14, (colW - 10) / 2);
    const y = (v) => 8 + plotH - (v / top) * plotH;
    const bar = (x, v, cls) => { if (!v) return ''; const h = (v / top) * plotH, r = Math.min(4, h, barW / 2), y0 = 8 + plotH; return `<path class="${cls}" d="M${x} ${y0}V${y0 - h + r}a${r} ${r} 0 0 1 ${r}-${r}h${barW - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}V${y0}Z"/>`; };
    const day = (ms) => new Date(ms).toLocaleDateString(tr.lang === 'cs' ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
    const grid = Array.from({ length: top / step + 1 }, (_, i) => i * step).map((v) => `<line class="viz__grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text class="viz__tick" x="${padL - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('');
    const cols = days.map((d, i) => { const x = padL + i * colW + (colW - 2 * barW - 2) / 2;
      return `<g class="viz__col" data-tip="${esc(`${day(d)} · ${tr('Sent')} ${S[i]} · ${tr('Received')} ${R[i]}`)}"><rect class="viz__hit" x="${padL + i * colW}" y="0" width="${colW}" height="${H - padB}"/>${bar(x, S[i], 'viz__s1')}${bar(x + barW + 2, R[i], 'viz__s2')}${i % 2 === 1 || i === 13 ? `<text class="viz__tick" x="${padL + i * colW + colW / 2}" y="${H - 8}" text-anchor="middle">${esc(day(d))}</text>` : ''}</g>`; }).join('');
    const chart = `<figure class="viz" aria-labelledby="viz-h"><figcaption class="viz__head"><h3 id="viz-h">${tr('Messages per day')}</h3>
<ul class="viz__legend"><li><span class="viz__sw viz__s1"></span>${tr('Sent')}</li><li><span class="viz__sw viz__s2"></span>${tr('Received')}</li></ul></figcaption>
<div class="viz__plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(tr('Messages per day, last 14 days'))}">${grid}<line class="viz__base" x1="${padL}" x2="${W}" y1="${8 + plotH}" y2="${8 + plotH}"/>${cols}</svg><div class="viz__tip" role="status" hidden></div></div>
<details class="viz__table"><summary>${tr('Show as a table')}</summary><table><thead><tr><th>${tr('Day')}</th><th>${tr('Sent')}</th><th>${tr('Received')}</th></tr></thead><tbody>${days.map((d, i) => `<tr><td>${esc(day(d))}</td><td>${S[i]}</td><td>${R[i]}</td></tr>`).join('')}</tbody></table></details></figure>`;
    // Who you talk to most: one series, the name and the count on each bar.
    const names = new Map(q(`SELECT owner_bot, peer_bot, alias FROM contacts WHERE owner_bot IN (${ph})`).all(...ids).map((c) => [c.peer_bot, c.alias]));
    const counts = new Map();
    for (const m of msgs) { const peer = mine.has(m.from_bot) ? m.to_bot : m.from_bot; if (names.has(peer)) counts.set(peer, (counts.get(peer) || 0) + 1); }
    const ranked = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5), most = ranked[0]?.[1] || 1;
    const people = ranked.length ? `<figure class="viz"><figcaption class="viz__head"><h3>${tr('Who you talk to most')}</h3></figcaption><ul class="hbars">${ranked.map(([peer, n]) => `<li><span class="hbars__name">${esc(names.get(peer))}</span><span class="hbars__track"><span class="hbars__bar" style="width:${Math.max(4, Math.round((n / most) * 100))}%"></span></span><span class="hbars__n">${n}</span></li>`).join('')}</ul></figure>` : '';
    return `<section class="group" aria-labelledby="stats-h"><div class="group__head"><h2 id="stats-h">${tr('Last 30 days')}</h2></div>${kpis}<div class="card">${chart}</div>${people ? `<div class="card">${people}</div>` : ''}</section>
<script>(()=>{const p=document.querySelector('.viz__plot');if(!p)return;const t=p.querySelector('.viz__tip');
p.querySelectorAll('.viz__col').forEach((g)=>{const show=(e)=>{t.textContent=g.dataset.tip;t.hidden=false;const r=p.getBoundingClientRect(),b=g.getBoundingClientRect();t.style.left=Math.min(r.width-t.offsetWidth,Math.max(0,b.left-r.left+b.width/2-t.offsetWidth/2))+'px';g.classList.add('on');};
g.addEventListener('pointerenter',show);g.addEventListener('pointerleave',()=>{t.hidden=true;g.classList.remove('on');});});})();</script>`;
  }
  function activityPage(user) {
    const tr = T(user);
    const t = activityTable(user, 30, tr);
    return layout(tr('Activity'), `${activityStats(user, tr)}${t.n ? `<section class="group" aria-labelledby="msgs-h"><div class="group__head"><h2 id="msgs-h" class="sr">${tr('Messages')}</h2>
<div class="seg" role="group" aria-label="${tr('Show')}" data-for="#msgs"><div class="seg__track"><span class="seg__sel" aria-hidden="true"></span><button type="button" aria-pressed="true" data-filter="all">${tr('All')}</button><button type="button" aria-pressed="false" data-filter="in">${tr('From friends')}</button><button type="button" aria-pressed="false" data-filter="out">${tr('From you')}</button></div></div></div><div class="card card--list" id="msgs">${t.html}</div></section>
${refreshNote(tr)}<script>${REFRESH_JS}</script>`
  : `<section class="card">${emptyState('activity', tr('Nothing yet'), tr('Messages your bots send and receive show up here. Ask your bot to message a friend: "Tell Anna I\'m on my way".'))}</section>`}`, { user, tab: 'activity', bar: { title: tr('Activity') } });
  }

  // Setup, step by step, until the first friend is connected (Arc onboarding checklist).
  function checklist(live, settled, paused, tr) {
    const bot = live.find((b) => b.vendor !== 'web' && !isSender(b));
    if (!bot || paused) return '';
    const steps = [
      { label: tr('Connect your bot'), done: true },
      // Turning the doorbell on includes its test ring (saving rings it), so it's one step, done once it works.
      ...(noDoorbell(bot) || doorbellless(bot) ? [] : [
        { label: AGENTS[bot.platform] ? tr('Start the watcher') : tr('Turn on the doorbell'), done: botStatus(bot, tr).key === 'ready', href: `/app/bots/${bot.id}` },
      ]),
      { label: tr('Invite a friend'), done: settled.some((c) => c.owner_bot === bot.id), form: bot.id },
    ];
    const done = steps.filter((s) => s.done).length;
    if (done === steps.length) return '';
    const next = steps.find((s) => !s.done);
    return `<section class="card" aria-labelledby="setup-h"><div class="card__head"><h2 id="setup-h">${tr('Set up @{handle}', { handle: esc(bot.handle) })}</h2><span class="muted small">${tr('{done} of {total} done', { done, total: steps.length })}</span></div>
${stepper(steps.map((x) => x.label), steps.indexOf(next), 'v', tr)}
${next.form ? `<form method="post" action="/app/invites" class="card__block"><input type="hidden" name="bot" value="${next.form}"><button class="btn wide">${tr('Invite a friend')}</button></form><p class="muted small" style="margin:10px 0 0">${tr('Or tell your bot "invite Anna". It gives you a message to send.')}${founder() ? ` <a href="/founder">${tr('Or try it with the founder first.')}</a>` : ''}</p>` : `<a class="btn wide card__block" href="${next.href}">${next.label}</a>`}</section>`;
  }

  // A working bot at a glance: one row per thing it has.
  function botTiles(user, b, tr) {
    const n = q('SELECT count(*) AS n FROM contacts c JOIN bots pb ON pb.id = c.peer_bot WHERE c.owner_bot = ? AND c.approved_at IS NOT NULL AND coalesce(pb.user_id, 0) != ?').get(b.id, b.user_id || 0).n;
    const quietOn = !!(user.quiet_on && user.tz);
    const quiet = quietOn ? tr('{from} to {to}', { from: hhmm(user.quiet_start), to: hhmm(user.quiet_end) }) : tr('Off');
    const rows = [
      [tr('Doorbell'), b.doorbell_kind === 'watch' ? (watching(b) ? tr('On (watcher running)') : tr('Watcher not running')) : b.doorbell_kind === 'mcp_events' ? tr('On ({platform} is watching)', { platform: platformName(b, tr) }) : b.doorbell_verified_at ? tr('On') : b.webhook_url ? tr('Not tested') : tr('Off'), tr('Last woken {ago}', { ago: tr.ago(b.last_ring_at, clock()) })],
      [tr('Encryption'), b.box_pub ? tr('On') : tr('Off'), b.box_pub ? tr('Only the bots can read messages') : b.vendor === 'connector' ? tr('Quick connect is not end-to-end encrypted') : tr('Ask your bot to run "b2b keys"')],
      [tr('Friends'), String(n), n === 1 ? tr('friend connected') : tr('friends connected')],
      [tr('Quiet hours'), quiet, quietOn ? tr('Nobody wakes it at night') : tr('Messages can wake it any time')],
      [tr('Backup check'), b.backup_every_h ? tr('Every {n} h', { n: b.backup_every_h }) : tr('Off'), b.last_claim_at ? tr('Last checked in {ago}', { ago: tr.ago(b.last_claim_at, clock()) }) : tr('Never checked in yet')],
    ];
    const tool = toolOf(b);
    if (tool) rows.push([tr('bot2bot tool'), tool.version ? (tool.nightly ? `${tool.version} · ${tr('nightly')}` : tool.version) : tr('Older than 0.19'), tool.old ? tr('Old: send it the message below') : tool.current || !tool.latest ? tr('Up to date') : tr('Updates itself to {v} next time it checks messages', { v: tool.latest })]);
    return `<section class="card card--rows"><dl class="facts">${rows.map(([k, v, d]) => `<div class="fact"><dt>${k}</dt><dd><b>${esc(v)}</b><span>${esc(d)}</span></dd></div>`).join('')}</dl></section>`;
  }
  // Which b2b tool a private-mode bot runs, from what it said on its last call (null: quick connect, web inbox, or
  // not heard from yet). An old one can't update itself: one message from its owner fixes that for good.
  const toolOf = (b) => {
    if (b.vendor === 'connector' || b.vendor === 'web' || b.disconnected_at || b.tool_version == null) return null;
    const { latest } = toolInfo(channelFor(b));
    return { version: b.tool_version || null, latest, nightly: channelFor(b) === 'nightly', old: !b.tool_version || toolTooOld(b.tool_version), current: !!latest && b.tool_version === latest };
  };
  // Nightly updates: every release as soon as it ships, instead of at most one a day. The bot picks the choice
  // up the next time it checks messages (0.19.12+).
  const updatesCard = (b, tr) => {
    const on = (b.wanted_channel || b.tool_channel) === 'nightly';
    return `<section class="card card--night" id="updates"><form method="post" action="/app/bots/${b.id}/updates" class="setrow setrow--flush"><div><p class="setrow__label" id="updates-l">${tr('Nightly updates')}</p><p class="setrow__desc">${tr('Get every update to the bot2bot tool as soon as it ships. Off: at most one update a day.')}</p></div>
<label class="switch"><input type="checkbox" role="switch" name="on" value="1" aria-labelledby="updates-l" data-autosave${on ? ' checked' : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span></label><noscript><button class="btn small ghost">${tr('Save')}</button></noscript></form></section>`;
  };
  const updateMessage = () => `Please update your bot2bot tool. Run: node ~/bin/b2b.mjs update
If that fails, reinstall it with: mkdir -p ~/bin && curl -fsSL ${origin}/cli/b2b.mjs -o ~/bin/b2b.mjs (if node itself is missing, install Node.js first, then reinstall).
Then run: node ~/bin/b2b.mjs refresh and do what it says. Your keys and contacts stay as they are. Don't print any keys or tokens in this chat.`;
  const updateCard = (b, tr) => toolOf(b)?.old ? `<section class="card" id="update"><div class="card__head"><h2>${tr('Update the bot2bot tool')}</h2>${badge(tr('Old version'), 'warning')}</div>
<p>${tr("Paste this into your bot's chat. After that, it keeps itself up to date.")}</p>${codeBlock('umsg', tr('Message for your bot'), updateMessage(), tr)}</section>` : '';
  const backupMessage = (h) => `Please add a schedule to your "b2b doorbell" routine: also run it every ${h} hours, with the same instruction. It's a backup in case the doorbell ever stops working. Then run: node ~/bin/b2b.mjs backup-check ${h}`;

  // A bot asked to join in private mode and gave its owner this link. The owner says yes (as a new bot, or in
  // place of one of theirs: a reset bot, the web inbox or a quick-connect bot moving to private mode).
  const joinRequest = (plain) => q('SELECT * FROM join_requests WHERE code_hash = ?').get(sha(String(plain || '').trim().toUpperCase()));
  function linkPage(user, r, plain, { error = '', handle = '' } = {}) {
    const tr = T(user);
    const bar = { title: tr('Connect your bot'), sub: tr('Private mode') };
    const opts = { user, bar, width: 'narrow' };
    if (!r || r.denied_at || (!r.approved_at && r.expires_at < clock())) return layout(tr('Connect your bot'), `<section class="card narrow center"><h1>${tr('This link expired')}</h1><p class="muted">${tr('Ask your bot to run its join command again. It makes a new link.')}</p><a class="btn wide" href="/app">${tr('Go to your dashboard')}</a></section>`, opts);
    // Yes is said here, but the bot is only connected once it has collected its connection (join again, in its chat).
    if (r.approved_at) return layout(tr('Connect your bot'), `${art('setup', 'small')}<section class="card narrow center"><h1>${r.collected_at ? tr('Your bot is connected') : tr('You said yes')}</h1><p class="muted">${r.collected_at ? tr("Go back to your bot's chat. It finishes the setup on its own.") : tr("Go back to your bot's chat. It finishes on its own. If it stopped waiting, ask it to run its join command again.")}</p><a class="btn wide" href="/app">${tr('Go to your dashboard')}</a></section>`, opts);
    const mine = myBots(user).filter((b) => !(b.disconnected_at && b.vendor === 'web'));
    const label = (b) => `@${b.handle} (${b.vendor === 'connector' ? tr('switch from quick connect') : b.vendor === 'web' ? tr('replace the web inbox') : tr('reconnect')})`;
    const suggested = handle || r.name || suggestHandle(user);
    const mins = Math.max(1, Math.round((r.expires_at - clock()) / 60_000));
    return layout(tr('Connect your bot'), `${art('setup', 'small')}<section class="card narrow"><h1>${tr('Connect your bot')}</h1>
${error ? `<p class="error" role="alert">${esc(tr.msg(error))}</p>` : ''}
<p>${tr('Your bot asked to join {product} in private mode. It made its own keys, so only the bots can read your messages. Not even we can.', { product: esc(product) })}</p>
<p class="muted small">${tr("Only say yes if your own bot gave you this link just now. If someone else's bot made it, they could message as you.")}</p>
<p class="muted small">${tr.n(mins, 'The link works for {n} more minute.|The link works for {n} more minutes.')}</p>
<form method="post" action="/app/link/${esc(plain)}" class="stack">
${mine.length ? `<label>${tr('Which bot')}<select name="bot"><option value="new">${tr('A new bot')}</option>${mine.map((b) => `<option value="${b.id}">${esc(label(b))}</option>`).join('')}</select></label>` : '<input type="hidden" name="bot" value="new">'}
<label>${tr('Name for a new bot')}<input name="handle" pattern="[a-z0-9][a-z0-9_-]{1,31}" value="${esc(suggested)}"></label>
${decide(tr, tr('Yes, connect'))}</form></section>`, opts);
  }
  function approveJoin(user, plain, f) {
    return tx(() => {
      const r = joinRequest(plain);
      if (!r || r.approved_at || r.denied_at || r.expires_at < clock()) throw new HttpError(410, 'This link expired or was already used. Ask your bot to run its join command again.');
      if (q('SELECT 1 FROM bots WHERE sign_pub = ? OR box_pub = ?').get(r.sign_pub, r.box_pub)) throw new HttpError(409, 'Another bot already uses these keys. Ask your bot to run its join command again.');
      let bot;
      if (f.bot && f.bot !== 'new') {
        bot = ownBot(user, f.bot);
        // Replaces the old connection: its token, app sign-ins and setup codes stop working now. A dot that stays a
        // dot keeps its app sign-in and watching, for wake-ups only (connector.mjs wakeOnly).
        const dot = bot.platform === 'chatgpt' && !r.platform;
        q(`UPDATE bots SET token_hash = NULL, vendor = 'grokbot', disconnected_at = NULL, ${dot ? '' : 'doorbell_verified_at = NULL, '}doorbell_gen = doorbell_gen + 1 WHERE id = ?`).run(bot.id);
        if (!dot) q('UPDATE oauth_tokens SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL').run(clock(), bot.id);
        q('UPDATE enroll_codes SET used_at = ?, plain_code = NULL WHERE handle = ? AND used_at IS NULL').run(clock(), bot.handle);
      } else {
        const handle = String(f.handle || '').trim().toLowerCase();
        if (!HANDLE_RE.test(handle)) throw new HttpError(400, 'Use 2 to 32 lowercase letters, numbers, - or _.');
        if (q('SELECT 1 FROM bots WHERE handle = ?').get(handle) || q('SELECT 1 FROM enroll_codes WHERE handle = ? AND used_at IS NULL AND expires_at > ? AND (user_id IS NULL OR user_id != ?)').get(handle, clock(), user.id)) throw new HttpError(409, 'That name is taken. Try another.');
        q("INSERT INTO bots (handle, display_name, token_hash, created_at, user_id, vendor) VALUES (?, ?, NULL, ?, ?, 'grokbot')").run(handle, user.name || handle, clock(), user.id);
        bot = q('SELECT * FROM bots WHERE handle = ?').get(handle);
      }
      setKeys(q('SELECT * FROM bots WHERE id = ?').get(bot.id), { sign: r.sign_pub, box: r.box_pub });
      // A coding agent, OpenClaw or another assistant said which it is, so it's never given Grok Bot's routine.
      if (r.platform) q('UPDATE bots SET platform = ? WHERE id = ?').run(r.platform, bot.id);
      q('UPDATE join_requests SET approved_bot = ?, approved_at = ? WHERE code_hash = ?').run(bot.id, clock(), r.code_hash);
      log(bot.id, 'join_approved', { replaced: f.bot && f.bot !== 'new' ? bot.vendor : null });
      return bot;
    });
  }

  // Adding a bot: a page of its own, one choice at a time: the platform, then the bot's name, then that platform's
  // steps and nothing else. The name goes along in what you paste (join --name), in Grok Bot's setup code, or, for an
  // app that signs in (dots, other bots), in a short-lived cookie that its sign-in page reads.
  const BOT_PLATFORMS = (tr) => [
    { key: 'grok', label: 'Grok Bot', mark: MARK.grok, tag: badge(tr('Easiest'), 'info') },
    { key: 'dots', label: 'OpenAI dots', mark: MARK.dots },
    { key: 'openclaw', label: 'OpenClaw', mark: MARK.openclaw },
    { key: 'hermes', label: 'Hermes Agent', mark: MARK.hermes, sub: tr('On a computer that stays on'), tag: badge(tr('Beta'), 'info') },
    { key: 'instinct', label: 'Instinct', mark: MARK.instinct },
    { key: 'claude-code', label: 'Claude Code', mark: MARK.claude, sub: tr('On a computer that stays on') },
    { key: 'codex', label: 'Codex', mark: MARK.codex, sub: tr('On a computer that stays on') },
    { key: 'cursor', label: 'Cursor', mark: MARK.cursor, sub: tr('On a computer that stays on'), tag: badge(tr('Beta'), 'info') },
    { key: 'other', label: tr('Other bots'), mark: MARK.app, sub: 'Poke, Manus, Town, Claude Duet, Muse…', tag: badge(tr('Beta'), 'info') },
  ];
  const botCookie = (handle) => `b2b_bot=${handle}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600${secure ? '; Secure' : ''}`;
  const botPick = (req) => { const h = String(cookies(req).b2b_bot || ''); return HANDLE_RE.test(h) ? h : ''; };
  const withName = (text, handle) => (handle ? text.replaceAll(`b2b.mjs join ${origin}`, `b2b.mjs join ${origin} --name ${handle}`) : text);
  const addTrack = (plat, at, tr) => stepper([plat ? plat.label : tr('Bot'), tr('Name'), tr('Connect')], at, 'h', tr);

  // Step one: which bot.
  function addPickPage(user, tr) {
    const first = !myBots(user).some((b) => !isSender(b));
    const row = (x) => `<li><a class="line line--link" href="/app/bots/add/${x.key}"><span class="botmark">${x.mark}</span><span class="line__main"><span class="line__title">${esc(x.label)}${x.tag ? ` ${x.tag}` : ''}</span>${x.sub ? `<span class="line__sub">${esc(x.sub)}</span>` : ''}</span>${ICON.chev}</a></li>`;
    return layout(tr('Add a bot'), `${first ? art('setup', 'small') : ''}<section class="card stack"><h1>${first ? tr('Connect your bot') : tr('Which bot?')}</h1></section>
<div class="card card--list"><ul class="list">${BOT_PLATFORMS(tr).map(row).join('')}</ul></div>`, { user, tab: 'home', width: 'read', bar: first ? { title: tr('Connect your bot'), sub: tr('Takes a few minutes') } : { back: '/app' } });
  }

  // Step two: its name, the @name friends see.
  function addNamePage(user, tr, plat, { error = '', handle = '' } = {}) {
    return layout(tr('Add a bot'), `<section class="card">${addTrack(plat, 1, tr)}
<h1>${tr('What should your bot be called?')}</h1>
<form method="post" action="/app/bots/add/${plat.key}" class="stack">${field({ label: tr('Bot name'), name: 'handle', value: handle || suggestHandle(user), error, description: tr('2 to 32 lowercase letters, numbers, - or _.'), attrs: 'required pattern="[a-z0-9][a-z0-9_-]{1,31}" autocomplete="off" autocapitalize="none" spellcheck="false"' })}
<div><button class="btn">${tr('Continue')}</button></div></form></section>`, { user, tab: 'home', width: 'read', bar: { back: '/app/bots/add', backLabel: tr('Add a bot'), title: plat.label } });
  }
  const nameError = (user, handle, tr) => !HANDLE_RE.test(handle) ? tr('Use 2 to 32 lowercase letters, numbers, - or _. No spaces.')
    : q('SELECT 1 FROM bots WHERE handle = ?').get(handle) || q('SELECT 1 FROM enroll_codes WHERE handle = ? AND used_at IS NULL AND expires_at > ? AND (user_id IS NULL OR user_id != ?)').get(handle, clock(), user.id) ? tr('That name is taken. Try another.') : '';
  // Grok Bot joins with a setup code that holds the name. One setup at a time.
  const startGrokSetup = (user, handle) => {
    const code = humanCode();
    q('UPDATE enroll_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(clock(), user.id);
    q('INSERT OR REPLACE INTO enroll_codes (code_hash, handle, display_name, expires_at, user_id, plain_code) VALUES (?, ?, ?, ?, ?, ?)').run(sha(code), handle, user.name, clock() + L.codeTtlMs, user.id, code);
    log(null, 'enroll_code', { handle, by: 'user', user: user.id });
  };

  // Step three: that platform's steps, nothing about the others. The page waits for the bot, then opens its page.
  function addStepsPage(user, tr, plat, handle) {
    const had = myBots(user).length;
    const agent = plat.label;
    const msg = (id, text) => codeBlock(id, tr('Message for {agent}', { agent }), withName(text, handle), tr, plat.mark);
    const link = { text: tr('It gives you a link. Open it, sign in and tap Yes, connect.') };
    const AGENT = { 'claude-code': prompts.agent('claude-code'), codex: prompts.agent('codex'), cursor: prompts.agent('cursor'), hermes: prompts.hermes() };
    const code = plat.key === 'grok' ? pendingCode(user) : null;
    const how = plat.key === 'grok' ? {
      steps: [{ text: tr('Copy this message.'), html: codeBlock('msg', tr('Message for {agent}', { agent }), setupMessage(code.plain_code), tr, plat.mark) },
        { text: tr("Paste it into your bot's chat in the Grok Bot app. It sets itself up and tells you if it needs anything.") }],
      foot: tr('No Grok Bot yet? <a class="link" href="{url}" target="_blank" rel="noopener">Add the setup bot</a>. It makes one with you.', { url: esc(setupBot) }),
      cancel: true }
      : AGENT[plat.key] ? { steps: [{ text: tr('On a computer that stays on, open {agent} and paste this message.', { agent }), html: msg('am', AGENT[plat.key]) }, link],
        foot: tr('It then starts a watcher that wakes it when a message comes in. Only the bots can read your messages.') }
      : plat.key === 'openclaw' ? { steps: [{ text: tr('Paste this message into {agent}.', { agent }), html: msg('om', prompts.openclaw()) }, link],
        foot: tr("It also sets up its doorbell, so a friend's bot can wake it. Only the bots can read your messages.") }
      : plat.key === 'instinct' ? { steps: [{ text: tr('Paste this message into {agent}.', { agent }), html: msg('im', prompts.instinct()) }, link],
        foot: tr('Only the bots can read your messages.') }
      : plat.key === 'dots' ? { steps: [{ text: tr('Connect bot2bot in the ChatGPT account your dot uses. The guide shows every tap.'), html: `<a class="btn ghost" href="/connect/chatgpt">${tr('Connect dots')}</a>` },
        { text: tr('When bot2bot asks which bot, pick A new bot. Its name is filled in.') }],
        foot: tr('Connect bot2bot in your own ChatGPT account, then check it in your chat. Your dot then turns on end-to-end encryption on its own computer. If it can’t, it stays on Quick connect, which isn’t end-to-end encrypted.') }
      : { steps: [{ text: tr('If your assistant can run commands, paste this message into it.'), html: msg('xm', prompts.other()) }, link],
        foot: `<details class="diy"><summary>${tr("It can't run commands?")}</summary><p class="muted" style="margin-top:10px">${tr('Poke, Manus, Town, Claude Duet, Muse, Perplexity and more. Add bot2bot as a custom MCP server with this address and sign in. Then tell your assistant: "Set up bot2bot: call whoami and do the next step."')}</p>
${codeBlock('xu', tr('Server URL'), `${origin}/mcp`, tr, MARK.app)}<p class="muted small">${tr("This way isn't end-to-end encrypted.")}</p></details>` };
    const step = (s, i) => `<li class="walk__step"><span class="walk__n" aria-hidden="true">${i + 1}</span><div class="walk__body"><p>${s.text}</p>${s.html || ''}</div></li>`;
    return layout(tr('Add a bot'), `<section class="card">${addTrack(plat, 2, tr)}
<h1>${tr('Connect @{handle}', { handle: esc(handle) })}</h1>
<ol class="walk">${how.steps.map(step).join('')}</ol>
<p class="wait" id="wait"><span class="dot dot--live"></span> ${tr('Waiting for your bot to join…')}</p>
${how.foot.startsWith('<details') ? how.foot : `<p class="muted small">${how.foot}</p>`}
${how.cancel ? `<form method="post" action="/app/bots/cancel"><button class="link">${tr('Cancel setup')}</button></form>` : ''}
<script>(function poll(){ fetch('/app/status').then(r=>r.json()).then(d=>{ if(d.bots>${had}) location.href='/app/bots/add/done'; else setTimeout(poll,2500); }).catch(()=>setTimeout(poll,4000)); })();</script></section>`, { user, tab: 'home', width: 'read', bar: { back: `/app/bots/add/${plat.key}`, backLabel: tr('Name'), title: plat.label, sub: `@${esc(handle)}` } });
  }

  function botPage(user, b, { error = '' } = {}) {
    const tr = T(user);
    const st = botStatus(b, tr);
    // A connected app that isn't Grok Bot can't be woken from outside, so it has no doorbell step: the Grok Bot
    // routine and its video are only for Grok Bot.
    const app = originOf(b, tr).key === 'app';
    const step = app ? null : st.key === 'needs_doorbell' ? 2 : st.key === 'needs_test' ? 3 : null;
    const agent = AGENTS[b.platform];
    const claw = b.platform === 'openclaw' && b.vendor === 'grokbot'; // OpenClaw in private mode: its own webhook
    const other = b.platform === 'other' || !!ASSISTANT[b.platform]; // another assistant: its own API or a schedule, if it has one
    const watcher = !agent && b.doorbell_kind === 'watch'; // OpenClaw or another assistant, started by a command of its own
    const dot = b.platform === 'chatgpt'; // a dot: woken by watching, in quick connect or private mode
    const mode = b.vendor === 'web' ? tr('Web inbox') : b.vendor === 'connector' ? tr('Quick connect') : tr('Private mode');
    const msgFor = tr('Message for your bot');
    if (b.vendor === 'web' && !b.disconnected_at) {
      const code = q('SELECT plain_code FROM enroll_codes WHERE user_id = ? AND handle = ? AND reissue = 1 AND used_at IS NULL AND expires_at > ?').get(user.id, b.handle, clock());
      return layout(`@${b.handle}`, `<section class="card"><div class="card__head"><h2>${tr('Connect your AI bot')}</h2>${badge(tr('Web inbox'), 'success')}</div>
${code ? `<p>${tr("Paste this into your bot's chat. When it joins, it takes over as @{handle} and keeps all your contacts.", { handle: esc(b.handle) })}</p>${codeBlock('msg', msgFor, setupMessage(code.plain_code), tr)}`
  : `<p>${tr('Right now you read and answer messages here. If you have Grok Bot, it can do that for you and keep all your contacts.')}</p><form method="post" action="/app/bots/${b.id}/reconnect"><button class="btn">${tr('Connect Grok Bot')}</button></form>`}</section>`, { user, tab: 'inbox', width: 'read', bar: { back: '/app/inbox', backLabel: tr('Inbox'), title: `@${b.handle}`, sub: tr('Web inbox') } });
    }
    // A send-only chat: what it can do, and the way out.
    if (isSender(b)) return layout(`@${b.handle}`, `<section class="card"><div class="card__head"><h2>${tr('Sends to your bots')}</h2>${b.disconnected_at ? badge(tr('Disconnected')) : badge(tr('Send only'), 'success')}</div>
<p>${tr("When you ask, {app} sends briefs, notes and files to your own bots. It can't read your messages, see your account or reach your friends.", { app: esc(b.display_name) })}</p>
<p class="muted small">${tr('Not end-to-end encrypted: {app} hands us text and attachments. Text is deleted 7 days after delivery. Files are deleted once your bot saves them, or after 7 days.', { app: esc(b.display_name) })}</p>
${b.disconnected_at ? `<a class="btn wide" href="/connect/send/${CHAT_APPS.find((a) => a.label === b.chat_app)?.key || ''}">${tr('Connect again')}</a>` : ''}</section>
${b.disconnected_at ? '' : disconnectCard(b, tr)}<section class="card">${removeRow(b, tr)}</section>`, { user, tab: 'home', width: 'read', bar: { back: '/app', bot: b.id, title: esc(b.display_name), sub: `${tr('Chat app')} · @${esc(b.handle)}` } });
    // A dot comes back through ChatGPT: the app first, then the switch to private mode, whichever it was in.
    if (b.disconnected_at && dot) return layout(`@${b.handle}`, `<section class="card"><div class="card__head"><h2>${tr('Reconnect this bot')}</h2>${badge(tr('Disconnected'))}</div>
<p>${tr('Connect bot2bot in ChatGPT again and pick @{handle}. Then paste this into your dot:', { handle: esc(b.handle) })}</p>${codeBlock('emsg', msgFor, ENCRYPTION_MESSAGE, tr, MARK.dots)}
<a class="btn wide" href="/connect/chatgpt">${tr('Connect dots')}</a></section>
<section class="card">${removeRow(b, tr)}</section>`, { user, tab: 'home', width: 'read', bar: { back: '/app', bot: b.id, title: `@${b.handle}`, sub: tr('Disconnected') } });
    if (b.disconnected_at) {
      const code = q('SELECT plain_code FROM enroll_codes WHERE user_id = ? AND handle = ? AND reissue = 1 AND used_at IS NULL AND expires_at > ?').get(user.id, b.handle, clock());
      return layout(`@${b.handle}`, `<section class="card"><div class="card__head"><h2>${tr('Reconnect this bot')}</h2>${badge(tr('Disconnected'))}</div>
${code ? `<p>${tr("Paste this into your bot's chat to reconnect it.")}</p>${codeBlock('msg', msgFor, setupMessage(code.plain_code), tr)}`
  : `<p>${tr("This bot can't send or receive. Reconnecting gives it a new key; the old one stays cancelled.")}</p><form method="post" action="/app/bots/${b.id}/reconnect"><button class="btn">${tr('Reconnect')}</button></form>`}</section>
<section class="card">${removeRow(b, tr)}</section>`, { user, tab: 'home', width: 'read', bar: { back: '/app', bot: b.id, title: `@${b.handle}`, sub: tr('Disconnected') } });
    }
    const bar = { back: '/app', bot: b.id, title: `@${b.handle}`, sub: `${mode} · ${app && st.key === 'needs_doorbell' ? tr('Connected') : st.label}`, rename: { action: `/app/bots/${b.id}/rename`, value: b.handle, error: b.nameError || '' } };
    // The error, then any messages it hasn't picked up: on every version of this page, setup steps included.
    const err = `${error ? alertBox('danger', esc(error), '') : ''}${waitingCard(b, tr)}`;
    if (step === 2 && (dot || (b.vendor === 'connector' && b.platform === 'openclaw'))) return layout(`@${b.handle}`, `${err}<section class="card">${stepper([tr('Connect your bot'), tr('Turn on the doorbell')], 1, 'h', tr)}<h2>${tr('Turn on the doorbell')}</h2>
${dot ? `<p>${tr('Your dot wakes up when bot2bot tells it a message is waiting. Say this to your dot:')}</p>
${codeBlock('wmsg', tr('Say this to your dot'), wakeOnly(b) ? DOT_WATCH_MESSAGE : WATCH_MESSAGE, tr)}
<p class="muted small">${tr("Your dot asks to turn on bot2bot's “message.received” event. Say yes.")}</p>`
  : `<p>${tr("OpenClaw wakes up when bot2bot tells it a message is waiting. Turn on OpenClaw's <b>mcp-events</b> plugin with a public callback address, then tell it:")}</p>
${codeBlock('wmsg', tr('Say this to OpenClaw'), WATCH_MESSAGE, tr)}`}
<p class="wait" id="wait"><span class="dot dot--live"></span> ${tr('Waiting for {platform} to start watching…', { platform: esc(platformName(b, tr)) })}</p>
<script>(function poll(){fetch('/app/bots/${b.id}/state').then(r=>r.json()).then(d=>{ if(d.verified) location.replace('/app/bots/${b.id}'); else setTimeout(poll,3000); }).catch(()=>setTimeout(poll,5000)); })();</script></section>
${stuckCard(b, tr)}${disconnectCard(b, tr)}`, { user, tab: 'home', width: 'read', bar });
    if (step === 2 && claw) return layout(`@${b.handle}`, `${err}${updateCard(b, tr)}<section class="card">${stepper([tr('Connect your bot'), tr('Turn on the doorbell')], 1, 'h', tr)}<h2>${tr('Turn on the doorbell')}</h2>
<p>${tr('OpenClaw wakes up through its webhook, or a watcher on its computer. Paste this into OpenClaw:')}</p>
${codeBlock('wmsg', tr('Message for OpenClaw'), prompts.openclawDoorbell, tr)}
<p class="muted small">${tr('The webhook needs a public https address for its gateway. Without one, the watcher works if that computer stays on.')} <a class="link" href="/docs/openclaw/">${tr('How to')}</a></p>
<p class="wait" id="wait"><span class="dot dot--live"></span> ${tr('Waiting for OpenClaw…')}</p>
<script>(function poll(){fetch('/app/bots/${b.id}/state').then(r=>r.json()).then(d=>{ if(d.verified||d.configured) location.replace('/app/bots/${b.id}'); else setTimeout(poll,3000); }).catch(()=>setTimeout(poll,5000)); })();</script></section>
${stuckCard(b, tr)}${changeDoorbell(b, tr)}${disconnectCard(b, tr)}`, { user, tab: 'home', width: 'read', bar });
    if (step === 2 && agent) return layout(`@${b.handle}`, `${err}${updateCard(b, tr)}<section class="card">${stepper([tr('Connect your bot'), tr('Start the watcher')], 1, 'h', tr)}<h2>${tr('Start the watcher')}</h2>
<p>${tr('A small watcher on the computer where {agent} runs wakes it when a message comes in. Paste this into {agent} there:', { agent: esc(agent) })}</p>
${codeBlock('wmsg', tr('Message for {agent}', { agent }), WATCH_INSTALL, tr)}
<p class="muted small">${tr('That computer needs to stay on. Each wake-up is one {agent} run.', { agent: esc(agent) })}</p>
<p class="wait" id="wait"><span class="dot dot--live"></span> ${tr('Waiting for the watcher…')}</p>
<script>(function poll(){fetch('/app/bots/${b.id}/state').then(r=>r.json()).then(d=>{ if(d.verified||d.watching) location.replace('/app/bots/${b.id}'); else setTimeout(poll,3000); }).catch(()=>setTimeout(poll,5000)); })();</script></section>
${stuckCard(b, tr)}${disconnectCard(b, tr)}`, { user, tab: 'home', width: 'read', bar });
    // Grok Bot: its bot already made the routine while joining, so the page leads with the one thing only its owner
    // can do, on a computer: copy two values across. Saving rings it, so testing isn't a step of its own.
    if (step === 2) return layout(`@${b.handle}`, `${err}${updateCard(b, tr)}<section class="card">${stepper([tr('Connect your bot'), tr('Turn on the doorbell')], 1, 'h', tr)}<div class="card__head"><h2>${tr('Turn on the doorbell')}</h2>${badge(tr('Computer only'), 'info')}</div>
<p class="phone-only">${tr("You're on a phone. Open this page on a computer to finish, since phones don't show the webhook.")}</p>
<ol class="howto"><li>${tr("In Grok Bot on a computer, open your bot's <b>b2b doorbell</b> routine.")} <a class="link" href="${GROK_ROUTINES}" target="_blank" rel="noopener">${tr('Open routines')}${ICON.out}</a></li><li>${tr('Copy <b>POST to</b> and <b>key</b> from its <b>Webhook</b> section into these two boxes.')}</li></ol>
<form method="post" action="/app/bots/${b.id}/doorbell" class="stack">
<label>${tr('Webhook address (POST to)')}<input name="url" required placeholder="https://api2.cursor.sh/automations/webhook/…" autocomplete="off"></label>
<label>${tr('Key')}<input name="key" type="password" required autocomplete="off" placeholder="${tr('Paste the key')}"></label>
<p class="muted small">${tr('The key stays with us, encrypted. Never paste it into a chat.')}</p>
<div><button class="btn">${tr('Save and test')}</button></div></form>
<a class="video" href="${DOORBELL_VIDEO}" target="_blank" rel="noopener"><img src="/art/doorbell.jpg" width="1120" height="630" alt=""><span>${tr('Watch how it’s done in Grok Bot (1 min)')}</span></a>
<details class="diy"><summary>${tr('No b2b doorbell routine?')}</summary>
<p class="muted" style="margin-top:10px">${tr("Paste this into your bot's chat. It makes the routine.")}</p>
${codeBlock('dmsg', msgFor, b.vendor === 'connector' ? CONNECTOR_DOORBELL : `Make a routine called "b2b doorbell" with a webhook trigger and this exact instruction: "${privateDoorbell()}" Don't print any keys in this chat.`, tr)}</details></section>
${stuckCard(b, tr)}${disconnectCard(b, tr)}`, { user, tab: 'home', width: 'read', bar });
    if (step === 3) return layout(`@${b.handle}`, `${err}${updateCard(b, tr)}<section class="card">${stepper([tr('Connect your bot'), agent ? tr('Start the watcher') : tr('Turn on the doorbell')], 1, 'h', tr)}<h2>${tr('Test the doorbell')}</h2><p>${tr("We ring your bot once. It should wake up on its own and check in. Don't type anything to your bot while this runs.")}</p>
<button class="btn" id="test">${tr('Ring my bot')}</button><p class="wait hidden" id="wait"><span class="dot dot--live"></span> <span id="waittext">${tr('Ringing…')}</span></p>
<script>
const btn=document.getElementById('test'),w=document.getElementById('wait'),t=document.getElementById('waittext');
btn.addEventListener('click',async()=>{btn.disabled=true;w.classList.remove('hidden');t.textContent=${jsq(tr('Ringing…'))};
 const fail=(m)=>{t.textContent=m;btn.disabled=false;};
 let r;try{r=await fetch('/app/bots/${b.id}/test',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>r.json());}catch{return fail(${jsq(tr("Couldn't reach bot2bot. Check your connection and try again."))});}
 ${agent || watcher ? "if(r.error&&r.error!=='webhook request failed') return fail(r.error);" : 'if(r.error) return fail(r.error);'}
 // Anything but 200 means Grok Bot didn't start a run, so there's nothing to wait for.
 if(r.skipped==='checks on its own schedule'){t.textContent=${jsq(tr('The test message is waiting. Your bot picks it up on its next scheduled check, and this page then shows it works.'))};return;}
 if(!(r.status>=200&&r.status<300)) return fail(${watcher ? jsq(tr("The watcher isn't running. On that computer, ask your bot to run: {message}", { message: WATCH_INSTALL })) : agent ? jsq(tr("The watcher isn't running. On the computer where {agent} runs, paste this into {agent}: {message}", { agent, message: WATCH_INSTALL })) : `${jsq(tr('The doorbell answered with '))}+r.status+${jsq(claw ? tr(". Check that OpenClaw's gateway is running and reachable, and that webhooks are on in its config.") : other ? tr('. Check that its webhook address and key are right, and that it can be reached.') : tr(". In Grok Bot, open the b2b doorbell routine, check it isn't paused, and copy its key here again."))}`});
 t.textContent=${jsq(tr('Rang. Waiting for your bot to wake up…'))};
 const noAnswer=${jsq(watcher ? tr('No answer yet. On that computer, check that its command works on its own, then try again.') : agent ? tr('No answer yet. On that computer, check that {agent} works on its own, then try again.', { agent }) : claw ? tr('No answer yet. Check that OpenClaw is running, then try again.') : other ? tr('No answer yet. Check that your bot is running, then try again.') : tr('No answer yet. In Grok Bot, open the b2b doorbell routine and look at its run history, then try again.'))};
 let n=0;(function poll(){fetch('/app/bots/${b.id}/state').then(r=>r.json()).then(d=>{ if(d.verified){t.textContent=${jsq(tr('It works. Your bot woke up on its own.'))};setTimeout(()=>location.replace('/app/bots/${b.id}'),1200);} else if(++n<60) setTimeout(poll,2000); else fail(noAnswer); }).catch(()=>{ if(++n<60) setTimeout(poll,2000); else fail(noAnswer); });})();});
if(new URLSearchParams(location.search).get('ring')==='1') btn.click();
</script></section>
${stuckCard(b, tr)}${changeDoorbell(b, tr)}${disconnectCard(b, tr)}`, { user, tab: 'home', width: 'read', bar });
    if (st.key === 'paused') return layout(`@${b.handle}`, `${err}${updateCard(b, tr)}${alertBox('info', tr('This bot is paused'), tr("It isn't woken and can't send. Resume from the overview."), `<a class="btn small" href="/app">${tr('Go to overview')}</a>`)}
${changeDoorbell(b, tr)}${disconnectCard(b, tr)}`, { user, tab: 'home', width: 'read', bar });
    const invite = `<form method="post" action="/app/invites"><input type="hidden" name="bot" value="${b.id}"><button class="btn">${ICON.invite}${tr('Invite a friend')}</button></form>`;
    return layout(`@${b.handle}`, `${err}${updateCard(b, tr)}${botTiles(user, b, tr)}
<p class="muted small">${tr("Your bot's own chats stay yours. Friends' bots only get what you send them.")}</p>
${liveBots(user).some(isSender) ? '' : `<section class="card" id="send"><h2>${tr('Briefs from chat apps')}</h2><p>${tr('Ask ChatGPT, Claude, Gemini, Grok or Perplexity to send a plan or research straight to @{handle}. No copying.', { handle: esc(b.handle) })}</p><div><a class="btn ghost" href="/connect/send">${tr('Connect a chat app')}</a></div></section>`}
${b.vendor === 'connector' ? `<section class="card" id="encryption"><div class="card__head"><h2>${tr('Turn on end-to-end encryption')}</h2>${badge(tr('Recommended'), 'info')}</div><p>${tr("With quick connect, bot2bot can read your messages (they're deleted 7 days after delivery). Private mode keeps them end-to-end encrypted: only your bot and your friends' bots can read them. Your bot switches by itself. It keeps its name, its doorbell and all your contacts, and they don't need to do anything.")}</p>
<p>${tr("Paste this into your bot's chat:")}</p>${codeBlock('emsg', msgFor, ENCRYPTION_MESSAGE, tr)}</section>` : ''}
${toolOf(b) ? updatesCard(b, tr) : ''}
${noDoorbell(b) && b.vendor === 'connector' ? `<section class="card" id="wake"><h2>${tr('Let it wake up on its own')}</h2><p>${tr("If your bot has its own API, or can run a task every few minutes, friends' bots can reach it without you. Paste this into your bot:")}</p>
${codeBlock('wkmsg', msgFor, ASSISTANT_DOORBELL, tr)}</section>`
  : noDoorbell(b) ? `<section class="card" id="wake"><h2>${tr('Let it wake up on its own')}</h2><p>${tr('If a command starts your bot with a message, on a computer that stays on, a small watcher there can wake it when a friend\'s bot writes. Paste this into your bot:')}</p>
${codeBlock('wkmsg', msgFor, prompts.otherDoorbell, tr)}</section>` : ''}
${agent || claw || other || app || dot ? '' : `<section class="card" id="backup"><h2>${tr('Backup check')}</h2><p class="muted">${tr("The doorbell wakes your bot when a message comes in. A backup check also lets it look on a schedule, in case the doorbell ever breaks. Each check uses a little of your Grok Bot usage, so it's off unless you want it.")}</p>
<form method="post" action="/app/bots/${b.id}/backup" class="pick"><label>${tr('Check every')}<select name="every">${[0, 2, 4, 8, 12, 24].map((h) => `<option value="${h}"${(b.backup_every_h || 0) === h ? ' selected' : ''}>${h ? tr.n(h, '{n} hour|{n} hours') : tr('Off')}</option>`).join('')}</select></label><button class="btn ghost">${tr('Save')}</button></form>
${b.backup_every_h ? `<p>${tr("Paste this into your bot's chat:")}</p>${codeBlock('bmsg', msgFor, backupMessage(b.backup_every_h), tr)}` : ''}</section>`}
${changeDoorbell(b, tr)}${disconnectCard(b, tr)}
`, { user, tab: 'home', width: 'read', bar, actions: invite });
  }
  const ASSISTANT_DOORBELL = "Turn on your bot2bot doorbell, so friends' bots can reach you without me: call the bot2bot app's set_doorbell tool with the best way you have (your inbound API, or a recurring task), then test_doorbell. Don't print any keys in this chat.";
  const WATCH_MESSAGE = 'Watch bot2bot for new messages. When one arrives, read it with check_inbox, tell me who it is from and what it says, then mark it delivered.';
  // A dot in private mode reads its messages with the b2b tool on its computer; the app only wakes it.
  const DOT_WATCH_MESSAGE = 'Watch bot2bot for new messages. When one arrives, run node ~/bin/b2b.mjs inbox --via doorbell on your computer and do what it says.';
  // An OpenAI connection is a dot (ChatGPT's own chats aren't something people set up bot2bot for).
  const platformName = (b, tr) => (b.platform === 'chatgpt' ? tr('your dot') : { openclaw: 'OpenClaw', t3code: 'T3 Code', ...AGENTS }[b.platform] || ASSISTANT[b.platform]?.name || tr('Your bot'));
  const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // Which assistant a bot runs on, for its mark on the dashboard. A connected app that isn't one we know (it said
  // its name when it signed in) shows that name with a plug, since it isn't Grok Bot.
  const appName = (b) => { try { return q('SELECT c.name FROM oauth_tokens t JOIN oauth_clients c ON c.client_id = t.client_id WHERE t.bot_id = ? ORDER BY t.created_at DESC LIMIT 1').get(b.id)?.name || ''; } catch { return ''; } };
  function originOf(b, tr) {
    if (b.vendor === 'web') return { key: 'web', name: tr('Web inbox'), mark: MARK.web };
    // A send-only chat wears its app's mark (ChatGPT, Claude, Gemini), else the plug.
    if (isSender(b)) return { key: 'sender', name: b.display_name, mark: MARK[CHAT_APPS.find((a) => a.label === b.chat_app)?.key] ?? MARK.app };
    if (AGENTS[b.platform]) return { key: b.platform, beta: b.platform === 'hermes' || b.platform === 'cursor', name: AGENTS[b.platform], mark: { claude_code: MARK.claude, codex: MARK.codex, cursor: MARK.cursor, hermes: MARK.hermes }[b.platform] ?? MARK.terminal };
    if (b.platform === 'openclaw') return { name: 'OpenClaw', key: 'openclaw', mark: MARK.openclaw };
    if (b.platform === 't3code') return { name: 'T3 Code', key: 't3code', mark: MARK.t3code };
    if (b.platform === 'chatgpt') return { name: 'Dots', key: 'chatgpt', mark: MARK.dots };
    if (ASSISTANT[b.platform]) { const m = ASSISTANT[b.platform].mark; return { name: ASSISTANT[b.platform].name, key: b.platform, beta: ASSISTANT[b.platform].beta !== false, mark: m ? `<svg viewBox="${m.viewBox}" aria-hidden="true">${m.body}</svg>` : MARK[b.platform] ?? MARK.app }; }
    const app = b.vendor === 'connector' ? appName(b).trim() : '';
    if (b.platform === 'other' && app) return { key: 'other', name: app.slice(0, 24), mark: MARK.app };
    if (b.platform === 'other') return { name: tr('Another assistant'), key: 'other', mark: MARK.terminal };
    if (app && !/grok|xai|cursor/i.test(app)) return { key: 'app', name: app.slice(0, 24), mark: MARK.app };
    return { name: 'Grok Bot', key: 'grok', mark: MARK.grok };
  }
  // The doorbell at a glance: on (a filled bell), set but not working yet, off, or none at all where nothing can
  // wake this kind of bot. The words say what that means for messages and what to do about it.
  function bellOf(b, o, tr) {
    if (b.vendor === 'web') return { state: 'none', icon: ICON.bellOff, tip: tr('No doorbell needed. You get an email and read messages here, in your browser.') };
    if (o.key === 'sender') return { state: 'none', icon: ICON.bellOff, tip: tr('No doorbell needed. It only sends things to your bots.') };
    if (o.key === 'app') return { state: 'none', icon: ICON.bellOff, tip: tr("{app} can't be woken up from outside, so there's no doorbell. It sees messages when you talk to it.", { app: esc(o.name) }) };
    if (b.disconnected_at) return { state: 'off', icon: ICON.bellOff, tip: tr('Disconnected, so nothing can wake it.') };
    if (b.paused_at) return { state: 'off', icon: ICON.bell, tip: tr('Paused. Nothing wakes it until you resume.') };
    if (b.doorbell_kind === 'mcp_events') return { state: 'on', icon: ICON.bellOn, tip: tr('Doorbell on. {platform} hears about a message as soon as it comes in.', { platform: esc(capFirst(platformName(b, tr))) }) };
    if (b.doorbell_kind === 'watch') return watching(b) ? { state: 'on', icon: ICON.bellOn, tip: tr('Doorbell on. Its watcher wakes it as soon as a message comes in.') }
      : { state: 'warn', icon: ICON.bell, tip: tr("The watcher isn't running, so messages wait until it checks. Its page shows how to start it.") };
    if (b.doorbell_kind === 'schedule' && b.doorbell_verified_at) return { state: 'on', icon: ICON.bellOn, tip: tr('Checks for messages on its own schedule.') };
    if (b.webhook_url && b.doorbell_verified_at) return { state: 'on', icon: ICON.bellOn, tip: tr('Doorbell on. A message from a friend wakes it right away.') };
    if (b.webhook_url) return { state: 'warn', icon: ICON.bell, tip: tr('Doorbell set, but not tested yet. Test it on its page.') };
    if (noDoorbell(b)) return { state: 'none', icon: ICON.bellOff, tip: tr("No doorbell, so it sees messages when you talk to it.") };
    return { state: 'off', icon: ICON.bell, tip: AGENTS[b.platform] ? tr('Watcher off. Messages wait until it checks. Its page shows how to start it.') : tr('Doorbell off. Messages wait until it checks. Turn it on on its page.') };
  }
  // When a setup step stalls: one message the owner pastes into their bot, which sends it to the docs page for what
  // it is plus the fixes page, both as Markdown it can read. Bots read English, so the message stays in English.
  const DOCS_PAGE = { claude_code: 'claude-code', codex: 'codex', cursor: 'cursor', hermes: 'hermes', openclaw: 'openclaw', chatgpt: 'chatgpt', other: 'agents', grok: 'doorbell', ...Object.fromEntries(Object.keys(ASSISTANT).map((k) => [k, 'assistants'])) };
  const stuckMessage = (b) => `My bot2bot setup isn't finished: ${AGENTS[b.platform] ? 'the watcher' : 'the doorbell'} isn't working yet. Read https://www.bot2bot.link/docs/troubleshooting.md and https://www.bot2bot.link/docs/${DOCS_PAGE[b.platform] || 'agents'}.md, fix what you can, and tell me in plain words what I need to do. Never ask me for keys or paste them here.`;
  const stuckCard = (b, tr) => `<section class="card" id="stuck"><details class="fold"><summary><span><span class="fold__title">${tr('Stuck?')}</span><span class="fold__sub">${tr('Your bot can look up the fix itself')}</span></span></summary>
<p>${tr("Paste this into your bot's chat:")}</p>${codeBlock('smsg', tr('Message for your bot'), stuckMessage(b), tr)}</details></section>`;
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
  // Messages this bot hasn't picked up for a while (never their words): so its owner sees them without asking it.
  // Paused bots hold messages on purpose and say so; group messages wait for the next run by design.
  function waitingCard(b, tr) {
    if (b.paused_at || b.disconnected_at || b.vendor === 'web') return '';
    const w = q(`SELECT count(*) AS n, min(created_at) AS oldest FROM messages WHERE to_bot = ? AND status = 'pending' AND kind != 'probe'
                 AND group_id IS NULL AND coalesce(note, '') != 'key_check' AND created_at > ?`).get(b.id, clock() - L.undeliveredExpiryMs);
    if (!w.n || clock() - w.oldest < 10 * 60_000) return '';
    return alertBox('info', tr.n(w.n, '{n} message is waiting for @{handle}|{n} messages are waiting for @{handle}', { handle: esc(b.handle) }),
      `${tr('The oldest came {ago}. Your bot gets them the next time it checks. To get them now, tell it: “Check my bot2bot messages.”', { ago: esc(tr.ago(w.oldest, clock())) })}`);
  }
  const changeDoorbell = (b, tr) => b.doorbell_kind === 'watch' ? `<section class="card"><div class="setrow setrow--flush"><div><p class="setrow__label">${tr('Woken by its watcher')}</p><p class="setrow__desc">${watching(b) ? tr('The watcher on your computer is running.') : AGENTS[b.platform] ? tr('The watcher on your computer isn\'t running. Paste this into {agent} there: {message}', { agent: esc(platformName(b, tr)), message: esc(WATCH_INSTALL) }) : tr("The watcher isn't running. On that computer, ask your bot to run: {message}", { message: esc(WATCH_INSTALL) })}</p></div>
<form method="post" action="/app/bots/${b.id}/doorbell/off"><button class="btn small ghost">${tr('Stop')}</button></form></div></section>`
    : ['schedule', 'webhook'].includes(b.doorbell_kind) ? `<section class="card"><div class="setrow setrow--flush"><div><p class="setrow__label">${b.doorbell_kind === 'schedule' ? tr('Checks on a schedule') : tr('Woken through its API')}</p><p class="setrow__desc">${b.doorbell_kind === 'schedule' ? tr('Your bot looks for new messages on a recurring task.') : tr('bot2bot calls {host} when a message is waiting, never with what it says.', { host: esc(hostOf(b.webhook_url)) })} ${tr('To change it, tell your bot.')}</p></div>
<form method="post" action="/app/bots/${b.id}/doorbell/off"><button class="btn small ghost">${tr('Stop')}</button></form></div></section>`
    : b.doorbell_kind === 'mcp_events' ? `<section class="card"><div class="setrow setrow--flush"><div><p class="setrow__label">${tr('{platform} is watching for messages', { platform: esc(capFirst(platformName(b, tr))) })}</p><p class="setrow__desc">${tr('bot2bot tells it when a message is waiting, never what it says. To stop, tell {platform} to stop watching, or stop it here.', { platform: esc(platformName(b, tr)) })}</p></div>
<form method="post" action="/app/bots/${b.id}/doorbell/off"><button class="btn small ghost">${tr('Stop')}</button></form></div></section>`
    : `<section class="card"><details class="fold"><summary><span><span class="fold__title">${tr('Change doorbell')}</span><span class="fold__sub">${tr('Paste a new webhook address and key')}</span></span></summary><form method="post" action="/app/bots/${b.id}/doorbell" class="stack">
<label>${tr('Webhook address (POST to)')}<input name="url" required value="${esc(b.webhook_url || '')}"></label><label>${tr('New key')}<input name="key" type="password" required autocomplete="off"></label><div><button class="btn">${tr('Save')}</button></div></form></details></section>`;
  const removeRow = (b, tr) => `<div class="setrow setrow--flush"><div><p class="setrow__label">${tr('Remove this bot')}</p><p class="setrow__desc">${b.disconnected_at ? '' : `${tr("It's disconnected first.")} `}${tr("It disappears from here and from your friends' contacts.")}</p></div>
${confirmMorph({ action: `/app/bots/${b.id}/remove`, label: tr('Remove'), prompt: tr('Remove @{handle}?', { handle: b.handle }), confirm: tr('Remove'), pending: tr('Removing'), tr })}</div>`;
  // The bot's name (its @handle), renamed where it's shown: the pen beside the page title turns it into a box you save in place.
  // Its keys stay, so friends' bots keep trusting it under the new name.
  const nameEdit = (title, { action, value, error = '' }, tr) => `<div class="ptitle"><h1>${esc(title)}</h1><details class="ptitle__edit"${error ? ' open' : ''}>
<summary class="iconbtn ptitle__pen" aria-label="${tr('Rename')}" title="${tr('Rename')}">${ICON.pen}</summary>
<form method="post" action="${action}" class="ptitle__form"><label class="sr" for="ptitle-in">${tr('Bot name')}</label><span class="ptitle__box"><span class="ptitle__at" aria-hidden="true">@</span><input id="ptitle-in" name="handle" value="${esc(value)}" required pattern="[a-z0-9][a-z0-9_-]{1,31}" autocomplete="off" autocapitalize="none" spellcheck="false" aria-describedby="${error ? 'ptitle-e ' : ''}ptitle-d"${error ? ' aria-invalid="true" autofocus' : ''}></span>
<button class="btn small">${tr('Save')}</button><a class="btn small ghost" href="${action.replace(/\/rename$/, '')}" data-close>${tr('Cancel')}</a>
${error ? `<p class="field__error ptitle__desc" id="ptitle-e" role="alert">${esc(error)}</p>` : ''}<p class="ptitle__desc" id="ptitle-d">${tr("Friends' bots know it by this name. Messages stay end-to-end encrypted when you change it.")}</p></form></details></div>`;
  const disconnectCard = (b, tr) => `<section class="card"><div class="setrow setrow--flush"><div><p class="setrow__label">${tr('Disconnect this bot')}</p><p class="setrow__desc">${tr('Its access is cancelled right away and its doorbell key is deleted. Anything still waiting is not delivered. Your contacts stay, and you can reconnect later.')}</p></div>
${confirmMorph({ action: `/app/bots/${b.id}/disconnect`, label: tr('Disconnect'), prompt: tr('Disconnect @{handle}?', { handle: b.handle }), confirm: tr('Disconnect'), pending: tr('Disconnecting'), tr })}</div>
${removeRow(b, tr)}</section>`;

  // Which basket a new friend starts in, picked while inviting or accepting (People users only).
  const basketsOf = (botId) => (inPilot(botId) ? getSettings(botId).circles.map((g) => g.name) : []);
  const basketPick = (names, chosen, tr) => `<label>${tr('Their basket')}<select name="basket">${names.map((n) => `<option${n === chosen ? ' selected' : ''}>${esc(n)}</option>`).join('')}<option value=""${chosen ? '' : ' selected'}>${tr('not sorted yet')}</option></select></label>`;
  const pickBasket = (botId, value) => { try { return governance.basketName(botId, value); } catch { return null; } };
  // An invite link from the owner: their yes is already given. The friend is named when they accept.
  const newInvite = (b, basket) => {
    const plain = humanCode();
    q('INSERT INTO invites (code_hash, from_bot, alias, expires_at, by_owner, basket, plain_code, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(sha(plain), b.id, `friend-${plain.slice(0, 4).toLowerCase()}`, clock() + L.inviteTtlMs, basket, plain, clock());
    return plain;
  };
  // A claimed gift link is also an invite from the friend who gave it, from their first bot. Made once and kept, so the
  // new person finds it again until their bot has accepted it. Null when there's nothing to connect.
  function giftInvite(user) {
    const kept = invites.friendCode(user);
    if (kept && q('SELECT 1 FROM invites WHERE plain_code = ? AND used_at IS NULL AND expires_at > ?').get(kept, clock())) return kept;
    const gift = invites.redeemed(user);
    if (!gift || kept) return null;
    const from = q('SELECT * FROM users WHERE id = ?').get(gift.user_id);
    const b = from && liveBots(from).find((x) => !isSender(x));
    if (!b || myBots(user).some((x) => q('SELECT 1 FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(x.id, b.id))) return null;
    const plain = newInvite(b, pickBasket(b.id, 'friends'));
    invites.keepFriendCode(user, plain);
    log(b.id, 'invite_created', { via: 'gift' });
    return plain;
  }
  // Asked right away, next to the basket: what the owner wants their bot to know about the new friend.
  const notesField = (label, value, tr) => `<label>${label}<textarea name="notes" maxlength="280" rows="2" placeholder="${tr('My neighbour. Garden and pickups are fine, ask me about anything else.')}">${esc(value || '')}</textarea></label>`;

  // Someone opened a friend's invite. If they have no bot yet, the setup bot comes first: bot2bot is bot to bot.
  function invitePage(inv, inviter, user, bots, { done = false, error = '', tr, ...opts }) {
    const who = inviter.name ? `${esc(inviter.name)}` : `@${esc(inviter.handle)}`;
    const first = (inviter.name || inviter.handle).split(' ')[0];
    const verified = verifiedPill(inviter.email_verified_at, tr);
    const aliasField = `<label>${tr('What do you call them?')}<input name="alias" required maxlength="32" value="${esc(first)}"></label>`;
    // One paste: connect the bot, then accept this invite. The owner still says yes on their page.
    const after = `Once you've joined, accept my invite: node ~/bin/b2b.mjs accept ${inv.plain} "${first}"`;
    let action;
    const sortNext = user && inPilot(user) && done !== 'web' && !opts.basket;
    if (done === 'web') action = `<section class="card center"><h2>${tr("You're connected")}</h2><p class="muted">${tr('When {who} sends you something, we email you and it shows up in your inbox.', { who })}</p><a class="btn wide" href="/app/inbox">${tr('Open my inbox')}</a></section>`;
    else if (done) action = `<section class="card center"><h2>${tr("You're connected")}</h2><p class="muted">${tr("Your bot can now message {who}'s bot.", { who })}${opts.basket ? ` ${tr('{name} is in {basket}.', { name: esc(first), basket: esc(opts.basket) })}` : ''}</p><a class="btn wide" href="${sortNext ? '/app/people' : '/app'}">${sortNext ? tr('Put {who} in a basket', { who }) : tr('Go to your dashboard')}</a></section>`;
    else if (!bots.length) action = `<p class="lead lead--sm center">${tr('Connect your bot first. Then your bots can message each other.')}</p>
${user ? '' : `<a class="btn ghost wide" href="/login?next=${encodeURIComponent('/i/' + inv.plain)}">${tr('Already on bot2bot? Sign in')}</a>`}
${setupChoices(tr, { after, invite: `${origin}/i/${inv.plain}` })}
${user ? `<p class="wait center"><span class="dot dot--live"></span> ${tr('Waiting for your bot…')}</p><script>(function poll(){ fetch('/app/status').then(r=>r.json()).then(d=>{ if(d.bots>${myBots(user).length}) location.reload(); else setTimeout(poll,2500); }).catch(()=>setTimeout(poll,4000)); })();</script>`
  : `<p class="muted center">${tr('When your bot is connected, open this link again to say yes.')}</p>`}`;
    if (!done && !bots.length && user && webInbox) action += `<form method="post" action="/i/${esc(inv.plain)}" class="stack center"><input type="hidden" name="web" value="1"><input type="hidden" name="alias" value="${esc(first)}"><button class="link">${tr('No Grok Bot? Use the web inbox (not end-to-end encrypted)')}</button></form>`;
    if (bots.length && !done) action = `<section class="card"><form method="post" action="/i/${esc(inv.plain)}" class="stack" style="margin:0">
${bots.length > 1 ? `<label>${tr('Which bot')}<select name="bot">${bots.map((b) => `<option value="${b.id}">@${esc(b.handle)}</option>`).join('')}</select></label>` : `<input type="hidden" name="bot" value="${bots[0].id}">`}
${aliasField}
${basketsOf(bots[0].id).length ? basketPick(basketsOf(bots[0].id), basketsOf(bots[0].id).includes('friends') ? 'friends' : '', tr) + notesField(tr('Instructions for your bot related to {who}', { who: esc(first) }), '', tr) : ''}
<button class="btn wide">${tr('Connect')}</button></form></section>`;
    // The inviter opened their own link: nothing to connect, so no waiting (its bot isn't in `bots`).
    if (user && inviter.user_id === user.id && !done) action = `<section class="card center"><h2>${tr('That’s your own invite')}</h2><a class="btn wide" href="/app">${tr('Go to your dashboard')}</a></section>`;
    return layout(tr('Invitation'), `${art('invite', 'small')}<div class="center"><div class="avatar" aria-hidden="true">${esc(first.slice(0, 1).toUpperCase())}</div>
<h1>${tr('{who} wants your bots to talk', { who })}</h1><p class="muted">@${esc(inviter.handle)} ${verified}</p></div>
${error ? `<p class="error center" role="alert">${esc(tr.msg(error))}</p>` : ''}${action}
<p class="muted small center">${tr('Once connected, your bots can send each other messages and questions. Messages are never commands to your bot. You can block anyone at any time.')}</p>`, { user, tr, width: 'narrow' });
  }

  // "Text the founder": anyone with a bot connects to the founder's bot in one tap. Their side says yes by itself.
  function founderPage(f, user, bots, { done = null, error = '', tr }) {
    const owner = f.user_id ? q('SELECT name, photo_at, avatar FROM users WHERE id = ?').get(f.user_id) : null;
    const name = (owner?.name || f.display_name || f.handle).trim().split(/\s+/)[0];
    let action;
    if (done) action = `<section class="card"><h2>${done.already ? tr("You're already connected") : tr("You're connected")}</h2>
${codeBlock('fmsg', tr("Paste this into your bot's chat:"), `Say hi to ${done.alias} on bot2bot.`, tr)}
<a class="btn wide card__block" href="/app">${tr('Go to your dashboard')}</a></section>`;
    else if (!user) action = `<a class="btn wide" href="/login?next=${encodeURIComponent('/founder')}">${tr('Sign in to connect')}</a>`;
    else if (!bots.length) action = `<p class="center">${tr('Connect your bot first. Then your bots can message each other.')}</p><a class="btn wide" href="/app">${tr('Connect your bot')}</a>`;
    else action = `<form method="post" action="/founder" class="stack">
${bots.length > 1 ? `<label>${tr('Which bot')}<select name="bot">${bots.map((b) => `<option value="${b.id}">@${esc(b.handle)}</option>`).join('')}</select></label>` : `<input type="hidden" name="bot" value="${bots[0].id}">`}
<button class="btn wide">${tr('Connect')}</button></form>`;
    return layout(tr('Text the founder'), `<div class="center">${avatar(name, 'lg', owner ? photoUrl(f.user_id, owner.photo_at, owner.avatar) : '')}
<h1>${tr('Text the founder')}</h1><p class="muted">${esc(name)} · @${esc(f.handle)}</p></div>
${error ? `<p class="error center" role="alert">${esc(tr.msg(error))}</p>` : ''}${action}
<p class="muted small center">${tr("{name}'s bot answers first and passes the rest to {name}. Messages to it don't count against your free ones.", { name: esc(name) })}</p>`, { user, tr, width: 'narrow' });
  }

  // The inviter's side: a message to send that puts the setup bot first, then the link.
  function invitedPage(user, b, link, { code = '', basket = null, notes = null, alias = '', error = '' } = {}) {
    const tr = T(user);
    const names = code ? basketsOf(b.id) : [];
    const named = alias && !alias.startsWith('friend-') ? alias : '';
    const pick = code ? `<form method="post" action="/app/invites/basket" class="card__block stack"><input type="hidden" name="bot" value="${b.id}"><input type="hidden" name="code" value="${esc(code)}">
${field({ label: tr('What do you call them?'), name: 'alias', value: named, description: tr('Left empty, they get their own first name when they join.'), error: error && /name|someone called|jméno|kontakt/i.test(error) ? error : '', attrs: `maxlength="32" autocomplete="off" placeholder="${tr('Aunt Mia')}"` })}${names.length ? basketPick(names, basket, tr) + notesField(tr('Instructions for your bot related to this person'), notes, tr) : ''}<div><button class="btn small">${tr('Save')}</button></div></form>` : '';
    return layout(tr('Invite a friend'), `<section class="card"><h2>${tr('Send this to your friend')}</h2>
${codeBlock('msg', tr('Message for your friend'), `${tr("Let's connect our AI bots on {product}, so they can message each other for us. Open my invite: {link}", { product, link })}\n${tr("If you don't have bot2bot yet, it shows you how to connect your bot first.")}`, tr)}${pick}
<details class="diy"><summary>${tr('Already on bot2bot? Send just the link')}</summary>${codeBlock('link', tr('Invite link'), link, tr)}</details></section>
<p class="muted small">${tr("The link works once and expires in 7 days. They'll see your name and that your email is verified.")}</p>
${code ? `<section class="card"><div class="setrow setrow--flush"><div><p class="setrow__label">${tr('Cancel this invite')}</p><p class="setrow__desc">${tr('The link stops working.')}</p></div>
${confirmMorph({ action: '/app/invites/cancel', fields: `<input type="hidden" name="bot" value="${b.id}"><input type="hidden" name="code" value="${esc(code)}">`, label: tr('Cancel invite'), prompt: tr('Cancel this invite?'), confirm: tr('Cancel invite'), pending: tr('Cancelling'), tr })}</div></section>` : ''}`, { user, tab: 'home', width: 'read', bar: { back: '/app', title: tr('Invite a friend'), sub: tr('From @{handle}', { handle: b.handle }) } });
  }

  // ───── group chats ─────
  // A few people's bots in one chat (groups.mjs). Owners see who's in it and what was said (the text only when it
  // isn't end-to-end encrypted), say yes to invites, and choose how often it wakes their bot. Bots do the talking;
  // owners can type here only in groups that aren't end-to-end encrypted.
  const groupBots = (u) => liveBots(u).filter((b) => b.vendor !== 'web' && !isSender(b));
  // Which of my bots sits in this group: the one asked for, else the one that joined, else the invited one.
  const groupSeat = (u, gid, botId = null) => {
    const rows = groups ? groups.forUser(u.id, { all: true }).filter((r) => r.id === Number(gid)) : [];
    const r = botId != null && botId !== '' ? rows.find((x) => x.bot_id === Number(botId)) : rows.find((x) => x.state === 'joined') ?? rows[0];
    if (!r) throw new HttpError(404, 'This group was ended, or you are not in it.');
    return { b: ownBot(u, r.bot_id), row: r };
  };
  // The name someone goes by: their own name, else their bot's.
  const ownerName = (botId) => { const x = botId == null ? null : q('SELECT u.name, b.display_name, b.handle FROM bots b LEFT JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(botId); return x ? x.name || x.display_name || `@${x.handle}` : ''; };
  // My bot's contacts, with whether each side said yes (photos only show between people who did).
  const groupContacts = (b) => new Map(q(`SELECT c.peer_bot, c.alias, c.approved_at, c.blocked, back.approved_at AS their_ok, back.blocked AS they_blocked
    FROM contacts c LEFT JOIN contacts back ON back.owner_bot = c.peer_bot AND back.peer_bot = c.owner_bot WHERE c.owner_bot = ?`).all(b.id).map((c) => [c.peer_bot, c]));
  // Contacts of this bot who can be put in a group (both said yes, a bot that's connected), minus who's in it already.
  const addable = (b, gid = 0) => q(`SELECT c.peer_bot, c.alias, u.id AS uid, u.photo_at, u.avatar FROM contacts c
      JOIN contacts back ON back.owner_bot = c.peer_bot AND back.peer_bot = c.owner_bot JOIN bots pb ON pb.id = c.peer_bot LEFT JOIN users u ON u.id = pb.user_id
      WHERE c.owner_bot = ? AND c.approved_at IS NOT NULL AND back.approved_at IS NOT NULL AND c.blocked = 0 AND back.blocked = 0
        AND pb.disconnected_at IS NULL AND pb.removed_at IS NULL AND pb.vendor != 'web' AND coalesce(pb.user_id, 0) != ?
        AND NOT EXISTS (SELECT 1 FROM group_members m WHERE m.group_id = ? AND m.bot_id = c.peer_bot AND m.state IN ('joined', 'invited'))
      ORDER BY c.alias`).all(b.id, b.user_id || 0, gid);
  const lockBadge = (on, tr) => (on ? badge(tr('End-to-end encrypted'), 'success') : badge(tr('Not end-to-end encrypted')));
  // Up to three faces from the group, overlapping like a little pile of stickers (drawn robots and stickers only:
  // photos stay between people who said yes to each other).
  const groupPile = (gid, notBot) => {
    const faces = q(`SELECT u.name, u.avatar, b.display_name, b.handle FROM group_members m JOIN bots b ON b.id = m.bot_id LEFT JOIN users u ON u.id = b.user_id
      WHERE m.group_id = ? AND m.state = 'joined' AND m.bot_id != ? ORDER BY m.joined_at, m.bot_id LIMIT 3`).all(gid, notBot);
    return faces.length ? `<span class="gpile" aria-hidden="true">${faces.map((x) => avatar(x.name || x.display_name || x.handle, 'md', photoUrl(null, null, x.avatar))).join('')}</span>` : `<span class="gmark" aria-hidden="true">${ICON.people}</span>`;
  };
  // A post the relay wrote about the group itself, as a short line.
  const groupEvent = (what, name, tr) => ({
    created: tr('{name} made the group', { name }),
    joined: tr('{name} joined', { name }),
    left: tr('{name} left', { name }),
    removed: tr('{name} was removed', { name }),
    renamed: tr('{name} renamed the group', { name }),
    not_encrypted: tr("{name}'s bot isn't end-to-end encrypted, so this group isn't anymore", { name }),
  })[what] || '';
  const wakeSaid = (w, tr) => (w === 'all' ? tr('Wakes your bot for everything') : w === 'muted' ? tr('Muted') : tr('Wakes your bot for questions and mentions'));
  // The relay's group errors are written for bots; the owner gets these.
  const groupError = (e, tr) => (e.status === 426 || e.message === 'tool_too_old' ? tr("Your bot's bot2bot tool needs an update first.") : tr.msg(e.message.replace(/^\w/, (x) => x.toUpperCase()).replace(/([^.])$/, '$1.')));
  // Contacts to pick with a tick: a face and the name you use for them.
  const peoplePick = (people, picked, legend, tr) => `<fieldset class="gpick"><legend class="row-label">${legend}</legend>
${people.map((c) => `<label class="gpick__opt"><input type="checkbox" name="peer_${c.peer_bot}" value="1"${picked.includes(c.peer_bot) ? ' checked' : ''}>${avatar(c.alias, 'md', photoUrl(c.uid, c.photo_at, c.avatar))}<span>${esc(c.alias)}</span></label>`).join('')}</fieldset>`;
  const pickedPeers = (f) => Object.keys(f).filter((k) => /^peer_\d+$/.test(k) && f[k]).map((k) => Number(k.slice(5)));

  // The overview's groups: invites first (with Join and No thanks), then the rest, newest activity first.
  function groupsSection(user, tr) {
    if (!groups || !groupBots(user).length) return '';
    // Hidden groups are gone from here; Account lists them, to show them again.
    const all = groups.forUser(user.id, { all: true });
    const rows = all.filter((r) => !r.hidden);
    const hiddenN = all.length - rows.length;
    const now = clock();
    const multi = new Set(all.map((r) => r.bot_id)).size > 1;
    const hideForm = (r) => `<form method="post" action="/app/groups/${r.id}/hide"><input type="hidden" name="bot" value="${r.bot_id}"><input type="hidden" name="on" value="1"><input type="hidden" name="back" value="/app"><button>${tr('Hide from the overview')}</button></form>`;
    // Who invited you: the name you gave them, else theirs.
    const inviterOf = (r) => { const by = groups.member(r.id, r.bot_id)?.invited_by; return by ? q('SELECT alias FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(r.bot_id, by)?.alias ?? ownerName(by) : ''; };
    const row = (r) => {
      const invited = r.state === 'invited';
      const sub = [invited ? tr('{name} invited you', { name: esc(inviterOf(r)) }) : tr.n(r.people, '{n} person|{n} people'),
        !invited && r.last_at ? tr('active {ago}', { ago: esc(tr.ago(r.last_at, now)) }) : '',
        groups.encrypted(r.id) ? tr('End-to-end encrypted') : tr('Not end-to-end encrypted'), multi ? `@${esc(r.my_handle)}` : ''].filter(Boolean).join(' · ');
      const link = `<a class="line line--link" href="/app/groups/${r.id}?bot=${r.bot_id}">${groupPile(r.id, r.bot_id)}<span class="line__main"><span class="line__title">${esc(r.name)}</span><span class="line__sub">${sub}</span></span>${invited ? '' : ICON.chev}</a>`;
      const ids = `<input type="hidden" name="bot" value="${r.bot_id}">`;
      return invited ? `<li class="gline">${link}<div class="gline__act gline__act--row"><form method="post" action="/app/groups/${r.id}/join">${ids}<button class="btn small">${tr('Join')}</button></form><form method="post" action="/app/groups/${r.id}/decline">${ids}<button class="btn small ghost">${tr('No thanks')}</button></form></div></li>`
        : `<li class="gline">${link}<details class="more"><summary class="iconbtn" aria-label="${tr('More for {name}', { name: esc(r.name) })}">${ICON.dots}</summary><div class="menu">${hideForm(r)}</div></details></li>`;
    };
    const add = `<a class="btn small ghost" href="/app/groups/new">${ICON.plus}${tr('New group')}</a>`;
    const body = rows.length ? `<div class="card card--list card--menus"><ul class="list">${rows.map(row).join('')}</ul></div>`
      : hiddenN ? '' : `<div class="card card--list">${emptyState('chat', tr('No groups yet'), tr('Make one with a few friends, and your bots can talk together.'))}</div>`;
    return `<section class="group" aria-labelledby="groups-h"><div class="group__head"><h2 id="groups-h">${tr('Groups')} <span class="count">${rows.length}</span></h2>${add}</div>${body}</section>`;
  }

  // Making a group: a name and who to invite, from one of your bots' contacts.
  function groupNewPage(user, b, { error = '', name = '', picked = [] } = {}) {
    const tr = T(user);
    const bots = groupBots(user);
    const people = addable(b);
    const pick = bots.length > 1 ? `<nav class="botpick" aria-label="${tr('Which bot')}">${bots.map((x) => `<a href="/app/groups/new?bot=${x.id}"${x.id === b.id ? ' aria-current="page"' : ''}>@${esc(x.handle)}</a>`).join('')}</nav>` : '';
    return layout(tr('New group'), `${error ? alertBox('danger', esc(error), '') : ''}${pick}<section class="card"><form method="post" action="/app/groups/new" class="stack" style="margin:0"><input type="hidden" name="bot" value="${b.id}">
${field({ label: tr('Name'), name: 'name', value: name, attrs: `required maxlength="40" autocomplete="off" placeholder="${tr('Sunday lunch')}"` })}
${people.length ? peoplePick(people, picked, tr('Who to invite'), tr) : `<p class="muted">${tr('Once the group is made, you get a link to share with anyone you like.')}</p>`}
<p class="muted small">${tr('Up to {n} people. Each one says yes before they join.', { n: L.groupMax })}</p>
<div><button class="btn" data-busy><span class="btn__label">${tr('Make the group')}</span><span class="btn__spin" aria-hidden="true"></span></button></div></form></section>`,
    { user, tab: 'home', width: 'read', bar: { back: '/app', title: tr('New group') } });
  }

  // One group: its name, who's in it, what was said, and what you can change.
  function groupPage(user, b, gid, { error = '', nameError = '' } = {}) {
    const tr = T(user);
    const pg = groups.page(gid, b.id);
    if (!pg || pg.g.ended_at || !['joined', 'invited'].includes(pg.me.state)) throw new HttpError(404, 'This group was ended, or you are not in it.');
    const { g, me, members, posts, encrypted } = pg;
    const now = clock();
    const joined = me.state === 'joined', admin = joined && me.role === 'admin';
    const mayAdd = joined && (!g.only_admins_add || admin);
    const mine = new Set(myBots(user).map((x) => x.id));
    const known = groupContacts(b);
    const act = (x) => `/app/groups/${g.id}/${x}`;
    const ids = `<input type="hidden" name="bot" value="${b.id}">`;
    // Who someone is to you: the name you gave them, else theirs. Your own bots go by you.
    const nameFor = (botId, person, handle) => (mine.has(botId) ? user.name || `@${handle}` : known.get(botId)?.alias ?? person ?? `@${handle}`);
    const picFor = (botId, uid, at, pic) => { const c = known.get(botId); return mine.has(botId) || (c?.approved_at && c.their_ok && !c.they_blocked) ? photoUrl(uid, at, pic) : photoUrl(null, null, pic); };

    const title = joined ? `<div class="ptitle"><h1>${esc(g.name)}</h1><details class="ptitle__edit"${nameError ? ' open' : ''}>
<summary class="iconbtn ptitle__pen" aria-label="${tr('Rename')}" title="${tr('Rename')}">${ICON.pen}</summary>
<form method="post" action="${act('rename')}" class="ptitle__form">${ids}<label class="sr" for="ptitle-in">${tr('Group name')}</label><span class="ptitle__box ptitle__box--plain"><input id="ptitle-in" name="name" value="${esc(g.name)}" required maxlength="40" autocomplete="off"${nameError ? ' aria-invalid="true" aria-describedby="ptitle-e" autofocus' : ''}></span>
<button class="btn small">${tr('Save')}</button><a class="btn small ghost" href="/app/groups/${g.id}?bot=${b.id}" data-close>${tr('Cancel')}</a>
${nameError ? `<p class="field__error ptitle__desc" id="ptitle-e" role="alert">${esc(nameError)}</p>` : ''}<p class="ptitle__desc">${tr('Everyone in the group sees the new name.')}</p></form></details></div>` : `<h1>${esc(g.name)}</h1>`;
    const head = `<div class="ghead">${title}<p class="ghead__meta">${lockBadge(encrypted, tr)}<span>${tr.n(members.filter((m) => m.state === 'joined').length, '{n} person|{n} people')}</span></p></div>`;

    // Invited: the owner's own yes (or no). A bot whose tool is too old to read the group updates first.
    const inviter = me.invited_by && me.invited_by !== b.id ? nameFor(me.invited_by, ownerName(me.invited_by), '') : '';
    const ready = groups.toolReady(b);
    const no = `<form method="post" action="${act('decline')}">${ids}<button class="btn ghost">${tr('No thanks')}</button></form>`;
    const joinCard = joined ? '' : `<section class="card"><h2>${tr('Join {name}?', { name: esc(g.name) })}</h2><p class="muted">${inviter ? `${tr('{name} invited you.', { name: esc(inviter) })} ` : ''}${tr('Your bot can then read and write in the group.')}</p>
${ready ? `<div class="actions"><form method="post" action="${act('join')}">${ids}<button class="btn">${tr('Join')}</button></form>${no}</div>`
  : `<p>${tr("Your bot's bot2bot tool needs an update first. Paste this into your bot's chat, then come back here:")}</p>${codeBlock('umsg', tr('Message for your bot'), updateMessage(), tr)}<div class="actions">${no}</div>`}</section>`;

    // What was said, oldest first, newest at the bottom. Sealed posts say so and show nothing else.
    const post = (p) => {
      const who = nameFor(p.from_bot, p.person, p.handle);
      if (p.kind === 'event') return `<li class="gsys">${esc(groupEvent(p.text, who, tr))} · ${esc(tr.ago(p.created_at, now))}</li>`;
      const out = p.from_bot === b.id;
      const text = p.body_purged_at ? `<i>${tr('Text deleted after 7 days')}</i>` : p.sealed ? `<i>${tr('End-to-end encrypted')}</i>` : p.text ? esc(p.text) : '';
      const choices = !p.sealed && !p.body_purged_at && p.choices ? JSON.parse(p.choices) : [];
      return `<li class="bubble ${out ? 'out' : 'in'}"><div class="meta">${out ? tr('You') : esc(who)} · ${esc(tr.ago(p.created_at, now))}${p.via === 'web' ? ` · ${tr('typed on the web')}` : ''}${p.kind === 'ask' ? ` · <b>${tr('question')}</b>` : ''}</div>${text ? `<div class="text">${text}</div>` : ''}${choices.length ? `<div class="choices--show">${choices.map((c) => `<span class="chip">${esc(c)}</span>`).join('')}</div>` : ''}</li>`;
    };
    // Typing here works only where no bot would get a sealed copy: the group isn't encrypted, and no member's bot
    // and yours both have keys (the relay can't seal for them).
    const sealedPair = !!b.box_pub && members.some((m) => m.state === 'joined' && m.bot_id !== b.id && m.box_pub && !m.disconnected_at && !m.removed_at);
    const canType = joined && !encrypted && !sealedPair && !b.paused_at;
    const compose = canType ? `<form method="post" action="${act('send')}" class="compose">${ids}
<label class="sr" for="gmsg">${tr('Message to {name}', { name: esc(g.name) })}</label><textarea id="gmsg" name="text" rows="2" maxlength="8000" placeholder="${tr('Message {name}', { name: esc(g.name) })}" required></textarea>
<details class="extra"><summary>${tr('Add a link or ask a question')}</summary><label>${tr('Link')}<input name="link" type="url" placeholder="https://"></label>
<label>${tr('Answer options, separated by commas')}<input name="choices" placeholder="${tr('Yes, No, Maybe')}"></label></details>
<button class="btn small">${tr('Send')}</button></form>`
      : joined && !b.paused_at ? `<p class="gtell">${encrypted ? tr('This group is end-to-end encrypted, so only the bots can read it. Tell your bot what to say.') : tr('To write here, tell your bot what to say.')}</p>` : '';
    const talk = joined ? `<section class="group" aria-labelledby="talk-h"><div class="group__head"><h2 id="talk-h">${tr('Conversation')}</h2></div><div class="card">
${posts.length ? `<ul class="thread">${posts.map(post).join('')}</ul>` : `<p class="muted">${tr('Nothing said yet.')}</p>`}${compose}</div></section>` : '';

    // Who's in it. People who aren't your contacts are one tap away from being one (they say yes on their side).
    const memberRow = (m) => {
      const self = mine.has(m.bot_id), c = known.get(m.bot_id);
      const who = m.bot_id === b.id ? tr('You') : nameFor(m.bot_id, m.name, m.handle);
      const sub = [`@${esc(m.handle)}`, m.role === 'admin' ? tr('admin') : '', m.state === 'invited' ? tr('invited') : '', !self && c && !c.their_ok ? tr('waiting for them') : ''].filter(Boolean).join(' · ');
      const asContact = joined && !self && !c && m.state === 'joined' ? `<form method="post" action="${act('contact')}">${ids}<input type="hidden" name="peer" value="${m.bot_id}"><button class="btn small ghost">${tr('Add as contact')}</button></form>` : '';
      const mem = `<input type="hidden" name="member" value="${m.bot_id}">`;
      const menu = admin && m.bot_id !== b.id ? `<details class="more"><summary class="iconbtn" aria-label="${tr('More for {name}', { name: esc(who) })}">${ICON.dots}</summary><div class="menu">
${m.state === 'joined' ? `<form method="post" action="${act('admin')}">${ids}${mem}${m.role === 'admin' ? '' : '<input type="hidden" name="on" value="1">'}<button>${m.role === 'admin' ? tr('Remove as admin') : tr('Make admin')}</button></form>` : ''}
<form method="post" action="${act('remove')}" id="rm-${m.bot_id}">${ids}${mem}<button class="danger" data-reveal>${tr('Remove from the group')}</button></form>
<div class="menu__confirm" hidden><p>${tr('Remove {name}? Only an admin can add them back.', { name: esc(who) })}</p><div class="menu__actions"><button type="button" data-unreveal>${tr('Cancel')}</button><button class="danger" form="rm-${m.bot_id}">${tr('Remove')}</button></div></div></div></details>` : '';
      return `<li class="gline"><div class="line">${avatar(who, 'md', picFor(m.bot_id, m.photo?.id, m.photo?.photo_at, m.photo?.avatar))}<span class="line__main"><span class="line__title">${esc(who)}</span><span class="line__sub">${sub}</span></span></div>${asContact || menu ? `<div class="gline__act${asContact ? ' gline__act--row' : ''}">${asContact}${menu}</div>` : ''}</li>`;
    };
    const canAdd = mayAdd ? addable(b, g.id) : [];
    const addFold = canAdd.length ? `<div class="card"><details class="fold"><summary><span class="fold__title">${tr('Add people')}</span></summary>
<form method="post" action="${act('add')}" class="stack" style="margin:0">${ids}${peoplePick(canAdd, [], tr('Your contacts'), tr)}<div><button class="btn small">${tr('Invite them')}</button></div></form></details></div>` : '';
    const link = pg.link ? `${origin}/g/${pg.link.plain_code}` : '';
    const invite = mayAdd ? `<div class="card" id="invite">${link ? `<p class="setrow__label">${tr('Invite link')}</p><p class="setrow__desc">${tr('Anyone with it can join for 7 days. They become your contact too.')}</p>${codeBlock('glink', tr('Invite link'), link, tr)}`
      : `<div class="setrow setrow--flush"><div><p class="setrow__label">${tr('Invite link')}</p><p class="setrow__desc">${tr('Anyone with it can join for 7 days. They become your contact too.')}</p></div><form method="post" action="${act('link')}">${ids}<button class="btn small ghost">${tr('Make an invite link')}</button></form></div>`}</div>` : '';
    const people = `<section class="group" aria-labelledby="ppl-h"><div class="group__head"><h2 id="ppl-h">${tr('People')} <span class="count">${members.length}</span></h2></div>
<div class="card card--list${admin ? ' card--menus' : ''}"><ul class="list">${members.map(memberRow).join('')}</ul></div>${addFold}${invite}</section>`;

    // Settings: how it wakes your bot, whether it shows on the overview; admins also who may add people, links, ending it.
    const seg = `<form method="post" action="${act('wake')}">${ids}<div class="seg seg--fit" role="group" aria-labelledby="wake-l"><div class="seg__track"><span class="seg__sel" aria-hidden="true"></span>${[['mentions', tr('Questions and mentions')], ['all', tr('Everything')], ['muted', tr('Muted')]].map(([v, l]) => `<button name="wake" value="${v}" aria-pressed="${me.wake === v}">${l}</button>`).join('')}</div></div></form>`;
    const sw = (action, id, label, desc, on) => `<form method="post" action="${action}" class="setrow">${ids}<div><p class="setrow__label" id="${id}">${label}</p>${desc ? `<p class="setrow__desc">${desc}</p>` : ''}</div>
<label class="switch"><input type="checkbox" role="switch" name="on" value="1" aria-labelledby="${id}" data-autosave${on ? ' checked' : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span></label><noscript><button class="btn small ghost">${tr('Save')}</button></noscript></form>`;
    const settings = `<section class="group" aria-labelledby="gset-h"><div class="group__head"><h2 id="gset-h">${tr('Settings')}</h2></div><div class="card card--rows">
<div class="setrow gset"><div><p class="setrow__label" id="wake-l">${tr('Wake your bot for')}</p><p class="setrow__desc">${me.wake === 'muted' ? tr('Nothing wakes it. It reads the group when it runs anyway.') : me.wake === 'all' ? tr('Every message wakes it.') : tr('Questions and messages that name it wake it. The rest waits for its next run.')}</p></div>${seg}</div>
${sw(act('hide'), 'ghide-l', tr('Hide from the overview'), '', !!pg.me.hidden)}
${admin ? sw(act('admins-add'), 'gadm-l', tr('Only admins can add people'), '', !!g.only_admins_add) : ''}
${admin ? `<div class="setrow"><div><p class="setrow__label">${tr('Turn off invite links')}</p><p class="setrow__desc">${tr('Links already shared stop working. New ones can be made.')}</p></div><form method="post" action="${act('reset-links')}">${ids}<button class="btn small ghost">${tr('Turn off')}</button></form></div>` : ''}
${joined ? `<div class="setrow"><div><p class="setrow__label">${tr('Leave the group')}</p></div>${confirmMorph({ action: act('leave'), fields: ids, label: tr('Leave'), prompt: tr('Leave {name}?', { name: g.name }), confirm: tr('Leave'), pending: tr('Leaving'), tr })}</div>` : ''}
${admin ? `<div class="setrow"><div><p class="setrow__label">${tr('End the group')}</p><p class="setrow__desc">${tr('Everyone is out and it closes for good.')}</p></div>${confirmMorph({ action: act('end'), fields: ids, label: tr('End group'), prompt: tr('End {name} for everyone?', { name: g.name }), confirm: tr('End group'), pending: tr('Ending'), tr })}</div>` : ''}
</div></section>`;
    return layout(g.name, `${head}${error ? alertBox('danger', esc(error), '') : ''}${joinCard}${talk}${people}${joined ? settings : ''}<script>${REFRESH_JS}</script>`, { user, tab: 'home', bar: { back: '/app', backLabel: tr('Overview'), bot: b.id } });
  }

  // Someone opened a member's group link. Signed out or without a bot, connecting comes first.
  function groupJoinPage(link, user, bots, { tr, code, error = '', inIt = null, old = null }) {
    const g = link.group;
    const who = ownerName(link.from_bot);
    const names = inIt ? q(`SELECT u.name, b.display_name, b.handle FROM group_members m JOIN bots b ON b.id = m.bot_id LEFT JOIN users u ON u.id = b.user_id
      WHERE m.group_id = ? AND m.state = 'joined' ORDER BY m.joined_at, m.bot_id`).all(g.id).map((x) => String(x.name || x.display_name || `@${x.handle}`).trim().split(/\s+/)[0]) : [];
    // Honest from the start: a bot without keys joining makes the group not end-to-end encrypted.
    const encrypted = groups.encrypted(g.id) && !(bots.length && bots.every((b) => !b.box_pub));
    let action;
    if (inIt) action = `<section class="card center"><h2>${tr("You're in this group")}</h2><a class="btn wide" href="/app/groups/${g.id}?bot=${inIt.id}">${tr('Open the group')}</a></section>`;
    else if (!bots.length) action = `<p class="lead lead--sm center">${tr('Connect your bot first. Then it can join the group.')}</p>
${user ? '' : `<a class="btn ghost wide" href="/login?next=${encodeURIComponent(`/g/${code}`)}">${tr('Already on bot2bot? Sign in')}</a>`}
${setupChoices(tr)}
${user ? `<p class="wait center"><span class="dot dot--live"></span> ${tr('Waiting for your bot…')}</p><script>(function poll(){ fetch('/app/status').then(r=>r.json()).then(d=>{ if(d.bots>${myBots(user).length}) location.reload(); else setTimeout(poll,2500); }).catch(()=>setTimeout(poll,4000)); })();</script>`
  : `<p class="muted center">${tr('When your bot is connected, open this link again to join.')}</p>`}`;
    else if (old) action = `<section class="card"><p>${tr("Your bot's bot2bot tool needs an update first. Paste this into your bot's chat, then come back here:")}</p>${codeBlock('umsg', tr('Message for your bot'), updateMessage(), tr)}</section>`;
    else {
      const first = bots[0];
      const known = q('SELECT 1 FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(first.id, link.from_bot);
      const names_ = !known && bots.length === 1 && link.from_bot !== first.id ? basketsOf(first.id) : [];
      action = `<section class="card"><form method="post" action="/g/${esc(code)}" class="stack" style="margin:0">
${bots.length > 1 ? `<label>${tr('Which bot')}<select name="bot">${bots.map((b) => `<option value="${b.id}">@${esc(b.handle)}</option>`).join('')}</select></label>` : `<input type="hidden" name="bot" value="${first.id}">`}
${names_.length ? basketPick(names_, '', tr) : ''}
<button class="btn wide" data-busy><span class="btn__label">${tr('Join the group')}</span><span class="btn__spin" aria-hidden="true"></span></button></form></section>`;
    }
    return layout(g.name, `<div class="center"><span class="gmark gmark--lg" aria-hidden="true">${ICON.people}</span>
<h1>${esc(g.name)}</h1><p class="muted">${tr('{name} invited you to their group chat', { name: esc(who) })}</p>
<p class="ghead__meta ghead__meta--center">${lockBadge(encrypted, tr)}${names.length ? `<span>${esc(names.join(', '))}</span>` : ''}</p></div>
${error ? `<p class="error center" role="alert">${esc(error)}</p>` : ''}${action}
<p class="muted small center">${tr('Joining also connects your bot with {name}. You can leave any time.', { name: esc(who) })}</p>`, { user, tr, width: 'narrow' });
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
    const tr = T(user);
    const wbs = webBots(user);
    const ids = wbs.map((b) => b.id);
    const ph = ids.map(() => '?').join(',');
    const now = clock();
    const paused = wbs.some((b) => b.paused_at);
    const people = q(`SELECT c.owner_bot, c.peer_bot, c.alias, c.blocked, c.approved_at, back.approved_at AS their_ok, b.handle, b.vendor, u.name, u.email_verified_at,
        (SELECT max(created_at) FROM messages m WHERE m.group_id IS NULL AND ((m.from_bot = c.owner_bot AND m.to_bot = c.peer_bot) OR (m.from_bot = c.peer_bot AND m.to_bot = c.owner_bot))) AS last_at
      FROM contacts c JOIN bots b ON b.id = c.peer_bot LEFT JOIN users u ON u.id = b.user_id LEFT JOIN contacts back ON back.owner_bot = c.peer_bot AND back.peer_bot = c.owner_bot
      WHERE c.owner_bot IN (${ph}) AND c.approved_at IS NOT NULL ORDER BY last_at IS NULL, last_at DESC, c.alias`).all(...ids);
    const thread = (c) => q(`SELECT * FROM (SELECT * FROM messages WHERE kind != 'probe' AND group_id IS NULL AND ((from_bot = ? AND to_bot = ?) OR (from_bot = ? AND to_bot = ?)) ORDER BY created_at DESC LIMIT 12) ORDER BY created_at`)
      .all(c.owner_bot, c.peer_bot, c.peer_bot, c.owner_bot);
    const bubble = (m, c) => {
      const mine = m.from_bot === c.owner_bot;
      const choices = m.choices ? JSON.parse(m.choices) : [];
      const answered = !mine && m.kind === 'ask' && q('SELECT text FROM messages WHERE reply_to = ? ORDER BY created_at LIMIT 1').get(m.id);
      const links = m.body_purged_at ? [] : JSON.parse(m.links);
      const how = mine ? '' : m.via === 'web' ? tr('typed on the web') : c.vendor === 'web' ? tr('via their inbox') : tr('via their bot');
      return `<li class="bubble ${mine ? 'out' : 'in'}"><div class="meta">${mine ? tr('You') : esc(c.alias)} · ${tr.ago(m.created_at, now)}${how ? ` · ${how}` : ''}${m.kind === 'ask' ? ` · <b>${tr('question')}</b>` : ''}${mine ? ` · ${m.replied_at ? tr('answered') : m.status === 'delivered' ? tr('seen') : m.status === 'dropped' ? tr('not delivered') : tr('sent')}` : ''}</div>
<div class="text">${m.body_purged_at ? `<i>${tr('Text deleted after 7 days')}</i>` : esc(m.text)}</div>
${links.map((l) => `<a class="ext" href="${esc(l)}" rel="noopener noreferrer nofollow" target="_blank">${esc(l.replace(/^https?:\/\//, '').slice(0, 60))}</a>`).join('')}
${!mine && m.kind === 'ask' && !answered && !m.body_purged_at && !c.blocked ? `<form method="post" action="/app/inbox/send" class="choices"><input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}"><input type="hidden" name="reply_to" value="${esc(m.id)}">
${(choices.length ? choices : [tr('Yes'), tr('No')]).map((ch) => `<button class="chip" name="text" value="${esc(ch)}">${esc(ch)}</button>`).join('')}</form>` : ''}
${answered ? `<div class="answered">${tr('You answered: <b>{text}</b>', { text: esc(answered.text) })}</div>` : ''}</li>`;
    };
    const lastAsk = (c, msgs) => [...msgs].reverse().find((m) => m.from_bot === c.peer_bot && m.kind === 'ask' && !m.replied_at && !m.body_purged_at);
    const cards = people.map((c) => {
      const msgs = thread(c);
      const ask = lastAsk(c, msgs);
      const ids_ = `<input type="hidden" name="bot" value="${c.owner_bot}"><input type="hidden" name="peer" value="${c.peer_bot}">`;
      return `<section class="card convo" id="c-${c.peer_bot}"><div class="card__head"><div><h2>${esc(c.alias)}</h2><p class="muted small">${c.name && c.name.toLowerCase() !== c.alias.toLowerCase() ? `${esc(c.name)} · ` : ''}@${esc(c.handle)} ${verifiedPill(c.email_verified_at, tr)}</p></div>
${c.blocked ? badge(tr('Blocked')) : !c.their_ok ? badge(tr('Waiting for them'), 'warning') : ''}</div>
${msgs.length ? `<ul class="thread">${msgs.map((m) => bubble(m, c)).join('')}</ul>` : `<p class="muted">${tr('No messages yet. Say hi.')}</p>`}
${c.blocked || paused ? '' : `<form method="post" action="/app/inbox/send" class="compose">${ids_}${ask ? `<input type="hidden" name="reply_to" value="${esc(ask.id)}">` : ''}
<label class="sr" for="t-${c.peer_bot}">${tr('Message to {name}', { name: esc(c.alias) })}</label><textarea id="t-${c.peer_bot}" name="text" rows="2" maxlength="8000" placeholder="${ask ? tr('Answer in your own words') : tr('Message {name}', { name: esc(c.alias) })}" required></textarea>
<details class="extra"><summary>${tr('Add a link or ask a question')}</summary><label>${tr('Link')}<input name="link" type="url" placeholder="https://"></label>
<label>${tr('Answer options, separated by commas')}<input name="choices" placeholder="${tr('Yes, No, Maybe')}"></label></details>
<button class="btn small">${tr('Send')}</button></form>`}</section>`;
    }).join('');
    return layout(tr('Inbox'), `${paused ? alertBox('info', tr('Everything is paused'), tr("No emails, and you can't send. Messages still show up here."), `<form method="post" action="/app/pause"><input type="hidden" name="on" value="0"><button class="btn small">${tr('Resume')}</button></form>`) : ''}
${error ? alertBox('danger', esc(error), '') : ''}
${cards ? `<div class="convos">${cards}</div><p class="muted small">${tr('Not end-to-end encrypted. You read these on the web, so they pass through our server in a form we could read. They are deleted 7 days after you see them.')}</p>` : `<section class="card">${emptyState('inbox', tr('Your inbox is empty'), tr('When friends connect with you, their messages and questions show up here.'))}</section>`}`,
      { user, tab: 'inbox', bar: { title: tr('Inbox') },
        actions: wbs.length ? `<a class="btn ghost" href="/app/bots/${wbs[0].id}">${tr('Let Grok Bot handle this')}</a>` : '' });
  }

  // Onboarding: everyone picks a picture before the dashboard. A sticker from the set, or their own photo.
  // Computers first, then everyone else. The drawn robots aren't offered any more; whoever has one keeps it.
  function picturePage(user, next, { error = '', nameError = '' } = {}) {
    const tr = T(user);
    const set = [...stickers().values()];
    const machines = set.filter((x) => x.machine), others = set.filter((x) => !x.machine);
    const starters = machines.length ? machines : set;
    const pick = ROBOT.has(user.avatar) || isSticker(user.avatar) ? user.avatar : user.photo ? '' : starters.length ? `sticker:${starters[user.id % starters.length].key}` : ROBOTS[user.id % ROBOTS.length].key;
    const face = ROBOT.has(pick) ? ROBOT_SVG.get(pick) : `<img src="${esc(photoUrl(user.id, user.photo_at, pick))}" alt="">`;
    const first = hasPicture(user);
    const opt = (value, art, name, cut = false) => `<label class="pfp__opt"><input type="radio" name="avatar" value="${esc(value)}"${value === pick ? ' checked' : ''}><span class="pfp__img${cut ? ' pfp__img--cut' : ''}">${art}</span><span class="sr">${esc(name)}</span></label>`;
    const part = (legend, xs) => xs.length ? `<fieldset class="pfp__set"><legend class="pfp__legend">${legend}</legend><div class="pfp__grid">${xs.map((x) => opt(`sticker:${x.key}`, `<img src="/stickers/${esc(x.key)}.png" alt="" loading="lazy" decoding="async">`, x.name, true)).join('')}</div></fieldset>` : '';
    // Without a sticker list the drawn robots are still the choice.
    const sheet = set.length ? part(tr('Computers'), machines) + part(tr('Stickers'), others)
      : `<fieldset class="pfp__set"><legend class="sr">${tr('Robots')}</legend><div class="pfp__grid">${ROBOTS.map((r) => opt(r.key, ROBOT_SVG.get(r.key), tr(r.name))).join('')}</div></fieldset>`;
    return layout(tr('Your picture'), `<form method="post" action="/app/picture" class="pfp" data-pick>
<input type="hidden" name="next" value="${esc(next)}"><input type="hidden" name="photo">
<div class="pfp__head"><span class="pfp__face" data-face${isSticker(pick) ? ' data-cut' : ''}>${face}</span><h1>${first ? tr('Change your picture') : tr('Your name and picture')}</h1><p class="pagehead__sub">${tr('Friends see them when you invite them. You can change both any time in Settings.')}</p></div>
${first ? '' : `<div class="pfp__name">${field({ label: tr('Your name'), name: 'name', value: user.name_set_at ? user.name : '', description: tr('What friends know you as.'), error: nameError, attrs: 'required maxlength="40" autocomplete="name" autofocus' })}</div>`}
${sheet}
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}<p class="error" role="alert" data-photo-error hidden>${tr("That photo couldn't be opened. Try a JPEG or PNG.")}</p>
<div class="pfp__foot"><input type="file" accept="image/*" hidden tabindex="-1" aria-hidden="true" data-own-file><button type="button" class="btn ghost" data-own hidden>${ICON.photo}${tr('Upload a photo')}</button>
<button class="btn" data-busy><span class="btn__label">${first ? tr('Save') : tr('Continue')}</span><span class="btn__spin" aria-hidden="true"></span></button></div></form>`, { user, width: 'narrow', bar: !first ? {} : { back: next, backLabel: next.startsWith('/app/account') ? tr('Settings') : tr('Back') } });
  }

  // Arc settings: one group per section, label and description on the left, the control on the right.
  // What the owner hid from the overview (groups and baskets), each with a way to show it again. Only when there's any.
  function hiddenCard(user, tr) {
    const ids = myBots(user).map((b) => b.id);
    const gs = groups ? groups.forUser(user.id, { all: true }).filter((r) => r.hidden) : [];
    const bs = inPilot(user) && ids.length ? q(`SELECT name_key, min(name) AS name FROM circles WHERE owner_bot IN (${ids.map(() => '?').join(',')}) AND hidden = 1 GROUP BY name_key ORDER BY min(position), name_key`).all(...ids) : [];
    if (!gs.length && !bs.length) return '';
    const back = '<input type="hidden" name="back" value="/app/account">';
    const row = (label, kind, action, fields) => `<div class="setrow"><div><p class="setrow__label">${label}</p><p class="setrow__desc">${kind}</p></div><form method="post" action="${action}">${fields}${back}<button class="btn small ghost">${tr('Show')}</button></form></div>`;
    return `<section class="group" aria-labelledby="hidden-h"><h2 id="hidden-h">${tr('Hidden from your overview')}</h2><div class="card card--rows">
${gs.map((r) => row(`<a class="link" href="/app/groups/${r.id}?bot=${r.bot_id}">${esc(r.name)}</a>`, tr('Group'), `/app/groups/${r.id}/hide`, `<input type="hidden" name="bot" value="${r.bot_id}">`)).join('')}
${bs.map((g) => row(`<span class="hand basket-word">${esc(g.name)}</span>`, tr('Basket'), '/app/baskets/hide', `<input type="hidden" name="basket" value="${esc(g.name_key)}">`)).join('')}</div></section>`;
  }
  // Files: on for everyone who has them (each owner can turn them off). The allowance is the plan's; paying isn't open yet.
  function filesCard(user, tr) {
    if (!files?.inAlpha(user)) return '';
    const p = files.plan(user);
    const mb = Math.round(p.maxBytes / files.MB);
    const until = p.promoUntil && new Date(p.promoUntil - 1).toLocaleDateString(tr.lang === 'cs' ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/Prague' });
    const allowance = p.free
      ? `${until ? tr('Free plan: {n} files a day, up to {mb} MB each until {date} (usually {usual} MB).', { n: p.perDay, mb, date: until, usual: Math.round(p.usualBytes / files.MB) }) : tr('Free plan: {n} files a day, up to {mb} MB each.', { n: p.perDay, mb })} ${tr('Paid plan is coming soon.')}`
      : tr('Your plan: {n} files a day, up to {mb} MB each.', { n: p.perDay, mb });
    const on = files.isOn(user);
    const art = filesArt();
    return `<section class="group" aria-labelledby="files-h"><h2 id="files-h">${tr('Files')}</h2><div class="card card--files">${art}
<form method="post" action="/app/account/files" class="setrow setrow--flush" id="files"><div><p class="setrow__label" id="files-l">${tr('Send files')} ${badge(tr('New'), 'neutral')}</p><p class="setrow__desc">${tr('Your bot can send and receive files, end-to-end encrypted. Each file is deleted once it arrives.')}</p>
${on ? `<p class="setrow__desc">${esc(allowance)}</p>` : ''}</div>
<label class="switch"><input type="checkbox" role="switch" name="on" value="1" aria-labelledby="files-l" data-autosave${on ? ' checked' : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span></label><noscript><button class="btn small ghost">${tr('Save')}</button></noscript></form></div></section>`;
  }
  function accountPage(user, { error = '', quietError = '', nameError = '' } = {}) {
    const tr = T(user);
    const quietNow = quietUntil(user, clock());
    // Arc segmented control: each language says its own name, and picking one saves it.
    const langPick = `<form method="post" action="/app/account/lang" data-reload><div class="seg" role="group" aria-labelledby="lang-l"><div class="seg__track"><span class="seg__sel" aria-hidden="true"></span>${[['en', 'English'], ['cs', 'Čeština']].map(([v, name]) => `<button name="lang" value="${v}" lang="${v}" aria-pressed="${tr.lang === v}">${name}</button>`).join('')}</div></div></form>`;
    const themePick = `<form method="post" action="/app/account/theme" data-theme-pick><div class="seg" role="group" aria-labelledby="theme-l"><div class="seg__track"><span class="seg__sel" aria-hidden="true"></span>${[['', tr('Auto')], ['light', tr('Light')], ['dark', tr('Dark')]].map(([v, name]) => `<button name="theme" value="${v}" aria-pressed="${(user.theme || '') === v}">${name}</button>`).join('')}</div></div></form>`;
    return layout(tr('Settings'), `<section class="group" aria-labelledby="you-h"><h2 id="you-h">${tr('You')}</h2><div class="card card--rows">
<div class="setrow"><div class="me">${avatar(user.name || user.email, 'lg', photoUrl(user.id, user.photo_at, user.avatar))}<div><p class="setrow__label">${esc(user.name)}</p><p class="setrow__desc">${esc(user.email)}</p></div></div>${verifiedPill(user.email_verified_at, tr)}</div>
<form method="post" action="/app/account/name" class="setrow"><div class="grow">${field({ label: tr('Your name'), name: 'name', value: user.name, description: tr('Friends see it when you invite them.'), error: nameError, attrs: 'required maxlength="40" autocomplete="name"' })}</div><button class="btn small ghost">${tr('Save')}</button></form>
<div class="setrow"><div><p class="setrow__label">${tr('Profile picture')}</p><p class="setrow__desc">${tr('Only friends you said yes to can see it.')}</p></div><a class="btn small ghost" href="/app/picture?next=/app/account">${tr('Change')}</a></div>
<div class="setrow"><div><p class="setrow__label" id="lang-l">${tr('Language')}</p></div>${langPick}</div>
<div class="setrow"><div><p class="setrow__label" id="theme-l">${tr('Appearance')}</p></div>${themePick}</div>
<div class="setrow"><p class="setrow__desc">${tr('Friends see your name, your picture and that your email is verified. They never see the address itself.')}</p></div>
${hosted ? `<div class="setrow"><div><p class="setrow__label">${tr('Plan')}</p><p class="setrow__desc">${tr('What you can send and who your plan covers.')}</p></div><a class="btn small ghost" href="/app/billing">${tr('See my plan')}</a></div>` : ''}</div></section>
${hiddenCard(user, tr)}<section class="group" aria-labelledby="quiet-h"><h2 id="quiet-h">${tr('Quiet hours')}</h2><div class="card">
<form method="post" action="/app/account/quiet" class="quietform">
<div class="setrow setrow--flush"><div><p class="setrow__label" id="quiet-l">${tr('Quiet hours')}</p><p class="setrow__desc">${tr('Nobody can wake your bot or email you during these hours. Messages wait and arrive when they end.')}</p></div>
<label class="switch"><input type="checkbox" role="switch" name="on" value="1" aria-labelledby="quiet-l" data-autosave${user.quiet_on ? ' checked' : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span></label></div>
${quietError ? `<p class="error" role="alert">${esc(quietError)}</p>` : ''}${!user.tz ? `<p class="muted small">${tr("Pick your time zone so we know when it's night for you.")}</p>` : ''}
<div class="row3"><label>${tr('From')}<input type="time" name="start" value="${hhmm(user.quiet_start ?? 1320)}" required></label><label>${tr('To')}<input type="time" name="end" value="${hhmm(user.quiet_end ?? 480)}" required></label>
<label>${tr('Time zone')}<select name="tz">${Intl.supportedValuesOf('timeZone').map((z) => `<option${z === (user.tz || 'UTC') ? ' selected' : ''}>${z}</option>`).join('')}</select></label></div>
<div><button class="btn small ghost">${tr('Save times')}</button></div></form>
${quietNow ? `<p class="muted small">${tr("It's quiet time now. Messages wait until {time}.", { time: hhmm(user.quiet_end) })}</p>` : ''}</div></section>
${filesCard(user, tr)}
<section class="group" aria-labelledby="data-h"><h2 id="data-h">${tr('Your data')}</h2><div class="card card--rows">
<div class="setrow"><div><p class="setrow__label">${tr('Download my data')}</p><p class="setrow__desc">${tr("Message text is deleted 7 days after delivery. Messages that can't be delivered expire after 7 days. The activity log is kept for 90 days.")}</p></div><a class="btn small ghost" href="/app/account/export">${tr('Download')}</a></div>
</div></section>
<section class="group"><div class="card danger-zone"><details class="fold"${error ? ' open' : ''}><summary><span><span class="fold__title">${tr('Delete my account')}</span><span class="fold__sub">${tr('Disconnects your bots and erases message text')}</span></span></summary>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<p>${tr("This disconnects your bots, removes your contacts and erases message text. Copies your friends' bots already received stay with them.")}</p>
<form method="post" action="/app/account/delete" class="stack"><label>${tr('Type {email} to confirm', { email: esc(user.email) })}<input name="confirm" autocomplete="off" required></label><div><button class="btn danger">${tr('Delete my account')}</button></div></form></details></div></section>`, { user, tab: 'account', width: 'read', bar: { title: tr('Settings') } });
  }

  function exportData(user) {
    const bots = myBots(user, { all: true });
    const ids = bots.map((b) => b.id);
    const ph = ids.map(() => '?').join(',') || 'NULL';
    return {
      exported_at: iso(clock()),
      account: { name: user.name, email: user.email, created_at: iso(user.created_at), email_verified_at: iso(user.email_verified_at), photo: user.photo ? `data:image/jpeg;base64,${Buffer.from(user.photo).toString('base64')}` : null, robot: user.avatar || null },
      bots: bots.map((b) => ({ handle: b.handle, created_at: iso(b.created_at), doorbell: !!b.webhook_url, paused: !!b.paused_at, disconnected_at: iso(b.disconnected_at), removed_at: iso(b.removed_at) })),
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
    const ids = myBots(user, { all: true }).map((b) => b.id);
    const ph = ids.map(() => '?').join(',') || 'NULL';
    const t = clock();
    tx(() => {
      for (const id of ids) bumpGen(id);
      governance?.deleteDataInTx(ids);
      files?.forgetBots(ids);
      for (const id of ids) events?.revokeAll(id);
      q(`UPDATE bots SET token_hash = NULL, webhook_url = NULL, webhook_key = NULL, doorbell_kind = NULL, doorbell_verified_at = NULL, paused_at = NULL, disconnected_at = coalesce(disconnected_at, ?), display_name = 'Deleted user' WHERE id IN (${ph})`).run(t, ...ids);
      q(`DELETE FROM contacts WHERE owner_bot IN (${ph}) OR peer_bot IN (${ph})`).run(...ids, ...ids);
      erase(`from_bot IN (${ph}) OR to_bot IN (${ph})`, ...ids, ...ids);
      q('UPDATE feedback SET user_id = NULL WHERE user_id = ?').run(user.id); // feedback stays, without who sent it
      board?.forgetUser(user.id); // board posts stay under "Deleted user", with no more emails
      usage?.forgetUser(user.id);
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
  const govBots = (u) => inPilot(u) ? liveBots(u).filter((b) => b.vendor !== 'web' && !isSender(b)) : [];
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
  const faceSql = `SELECT c.peer_bot, c.alias, c.approved_at, pb.handle, pb.user_id AS peer_owner, back.approved_at AS their_ok, back.blocked AS they_blocked, u.id AS peer_user, u.photo_at, u.avatar
    FROM contacts c JOIN bots pb ON pb.id = c.peer_bot LEFT JOIN users u ON u.id = pb.user_id
    LEFT JOIN contacts back ON back.owner_bot = c.peer_bot AND back.peer_bot = c.owner_bot WHERE c.owner_bot = ?`;
  const picOf = (x) => (x.their_ok && !x.they_blocked ? photoUrl(x.peer_user, x.photo_at, x.avatar) : '');
  function peopleOf(b) {
    const s = getSettings(b.id);
    // The owner's other bots aren't people to sort: they always talk to each other.
    const extra = new Map(q(faceSql).all(b.id).filter((r) => !b.user_id || r.peer_owner !== b.user_id).map((r) => [r.peer_bot, r]));
    // Contacts still waiting for the owner's yes are decided on the overview; People shows them faded until then.
    const people = s.contacts.filter((c) => extra.get(c.peer_bot)?.approved_at)
      .map((c) => ({ ...c, pic: picOf(extra.get(c.peer_bot)), waiting: !extra.get(c.peer_bot).their_ok })).sort((x, y) => x.alias.localeCompare(y.alias));
    const unconfirmed = s.contacts.filter((c) => extra.has(c.peer_bot) && !extra.get(c.peer_bot).approved_at).sort((x, y) => x.alias.localeCompare(y.alias));
    return { ...s, people, unconfirmed };
  }
  // Invites nobody has used yet: ones the bot made, and ones saved from Invite a friend (opening it and going back makes nothing).
  const openInvites = (botIds) => botIds.length ? q(`SELECT i.*, b.handle FROM invites i JOIN bots b ON b.id = i.from_bot WHERE i.from_bot IN (${botIds.map(() => '?').join(',')})
    AND i.used_at IS NULL AND i.expires_at > ? AND (i.by_owner = 0 OR (i.plain_code IS NOT NULL AND i.saved_at IS NOT NULL)) ORDER BY i.created_at DESC`).all(...botIds, clock()) : [];
  function peerFace(botId, peerId, tr) {
    const r = q(`${faceSql} AND c.peer_bot = ?`).get(botId, peerId);
    if (r) return { alias: r.alias, pic: picOf(r) };
    const pb = q('SELECT handle FROM bots WHERE id = ?').get(peerId);
    return { alias: pb ? `@${pb.handle}` : tr('Someone'), pic: '' };
  }
  const TILTS = [-4, 3, -2, 5, -5, 2, 4, -3, 1, -1];
  // A sticker: the picture cut out (one from the sticker set) or on a disc with a white edge (a robot, a photo,
  // or just the initial). No name until hover, keyboard focus or a long press; screen readers get the label.
  const stickerArt = (name, src) => String(src).startsWith('/stickers/')
    ? `<img class="stk__img" src="${esc(src)}" alt="" draggable="false" decoding="async">`
    : `<span class="stk__img stk__disc">${src ? `<img src="${esc(src)}" alt="" draggable="false" decoding="async">` : `<span class="stk__initial">${esc(String(name || '?').trim().slice(0, 1).toUpperCase())}</span>`}</span>`;
  const sticker = ({ seed = 0, name, src = '', href = '', label = name, data = '', note = true, wait = false }) => {
    const inner = `${stickerArt(name, src)}${note ? `<span class="stk__name" aria-hidden="true">${esc(String(name).toLowerCase())}</span>` : ''}`;
    const style = `--tilt:${TILTS[seed % TILTS.length]}deg`, cls = wait ? 'stk stk--wait' : 'stk';
    return href ? `<a class="${cls}" href="${esc(href)}" draggable="false" aria-label="${esc(label)}" style="${style}"${data}>${inner}</a>`
      : `<span class="${cls}" role="img" aria-label="${esc(label)}" style="${style}"${data}>${inner}</span>`;
  };
  // Hand-drawn marks from the sticker sheet: a question mark for "asks you first", a clock for "waiting", a cross, an arrow.
  const HAND = {
    wait: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8.2 2.4c3.2-.1 5.5 2.4 5.4 5.6-.1 3.1-2.6 5.6-5.7 5.5C4.8 13.4 2.4 11 2.5 7.9 2.6 5 4.9 2.6 7.6 2.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M8 5v3.3l2.2 1.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    check: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.6c1.2 1 2.1 2 2.9 3.2C7.6 8.4 9.9 5.6 13.2 3.4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    ask: '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.6 5.8c.1-1.6 1.3-2.6 2.6-2.5 1.5.1 2.4 1.1 2.3 2.3-.1 1.4-1.4 1.8-2.1 2.6-.4.4-.4 1-.4 1.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="12.6" r="1.05" fill="currentColor"/></svg>',
    x: '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m3 3 6 6M9 3 3 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    arrow: '<svg viewBox="0 0 34 30" fill="none" aria-hidden="true"><path d="M30 4C22 4 12 8 8 22" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M3.5 16.5 8 23l5.5-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  // The relay's validation messages are written for bots; the owner gets these (in Czech too: see CS_MESSAGES).
  const ownerError = (e, tr) => tr.msg(({
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
  })[e.message] || e.message.replace(/^\w/, (x) => x.toUpperCase()).replace(/([^.])$/, '$1.'));
  const basketMenu = (b, g, tr) => `<details class="more bmenu"><summary class="iconbtn" aria-label="${tr('Change the {name} basket', { name: esc(g.name) })}">${ICON.dots}</summary><div class="menu">
<form method="post" action="/app/people/baskets" class="bmenu__rename"><input type="hidden" name="bot" value="${b.id}"><input type="hidden" name="circle" value="${g.id}"><label class="sr" for="rn-${g.id}">${tr('New name')}</label><input id="rn-${g.id}" name="name" value="${esc(g.name)}" maxlength="24" required autocomplete="off"><button>${tr('Rename')}</button></form>
<form method="post" action="/app/people/mode" class="bmenu__mode"><input type="hidden" name="bot" value="${b.id}"><input type="hidden" name="circle" value="${g.id}"><input type="hidden" name="mode" value="${g.mode === 'asks' ? 'handles' : 'asks'}"><button role="menuitemcheckbox" aria-checked="${g.mode === 'asks'}">${tr('Asks you first')}<span class="bmenu__sw" aria-hidden="true"></span></button></form>
${g.is_default ? '' : `<form method="post" action="/app/people/baskets" id="del-${g.id}"><input type="hidden" name="bot" value="${b.id}"><input type="hidden" name="circle" value="${g.id}"><input type="hidden" name="delete" value="1"><button class="danger" data-reveal>${tr('Remove basket')}</button></form>
<div class="menu__confirm" hidden><p>${tr('Everyone in it goes back to not sorted yet, so your bot asks you first.')}</p><div class="menu__actions"><button type="button" data-unreveal>${tr('Cancel')}</button><button class="danger" form="del-${g.id}">${tr('Remove')}</button></div></div>`}</div></details>`;
  const asksTag = (tr) => `<span class="tag" data-mode="asks">${HAND.ask}<span>${tr('asks you first')}</span></span>`;
  const waitTag = (n, tr) => `<span class="tag" data-mode="wait">${HAND.wait}<span>${tr.n(n, '{n} waiting|{n} waiting')}</span></span>`;

  function peoplePage(user, b, { error = '' } = {}) {
    const tr = T(user);
    const s = peopleOf(b);
    const bots = govBots(user);
    const ids = `<input type="hidden" name="bot" value="${b.id}">`;
    const count = (n) => tr.n(n, '{n} person|{n} people');
    const where = (c) => (c.circle ? tr('in {basket}', { basket: c.circle.name }) : tr('not sorted yet'));
    const waitSaid = (c) => (c.waiting ? `, ${tr('waiting for them')}` : '');
    const stk = (c) => sticker({ seed: c.peer_bot, name: c.alias, src: c.pic, href: `/app/people/${b.id}/${c.peer_bot}`, label: `${c.alias}, ${where(c)}${waitSaid(c)}`, wait: c.waiting,
      data: ` data-peer="${c.peer_bot}" data-name="${esc(c.alias)}" data-in="${c.circle?.id ?? ''}"` });
    // Not connected yet, so not movable: invites nobody has used (in the basket they'll land in), and people waiting for your yes on the overview.
    const circleNamed = (name) => (name ? s.circles.find((g) => g.name.toLowerCase() === String(name).toLowerCase()) ?? null : null);
    const held = [...s.unconfirmed.map((c) => ({ seed: c.peer_bot, alias: c.alias, circle: c.circle, href: '/app', said: tr('waiting for your yes') })),
      ...openInvites([b.id]).filter((i) => !i.alias.startsWith('friend-') || i.notes).map((i) => ({ seed: i.created_at || 0, alias: i.alias.startsWith('friend-') ? i.notes.slice(0, 32) : i.alias, circle: circleNamed(i.basket),
        href: i.plain_code ? `/app/invites/${i.plain_code}` : '', said: tr('waiting for them') }))];
    const heldStk = (h) => sticker({ seed: h.seed, name: h.alias, href: h.href, label: `${h.alias}, ${where(h)}, ${h.said}`, wait: true, data: ' data-held' });
    const waitingIn = (id) => s.people.filter((c) => c.waiting && (c.circle?.id ?? null) === id).length + held.filter((h) => (h.circle?.id ?? null) === id).length;
    const loose = s.people.filter((c) => !c.circle), looseHeld = held.filter((h) => !h.circle), looseWait = waitingIn(null);
    const pool = `<div class="pool" data-drop="" aria-label="${tr('Not sorted yet, {count}', { count: count(loose.length) })}"><span class="pool__label" aria-hidden="true"><span class="hand">${tr('not sorted yet')}</span>${loose.length ? asksTag(tr) : ''}${looseWait ? waitTag(looseWait, tr) : ''}</span>
${loose.map(stk).join('')}${looseHeld.map(heldStk).join('')}${loose.length ? `<span class="pool__hint hand" aria-hidden="true"><span class="js-only">${tr('drag them into a basket')}</span><span class="no-js">${tr('tap someone to sort them')}</span>${HAND.arrow}</span>`
  : looseHeld.length ? '' : `<span class="pool__empty hand">${s.people.length || held.length ? tr('everyone’s sorted') : tr('nobody here yet')}</span>`}</div>`;
    const basket = (g) => {
      const inside = s.people.filter((c) => c.circle?.id === g.id), waits = waitingIn(g.id);
      return `<section class="basket" data-drop="${g.id}" data-mode="${g.mode}" aria-label="${esc(g.name)}, ${count(inside.length)}${g.mode === 'asks' ? `, ${tr('asks you first')}` : ''}">
<div class="basket__head"><h2 class="basket__name hand">${esc(g.name)}</h2>${basketMenu(b, g, tr)}</div>${g.mode === 'asks' || waits ? `<div class="basket__tag">${g.mode === 'asks' ? asksTag(tr) : ''}${waits ? waitTag(waits, tr) : ''}</div>` : ''}
<div class="pile">${inside.map(stk).join('')}${held.filter((h) => h.circle?.id === g.id).map(heldStk).join('')}</div></section>`;
    };
    const add = s.circles.length >= 12 ? '' : `<form method="post" action="/app/people/baskets" class="basket basket--new" style="--span3:span ${3 - (s.circles.length % 3)};--span2:span ${2 - (s.circles.length % 2)}">${ids}<label class="sr" for="nb">${tr('Name a new basket')}</label><input id="nb" name="name" maxlength="24" required autocomplete="off" placeholder="${tr('+ new basket')}"><button class="nb__add">${tr('Add')}</button></form>`;
    const pick = bots.length > 1 ? `<nav class="botpick" aria-label="${tr('Which bot')}">${bots.map((x) => `<a href="/app/people?bot=${x.id}"${x.id === b.id ? ' aria-current="page"' : ''}>@${esc(x.handle)}</a>`).join('')}</nav>` : '';
    const invite = s.people.length || held.length ? '' : `<form method="post" action="/app/invites" class="people__invite"><input type="hidden" name="bot" value="${b.id}"><p>${tr('When someone connects with you, they land here.')}</p><button class="btn small ghost">${ICON.invite}${tr('Invite a friend')}</button></form>`;
    const data = JSON.stringify({ bot: b.id, baskets: s.circles.map((g) => ({ id: g.id, name: g.name, mode: g.mode })) }).replace(/</g, '\\u003c');
    return layout(tr('People'), `${error ? alertBox('danger', esc(error), '') : ''}<section class="sheet people" id="people-board" aria-label="${tr('Your baskets')}">
${pick}${pool}${invite}<div class="baskets">${s.circles.map(basket).join('')}${add}</div>
<p class="people__how">${tr("Your bot handles each basket on its own and asks you when it isn't sure.")}</p>
<p class="sr" id="stk-help">${tr('Press Enter to move them to another basket, or Space to open their page.')}</p>
<script type="application/json" id="people-data">${data}</script></section><script>${peopleJs(tr)}</script>`, { user, tab: 'people', bar: { title: tr('People') } });
  }

  // One person: their basket, what they can ask about, notes for the bot, and rules (learned ones say so).
  const daysSaid = (tr) => ({ mon: tr('Mondays'), tue: tr('Tuesdays'), wed: tr('Wednesdays'), thu: tr('Thursdays'), fri: tr('Fridays'), sat: tr('Saturdays'), sun: tr('Sundays') });
  const ruleText = (r, tr) => {
    if (!(r.source === 'learned' && r.topic && r.days)) return r.text;
    const said = { topic: r.topic, days: r.days.map((d) => daysSaid(tr)[d] || d).join(tr(' and ')) };
    return r.answer === 'share' ? tr('Shares {topic} on {days}', said) : tr("Doesn't share {topic} on {days}", said);
  };
  function personPage(user, b, peerId, { error = '' } = {}) {
    const tr = T(user);
    const s = peopleOf(b);
    const c = s.people.find((x) => x.peer_bot === Number(peerId));
    if (!c) throw new HttpError(404, 'Contact not found');
    const base = `/app/people/${b.id}/${c.peer_bot}`;
    // The switch is theirs alone; when the basket (or not being sorted yet) already asks first, it shows that and waits.
    const own = c.mode_override === 'asks', held = !own && c.effective_mode === 'asks';
    const modeLine = own ? tr('Your bot asks you before it answers {name}.', { name: esc(c.alias) })
      : !c.circle ? tr("{name} isn't in a basket yet, so your bot asks you first.", { name: esc(c.alias) })
      : held ? tr('Your bot asks you first for everyone in {basket}.', { basket: `<span class="hand basket-word">${esc(c.circle.name)}</span>` })
      : tr("Your bot handles it and asks you when it isn't sure.");
    const chip = (v, name, on, asks) => `<label class="bchip"><input type="radio" name="circle" value="${v}"${on ? ' checked' : ''} data-autosave><span class="hand">${esc(name)}</span>${asks ? `<span class="bchip__ask" aria-label="${tr('asks you first')}" title="${tr('asks you first')}">${HAND.ask}</span>` : ''}</label>`;
    const rules = c.rules.map((r) => `<li class="rule${(r.source === 'learned' || r.via === 'bot') && !r.owner_seen_at ? ' is-new' : ''}"><span class="rule__text">${esc(ruleText(r, tr))}</span>
<span class="rule__meta">${r.source === 'learned' ? `<span class="hand">${tr('learned')}</span><span>${tr('from your answers')}</span>` : r.via === 'bot' ? `<span>${tr('Added by your bot')}</span>` : `<span>${tr('Set by you')}</span>`}</span>
${!r.owner_seen_at && (r.source === 'learned' || r.via === 'bot') ? `<form method="post" action="${base}/rules"><input type="hidden" name="seen" value="${esc(r.id)}"><button class="link">${tr('Seen')}</button></form>` : ''}
<form method="post" action="${base}/rules"><input type="hidden" name="remove" value="${esc(r.id)}"><button class="link" aria-label="${tr('Remove rule: {rule}', { rule: esc(ruleText(r, tr)) })}">${tr('Remove')}</button></form></li>`).join('');
    return layout(c.alias, `${error ? alertBox('danger', esc(error), '') : ''}<section class="sheet person" aria-labelledby="person-h">
<div class="person__art">${sticker({ seed: c.peer_bot, name: c.alias, src: c.pic, label: c.alias, note: false })}<div class="person__names"><h1 class="person__name hand" id="person-h">${esc(c.alias)}</h1>${c.purpose ? `<p class="person__note hand">${esc(c.purpose)}</p>` : ''}<p class="person__handle handle">${esc(c.handle)}</p></div></div>
<div class="person__body">
<form method="post" action="${base}/basket" class="pblock" id="basket"><fieldset class="bchips"><legend class="row-label">${tr('Basket')}</legend>
${chip('', tr('not sorted yet'), !c.circle, true)}${s.circles.map((g) => chip(g.id, g.name, c.circle?.id === g.id, g.mode === 'asks')).join('')}</fieldset>
<div class="setrow setrow--flush setrow--keep"><div><p class="setrow__label" id="ask-first">${tr('Asks you first')}</p><p class="setrow__desc">${modeLine}</p></div>
<label class="switch"><input type="checkbox" role="switch" name="mode" value="asks" aria-labelledby="ask-first" data-autosave${own || held ? ' checked' : ''}${held ? ' disabled' : ''}><span class="switch__track" aria-hidden="true"><span class="switch__thumb"></span></span></label></div>
<noscript><div><button class="btn small ghost">${tr('Save')}</button></div></noscript></form>
<form method="post" action="${base}/about" class="pblock" id="about">
${field({ label: tr('What you call them'), name: 'alias', value: c.alias, description: tr('Your bot uses this name for them. They never see it.'), attrs: 'required maxlength="32" autocomplete="off"' })}
<label>${tr('Who they are')}<input name="purpose" maxlength="60" autocomplete="off" value="${esc(c.purpose || '')}" placeholder="${tr('football friend')}"></label>
<label>${tr('Instructions for your bot related to {who}', { who: esc(c.alias) })}<textarea name="notes" maxlength="280" rows="3" placeholder="${tr('Only football. Anything else, ask me.')}">${esc(c.notes || '')}</textarea></label>
<div><button class="btn small ghost">${tr('Save')}</button></div></form>
<section class="pblock" id="topics" aria-labelledby="topics-h"><h2 class="row-label" id="topics-h">${tr('{name} can ask about', { name: esc(c.alias) })}</h2><div class="tchips">
${c.topics.map((t) => `<form method="post" action="${base}/topics" class="tchip"><span>${esc(t)}</span><input type="hidden" name="remove" value="${esc(t)}"><button aria-label="${tr('Stop {name} asking about {topic}', { name: esc(c.alias), topic: esc(t) })}">${HAND.x}</button></form>`).join('')}
${c.topics.length < 10 ? `<form method="post" action="${base}/topics" class="tchip-add"><label class="sr" for="nt">${tr('New topic')}</label><input id="nt" name="add" maxlength="40" required autocomplete="off" placeholder="${tr('+ add a topic')}"><noscript><button class="btn small ghost">${tr('Add topic')}</button></noscript></form>` : ''}</div></section>
<section class="pblock" id="rules" aria-labelledby="rules-h"><h2 class="row-label" id="rules-h">${tr('Rules')}</h2>
${rules ? `<ul class="rules">${rules}</ul>` : ''}
<form method="post" action="${base}/rules" class="rule-add"><label class="sr" for="nr">${tr('New rule')}</label><input id="nr" name="add" maxlength="200" required autocomplete="off" placeholder="${tr('Never says yes to a meeting without me')}"><button class="btn small ghost">${tr('Add rule')}</button></form></section>
</div></section>`, { user, tab: 'people', bar: { back: `/app/people?bot=${b.id}`, backLabel: tr('People') } });
  }

  // ───── requests (pilot): replies waiting for a yes, and changes the bot can't make alone ─────
  function requestCard(r, tr) {
    const who = peerFace(r.owner_bot, r.peer_bot, tr);
    const inbound = r.inbound_message_id ? q('SELECT text, links, sealed, body_purged_at FROM messages WHERE id = ?').get(r.inbound_message_id) : null;
    // Their words are data: escaped, invisible and control characters shown, links as plain text.
    const theirs = !inbound ? '' : inbound.body_purged_at ? `<p class="ask__theirs ask__theirs--quiet">${tr('Their message was deleted after 7 days.')}</p>`
      : inbound.sealed ? `<p class="ask__theirs ask__theirs--quiet">${tr('End-to-end encrypted, so only your bot could read their message.')}</p>`
      : `<figure class="ask__theirs"><figcaption>${tr("{name}'s bot wrote", { name: esc(who.alias) })}</figcaption><blockquote>${esc(safeText(inbound.text))}</blockquote>${JSON.parse(inbound.links || '[]').map((l) => `<p class="ask__link">${esc(safeText(l))}</p>`).join('')}</figure>`;
    const d = r.draft;
    const draft = d ? `<div class="ask__draft"><p class="ask__label">${r.state === 'PENDING_OWNER' ? tr("Your bot's draft") : r.state === 'ENQUEUED' ? tr('What was sent') : tr('The answer')}</p><p class="ask__text">${esc(d.text)}</p>${d.links.map((l) => `<a class="ext" href="${esc(l)}" rel="noopener noreferrer nofollow" target="_blank">${esc(l.replace(/^https?:\/\//, '').slice(0, 60))}</a>`).join('')}${(d.files ?? []).map((f) => `<p class="ask__link">${esc(safeText(f.name))} (${f.size >= 1048576 ? `${Math.round(f.size / 104857.6) / 10} MB` : `${Math.max(1, Math.round(f.size / 1024))} KB`})</p>`).join('')}</div>` : '';
    const q_ = r.question ? esc(r.question) : r.inbound_message_id ? tr("{name} wrote to you. Send your bot's answer?", { name: esc(who.alias) }) : tr('Your bot wants to write to {name}. Send it?', { name: esc(who.alias) });
    const act = `/app/requests/${esc(r.id)}`;
    const rev = `<input type="hidden" name="revision" value="${r.revision}">`;
    const own = (action, summary, text) => `<details class="ask__more" name="own-${esc(r.id)}"><summary class="btn ghost">${summary}</summary><form method="post" action="${act}" class="ask__own">${rev}<input type="hidden" name="action" value="${action}">${action === 'edit' && d?.links.length ? `<input type="hidden" name="links" value="${esc(d.links.join('\n'))}">` : ''}
<label class="sr" for="${action}-${esc(r.id)}">${action === 'edit' ? tr('Your edit') : tr('Your answer')}</label><textarea id="${action}-${esc(r.id)}" name="text" rows="4" maxlength="8000" required${action === 'write' ? ` placeholder="${tr('Write it in your words')}"` : ''}>${esc(text)}</textarea><button class="btn">${tr('Send this')}</button></form></details>`;
    const done = {
      ENQUEUED: [tr('sent'), tr('Sent to {name}.', { name: esc(who.alias) })],
      APPROVED: [tr('okay'), tr('Okayed. Your bot sends it end-to-end encrypted the next time it runs.')],
      DECLINED: [tr('declined'), tr('Declined. Nothing was sent.')],
      EXPIRED: [tr('expired'), tr('This waited 24 hours, so it expired. Nothing was sent.')],
      CANCELLED: [tr('cancelled'), tr('Something changed with {name}, so this was cancelled. Nothing was sent.', { name: esc(who.alias) })],
    }[r.state];
    const body = r.state === 'PENDING_OWNER' ? `<div class="ask__actions" role="group" aria-label="${tr('Your answer')}">
<form method="post" action="${act}">${rev}<input type="hidden" name="action" value="send"><button class="btn">${tr('Send once')}</button></form>
${own('edit', tr('Edit'), d?.text || '')}${own('write', tr('Write my own'), '')}
<form method="post" action="${act}">${rev}<input type="hidden" name="action" value="decline"><button class="btn ghost">${tr('Decline')}</button></form></div>
<p class="ask__why">${tr('Nothing goes to {name} until you choose.', { name: esc(who.alias) })}</p>`
      : `<span class="ask__stamp" aria-hidden="true">${done[0]}</span><div class="ask__done"><p role="status">${done[1]}</p></div>`;
    return `<article class="ask" id="${esc(r.id)}" aria-label="${r.inbound_message_id ? tr('Reply to {name}', { name: esc(who.alias) }) : tr('Message to {name}', { name: esc(who.alias) })}">
<div class="ask__top">${sticker({ seed: r.peer_bot, name: who.alias, src: who.pic, label: who.alias, note: false })}<div class="ask__who"><span class="hand">${r.inbound_message_id ? tr('{name} asked', { name: esc(who.alias.toLowerCase()) }) : tr('to {name}', { name: esc(who.alias.toLowerCase()) })}</span><time datetime="${new Date(r.created_at).toISOString()}">${esc(tr.ago(r.created_at, clock()))}</time></div></div>
<p class="ask__q">${q_}</p>${r.topic && r.state === 'PENDING_OWNER' ? `<p class="ask__topic"><span class="hand">${esc(r.topic)}</span> ${tr('Your bot remembers your answer, so it asks less next time.')}</p>` : ''}${theirs}${draft}${body}</article>`;
  }
  // Settings changes in words, from the stored operations.
  function describeOp(b, o, tr) {
    const who = o.contact != null ? (q('SELECT alias FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(b.id, o.contact)?.alias ?? tr('someone')) : '';
    const grp = o.circle_name ?? (o.circle != null ? (q('SELECT name FROM circles WHERE id = ? AND owner_bot = ?').get(o.circle, b.id)?.name ?? tr('a basket')) : '');
    const rule = o.rule ? q('SELECT text FROM contact_rules WHERE id = ? AND owner_bot = ?').get(o.rule, b.id)?.text : null;
    switch (o.op) {
      case 'move': return o.circle == null ? tr('Take {who} out of their basket', { who }) : tr('Put {who} in {basket}', { who, basket: grp });
      case 'set_mode': return o.contact != null
        ? (o.mode === 'handles' ? tr('Let your bot handle {who} without asking you first', { who }) : o.mode === 'asks' ? tr('Your bot asks you first about {who}', { who }) : tr('{who} goes by their basket again', { who }))
        : (o.mode === 'handles' ? tr('Let your bot handle everyone in {basket} without asking you first', { basket: grp }) : tr('Your bot asks you first about everyone in {basket}', { basket: grp }));
      case 'add_circle': return o.mode === 'asks' ? tr('Add a basket called {name}, where your bot asks you first', { name: o.name }) : tr('Add a basket called {name}', { name: o.name });
      case 'rename_circle': return tr('Rename {basket} to {name}', { basket: grp, name: o.name });
      case 'delete_circle': return tr('Remove the {basket} basket', { basket: grp });
      case 'set_purpose': return o.purpose ? tr('Note who {who} is: {purpose}', { who, purpose: o.purpose }) : tr('Clear who {who} is', { who });
      case 'set_notes': return tr('Change your notes for {who}', { who });
      case 'rename': return tr('Call {who} {name}', { who, name: o.name });
      case 'add_topic': return tr('Let {who} ask about {topic}', { who, topic: o.topic });
      case 'remove_topic': return tr('Stop {who} asking about {topic}', { who, topic: o.topic });
      case 'add_rule': return tr('Add a rule for {who}: {text}', { who, text: o.text });
      case 'remove_rule': return rule ? tr('Remove your rule: {rule}', { rule }) : tr('Remove one of your rules');
      case 'block': return o.on ? tr('Block {who}', { who }) : tr('Unblock {who}', { who });
      case 'pause': return o.on ? tr('Pause your bots') : tr('Resume your bots');
      case 'quiet_hours': return o.on ? tr('Quiet hours from {from} to {to}', { from: hhmm(o.start), to: hhmm(o.end) }) : tr('Turn quiet hours off');
      case 'ack_learned': return tr('Mark learned rules as seen');
      default: return tr('Change a setting');
    }
  }
  function proposalCard(b, p, tr) {
    const ops = typeof p.ops === 'string' ? JSON.parse(p.ops) : p.ops;
    const act = `/app/proposals/${esc(p.id)}`;
    const done = { APPROVED: [tr('changed'), tr('Done. Your bot has the new settings.')], DECLINED: [tr('declined'), tr('Declined. Nothing changed.')], EXPIRED: [tr('expired'), tr('This waited 7 days, so it expired. Nothing changed.')] }[p.state];
    return `<article class="ask ask--change" id="${esc(p.id)}" aria-label="${tr('A change your bot wants')}">
<div class="ask__top"><div class="ask__who"><span class="hand">${tr('your bot asks')}</span><time datetime="${new Date(p.created_at).toISOString()}">${esc(tr.ago(p.created_at, clock()))}</time></div></div>
<p class="ask__q">${ops.length === 1 ? tr('Okay to change this?') : tr('Okay to change these {n} things?', { n: ops.length })}</p>
<ul class="changes">${ops.map((o) => `<li>${esc(describeOp(b, o, tr))}</li>`).join('')}</ul>
${p.state === 'PENDING_OWNER' ? `<p class="ask__why">${tr("Your bot can't do this alone, because it gives it more freedom.")}</p><div class="ask__actions" role="group" aria-label="${tr('Your answer')}">
<form method="post" action="${act}"><input type="hidden" name="decision" value="approve"><button class="btn">${tr('Approve')}</button></form>
<form method="post" action="${act}"><input type="hidden" name="decision" value="decline"><button class="btn ghost">${tr('Decline')}</button></form></div>`
  : `<span class="ask__stamp" aria-hidden="true">${done[0]}</span><div class="ask__done"><p role="status">${done[1]}</p></div>`}</article>`;
  }
  function requestsPage(user) {
    const tr = T(user);
    const bots = govBots(user);
    const reqs = bots.flatMap((b) => openRequests(b.id, { owner: true }));
    const props = bots.flatMap((b) => q("SELECT * FROM settings_proposals WHERE owner_bot = ? AND state = 'PENDING_OWNER' AND expires_at > ? ORDER BY created_at, id").all(b.id, clock()).map((p) => [b, p]));
    const body = reqs.length || props.length
      ? `${reqs.length ? `<section class="group" aria-labelledby="replies-h"><h2 id="replies-h">${tr('Replies')}</h2><div class="asks-list">${reqs.map((r) => requestCard(r, tr)).join('')}</div></section>` : ''}
${props.length ? `<section class="group" aria-labelledby="changes-h"><h2 id="changes-h">${tr('Changes')}</h2><div class="asks-list">${props.map(([b, p]) => proposalCard(b, p, tr)).join('')}</div></section>` : ''}`
      : `<section class="card">${emptyState('check', tr('Nothing waiting'), tr('When your bot needs your okay, it shows up here.'))}</section>`;
    return layout(tr('Requests'), `<p class="pnote">${tr('Drafts you okay here pass through bot2bot, so we can read them, even in end-to-end encrypted chats.')}</p>${body}`, { user, tab: 'requests', width: 'read', bar: { title: tr('Requests') } });
  }
  const oneRequestPage = (user, r, { error = '' } = {}) => { const tr = T(user); const who = peerFace(r.owner_bot, r.peer_bot, tr).alias; return layout(tr('Request'), `${error ? alertBox('danger', esc(error), '') : ''}<p class="pnote">${tr('Drafts you okay here pass through bot2bot, so we can read them, even in end-to-end encrypted chats.')}</p>${requestCard(r, tr)}`,
    { user, tab: 'requests', width: 'read', bar: { back: '/app/requests', backLabel: tr('Requests'), title: r.inbound_message_id ? tr('Reply to {name}', { name: who }) : tr('Message to {name}', { name: who }) } }); };
  const oneProposalPage = (user, b, p, { error = '' } = {}) => { const tr = T(user); return layout(tr('[noun]Change'), `${error ? alertBox('danger', esc(error), '') : ''}${proposalCard(b, p, tr)}`,
    { user, tab: 'requests', width: 'read', bar: { back: '/app/requests', backLabel: tr('Requests'), title: tr('A change from your bot') } }); };

  // ───── router ─────
  async function handleApp(req, res, url) {
    const p = url.pathname;
    // With the landing site on the same server, it answers / and /pricing instead of the built-in pages.
    const isApp = p === '/connect/chatgpt' || p === '/connect/send' || p.startsWith('/connect/send/') || p.startsWith('/setup-shots/') || p === '/oauth/authorize' || (!site && (p === '/' || p === '/pricing')) || (payments && p === '/billing/stripe') || p === '/login' || p.startsWith('/login/') || p === '/logout' || p === '/app' || p.startsWith('/app/') || (!!boardPages && (p === '/feedback' || p.startsWith('/feedback/'))) || p.startsWith('/i/') || (!!groups && p.startsWith('/g/')) || p === '/founder' || (promo && p.startsWith('/gift/')) || p.startsWith('/art/') || p.startsWith('/avatars/') || p.startsWith('/stickers/') || p.startsWith('/hand/') || p.startsWith('/lang/')
      || (!!status && (p === '/status' || p === '/status/' || p === '/status.json' || p === '/status/feed.xml'));
    if (!isApp) return false;
    if (isHeadPage()) {
      // Keep the real request's method intact for the server and its finish listeners.
      req = Object.assign(Object.create(req), { method: 'GET' });
      const end = res.end.bind(res);
      res.end = (body, encoding, callback) => end(typeof body === 'function' ? body : typeof encoding === 'function' ? encoding : callback);
    }
    let tr = translator(reqLang(req));
    try {
      // Stripe's payment webhook (hosted-billing.mjs).
      if (payments && p === '/billing/stripe' && req.method === 'POST') {
        const r = await payments.webhook(req);
        return json(res, r.status, r.body), true;
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
      // A chat app's setup screenshots (public/setup/<app>/step-<n>.png).
      const shm = p.match(/^\/setup-shots\/([a-z]+)\/step-(\d{1,2})\.png$/);
      if (shm && req.method === 'GET') {
        const file = new URL(`./${shm[1]}/step-${shm[2]}.png`, SHOT_DIR);
        if (!CHAT_APPS.some((a) => a.key === shm[1]) || !existsSync(file)) throw new HttpError(404, 'Not found');
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
        res.end(readFileSync(file));
        return true;
      }
      const am = p.match(/^\/art\/([a-z]+)\.jpg$/);
      if (am && req.method === 'GET') {
        if (!ART.has(am[1])) throw new HttpError(404, 'Not found');
        res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' });
        res.end(readFileSync(new URL(`./public/art/${am[1]}.jpg`, import.meta.url)));
        return true;
      }
      // Signed out, picking the other language at the top remembers it and shows the same page again.
      const lg = p.match(/^\/lang\/(en|cs)$/);
      if (lg && req.method === 'GET') {
        let back = '/login';
        try { const r = new URL(req.headers.referer || ''); if (origin ? r.origin === new URL(originFor(req)).origin : r.host === req.headers.host) back = safeNext(r.pathname + r.search); } catch { /* no page to go back to */ }
        res.writeHead(303, { location: back.startsWith('/lang/') ? '/login' : back, 'set-cookie': langCookie(lg[1]), 'cache-control': 'no-store' }); res.end();
        return true;
      }
      // The public status page, the same for everyone (status.mjs), in the language picked at the top or the browser's.
      // Its JSON and Atom feed are for agents and feed readers.
      if (status && p.startsWith('/status') && (req.method === 'GET' || req.method === 'HEAD')) {
        const base = origin || `http://${req.headers.host || 'localhost'}`;
        if (p === '/status/') { res.writeHead(301, { location: '/status' }); res.end(); return true; }
        if (p === '/status') return page(res, 200, layout(tr('Status'), status.page(tr), { tr, outWidth: 'status' })), true;
        const [type, body] = p === '/status.json' ? ['application/json; charset=utf-8', JSON.stringify(status.json(base), null, 2)] : ['application/atom+xml; charset=utf-8', status.feed(base)];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' });
        res.end(req.method === 'HEAD' ? undefined : body);
        return true;
      }
      if (req.method === 'POST' && !sameOrigin(req)) throw new HttpError(403, 'Please use the website to do that.');
      const user = currentUser(req);
      if (user) tr = T(user);
      const csm = p.match(/^\/connect\/send(?:\/([a-z]+)(\/steps|\/done)?)?$/);
      if (csm) {
        const app = CHAT_APPS.find((a) => a.key === (csm[1] || url.searchParams.get('app')));
        if (!csm[1]) return app ? (redirect(res, `/connect/send/${app.key}`), true) : (page(res, 200, sendPickPage(user, tr)), true);
        if (!app) throw new HttpError(404, 'Not found');
        if (!csm[2] && req.method === 'POST') {
          const name = cleanName((await form(req)).name);
          if (!name) return page(res, 400, sendNamePage(user, tr, app, '', tr('Give it a name.'))), true;
          res.setHeader('set-cookie', sendCookie(app.key, name));
          return redirect(res, `/connect/send/${app.key}/steps`), true;
        }
        if (req.method === 'GET' && !csm[2]) return page(res, 200, sendNamePage(user, tr, app, sendPick(req, app.label))), true;
        if (req.method === 'GET' && csm[2] === '/steps') return page(res, 200, sendStepsPage(user, tr, app, sendPick(req, app.label) || app.label)), true;
        if (req.method === 'GET' && csm[2] === '/done') {
          const name = sendPick(req, app.label) || app.label;
          const on = sendersOf(user).filter((b) => b.chat_app === app.label);
          const b = on.find((x) => x.display_name === name) || on[0];
          return b ? (page(res, 200, sendDonePage(user, tr, app, b)), true) : (redirect(res, `/connect/send/${app.key}/steps`), true);
        }
      }
      if (p === '/connect/chatgpt' && req.method === 'GET') return page(res, 200, chatgptSetupPage(user, tr, url.searchParams.get('invite'))), true;
      if (boardPages && (p === '/feedback' || p.startsWith('/feedback/'))) {
        if (await boardPages(req, res, p, url, { user, tr })) return true;
        throw new HttpError(404, 'Page not found');
      }

      if (p === '/' && req.method === 'GET') return page(res, 200, landing(user, tr)), true;
      if (p === '/pricing' && req.method === 'GET') return page(res, hosted ? 200 : 404, hosted ? pricingPage(user, tr) : layout(tr('Not found'), `<section class="card narrow"><h1>${tr('Not found')}</h1><p>${tr('This server is self-hosted and free.')}</p></section>`, { tr })), true;

      if (p === '/login' && req.method === 'GET') return page(res, 200, loginPage(tr, { next: url.searchParams.get('next') || '' })), true;
      if (p === '/login' && req.method === 'POST') {
        const f = await form(req);
        const email = String(f.email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return page(res, 400, loginPage(tr, { email, error: tr('That email address looks wrong.'), next: f.next })), true;
        try { const devCode = await sendLogin(email, req, res, f.next); return page(res, 200, loginPage(tr, { email, sent: true, next: f.next, devCode })), true; }
        catch (e) { if (e instanceof HttpError) return page(res, e.status, loginPage(tr, { email, error: e.message, next: f.next })), true; throw e; }
      }
      if (p === '/login/verify' && req.method === 'POST') {
        const f = await form(req);
        const email = String(f.email || '').trim().toLowerCase();
        const row = q('SELECT * FROM login_codes WHERE email = ? AND expires_at > ? ORDER BY created_at DESC').get(email, clock());
        // A directory reviewer (REVIEW_LOGIN) can't read our emails: their address also takes their own code.
        const right = !!row && (row.code_hash === sha(String(f.code || '').trim()) || (!!reviewLogin && email === reviewLogin.email && String(f.code || '').trim() === reviewLogin.code));
        // The same code sent twice from the same browser (a double tap, or autofill submitting as you tap) logs in
        // again instead of saying it expired: the first one already did.
        const nonce = cookies(req).b2b_login;
        if (row?.used_at && right && clock() - row.used_at < 2 * 60_000 && row.browser_hash && nonce && sha(nonce) === row.browser_hash) return finishLogin(req, res, email, f.next, f.tz, reqLang(req)), true;
        if (!row || row.used_at) return page(res, 400, loginPage(tr, { email, error: tr('That code expired. Ask for a new one.'), next: f.next })), true;
        if (row.attempts >= 5) return page(res, 400, loginPage(tr, { email, error: tr('Too many wrong tries. Ask for a new code.'), next: f.next })), true;
        if (!right) {
          q('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
          return page(res, 400, loginPage(tr, { email, sent: true, error: tr('Wrong code. Try again.'), next: f.next })), true;
        }
        q('UPDATE login_codes SET used_at = ? WHERE id = ?').run(clock(), row.id);
        return finishLogin(req, res, email, f.next, f.tz, reqLang(req)), true;
      }
      if (p === '/login/link') {
        // GET only shows a button, so email scanners that open links can't use them up.
        const t = req.method === 'POST' ? String((await form(req)).t || '') : url.searchParams.get('t') || '';
        const row = q('SELECT * FROM login_codes WHERE link_hash = ? AND used_at IS NULL AND expires_at > ?').get(sha(t), clock());
        if (!row) return page(res, 400, loginPage(tr, { error: tr('That link expired. Ask for a new one.') })), true;
        const nonce = cookies(req).b2b_login;
        if (row.browser_hash && (!nonce || sha(nonce) !== row.browser_hash)) {
          return page(res, 400, loginPage(tr, { error: tr('Open the link in the same browser where you asked for it, or type the 6-digit code from the email there.') })), true;
        }
        if (req.method !== 'POST') return page(res, 200, layout(tr('Log in'), `<section class="card narrow center"><h1>${tr('Continue to {product}', { product: esc(product) })}</h1>
<form method="post" action="/login/link"><input type="hidden" name="t" value="${esc(t)}"><button class="btn wide">${tr('Log in')}</button></form></section>`, { tr })), true;
        q('UPDATE login_codes SET used_at = ? WHERE id = ?').run(clock(), row.id);
        // Back to where they were going (a bot's approve link, an invite), like the 6-digit code does.
        return finishLogin(req, res, row.email, row.next || '/app', undefined, reqLang(req)), true;
      }
      if (p === '/logout' && req.method === 'POST') {
        const t = cookies(req).b2b_session; if (t) q('DELETE FROM sessions WHERE token_hash = ?').run(sha(t));
        // Switching accounts mid sign-in (a connected app's consent page): straight to sign-in, then back.
        const f = await form(req);
        res.setHeader('set-cookie', sessionCookie('', 0)); return redirect(res, f.next ? `/login?next=${encodeURIComponent(safeNext(f.next))}` : '/'), true;
      }

      // Connected app sign-in (OAuth authorize). Needs a logged-in person; they pick which bot the app acts as.
      if (p === '/oauth/authorize') {
        // The issuer and resources are the address the app connected to (an app connected on the old www host stays there).
        const origin = originFor(req);
        const params = req.method === 'POST' ? await form(req) : Object.fromEntries(url.searchParams);
        const keep = Object.fromEntries(['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'].map((k) => [k, String(params[k] ?? '')]));
        const client = q('SELECT * FROM oauth_clients WHERE client_id = ?').get(keep.client_id);
        if (!client || !JSON.parse(client.redirect_uris).includes(keep.redirect_uri)) return page(res, 400, layout(tr('Start the connection again'), `<section class="card"><h1>${tr('Start the connection again')}</h1><p>${tr("This link didn't work. Go back to the app you're connecting and select Connect again.")}</p><p class="muted small">${tr('Sign in in the window the app opens. A copied link may not finish the connection.')}</p><a class="btn wide" href="/connect/chatgpt">${tr('Connect dots')}</a></section>`, { tr })), true;
        // Every answer names us as the issuer (RFC 9207), so the app can tell which server it came from.
        const back = (qs) => { const u = new URL(keep.redirect_uri); for (const [k, v] of Object.entries(qs)) u.searchParams.set(k, v); if (keep.state) u.searchParams.set('state', keep.state); u.searchParams.set('iss', origin); return redirect(res, u.toString()), true; };
        if (keep.response_type !== 'code' || keep.code_challenge_method !== 'S256' || keep.code_challenge.length < 43) return back({ error: 'invalid_request', error_description: 'PKCE (S256) and response_type=code are required' });
        if (keep.resource && ![`${origin}/mcp`, origin, `${origin}/`, `${origin}/send`].includes(keep.resource)) return back({ error: 'invalid_target', error_description: `resource must be ${origin}/mcp or ${origin}/send` });
        // Send only (bot2bot.link/send): no bot to pick. The chat gets a sender of its own.
        const sendOnly = keep.resource === `${origin}/send`;
        if (!user) return redirect(res, `/login?next=${encodeURIComponent(`/oauth/authorize?${new URLSearchParams(keep)}`)}`), true;
        // A name picked on the setup page for this app (/connect/send) names its sender, and picks Send only.
        const picked = sendPick(req, senderLabel(client.name));
        if (req.method === 'GET') return page(res, 200, sendOnly ? sendAuthorizePage(user, client, keep, picked) : authorizePage(user, client, keep, { send: !!picked, name: botPick(req) })), true;
        if (params.decision !== 'allow') return back({ error: 'access_denied' });
        if (sendOnly) {
          const sender = senderBot(user, senderLabel(client.name), picked || undefined);
          linkOwnBots(user.id);
          const code = token('ac_', 24);
          q('INSERT INTO oauth_codes (code_hash, client_id, bot_id, redirect_uri, challenge, expires_at, resource) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sha(code), client.client_id, sender.id, keep.redirect_uri, keep.code_challenge, clock() + 5 * 60_000, keep.resource);
          log(sender.id, 'connector_authorized', { client: client.name.slice(0, 40), send_only: true });
          tell(user, { what: tr('{app} can send to your bots now', { app: sender.display_name }) });
          return back({ code });
        }
        // Which assistant this is, from the name the app registered with (a hint for setup steps, never for trust).
        const platform = platformForApp(client.name);
        let bot;
        try {
          // Send only, picked here by a chat app that didn't say it was connecting to /send (Gemini sends no resource).
          if (params.bot === 'send') {
            const sender = senderBot(user, senderLabel(client.name), picked || undefined);
            linkOwnBots(user.id);
            const code = token('ac_', 24);
            q('INSERT INTO oauth_codes (code_hash, client_id, bot_id, redirect_uri, challenge, expires_at, resource) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sha(code), client.client_id, sender.id, keep.redirect_uri, keep.code_challenge, clock() + 5 * 60_000, keep.resource || null);
            log(sender.id, 'connector_authorized', { client: client.name.slice(0, 40), send_only: true });
            tell(user, { what: tr('{app} can send to your bots now', { app: sender.display_name }) });
            return back({ code });
          }
          bot = params.bot && params.bot !== 'new' ? ownBot(user, params.bot) : makeConnectorBot(user, params.handle);
          if ((bot.vendor !== 'connector' && !(isDotApp(client) && wakeOnly(bot))) || isSender(bot)) throw new HttpError(400, 'Pick one of your connected-app bots.');
        } catch (e) { if (e instanceof HttpError) return page(res, 400, authorizePage(user, client, keep, { error: e.message, name: botPick(req) })), true; throw e; }
        if (bot.disconnected_at) q('UPDATE bots SET disconnected_at = NULL WHERE id = ?').run(bot.id);
        linkOwnBots(user.id);
        const code = token('ac_', 24);
        q('INSERT INTO oauth_codes (code_hash, client_id, bot_id, redirect_uri, challenge, expires_at, resource) VALUES (?, ?, ?, ?, ?, ?, ?)').run(sha(code), client.client_id, bot.id, keep.redirect_uri, keep.code_challenge, clock() + 5 * 60_000, keep.resource || null);
        if (platform) q('UPDATE bots SET platform = ? WHERE id = ?').run(platform, bot.id);
        log(bot.id, 'connector_authorized', { client: client.name.slice(0, 40) });
        return back({ code });
      }

      // Gift links (hosted-invites.mjs): a friend's invite with a bonus for both. Signed out, it asks you to sign up first.
      const gm = promo && p.match(/^\/gift\/([A-Za-z0-9-]{8,10})$/);
      if (gm) {
        const code = hostedInvites.normCode(gm[1]);
        if (req.method === 'GET') {
          const c = invites.check(user, code);
          if (c.state === 'mine') { const fc = giftInvite(user); return redirect(res, fc ? `/i/${fc}` : '/app/gifts'), true; }
          return page(res, c.state === 'missing' ? 404 : 200, promo.giftPage(user, tr, code, c)), true;
        }
        if (!user) return redirect(res, `/login?next=${encodeURIComponent(`/gift/${code}`)}`), true;
        try {
          const r = invites.redeem(user, code);
          if (!r.again) tell(user, { what: promo.claimed(tr, r.inv.from_name) });
          // Then the friend's invite, so the new person's bot connects to theirs.
          const fc = giftInvite(user);
          return redirect(res, fc ? `/i/${fc}` : r.again ? '/app/gifts' : '/app'), true;
        } catch (e) { if (e instanceof HttpError) return page(res, e.status, promo.giftPage(user, tr, code, invites.check(user, code), { error: e.message })), true; throw e; }
      }

      if (p === '/founder') {
        const f = founder();
        if (!f) return page(res, 404, layout(tr('Text the founder'), `<section class="card narrow center"><h1>${tr('Not here right now')}</h1><p><a class="link" href="/feedback">${tr('Write to us on the feedback board')}</a></p>${onward(user, tr)}</section>`, { user, tr })), true;
        const bots = user ? liveBots(user).filter((b) => b.id !== f.id && b.vendor !== 'web' && !isSender(b)) : [];
        if (req.method === 'GET') {
          const c = bots.map((b) => q('SELECT alias FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(b.id, f.id)).find(Boolean);
          return page(res, 200, founderPage(f, user, bots, { tr, done: c ? { already: true, alias: c.alias } : null })), true;
        }
        if (!user) return redirect(res, '/login?next=%2Ffounder'), true;
        const fm = await form(req);
        const bot = bots.find((b) => b.id === Number(fm.bot));
        if (!bot) return page(res, 400, founderPage(f, user, bots, { tr, error: tr('Connect your bot first.') })), true;
        try { return page(res, 200, founderPage(f, user, bots, { tr, done: connectFounder(bot, user) })), true; }
        catch (e) { if (e instanceof HttpError) return page(res, e.status, founderPage(f, user, bots, { tr, error: e.message })), true; throw e; }
      }

      // Invite links work for logged-out visitors too.
      const im = p.match(/^\/i\/([A-Za-z0-9-]{9})$/);
      if (im) {
        const plain = im[1].toUpperCase();
        const inv = q('SELECT * FROM invites WHERE code_hash = ?').get(sha(plain));
        const unavailable = (status, title) => page(res, status, layout(tr('Invitation'), `<section class="card narrow center"><h1>${title}</h1><p>${tr('Ask your friend for a new link.')}</p>${onward(user, tr)}</section>`, { user, tr }));
        if (!inv) return unavailable(404, tr('This invite was not found')), true;
        inv.plain = plain;
        const inviter = q('SELECT b.handle, u.name, u.email_verified_at, b.user_id FROM bots b LEFT JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(inv.from_bot);
        const bots = user ? liveBots(user).filter((b) => b.id !== inv.from_bot && !isSender(b)) : [];
        const connected = (b) => q('SELECT 1 FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(b.id, inv.from_bot);
        const alreadyConnected = () => {
          const people = govBots(user).length > 0;
          return page(res, 200, layout(tr('Invitation'), `<section class="card narrow center"><h1>${tr("You're already connected")}</h1>${people ? `<p>${tr('Find them on your people page.')}</p>` : ''}<a class="btn wide" href="${people ? '/app/people' : '/app'}">${people ? tr('Open your people page') : tr('Go to overview')}</a></section>`, { user, tr }));
        };
        const usedByMe = inv.used_by && bots.find((b) => b.id === inv.used_by);
        if (inv.used_at) return usedByMe && connected(usedByMe) ? (alreadyConnected(), true) : (unavailable(410, tr('This invite was already used')), true);
        if (inv.expires_at <= clock()) return unavailable(410, tr('This invite has expired')), true;
        if (bots.length && bots.every(connected)) return alreadyConnected(), true;
        if (req.method === 'GET') return page(res, 200, invitePage(inv, inviter, user, bots, { tr })), true;
        if (!user) return redirect(res, `/login?next=${encodeURIComponent(p)}`), true;
        const f = await form(req);
        if (inviter.user_id === user.id) return page(res, 400, invitePage(inv, inviter, user, bots, { tr, error: tr('That’s your own invite') })), true;
        // The web inbox is off unless an operator turns it on (WEB_INBOX=1): bot2bot is for bots.
        const bot = webInbox && f.web === '1' && !bots.length ? makeWebBot(user) : bots.find((b) => b.id === Number(f.bot));
        if (!bot) return page(res, 400, invitePage(inv, inviter, user, bots, { tr, error: bots.length ? tr('Pick one of your bots.') : tr('Connect your bot first.') })), true;
        if (connected(bot)) return alreadyConnected(), true;
        let accepted;
        try {
          // A dashboard link names the friend for the inviter as it's accepted (POST /v1/invites/accept).
          accepted = routes['POST /v1/invites/accept']({ me: bot, body: { code: plain, alias: String(f.alias || '').trim(), basket: f.basket || null, notes: f.notes ?? null }, byOwner: true });
        }
        catch (e) { if (e instanceof HttpError) return page(res, e.status, invitePage(inv, inviter, user, bots, { tr, error: e.message })), true; throw e; }
        return page(res, 200, invitePage(inv, inviter, user, bots, { tr, done: bot.vendor === 'web' ? 'web' : true, basket: accepted?.basket })), true;
      }

      // A member's group link. Signed out, it shows the group and how to connect a bot; joining needs signing in.
      const gl = groups && p.match(/^\/g\/([A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/);
      if (groups && p.startsWith('/g/')) {
        const code = gl ? gl[1].toUpperCase() : '';
        const link = gl ? groups.linkByCode(code) : null;
        if (!link) return page(res, 404, layout(tr('Group chat'), `<section class="card narrow center"><h1>${tr('This group link has expired')}</h1><p>${tr('Ask whoever sent it for a new one.')}</p>${onward(user, tr)}</section>`, { user, tr })), true;
        const bots = user ? groupBots(user) : [];
        const inIt = bots.find((b) => groups.member(link.group_id, b.id)?.state === 'joined') ?? null;
        const show = (status, extra = {}) => page(res, status, groupJoinPage(link, user, bots.filter((b) => groups.member(link.group_id, b.id)?.state !== 'joined'), { tr, code, inIt, ...extra }));
        if (req.method === 'GET') return show(200), true;
        if (!user) return redirect(res, `/login?next=${encodeURIComponent(p)}`), true;
        const f = await form(req);
        const bot = bots.find((b) => b.id === Number(f.bot));
        if (!bot) return show(400, { error: bots.length ? tr('Pick one of your bots.') : tr('Connect your bot first.') }), true;
        if (!groups.toolReady(bot)) return show(200, { old: bot }), true;
        let r;
        try { r = groups.join(bot, link.group_id, { linkCode: code, basket: f.basket || null, byOwner: true }); }
        catch (e) { if (e instanceof HttpError) return show(e.status, { error: groupError(e, tr) }), true; throw e; }
        tell(user, { what: r.connected ? tr('You joined {name} · {who} is a contact now', { name: link.group.name, who: r.connected.alias }) : tr('You joined {name}', { name: link.group.name }) });
        return redirect(res, `/app/groups/${link.group_id}?bot=${bot.id}`), true;
      }

      // Everything below needs a logged-in user.
      if (!user && cookies(req).b2b_in) res.setHeader('set-cookie', sessionCookie('', 0)); // the session ended elsewhere: drop the marker too
      // Signed in from before the marker existed: add it now, so the site says Platform on the next visit.
      else if (user && !cookies(req).b2b_in) res.setHeader('set-cookie', sessionCookie(cookies(req).b2b_session, SESSION_MS / 1000));
      if (user && !isHeadPage()) { markActive(user.id); usage?.noteCountry(user.id, req); }
      if (!user) return redirect(res, `/login?next=${encodeURIComponent(p + url.search)}`), true;

      // No picture yet: once there's a bot (or links to give away), pick one first, then carry on to the page they asked
      // for. Before that, connecting a bot comes first.
      if (req.method === 'GET' && !hasPicture(user) && (p === '/app/gifts' || myBots(user).some((b) => !isSender(b))) && /^\/app(\/(activity|inbox|account|billing|gifts|people|requests|bots\/\d+))?$/.test(p)) return redirect(res, `/app/picture?next=${encodeURIComponent(p + url.search)}`), true;
      if (p === '/app' && req.method === 'GET') {
        // No bot yet after claiming a friend's gift: their invite is the way in.
        const fc = promo && !myBots(user).some((b) => !isSender(b)) && !pendingCode(user) && giftInvite(user);
        if (fc) return redirect(res, `/i/${fc}`), true;
        return page(res, 200, dashboard(user)), true;
      }
      if (p === '/app/status' && req.method === 'GET') return json(res, 200, { bots: myBots(user).length, senders: liveBots(user).filter(isSender).length }), true;

      const lm = p.match(/^\/app\/link\/([A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/);
      if (lm) {
        const plain = lm[1].toUpperCase();
        if (req.method === 'GET') return page(res, 200, linkPage(user, joinRequest(plain), plain)), true;
        if (req.method === 'POST') {
          const f = await form(req);
          if (f.decision !== 'allow') {
            q('UPDATE join_requests SET denied_at = ? WHERE code_hash = ? AND approved_at IS NULL').run(clock(), sha(plain));
            tell(user, { what: tr("Declined. That bot isn't linked.") });
            return redirect(res, '/app'), true;
          }
          try { approveJoin(user, plain, f); }
          catch (e) { if (e instanceof HttpError) return page(res, e.status, linkPage(user, joinRequest(plain), plain, { error: e.message, handle: f.handle })), true; throw e; }
          linkOwnBots(user.id);
          return redirect(res, `/app/link/${plain}`), true;
        }
      }

      // Adding a bot: /app/bots/add (which bot), /add/<platform> (its name), /add/<platform>/steps, /add/done.
      const am_ = p.match(/^\/app\/bots\/add(?:\/([a-z-]+)(\/steps)?)?$/);
      if (am_ && req.method === 'GET' && am_[1] === 'done') {
        const newest = myBots(user).filter((b) => !isSender(b)).sort((a, b) => b.created_at - a.created_at)[0];
        return redirect(res, newest ? `/app/bots/${newest.id}` : '/app'), true;
      }
      if (am_) {
        const plat = am_[1] ? BOT_PLATFORMS(tr).find((x) => x.key === am_[1]) : null;
        if (!am_[1] && req.method === 'GET') return page(res, 200, addPickPage(user, tr)), true;
        if (!plat) throw new HttpError(404, 'Not found');
        if (!am_[2] && req.method === 'GET') return page(res, 200, addNamePage(user, tr, plat, { handle: plat.key === 'grok' ? pendingCode(user)?.handle : botPick(req) })), true;
        if (!am_[2] && req.method === 'POST') {
          const f = await form(req);
          const handle = String(f.handle || '').trim().toLowerCase();
          const error = nameError(user, handle, tr);
          if (error) return page(res, error === tr('That name is taken. Try another.') ? 409 : 400, addNamePage(user, tr, plat, { error, handle: f.handle })), true;
          if (plat.key === 'grok') startGrokSetup(user, handle);
          res.setHeader('set-cookie', botCookie(handle));
          return redirect(res, `/app/bots/add/${plat.key}/steps`), true;
        }
        if (am_[2] && req.method === 'GET') {
          const handle = plat.key === 'grok' ? pendingCode(user)?.handle : botPick(req);
          return handle ? (page(res, 200, addStepsPage(user, tr, plat, handle)), true) : (redirect(res, `/app/bots/add/${plat.key}`), true);
        }
      }
      // Older ways in: the overview's button, the name form, and Undo after cancelling a Grok Bot setup.
      if (p === '/app/bots/new' && req.method === 'POST') return redirect(res, '/app/bots/add'), true;
      if (p === '/app/bots/new-form' && req.method === 'GET') return redirect(res, '/app/bots/add'), true;
      if (p === '/app/bots' && req.method === 'POST') {
        const f = await form(req);
        const handle = String(f.handle || '').trim().toLowerCase();
        const error = nameError(user, handle, tr);
        if (error) return page(res, error === tr('That name is taken. Try another.') ? 409 : 400, addNamePage(user, tr, BOT_PLATFORMS(tr)[0], { error, handle: f.handle })), true;
        startGrokSetup(user, handle);
        return redirect(res, '/app/bots/add/grok/steps'), true;
      }
      if (p === '/app/bots/cancel' && req.method === 'POST') {
        const f = await form(req);
        const was = q('SELECT handle FROM enroll_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ?').get(user.id, clock());
        q('UPDATE enroll_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(clock(), user.id);
        // Undo starts the same setup again, with a fresh code.
        tell(user, { what: tr('Setup cancelled'), undo: was && f.undo !== '1' ? undoForm('/app/bots', { handle: was.handle }) : null });
        return redirect(res, '/app'), true;
      }

      const bm = p.match(/^\/app\/bots\/(\d+)(\/[a-z]+(?:\/off)?)?$/);
      if (bm) {
        const sub = bm[2] || '';
        const b = ownBot(user, bm[1], { removed: sub === '/restore' });
        if (!sub && req.method === 'GET') return page(res, 200, botPage(user, b)), true;
        if (sub === '/state' && req.method === 'GET') return json(res, 200, { verified: !!b.doorbell_verified_at, configured: !!b.webhook_url, watching: b.doorbell_kind === 'watch' && watching(b), last_ring_status: b.last_ring_status }), true;
        if (sub === '/doorbell' && req.method === 'POST') {
          const f = await form(req);
          try {
            // The two boxes the wrong way round (the key in the address box) is an easy slip: take them as meant.
            const looksUrl = (v) => /^https?:\/\//i.test(String(v || '').trim());
            if (!looksUrl(f.url) && looksUrl(f.key)) [f.url, f.key] = [f.key, f.url];
            const { url: urlOk, kind } = doorbellTarget(String(f.url || '').trim());
            const key = webhookKey(f.key);
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
            if (e instanceof HttpError) return page(res, 400, botPage(user, b, { error: tr.msg(e.message.replace(/^webhook (url|host)/, 'The webhook address')) })), true;
            throw e;
          }
          // Saving rings the bot straight away: one less thing to click.
          tell(user, { what: tr('Doorbell saved') });
          return redirect(res, `/app/bots/${b.id}?ring=1`), true;
        }
        // ChatGPT or OpenClaw watching for messages: stop every subscription (they can ask to watch again).
        if (sub === '/doorbell/off' && req.method === 'POST') {
          tx(() => {
            events?.revokeAll(b.id);
            q('UPDATE bots SET webhook_url = NULL, webhook_key = NULL, doorbell_kind = NULL, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1 WHERE id = ?').run(b.id);
          });
          log(b.id, 'doorbell_removed', { by: 'owner' });
          tell(user, { what: tr('Stopped watching') });
          return redirect(res, `/app/bots/${b.id}`), true;
        }
        const disconnectInTx = () => {
          bumpGen(b.id);
          events?.revokeAll(b.id);
          q('UPDATE bots SET token_hash = NULL, webhook_url = NULL, webhook_key = NULL, doorbell_kind = NULL, doorbell_verified_at = NULL, doorbell_gen = doorbell_gen + 1, disconnected_at = ? WHERE id = ?').run(clock(), b.id);
          q('UPDATE oauth_tokens SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL').run(clock(), b.id);
          erase(`status IN ('pending', 'claimed') AND (to_bot = ? OR from_bot = ?)`, b.id, b.id);
          q('DELETE FROM invites WHERE from_bot = ? AND used_at IS NULL').run(b.id);
          // Any setup code made before now (an upgrade or an earlier reconnect) stops working too.
          q('UPDATE enroll_codes SET used_at = ?, plain_code = NULL WHERE handle = ? AND used_at IS NULL').run(clock(), b.handle);
        };
        if (sub === '/rename' && req.method === 'POST') {
          const f = await form(req);
          let r;
          try { r = renameBot(b, f.handle); }
          catch (e) { if (e instanceof HttpError && e.status < 500) return page(res, e.status, botPage(user, { ...b, nameError: tr.msg(e.message) })), true; throw e; }
          if (r.from !== r.to) tell(user, { what: tr('Renamed to {name}', { name: r.to }), undo: f.undo === '1' ? null : undoForm(`/app/bots/${b.id}/rename`, { handle: b.handle }) });
          return redirect(res, `/app/bots/${b.id}`), true;
        }
        if (sub === '/disconnect' && req.method === 'POST') {
          tx(disconnectInTx);
          log(b.id, 'disconnected', { by: 'owner' });
          tell(user, { what: tr('Disconnected @{handle}', { handle: b.handle }), undo: undoForm(`/app/bots/${b.id}/reconnect`, {}, tr('Reconnect')) });
          return redirect(res, `/app/bots/${b.id}`), true;
        }
        // Remove: disconnected first if it isn't yet, then gone from the dashboard. An hour later it leaves its
        // friends' contact lists and its name is free again (server retention); until then Undo brings it back.
        if (sub === '/remove' && req.method === 'POST') {
          tx(() => {
            if (!b.disconnected_at) disconnectInTx();
            q('UPDATE bots SET removed_at = ? WHERE id = ?').run(clock(), b.id);
          });
          log(b.id, 'removed', { by: 'owner' });
          tell(user, { what: tr('Removed @{handle}', { handle: b.handle }), undo: undoForm(`/app/bots/${b.id}/restore`, {}) });
          return redirect(res, '/app'), true;
        }
        if (sub === '/restore' && req.method === 'POST') {
          if (b.handle.includes('~')) throw new HttpError(410, 'This bot is gone for good.');
          q('UPDATE bots SET removed_at = NULL WHERE id = ?').run(b.id);
          log(b.id, 'restored', { by: 'owner' });
          tell(user, { what: tr('@{handle} is back, disconnected', { handle: b.handle }) });
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
          tell(user, { what: every ? tr.n(every, 'Backs up every {n} hour|Backs up every {n} hours') : tr('Backups off'), undo: f.undo === '1' || every === b.backup_every_h ? null : undoForm(`/app/bots/${b.id}/backup`, { every: b.backup_every_h ?? 0 }) });
          return redirect(res, `/app/bots/${b.id}#backup`), true;
        }
        if (sub === '/updates' && req.method === 'POST') {
          const f = await form(req);
          const was = (b.wanted_channel || b.tool_channel) === 'nightly';
          const on = f.on === '1';
          q('UPDATE bots SET wanted_channel = ? WHERE id = ?').run(on ? 'nightly' : 'stable', b.id);
          log(b.id, 'tool_channel', { channel: on ? 'nightly' : 'stable', by: 'owner' });
          tell(user, { what: on ? tr('Nightly updates on') : tr('Nightly updates off'), undo: f.undo === '1' || on === was ? null : undoForm(`/app/bots/${b.id}/updates`, was ? { on: '1' } : {}) });
          return redirect(res, `/app/bots/${b.id}#updates`), true;
        }
        if (sub === '/test' && req.method === 'POST') {
          if (b.disconnected_at || b.vendor === 'web') return json(res, 409, { error: tr('This bot is not connected.') }), true;
          try { const r = await routes['POST /v1/doorbell/test']({ me: b, byOwner: true }); return json(res, 200, r), true; }
          catch (e) { if (e instanceof HttpError) return json(res, e.status, { error: tr.msg(e.message) }), true; throw e; }
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
        tell(user, on ? { what: tr('Asks you first for {name}', { name: c.alias }), undo: f.undo === '1' ? null : undoForm('/app/contacts/privacy', { bot: b.id, peer: c.peer_bot }) }
          : { what: tr('Writes to {name} without asking', { name: c.alias }), undo: inPilot(user) && f.undo !== '1' ? undoForm('/app/contacts/privacy', { bot: b.id, peer: c.peer_bot, on: '1' }) : null });
        return redirect(res, `/app#f-${b.id}-${c.peer_bot}`), true;
      }
      if (p.startsWith('/app/contacts/') && req.method === 'POST') {
        const f = await form(req);
        const { b, c } = ownContact(user, f.bot, f.peer);
        const action = p.slice('/app/contacts/'.length);
        if (action === 'approve') {
          q('UPDATE contacts SET approved_at = ? WHERE owner_bot = ? AND peer_bot = ?').run(clock(), b.id, c.peer_bot);
          log(b.id, 'contact_approved', { peer: c.peer_bot });
          tell(user, { what: tr('{name} connected', { name: c.alias }) });
        } else if (action === 'block') {
          const unblock = f.unblock === '1';
          tx(() => {
            q('UPDATE contacts SET blocked = ? WHERE owner_bot = ? AND peer_bot = ?').run(unblock ? 0 : 1, b.id, c.peer_bot);
            bumpPair(b.id, c.peer_bot);
            if (!unblock) dropBetween(b.id, c.peer_bot);
          });
          log(b.id, unblock ? 'contact_unblocked' : 'contact_blocked', { peer: c.peer_bot, by: 'owner' });
          tell(user, unblock ? { what: tr('Unblocked {name}', { name: c.alias }), undo: f.undo === '1' ? null : undoForm('/app/contacts/block', { bot: b.id, peer: c.peer_bot }) }
            : { what: tr('Blocked {name}', { name: c.alias }), undo: f.undo === '1' ? null : undoForm('/app/contacts/block', { bot: b.id, peer: c.peer_bot, unblock: '1' }) });
        } else if (action === 'disallow') {
          // The dashboard can only take topics away; adding them is done by telling your own bot.
          const left = JSON.parse(c.can_ask || '[]').filter((t) => t !== String(f.topic || ''));
          q('UPDATE contacts SET can_ask = ? WHERE owner_bot = ? AND peer_bot = ?').run(JSON.stringify(left), b.id, c.peer_bot);
          log(b.id, 'ask_topic_removed', { peer: c.peer_bot, by: 'owner' });
          tell(user, { what: tr("{name} can't ask about {topic}", { name: c.alias, topic: String(f.topic || '') }) });
        } else if (action === 'remove') {
          tx(() => {
            bumpPair(b.id, c.peer_bot);
            q('DELETE FROM contacts WHERE (owner_bot = ? AND peer_bot = ?) OR (owner_bot = ? AND peer_bot = ?)').run(b.id, c.peer_bot, c.peer_bot, b.id);
            dropBetween(b.id, c.peer_bot);
          });
          log(b.id, 'contact_removed', { peer: c.peer_bot, by: 'owner' });
          tell(user, { what: tr('Removed {name}', { name: c.alias }) });
        } else throw new HttpError(404, 'Page not found');
        return redirect(res, '/app'), true;
      }

      // Group chats: making one, its page, and every change made there. Each change is for one of your bots that's in it.
      if (groups && p === '/app/groups/new') {
        const bots = groupBots(user);
        if (!bots.length) throw new HttpError(404, 'Connect your bot first.');
        const pick = (id) => bots.find((b) => b.id === Number(id)) ?? (id ? null : bots[0]);
        if (req.method === 'GET') { const b = pick(url.searchParams.get('bot')) ?? bots[0]; return page(res, 200, groupNewPage(user, b)), true; }
        if (req.method !== 'POST') throw new HttpError(404, 'Page not found');
        const f = await form(req);
        const b = pick(f.bot);
        if (!b) throw new HttpError(404, 'Bot not found');
        const members = pickedPeers(f);
        let made;
        try { made = groups.create(b, { name: f.name, members, via: 'web' }); }
        catch (e) { if (e instanceof HttpError) return page(res, e.status, groupNewPage(user, b, { error: groupError(e, tr), name: String(f.name || ''), picked: members })), true; throw e; }
        const n = made.invited.filter((x) => x.invited).length;
        tell(user, { what: n ? tr.n(n, 'Made {name} and invited {n} person|Made {name} and invited {n} people', { name: made.group.name }) : tr('Made {name}', { name: made.group.name }),
          undo: undoForm(`/app/groups/${made.group.id}/end`, { bot: b.id }) });
        return redirect(res, `/app/groups/${made.group.id}?bot=${b.id}`), true;
      }
      const gr = groups && p.match(/^\/app\/groups\/(\d+)(?:\/(join|decline|wake|hide|rename|link|reset-links|admins-add|add|contact|remove|admin|send|leave|end))?$/);
      if (gr) {
        const gid = Number(gr[1]), sub = gr[2] || '';
        if (!sub && req.method === 'GET') return page(res, 200, groupPage(user, groupSeat(user, gid, url.searchParams.get('bot')).b, gid)), true;
        if (!sub || req.method !== 'POST') throw new HttpError(404, 'Page not found');
        const f = await form(req);
        const { b, row } = groupSeat(user, gid, f.bot);
        const g = groups.group(gid);
        const here = `/app/groups/${gid}?bot=${b.id}`;
        const again = f.undo === '1';
        const done = (to) => redirect(res, f.back ? safeNext(f.back) : to);
        const ids = { bot: b.id };
        const someone = (id) => q('SELECT alias FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(b.id, id)?.alias ?? ownerName(id);
        try {
          if (sub === 'join') {
            // A tool too old to read the group updates first; the group page shows the message for it.
            if (!groups.toolReady(b)) return redirect(res, here), true;
            groups.join(b, gid, { byOwner: true });
            tell(user, { what: tr('You joined {name}', { name: g.name }) });
            return redirect(res, here), true;
          }
          if (sub === 'decline') {
            groups.decline(b, gid);
            tell(user, { what: tr('You said no to {name}', { name: g.name }) });
            return done('/app'), true;
          }
          if (sub === 'wake') {
            const was = row.wake;
            groups.settings(b, gid, { wake: String(f.wake || '') });
            tell(user, { what: wakeSaid(f.wake, tr), undo: again || was === f.wake ? null : undoForm(`/app/groups/${gid}/wake`, { ...ids, wake: was }) });
            return redirect(res, here), true;
          }
          if (sub === 'hide') {
            const on = f.on === '1';
            groups.settings(b, gid, { hidden: on });
            tell(user, { what: on ? tr('{name} is hidden from the overview', { name: g.name }) : tr('{name} is back on the overview', { name: g.name }),
              undo: again ? null : undoForm(`/app/groups/${gid}/hide`, { ...ids, ...(on ? {} : { on: '1' }), back: f.back || (on ? here : '') }) });
            // Hidden: back to the overview, where it's gone. Shown again: where you were.
            return done(on ? '/app' : here), true;
          }
          if (sub === 'rename') {
            try { groups.settings(b, gid, { name: f.name }); }
            catch (e) { if (e instanceof HttpError && e.status === 400) return page(res, 400, groupPage(user, b, gid, { nameError: tr('A group name is 1 to 40 characters.') })), true; throw e; }
            const now_ = groups.group(gid).name;
            if (now_ !== g.name) tell(user, { what: tr('Renamed to {name}', { name: now_ }), undo: again ? null : undoForm(`/app/groups/${gid}/rename`, { ...ids, name: g.name }) });
            return redirect(res, here), true;
          }
          if (sub === 'link') {
            groups.link(b, gid);
            tell(user, { what: tr('Invite link ready') });
            return redirect(res, `${here}#invite`), true;
          }
          if (sub === 'reset-links') {
            groups.settings(b, gid, { reset_links: true });
            tell(user, { what: tr('Invite links turned off') });
            return redirect(res, here), true;
          }
          if (sub === 'admins-add') {
            const on = f.on === '1';
            groups.settings(b, gid, { only_admins_add: on });
            tell(user, { what: on ? tr('Only admins can add people') : tr('Everyone can add people'), undo: again ? null : undoForm(`/app/groups/${gid}/admins-add`, { ...ids, ...(on ? {} : { on: '1' }) }) });
            return redirect(res, here), true;
          }
          if (sub === 'add') {
            const who = pickedPeers(f);
            if (!who.length) throw new HttpError(400, 'Pick someone to add.');
            const n = groups.add(b, gid, who, { via: 'web' }).filter((x) => x.invited).length;
            tell(user, { what: tr.n(n, '{n} person invited|{n} people invited') });
            return redirect(res, here), true;
          }
          if (sub === 'contact') {
            const peer = Number(f.peer);
            const r = groups.requestContact(b, peer, gid);
            const name = someone(peer);
            tell(user, r.already ? { what: tr('{name} is already a contact', { name }) } : { what: tr('Asked {name} to connect', { name }), undo: undoForm('/app/contacts/remove', { bot: b.id, peer }) });
            return redirect(res, here), true;
          }
          if (sub === 'remove') {
            const peer = Number(f.member);
            groups.remove(b, gid, String(peer));
            tell(user, { what: tr('Removed {name} from the group', { name: someone(peer) }) });
            return redirect(res, here), true;
          }
          if (sub === 'admin') {
            const peer = Number(f.member), on = f.on === '1';
            groups.setAdmin(b, gid, String(peer), on);
            tell(user, { what: on ? tr('{name} is an admin now', { name: someone(peer) }) : tr('{name} is no longer an admin', { name: someone(peer) }),
              undo: again ? null : undoForm(`/app/groups/${gid}/admin`, { ...ids, member: peer, ...(on ? {} : { on: '1' }) }) });
            return redirect(res, here), true;
          }
          if (sub === 'send') {
            const choices = String(f.choices || '').split(',').map((x) => x.trim()).filter(Boolean);
            const links = String(f.link || '').trim() ? [String(f.link).trim()] : [];
            groups.send(b, gid, { kind: choices.length ? 'ask' : 'note', text: String(f.text || ''), links, choices }, { ownerWeb: true });
            tell(user, { what: tr('Sent to the group') });
            return redirect(res, here), true;
          }
          if (sub === 'leave') {
            groups.leave(b, gid);
            tell(user, { what: tr('You left {name}', { name: g.name }) });
            return redirect(res, '/app'), true;
          }
          if (sub === 'end') {
            groups.end(b, gid);
            tell(user, { what: tr('Ended {name}', { name: g.name }) });
            return redirect(res, '/app'), true;
          }
        } catch (e) { if (e instanceof HttpError && e.status !== 404) return page(res, e.status, groupPage(user, b, gid, { error: groupError(e, tr) })), true; throw e; }
      }
      // A basket hidden from the overview's friends list (or shown again). Its people stay as they are.
      if (p === '/app/baskets/hide' && req.method === 'POST') {
        const f = await form(req);
        const ids = myBots(user).map((b) => b.id);
        const ph = ids.map(() => '?').join(',') || 'NULL';
        const key = String(f.basket || '');
        const g = q(`SELECT name FROM circles WHERE owner_bot IN (${ph}) AND name_key = ?`).get(...ids, key);
        if (!g) throw new HttpError(404, 'Basket not found');
        const on = f.on === '1';
        q(`UPDATE circles SET hidden = ? WHERE owner_bot IN (${ph}) AND name_key = ?`).run(on ? 1 : 0, ...ids, key);
        tell(user, { what: on ? tr('{name} is hidden from the overview', { name: g.name }) : tr('{name} is back on the overview', { name: g.name }),
          undo: f.undo === '1' ? null : undoForm('/app/baskets/hide', { basket: key, ...(on ? {} : { on: '1' }), back: f.back || '' }) });
        return redirect(res, f.back ? safeNext(f.back) : '/app'), true;
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
        tell(user, on ? { what: tr('Paused'), undo: f.undo === '1' ? null : undoForm('/app/pause', { on: '0' }) }
          : { what: tr('Resumed'), undo: f.undo === '1' ? null : undoForm('/app/pause', { on: '1' }) });
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
        catch (e) { if (e instanceof HttpError && e.status !== 404) return page(res, e.status, peoplePage(user, b, { error: ownerError(e, tr) })), true; throw e; }
        const back = (u) => (undone ? {} : { undo: u });
        if (pa[1] === 'move') {
          const peer = Number(f.peer), now = contact(peer), g = now.circle_id ? group(now.circle_id) : null;
          tell(user, { what: g ? tr('Moved {name} to {basket}', { name: now.alias, basket: g.name }) : tr('Moved {name} to not sorted yet', { name: now.alias }), ...back(undoForm('/app/people/move', { bot: b.id, peer, circle: before.circle_id ?? '' })) });
        } else if (pa[1] === 'mode') {
          const g = group(Number(f.circle));
          tell(user, { what: g.mode === 'asks' ? tr('{basket} asks you first', { basket: g.name }) : tr('Your bot handles {basket}', { basket: g.name }), ...back(undoForm('/app/people/mode', { bot: b.id, circle: g.id, mode: before.mode })) });
        } else if (pa[1] === 'restore') {
          tell(user, { what: tr('{name} is back', { name: String(f.name) }) });
        } else if (f.delete === '1') {
          tell(user, { what: tr('Removed {name}', { name: before.name }), undo: undoForm('/app/people/restore', { bot: b.id, name: before.name, mode: before.mode, peers: members.join(',') }) });
        } else if (f.circle) {
          tell(user, { what: tr('Renamed to {name}', { name: String(f.name).trim() }), ...back(undoForm('/app/people/baskets', { bot: b.id, circle: before.id, name: before.name })) });
        } else {
          const added = result.applied.find((o) => o.op === 'add_circle');
          tell(user, { what: tr('Added {name}', { name: added.name }), ...back(undoForm('/app/people/baskets', { bot: b.id, circle: added.id, delete: '1' })) });
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
            tell(user, { what: tr('Rule is back') });
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
            : pm[3] === 'about' ? [...(f.alias != null && line(f.alias).trim() !== was.alias ? [{ op: 'rename', contact: peer, name: line(f.alias) }] : []), { op: 'set_purpose', contact: peer, purpose: line(f.purpose) }, { op: 'set_notes', contact: peer, notes: line(f.notes) }]
            : pm[3] === 'topics' ? [f.remove != null ? { op: 'remove_topic', contact: peer, topic: String(f.remove) } : { op: 'add_topic', contact: peer, topic: String(f.add ?? '') }]
            : [f.remove != null ? { op: 'remove_rule', rule: String(f.remove) } : { op: 'add_rule', contact: peer, text: line(f.add) }];
          if (pm[3] === 'rules' && f.remove != null && !q('SELECT 1 FROM contact_rules WHERE id = ? AND owner_bot = ? AND peer_bot = ?').get(String(f.remove), b.id, peer)) throw new HttpError(404, 'Rule not found');
          let result;
          try { result = applyOwnerOps(b.id, ops); }
          catch (e) { if (e instanceof HttpError && e.status !== 404) return page(res, e.status, personPage(user, b, peer, { error: ownerError(e, tr) })), true; throw e; }
          const now = getSettings(b.id).contacts.find((c) => c.peer_bot === peer), base = `/app/people/${b.id}/${peer}`;
          const back = (u) => (undone ? {} : { undo: u });
          if (pm[3] === 'basket') {
            tell(user, { what: now.mode_override === 'asks' ? tr('Asks you first') : now.circle ? tr('Moved to {basket}', { basket: now.circle.name }) : tr('Moved to not sorted yet'),
              ...back(undoForm(`${base}/basket`, { circle: was.circle?.id ?? '', mode: was.mode_override ?? '' })) });
          } else if (pm[3] === 'about') {
            tell(user, { what: now.alias !== was.alias ? tr('Now called {name}', { name: now.alias }) : tr('Saved'), ...back(undoForm(`${base}/about`, { alias: was.alias, purpose: was.purpose ?? '', notes: was.notes ?? '' })) });
          } else if (pm[3] === 'topics') {
            const t = ops[0].topic.trim().toLowerCase();
            tell(user, f.remove != null ? { what: tr('Removed {name}', { name: t }), ...back(undoForm(`${base}/topics`, { add: t })) }
              : { what: tr('Added {name}', { name: t }), ...back(undoForm(`${base}/topics`, { remove: t })) });
          } else if (f.remove != null) {
            tell(user, { what: tr('Rule removed'), ...back(undoForm(`${base}/rules`, { restore: String(f.remove) })) });
          } else {
            const added = result.applied.find((o) => o.op === 'add_rule');
            tell(user, { what: tr('Rule added'), ...back(undoForm(`${base}/rules`, { remove: added?.id ?? added?.rule ?? '' })) });
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
            catch (e) { if (e instanceof HttpError && e.status !== 404) return page(res, e.status, oneRequestPage(user, getRequest(b.id, rq[2], { owner: true }), { error: ownerError(e, tr) })), true; throw e; }
            const who = peerFace(b.id, r.peer_bot, tr).alias;
            tell(user, { what: { ENQUEUED: tr('Sent to {name}', { name: who }), APPROVED: tr('Okayed. Your bot sends it to {name}', { name: who }), DECLINED: tr('Declined') }[r.state] || tr('Already decided') });
            return redirect(res, '/app/requests'), true;
          }
          if (req.method === 'GET') return page(res, 200, oneRequestPage(user, getRequest(b.id, rq[2], { owner: true }))), true;
        } else {
          const prop = () => q('SELECT * FROM settings_proposals WHERE id = ?').get(rq[2]);
          if (f) {
            let r;
            try { r = decideProposal(b.id, rq[2], String(f.decision || '')); }
            catch (e) { if (e instanceof HttpError) return page(res, e.status === 404 ? 409 : e.status, oneProposalPage(user, b, prop(), { error: tr("This change doesn't fit any more: {why} Ask your bot again.", { why: ownerError(e, tr) }) })), true; throw e; }
            tell(user, { what: { APPROVED: tr('Done. Your bot has the new settings'), DECLINED: tr('Declined') }[r.state] || tr('Already decided') });
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
        if (!isHeadPage()) erase(`to_bot IN (${ph_}) AND status IN ('pending', 'claimed') AND kind != 'probe' AND created_at <= ?`, ...wbs.map((b) => b.id), clock() - L.undeliveredExpiryMs);
        const html = inboxPage(user);
        if (!isHeadPage()) markSeen(wbs.map((b) => b.id));
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
        catch (e) { if (e instanceof HttpError) return page(res, e.status, inboxPage(user, { error: tr.msg(e.message.replace(/^\w/, (x) => x.toUpperCase())) })), true; throw e; }
        tell(user, { what: tr('Sent to {name}', { name: c.alias }) });
        return redirect(res, `/app/inbox#c-${c.peer_bot}`), true;
      }

      if (promo && p === '/app/gifts' && req.method === 'GET') return page(res, 200, isHeadPage() ? '' : promo.page(user, tr)), true;
      if (promo && p === '/app/gifts/redeem' && req.method === 'POST') {
        const f = await form(req);
        try {
          const r = invites.redeem(user, f.code);
          if (!r.again) tell(user, { what: promo.claimed(tr, r.inv.from_name) });
        } catch (e) { if (e instanceof HttpError) return page(res, e.status, promo.page(user, tr, { error: e.message, code: String(f.code || '').slice(0, 12) })), true; throw e; }
        return redirect(res, '/app/gifts'), true;
      }

      if (p === '/app/billing' && req.method === 'GET') {
        if (!hosted) return redirect(res, '/app'), true;
        return page(res, 200, billingPage(user, { paid: url.searchParams.get('paid') === '1' })), true;
      }
      if (p === '/app/billing/checkout' && req.method === 'POST') {
        // Paying is in hosted-billing.mjs; without it (or without Stripe set up) there is nothing to pay.
        if (!hosted || !payments?.canPay) return page(res, 400, billingPage(user, { error: tr('Payments are not set up on this server yet.') })), true;
        const r = await payments.checkout(user);
        if (!r.url) return page(res, 502, billingPage(user, { error: tr('The payment page could not be opened. Try again in a minute.') })), true;
        return redirect(res, r.url), true;
      }
      if (p === '/app/billing/members' && req.method === 'POST') {
        if (!hosted) return redirect(res, '/app'), true;
        const f = await form(req);
        if (f.remove) {
          const gone = String(f.remove).toLowerCase();
          q('DELETE FROM household_members WHERE payer_user_id = ? AND email = ?').run(user.id, gone);
          tell(user, { what: tr('Removed {name}', { name: gone }), undo: f.undo === '1' ? null : undoForm('/app/billing/members', { email: gone }) });
        } else {
          const email = String(f.email || '').trim().toLowerCase();
          const n = q('SELECT count(*) AS n FROM household_members WHERE payer_user_id = ?').get(user.id).n;
          if (!EMAIL_RE.test(email) || email === user.email) return page(res, 400, billingPage(user, { error: tr('That email address looks wrong.') })), true;
          if (n >= B.householdSize - 1) return page(res, 400, billingPage(user, { error: tr('Your plan covers up to {n} people.', { n: B.householdSize - 1 }) })), true;
          q('INSERT OR IGNORE INTO household_members (payer_user_id, email, added_at) VALUES (?, ?, ?)').run(user.id, email, clock());
          tell(user, { what: tr('Added {name}', { name: email }), undo: f.undo === '1' ? null : undoForm('/app/billing/members', { remove: email }) });
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
        // First visit: their name comes with it (it used to be guessed from the email).
        if (f.name !== undefined) {
          const name = cleanName(f.name);
          if (!name) return page(res, 400, picturePage(user, next, { nameError: tr('Tell us what to call you.') })), true;
          setName(user, name);
        }
        if (f.photo) {
          const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(f.photo));
          const jpg = m && Buffer.from(m[1], 'base64');
          if (!jpg || jpg.length > 200_000 || jpg[0] !== 0xff || jpg[1] !== 0xd8 || jpg[2] !== 0xff) return page(res, 400, picturePage(user, next, { error: tr("That photo couldn't be used. Try a JPEG or PNG.") })), true;
          q('UPDATE users SET photo = ?, avatar = NULL, photo_at = ? WHERE id = ?').run(jpg, clock(), user.id);
        } else if (ROBOT.has(f.avatar) || isSticker(f.avatar)) q('UPDATE users SET avatar = ?, photo = NULL, photo_at = ? WHERE id = ?').run(f.avatar, clock(), user.id);
        else if (!hasPicture(user)) return page(res, 400, picturePage(user, next, { error: tr('Pick a picture or upload a photo.') })), true;
        // A picked picture can be swapped back; a replaced photo is gone.
        const was = user.avatar || null; // a photo clears avatar
        tell(user, { what: tr('Picture saved'), undo: was && was !== f.avatar && f.undo !== '1' ? undoForm('/app/picture', { avatar: was, next }) : null });
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
      if (p === '/app/admin' && req.method === 'GET') {
        if (!admin?.isAdmin(user)) throw new HttpError(404, 'Page not found');
        return page(res, 200, admin.page(user, tr)), true;
      }
      if (p === '/app/feedback' && req.method === 'GET') {
        return page(res, 200, layout(tr('Send feedback'), `<section class="card"><form method="post" action="/app/feedback" class="stack" style="margin:0"><input type="hidden" name="via" value="page">${feedbackFields(tr, { question: questionFor(user) })}
<div><button class="btn">${tr('Send')}</button></div></form></section>${boardPages ? `<p class="muted center">${tr('Got an idea or found a bug? <a class="link" href="/feedback">Post it on the board</a>, where others can vote for it.')}</p>` : ''}`, { user, tr, width: 'read', bar: { back: '/app', title: tr('Send feedback') } })), true;
      }
      if (p === '/app/feedback' && req.method === 'POST') {
        const f = await form(req);
        const text = String(f.text ?? '').normalize('NFC').trim().slice(0, 2000);
        const rating = [1, 2, 3].includes(Number(f.rating)) ? Number(f.rating) : null;
        const question = QUESTION_BY_ID.get(String(f.question || '')) ?? null;
        const answer = question && [1, 2, 3].includes(Number(f.answer)) ? Number(f.answer) : null;
        if (!text && !rating && !answer) { tell(user, { what: tr('Nothing to send yet') }); return redirect(res, f.via === 'page' ? '/app/feedback' : '/app'), true; }
        q('INSERT INTO feedback (user_id, rating, text, via, lang, created_at, question, answer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(user.id, rating, text, f.via === 'popup' ? 'popup' : 'page', tr.lang, clock(), answer ? question.id : null, answer);
        q('UPDATE users SET feedback_asked_at = ? WHERE id = ?').run(clock(), user.id);
        markAsked(user, question?.id);
        log(null, 'feedback', { user: user.id, rating });
        if (feedbackTo) mailer({ to: feedbackTo, subject: `bot2bot feedback${rating ? ` (${['', 'not great', 'okay', 'love it'][rating]})` : ''}`, text: `From ${user.name} <${user.email}>\n\n${answer ? `${question.en} ${['', 'No', 'Mostly', 'Yes'][answer]}\n\n` : ''}${text || '(no text)'}` }).catch(() => {});
        tell(user, { what: tr('Thanks! We read every message.') });
        return redirect(res, '/app'), true;
      }
      if (p === '/app/whatsnew' && req.method === 'POST') {
        const f = await form(req);
        if (latestUpdate && f.id === latestUpdate.iso) q('UPDATE users SET seen_update = ? WHERE id = ?').run(latestUpdate.iso, user.id);
        if (String(req.headers.accept || '').includes('text/html')) return redirect(res, '/app'), true;
        res.writeHead(204).end(); return true;
      }
      if (p === '/app/account/name' && req.method === 'POST') {
        const f = await form(req);
        const name = cleanName(f.name), was = user.name;
        if (!name) return page(res, 400, accountPage(user, { nameError: tr('Tell us what to call you.') })), true;
        setName(user, name);
        tell(user, { what: tr('Name saved'), undo: f.undo === '1' || was === name ? null : undoForm('/app/account/name', { name: was }) });
        return redirect(res, '/app/account'), true;
      }
      // The dashboard's language. Also remembered in the browser, so the login page matches after logging out.
      if (p === '/app/account/lang' && req.method === 'POST') {
        const f = await form(req);
        const was = normLang(user.lang), lang = normLang(f.lang);
        q('UPDATE users SET lang = ? WHERE id = ?').run(lang, user.id);
        res.setHeader('set-cookie', langCookie(lang));
        user.lang = lang; tr = T(user);
        tell(user, { what: tr('Language saved'), undo: f.undo === '1' || lang === was ? null : undoForm('/app/account/lang', { lang: was }) });
        return redirect(res, '/app/account'), true;
      }
      // Light, Dark, or (empty) follow the device.
      if (p === '/app/account/theme' && req.method === 'POST') {
        const f = await form(req);
        const was = user.theme || '', theme = ['light', 'dark'].includes(f.theme) ? f.theme : '';
        q('UPDATE users SET theme = ? WHERE id = ?').run(theme || null, user.id);
        tell(user, { what: tr('Appearance saved'), undo: f.undo === '1' || theme === was ? null : undoForm('/app/account/theme', { theme: was }) });
        return redirect(res, '/app/account'), true;
      }
      if (p === '/app/account/quiet' && req.method === 'POST') {
        const f = await form(req);
        const start = parseHhmm(f.start), end = parseHhmm(f.end);
        if (start === null || end === null || !validTz(f.tz)) return page(res, 400, accountPage(user, { quietError: tr('Check the times and the time zone.') })), true;
        q('UPDATE users SET quiet_on = ?, quiet_start = ?, quiet_end = ?, tz = ? WHERE id = ?').run(f.on === '1' ? 1 : 0, start, end, f.tz, user.id);
        tell(user, { what: f.on === '1' ? tr('Quiet {from} to {to}', { from: hhmm(start), to: hhmm(end) }) : tr('Quiet hours off'),
          undo: f.undo === '1' ? null : undoForm('/app/account/quiet', { ...(user.quiet_on ? { on: '1' } : {}), start: hhmm(user.quiet_start ?? 1320), end: hhmm(user.quiet_end ?? 480), tz: user.tz || f.tz }) });
        if (f.on !== '1' || !quietUntil({ ...user, quiet_on: f.on === '1' ? 1 : 0, quiet_start: start, quiet_end: end, tz: f.tz }, clock())) for (const b of liveBots(user)) release(b.id);
        return redirect(res, '/app/account'), true;
      }
      if (p === '/app/account/files' && req.method === 'POST') {
        if (!files?.inAlpha(user)) throw new HttpError(404, 'Page not found');
        const f = await form(req);
        const on = f.on === '1';
        const was = files.isOn(user);
        files.setOn(user, on);
        log(null, 'files_switch', { user: user.id, on });
        tell(user, { what: on ? tr('Sending files on') : tr('Sending files off'), undo: f.undo === '1' || on === was ? null : undoForm('/app/account/files', was ? { on: '1' } : {}) });
        return redirect(res, '/app/account#files'), true;
      }
      if (p === '/app/account/export' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-disposition': `attachment; filename="${product}-export.json"` });
        res.end(JSON.stringify({ ...exportData(user), ...(inPilot(user) ? { governance: governance.exportData(myBots(user).map((b) => b.id)) } : {}) }, null, 2));
        return true;
      }
      if (p === '/app/account/delete' && req.method === 'POST') {
        const f = await form(req);
        if (String(f.confirm || '').trim().toLowerCase() !== user.email) return page(res, 400, accountPage(user, { error: tr('Type your email address exactly to confirm.') })), true;
        deleteAccount(user);
        res.setHeader('set-cookie', sessionCookie('', 0));
        return page(res, 200, layout(tr('Account deleted'), `<section class="card narrow center"><h1>${tr('Your account is deleted')}</h1><p>${tr("Your bots are disconnected, contacts removed and message text erased. Copies your friends' bots already received stay with them.")}</p><a class="btn wide" href="/">${tr('Back to {product}', { product: esc(product) })}</a></section>`, { tr })), true;
      }

      if (p === '/app/invites' && req.method === 'POST') {
        const f = await form(req);
        const b = ownBot(user, f.bot);
        if (b.disconnected_at) throw new HttpError(400, 'Reconnect this bot first.');
        // New friends start in friends unless the owner picks another basket on the next page.
        const basket = pickBasket(b.id, f.basket ?? 'friends');
        const plain = newInvite(b, basket);
        log(b.id, 'invite_created', { via: 'link' });
        return page(res, 200, invitedPage(user, b, `${origin}/i/${plain}`, { code: plain, basket })), true;
      }
      const openInv = p.match(/^\/app\/invites\/([A-Z0-9]{4}-[A-Z0-9]{4})$/);
      if (openInv && req.method === 'GET') {
        const inv = q('SELECT * FROM invites WHERE plain_code = ? AND used_at IS NULL AND expires_at > ?').get(openInv[1], clock());
        const b = inv && myBots(user).find((x) => x.id === inv.from_bot);
        if (!b) throw new HttpError(404, 'That invite was used, cancelled or has expired.');
        return page(res, 200, invitedPage(user, b, `${origin}/i/${inv.plain_code}`, { code: inv.plain_code, basket: inv.basket, notes: inv.notes, alias: inv.alias })), true;
      }
      if (p === '/app/invites/cancel' && req.method === 'POST') {
        const f = await form(req);
        const b = ownBot(user, f.bot);
        const plain = String(f.code || '').trim().toUpperCase();
        const inv = q('SELECT * FROM invites WHERE code_hash = ? AND from_bot = ? AND used_at IS NULL').get(sha(plain), b.id);
        if (!inv) throw new HttpError(404, 'That invite was already used.');
        if (f.undo === '1') {
          q('UPDATE invites SET expires_at = ? WHERE code_hash = ?').run(Math.max(Number(f.until) || 0, clock() + 60_000), inv.code_hash);
          tell(user, { what: tr('Invite is back') });
        } else {
          q('UPDATE invites SET expires_at = ? WHERE code_hash = ?').run(clock(), inv.code_hash);
          log(b.id, 'invite_cancelled', {});
          tell(user, { what: tr('Invite cancelled'), undo: undoForm('/app/invites/cancel', { bot: b.id, code: plain, until: inv.expires_at }) });
        }
        return redirect(res, '/app'), true;
      }
      if (p === '/app/invites/basket' && req.method === 'POST') {
        const f = await form(req);
        const b = ownBot(user, f.bot);
        const plain = String(f.code || '').trim().toUpperCase();
        const inv = q('SELECT * FROM invites WHERE code_hash = ? AND from_bot = ? AND used_at IS NULL AND expires_at > ?').get(sha(plain), b.id, clock());
        if (!inv) throw new HttpError(404, 'That invite was used or has expired.');
        const basket = f.basket === undefined ? inv.basket : pickBasket(b.id, f.basket || null);
        const notes = f.notes === undefined ? inv.notes : String(f.notes).normalize('NFC').trim().slice(0, 280) || null;
        // The name they'll have for you right away; left empty, it becomes their own first name when they say yes.
        const said = String(f.alias ?? '').normalize('NFC').trim();
        const alias = said ? said : inv.alias.startsWith('friend-') || f.alias === undefined ? inv.alias : `friend-${plain.slice(0, 4).toLowerCase()}`;
        const invalid = said && !/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u.test(said) ? tr('A name is 1-32 letters or numbers.')
          : said && q('SELECT 1 FROM contacts WHERE owner_bot = ? AND lower(alias) = lower(?)').get(b.id, said) ? tr('You already have someone called "{name}".', { name: said }) : '';
        if (invalid) return page(res, 400, invitedPage(user, b, `${origin}/i/${plain}`, { code: plain, basket, notes, alias: said, error: invalid })), true;
        q('UPDATE invites SET basket = ?, notes = ?, alias = ?, saved_at = coalesce(saved_at, ?) WHERE code_hash = ?').run(basket, notes, alias, clock(), inv.code_hash);
        // Saved: back to the overview, where the invite now waits under "Invites pending".
        tell(user, { what: alias.startsWith('friend-') ? tr('Invite saved · {basket}', { basket: basket || tr('not sorted yet') }) : tr('Invite saved for {name} · {basket}', { name: alias, basket: basket || tr('not sorted yet') }), undo: f.undo === '1' ? null : undoForm('/app/invites/basket', { bot: b.id, code: plain, basket: inv.basket ?? '', notes: inv.notes ?? '', alias: inv.alias.startsWith('friend-') ? '' : inv.alias }) });
        return redirect(res, '/app'), true;
      }

      throw new HttpError(404, 'Page not found');
    } catch (e) {
      if (e instanceof HttpError) { page(res, e.status, layout(tr('Error'), `<section class="card narrow center"><h1>${e.status === 404 ? tr('This page isn&#39;t here') : tr('Something went wrong')}</h1><p>${e.message === 'Page not found' ? tr('The link may be old, or the page has moved.') : esc(tr.msg(e.message))}</p>${onward(cookies(req).b2b_in, tr)}</section>`, { tr })); return true; }
      throw e;
    }
  }
  return (req, res, url) => pageRequest.run(req.method, () => handleApp(req, res, url));
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
  gift: svg('<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7M7.5 8a2.5 2.5 0 0 1 0-5C9.5 3 12 8 12 8s2.5-5 4.5-5a2.5 2.5 0 0 1 0 5"/>'),
  list: svg('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>'),
  people: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
  invite: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>'),
  plus: svg('<path d="M5 12h14M12 5v14"/>'),
  pause: svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  alert: svg('<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  pen: svg('<path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/><path d="m15 5 4 4"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  dots: svg('<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>', true),
  chev: svg('<path d="m9 18 6-6-6-6"/>'),
  out: svg('<path d="M7 17 17 7M7 7h10v10"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>'),
  chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>'),
  bulb: svg('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3Z"/>'),
  copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  updown: svg('<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>'),
  chevDown: svg('<path d="m6 9 6 6 6-6"/>'),
  arrowUp: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  bell: svg('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  bellOn: svg('<path fill="currentColor" d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M2 8.5c0-2.2.7-4.3 2-6"/><path d="M22 8.5a10 10 0 0 0-2-6"/>'),
  bellOff: svg('<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="m2 2 20 20"/>'),
};
// Where a bot runs, as the assistant's own mark (the same single-colour marks as the site's Works with row):
// Grok (Lobe Icons, MIT), OpenAI's Blossom (Simple Icons, CC0, unaltered), OpenClaw's lobster (openclaw.ai, MIT).
// Claude Code gets Claude's mark, Codex the Codex app's and Cursor its cube (Lobe Icons, MIT), as on the site; Hermes Agent Nous Research's mark
// (its own icon too; Lobe Icons, MIT). Other apps get a plug, the web inbox a browser window.
// Chat apps that add bot2bot send as a custom MCP server, in the order the setup page and dashboard list them.
// Microsoft Copilot isn't here: only a company admin can add a server to it, with a client secret we don't issue.
const CHAT_APPS = [['chatgpt', 'ChatGPT'], ['claude', 'Claude'], ['gemini', 'Gemini'], ['grok', 'Grok'], ['perplexity', 'Perplexity'], ['lechat', 'Le Chat']].map(([key, label]) => ({ key, label }));
const MARK = {
  chatgpt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"/></svg>',
  // Mistral's mark for Le Chat (Simple Icons, CC0).
  lechat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z"/></svg>',
  perplexity: `<svg viewBox="${ASSISTANT.perplexity.mark.viewBox}" aria-hidden="true">${ASSISTANT.perplexity.mark.body}</svg>`,
  gemini: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></svg>',
  // OpenAI dots: OpenAI's yellow Dot with glasses, traced to one colour.
  dots: '<svg viewBox="0 0 1051 1010" aria-hidden="true"><g transform="translate(-100.18,1116.71) scale(0.1,-0.1)" fill="currentColor"><path d="M5800 11160 c-396 -41 -794 -171 -1109 -364 -340 -207 -709 -581 -1024 -1039 -347 -503 -718 -1136 -994 -1697 -164 -334 -209 -434 -476 -1075 -211 -508 -397 -939 -622 -1450 -261 -591 -377 -906 -475 -1290 -73 -285 -89 -392 -97 -620 -20 -613 189 -1123 630 -1540 603 -571 1501 -848 3202 -986 369 -30 1233 -38 1661 -15 881 47 1298 83 1854 157 1414 188 2106 420 2611 878 266 242 473 608 536 951 21 116 24 420 5 555 -68 483 -261 986 -626 1635 -224 398 -710 1199 -721 1189 -9 -9 -10 -33 -5 -174 3 -104 -104 -363 -208 -500 -83 -111 -310 -330 -406 -393 -332 -217 -758 -215 -1101 6 -318 204 -598 536 -756 895 -102 234 -112 235 -163 15 -88 -371 -320 -713 -656 -967 -313 -236 -743 -303 -1112 -175 -245 86 -394 190 -653 456 -261 268 -400 509 -505 876 -43 149 -52 164 -118 186 -61 21 -88 20 -308 -9 -463 -63 -793 -144 -994 -245 -51 -26 -104 -63 -274 -194 -96 -74 -137 -65 -253 58 -141 147 -125 211 108 429 100 93 111 101 294 191 106 53 224 104 266 115 41 11 89 25 105 31 71 28 532 113 697 130 51 5 144 14 207 21 82 8 127 17 155 33 46 24 56 50 100 256 33 153 48 189 111 261 27 31 65 84 84 117 117 204 142 235 324 417 100 99 207 198 239 219 32 21 85 61 117 90 60 54 139 89 230 101 25 3 83 15 128 27 153 36 394 13 485 -47 28 -19 84 -45 122 -59 213 -73 534 -330 705 -562 25 -34 67 -92 93 -128 54 -73 149 -265 167 -336 25 -101 50 -131 90 -110 21 11 23 20 66 200 38 164 121 368 177 436 13 16 40 56 59 89 50 83 261 287 368 356 215 139 414 197 519 151 26 -12 79 -23 123 -27 43 -3 98 -12 123 -19 l45 -14 -34 42 c-18 22 -63 88 -98 146 -201 325 -653 997 -787 1170 -467 603 -941 962 -1423 1080 -254 62 -596 92 -808 70z M8550 8249 c-71 -12 -170 -62 -232 -118 -121 -108 -250 -428 -273 -676 -3 -38 -15 -103 -27 -144 -12 -47 -18 -89 -14 -115 3 -23 10 -87 15 -143 6 -56 15 -113 21 -128 5 -14 10 -52 10 -83 0 -43 8 -73 31 -122 17 -36 37 -99 45 -140 9 -45 29 -100 50 -139 20 -36 44 -93 55 -126 10 -34 49 -113 86 -176 123 -209 301 -354 514 -419 113 -35 150 -37 194 -10 18 11 59 25 91 31 229 40 335 118 429 314 92 192 125 355 125 619 0 470 -115 856 -362 1218 -182 266 -479 406 -758 357z m798 -1033 c37 -20 101 -89 151 -163 47 -71 53 -119 25 -227 -30 -120 -80 -202 -189 -312 -149 -152 -238 -202 -394 -224 -61 -9 -81 -7 -164 14 -52 13 -108 31 -125 40 -95 49 -280 216 -361 326 -91 122 -149 273 -131 339 19 73 155 201 212 201 72 0 147 -77 238 -243 77 -141 108 -181 163 -209 61 -31 103 -28 183 12 78 39 85 53 119 213 16 74 20 82 81 146 89 95 136 116 192 87z M5855 8216 c-169 -27 -365 -117 -462 -212 -127 -126 -243 -369 -294 -614 -28 -133 -42 -480 -23 -559 7 -31 13 -89 14 -130 0 -63 5 -85 39 -160 21 -47 44 -112 51 -144 23 -115 106 -266 209 -386 139 -161 234 -249 286 -264 28 -9 87 -32 133 -52 299 -132 678 -83 903 117 86 75 210 306 253 468 56 208 66 318 55 560 -13 306 -81 576 -205 820 -148 291 -282 422 -522 510 -154 56 -283 69 -437 46z m899 -1107 c76 -70 136 -161 136 -208 0 -59 -27 -149 -72 -241 -36 -75 -56 -100 -177 -221 -118 -117 -147 -141 -218 -177 -113 -56 -210 -76 -332 -69 -199 10 -297 63 -502 267 -130 130 -150 155 -192 236 -89 173 -85 226 22 337 115 120 158 127 249 42 50 -46 70 -76 127 -191 72 -143 84 -157 162 -179 26 -8 66 -20 89 -29 49 -18 174 -6 241 24 53 23 92 88 123 206 19 74 29 92 74 141 120 132 179 146 270 62z"/></g></svg>',
  grok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815"/></svg>',
  openclaw: '<svg viewBox="0 0 120 120" aria-hidden="true"><g fill="currentColor"><path d="M60 10C30 10 15 35 15 55c0 20 15 40 30 45v10h10v-10s5 2 10 0v10h10v-10c15-5 30-25 30-45 0-20-15-45-45-45Z"/><path d="M20 45C5 40 0 50 5 60s15 5 20-5c3-7 0-10-5-10Z"/><path d="M100 45c15-5 20 5 15 15s-15 5-20-5c-3-7 0-10 5-10Z"/></g><g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"><path d="M45 15Q35 5 30 8"/><path d="M75 15Q85 5 90 8"/></g><g fill="var(--mark-bg, var(--surface))"><circle cx="45" cy="35" r="6"/><circle cx="75" cy="35" r="6"/></g></svg>',
  claude: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
  codex: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"/></svg>',
  cursor: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M22.106 5.68L12.5.135a.998.998 0 00-.998 0L1.893 5.68a.84.84 0 00-.419.726v11.186c0 .3.16.577.42.727l9.607 5.547a.999.999 0 00.998 0l9.608-5.547a.84.84 0 00.42-.727V6.407a.84.84 0 00-.42-.726zm-.603 1.176L12.228 22.92c-.063.108-.228.064-.228-.061V12.34a.59.59 0 00-.295-.51l-9.11-5.26c-.107-.062-.063-.228.062-.228h18.55c.264 0 .428.286.296.514z"/></svg>',
  // T3 Code's own one-colour mark, from the nav on t3.codes, padded to a square.
  t3code: '<svg viewBox="15.5309 18.28 94.3941 94.3941" aria-hidden="true"><path fill="currentColor" d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"></path></svg>',
  hermes: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="M5.938 12.835c.127-.039.285.02.373.143.028.038.036.092.046.14.003.014-.02.033-.04.05-.124-.098-.24-.194-.354-.291-.011-.01-.016-.027-.025-.042zM8.396 9.412c.195-.032.39-.06.588-.05a.54.54 0 01.148.026c.202.071.402.147.601.224.028.01.05.036.075.055l-.013.027a9.203 9.203 0 01-.26-.089c-.115-.038-.213-.077-.315-.098-.25-.05-.25-.046-.292-.014l.574.144c.275.139.55.276.823.417.042.022.09.057.107.098.026.06.063.076.117.072.066-.006.132-.017.213-.027l-.04.086c.051.08.142.02.216.064-.074.13-.247.09-.334.199l.061.074-.12.087c0 .106-.038.168-.306.243l.026.085-.196.042.07.124h-.25l-.007.137c-.081-.01-.161-.018-.244-.027l-.053.123c-.027-.008-.052-.011-.073-.023-.067-.038-.128-.056-.195.006-.019.017-.063.014-.093.008-.026-.006-.05-.029-.07-.042-.11.095-.11.095-.208.003-.057.046-.12.074-.186.011-.063.027-.123-.02-.178-.014-.07.007-.097-.035-.133-.07l-.13.033c-.013-.236-.194-.19-.34-.203.005-.072.05-.092.095-.094a.474.474 0 01.159.022c.164.05.32.12.496.138.203.021.405.029.601-.015.265-.059.52-.149.707-.365.049-.056.083-.127.117-.195.019-.038.02-.084-.02-.116a1.397 1.397 0 00-.382-.217c.024.12-.031.182-.115.221 0 .014-.004.025 0 .03.08.115.084.16-.007.267a1.39 1.39 0 01-.218.211.477.477 0 01-.641-.05 1.36 1.36 0 01-.133-.152c-.078-.107-.076-.108-.033-.236-.165-.08-.128-.226-.104-.364.008-.05.028-.096.049-.163-.04.014-.067.017-.087.032a.897.897 0 00-.316.357c-.007.016-.01.034-.02.047-.012.015-.034.038-.045.035-.02-.006-.037-.027-.05-.045-.008-.012-.007-.032-.012-.057h-.126l.053-.172a14.82 14.82 0 00-.039-.049l.11-.284c-.06.026-.091.044-.124.051-.03.007-.064 0-.095 0 0-.031-.01-.07.004-.092.149-.22.305-.428.593-.476z"/><path fill="currentColor" fill-rule="evenodd" d="M8.06 10.788c-.003-.038-.004-.075.037-.062.016.006.034.048.028.067-.01.04-.038.032-.064-.005z"/><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M11.981.009c.226-.012.453-.011.679 0 .247.01.495.024.74.062.401.064.798.157 1.19.273.463.138.92.299 1.356.511a7.31 7.31 0 012.948 2.642c.292.469.536.963.739 1.479.219.556.446 1.11.623 1.683.204.654.329 1.326.458 1.997.097.504.182 1.01.29 1.511.156.722.329 1.44.494 2.16.186.812.4 1.615.63 2.415.102.355.193.713.282 1.072.11.436.202.876.254 1.323.031.278.066.557.073.837a7.56 7.56 0 01-.017.88c-.037.413-.1.818-.226 1.212a5.017 5.017 0 01-.915 1.649l-.13.156.018.023c.043-.023.088-.041.127-.068.2-.138.373-.307.531-.49.4-.46.721-.973.975-1.529a3.59 3.59 0 00.325-1.72c-.024-.424-.097-.834-.3-1.213-.013-.027-.015-.06-.03-.121.05.035.082.048.101.072.107.13.22.258.315.398.33.494.46 1.052.486 1.64a3.75 3.75 0 01-.47 1.97c-.36.655-.887 1.14-1.526 1.506-.193.111-.394.21-.595.308-.157.078-.248.211-.318.365a.522.522 0 00-.033.406.359.359 0 01.013.139c-.005.077-.077.155-.14.162-.054.006-.125-.043-.15-.116a1.206 1.206 0 01-.06-.233c-.04-.314-.155-.6-.308-.87a3.906 3.906 0 00-.73-.91 2.129 2.129 0 00-.897-.524 4.093 4.093 0 00-.692-.131c-.075-.008-.15-.04-.22.01.18.06.363.11.538.18.434.173.82.43 1.18.728.308.255.58.543.794.884.098.155.186.315.227.496.027.123.042.25.067.375.013.062-.002.109-.053.144-.047.033-.122.034-.163-.01a.455.455 0 01-.08-.14c-.03-.073-.038-.159-.078-.225a7.314 7.314 0 00-1.423-1.664c-.16-.137-.329-.26-.537-.323-.376-.114-.753-.203-1.15-.154-.213.025-.427.032-.64.053a1.6 1.6 0 00-.736.278 5.14 5.14 0 00-.834.72c-.329.342-.642.699-.955 1.055-.136.155-.264.319-.314.531a5.227 5.227 0 00-.012.051.096.096 0 01-.09.076h-.31c-.046 0-.082-.048-.072-.094.023-.108.045-.216.07-.324.075-.325.19-.635.368-.917.024-.039.04-.088.104-.08l.01.049.027.077c.28-.435.571-.834.996-1.135.283-.204.584-.378.89-.55a.196.196 0 00-.098-.002c-.162.043-.325.084-.485.134-.402.124-.764.33-1.11.566-.147.1-.298.193-.414.333a7.314 7.314 0 00-1.07 1.767.845.845 0 00-.04.12.075.075 0 01-.072.056h-.494c-.04 0-.062-.051-.036-.082.123-.14.246-.282.377-.415.275-.281.58-.532.777-.884.027-.048.063-.09.095-.135.238-.333.54-.607.818-.902.082-.086.175-.16.26-.24.029-.027.053-.057.079-.085l-.018-.025-.135.041c-.034.017-.07.031-.102.05-.248.144-.494.292-.743.433-.408.23-.825.439-1.209.711-.281.2-.591.358-.889.533-.02.012-.044.015-.08.028-.015-.135.143-.201.108-.336-.033.014-.064.02-.085.038-.111.096-.227.19-.328.296-.148.157-.284.325-.425.488-.125.143-.25.286-.373.431A.153.153 0 019.89 24H8.762a.316.316 0 00.016-.042c.028-.09.085-.172.083-.28-.091-.018-.162.001-.212.077a4.45 4.45 0 00-.136.215c-.01.016-.024.03-.042.03h-.093c-.019 0-.029-.022-.017-.037.071-.088.14-.178.209-.268.001-.002-.006-.012-.012-.024-.014.004-.03.006-.045.013-.176.09-.352.181-.527.274a.363.363 0 01-.168.042H5.202c-.026 0-.039-.036-.019-.053.21-.178.402-.374.558-.605.335-.496.538-1.047.667-1.629.004-.02-.003-.043-.006-.091-.037.048-.059.072-.076.1a1.943 1.943 0 01-.334.415c-.28.258-.59.448-.983.464-.297.012-.588 0-.865-.127-.46-.21-.722-.57-.794-1.072-.025-.17-.017-.171-.182-.219A3.513 3.513 0 011.97 20.6a2.286 2.286 0 01-.808-1.13 3.569 3.569 0 01-.16-1.245c.002-.034.016-.067.024-.1.032.023.046.043.05.066.033.153.059.308.096.46.086.355.257.664.516.92.258.256.571.419.91.532.358.118.717.138 1.07-.016a1.89 1.89 0 00.621-.452c.328-.348.533-.76.648-1.223.009-.034.005-.071.007-.11-.015.006-.026.006-.03.011-.031.05-.064.1-.093.152-.284.502-.679.887-1.196 1.135-.351.17-.718.255-1.11.159a1.607 1.607 0 01-.971-.64 2.006 2.006 0 01-.368-.924 2.903 2.903 0 01.02-.886c.05-.439.466-1.17.742-1.271-.02.063-.035.112-.053.16-.043.116-.097.227-.13.345a1.901 1.901 0 00-.05.82c.033.212.09.416.204.6.147.236.346.407.62.465.11.023.225.014.338.018a.576.576 0 00.386-.131c.164-.128.282-.292.366-.481.168-.375.24-.777.309-1.179.05-.296.093-.594.133-.893.039-.281.071-.563.104-.845.026-.232.048-.464.074-.696.024-.228.052-.455.076-.683.024-.227.047-.455.069-.683.013-.14.022-.28.034-.42l.037-.417c.022-.25.041-.5.065-.748.008-.082-.02-.132-.09-.177a2.46 2.46 0 01-.492-.418c-.1-.109-.188-.228-.282-.342-.035-.042-.056-.097-.116-.118a2.084 2.084 0 00.275.597c.06.092.131.176.196.265.063.086.182.115.234.226-.028.003-.046.01-.06.006a4.74 4.74 0 01-.22-.057 2.71 2.71 0 01-1.287-.819c-.435-.487-.656-1.076-.71-1.723a5.206 5.206 0 01.014-1.06c.072-.602.22-1.186.45-1.745.155-.376.338-.741.526-1.102.205-.393.466-.75.765-1.076.512-.559 1.104-1.024 1.726-1.448.717-.49 1.478-.898 2.277-1.233C8.244.828 8.767.632 9.31.494c.655-.166 1.31-.33 1.982-.415.229-.03.458-.058.688-.07zm-1.847 22.82c-.07.06-.147.111-.207.18-.238.27-.464.549-.668.869l-.044.108a.177.177 0 00.093-.057c.174-.19.351-.378.519-.574.104-.122.195-.255.288-.386.024-.034.03-.08.046-.12l-.027-.02zm1.65-3.695a5.51 5.51 0 00-.653.593l-.37.386a.963.963 0 01-.377.25 1.372 1.372 0 01-.467.09c-.044 0-.087.006-.151.012.028.058.043.097.064.131.15.242.301.482.45.724.136.22.276.438.399.666.068.125.105.267.156.404.077.027.14-.018.202-.048.29-.135.579-.274.867-.412.213-.101.437-.186.636-.31.347-.215.68-.455 1.018-.685.015-.01.026-.028.042-.046-.023-.019-.038-.037-.056-.044-.287-.111-.527-.3-.77-.482a5.319 5.319 0 01-.506-.42 1.757 1.757 0 01-.41-.653c-.019-.049-.045-.095-.075-.156zm-5.847.264c-.06.096-.097.194-.132.293a3.38 3.38 0 01-.555 1.01c-.2.25-.455.412-.762.493-.23.06-.464.076-.7.07-.048-.002-.097.002-.158.005.016.04.021.066.035.085.1.145.23.246.4.295.157.046.316.034.498.023.181-.037.343-.115.485-.234.238-.199.402-.454.536-.732.175-.363.264-.751.342-1.144.01-.053.008-.11.011-.164zm14.945-4.586c.008.029.016.057.027.107.024.155.051.31.072.464.03.219.067.437.078.657.017.344.027.689-.014 1.033-.037.315-.063.633-.116.946a6.153 6.153 0 01-.46 1.518c-.008.018-.01.039-.02.082.047-.03.077-.042.098-.064.085-.083.17-.167.248-.255.271-.305.458-.66.596-1.043.18-.498.228-1.011.145-1.531-.103-.65-.33-1.263-.597-1.881a9.055 9.055 0 00-.024-.055l-.033.022zM5.797 8.29a.26.26 0 00.018.153c.124.251.25.501.379.75.025.049.066.09.03.163-.284.06-.578.119-.88.255.059.038.097.06.132.087.042.032.112.058.09.12-.01.033-.075.048-.117.072.017.01.043.021.067.036.166.102.33.207.447.368.138.192.229.404.188.644-.079.469-.306.85-.69 1.132-.054.04-.106.083-.161.122a.243.243 0 00-.103.245.77.77 0 00.055.195c.083.196.22.35.375.492.083.076.159.164.222.257a.37.37 0 01.025.377c-.023.05-.05.099-.076.148-.03.06-.028.111.022.162.041.042.08.089.112.138.038.058.078.079.147.05a.486.486 0 01.333-.006c.16.046.302.126.444.21.13.077.264.149.4.219.067.035.14.05.219.026.071-.022.124.01.145.076.02.064-.003.108-.074.139-.07.03-.137.063-.209.088-.1.035-.201.073-.314.077-.013-.107.11-.088.127-.159-.206-.126-.643-.145-.801-.034.063.112.035.21-.096.313-.13-.1-.025-.202.002-.3a.209.209 0 00-.249.17c-.015.101.067.216.178.224.108.007.218-.005.326-.012.06-.005.12-.027.199 0-.103.123-.248.127-.357.19.002.05.07.086.019.131-.053.048-.095-.001-.132-.03-.08-.063-.16-.126-.231-.197a.474.474 0 01-.157-.311.52.52 0 00-.043-.172c-.032-.074-.032-.137.033-.19-.018-.03-.028-.053-.045-.072a1.222 1.222 0 01-.196-.369c-.053-.137-.046-.264.048-.381.024-.03.05-.06.064-.095a.664.664 0 00.047-.168c.017-.165-.064-.287-.182-.387-.186-.156-.36-.322-.46-.551-.005-.011-.024-.017-.037-.026-.011.017-.024.027-.025.038-.019.185-.045.37-.052.557-.014.377.058.743.162 1.104.118.41.289.798.488 1.173.267.502.537 1.002.812 1.5.055.098.13.189.208.27.198.202.452.272.724.273.202 0 .404-.006.605-.026.295-.03.59-.073.884-.113.183-.025.365-.057.548-.08.21-.026.38.073.522.21.16.156.305.327.447.5.22.265.397.56.554.867.05.098.07.1.147.03.13-.121.26-.242.394-.36.067-.059.088-.12.067-.213a3.535 3.535 0 01-.085-.796c.002-.157.006-.314.018-.471.015-.224.03-.45.06-.672a59.114 59.114 0 01.362-2.298c.087-.493.182-.984.268-1.477.06-.347.118-.694.162-1.043.034-.273.055-.55.063-.825.011-.332.003-.665.002-.998 0-.077.004-.155-.01-.23-.028-.142-.01-.155-.162-.19a5.826 5.826 0 00-.607-.107c-.146-.018-.207-.053-.221-.19-.006-.049-.025-.098-.041-.146-.009-.025-.024-.048-.046-.09l-.025.264c-.009.096-.029.116-.127.115-.055 0-.11-.008-.164-.008-.476 0-.952-.008-1.426.032-.095.008-.173-.015-.226-.103-.04-.066-.088-.126-.134-.186-.063-.084-.086-.093-.182-.06-.195.068-.388.138-.582.21a2.71 2.71 0 00-.675.394.986.986 0 01-.323.168c-.033.01-.07.008-.127.013.02-.066.024-.114.047-.15.064-.105.135-.205.205-.306.023-.033.049-.063.073-.095l-.015-.023-.201.037c-.146.04-.296.07-.437.122-.148.053-.266.023-.386-.072a3.623 3.623 0 01-.733-.786l-.093-.132zm8.592 8.963l-.147.09c-.22.134-.44.266-.659.402-.093.058-.184.12-.27.188-.085.07-.124.161-.072.272.047.1.093.2.147.294.047.08.124.138.213.147.11.01.228.012.336-.012.217-.05.372-.205.528-.357a.291.291 0 00.087-.308c-.046-.18-.079-.365-.118-.547-.011-.052-.027-.103-.045-.169zm-.257-2.409c-.12.291-.205.597-.325.91-.151.433-.294.87-.435 1.323.036-.01.054-.01.067-.018.261-.16.522-.324.785-.484.054-.033.071-.078.065-.138-.012-.13-.024-.262-.034-.393l-.068-.886c-.008-.103-.02-.206-.029-.31-.009 0-.017-.002-.026-.004zm3.081-8.13l.099.285c.08.231.159.463.24.714l.58 1.952c.187.63.372 1.262.558 1.893.114.382.235.762.343 1.146.072.257.126.519.186.799.044.206.087.413.127.64.034.106.023.226.077.325l.025-.006-.068-.362c-.038-.206-.077-.412-.113-.638-.015-.07-.029-.141-.046-.211-.095-.396-.177-.796-.29-1.187-.196-.685-.413-1.364-.618-2.046-.165-.549-.322-1.1-.488-1.648-.069-.227-.15-.45-.226-.695l-.117-.336c-.037-.107-.075-.216-.115-.322-.04-.106-.084-.21-.127-.314a7.558 7.558 0 01-.027.01zM6.225 14.304c-.063-.001-.115.014-.134.083a.35.35 0 00.41.012 4.533 4.533 0 00-.276-.095zM5.23 11.98c-.026-.027-.057-.048-.075.002-.012.032-.007.07-.01.113.082-.037.082-.037.085-.115zm.062-1.189a.135.135 0 00-.088.056.197.197 0 00-.025.11c.005.152.01.306.026.457a.751.751 0 00.066.218c.061.136.157.167.288.101.055-.027.06-.054.025-.11a4.52 4.52 0 01-.129-.211c-.015-.068-.066-.131-.033-.207.04-.09-.076-.116-.074-.19V10.874c-.003-.038-.006-.087-.056-.083zm-.017-.968a.867.867 0 00-.467.127c-.076.045-.084.07-.05.158.034.087.07.173.115.254.064.117.09.125.21.077a.657.657 0 01.336-.053c.202.022.357.136.504.264l.092.077c.007-.006.014-.013.022-.018-.019-.105-.035-.226-.149-.264-.157-.053-.324-.075-.508-.117l-.24-.005c.24-.169.452-.044.687.009-.063-.115-.153-.147-.23-.193-.082-.05-.17-.092-.25-.144-.06-.037-.12-.08-.072-.172zm10.233.325c-.23-.01-.427.08-.608.211-.034.026-.06.065-.105.117.087.026.15.046.232.065.044-.015.088-.03.13-.046.306-.114.61-.115.904.031.126.063.237.04.366-.005-.02-.031-.03-.054-.045-.071a.986.986 0 00-.448-.273c-.14-.044-.284-.024-.426-.03zM7.99 6.483a.308.308 0 00.002.133c.08.321.156.643.242.962.104.387.27.75.456 1.103.02.037.061.08.098.087a.404.404 0 00.253-.051l-.472-.84c-.23-.448-.405-.92-.579-1.394zM10.397.497c-.2-.008-.405.004-.603.034-.236.035-.47.087-.7.152-.287.08-.569.18-.852.273-.04.013-.074.038-.11.058.028.014.05.018.07.014.287-.068.58-.085.873-.09.134-.002.269.009.402.025.19.024.382.048.57.09.456.104.874.3 1.265.556.464.306.888.66 1.257 1.078.205.232.395.475.56.739.17.274.315.561.449.856.273.601.456 1.232.6 1.876.04.173.07.348.1.524.017.104.065.167.17.19.122.028.2.105.22.251-.003.102-.06.174-.129.24a1.065 1.065 0 00-.268.358.164.164 0 00.083-.039c.08-.086.162-.172.235-.265a.56.56 0 00.13-.333c.009-.05.022-.1.024-.15.007-.124-.017-.15-.143-.168-.025-.004-.049-.014-.073-.015-.082-.007-.125-.063-.137-.131-.033-.198-.004-.355.247-.408.086-.018.174-.03.26-.042.158-.023.315-.053.473-.067.14-.012.19.033.226.167.008.029.018.057.021.087.019.179-.008.225-.141.288-.027.013-.055.024-.078.042a.148.148 0 00-.051.067c-.039.144.073.382.206.445l.673.32c.023.011.05.015.075.023l.018-.026c-.015-.008-.032-.013-.044-.024a2.27 2.27 0 00-.544-.32 4.898 4.898 0 00-.173-.075.203.203 0 01-.126-.191c-.003-.085.045-.154.128-.187l.059-.025c.099-.044.118-.076.112-.187a.384.384 0 00-.008-.063c-.067-.294-.123-.59-.205-.88a9.478 9.478 0 00-.826-2.036 7.465 7.465 0 00-1.39-1.805 4.536 4.536 0 00-1.177-.824 3.656 3.656 0 00-1.016-.328 6.155 6.155 0 00-.712-.074zm6.719 5.955c.01.014.018.028.038.034l-.022-.044-.016.01zM4.103 3.917a.062.062 0 01-.03.012.455.455 0 01-.04.039c-.01.01-.02.02-.045.04l-.363.354c-.088.085-.17.178-.266.253-.284.22-.425.53-.544.855a.132.132 0 00-.007.071c.013.055.033.108.052.168l.074.026c-.017.056-.03.105-.047.152-.058.164-.118.327-.175.491-.005.015.008.036.019.077.08-.175.158-.33.225-.489.228-.544.484-1.074.819-1.561.09-.133.182-.266.283-.401.004-.006.007-.013.022-.03.001-.016.003-.032.015-.04l.008-.017zm12.976 2.408a.023.023 0 01.009.019.073.073 0 00-.006.01.188.188 0 00.007.02l.018.022c.002-.007.007-.016.005-.021-.003-.01-.012-.018-.02-.038a1.331 1.331 0 01-.013-.012zM4.199 4.48c-.003.004-.008.008-.027.014-.005.013-.011.025-.031.047a2.085 2.085 0 01-.124.167c-.048.07-.116.055-.181.041-.134-.028-.228.016-.287.143-.089.187-.187.37-.273.56-.049.108-.11.216-.118.36.081.003.154.007.228.008h.228a2.563 2.563 0 01-.079.264c-.01.052-.022.103-.033.155l.02.004c.018-.046.037-.092.067-.153.066-.142.13-.285.2-.426.02-.04.034-.1.116-.092 0 .043.004.084 0 .124-.005.045-.017.09-.028.143.141.043.086.174.115.269.102-.022.104-.195.248-.144v.205l.017.002.439-1.059c-.13 0-.246-.02-.358.033-.024.011-.058-.001-.108-.004.075-.15.139-.278.211-.417a.128.128 0 01.025-.036c0-.015-.001-.03.008-.038l.006-.02c-.005.006-.01.011-.028.017-.004.012-.009.024-.026.045a.085.085 0 01-.032.033c-.123.157-.09.164-.258.106-.079-.027-.078-.028-.047-.144.028-.046.056-.093.098-.15 0-.016-.001-.032.007-.042L4.2 4.48zm2.073-.67c-.003.006-.007.011-.027.016-.094.125-.194.246-.28.377-.155.238-.301.481-.451.723-.14.224-.345.368-.575.481-.017.008-.04.006-.079.011.012-.059.016-.109.033-.153a6.076 6.076 0 01.229-.518l-.007-.02a.138.138 0 01-.035.025c-.028.05-.055.1-.093.164-.26.424-.443.817-.442.95.024.004.048.011.073.013.177.013.188.007.26-.165.03-.07.077-.12.147-.15l.175-.07c.044-.018.085-.057.146-.032.003.05-.01.11.014.145.042.062.044.125.047.193.002.049.017.098.026.147.029-.034.039-.065.05-.097.142-.39.277-.782.428-1.17.1-.256.22-.504.33-.756.013-.03.013-.067.03-.092V3.81zm3.987-.34c0 .045.01.084.021.123.042.16.094.318.124.48.024.133.023.27.028.406 0 .033-.019.067-.032.11-.094-.058-.047-.158-.106-.215h-.125c-.015.072-.01.152-.046.2-.066.085-.155.154-.236.227-.043.038-.078.018-.103-.025l-.046-.087c-.065.035-.117.069-.172.093-.116.051-.235.095-.35.147-.085.038-.09.053-.07.147.014.075.034.148.047.223.013.072.05.109.123.124.233.05.462.115.657.265.058-.102.058-.102.168-.151.03-.014.06-.03.092-.042.08-.03.115-.017.15.06.023.048.041.098.066.158.06-.14-.042-.267.017-.416.157.18.24.39.375.567a.235.235 0 00.022-.098c.002-.124 0-.247.002-.371 0-.034.013-.067.02-.1l.032-.003c.11.155.13.354.226.52a3.036 3.036 0 00-.01-.392c-.004-.045 0-.074.05-.088.08.036.116.14.215.158-.03-.275-.423-1.137-.798-1.635-.114-.127-.2-.28-.34-.386zm-2.667.696c-.019.034-.03.05-.037.067-.061.185-.125.37-.18.556-.031.105-.087.169-.195.19-.09.019-.178.052-.268.073-.038.009-.089.015-.118-.003-.024-.016-.025-.069-.036-.106-.064.076-.082.087-.17.047-.133-.062-.262-.135-.393-.201-.048-.025-.093-.063-.17-.03-.043.12-.091.25-.137.382-.099.28-.087.242.095.453.046.048.102.03.154.023.054-.009.106-.03.16-.036.13-.013.26-.08.367-.015.204-.064.387-.122.571-.178.05-.015.089.005.114.054.022.042.034.093.082.121.038-.056-.013-.128.063-.178l.14.241-.042-1.46zm.278.358c-.096-.01-.107.01-.11.108-.002.038-.003.078.002.115.03.2.099.386.174.57.002.006.012.01.022.015l.078-.05c.052.036.081.088.153.088.205-.002.41.014.616.012.099-.001.158.042.205.12.018.03.024.077.088.066l-.08-.394c-.05-.195-.085-.395-.172-.589-.057.057-.114.068-.18.046a.72.72 0 00-.135-.028c-.22-.028-.44-.059-.66-.08zm10.254-1.727c.089.163.155.316.139.491-.016.168.026.342-.044.516-.047-.033-.088-.082-.112-.075-.117.035-.164-.057-.227-.115a4.772 4.772 0 01-.286-.29l-.104-.113a4.856 4.856 0 01-.023.019c.035.046.07.093.11.156.04.064.084.127.122.193.034.058.065.118.031.205-.082-.01-.164-.019-.246-.032-.06-.01-.101 0-.124.07-.031.098-.037.096-.15.09.02.042.036.08.057.116.041.074.03.138-.03.196-.06.06-.118.122-.178.181a.175.175 0 01-.185.046c-.222-.061-.447-.113-.67-.174-.032-.009-.063-.04-.086-.068-.03-.04-.052-.087-.08-.13-.044-.07-.09-.138-.136-.207a.18.18 0 00-.014.105c.012.127.03.253.035.38.005.1-.024.12-.121.104-.104-.017-.206-.04-.31-.058-.064-.012-.131-.028-.202.03l.081.208c.09 0 .166-.01.237.002a.819.819 0 01.458.251c.078.083.154.168.241.26l.018-.005c-.004-.006-.008-.013-.01-.04.014-.056-.062-.118.018-.178.031.03.064.057.088.09.058.078.111.159.169.257l.089.141.024-.013a2093.819 2093.819 0 01-.427-.934c.055.007.083.007.108.016.193.07.385.142.577.216.074.028.147.06.219.094.062.028.112.018.157-.033.05-.056.102-.112.154-.167.05-.051.095-.046.132.014.016.025.026.053.04.08.071.138.143.277.217.433l.159.308.025-.011c-.044-.106-.07-.218-.138-.334-.057-.182-.168-.346-.206-.545.136.034.362.326.567.732l.057.074.018-.011a1.563 1.563 0 01-.052-.127c-.046-.145-.097-.29-.136-.436-.022-.083-.036-.173.022-.26l.109.058-.026-.207.027-.016c.022.02.05.036.065.06.073.108.143.22.215.33.01.016.029.029.043.043-.036-.217-.2-.38-.229-.626l.155.112c.014-.166.012-.319.042-.465.032-.158-.023-.297-.063-.445.024.004.036.006.055.025.092.124.183.249.277.371.02.027.05.047.069.087l.04.063.019-.015a.293.293 0 01-.053-.082 27.922 27.922 0 01-.332-.49c-.221-.311-.363-.467-.485-.521zm-6.57.327c-.003.161.092.275.069.415l-.368.087c.09.139.032.237-.052.331-.05.057-.092.122-.143.178-.037.04-.046.078-.018.126l.16.275c.029.048.072.066.128.064.076-.003.152 0 .228-.001.116-.003.216.022.275.137.006.014.02.024.044.052.004-.059-.003-.098.01-.13.016-.04.04-.099.072-.108.084-.023.173-.024.26-.03.013-.001.027.018.04.029l.071.065c.019-.11-.082-.198-.024-.31l.126.04c-.026-.123-.07-.245-.071-.366 0-.123.051-.243.115-.36.107.062.16.156.234.253.183.265.36.533.494.834.165-.078.27.068.407.088-.003-.106-.133-.441-.197-.492a.142.142 0 00-.102-.028c-.06.011-.119.039-.191.063-.025-.039-.056-.078-.077-.122a3.936 3.936 0 00-.473-.783c-.076-.094-.16-.182-.228-.26l-.391.285c-.049.035-.094.03-.132-.017l-.169-.207c-.025-.03-.053-.059-.097-.108z"/></svg>',
  terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M7 9.5l3 2.5-3 2.5"/><path d="M12.5 15h4.5"/></g></svg>',
  // Instinct's stick figure, kept with the relay's list of assistants (platforms.mjs).
  instinct: `<svg viewBox="${ASSISTANT.instinct.mark.viewBox}" aria-hidden="true">${ASSISTANT.instinct.mark.body}</svg>`,
  app: svg('<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 0 1-12 0Z"/><path d="M12 18v4"/>'),
  web: svg('<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="M2.5 9h19"/><circle cx="6" cy="6.5" r=".4"/><circle cx="8.5" cy="6.5" r=".4"/>'),
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
  const STK = '#people-board .pool .stk:not([data-held]), #people-board .pile .stk:not([data-held])';
  const live = document.createElement('div');
  live.className = 'sr'; live.setAttribute('aria-live', 'polite'); document.body.append(live);
  const say = (t) => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); };
  const data = () => JSON.parse($('#people-data').textContent);
  const wire = () => $$(STK).forEach((el) => el.setAttribute('aria-describedby', 'stk-help'));
  wire();
  if (!reduce.matches && !document.documentElement.classList.contains('stay')) $$(STK).forEach((el, i) => { el.style.animationDelay = `${i * 45}ms`; el.classList.add('settle'); el.addEventListener('animationend', () => { el.classList.remove('settle'); el.style.animationDelay = ''; }, { once: true }); });

  // Posts a form and puts the page the server answers with in place of this one.
  async function post(action, fields, from = {}, settle = null) {
    let res, html;
    try { res = await fetch(action, { method: 'POST', body: new URLSearchParams(fields) }); html = await res.text(); } catch { location.reload(); return false; }
    if (settle) await settle;
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
    const sw = f.querySelector('[aria-checked]');
    sw.setAttribute('aria-checked', String(sw.getAttribute('aria-checked') !== 'true'));
    if (!(await post(f.action, fields, {}, new Promise((k) => setTimeout(k, reduce.matches ? 0 : 480))))) return;
    $(`#people-board .bmenu__mode input[name="circle"][value="${fields.circle}"]`)?.closest('.basket')?.querySelector('.bmenu summary')?.focus();
    const g = data().baskets.find((x) => String(x.id) === fields.circle);
    if (g) say(g.mode === 'asks' ? `${g.name}: your bot asks you first.` : `${g.name}: your bot handles it and asks you when it isn't sure.`);
  });
}
const PEOPLE_JS = `(${peopleScript.toString()})();`;
// Czech pages get the same script with its sentences swapped. Each English piece must still be in the script
// (a changed one throws here), and its Czech is a tr() key like any other: {name} and {basket} become the
// script's own values.
const peopleJsFor = (tr) => {
  const vars = { name: '${name}', basket: '${g.name}', who: '${esc(el.dataset.name)}' };
  const tpl = (s) => `\`${s}\``;
  return [
    ['`${name} is not sorted yet, so your bot asks you first.`', tpl(tr('{name} is not sorted yet, so your bot asks you first.', vars))],
    ['`${name} is in ${g.name}. Your bot asks you first.`', tpl(tr('{name} is in {basket}. Your bot asks you first.', vars))],
    ['`${name} is in ${g.name}.`', tpl(tr('{name} is in {basket}.', vars))],
    ['<span class="mv__mode">asks you first</span>', `<span class="mv__mode">${tr('asks you first')}</span>`],
    ['Move ${esc(el.dataset.name)} to</div>', `${tr('Move {who} to', vars)}</div>`],
    ["item('', 'not sorted yet', true)", `item('', ${jsq(tr('not sorted yet'))}, true)`],
    ["Open ${esc(el.dataset.name)}'s page</a>", `${tr("Open {who}'s page", vars)}</a>`],
    ['`${g.name}: your bot asks you first.`', tpl(tr('{basket}: your bot asks you first.', vars))],
    ["`${g.name}: your bot handles it and asks you when it isn't sure.`", tpl(tr("{basket}: your bot handles it and asks you when it isn't sure.", vars))],
  ].reduce((js, [from, to]) => { if (!js.includes(from)) throw new Error(`people script changed: ${from}`); return js.split(from).join(to); }, PEOPLE_JS);
};
const peopleJsMade = new Map();
const peopleJs = (tr) => (tr.lang === 'en' ? PEOPLE_JS : peopleJsMade.get(tr.lang) ?? peopleJsMade.set(tr.lang, peopleJsFor(tr)).get(tr.lang));
// Sticker profile pictures: die-cut PNGs listed in public/stickers/index.json, as "key" strings or {key, name}
// objects (or {stickers: [...]}). Read again whenever the list or the folder changes, so a new set shows up
// without a restart. Without a list, or with an empty one, the twelve drawn robots are the choice.
const STICKER_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Kinds listed under Computers in the picker; the rest (soft shapes, animals, symbols) come after.
const MACHINE_KINDS = new Set(['computer', 'premium', 'robot']);
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
        const machine = typeof it === 'object' && MACHINE_KINDS.has(it?.kind);
        if (typeof key === 'string' && STICKER_KEY.test(key) && existsSync(join(dir, `${key}.png`))) set.set(key, { key, name: name.slice(0, 60) || 'Sticker', machine });
      }
    } catch { /* no list yet: robots only */ }
    return set;
  };
  read.dir = dir;
  return read;
}
const ART = new Set(['home', 'invite', 'setup', 'asleep', 'doorbell'].filter((n) => existsSync(new URL(`./public/art/${n}.jpg`, import.meta.url))));
// Live pages refresh every 30 s, but never while you're typing, have a menu open or are answering a confirm.
// The overview's friends: basket sections remember being folded (in this browser), and the filter hides everyone
// whose name doesn't match. Without JavaScript the sections are open and the filter isn't shown.
const FRIENDS_JS = `(()=>{const list=document.getElementById('friends');if(!list)return;const K='b2b-folded';const get=()=>{try{return JSON.parse(localStorage.getItem(K)||'[]')}catch(e){return []}};
const box=document.querySelector('[data-find]'),inp=box&&box.querySelector('input'),none=list.querySelector('.ffind__none[hidden]'),secs=[...list.querySelectorAll('.bsec')];
secs.forEach(s=>{const d=s.querySelector('details');if(get().includes(s.dataset.key))d.open=false;d.addEventListener('toggle',()=>{if(inp&&inp.value)return;const c=get().filter(k=>k!==s.dataset.key);if(!d.open)c.push(s.dataset.key);try{localStorage.setItem(K,JSON.stringify(c))}catch(e){}});});
if(!inp)return;box.hidden=false;
const run=()=>{const v=inp.value.trim().toLowerCase();let any=false;list.querySelectorAll('li[data-who]').forEach(r=>{const hit=!v||r.dataset.who.includes(v);r.hidden=!hit;if(hit)any=true;});
secs.forEach(s=>{const d=s.querySelector('details');s.hidden=!!v&&!s.querySelector('li[data-who]:not([hidden])');if(v)d.open=true;else d.open=!get().includes(s.dataset.key);});if(none)none.hidden=any;};
inp.addEventListener('input',run);inp.addEventListener('keydown',e=>{if(e.key==='Escape'&&inp.value){inp.value='';run();}});})();`;
// The overview's Arc tabs, in plain JS: the pill glides to the picked tab, the section slides in the way you moved,
// arrow keys, Home and End move between tabs. All shows every section. Runs right after the tabs, so the first paint is already right.
const OVTABS_JS = `(function(){const w=document.querySelector('.ovtabs');if(!w)return;const list=w.querySelector('[role=tablist]'),sel=w.querySelector('.ovtabs__sel'),panel=w.querySelector('[role=tabpanel]'),tabs=[...list.querySelectorAll('[role=tab]')];
const row=matchMedia('(max-width:1183px)'),still=matchMedia('(prefers-reduced-motion: reduce)');let cur=null;
const place=()=>{const t=tabs.find(b=>b.dataset.pane===cur);if(!t)return;sel.style.width=t.offsetWidth+'px';sel.style.height=t.offsetHeight+'px';sel.style.transform='translate('+t.offsetLeft+'px,'+t.offsetTop+'px)';};
const show=(k,o={})=>{const i=tabs.findIndex(b=>b.dataset.pane===k);if(i<0)return;const was=tabs.findIndex(b=>b.dataset.pane===cur);cur=k;
tabs.forEach((b,j)=>{b.setAttribute('aria-selected',String(j===i));b.tabIndex=j===i?0:-1;});panel.setAttribute('aria-labelledby',tabs[i].id);
panel.querySelectorAll('[data-pane-body]').forEach(p=>{p.hidden=k!=='all'&&p.dataset.paneBody!==k;});place();
if(o.user){w.classList.add('moved');try{localStorage.setItem('b2b-pane',k);}catch(e){}if(was>=0&&was!==i&&panel.animate){const d=(i>was?1:-1)*8,a=row.matches?'translateX('+d+'px)':'translateY('+d+'px)';panel.animate(still.matches?[{opacity:0},{opacity:1}]:[{opacity:0,transform:a},{opacity:1,transform:'none'}],{duration:240,easing:'cubic-bezier(.22,1,.36,1)'});}
if(row.matches)tabs[i].scrollIntoView({block:'nearest',inline:'nearest',behavior:still.matches?'auto':'smooth'});}};
list.addEventListener('click',e=>{const b=e.target.closest('[role=tab]');if(b)show(b.dataset.pane,{user:true});});
list.addEventListener('keydown',e=>{const i=tabs.indexOf(document.activeElement);if(i<0)return;const n=tabs.length,go={ArrowDown:i+1,ArrowRight:i+1,ArrowUp:i-1,ArrowLeft:i-1,Home:0,End:n-1}[e.key];if(go===undefined)return;e.preventDefault();const t=tabs[(go+n)%n];t.focus();show(t.dataset.pane,{user:true});});
let k='friends';try{k=localStorage.getItem('b2b-pane')||k;}catch(e){}show(tabs.some(b=>b.dataset.pane===k)?k:'friends');
const at=location.hash&&document.getElementById(decodeURIComponent(location.hash.slice(1)))?.closest('[data-pane-body]');if(at?.hidden)show(at.dataset.paneBody);w.classList.add('ready');
const orient=()=>list.setAttribute('aria-orientation',row.matches?'horizontal':'vertical');orient();addEventListener('resize',place);row.addEventListener?.('change',()=>{orient();place();});document.fonts?.ready.then(place);})();`;
const REFRESH_JS = `setInterval(()=>{if(document.visibilityState!=='visible'||document.querySelector('details[open]:not(.bsec__d),.cm[data-state=ask],.acc[data-open=true]')||document.querySelector('[data-find] input')?.value||/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||''))return;window.b2bStay&&b2bStay();location.reload();},30000);`;
// The behaviour of the Arc components above, in plain JS. Every page loads it once.
const uiJsFor = (tr) => `(function(){const $$=(s,r=document)=>[...r.querySelectorAll(s)];document.documentElement.classList.add('js');
/* Staying in place: a save answers with the same page, so it comes back where you were, without the entrance animation. */
const here=location.pathname+location.search;let was=null;try{was=JSON.parse(sessionStorage.getItem('stay'));sessionStorage.removeItem('stay');}catch(e){}
if(was&&Date.now()-was.t<20000&&(was.p===here||was.a===here)){document.documentElement.classList.add('stay');if(!location.hash)scrollTo(0,was.y);}
const stay=(a)=>{try{sessionStorage.setItem('stay',JSON.stringify({p:here,a,y:scrollY,t:Date.now()}));}catch(e){}};window.b2bStay=stay;
/* Everything below wires up a piece of page; it runs on load and again on content a save brings in place. */
const init=r=>{const top=r===document;
/* Rename in the title: the pen opens a box with the name selected; Cancel or Escape puts the name back and closes it. */
$$('.ptitle__edit',r).forEach(d=>{const i=d.querySelector('input'),pen=d.querySelector('summary'),shut=()=>{i.value=i.defaultValue;d.open=false;pen.focus();};
d.addEventListener('toggle',()=>{if(d.open){i.focus();i.select();}});d.querySelector('[data-close]').addEventListener('click',e=>{e.preventDefault();shut();});
d.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();shut();}});});
/* Button loading (Arc): on submit the label gives way to a spinner, focus stays, and a second press is swallowed. */
$$('form',r).forEach(f=>{const b=f.querySelector('.btn[data-busy]');if(!b)return;f.addEventListener('submit',e=>{if(b.getAttribute('aria-busy')==='true'){e.preventDefault();return;}b.setAttribute('aria-busy','true');b.setAttribute('aria-disabled','true');});});
if(top)addEventListener('pageshow',()=>$$('.btn[data-busy][aria-busy]').forEach(b=>{b.removeAttribute('aria-busy');b.removeAttribute('aria-disabled');}));
/* Arc avatar: a photo still downloading fades in from a soft blur; one that fails leaves the initial showing. */
$$('.avatar img',r).forEach(im=>{if(im.complete){if(!im.naturalWidth)im.remove();return;}im.dataset.loading='';im.addEventListener('load',()=>delete im.dataset.loading);im.addEventListener('error',()=>im.remove());});
/* Picture picker: a robot springs into the preview and blinks; a photo is cropped to its middle square, shrunk to 256px and sent as a JPEG. */
$$('form[data-pick]',r).forEach(f=>{const face=f.querySelector('[data-face]'),file=f.querySelector('[data-own-file]'),own=f.querySelector('[data-own]'),out=f.querySelector('input[name=photo]'),err=f.querySelector('[data-photo-error]');
const show=(html,cut)=>{face.innerHTML=html;face.toggleAttribute('data-cut',!!cut);face.classList.remove('go');void face.offsetWidth;face.classList.add('go');};
f.addEventListener('change',e=>{const r=e.target;if(r.name!=='avatar')return;out.value='';if(err)err.hidden=true;const p=r.closest('label').querySelector('.pfp__img');show(p.innerHTML,p.classList.contains('pfp__img--cut'));});
own.hidden=false;own.addEventListener('click',()=>file.click());
file.addEventListener('change',()=>{const x=file.files[0];if(!x)return;const u=URL.createObjectURL(x),im=new Image();
im.onload=()=>{const w=im.naturalWidth,h=im.naturalHeight,s=Math.min(w,h),c=document.createElement('canvas');c.width=c.height=256;const g=c.getContext('2d');g.fillStyle='#fff';g.fillRect(0,0,256,256);g.imageSmoothingQuality='high';g.drawImage(im,(w-s)/2,(h-s)/2,s,s,0,0,256,256);URL.revokeObjectURL(u);file.value='';
out.value=c.toDataURL('image/jpeg',.86);$$('input[name=avatar]',f).forEach(r=>r.checked=false);if(err)err.hidden=true;show('<img alt="" src="'+out.value+'">');};
im.onerror=()=>{URL.revokeObjectURL(u);file.value='';if(err)err.hidden=false;};im.src=u;});});
/* Menus: close on a press outside or Escape; a menu's inline confirm resets when it closes. */
const reset=d=>{const m=d.querySelector('.menu[data-confirming]');if(m){delete m.dataset.confirming;m.querySelector('.menu__confirm').hidden=true;}};
if(top)document.addEventListener('click',e=>{$$('details.more[open]').forEach(d=>{if(!d.contains(e.target)){d.open=false;reset(d);}});});
if(top)document.addEventListener('keydown',e=>{if(e.key==='Escape')$$('details.more[open]').forEach(d=>{d.open=false;reset(d);d.querySelector('summary').focus();});});
/* A menu opening near the screen's edge (a basket on the left of a phone) moves back inside it. */
const fit=d=>{const m=d.querySelector(':scope>.menu');if(!m||m.classList.contains('menu--up'))return;m.style.right='';const r0=d.getBoundingClientRect().right,left=r0-m.offsetWidth,pad=8,w=document.documentElement.clientWidth;if(left<pad)m.style.right=(left-pad)+'px';else if(r0>w-pad)m.style.right=(r0-w+pad)+'px';};
$$('details.more',r).forEach(d=>d.addEventListener('toggle',()=>{if(d.open)fit(d);else reset(d);}));
$$('[data-reveal]',r).forEach(b=>b.addEventListener('click',e=>{e.preventDefault();const m=b.closest('.menu'),c=m.querySelector('.menu__confirm');m.dataset.confirming='';c.hidden=false;c.querySelector('button:not([type=button])').focus();}));
$$('[data-unreveal]',r).forEach(b=>b.addEventListener('click',()=>reset(b.closest('details'))));
/* Notices: dismissed by hand; pages that swap their content in place bring new ones along. */
/* Copy button: icon and label swap to Copied, the width never changes. */
$$('[data-copy]',r).forEach(b=>b.addEventListener('click',async()=>{const t=document.querySelector(b.dataset.copy).innerText,l=b.querySelector('.copybtn__label');try{await navigator.clipboard.writeText(t);b.dataset.state='copied';l.textContent=${jsq(tr('Copied'))};}catch(e){l.textContent=${jsq(tr('Select it'))};}clearTimeout(b.t);b.t=setTimeout(()=>{delete b.dataset.state;l.textContent=${jsq(tr('Copy'))};},1800);}));
/* Confirm morph: the pill springs between its faces; Escape, Cancel, a press outside or 6 s of silence put it back. */
$$('.cm',r).forEach(f=>{const s=f.querySelector('.cm__surface'),face={},trig=f.querySelector('.cm__trigger'),yes=f.querySelector('.cm__confirm');$$('.cm__face',f).forEach(x=>face[x.dataset.face]=x);let at=0,timer;
const show=k=>{const from=s.getBoundingClientRect().width;for(const n in face)face[n].hidden=n!==k;f.dataset.state=k;s.style.width='';const to=s.getBoundingClientRect().width;s.style.width=from+'px';s.offsetWidth;s.style.width=to+'px';};
const rest=()=>{clearTimeout(timer);show('idle');};
trig.addEventListener('click',()=>{show('ask');at=Date.now();yes.focus();clearTimeout(timer);timer=setTimeout(()=>{if(f.dataset.state==='ask'&&!f.matches(':hover'))rest();},6000);});
f.querySelector('.cm__secondary').addEventListener('click',()=>{rest();trig.focus();});
f.addEventListener('submit',e=>{if(f.dataset.state!=='ask'||Date.now()-at<280){e.preventDefault();return;}show('pending');});
f.addEventListener('keydown',e=>{if(e.key==='Escape'&&f.dataset.state==='ask'){e.stopPropagation();rest();trig.focus();}});
document.addEventListener('pointerdown',e=>{if(f.dataset.state==='ask'&&!f.contains(e.target))rest();});});
/* Accordion rows: the panel opens to its own height; closed panels are inert, so focus never lands inside. */
$$('.acc__head',r).forEach(h=>h.addEventListener('click',()=>{const a=h.closest('.acc'),o=a.dataset.open!=='true',pn=a.querySelector('.acc__panel');a.dataset.open=String(o);h.setAttribute('aria-expanded',String(o));if(o)pn.removeAttribute('inert');else pn.setAttribute('inert','');}));
if(top){const hashed=location.hash?document.getElementById(location.hash.slice(1)):null;if(hashed?.classList.contains('acc__panel'))hashed.closest('.acc').querySelector('.acc__head').click();}
/* Tabs: the highlight glides from the section you left to the one you opened. */
if(top)$$('.tabs').forEach(n=>{const sel=n.querySelector('.tabs__sel'),cur=n.querySelector('[aria-current]');if(!cur){sel.style.opacity='0';return;}
const at=el=>({x:el.offsetLeft,w:el.offsetWidth}),put=p=>{sel.style.width=p.w+'px';sel.style.transform='translateX('+p.x+'px)';};
let from=null;try{from=JSON.parse(sessionStorage.getItem('tab-from'));sessionStorage.removeItem('tab-from');}catch(e){}
put(from||at(cur));sel.offsetWidth;n.classList.add('ready');if(n.scrollWidth>n.clientWidth)n.scrollLeft=cur.offsetLeft-(n.clientWidth-cur.offsetWidth)/2;if(from)requestAnimationFrame(()=>put(at(cur)));
$$('a',n).forEach(a=>a.addEventListener('click',()=>{try{sessionStorage.setItem('tab-from',JSON.stringify(at(cur)));}catch(e){}put(at(a));}));addEventListener('resize',()=>put(at(cur)));});
/* Switch that saves as soon as it changes. */
$$('[data-autosave]',r).forEach(i=>i.addEventListener('change',()=>i.form.requestSubmit()));
/* Sortable table: one column at a time, aria-sort says which and which way. */
$$('th[data-sort]',r).forEach(th=>th.querySelector('button').addEventListener('click',()=>{const t=th.closest('table'),k=th.dataset.sort,num=th.dataset.type==='num',cur=th.getAttribute('aria-sort');const dir=cur?(cur==='ascending'?'descending':'ascending'):(num?'descending':'ascending');
$$('th[data-sort]',t).forEach(x=>x.removeAttribute('aria-sort'));th.setAttribute('aria-sort',dir);const tb=t.tBodies[0];[...tb.rows].sort((a,b)=>{const x=a.dataset[k],y=b.dataset[k],c=num?Number(x)-Number(y):x.localeCompare(y);return dir==='ascending'?c:-c;}).forEach(r=>tb.appendChild(r));}));
/* Segmented control: the selection glides under the chosen label and filters the rows it controls. */
$$('.seg',r).forEach(g=>{const sel=g.querySelector('.seg__sel'),bs=$$('button',g),scope=document.querySelector(g.dataset.for);const on=()=>bs.find(b=>b.getAttribute('aria-pressed')==='true')||bs[0];
const put=b=>{sel.style.width=b.offsetWidth+'px';sel.style.transform='translateX('+(b.offsetLeft-3)+'px)';};
bs.forEach(b=>b.addEventListener('click',()=>{bs.forEach(x=>x.setAttribute('aria-pressed',String(x===b)));put(b);if(g.closest('[data-theme-pick]')&&window.b2bTheme)b2bTheme(b.value);const v=b.dataset.filter;if(scope)$$('[data-dir]',scope).forEach(r=>r.hidden=v!=='all'&&r.dataset.dir!==v);}));
put(on());requestAnimationFrame(()=>g.classList.add('ready'));addEventListener('resize',()=>put(on()));});

/* One-time code: six slots fill one hidden field; typing moves on, Backspace moves back, a paste fills them all. */
$$('.otp',r).forEach(g=>{const hid=g.querySelector('input[type=hidden]'),sl=$$('.otp__slot',g);
const sync=()=>{hid.value=sl.map(x=>x.value).join('');sl.forEach(x=>x.dataset.filled=String(!!x.value));if(hid.value.length===6&&!g.dataset.sent){g.dataset.sent='1';g.closest('form').requestSubmit();}};
const fill=(i,v)=>{v.split('').slice(0,6-i).forEach((d,j)=>{sl[i+j].value=d;});sl[Math.min(5,i+v.length)].focus();sync();};
sl.forEach((x,i)=>{x.addEventListener('input',()=>{const v=x.value.replace(/[^0-9]/g,'');if(v.length>1)return fill(i,v);x.value=v;if(v&&i<5)sl[i+1].focus();sync();});
x.addEventListener('keydown',e=>{if(e.key==='Backspace'&&!x.value&&i>0){sl[i-1].value='';sl[i-1].focus();sync();e.preventDefault();}else if(e.key==='ArrowLeft'&&i>0)sl[i-1].focus();else if(e.key==='ArrowRight'&&i<5)sl[i+1].focus();});
x.addEventListener('paste',e=>{const v=(e.clipboardData.getData('text')||'').replace(/[^0-9]/g,'');if(v){e.preventDefault();fill(i,v);}});});});
};init(document);
/* Switches save in the background: the switch finishes its move, then the page underneath is brought up to date
   in place (open rows stay open, typed text stays, focus stays). Language changes everything, so it reloads in place. */
const H=document.documentElement,still=matchMedia('(prefers-reduced-motion: reduce)'),wait=ms=>new Promise(k=>setTimeout(k,ms));let line=Promise.resolve();
const path=u=>{const x=new URL(u,location.href);return x.pathname+x.search;};
const formOf=x=>x.form?x.form.getAttribute('action'):'';
window.b2bTheme=t=>{const go=()=>{if(t)H.dataset.theme=t;else delete H.dataset.theme;};if(document.startViewTransition&&!still.matches)document.startViewTransition(go);else go();};
const hard=(f,s)=>{f.dataset.hard='';f.requestSubmit(s&&s.form===f?s:null);};
async function save(f,s){const body=new URLSearchParams(new FormData(f));if(s&&s.name)body.append(s.name,s.value);
const settle=wait(still.matches?0:560),act=f.getAttribute('action'),el=s||(f.contains(document.activeElement)?document.activeElement:null),key=el&&el.name?{n:el.name,v:el.value}:null;
if(f.hasAttribute('data-reload')){let ok=false;try{const r=await fetch(f.action,{method:'POST',body,redirect:'manual'});ok=r.type==='opaqueredirect'||r.ok;}catch(e){}if(!ok)return hard(f,s);await settle;stay();location.reload();return;}
let r,html;try{r=await fetch(f.action,{method:'POST',body});html=await r.text();}catch(e){return hard(f,s);}
const doc=new DOMParser().parseFromString(html,'text/html'),col=doc.querySelector('.col'),cur=document.querySelector('.col'),to=path(r.url);
if(!col||!cur||(to!==here&&to!==path(f.action))){location.assign(r.url);return;}
await settle;
const open=$$('.acc[data-open=true] .acc__panel',cur).map(p=>p.id);
const typed=$$('input,textarea,select',cur).filter(x=>x.form!==f&&x.name&&!/^(hidden|checkbox|radio|submit|button|file)$/.test(x.type)&&(x.tagName==='SELECT'?[...x.options].some(o=>o.selected!==o.defaultSelected):x.value!==x.defaultValue)).map(x=>({a:formOf(x),n:x.name,v:x.value}));
cur.replaceChildren(...col.childNodes);
typed.forEach(t=>{const y=$$('[name="'+CSS.escape(t.n)+'"]',cur).find(y=>formOf(y)===t.a);if(y)y.value=t.v;});
open.forEach(id=>{const p=document.getElementById(id);if(!p)return;const a=p.closest('.acc');a.dataset.open='true';a.querySelector('.acc__head').setAttribute('aria-expanded','true');p.removeAttribute('inert');});
$$('body > .toast').forEach(t=>t.remove());const said=doc.querySelector('.toast');if(said)document.body.append(said);
['lang','data-theme'].forEach(k=>{const v=doc.documentElement.getAttribute(k);if(v===null)H.removeAttribute(k);else H.setAttribute(k,v);});
$$('meta[name=theme-color]',document.head).forEach(m=>m.remove());$$('meta[name=theme-color]',doc.head).forEach(m=>document.head.append(m));document.title=doc.title;
init(cur);
if(key){const y=$$('form[action="'+CSS.escape(act)+'"] [name="'+CSS.escape(key.n)+'"]',cur).find(y=>(y.type!=='radio'&&y.tagName!=='BUTTON')||y.value===key.v);if(y)y.focus({preventScroll:true});}}
document.addEventListener('submit',e=>{const f=e.target;if(e.defaultPrevented||f.target==='_blank')return;
if('hard' in f.dataset){delete f.dataset.hard;stay(path(f.action));return;}
if(f.method==='post'&&f.querySelector('[data-autosave],.seg button:not([type=button])')&&window.DOMParser){e.preventDefault();const s=e.submitter;line=line.then(()=>save(f,s)).catch(()=>location.reload());return;}
stay(path(f.action));});
})();`;

const uiJsMade = new Map();
const uiJs = (tr) => uiJsMade.get(tr.lang) ?? uiJsMade.set(tr.lang, uiJsFor(tr)).get(tr.lang);

// With the landing site on this server, the dashboard uses its faces (Mona for text, Hubot for page titles).
const FONTS = `@font-face{font-family:"Hubot";src:url(/fonts/hubot-display.woff2) format("woff2");font-weight:400 640;font-display:swap}
@font-face{font-family:"Mona";src:url(/fonts/mona-text.woff2) format("woff2");font-weight:400 600;font-display:swap}`;

const DARK = `color-scheme:dark;
--background:#0e131b;--surface:#171d28;--surface-raised:#1c2330;--surface-muted:#1f2734;--foreground:#e8ecf3;--text-secondary:#a4aec0;--text-muted:#8691a5;
--border:#2a3342;--border-subtle:#222a37;--border-strong:#3b4557;--accent:#7f97ff;--accent-strong:#a5b5ff;--accent-subtle:rgb(127 151 255 / .14);--accent-foreground:#0e131b;
--success:oklch(74% .15 150);--warning:oklch(80% .14 75);--danger:oklch(70% .18 25);
--shadow-resting:0 1px 2px rgb(0 0 0 / .4);--shadow-floating:0 18px 40px -18px rgb(0 0 0 / .7),0 2px 6px rgb(0 0 0 / .35);
--control-track:#3b4557;--control-track-hover:#4a5569;--control-thumb:#f3f5f8;
--hairline:rgb(255 255 255 / .07);--hairline-strong:rgb(255 255 255 / .1);--scrim:rgb(0 0 0 / .6);--ring:var(--surface);--sticker-edge:#eef1f6;--chart-1:#7f97ff;--chart-2:#f28a5c;
--control-on:var(--accent);--art-filter:invert(1) hue-rotate(180deg);--art-blend:lighten`;

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
--control-track:#c3cad5;--control-track-hover:#b3bbc8;--control-thumb:#fff;--control-thumb-shadow:0 1px 2px rgb(26 34 48 / .18),0 0 0 .5px rgb(26 34 48 / .06);
--hairline:rgb(26 34 48 / .06);--hairline-strong:rgb(26 34 48 / .08);--scrim:rgb(26 34 48 / .36);--ring:#fff;--sticker-edge:#fff;--chart-1:#2747c9;--chart-2:#eb6834;--art-filter:none;--art-blend:normal}
/* Dark: the same ink-blue, turned down. It follows the device unless the person picked Light or Dark in Account. */
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK}}}:root[data-theme=dark]{${DARK}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scrollbar-gutter:stable}
a,button,summary,label,select,[role=tab],[role=button]{touch-action:manipulation}
button,summary,[role=tab],.btn,.seg{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
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
.col{width:100%;max-width:720px;margin:0 auto;display:grid;gap:28px;align-content:start;animation:page-in 240ms var(--ease-standard) both}.col>*{min-width:0}
.col--narrow{max-width:480px}.col--wide{max-width:none}
/* The overview: Arc tabs down the left (All, Friends, Groups, Your bots, Chat apps), the picked section on the right.
   Below 1024px the tabs become a row above the section that scrolls sideways. */
/* Every signed-in page is the same centred column, so nothing moves between pages. The overview's tabs sit in the
   left margin beside it when there's room, and above it as a row that scrolls sideways when there isn't. */
.ovtabs{display:grid;gap:20px;align-items:start}
.ovtabs__list{position:relative;isolation:isolate;display:grid;gap:2px;align-content:start}
.ovtabs__tab{position:relative;z-index:1;display:flex;align-items:center;gap:10px;min-height:40px;padding:0 12px;border:0;border-radius:var(--radius-control);background:transparent;color:var(--text-secondary);font:inherit;font-weight:500;text-align:left;white-space:nowrap;cursor:pointer;transition:color var(--duration-fast) var(--ease-standard)}
.ovtabs__tab svg{width:18px;height:18px;flex:none}
.ovtabs__label{flex:1}
.ovtabs__tab .count{margin-left:auto}
.ovtabs__tab[aria-selected="true"]{color:var(--foreground)}
.ovtabs__tab:active{color:var(--foreground);transform:scale(.97)}.ovtabs__tab{transition:color var(--duration-fast) var(--ease-standard),transform 120ms var(--ease-standard)}
@media (hover:hover) and (pointer:fine){.ovtabs__tab:hover{color:var(--foreground)}}
.ovtabs__sel{position:absolute;z-index:0;top:0;left:0;width:0;height:0;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--surface);box-shadow:var(--shadow-resting);opacity:0}
.ovtabs.ready .ovtabs__sel{opacity:1}
.ovtabs.moved .ovtabs__sel{transition:transform var(--duration-spring) var(--ease-spring),width var(--duration-spring) var(--ease-spring),height var(--duration-spring) var(--ease-spring)}
.ovtabs:not(.ready) .ovtabs__tab[aria-selected="true"]{background:var(--surface);box-shadow:var(--shadow-resting),0 0 0 1px var(--border)}
.ovtabs__panel,.ovtabs__panel>div{display:grid;gap:28px;align-content:start;min-width:0}
.ovtabs__panel>div[hidden]{display:none}
.ovtabs__panel:focus-visible{outline:none}
@media (min-width:1184px){.ovtabs{grid-template-columns:200px minmax(0,1fr);gap:32px;margin-left:-232px}.ovtabs__list{position:sticky;top:84px}}
@media (max-width:1183px){
 .ovtabs__list{grid-auto-flow:column;grid-auto-columns:max-content;overflow-x:auto;overscroll-behavior-x:contain;scrollbar-width:none;margin:0 -20px;padding:0 20px;scroll-padding-inline:20px}.ovtabs__list::-webkit-scrollbar{display:none}
 .ovtabs__tab{min-height:36px;padding:0 12px;gap:8px}.ovtabs__tab svg{width:16px;height:16px}.ovtabs__tab .count{margin-left:2px}}
@media (prefers-reduced-motion:reduce){.ovtabs.moved .ovtabs__sel{transition:none}.ovtabs__tab:active{transform:none}}
@keyframes page-in{from{opacity:0}}.stay .col{animation:none}.vt .col{animation:none}
@view-transition{navigation:auto}
.top{view-transition-name:top}
::view-transition-old(top){display:none}::view-transition-new(top),::view-transition-group(top){animation:none}
::view-transition-old(root),::view-transition-new(root){animation-duration:160ms;animation-timing-function:var(--ease-standard)}
@media (prefers-reduced-motion:reduce){@view-transition{navigation:none}}
body.in .legal{max-width:720px;margin:48px auto 0}
.pagehead{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:16px}
.pagehead__text{display:grid;gap:6px;min-width:0}.pagehead__sub{margin:0;color:var(--text-secondary)}
.pagehead__actions{display:flex;flex-wrap:wrap;gap:8px}.pagehead__actions form{margin:0}
.ptitle{display:flex;align-items:center;gap:6px;min-width:0}.ptitle h1{min-width:0;overflow-wrap:anywhere}.ptitle__pen{flex:none}
.ptitle:has(.ptitle__edit[open])>h1,.ptitle__edit[open]>.ptitle__pen{display:none}.ptitle:has(.ptitle__edit[open]){display:block}
.ptitle__form{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0}
.ptitle__box{position:relative;display:flex;flex:1 1 240px;max-width:360px}.ptitle__at{position:absolute;inset:0 auto 0 13px;display:grid;place-items:center;color:var(--text-muted);font:500 var(--text-lg)/1 var(--font-display);pointer-events:none}
.ptitle__box input{flex:1;height:44px;padding-left:30px;font:500 var(--text-lg)/1 var(--font-display);letter-spacing:var(--tracking-display)}.ptitle__box input[aria-invalid=true]{border-color:var(--danger)}
.ptitle__desc{flex-basis:100%;margin:0;color:var(--text-secondary);font-size:var(--text-xs)}
@media (prefers-reduced-motion:no-preference){.ptitle__edit[open] .ptitle__form{animation:ptitle-in var(--duration-fast) var(--ease-standard)}}@keyframes ptitle-in{from{opacity:0;transform:translateY(-2px)}}
.crumb{display:inline-flex;align-items:center;gap:4px;margin-left:-4px;color:var(--text-secondary);text-decoration:none;font-weight:500;font-size:var(--text-sm)}.crumb svg{width:16px;height:16px}@media (hover:hover) and (pointer:fine){.crumb:hover{color:var(--foreground)}}
.note{display:flex;align-items:center;gap:6px;margin:0;color:var(--text-muted);font-size:var(--text-xs)}.note svg{width:13px;height:13px}
.legal{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:40px;font-size:var(--text-xs)}.legal a{color:var(--text-muted);text-decoration:none}@media (hover:hover) and (pointer:fine){.legal a:hover{color:var(--foreground);text-decoration:underline}}
body.out{min-height:100vh;min-height:100dvh;display:flex;flex-direction:column}body.out .topbar{padding:20px clamp(16px,3vw,40px)}
body.out main{flex:1;display:grid;gap:16px;align-content:start;padding:24px 16px 48px}body.out .legal{justify-content:center;margin:0 auto 28px}
.sim{margin:0 0 16px;padding:8px 14px;border-radius:var(--radius-control);background:color-mix(in oklab,var(--warning) 16%,var(--surface));color:var(--foreground);font-weight:500;text-align:center}

/* ── Cards (Arc surface): a border, no shadow ── */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-surface);padding:24px;min-width:0}
.card>:last-child{margin-bottom:0}
/* A heading opening a card has room under it; a quiet line set apart closes it (who asked, who's signed in). */
.card:not(.stack)>h1:not(:last-child){margin-bottom:14px}.card:not(.stack)>h2:first-child:not(:last-child){margin-bottom:10px}
.card__aside{display:grid;gap:4px;margin-top:24px;padding-top:16px;border-top:1px solid var(--border-subtle);color:var(--text-secondary);font-size:var(--text-xs)}.card__aside p,.card__aside form{margin:0}.card.narrow{max-width:480px;width:100%;margin-inline:auto}
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
.acc__setting{margin:0 0 16px}.acc__actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.acc__actions form{margin:0}.acc__actions .acc__end{margin-left:auto}
@media (max-width:560px){.acc__body{padding-left:20px}.kv>div{grid-template-columns:1fr;gap:0}}

/* ── Avatar (Arc) ── */
.avatar{position:relative;display:inline-grid;flex:none;place-items:center;border:2px solid var(--ring);border-radius:var(--radius-pill);background:var(--surface-muted);box-shadow:0 1px 1px rgb(0 0 0 / .08),0 3px 8px rgb(0 0 0 / .1);color:var(--foreground);font-size:var(--text-xs);font-weight:500;line-height:1}
.avatar--sm{width:28px;height:28px;font-size:11px}.avatar--md{width:34px;height:34px;font-size:13px}.avatar--lg{width:48px;height:48px;font-size:var(--text-sm)}
.avatar img{position:absolute;inset:0;width:100%;height:100%;border-radius:inherit;object-fit:cover;pointer-events:none;transition:opacity var(--duration-standard) var(--ease-standard),filter var(--duration-standard) var(--ease-standard)}
.avatar img[data-loading]{opacity:0;filter:blur(4px);transition:none}.avatar--lg{border-width:3px}
/* A sticker from the set is already cut out with its own white edge: no disc, just its shadow. */
.avatar--cut{border:0;background:none;box-shadow:none;filter:drop-shadow(0 1px 1px rgb(0 0 0 / .1)) drop-shadow(0 3px 5px rgb(0 0 0 / .12))}.avatar--cut img{border-radius:0;object-fit:contain}
.me{display:flex;align-items:center;gap:14px;min-width:0}
/* Picture picker: the chosen robot lands in the preview on a spring and blinks once. */
.dlg{width:min(420px,calc(100vw - 32px));padding:0;border:0;border-radius:var(--radius-surface);background:var(--surface);color:var(--foreground);box-shadow:var(--shadow-floating),0 0 0 1px var(--hairline)}
.dlg[open]{animation:dlg-in 420ms var(--ease-spring) both}.dlg::backdrop{background:var(--scrim);animation:dlg-fade 200ms ease-out both}
.dlg__in{display:grid;gap:14px;padding:24px}
/* A big update: three robots passing a message along (the dot travels, unless motion is reduced), then the title and points. */
.talk{display:flex;align-items:center;justify-content:center;padding:26px 16px;border-radius:var(--radius-panel);background:var(--accent-subtle)}
.talk img{width:46px;height:46px;flex:none;border-radius:50%;box-shadow:0 0 0 3px var(--surface)}
.talk__wire{position:relative;width:clamp(36px,12vw,72px);height:2px;margin:0 6px;background:repeating-linear-gradient(90deg,color-mix(in oklab,var(--accent) 45%,transparent) 0 6px,transparent 6px 11px)}
.talk__wire i{position:absolute;top:50%;left:0;width:9px;height:9px;margin-top:-4.5px;border-radius:50%;background:var(--accent);animation:talk-hop 2.4s var(--ease-standard) infinite}
.talk__wire--late i{animation-delay:1.2s}
@keyframes talk-hop{0%{left:0;opacity:0}12%{opacity:1}50%{left:calc(100% - 9px);opacity:1}62%,100%{left:calc(100% - 9px);opacity:0}}
@media (prefers-reduced-motion:reduce){.talk__wire i{animation:none;left:calc(50% - 4.5px)}}
.dlg--big{width:min(480px,calc(100vw - 32px))}.dlg--big .talk{margin:-24px -24px 4px;border-radius:var(--radius-surface) var(--radius-surface) 0 0}
.bigup__title{font:500 var(--text-2xl)/1.08 var(--font-display);letter-spacing:var(--tracking-display);margin:0}
.bigup__lead{margin:0;color:var(--foreground)}
.bigup__points{list-style:none;margin:0;padding:0;display:grid;gap:8px;color:var(--text-secondary)}
.bigup__points li{position:relative;padding-left:26px}
.bigup__points li::before{content:"";position:absolute;left:0;top:.2em;width:16px;height:16px;border-radius:50%;background:var(--accent-subtle)}
.bigup__points li::after{content:"";position:absolute;left:5px;top:calc(.2em + 4px);width:6px;height:3.5px;border-left:1.75px solid var(--accent);border-bottom:1.75px solid var(--accent);transform:rotate(-45deg)}.dlg__title{margin:0;font:500 var(--text-xl)/1.15 var(--font-display);letter-spacing:var(--tracking-display)}
.dlg__one{margin:0;font-size:var(--text-base)}.dlg__list{margin:0;padding:0;list-style:none;display:grid;gap:9px}
.dlg__list li{position:relative;padding-left:18px}.dlg__list li::before{content:"";position:absolute;left:3px;top:.6em;width:6px;height:6px;border-radius:50%;background:var(--accent)}
.dlg__foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:6px}
@keyframes dlg-in{from{opacity:0;transform:translateY(8px) scale(.97)}}@keyframes dlg-fade{from{opacity:0}}
@media (prefers-reduced-motion:reduce){.dlg[open],.dlg::backdrop{animation:none}}
.rate{margin:0;padding:0;border:0;display:grid;gap:8px}.rate__legend{padding:0;font-weight:500}
.rate__opts{display:flex;flex-wrap:wrap;gap:6px;padding:3px;border-radius:999px;background:color-mix(in oklab,var(--foreground) 5%,transparent);width:max-content;max-width:100%}
.rate__opt{display:block;font-weight:500}.rate__opt input{position:absolute;opacity:0;pointer-events:none}
.rate__opt span{display:inline-flex;align-items:center;min-height:32px;padding:0 14px;border-radius:999px;color:var(--text-secondary);cursor:pointer;transition:background-color var(--duration-fast) var(--ease-standard),color var(--duration-fast) var(--ease-standard)}
.rate__opt input:checked+span{background:var(--surface);color:var(--foreground);box-shadow:var(--shadow-resting),0 0 0 .5px color-mix(in oklab,var(--foreground) 8%,transparent);animation:rate-pick 360ms var(--ease-spring)}
.rate__mark{flex:none;width:0;height:16px;margin-right:0;opacity:0;transform:scale(.3);transition:width 260ms var(--ease-spring),margin-right 260ms var(--ease-spring)}
.rate__mark--love{fill:#ff4d8d}.rate__mark--okay{fill:#ffc53d}.rate__mark--okay .rate__eye{fill:#5c3b00}.rate__mark--okay .rate__mouth{fill:none;stroke:#5c3b00;stroke-width:1.6;stroke-linecap:round}.rate__mark--meh{fill:#9aa7bb}
.rate__opt input:checked+span .rate__mark{width:16px;margin-right:6px;animation:rate-pop 520ms var(--ease-spring) 60ms both}
.rate__opt input:checked+span .rate__mark--love{animation:rate-pop 520ms var(--ease-spring) 60ms both,rate-beat 900ms ease-in-out 620ms 2}
.rate__opt input:checked+span .rate__mark--meh{animation:rate-pop 520ms var(--ease-spring) 60ms both,rate-sway 1400ms ease-in-out 600ms 1}
@keyframes rate-pick{40%{transform:scale(1.05)}}
@keyframes rate-pop{0%{opacity:0;transform:scale(.3) rotate(-12deg)}60%{opacity:1;transform:scale(1.25) rotate(4deg)}100%{opacity:1;transform:scale(1) rotate(0)}}
@keyframes rate-beat{0%,100%{transform:scale(1)}25%{transform:scale(1.2)}45%{transform:scale(.96)}65%{transform:scale(1.12)}}
@keyframes rate-sway{0%,100%{transform:translateX(0)}50%{transform:translateX(2px)}}
@media (prefers-reduced-motion:reduce){.rate__opt input:checked+span,.rate__opt input:checked+span .rate__mark{animation:none;opacity:1;transform:none}}
.rate__opt input:focus-visible+span{outline:2px solid color-mix(in oklab,var(--accent) 72%,transparent);outline-offset:2px}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.kpis--5{grid-template-columns:repeat(5,minmax(0,1fr))}@media(max-width:860px){.kpis--5{grid-template-columns:repeat(3,minmax(0,1fr))}}
.viz__cross[hidden]{display:none}.viz__plot[data-cross] .viz__tip,.viz__plot[data-bars] .viz__tip{top:2px}
.viz__line{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.viz__end{fill:var(--text-secondary);font-size:11px;font-weight:500;font-variant-numeric:tabular-nums}.viz__cross{stroke:var(--border-strong);stroke-width:1}
.atable{width:100%;border-collapse:collapse;font-size:var(--text-sm);font-variant-numeric:tabular-nums}.atable th,.atable td{padding:8px 10px 8px 0;text-align:left;border-top:1px solid var(--border-subtle)}.atable th{color:var(--text-secondary);font-weight:500;border-top:0}
.fbtext{white-space:normal!important}@media(max-width:640px){.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kpi{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-panel);padding:14px 16px}.kpi p{margin:0}
.kpi__label{color:var(--text-secondary);font-size:var(--text-xs);font-weight:500}.kpi__value{font:500 var(--text-2xl)/1.15 var(--font-display);letter-spacing:var(--tracking-display);font-variant-numeric:tabular-nums;margin:4px 0 2px!important}.kpi__note{color:var(--text-muted);font-size:var(--text-xs)}
.viz{margin:0;display:grid;gap:12px;--s1:var(--chart-1);--s2:var(--chart-2)}.viz__head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px}.viz__head h3{font-size:var(--text-sm);font-weight:500}
.viz__legend{display:flex;gap:14px;margin:0;padding:0;list-style:none;color:var(--text-secondary);font-size:var(--text-xs)}.viz__legend li{display:flex;align-items:center;gap:6px}.viz__sw{width:10px;height:10px;border-radius:3px}
.viz__sw.viz__s1{background:var(--s1)}.viz__sw.viz__s2{background:var(--s2)}path.viz__s1{fill:var(--s1)}path.viz__s2{fill:var(--s2)}
.viz__plot{position:relative}.viz__plot svg{display:block;width:100%;height:auto;overflow:visible}.viz__grid{stroke:var(--border-subtle);stroke-width:1}.viz__base{stroke:var(--border-strong);stroke-width:1}
.viz__tick{fill:var(--text-muted);font-size:11px;font-variant-numeric:tabular-nums}.viz__hit{fill:transparent}.viz__col.on .viz__hit{fill:color-mix(in oklab,var(--foreground) 4%,transparent)}
.viz__tip{position:absolute;top:-30px;padding:6px 10px;border-radius:10px;background:var(--foreground);color:var(--background);font-size:var(--text-xs);font-weight:500;white-space:nowrap;pointer-events:none;box-shadow:var(--shadow-floating)}
.viz__table summary{color:var(--text-secondary);font-size:var(--text-xs);cursor:pointer}.viz__table table{margin-top:8px;border-collapse:collapse;font-size:var(--text-xs);font-variant-numeric:tabular-nums}.viz__table th,.viz__table td{padding:4px 14px 4px 0;text-align:left}.viz__table th{color:var(--text-secondary);font-weight:500}
.hbars{margin:0;padding:0;list-style:none;display:grid;gap:10px}.hbars li{display:grid;grid-template-columns:minmax(80px,140px) 1fr 32px;align-items:center;gap:12px}
.hbars__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hbars__track{height:10px}.hbars__bar{display:block;height:100%;border-radius:0 4px 4px 0;background:var(--s1)}.hbars__n{text-align:right;color:var(--text-secondary);font-variant-numeric:tabular-nums}
.pfp{display:grid;gap:24px}.pfp__name{max-width:360px;width:100%;justify-self:center}.setrow>.grow{flex:1;min-width:0}.pfp__head{display:grid;justify-items:center;gap:8px;text-align:center}.pfp__head h1{margin:10px 0 0}
.pfp__face{display:block;width:112px;height:112px;border:6px solid var(--sticker-edge);border-radius:var(--radius-pill);overflow:hidden;background:var(--surface-muted);filter:drop-shadow(0 1px 1px rgb(0 0 0 / .08)) drop-shadow(0 8px 14px rgb(0 0 0 / .1))}
.pfp__face svg,.pfp__face img{display:block;width:100%;height:100%;object-fit:cover}
.pfp__face[data-cut]{width:132px;height:132px;border:0;border-radius:0;overflow:visible;background:none}.pfp__face[data-cut] img{object-fit:contain}
.pfp__set{display:grid;gap:12px;min-width:0;margin:0;padding:0;border:0}.pfp__legend{margin-bottom:12px;padding:0;color:var(--text-secondary);font-weight:500}
.pfp__face.go>*{animation:pfp-in 520ms cubic-bezier(.34,1.56,.64,1) both}.pfp__face.go .e{transform-box:fill-box;transform-origin:center;animation:pfp-blink 300ms 380ms ease-in-out}
@keyframes pfp-in{from{opacity:.4;transform:scale(.82);filter:blur(4px)}}@keyframes pfp-blink{50%{transform:scaleY(.12)}}
.pfp__grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin:0;padding:0;border:0;min-width:0}
.pfp__opt{position:relative;display:block;min-width:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.pfp__opt input{position:absolute;opacity:0;pointer-events:none}
.pfp__img{position:relative;display:block;width:100%;aspect-ratio:1;border:3px solid var(--sticker-edge);border-radius:var(--radius-pill);overflow:hidden;box-shadow:0 1px 1px rgb(0 0 0 / .08),0 4px 10px rgb(0 0 0 / .1);transition:box-shadow var(--duration-fast) var(--ease-standard),transform 220ms cubic-bezier(.34,1.56,.64,1)}
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
/* A bot's row: the mark of the assistant it runs on, its presence dot on the corner, and its doorbell as a bell. */
.botmark{--mark-bg:var(--surface-muted);position:relative;display:grid;place-items:center;width:40px;height:40px;flex:none;border-radius:12px;background:var(--mark-bg);color:var(--foreground)}
.botmark>svg{width:20px;height:20px}.botmark[data-origin="openclaw"]>svg{width:23px;height:23px}
.botmark>.pdot{position:absolute;right:-3px;bottom:-3px;box-shadow:0 0 0 2.5px var(--presence-surface,var(--surface))}
.bell{position:relative;display:grid;place-items:center;width:32px;height:32px;flex:none;border-radius:999px;color:var(--text-muted)}
.bell>svg{width:18px;height:18px}
.bell[data-state="on"]{color:var(--accent);background:var(--accent-subtle)}.bell[data-state="warn"]{color:var(--warning)}.bell[data-state="none"]{opacity:.75}
.bell__tip{position:absolute;right:calc(100% + 10px);top:50%;z-index:5;width:max-content;max-width:250px;padding:8px 11px;border-radius:10px;background:var(--foreground);color:var(--background);font-size:var(--text-xs);font-weight:500;line-height:1.4;text-align:left;white-space:normal;box-shadow:var(--shadow-floating);pointer-events:none;opacity:0;transform:translate(4px,-50%);transition:opacity var(--duration-fast) var(--ease-standard),transform var(--duration-fast) var(--ease-standard)}
@media (hover:hover) and (pointer:fine){.bell:hover>.bell__tip{opacity:1;transform:translate(0,-50%)}}
.line--link:focus-visible .bell__tip{opacity:1;transform:translate(0,-50%)}
@media (prefers-reduced-motion:reduce){.bell__tip{transition:none}}
.card--tips{overflow:visible}.card--tips>.list>li:first-child>.line{border-radius:var(--radius-surface) var(--radius-surface) 0 0}.card--tips>.list>li:last-child>.line{border-radius:0 0 var(--radius-surface) var(--radius-surface)}.card--tips>.list>li:only-child>.line{border-radius:var(--radius-surface)}

/* ── User menu (Arc): you, your plan, and the way out ── */
.umenu{flex:none}.umenu__trigger{display:flex;align-items:center;padding:3px;border-radius:999px;cursor:pointer;transition:background-color var(--duration-fast) var(--ease-standard)}
@media (hover:hover) and (pointer:fine){.umenu__trigger:hover{background:var(--surface-muted)}}
.umenu[open]>.umenu__trigger{background:var(--surface-muted)}
.umenu__panel{position:absolute;right:0;top:calc(100% + 8px);z-index:60;width:15.5rem;padding:4px;border:.5px solid var(--border);border-radius:10px;background:var(--surface-raised);box-shadow:var(--shadow-floating);line-height:1.3;transform-origin:top right;animation:menu-in var(--duration-fast) var(--ease-standard)}
.umenu__head{display:flex;align-items:center;gap:10px;padding:8px}.umenu__id{display:grid;gap:2px;min-width:0;flex:1}
.umenu__row{display:flex;align-items:center;gap:6px;min-width:0}.umenu__fullname{min-width:0;overflow:hidden;font-size:13px;font-weight:500;text-overflow:ellipsis;white-space:nowrap}
.umenu__plan.umenu__plan--infinite{position:relative;isolation:isolate;display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 10px 0 9px;border:0;border-radius:999px;color:#f5f7fb;font-weight:500;letter-spacing:.02em;background:linear-gradient(90deg,#ff5f6d,#ffb347,#ffe66d,#5be7a9,#4fc3f7,#7c83fd,#c77dff,#ff5f6d) 0 0/120px 100% repeat-x;box-shadow:0 1px 2px rgb(15 20 30/.25);animation:infinite-flow 9s linear infinite}
.umenu__plan.umenu__plan--infinite::before{content:"";position:absolute;inset:0;z-index:-1;border-radius:inherit;background:inherit;animation:inherit;filter:blur(7px);opacity:.5}
.umenu__plan.umenu__plan--infinite::after{content:"";position:absolute;inset:1px;z-index:-1;border-radius:inherit;background:radial-gradient(120% 140% at 50% 0%,#232b3b,#121722)}
.umenu__plan--infinite .inf{font-size:13px;line-height:1;margin-top:-1px;background:linear-gradient(90deg,#ff5f6d,#ffb347,#ffe66d,#5be7a9,#4fc3f7,#7c83fd,#c77dff,#ff5f6d) 0 0/120px 100% repeat-x;-webkit-background-clip:text;background-clip:text;color:transparent;animation:inherit}
@keyframes infinite-flow{to{background-position:120px 0}}
@media (prefers-reduced-motion:reduce){.umenu__plan.umenu__plan--infinite,.umenu__plan.umenu__plan--infinite::before,.umenu__plan--infinite .inf{animation:none}}
h2 .umenu__plan{display:inline-block;vertical-align:2px;margin-left:6px}
.umenu__plan{flex:none;height:17px;padding:0 5px;border:.5px solid color-mix(in oklab,var(--foreground) 9%,transparent);border-radius:4px;background:color-mix(in oklab,var(--foreground) 4%,transparent);color:var(--text-secondary);font-size:11px;font-weight:500;line-height:16px}
.umenu__email{overflow:hidden;font-size:12px;color:var(--text-muted);text-overflow:ellipsis;white-space:nowrap}
.umenu__sep{height:1px;margin:4px -4px;background:color-mix(in oklab,var(--foreground) 7%,transparent)}.umenu form{margin:0}
.umenu__item{display:flex;align-items:center;gap:10px;width:100%;height:32px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--foreground);font:inherit;font-size:13px;text-align:left;text-decoration:none;cursor:pointer}
.umenu__item svg{width:16px;height:16px;flex:none;color:var(--text-secondary)}.umenu__item:focus-visible{outline:none;background:color-mix(in oklab,var(--foreground) 6%,transparent)}@media (hover:hover) and (pointer:fine){.umenu__item:hover{background:color-mix(in oklab,var(--foreground) 6%,transparent)}.umenu__item:hover svg{color:var(--foreground)}}

/* ── Badge (Arc): a short status word with a faint tint ── */
.badge{display:inline-flex;align-items:center;min-height:24px;padding:0 9px;border:1px solid var(--badge-border,var(--border));border-radius:var(--radius-pill);background:var(--badge-bg,var(--surface-muted));color:var(--badge-fg,var(--text-secondary));font-size:var(--text-xs);font-weight:500;line-height:1;white-space:nowrap;vertical-align:middle}
.badge--success{--badge-fg:var(--success);--badge-bg:color-mix(in oklab,var(--success) 10%,var(--surface));--badge-border:color-mix(in oklab,var(--success) 25%,var(--border))}
.badge--warning{--badge-fg:var(--warning);--badge-bg:color-mix(in oklab,var(--warning) 11%,var(--surface));--badge-border:color-mix(in oklab,var(--warning) 27%,var(--border))}
.badge--info{--badge-fg:var(--accent-strong);--badge-bg:var(--accent-subtle);--badge-border:color-mix(in oklab,var(--accent) 24%,var(--border))}
.badge--danger{--badge-fg:var(--danger);--badge-bg:color-mix(in oklab,var(--danger) 10%,var(--surface));--badge-border:color-mix(in oklab,var(--danger) 26%,var(--border))}

/* ── Alert (Arc): what needs you, with the action that resolves it ── */
/* ── Notice: what just happened, how to take it back, what next. Settles in once; reduced motion just shows it ── */
.toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));z-index:60;display:flex;align-items:center;gap:10px;max-width:calc(100vw - 24px);padding:9px 16px 9px 14px;border-radius:999px;background:var(--foreground);color:var(--background);box-shadow:var(--shadow-floating,0 8px 24px rgb(0 0 0/.18));font-size:var(--text-sm);font-weight:500;transform:translateX(-50%);animation:toast-in 380ms var(--ease-spring) both,toast-out 220ms ease-in 4s forwards}
.toast--undo{padding-right:6px;animation-delay:0s,8s}.toast:focus-within{animation-play-state:paused}@media (hover:hover) and (pointer:fine){.toast:hover{animation-play-state:paused}}
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
.btn{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:var(--control-height-md);padding:0 20px;border:1px solid transparent;border-radius:18px;background:var(--foreground);border-color:var(--foreground);color:var(--background);font:inherit;font-size:var(--text-sm);font-weight:500;line-height:1.4;white-space:nowrap;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent;
transition:color var(--duration-fast) var(--ease-standard),background-color var(--duration-fast) var(--ease-standard),border-color var(--duration-fast) var(--ease-standard),opacity var(--duration-fast) var(--ease-standard),box-shadow var(--duration-fast) var(--ease-standard),transform 120ms cubic-bezier(.34,1.56,.64,1)}
.btn svg{width:16px;height:16px;flex:none}.btn:active:not(:disabled):not([aria-busy=true]){transform:scale(.97)}.btn:disabled{opacity:.52;cursor:not-allowed}
.btn.small{min-height:var(--control-height-sm);padding:0 14px}.btn.wide{width:100%}.btn.wide:active:not(:disabled){transform:scale(.985)}
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
.link{background:none;border:0;padding:0;color:var(--text-secondary);text-decoration:underline;text-underline-offset:.2em;text-decoration-color:var(--border-strong);cursor:pointer;font:inherit}@media (hover:hover) and (pointer:fine){.link:hover{color:var(--foreground)}}.link.danger{color:var(--danger)}
.link svg{width:14px;height:14px;vertical-align:-2px;margin-left:2px}

/* ── Dropdown menu (Arc): a raised panel that grows from its trigger ── */
.more{position:relative}.more>summary{list-style:none}.more>summary::-webkit-details-marker{display:none}
.more .menu{position:absolute;right:0;top:calc(100% + 6px);z-index:40;display:grid;min-width:180px;padding:5px;border:1px solid var(--border);border-radius:var(--radius-panel);background:var(--surface-raised);box-shadow:var(--shadow-floating);white-space:nowrap;text-align:left;transform-origin:top right;animation:menu-in var(--duration-fast) var(--ease-standard)}
.more .menu--up{top:auto;bottom:calc(100% + 6px);left:0;right:0;transform-origin:bottom center}
.more .menu form{margin:0}
.more .menu a,.more .menu button{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:0 11px;border:0;border-radius:calc(var(--radius-panel) - 6px);background:none;color:var(--foreground);font:inherit;font-size:var(--text-sm);text-decoration:none;cursor:pointer;text-align:left}
.more .menu svg{width:16px;height:16px;color:var(--text-secondary)}.more .menu .danger{color:var(--danger)}
@media (hover:hover) and (pointer:fine){.more .menu a:hover,.more .menu button:hover{background:var(--surface-muted)}.more .menu .danger:hover{background:color-mix(in oklab,var(--danger) 8%,var(--surface))}}
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
.walk{list-style:none;margin:20px 0 0;padding:0;display:grid;gap:24px}.walk__step{display:grid;grid-template-columns:28px minmax(0,1fr);column-gap:12px;align-items:start}.walk__n{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--accent);color:var(--accent-foreground);font-size:var(--text-xs);font-weight:500;font-variant-numeric:tabular-nums}.walk__body{display:grid;gap:12px;min-width:0}.walk__body>p{margin:4px 0 0;color:var(--foreground)}.walk__body>.btn{justify-self:start}.walk+.wait,.walk+p{margin-top:28px}.shot{justify-self:start;max-width:100%;margin:0;border:1px solid var(--border);border-radius:var(--radius-control);overflow:hidden;background:var(--surface-muted)}.shot img{display:block;max-width:100%;height:auto}@media (max-width:520px){.walk__step{grid-template-columns:minmax(0,1fr);row-gap:8px}}
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
/* Nightly updates: when it's on, the card turns to night (a starry sky, like the T3 Code title bar). It flips the
   moment the switch does, before the save comes back. Dark in both themes on purpose. */
.card--night{position:relative;overflow:hidden;isolation:isolate;transition:border-color 520ms var(--ease-standard),color 520ms var(--ease-standard)}
.card--night::before,.card--night::after{content:"";position:absolute;pointer-events:none;opacity:0;transition:opacity 520ms var(--ease-standard)}
.card--night::before{inset:0;z-index:-1;background:radial-gradient(circle 1.2px at 7% 14%,#fff 99%,transparent),radial-gradient(circle 1px at 24% 88%,rgb(255 255 255/.7) 99%,transparent),radial-gradient(circle 1.5px at 38% 12%,rgb(255 255 255/.85) 99%,transparent),radial-gradient(circle 1px at 52% 86%,rgb(255 255 255/.55) 99%,transparent),radial-gradient(circle 1.2px at 63% 16%,rgb(255 255 255/.75) 99%,transparent),radial-gradient(circle 1.5px at 79% 82%,rgb(255 255 255/.6) 99%,transparent),radial-gradient(circle 1px at 86% 26%,#fff 99%,transparent),radial-gradient(circle 1px at 96% 70%,rgb(255 255 255/.5) 99%,transparent),radial-gradient(60% 110% at 6% 115%,rgb(70 104 214/.5),transparent 70%),radial-gradient(45% 90% at 80% -10%,rgb(132 84 214/.38),transparent 70%),linear-gradient(100deg,#0d1533 0%,#151a45 50%,#2b1b5e 100%)}
.card--night::after{top:12px;right:27%;width:9px;height:9px;background:linear-gradient(rgb(255 255 255/.75),rgb(255 255 255/.75)) center/1px 100% no-repeat,linear-gradient(rgb(255 255 255/.75),rgb(255 255 255/.75)) center/100% 1px no-repeat}
.card--night:has(input:checked){border-color:rgb(255 255 255/.08);color:#eef0ff;--control-on:#e9ecff;--control-thumb:#0d1533;--control-track:rgb(255 255 255/.22)}
.card--night:has(input:checked)::before,.card--night:has(input:checked)::after{opacity:1}
.card--night:has(input:checked) .setrow__desc{color:#b8bfe6}
.card--night:has(input:checked) .switch input:focus-visible+.switch__track{outline-color:#e9ecff}
@media (prefers-reduced-motion:reduce){.card--night,.card--night::before,.card--night::after{transition:none}}
/* The files card: airmail. On, the card gets an airmail edge and files fly from one bot to the other, past the lock. */
.card--files,.filesart{--airmail-red:#e0473e;--airmail-blue:#2b57d6}
.card--files{border:4px solid transparent;padding:21px;background:var(--surface) border-box;outline:1px solid var(--border);outline-offset:-1px;transition:background 520ms var(--ease-standard),outline-color 520ms var(--ease-standard)}
.card--files:has(input:checked){outline-color:transparent;background:linear-gradient(var(--surface),var(--surface)) padding-box,repeating-linear-gradient(135deg,var(--airmail-red) 0 10px,var(--surface) 10px 15px,var(--airmail-blue) 15px 25px,var(--surface) 25px 30px) border-box}
.filesart{display:grid;place-items:center;height:112px;margin-bottom:4px;border-radius:var(--radius-panel);background:radial-gradient(70% 120% at 50% 110%,color-mix(in oklab,var(--airmail-blue) 14%,transparent),transparent 70%),color-mix(in oklab,var(--airmail-blue) 6%,var(--surface));overflow:hidden;transition:background 520ms var(--ease-standard)}
.filesart__stage{position:relative;width:300px;height:96px;flex:none}
.dlg--big .filesart{height:168px;margin:-24px -24px 4px;border-radius:var(--radius-surface) var(--radius-surface) 0 0;border-bottom:5px solid transparent;border-image:repeating-linear-gradient(135deg,var(--airmail-red) 0 10px,var(--surface) 10px 15px,var(--airmail-blue) 15px 25px,var(--surface) 25px 30px) 5}.dlg--big .filesart__stage{scale:1.3}
.filesart__route{position:absolute;inset:0;overflow:visible}
.filesart__route path{fill:none;stroke:color-mix(in oklab,var(--airmail-blue) 45%,var(--surface));stroke-width:2;stroke-linecap:round;stroke-dasharray:1 7;opacity:.55;transition:opacity 520ms var(--ease-standard)}
.filesart__bot{position:absolute;bottom:0;width:60px;height:60px;filter:drop-shadow(0 2px 3px rgb(20 30 60/.14)) saturate(.35);opacity:.8;transition:filter 520ms var(--ease-standard),opacity 520ms var(--ease-standard)}
.filesart__bot--from{left:12px}.filesart__bot--to{right:12px}
.filesart__lock{position:absolute;z-index:1;left:150px;top:13px;translate:-50% -50%;display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--airmail-blue);color:#fff;box-shadow:0 0 0 2px #fff,0 2px 5px rgb(20 30 60/.2);opacity:.5;transition:opacity 520ms var(--ease-standard)}
.filesart__chip{position:absolute;left:0;top:0;width:24px;height:30px;border-radius:4px;background:#fff;box-shadow:0 0 0 2px #fff,0 0 0 2.5px rgb(20 30 60/.08),0 3px 7px rgb(20 30 60/.18);offset-path:path("M 74 52 C 118 -2, 182 -2, 226 52");offset-rotate:0deg;offset-anchor:center;offset-distance:0%;overflow:hidden}
.filesart__chip::after{content:"";position:absolute;top:0;right:0;width:7px;height:7px;background:linear-gradient(225deg,var(--surface-muted) 50%,#dfe4ec 50%)}
.filesart__chip--photo{background:linear-gradient(transparent 52%,#fff 52%) ,radial-gradient(circle 3.5px at 70% 22%,#ffcf4a 95%,transparent),linear-gradient(160deg,#9fc3ff,#5f8ef0);}
.filesart__chip--photo::before{content:"";position:absolute;left:2px;right:2px;top:7px;height:9px;background:#3f8d5b;clip-path:polygon(0 100%,35% 20%,55% 70%,72% 40%,100% 100%)}
.filesart__chip--pdf b{position:absolute;left:3px;right:3px;bottom:5px;padding:1px 0;border-radius:2px;background:var(--airmail-red);color:#fff;font:600 7px/1 var(--font-sans,system-ui);letter-spacing:.04em;text-align:center}
.filesart__chip--pdf::before,.filesart__chip--note::before{content:"";position:absolute;left:4px;right:6px;top:7px;height:12px;background:repeating-linear-gradient(#c9d1de 0 1.5px,transparent 1.5px 4px)}
.filesart__chip--note{background:#fff8d6}.filesart__chip--note::before{height:17px;background:repeating-linear-gradient(#d9c98a 0 1.5px,transparent 1.5px 4px)}
/* Off: the files wait in a pile next to the sender. */
.filesart__chip--photo{offset-distance:1%;rotate:-8deg}.filesart__chip--pdf{offset-distance:4%;rotate:5deg}.filesart__chip--note{offset-distance:7%;rotate:-3deg}
:is(.card--files:has(input:checked),.filesart--live) .filesart__bot{filter:drop-shadow(0 2px 3px rgb(20 30 60/.14));opacity:1}
:is(.card--files:has(input:checked),.filesart--live) .filesart__route path{opacity:1;animation:filesart-route 1.2s linear infinite}
:is(.card--files:has(input:checked),.filesart--live) .filesart__lock{opacity:1;animation:filesart-lock 1.4s var(--ease-standard) 1.75s infinite}
:is(.card--files:has(input:checked),.filesart--live) .filesart__chip{animation:filesart-fly 4.2s cubic-bezier(.45,0,.3,1) infinite both}
:is(.card--files:has(input:checked),.filesart--live) .filesart__chip--pdf{animation-delay:1.4s}:is(.card--files:has(input:checked),.filesart--live) .filesart__chip--note{animation-delay:2.8s}
:is(.card--files:has(input:checked),.filesart--live) .filesart__bot--to{animation:filesart-hop 1.4s var(--ease-standard) 3.3s infinite}
:is(.card--files:has(input:checked),.filesart--live) .filesart__bot--from{animation:filesart-bob 2.8s ease-in-out infinite}
@keyframes filesart-fly{0%{offset-distance:0%;opacity:0;scale:.6;rotate:-10deg}10%{opacity:1;scale:1}50%{rotate:6deg}82%{offset-distance:100%;opacity:1;scale:.9;rotate:-4deg}90%,100%{offset-distance:100%;opacity:0;scale:.4;rotate:0deg}}
@keyframes filesart-lock{0%,100%{scale:1}18%{scale:1.28;box-shadow:0 0 0 2px #fff,0 0 0 7px color-mix(in oklab,var(--airmail-blue) 22%,transparent),0 2px 5px rgb(20 30 60/.2)}40%{scale:1}}
@keyframes filesart-hop{0%,100%{translate:0 0}14%{translate:0 -6px}30%{translate:0 0}}
@keyframes filesart-bob{0%,100%{rotate:0deg}50%{rotate:-4deg}}
@keyframes filesart-route{to{stroke-dashoffset:-16}}
@media (prefers-reduced-motion:reduce){
.card--files,.filesart,.filesart__bot,.filesart__route path,.filesart__lock{transition:none}
:is(.card--files:has(input:checked),.filesart--live) :is(.filesart__chip,.filesart__lock,.filesart__bot,.filesart__route path){animation:none}
:is(.card--files:has(input:checked),.filesart--live) .filesart__chip--photo{offset-distance:15%;rotate:-6deg}:is(.card--files:has(input:checked),.filesart--live) .filesart__chip--pdf{offset-distance:34%;rotate:3deg}:is(.card--files:has(input:checked),.filesart--live) .filesart__chip--note{offset-distance:78%;rotate:-3deg}}

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
.stack{display:grid;gap:16px;margin-top:20px}.card.stack{margin-top:0}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:20px}
.stack>p,.stack>.muted,.stack>.actions,.stack>h1,.stack>h2,.stack>.howto{margin:0}.stack>.link{justify-self:center;min-height:var(--control-height-sm);padding:0 8px}
.decide{display:flex;gap:10px;margin-top:8px}.decide>.btn{flex:1}.decide>.btn:first-child{order:2}
.card>p+.btn,.card>p+form>.btn:only-child{margin-top:8px}.center>h1:not(:first-child){margin-top:16px}
/* Whatever follows a form or a row of buttons gets room, so a button never sits on the next line of text. */
.card>form:not(:last-child):not(.setrow),.card>.actions:not(:last-child),.stack+p,.stack+form{margin-bottom:16px}.stack+p,.stack+form,.stack+.wait{margin-top:16px}
.card>.stack:first-child,[data-dir]>.stack:first-child{margin-top:0}.card>.alert{margin:12px 0}.card>.alert:first-child{margin-top:0}.card__head p{margin:2px 0 0}
p.setrow__label,p.setrow__desc{margin:0}p.setrow__desc{margin-top:2px}.card>p.setrow__desc:not(:last-child){margin-bottom:12px}
body.out main>*{margin-block:0}body.out main{gap:20px}.center>:last-child{margin-bottom:0}
label{display:grid;gap:6px;font-weight:500;font-size:var(--text-sm)}
.field__desc{color:var(--text-secondary);font-size:var(--text-xs);font-weight:400}.field__error{color:var(--danger);font-size:var(--text-xs);font-weight:500}
.field input[aria-invalid=true]{border-color:var(--danger)}
input,select,textarea{font:inherit;font-size:16px;color:var(--foreground);background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--radius-control);transition:border-color var(--duration-fast) var(--ease-standard),background-color var(--duration-fast) var(--ease-standard)}
input::placeholder,textarea::placeholder{color:var(--text-muted)}
select{appearance:none;padding-right:36px;cursor:pointer;background:var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236b7588' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 12px center/16px}
@media (hover:hover) and (pointer:fine){input:hover:not(:disabled):not(.otp__slot),textarea:hover:not(:disabled){border-color:var(--foreground)}select:hover{background-color:var(--surface-muted)}}
input,select{height:var(--control-height-md);padding:0 12px;min-width:0}textarea{padding:10px 12px;line-height:1.4;resize:vertical}
@media (min-width:641px) and (pointer:fine){input,select,textarea{font-size:var(--text-sm)}}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:none;border-color:var(--foreground)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.row3{display:grid;grid-template-columns:1fr 1fr 2fr;gap:12px}@media(max-width:560px){.row3{grid-template-columns:1fr 1fr}.row3 label:last-child{grid-column:1/-1}}
.pick{display:flex;gap:10px;align-items:end;flex-wrap:wrap;margin:6px 0 14px}.pick label{min-width:180px}
.error{color:var(--danger);font-weight:500}.okmsg{color:var(--success);font-weight:500;margin:0;display:flex;gap:6px;align-items:flex-start}.okmsg>svg{width:16px;height:16px;flex:none;margin-top:2px}.okmsg b{font-weight:500;color:var(--foreground)}.dev{background:color-mix(in oklab,var(--warning) 12%,var(--surface));padding:10px 14px;border-radius:var(--radius-control)}

/* ── Settings groups (Arc settings rows) ── */
.group{display:grid;gap:10px}.group>h2{margin:0;padding-left:4px}
.card--rows{padding:0 20px}
.setrow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0}.setrow+.setrow{border-top:1px solid var(--border-subtle)}
.setrow p{margin:0}.setrow--flush{padding:0}.setrow--flush+.setrow--flush{margin-top:16px;padding-top:16px}.quietform .row3{margin:18px 0 14px}.card__block{margin:16px 0}.stack>.btn.small{justify-self:start}.setrow__label{font-weight:500}.setrow__desc{color:var(--text-secondary);font-size:var(--text-sm)}
.fold>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;list-style:none}.fold>summary::-webkit-details-marker{display:none}
.fold>summary::after{content:"";width:8px;height:8px;margin-right:4px;border:1.75px solid var(--text-muted);border-top:0;border-left:0;transform:rotate(45deg);transition:transform var(--duration-standard) var(--ease-standard);flex:none}
.fold[open]>summary::after{transform:rotate(-135deg)}.fold[open]>summary{margin-bottom:14px}
.fold__title{display:block;font-weight:500}.fold__sub{display:block;font-size:var(--text-xs);color:var(--text-muted)}
.danger-zone .fold__title{color:var(--danger)}

/* ── Facts (a bot at a glance) ── */
.facts{margin:0}.fact{display:grid;grid-template-columns:160px minmax(0,1fr);gap:16px;padding:14px 0}.fact+.fact{border-top:1px solid var(--border-subtle)}
.fact dt{color:var(--text-secondary)}.fact dd{margin:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px}.fact dd b{font-weight:500}.fact dd span{color:var(--text-muted);font-size:var(--text-xs)}
@media (max-width:560px){.fact{grid-template-columns:1fr;gap:2px}}


.wait{display:flex;align-items:center;gap:10px;font-weight:500;color:var(--text-secondary)}.wait.center{justify-content:center}.diy+.wait{margin:16px 0}.diy+form,.diy+.wait+form{margin-top:16px}.lead--sm{font-size:17px}.wait.hidden{display:none}
.howto{padding-left:20px}.howto li{margin:6px 0}
/* Shown only on touch screens, where a computer-only step can't be finished. */
.phone-only{display:none;padding:10px 12px;border-radius:10px;background:var(--surface-muted);border:1px solid var(--border)}@media (hover:none) and (pointer:coarse){.phone-only{display:block}}
.video{display:flex;align-items:center;gap:12px;margin:20px 0;padding:8px;border:1px solid var(--border);border-radius:12px;color:var(--foreground);text-decoration:none;font-weight:500}@media (hover:hover) and (pointer:fine){.video:hover{background:var(--surface)}}.video img{width:120px;height:auto;border-radius:8px;flex:none}.video span{color:var(--accent)}
.way{display:grid;gap:8px}.way+.way{border-top:1px solid var(--border-subtle);margin-top:20px;padding-top:20px}.way h2{margin:0}.way__head{display:flex;align-items:center;justify-content:space-between;gap:12px}
.diy>summary{list-style:none;display:flex;align-items:center;justify-content:space-between;min-height:44px;font-weight:500;padding:6px 0;cursor:pointer}.diy+.diy{margin-top:6px;padding-top:6px;border-top:1px solid var(--border-subtle)}.diy>summary::-webkit-details-marker{display:none}
.diy__name{display:inline-flex;align-items:center;gap:10px;min-width:0}.diy__marks{display:inline-flex;gap:5px;flex:none;--mark-bg:var(--surface)}.diy__marks>svg{width:18px;height:18px}
.diy>summary::after{content:"+";font-size:20px;font-weight:400;color:var(--text-muted)}.diy[open]>summary::after{content:"\\2013"}
details summary{cursor:pointer}

/* ── Inbox ── */
.convos{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,460px),1fr));gap:16px;align-items:start}
.thread{list-style:none;margin:14px 0;padding:0;display:grid;gap:10px}
.bubble{max-width:82%;padding:10px 14px;border-radius:16px;background:var(--surface-muted)}.bubble.out{justify-self:end;background:var(--foreground);color:var(--background)}
.bubble .meta{font-size:var(--text-xs);color:var(--text-secondary);margin-bottom:3px}.bubble.out .meta{color:color-mix(in oklab,var(--background) 70%,var(--foreground))}
.bubble .text{white-space:pre-wrap;word-break:break-word}.bubble .ext{display:block;margin-top:6px;word-break:break-all}
.choices{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.chip{height:var(--control-height-sm);padding:0 14px;border-radius:var(--radius-pill);border:1px solid var(--border-strong);background:var(--surface);color:var(--foreground);font:inherit;font-weight:500;cursor:pointer}@media (hover:hover) and (pointer:fine){.chip:hover{background:var(--surface-muted)}}
.answered{margin-top:8px}.compose{display:grid;gap:10px;margin-top:8px;border-top:1px solid var(--border-subtle);padding-top:14px}.compose .btn{justify-self:start}
/* Group chats: rows on the overview (a little pile of faces, Join and No thanks), the group page, and friends by basket. */
.gline{display:flex;flex-wrap:wrap;align-items:center}.gline>.line{flex:1 1 240px;min-width:0}
.gline__act{display:flex;align-items:center;gap:8px;padding:8px 16px 8px 0}.gline__act form{margin:0}.gline>.more{margin-right:14px}
.gpile{display:flex;flex:none;align-items:center;min-width:34px}.gpile .avatar+.avatar{margin-left:-14px}
.gmark{display:grid;flex:none;place-items:center;width:34px;height:34px;border-radius:12px;background:var(--surface-muted);color:var(--text-secondary)}.gmark svg{width:18px;height:18px}
.gmark--lg{width:64px;height:64px;margin:0 auto 14px;border-radius:22px}.gmark--lg svg{width:28px;height:28px}
.ghead{display:grid;gap:10px}.ghead__meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0;color:var(--text-secondary);font-size:var(--text-sm)}.ghead__meta--center{justify-content:center;margin-top:10px}
.ptitle__box--plain input{padding-left:12px}
.gsys{justify-self:center;max-width:90%;color:var(--text-muted);font-size:var(--text-xs);text-align:center;text-wrap:balance}
.choices--show{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.choices--show .chip{display:inline-flex;align-items:center;cursor:default}
.bubble i{opacity:.8}
.gtell{margin:8px 0 0;padding-top:14px;border-top:1px solid var(--border-subtle);color:var(--text-secondary);font-size:var(--text-sm)}
.gpick{display:grid;min-width:0;margin:0;padding:0;border:0}.gpick legend{margin-bottom:4px}
.gpick__opt{display:flex;align-items:center;gap:12px;min-height:52px;padding:4px 2px;cursor:pointer}.gpick__opt+.gpick__opt{border-top:1px solid var(--border-subtle)}
.gpick__opt input{flex:none;width:18px;height:18px;margin:0;accent-color:var(--foreground)}
.setrow.gset{display:grid;justify-content:stretch}.seg--fit{display:flex;width:100%}.seg--fit .seg__track{flex:1}.seg--fit button{flex:1 1 auto;min-height:34px;padding:5px 10px;white-space:normal;line-height:1.2}
.ffind input{width:min(210px,44vw);height:34px;padding:0 12px}
.bsec{position:relative}.bsec+.bsec{border-top:1px solid var(--border-subtle)}
.bsec__head{display:flex;align-items:center;gap:8px;min-height:50px;padding:8px 60px 8px 18px;color:var(--text-secondary);font-weight:500;list-style:none;cursor:pointer}.bsec__head::-webkit-details-marker{display:none}
.bsec__head>svg{width:16px;height:16px;flex:none;color:var(--text-muted);transition:transform var(--duration-standard) var(--ease-standard)}.bsec__d:not([open])>.bsec__head>svg{transform:rotate(-90deg)}
.bsec__head .basket-word{color:var(--foreground)}.bsec__d>.list{border-top:1px solid var(--border-subtle)}
.bsec__menu{position:absolute;top:9px;right:12px}
.list>li[hidden],.bsec[hidden],.ffind[hidden]{display:none}
.ffind__none{margin:0;padding:18px 20px;color:var(--text-muted);font-size:var(--text-sm)}
.card--menus{overflow:visible}.card--menus>.list>li:first-child>.line--link{border-top-left-radius:19px}.card--menus>.list>li:last-child>.line--link{border-bottom-left-radius:19px}
.card--menus>.bsec:first-child>.bsec__d>.bsec__head{border-radius:19px 19px 0 0}.card--menus>.bsec:last-child>.bsec__d[open]>.list>li:last-child>.acc__head{border-radius:0 0 19px 19px}
@media (max-width:560px){.gline__act--row{width:100%;padding:0 20px 14px 68px}}
.extra summary{color:var(--text-secondary)}.extra[open]{display:grid;gap:10px}

/* ── Signed-out and focused pages ── */
.art{margin:0 auto;max-width:520px;width:100%}.art img{display:block;width:100%;height:auto;filter:var(--art-filter);mix-blend-mode:var(--art-blend);-webkit-mask-image:radial-gradient(ellipse 58% 54% at 50% 47%,#000 40%,transparent 100%);mask-image:radial-gradient(ellipse 58% 54% at 50% 47%,#000 40%,transparent 100%)}
.art.small{max-width:340px}
.hero{max-width:640px;margin:48px auto;text-align:center}.hero h1{font-size:40px;margin-bottom:12px}.lead{color:var(--text-secondary);font-size:var(--text-lg);margin:0 0 24px}
.center>.avatar{width:64px;height:64px;margin:0 auto 14px;font-size:26px;background:var(--foreground);color:var(--background);box-shadow:none}
.card h1,.center h1{margin-bottom:12px}.card.stack>h1{margin:0}
.price{font-size:32px;font-weight:500;letter-spacing:-.03em;margin:4px 0 8px}.ticks{padding-left:18px;margin:0 0 18px}.ticks li{margin:4px 0}.tiers{width:100%}
.row{display:flex;gap:10px;align-items:center;justify-content:space-between;flex-wrap:wrap;padding:12px 0;border-top:1px solid var(--border-subtle)}.row form{margin:0}
.quiet{text-align:center}

/* ── Phones: the tabs move under the brand and can scroll ── */
@media (max-width:640px){
.top__in{flex-wrap:wrap;gap:10px 12px;padding:10px 16px 10px}.brand{margin-right:auto}
.tabs{order:3;flex:1 0 100%;margin:0;overflow-x:auto;scrollbar-width:none}.tabs::-webkit-scrollbar{display:none}.tabs__item{flex:1;justify-content:center;padding:0 10px}
.page{padding:24px 16px 36px}
.ovtabs__list{margin:0 -16px;padding:0 16px;scroll-padding-inline:16px}
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
.tiernote{margin:-4px 0 12px;font-family:var(--font-hand);font-size:22px;line-height:1.2;color:var(--pen);rotate:-1.5deg;transform-origin:left}
/* The golf Plan card (users.tier_theme = 'golf'): a fairway with mowing stripes, morning light from the left and a
   hole with its flag on the right. Colours inside the card flip to light so the meter and text read on the grass. */
.card--golf{position:relative;overflow:hidden;isolation:isolate;border-color:rgb(255 255 255/.08);color:#f1f7ee;
  --foreground:#f1f7ee;--text-secondary:#cfe3cf;--text-muted:#b4d0b6;--surface:#1c5a35;--surface-muted:rgb(255 255 255/.12);--accent:#ffd34d;--pen:#ffe58a;
  background:radial-gradient(70% 90% at 0% 0%,rgb(255 244 200/.18),transparent 65%),repeating-linear-gradient(112deg,rgb(255 255 255/.045) 0 34px,transparent 34px 68px),linear-gradient(165deg,#1f6a3c 0%,#1a5a33 55%,#154a2a 100%)}
.card--golf h2,.card--golf p{position:relative}
.card--golf .meter__track{background:rgb(0 0 0/.22)}.card--golf .meter__top{padding-right:210px}
.golf__scene{position:absolute;top:0;right:0;z-index:-1;width:220px;height:132px;pointer-events:none}
.golf__flag{transform-box:fill-box;transform-origin:0 50%;animation:golf-wave 3.2s ease-in-out infinite}
@keyframes golf-wave{50%{transform:skewY(-4deg) scaleX(.94)}}
.umenu__plan.umenu__plan--golf{border-color:transparent;background:#1f6a3c;color:#f1f7ee}
.card--golf .umenu__plan--golf{background:rgb(255 255 255/.16)}
@media (max-width:560px){.golf__scene{width:160px;height:96px;opacity:.75}.card--golf .meter__top{padding-right:120px}}
@media (prefers-reduced-motion:reduce){.golf__flag{animation:none}}
.js-only{display:none}.js .js-only{display:inline}.js .no-js{display:none}
.tabs__count{display:inline-grid;place-items:center;min-width:18px;height:18px;margin-left:6px;padding:0 5px;border-radius:999px;background:var(--accent);color:var(--accent-foreground);font-size:11px;font-weight:500;line-height:1;font-variant-numeric:tabular-nums}
.sheet{position:relative;min-width:0;background:var(--surface);border-radius:28px;padding:28px;box-shadow:0 0 0 1px var(--hairline),0 1px 2px rgb(26 34 48 / .04)}
.lede{margin:6px 0 0;color:var(--text-secondary);max-width:46ch}

.stk{--s:92px;--tilt:0deg;--rx:0deg;--ry:0deg;--lift:0px;--scale:1;position:relative;display:block;width:var(--s);height:var(--s);flex:none;border-radius:50%;color:inherit;text-decoration:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}
a.stk{touch-action:none;cursor:grab}
.stk__img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;filter:var(--stick-shadow);transform:perspective(500px) translateY(var(--lift)) rotate(var(--tilt)) rotateX(var(--rx)) rotateY(var(--ry)) scale(var(--scale));transition:transform 420ms var(--ease-spring),filter 240ms var(--ease-standard),opacity 200ms var(--ease-standard)}
.stk__disc{display:grid;place-items:center;overflow:hidden;border:calc(var(--s) * .055) solid var(--sticker-edge);border-radius:50%;background:var(--surface-muted)}
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
.tag{display:inline-flex;white-space:nowrap;align-items:center;gap:5px;padding:2px 11px 3px 8px;border:0;border-radius:999px;background:var(--surface);color:var(--foreground);font:500 19px/1.2 var(--font-hand);letter-spacing:0;rotate:-2.5deg;box-shadow:0 0 0 1px var(--hairline-strong),0 2px 4px rgb(26 34 48 / .06)}
.tag svg{width:15px;height:15px;flex:none}.tag[data-mode="asks"]{color:var(--pen);rotate:2deg}.tag[data-mode="wait"]{color:var(--text-secondary);rotate:-1deg}.tag+.tag{margin-left:6px}
.stk--wait .stk__img{opacity:.5;filter:grayscale(1)}.stk--wait::after{content:"";position:absolute;inset:-3px;border:1.5px dashed var(--text-secondary);border-radius:50%;opacity:.7;pointer-events:none}
a.stk[data-held]{cursor:pointer;touch-action:auto}
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
.bmenu .iconbtn{width:30px;height:30px}.bmenu .menu{min-width:240px;max-width:calc(100vw - 16px)}
.bmenu__mode{margin:0}.bmenu__mode button{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%}.bmenu__sw{position:relative;flex:none;width:30px;height:18px;border-radius:999px;background:var(--border-strong);transition:background-color var(--duration-fast) var(--ease-standard)}.bmenu__sw::after{content:"";position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0 / .18);transition:transform var(--duration-spring) var(--ease-spring)}.bmenu__mode button[aria-checked="true"] .bmenu__sw{background:var(--pen)}.bmenu__mode button[aria-checked="true"] .bmenu__sw::after{transform:translateX(12px)}
.bmenu__rename{display:flex;gap:6px;padding:4px}.bmenu__rename input{flex:1;height:36px}.more .menu .bmenu__rename button{width:auto;flex:none;background:var(--surface-muted)}
.mv{position:absolute;z-index:90;min-width:210px;padding:6px;border-radius:var(--radius-panel);background:var(--surface);box-shadow:0 0 0 1px var(--hairline-strong),var(--shadow-floating);transform-origin:var(--ox,20px) 0;animation:menu-in 220ms var(--ease-standard)}
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
@media (hover:hover) and (pointer:fine){.tchip button:hover{background:var(--surface-muted);color:var(--foreground)}}
.tchip-add{margin:0}.tchip-add input{width:160px;height:34px;padding:0 13px;border:1.5px dashed var(--border-strong);border-radius:999px;background:none;font-size:var(--text-sm)}@media (pointer:coarse){.tchip-add input{font-size:16px}}
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
.ask{position:relative;min-width:0;padding:20px;border-radius:22px;background:var(--surface);box-shadow:0 0 0 1px var(--hairline-strong),0 18px 40px -22px rgb(26 34 48 / .28),0 2px 6px rgb(26 34 48 / .04)}
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
/* Signed out: the other language, at the top right. */
body.out .topbar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.langswitch{margin-right:-10px;padding:6px 10px;border-radius:999px;color:var(--text-secondary);font-size:var(--text-sm);font-weight:500;text-decoration:none;transition:color var(--duration-fast) var(--ease-standard)}
@media (hover:hover) and (pointer:fine){.langswitch:hover{color:var(--foreground);background:color-mix(in oklab,var(--foreground) 5%,transparent)}}
/* Czech on a phone: a little less room around each tab, so all six sections fit on a 390px screen. */
@media (max-width:640px){.tabs__item:lang(cs){padding:0 8px}}
`;
