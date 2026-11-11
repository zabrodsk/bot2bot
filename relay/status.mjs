// The public status page (/status, /status.json, /status/feed.xml): how each part of the relay is doing right now,
// its last 90 days, and the incidents the operator posts. Part of the open-source relay, so a self-hosted relay
// gets one too.
//
// Measuring uses signals the relay already has, never message content or anything about a person:
// - every minute the scheduler writes one heartbeat row (that the row gets written is the proof the process is alive
//   and the database takes writes);
// - HTTP answers: 5xx from pages, from the bot API (/v1) and from connected apps (/mcp);
// - doorbell rings: only failures that are ours (network errors, timeouts and 5xx across several bots). One owner's
//   paused or broken routine answers 4xx and is their business, not an outage;
// - emails: the mailer is wrapped, so a failed send is counted;
// - the outside check, when one is set up: its pings to /healthz stopping means nobody outside gets through.
// Minutes with no heartbeat at all (the relay was down or restarting) count as down for everything once it is back,
// except short gaps, which are a deploy's restart.

export const COMPONENTS = ['website', 'messages', 'wake', 'email', 'apps'];
// English names for the JSON and the feed; the page translates them (componentName).
const NAMES = { website: 'Website and dashboard', messages: 'Messages', wake: 'Waking bots', email: 'Login emails', apps: 'Connected apps' };
const STEPS = ['investigating', 'identified', 'monitoring', 'resolved'];
const IMPACTS = ['minor', 'major'];
const MIN = 60_000, DAY = 86_400_000;
const WINDOW_MS = 5 * MIN;        // the signals the current state is judged on
const GRACE_MIN = 2;              // a gap of this many missing minutes or fewer is a restart, not an outage
const PROBE_LATE_MS = 4 * MIN;    // the outside check pings every minute; this long without one, nobody gets through
const PROBE_RETIRED_MS = 6 * 60 * MIN;
const KEEP_MINUTES_MS = 2 * DAY;  // per-minute heartbeats; older ones live on as per-day counts
const KEEP_DAYS = 92;
const SHOWN_DAYS = 90, PAST_DAYS = 14;
// One letter per component in a heartbeat row, in COMPONENTS order.
const LETTER = { up: 'u', slow: 's', down: 'd' };
const FROM_LETTER = { u: 'up', s: 'slow', d: 'down' };
const RANK = { up: 0, slow: 1, down: 2 };
const worse = (a, b) => (RANK[b] > RANK[a] ? b : a);
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function migrateStatus(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS status_minutes (minute INTEGER PRIMARY KEY, states TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS status_days (
      day TEXT NOT NULL, component TEXT NOT NULL,
      up INTEGER NOT NULL DEFAULT 0, slow INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, component)
    );
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY, title TEXT NOT NULL, impact TEXT NOT NULL, components TEXT NOT NULL,
      status TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS incident_updates (
      id INTEGER PRIMARY KEY, incident INTEGER NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
      status TEXT NOT NULL, message TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS incident_updates_by ON incident_updates (incident, at);
  `);
}

export function createStatus({ q, tx, clock, HttpError, log = () => {}, product = 'bot2bot' }) {
  // ───── signals, in memory for the last few minutes ─────
  // Per minute: [requests, failed] for each part. Nothing about who made them.
  const buckets = new Map();
  const count = (part, bad) => {
    const m = Math.floor(clock() / MIN);
    let b = buckets.get(m);
    if (!b) {
      b = { website: [0, 0], messages: [0, 0], apps: [0, 0], email: [0, 0] };
      buckets.set(m, b);
      for (const k of buckets.keys()) if (k < m - 10) buckets.delete(k);
    }
    b[part][0] += 1;
    if (bad) b[part][1] += 1;
  };
  const sum = (part, t) => {
    const from = Math.floor((t - WINDOW_MS) / MIN);
    let n = 0, bad = 0;
    for (const [m, b] of buckets) if (m > from) { n += b[part][0]; bad += b[part][1]; }
    return { n, bad };
  };
  // Rings: which bot, and whether it failed in a way that's ours. Bot ids stay in memory and are never shown.
  const rings = [];
  let writeFailedAt = 0;

  // Called for every HTTP answer. /mcp and its sign-in are connected apps, /v1 is bots sending and fetching,
  // everything else is the website and the dashboard.
  function request(path, code) {
    const part = /^\/(mcp|oauth|\.well-known)(\/|$)/.test(path) ? 'apps' : /^\/v1\//.test(path) ? 'messages' : 'website';
    count(part, code >= 500);
  }
  const wrapMailer = (send) => async (m) => {
    try { const r = await send(m); count('email', false); return r; } catch (e) { count('email', true); throw e; }
  };
  // A doorbell ring went out. httpStatus 0 means it never got an answer (network error or timeout).
  // OpenClaw gateways, watchers and other assistants' own APIs aren't ours, so their failures say nothing about us.
  function rang(bot, httpStatus) {
    if (bot.doorbell_kind === 'hook' || bot.doorbell_kind === 'watch' || bot.doorbell_kind === 'webhook') return;
    const t = clock();
    rings.push({ t, bot: bot.id, bad: !httpStatus || httpStatus >= 500 });
    while (rings.length && (rings[0].t <= t - WINDOW_MS || rings.length > 5000)) rings.shift();
  }
  // The outside check: a pinger somewhere else (status-probe/worker.js) asks for /healthz once a minute, through the
  // public address. It counts once the answer is sent. When its pings stop arriving while we're running, people
  // can't reach us either (DNS, the host's edge) or we're stuck. Probing that stopped hours ago is a retired
  // pinger, not an outage.
  let probedAt = 0;
  const probed = (t = clock()) => { probedAt = t; };
  const unreachable = (t) => probedAt > t - PROBE_RETIRED_MS && probedAt <= t - PROBE_LATE_MS;

  // How each part looks from the signals alone. A few failures are noise; a part is slow when failures are a real
  // share of the traffic, and down when most of it fails.
  function measured(t = clock()) {
    const http = ({ n, bad }) => (bad >= 10 && bad * 2 >= n ? 'down' : bad >= 3 && bad * 10 >= n ? 'slow' : 'up');
    // Each bot's latest ring decides whether it is failing right now.
    const latest = new Map();
    for (const r of rings) if (r.t > t - WINDOW_MS) latest.set(r.bot, r.bad);
    const failing = [...latest.values()].filter(Boolean).length, fine = latest.size - failing;
    const mail = sum('email', t);
    const s = {
      website: http(sum('website', t)),
      messages: http(sum('messages', t)),
      wake: failing >= 5 && fine === 0 ? 'down' : failing >= 3 && failing >= fine ? 'slow' : 'up',
      email: mail.bad >= 3 && mail.bad === mail.n ? 'down' : mail.bad >= 2 && mail.bad * 2 >= mail.n ? 'slow' : 'up',
      apps: http(sum('apps', t)),
    };
    // The heartbeat couldn't be written: the database isn't taking writes, so nothing that saves anything works.
    if (writeFailedAt > t - WINDOW_MS) s.website = s.messages = 'down';
    // Nobody outside gets through: pages, bots and connected apps all come in that way.
    if (unreachable(t)) s.website = s.messages = s.apps = 'down';
    return s;
  }

  // ───── incidents ─────
  const parse = (i) => (i ? { ...i, components: JSON.parse(i.components) } : null);
  const updatesOf = (id) => q('SELECT status, message, at FROM incident_updates WHERE incident = ? ORDER BY at DESC, id DESC').all(id);
  const incident = (id) => { const i = parse(q('SELECT * FROM incidents WHERE id = ?').get(id)); return i && { ...i, updates: updatesOf(i.id) }; };
  const openIncidents = () => q('SELECT * FROM incidents WHERE resolved_at IS NULL ORDER BY created_at DESC').all().map(parse);
  // Now: what was measured, made worse by any incident still open (a major one means its parts are down).
  function current(t = clock()) {
    const s = measured(t);
    for (const i of openIncidents()) for (const c of i.components) if (c in s) s[c] = worse(s[c], i.impact === 'major' ? 'down' : 'slow');
    return s;
  }

  const text = (v, max, what) => {
    const s = String(v ?? '').trim();
    if (!s) throw new HttpError(400, `${what} is required`);
    if (s.length > max) throw new HttpError(400, `${what} is at most ${max} characters`);
    return s;
  };
  const step = (v) => { if (!STEPS.includes(v)) throw new HttpError(400, `status must be one of: ${STEPS.join(', ')}`); return v; };
  const impactOf = (v) => { if (!IMPACTS.includes(v)) throw new HttpError(400, `impact must be minor or major`); return v; };
  const componentsOf = (v) => {
    const list = Array.isArray(v) ? [...new Set(v.map(String))] : [];
    if (!list.length || list.some((c) => !COMPONENTS.includes(c))) throw new HttpError(400, `components must be a list of: ${COMPONENTS.join(', ')}`);
    return list;
  };
  // The operator's API, with the ADMIN_TOKEN. Each change is one more update on the incident's timeline.
  const routes = {
    'POST /admin/incidents': ({ body, admin }) => {
      if (!admin) throw new HttpError(401, 'admin token required');
      const title = text(body.title, 120, 'title'), message = text(body.message, 2000, 'message');
      const status = step(body.status ?? 'investigating'), impact = impactOf(body.impact ?? 'minor'), components = componentsOf(body.components);
      const t = clock();
      const id = tx(() => {
        const r = q('INSERT INTO incidents (title, impact, components, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(title, impact, JSON.stringify(components), status, t, status === 'resolved' ? t : null);
        q('INSERT INTO incident_updates (incident, status, message, at) VALUES (?, ?, ?, ?)').run(r.lastInsertRowid, status, message, t);
        return Number(r.lastInsertRowid);
      });
      log(null, 'incident_opened', { id, impact, components });
      return { ok: true, incident: publicIncident(incident(id)) };
    },
    // {status, message} adds an update; resolved closes it (another status opens it again). title, impact and
    // components can be corrected along the way. {delete: true} removes an incident posted by mistake.
    'POST /admin/incidents/:id': ({ body, admin, params }) => {
      if (!admin) throw new HttpError(401, 'admin token required');
      const was = incident(Number(params.id));
      if (!was) throw new HttpError(404, 'no such incident');
      if (body.delete === true) {
        tx(() => { q('DELETE FROM incident_updates WHERE incident = ?').run(was.id); q('DELETE FROM incidents WHERE id = ?').run(was.id); });
        log(null, 'incident_deleted', { id: was.id });
        return { ok: true, deleted: was.id };
      }
      const status = step(body.status), message = text(body.message, 2000, 'message');
      const title = body.title === undefined ? was.title : text(body.title, 120, 'title');
      const impact = body.impact === undefined ? was.impact : impactOf(body.impact);
      const components = body.components === undefined ? was.components : componentsOf(body.components);
      const t = clock();
      tx(() => {
        q('UPDATE incidents SET title = ?, impact = ?, components = ?, status = ?, resolved_at = ? WHERE id = ?')
          .run(title, impact, JSON.stringify(components), status, status === 'resolved' ? (was.resolved_at ?? t) : null, was.id);
        q('INSERT INTO incident_updates (incident, status, message, at) VALUES (?, ?, ?, ?)').run(was.id, status, message, t);
      });
      log(null, status === 'resolved' ? 'incident_resolved' : 'incident_updated', { id: was.id, status });
      return { ok: true, incident: publicIncident(incident(was.id)) };
    },
  };

  // ───── heartbeats ─────
  let last = null;        // the newest minute with a heartbeat
  let trimmedAt = 0;
  const addDay = q(`INSERT INTO status_days (day, component, up, slow, down) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (day, component) DO UPDATE SET up = up + excluded.up, slow = slow + excluded.slow, down = down + excluded.down`);
  const addMinute = q('INSERT OR IGNORE INTO status_minutes (minute, states) VALUES (?, ?)');
  const tally = (day, states, n = 1) => COMPONENTS.forEach((c, i) => addDay.run(day, c, states[i] === 'up' ? n : 0, states[i] === 'slow' ? n : 0, states[i] === 'down' ? n : 0));
  // Minutes nobody wrote (from, for n minutes): all up after a short restart, all down after a longer one.
  // Per-minute rows only for the last two days; further back, straight into the day counts.
  function fill(from, n, now) {
    const state = n <= GRACE_MIN ? 'up' : 'down', states = COMPONENTS.map(() => state), row = states.map((s) => LETTER[s]).join('');
    const start = Math.max(from, now - KEEP_DAYS * 1440), end = from + n;
    for (let m = Math.max(start, now - KEEP_MINUTES_MS / MIN); m < end; m++) addMinute.run(m, row);
    for (let m = start; m < end;) {
      const dayEnd = (Math.floor(m / 1440) + 1) * 1440;
      const k = Math.min(end, dayEnd) - m;
      tally(dayKey(m * MIN), states, k);
      m += k;
    }
  }
  // Called by the scheduler (every couple of seconds): the first call in a new minute writes that minute.
  function beat(t = clock()) {
    const m = Math.floor(t / MIN);
    try {
      if (last === null) last = q('SELECT max(minute) AS m FROM status_minutes').get().m ?? m - 1;
      if (m <= last) return false;
      const now = current(t), states = COMPONENTS.map((c) => now[c]);
      tx(() => {
        if (m - last > 1) fill(last + 1, m - last - 1, m);
        if (addMinute.run(m, states.map((s) => LETTER[s]).join('')).changes) tally(dayKey(t), states);
      });
      last = m;
      if (t - trimmedAt > 3_600_000) {
        trimmedAt = t;
        // The newest row always stays: it is how the next start knows how long the relay was away.
        q('DELETE FROM status_minutes WHERE minute < ? AND minute < (SELECT max(minute) FROM status_minutes)').run(Math.floor((t - KEEP_MINUTES_MS) / MIN));
        q('DELETE FROM status_days WHERE day < ?').run(dayKey(t - KEEP_DAYS * DAY));
      }
      return true;
    } catch (e) {
      writeFailedAt = t;
      return false;
    }
  }

  // ───── what the page and the JSON show ─────
  function view(t = clock()) {
    const now = current(t);
    const days = Array.from({ length: SHOWN_DAYS }, (_, i) => dayKey(t - (SHOWN_DAYS - 1 - i) * DAY));
    const counts = new Map(q('SELECT * FROM status_days WHERE day >= ?').all(days[0]).map((r) => [`${r.day} ${r.component}`, r]));
    const recent = q('SELECT * FROM incidents WHERE resolved_at IS NULL OR resolved_at >= ? ORDER BY created_at DESC').all(t - SHOWN_DAYS * DAY)
      .map((i) => ({ ...parse(i), updates: updatesOf(i.id) }));
    const components = COMPONENTS.map((id) => {
      let ok = 0, total = 0;
      const cells = days.map((day) => {
        const r = counts.get(`${day} ${id}`) ?? { up: 0, slow: 0, down: 0 };
        const n = r.up + r.slow + r.down;
        ok += r.up + r.slow; total += n;
        const from = Date.parse(`${day}T00:00:00Z`), to = from + DAY;
        const incidents = recent.filter((i) => i.components.includes(id) && i.created_at < to && (i.resolved_at ?? t) >= from);
        // A day is red after half an hour down, amber after a few minutes down or half an hour slow.
        const state = !n ? 'none' : r.down >= 30 ? 'down' : r.down > GRACE_MIN || r.slow >= 30 ? 'slow' : 'up';
        return { day, state, uptime: n ? (r.up + r.slow) / n : null, slow: r.slow, down: r.down, incidents };
      });
      return { id, now: now[id], uptime: total ? ok / total : null, cells };
    });
    const overall = COMPONENTS.reduce((s, c) => worse(s, now[c]), 'up');
    return { t, overall, components, active: recent.filter((i) => !i.resolved_at), recent };
  }

  const WORD = { up: 'operational', slow: 'degraded', down: 'down' };
  const SUMMARY = { up: "We're fully operational", slow: 'Some things are slow', down: "Something's down" };
  const round = (v) => (v == null ? null : Math.floor(v * 100_000) / 1000);
  function publicIncident(i) {
    return { id: i.id, title: i.title, impact: i.impact, status: i.status, components: i.components, created_at: iso(i.created_at), resolved_at: iso(i.resolved_at),
      updates: i.updates.map((u) => ({ status: u.status, message: u.message, at: iso(u.at) })) };
  }
  // /status.json: for agents and status-page readers. Only states, counts and the operator's own words.
  function json(base = '', t = clock()) {
    const v = view(t);
    return {
      page: { name: `${product} status`, url: `${base}/status`, feed: `${base}/status/feed.xml`, updated_at: iso(t) },
      status: { state: WORD[v.overall], description: SUMMARY[v.overall] },
      components: v.components.map((c) => ({ id: c.id, name: NAMES[c.id], status: WORD[c.now], uptime_90d: round(c.uptime),
        days: c.cells.map((d) => ({ date: d.day, uptime: round(d.uptime), slow_minutes: d.slow, down_minutes: d.down })) })),
      incidents: v.recent.map(publicIncident),
    };
  }

  // /status/feed.xml: one entry per incident, newest first, its updates as the content.
  function feed(base = '', t = clock(), tr = null) {
    const list = q('SELECT * FROM incidents ORDER BY created_at DESC LIMIT 30').all().map((i) => ({ ...parse(i), updates: updatesOf(i.id) }));
    const updated = Math.max(0, ...list.map((i) => i.updates[0]?.at ?? i.created_at)) || t;
    const entry = (i) => {
      const html = i.updates.map((u) => `<p><b>${esc(stepWords(tr)[u.status])}</b> · ${esc(iso(u.at))}<br>${esc(u.message)}</p>`).join('')
        + `<p>Affects: ${esc(i.components.map((c) => NAMES[c]).join(', '))}</p>`;
      return `<entry><id>${esc(base)}/status#incident-${i.id}</id><title>${esc(i.resolved_at ? `Resolved: ${i.title}` : i.title)}</title>
<link rel="alternate" type="text/html" href="${esc(base)}/status#incident-${i.id}"/><published>${iso(i.created_at)}</published><updated>${iso(i.updates[0]?.at ?? i.created_at)}</updated>
<content type="html">${esc(html)}</content></entry>`;
    };
    return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>${esc(product)} status</title><id>${esc(base)}/status</id>
<link rel="alternate" type="text/html" href="${esc(base)}/status"/><link rel="self" type="application/atom+xml" href="${esc(base)}/status/feed.xml"/>
<updated>${iso(updated)}</updated>
${list.map(entry).join('\n')}
</feed>`;
  }

  return { beat, request, rang, probed, wrapMailer, current, measured, view, json, feed, routes, page: (tr) => statusPage(view(), tr) };
}

// ───── the page ─────
// Each part in plain words. Written out so the Czech test finds every string.
const componentName = (c, tr) => ({ website: tr('Website and dashboard'), messages: tr('Messages'), wake: tr('Waking bots'), email: tr('Login emails'), apps: tr('Connected apps') })[c];
const stateWord = (s, tr) => ({ up: tr('Working'), slow: tr('Slow'), down: tr('Down') })[s];
const stepWords = (tr) => (tr ? { investigating: tr('Looking into it'), identified: tr('Found the cause'), monitoring: tr('Fixed, keeping watch'), resolved: tr('Resolved') }
  : { investigating: 'Looking into it', identified: 'Found the cause', monitoring: 'Fixed, keeping watch', resolved: 'Resolved' });
const headline = (s, tr) => ({ up: tr("We're fully operational"), slow: tr('Some things are slow'), down: tr("Something's down") })[s];

// Lucide shapes (ISC), the same stroke as the dashboard's icons.
const icon = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  up: icon('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  slow: icon('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
  down: icon('<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>'),
  feed: icon('<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/>'),
};

function statusPage(v, tr) {
  // 99.996% shows as 99.99%, never rounded up to a perfect 100%.
  const pct = (x) => new Intl.NumberFormat(tr.locale, { style: 'percent', maximumFractionDigits: 2 }).format(Math.floor(x * 10_000) / 10_000);
  const dur = (min) => (min < 60 ? tr('{n} min', { n: min }) : tr('{h} h {m} min', { h: Math.floor(min / 60), m: min % 60 }));
  const day = (key) => tr.date(Date.parse(`${key}T12:00:00Z`));
  // Times are written in UTC; the page script shows them in the reader's own time zone.
  const when = (ms) => `<time datetime="${new Date(ms).toISOString()}" data-local>${esc(new Intl.DateTimeFormat(tr.locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(ms))} UTC</time>`;
  const steps = stepWords(tr);
  // An incident keeps the colour of how bad it was; its Resolved step gets a green dot.
  const tone = (i) => (i.impact === 'major' ? 'down' : 'slow');
  const badgeTone = (i) => (i.resolved_at ? 'success' : i.status === 'monitoring' ? 'info' : i.impact === 'major' ? 'danger' : 'warning');
  const timeline = (i) => `<ol class="st-tl">${i.updates.map((u) => `<li${u.status === 'resolved' ? ' class="ok"' : ''}><p class="st-tl__step">${esc(steps[u.status])}</p><p class="st-tl__msg">${esc(u.message)}</p>${when(u.at)}</li>`).join('')}</ol>`;
  const affects = (i) => tr('Affects {list}', { list: i.components.map((c) => componentName(c, tr)).join(', ') });
  const activeCard = (i) => `<article class="card st-inc tone-${tone(i)}" id="incident-${i.id}" aria-labelledby="inc-${i.id}">
<div class="st-inc__head"><h2 class="st-inc__title" id="inc-${i.id}">${ICONS[tone(i)]}<span>${esc(i.title)}</span></h2><span class="badge badge--${badgeTone(i)}">${esc(steps[i.status])}</span></div>
<p class="st-inc__affects">${esc(affects(i))}</p>${timeline(i)}</article>`;

  // One cell a day. The label is read out by screen readers and drawn as the tooltip (one line each).
  const cell = (d, last) => {
    const lines = [day(d.day)];
    if (d.state === 'none') lines.push(tr('No data'));
    else {
      lines.push(tr('{pct} uptime', { pct: pct(d.uptime) }));
      if (d.down) lines.push(tr('Down for {time}', { time: dur(d.down) }));
      if (d.slow) lines.push(tr('Slow for {time}', { time: dur(d.slow) }));
      if (!d.down && !d.slow && !d.incidents.length) lines.push(tr('All good'));
    }
    for (const i of d.incidents) lines.push(i.title);
    return `<span class="${d.state[0]}" role="img"${last ? ' tabindex="0"' : ''} aria-label="${esc(lines.join('\n'))}"></span>`;
  };
  const row = (c) => {
    const name = componentName(c.id, tr);
    return `<li class="st-comp"><div class="st-comp__head"><h3 class="st-comp__name">${esc(name)}</h3><span class="st-now tone-${c.now}">${esc(stateWord(c.now, tr))}</span></div>
<div class="st-wrap"><div class="st-bar" role="group" aria-label="${esc(tr('{name}, last 90 days', { name }))}">${c.cells.map((d, i) => cell(d, i === c.cells.length - 1)).join('')}</div></div>
<div class="st-legend"><span>${tr('90 days ago')}</span><i></i><span>${c.uptime == null ? tr('No data yet') : esc(tr('{pct} uptime', { pct: pct(c.uptime) }))}</span><i></i><span>${tr('Today')}</span></div></li>`;
  };

  // The last two weeks, a heading per day, newest first; quiet days say so.
  const past = Array.from({ length: PAST_DAYS }, (_, k) => {
    const key = dayKey(v.t - k * DAY), from = Date.parse(`${key}T00:00:00Z`);
    const list = v.recent.filter((i) => i.created_at >= from && i.created_at < from + DAY);
    // One still open has its whole story at the top of the page, so here it is only its name.
    if (!list.length) return `<li class="st-day st-day--quiet"><h3>${esc(day(key))}</h3><p class="st-day__none">${tr('No incidents')}</p></li>`;
    return `<li class="st-day"><h3>${esc(day(key))}</h3>${list.map((i) => `<div class="st-past tone-${tone(i)}"${i.resolved_at ? ` id="incident-${i.id}"` : ''}>
<p class="st-past__title">${ICONS[tone(i)]}${i.resolved_at ? `<span>${esc(i.title)}</span>` : `<a href="#incident-${i.id}">${esc(i.title)}</a>`}<span class="badge badge--${badgeTone(i)}">${esc(steps[i.status])}</span></p>${i.resolved_at ? timeline(i) : ''}</div>`).join('')}</li>`;
  }).join('');

  return `<style>${STATUS_CSS}</style><div class="st" id="st">
<header class="st-hero tone-${v.overall}"><span class="st-hero__icon">${ICONS[v.overall]}</span><h1>${headline(v.overall, tr)}</h1></header>
${v.active.map(activeCard).join('')}
<section class="group" aria-labelledby="st-comps-h"><div class="group__head"><h2 id="st-comps-h">${tr('Last 90 days')}</h2></div>
<div class="card card--flush"><ul class="st-comps">${v.components.map(row).join('')}</ul></div></section>
<section class="group" aria-labelledby="st-past-h"><div class="group__head"><h2 id="st-past-h">${tr('Past incidents')}</h2></div>
<div class="card"><ol class="st-days">${past}</ol></div></section>
<p class="st-foot"><a href="/status/feed.xml" type="application/atom+xml">${ICONS.feed}${tr('Follow in a feed reader')}</a><a href="/status.json" type="application/json">status.json</a></p>
</div><script>${STATUS_JS}</script>`;
}

const STATUS_CSS = `.col--status{max-width:760px}
.st{display:grid;gap:28px;min-width:0}
.tone-up{--tone:var(--success)}.tone-slow{--tone:var(--warning)}.tone-down{--tone:var(--danger)}
.st-hero{display:flex;align-items:center;gap:14px;padding:8px 4px 4px}
.st-hero__icon{flex:none;display:grid;place-items:center;width:44px;height:44px;border-radius:50%;color:var(--tone);background:color-mix(in oklab,var(--tone) 14%,transparent)}
.st-hero__icon svg{width:24px;height:24px}.st-hero h1{font-size:clamp(24px,6vw,30px)}
.st-inc{border-color:color-mix(in oklab,var(--tone) 40%,var(--border))}
.st-inc__head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.st-inc__title{display:flex;align-items:flex-start;gap:10px;margin:0;font-size:var(--text-lg);line-height:1.3;min-width:0;overflow-wrap:anywhere}
.st-inc__title svg{flex:none;width:20px;height:20px;margin-top:2px;color:var(--tone)}
.st-inc__affects{margin:6px 0 0 30px;color:var(--text-secondary)}
.st-tl{list-style:none;margin:16px 0 0 9px;padding:0 0 0 19px;display:grid;gap:14px;border-left:1.5px solid var(--border)}
.st-tl li{position:relative}.st-tl li::before{content:"";position:absolute;left:-25px;top:5px;width:9px;height:9px;border-radius:50%;background:var(--surface);border:1.5px solid var(--border-strong)}
.st-tl li:first-child::before{background:var(--tone);border-color:var(--tone)}.st-tl li.ok::before{background:var(--success);border-color:var(--success)}
.st-tl p{margin:0}.st-tl__step{font-weight:500}.st-tl p.st-tl__msg{margin:2px 0 4px;white-space:pre-line;overflow-wrap:anywhere}.st-tl time{color:var(--text-muted);font-size:var(--text-xs)}
.st-comps{list-style:none;margin:0;padding:0}.st-comp{padding:18px 20px 16px}.st-comp+.st-comp{border-top:1px solid var(--border-subtle)}
.st-comp__head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.st-comp__name{font-size:var(--text-sm)}
.st-now{display:inline-flex;align-items:center;gap:7px;color:var(--tone);font-weight:500;white-space:nowrap}.st-now::before{content:"";width:8px;height:8px;border-radius:50%;background:currentColor}
.st-wrap{position:relative}
.st-bar{display:flex;gap:2px;height:34px;touch-action:pan-y;-webkit-user-select:none;user-select:none}
.st-bar>span{flex:1 1 0;min-width:0;border-radius:2px;background:var(--cell);transition:opacity var(--duration-instant) var(--ease-standard)}
.st-bar>.u{--cell:color-mix(in oklab,var(--success) 82%,var(--surface))}.st-bar>.s{--cell:var(--warning)}.st-bar>.d{--cell:var(--danger)}.st-bar>.n{--cell:var(--surface-muted)}
.st-bar.hot>span:not(.on){opacity:.5}.st-bar>span:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
@media (max-width:560px){.st-bar{gap:1px;height:30px}.st-bar>span{border-radius:1px}.st-comp{padding:16px}}
.st-legend{display:flex;align-items:center;gap:10px;margin-top:8px;color:var(--text-muted);font-size:var(--text-xs);white-space:nowrap}.st-legend i{flex:1;height:1px;background:var(--border-subtle)}
.st-tip{position:absolute;bottom:calc(100% + 8px);left:0;z-index:5;display:grid;gap:2px;width:max-content;max-width:min(260px,100%);padding:9px 12px;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--surface-raised);box-shadow:var(--shadow-floating);color:var(--text-secondary);font-size:var(--text-xs);pointer-events:none}
.st-tip b{color:var(--foreground);font-weight:500}
.st-days{list-style:none;margin:0;padding:0}.st-day{padding:16px 0}.st-day:first-child{padding-top:0}.st-day:last-child{padding-bottom:0}.st-day+.st-day{border-top:1px solid var(--border-subtle)}
.st-day h3{margin:0 0 8px;font-size:var(--text-sm)}.st-day__none{margin:0;color:var(--text-muted)}
.st-day--quiet{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:4px 16px;padding:12px 0}.st-day--quiet h3{margin:0}
.st-past+.st-past{margin-top:16px}.st-past__title{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin:0;font-weight:500}.st-past__title svg{flex:none;width:16px;height:16px;color:var(--tone)}.st-past__title>span:first-of-type,.st-past__title>a{overflow-wrap:anywhere}.st-past__title>a{color:inherit;text-underline-offset:3px}.st-past .st-tl{margin-top:10px}
.st-foot{display:flex;flex-wrap:wrap;gap:8px 20px;margin:0;padding:0 4px;font-size:var(--text-xs)}.st-foot a{display:inline-flex;align-items:center;gap:6px;color:var(--text-muted);text-decoration:none}@media (hover:hover) and (pointer:fine){.st-foot a:hover{color:var(--foreground)}}.st-foot svg{width:14px;height:14px}
@media (prefers-reduced-motion:reduce){.st-bar>span{transition:none}}`;

// The page script: tooltips for the day cells (pointer, touch drag, keyboard), local times, and a fresh copy of the
// page every minute while it's visible and nobody is looking at a tooltip.
const STATUS_JS = `(()=>{const fmt=new Intl.DateTimeFormat(document.documentElement.lang==='cs'?'cs-CZ':'en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
let tip=null,on=null;
const hide=()=>{if(tip)tip.hidden=true;if(on){on.classList.remove('on');on.parentElement.classList.remove('hot');}on=null;};
const show=(c)=>{if(!c||c===on&&tip&&!tip.hidden)return;hide();const bar=c.parentElement,wrap=bar.parentElement;
if(!tip){tip=document.createElement('div');tip.className='st-tip';tip.setAttribute('aria-hidden','true');}
if(tip.parentElement!==wrap)wrap.appendChild(tip);tip.textContent='';
(c.getAttribute('aria-label')||'').split('\\n').forEach((l,i)=>{const e=document.createElement(i?'span':'b');e.textContent=l;tip.appendChild(e);});
tip.hidden=false;const w=wrap.getBoundingClientRect(),r=c.getBoundingClientRect();
tip.style.left=Math.max(0,Math.min(w.width-tip.offsetWidth,r.left-w.left+r.width/2-tip.offsetWidth/2))+'px';
c.classList.add('on');bar.classList.add('hot');on=c;};
const init=(root)=>{if(!root)return;root.querySelectorAll('time[data-local]').forEach((t)=>{const d=new Date(t.getAttribute('datetime'));if(!isNaN(d))t.textContent=fmt.format(d);});
root.querySelectorAll('.st-bar').forEach((bar)=>{const cells=[...bar.children];cells.forEach((c)=>{if(c.tabIndex!==0)c.tabIndex=-1;});
const at=(e)=>{const r=bar.getBoundingClientRect();return cells[Math.max(0,Math.min(cells.length-1,Math.floor((e.clientX-r.left)/r.width*cells.length)))];};
bar.addEventListener('pointermove',(e)=>{if(e.pointerType==='mouse'||e.pressure>0)show(at(e));});
bar.addEventListener('pointerdown',(e)=>show(at(e)));
bar.addEventListener('pointerleave',(e)=>{if(e.pointerType==='mouse')hide();});
bar.addEventListener('focusin',(e)=>show(e.target));
bar.addEventListener('focusout',(e)=>{if(!bar.contains(e.relatedTarget))hide();});
bar.addEventListener('keydown',(e)=>{const i=cells.indexOf(document.activeElement);if(i<0)return;
const j={ArrowLeft:i-1,ArrowRight:i+1,Home:0,End:cells.length-1}[e.key];if(e.key==='Escape'){hide();return;}
if(j===undefined||!cells[j])return;e.preventDefault();cells[i].tabIndex=-1;cells[j].tabIndex=0;cells[j].focus();});});};
document.addEventListener('pointerdown',(e)=>{if(on&&!e.target.closest('.st-bar'))hide();});
init(document.getElementById('st'));
setInterval(()=>{if(document.visibilityState!=='visible'||on)return;
fetch(location.pathname,{headers:{accept:'text/html'},cache:'no-store'}).then((r)=>r.ok?r.text():null).then((h)=>{if(!h)return;
const n=new DOMParser().parseFromString(h,'text/html').getElementById('st'),cur=document.getElementById('st');if(n&&cur){tip=null;cur.replaceWith(n);init(n);}}).catch(()=>{});},60000);})();`;
