// The public status page: a heartbeat a minute, gaps after a restart, the signals that make a part slow or down,
// incidents from the operator, and the page, JSON and feed people and agents read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../server.mjs';
import { listen, browser, setup, owner, connect, ADMIN } from './helpers.mjs';

const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);
const MIN = 60_000;
const PARTS = ['website', 'messages', 'wake', 'email', 'apps'];

// A relay whose clock only moves when the test moves it (nothing ticks on its own), on a random port.
async function make(t0, { t = T0, ...opts } = {}) {
  const clock = { t };
  let relay;
  const { s, url } = await listen((req, res) => relay.handle(req, res));
  relay = createRelay({ adminToken: ADMIN, publicUrl: url, allowLocalWebhooks: true, clock: () => clock.t, ...opts });
  t0.after(() => { s.close(); try { relay.db.close(); } catch { /* closed by the test */ } });
  const json = async () => (await fetch(`${url}/status.json`)).json();
  const part = async (id) => (await json()).components.find((c) => c.id === id);
  return { relay, url, clock, json, part, advance: (ms) => { clock.t += ms; } };
}
const minutes = (relay) => relay.db.prepare('SELECT minute, states FROM status_minutes ORDER BY minute').all();
const day = (relay, component, d = '2026-11-04') => relay.db.prepare('SELECT up, slow, down FROM status_days WHERE day = ? AND component = ?').get(d, component);

test('the relay writes one heartbeat a minute, and each one counts toward its day', async (t0) => {
  const env = await make(t0);
  assert.equal(env.relay.status.beat(), true);
  assert.equal(env.relay.status.beat(), false, 'once a minute');
  env.advance(30_000);
  assert.equal(env.relay.status.beat(), false, 'still the same minute');
  for (let i = 0; i < 3; i++) { env.advance(MIN); env.relay.status.beat(); }
  // The scheduler is what calls it in production.
  env.advance(MIN);
  await env.relay.tick();
  const rows = minutes(env.relay);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((r) => r.minute - rows[0].minute), [0, 1, 2, 3, 4], 'one row per minute, no gaps');
  assert.ok(rows.every((r) => r.states === 'uuuuu'), 'every part up');
  for (const c of PARTS) assert.deepEqual({ ...day(env.relay, c) }, { up: 5, slow: 0, down: 0 });
});

test('after a restart, a long gap counts as down for everything, and a short deploy gap does not', async (t0) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'b2b-status-')), 'relay.db');
  const first = await make(t0, { dbPath });
  for (let i = 0; i < 3; i++) { first.relay.status.beat(); first.advance(MIN); } // 12:00, 12:01, 12:02
  first.relay.db.close();

  // A deploy: the new process writes its first heartbeat at 12:05, so 12:03 and 12:04 are missing. That's a restart.
  const deploy = await make(t0, { dbPath, t: T0 + 5 * MIN + 10_000 });
  deploy.relay.status.beat();
  assert.deepEqual(minutes(deploy.relay).map((r) => r.states), Array(6).fill('uuuuu'));
  deploy.relay.db.close();

  // A crash: nothing from 12:06 to 12:15. Once it is back, those ten minutes show as down, for every part.
  const back = await make(t0, { dbPath, t: T0 + 16 * MIN });
  back.relay.status.beat();
  const rows = minutes(back.relay);
  assert.equal(rows.length, 17);
  assert.deepEqual(rows.slice(6, 16).map((r) => r.states), Array(10).fill('ddddd'));
  assert.equal(rows.at(-1).states, 'uuuuu', 'up again now');
  for (const c of PARTS) assert.deepEqual({ ...day(back.relay, c) }, { up: 7, slow: 0, down: 10 });
  const messages = await back.part('messages');
  assert.equal(messages.status, 'operational', 'it works now');
  assert.equal(messages.uptime_90d, 41.176, '7 of 17 minutes');
  assert.deepEqual(messages.days.at(-1), { date: '2026-11-04', uptime: 41.176, slow_minutes: 0, down_minutes: 10 });
  // Ten minutes down is an amber day; a day before any heartbeat has no data.
  const page = await browser(back.url)('/status');
  const cells = [...page.text.match(/aria-label="Messages, last 90 days">([^]*?)<\/div>/)[1].matchAll(/<span class="(\w)"[^>]*aria-label="([^"]*)"/g)];
  assert.equal(cells.length, 90);
  assert.deepEqual([cells.at(-1)[1], cells.at(-1)[2]], ['s', '4 November 2026\n41.17% uptime\nDown for 10 min']);
  assert.deepEqual([cells[0][1], cells[0][2]], ['n', '7 August 2026\nNo data']);
});

test('waking bots is slow when rings fail on our side across several bots, never for owners whose routine says no', async (t0) => {
  for (const [code, want] of [[503, 'degraded'], [403, 'operational']]) {
    const env = await make(t0);
    const routine = await listen((req, res) => { res.writeHead(code).end('{}'); });
    t0.after(() => routine.s.close());
    const db = env.relay.db;
    for (let i = 0; i < 3; i++) {
      db.prepare("INSERT INTO bots (handle, display_name, created_at, webhook_url, webhook_key, doorbell_kind) VALUES (?, ?, ?, ?, 'k-12345678', 'grok_webhook')")
        .run(`ring-${i}`, `Ring ${i}`, env.clock.t, `${routine.url}/automations/webhook/${i}`);
    }
    const bots = db.prepare('SELECT * FROM bots ORDER BY id').all();
    await env.relay.ring(bots[0], 'test');
    assert.equal((await env.part('wake')).status, 'operational', 'one bot failing is that bot');
    for (const b of bots.slice(1)) await env.relay.ring(b, 'test');
    assert.equal((await env.part('wake')).status, want, `rings answered ${code}`);
    if (code === 503) {
      assert.equal((await env.json()).status.state, 'degraded');
      assert.match((await browser(env.url)('/status')).text, /Some things are slow[^]*Waking bots<\/h3><span class="st-now tone-slow">Slow</);
      // Once they work again (or the failures are a few minutes old), it is back to working.
      env.advance(6 * MIN);
      assert.equal((await env.part('wake')).status, 'operational');
    }
  }
  // Nobody answering at all (a network error) counts too.
  const env = await make(t0);
  const gone = await listen((req, res) => res.end());
  const deadUrl = gone.url; gone.s.close();
  for (let i = 0; i < 3; i++) {
    env.relay.db.prepare("INSERT INTO bots (handle, display_name, created_at, webhook_url, webhook_key, doorbell_kind) VALUES (?, ?, ?, ?, 'k-12345678', 'grok_webhook')")
      .run(`gone-${i}`, `Gone ${i}`, env.clock.t, `${deadUrl}/automations/webhook/${i}`);
  }
  for (const b of env.relay.db.prepare('SELECT * FROM bots').all()) await env.relay.ring(b, 'test');
  assert.equal((await env.part('wake')).status, 'degraded');
});

test('failed emails mark login emails, and it clears once they go out again', async (t0) => {
  t0.mock.method(console, 'error', () => {}); // the failed sends are logged; expected here
  let failing = true;
  const env = await make(t0, { mailer: async () => { if (failing) throw new Error('provider down'); } });
  const b = browser(env.url);
  for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) await b('/login', { method: 'POST', form: { email } });
  assert.equal((await env.part('email')).status, 'down', 'every send failed');
  assert.match((await b('/status')).text, /Something's down[^]*Login emails<\/h3><span class="st-now tone-down">Down</);
  failing = false;
  for (const email of ['d@example.com', 'e@example.com', 'f@example.com']) await b('/login', { method: 'POST', form: { email } });
  assert.equal((await env.part('email')).status, 'degraded', 'half of them failed');
  env.advance(6 * MIN);
  assert.equal((await env.part('email')).status, 'operational');
});

test('the outside check: when its pings stop reaching a running relay, pages, bots and apps are down', async (t0) => {
  const env = await make(t0, { probeToken: 'probe-secret-123' });
  const ping = (token = 'probe-secret-123') => fetch(`${env.url}/healthz`, { headers: { 'x-status-probe': token } });
  assert.equal((await ping()).status, 200);
  env.advance(3 * MIN);
  await ping('wrong');
  assert.equal((await env.json()).status.state, 'operational', 'a missed ping or two is fine');
  env.advance(2 * MIN);
  const parts = Object.fromEntries((await env.json()).components.map((c) => [c.id, c.status]));
  assert.deepEqual(parts, { website: 'down', messages: 'down', wake: 'operational', email: 'operational', apps: 'down' }, 'a wrong token is no ping');
  env.relay.status.beat();
  assert.equal(minutes(env.relay).at(-1).states, 'dduud', 'the minute is kept as down');
  await ping();
  assert.equal((await env.json()).status.state, 'operational', 'back once pings arrive again');
  env.advance(7 * 60 * MIN);
  assert.equal((await env.json()).status.state, 'operational', 'a pinger gone for hours was retired, not an outage');
});

test('without an outside check set up, /healthz pings change nothing', async (t0) => {
  const env = await make(t0);
  await fetch(`${env.url}/healthz`, { headers: { 'x-status-probe': '' } });
  env.advance(10 * MIN);
  assert.equal((await env.json()).status.state, 'operational');
});

test('incidents: the operator opens, updates and resolves one with the admin token, and the page, JSON and feed follow', async (t0) => {
  const env = await make(t0);
  env.relay.status.beat();
  const post = (path, body, token = ADMIN) => fetch(env.url + path, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const open = { title: 'Messages arrive late', status: 'investigating', message: 'Some messages take a few minutes. <b>Looking</b> into it.', components: ['messages', 'wake'], impact: 'major' };
  assert.equal((await post('/admin/incidents', open, '')).status, 401);
  assert.equal((await post('/admin/incidents', open, 'not-the-admin-token-123')).status, 401);
  assert.equal((await post('/admin/incidents', { ...open, components: ['database'] })).status, 400);
  assert.equal((await post('/admin/incidents', { ...open, status: 'panicking' })).status, 400);
  assert.equal((await post('/admin/incidents', { ...open, title: ' ' })).status, 400);
  const made = await post('/admin/incidents', open);
  assert.equal(made.status, 200);
  const { incident } = await made.json();
  assert.equal(incident.status, 'investigating');

  // An open major incident makes its parts down, whatever was measured.
  let j = await env.json();
  assert.equal(j.status.state, 'down');
  assert.deepEqual(Object.fromEntries(j.components.map((c) => [c.id, c.status])), { website: 'operational', messages: 'down', wake: 'down', email: 'operational', apps: 'operational' });
  assert.equal(j.incidents[0].title, 'Messages arrive late');
  let page = (await browser(env.url)('/status')).text;
  assert.match(page, /Something's down[^]*<article class="card st-inc tone-down" id="incident-\d+"[^]*Messages arrive late[^]*Looking into it[^]*Affects Messages, Waking bots/);
  assert.ok(page.includes('Some messages take a few minutes. &lt;b&gt;Looking&lt;/b&gt; into it.'), 'escaped');
  assert.ok(!page.includes('<b>Looking</b>'));
  // Today's cells say there was an incident.
  assert.match(page, /aria-label="4 November 2026\n[^"]*\nMessages arrive late"/);

  env.advance(20 * MIN);
  assert.equal((await post(`/admin/incidents/${incident.id}`, { status: 'monitoring', message: 'A fix is out.' }, '')).status, 401);
  assert.equal((await post('/admin/incidents/999', { status: 'monitoring', message: 'x' })).status, 404);
  assert.equal((await post(`/admin/incidents/${incident.id}`, { status: 'monitoring', message: 'A fix is out.', impact: 'minor' })).status, 200);
  j = await env.json();
  assert.equal(j.status.state, 'degraded', 'now minor');
  assert.deepEqual(j.incidents[0].updates.map((u) => u.status), ['monitoring', 'investigating'], 'newest first');

  env.advance(20 * MIN);
  assert.equal((await post(`/admin/incidents/${incident.id}`, { status: 'resolved', message: 'All caught up.' })).status, 200);
  j = await env.json();
  assert.equal(j.status.state, 'operational');
  assert.equal(j.incidents[0].resolved_at, new Date(T0 + 40 * MIN).toISOString());
  page = (await browser(env.url)('/status')).text;
  assert.match(page, /We're fully operational/);
  assert.doesNotMatch(page, /<article class="card st-inc/, 'nothing open');
  assert.match(page, /Past incidents[^]*4 November 2026[^]*Messages arrive late[^]*Resolved[^]*All caught up\.[^]*A fix is out\./);
  assert.match(page, /No incidents/, 'quiet days say so');

  const feed = await fetch(`${env.url}/status/feed.xml`);
  assert.match(feed.headers.get('content-type'), /application\/atom\+xml/);
  const xml = await feed.text();
  assert.match(xml, /^<\?xml[^]*<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">[^]*<entry><id>http:\/\/127\.0\.0\.1:\d+\/status#incident-\d+<\/id><title>Resolved: Messages arrive late<\/title>/);
  assert.ok(xml.includes('&amp;lt;b&amp;gt;Looking'), 'escaped twice: once for the HTML, once for the XML');

  // A mistake can be taken back.
  assert.equal((await post(`/admin/incidents/${incident.id}`, { delete: true })).status, 200);
  assert.deepEqual((await env.json()).incidents, []);
});

test('the status page in English and Czech: each part with a cell for each of the last 90 days', async (t0) => {
  const env = await make(t0);
  env.relay.status.beat();
  const en = await browser(env.url)('/status');
  assert.equal(en.status, 200);
  assert.match(en.text, /<html lang="en">[^]*<title>Status · bot2bot<\/title>[^]*<h1>We're fully operational<\/h1>/);
  const bars = [...en.text.matchAll(/<div class="st-bar" role="group" aria-label="([^"]+), last 90 days">([^]*?)<\/div>/g)];
  assert.deepEqual(bars.map((b) => b[1]), ['Website and dashboard', 'Messages', 'Waking bots', 'Login emails', 'Connected apps']);
  for (const [, , cells] of bars) {
    assert.equal(cells.match(/role="img"/g).length, 90);
    assert.equal(cells.match(/tabindex="0"/g).length, 1, 'one tab stop per bar; arrows move along it');
    assert.match(cells, /<span class="u" role="img" tabindex="0" aria-label="4 November 2026\n100% uptime\nAll good"><\/span>$/);
  }
  assert.equal(en.text.match(/<span class="st-now tone-up">Working<\/span>/g).length, 5);
  assert.match(en.text, /90 days ago<\/span><i><\/i><span>100% uptime<\/span><i><\/i><span>Today/);
  assert.match(en.text, /Past incidents/);
  assert.equal(en.text.match(/No incidents/g).length, 14, 'the last two weeks');
  assert.match(en.text, /href="\/status\/feed\.xml"[^]*href="\/status\.json"/);
  assert.match(en.text, /setInterval\([^]*60000\)/, 'it refreshes itself');

  const cs = await browser(env.url, { 'accept-language': 'cs-CZ,cs;q=0.9' })('/status');
  assert.match(cs.text, /<html lang="cs">[^]*<title>Stav · bot2bot<\/title>[^]*<h1>Všechno funguje<\/h1>/);
  assert.match(cs.text, /aria-label="Web a přehled, posledních 90 dní"/);
  assert.match(cs.text, /aria-label="4\. listopadu 2026\nDostupnost 100\u00a0%\nVšechno v pořádku"/);
  assert.match(cs.text, /Před 90 dny[^]*Dnes[^]*Předchozí potíže[^]*Bez potíží/);
  assert.equal(cs.text.match(/role="img"/g).length, 450);

  // The language picked at the top comes back to the status page.
  const pick = browser(env.url, { referer: `${env.url}/status` });
  assert.equal((await pick('/lang/cs')).location, '/status');
  assert.match((await pick('/status')).text, /<html lang="cs">/);
  assert.equal((await fetch(`${env.url}/status/`, { redirect: 'manual' })).headers.get('location'), '/status');
  const j = await fetch(`${env.url}/status.json`);
  assert.match(j.headers.get('content-type'), /application\/json/);
  assert.equal(j.headers.get('access-control-allow-origin'), '*');
});

test('the status JSON and feed have nothing personal in them', async (t0) => {
  const env = await setup(t0);
  const ann = await owner(env, t0, 'ann.status@example.com', 'ann-status');
  const ben = await owner(env, t0, 'ben.status@example.com', 'ben-status');
  await connect(ann, ben, 'Ann', { basket: 'friends' });
  env.advance(MIN);
  await env.relay.tick();
  const res = await fetch(`${env.url}/admin/incidents`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Slow sign-in', message: 'Looking into it.', components: ['email'] }) });
  assert.equal(res.status, 200);
  const raw = await (await fetch(`${env.url}/status.json`)).text();
  const feed = await (await fetch(`${env.url}/status/feed.xml`)).text();
  for (const text of [raw, feed]) {
    for (const secret of ['ann.status', 'ben.status', 'example.com', 'ann-status', 'ben-status', '@', 'Ann']) assert.ok(!text.includes(secret), `no "${secret}"`);
  }
  const j = JSON.parse(raw);
  assert.deepEqual(Object.keys(j), ['page', 'status', 'components', 'incidents']);
  assert.deepEqual(j.components.map((c) => Object.keys(c)), PARTS.map(() => ['id', 'name', 'status', 'uptime_90d', 'days']));
  assert.deepEqual(Object.keys(j.components[0].days[0]), ['date', 'uptime', 'slow_minutes', 'down_minutes']);
  assert.deepEqual(Object.keys(j.incidents[0]), ['id', 'title', 'impact', 'status', 'components', 'created_at', 'resolved_at', 'updates']);
  assert.equal(j.incidents[0].impact, 'minor', 'minor unless said');
  assert.equal(j.components.find((c) => c.id === 'email').status, 'degraded');
});
