import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consentMarkup, privacyOptions, captureConnectedBots, replayPage, ANALYTICS_CSP } from '../analytics.mjs';
import { t } from '../i18n.mjs';
import { setup, login } from './helpers.mjs';

function client(saved, connected = []) {
  const handlers = {}, requests = [], calls = [];
  const storage = { 'b2b-consent': saved ? JSON.stringify(saved) : null };
  const fields = { analytics: { checked: false, focus() {} }, replay: { checked: false } };
  const form = { elements: fields, addEventListener: (n, fn) => { handlers[n] = fn; } };
  const root = { hidden: true, querySelector: () => form };
  const store = { getItem: (k) => storage[k], setItem: (k, v) => { storage[k] = v; }, removeItem: (k) => { delete storage[k]; } };
  const sdk = { init: (key, config) => { calls.push(config); config.loaded(sdk); }, capture: (e, p) => calls.push(p ? { event: e, properties: p } : e), stopSessionRecording: () => calls.push('stop'), opt_out_capturing: () => calls.push('out'), opt_in_capturing() {}, startSessionRecording() {}, set_config() {} };
  const context = { URL, location: { origin: 'https://www.bot2bot.link', hostname: 'www.bot2bot.link', reload: () => calls.push('reload') }, localStorage: store, sessionStorage: store,
    window: { posthog: sdk, addEventListener: (n, fn) => { handlers[n] = fn; } }, document: { cookie: '', querySelectorAll: () => connected, getElementById: () => root, addEventListener: (n, fn) => { handlers[n] = fn; }, createElement: () => ({}), head: { append: (s) => requests.push(s) } } };
  const html = consentMarkup(t('en'), 'public-test-key');
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  vm.runInNewContext(html.match(/<script>([^]*?)<\/script>/)[1], context);
  return { handlers, fields, root, requests, calls, storage };
}

test('no SDK request before consent, after rejection, or with an old consent version', () => {
  for (const saved of [null, { version: '2', value: { analytics: true } }, { version: '3', value: { analytics: false, replay: false } }]) {
    const c = client(saved);
    assert.equal(c.requests.length, 0);
    c.handlers.submit({ preventDefault() {}, submitter: { value: 'reject' } });
    assert.equal(c.requests.length, 0);
  }
});

test('explicit replay consent loads EU SDK, keeps page analytics separate, and withdrawal stops it', () => {
  const c = client(null);
  c.fields.replay.checked = true;
  c.handlers.submit({ preventDefault() {}, submitter: { value: 'save' } });
  assert.equal(c.requests.length, 1);
  assert.equal(c.requests[0].src, 'https://eu-assets.i.posthog.com/static/array.js');
  c.requests[0].onload();
  const config = c.calls[0];
  assert.equal(config.disable_session_recording, false);
  assert.equal(config.session_recording.maskTextSelector, '*');
  assert.equal(config.session_recording.maskAllElementAttributes, true);
  assert.equal(config.before_send({ event: '$pageview' }), null);
  assert.equal(c.calls.includes('$pageview'), false);
  assert.equal(config.before_send({ event: '$autocapture' }), null);
  assert.equal(config.autocapture, false);
  c.handlers.submit({ preventDefault() {}, submitter: { value: 'reject' } });
  assert.ok(c.calls.includes('stop'));
  assert.ok(c.calls.includes('out'));
});

test('withdrawal in another tab while SDK loads prevents initialization', () => {
  const c = client({ version: '3', value: { replay: true } });
  c.storage['b2b-consent'] = null;
  c.handlers.storage({ key: 'b2b-consent' });
  c.requests[0].onload();
  assert.deepEqual(c.calls, []);
  assert.equal(c.root.hidden, false);
});

test('sensitive routes are excluded, including nested admin, approvals, invites and setup', () => {
  for (const p of ['/login', '/login/link', '/i/ABCD-EFGH', '/app/link/ABCD-EFGH', '/app/admin', '/app/admin/users', '/oauth/authorize', '/app/bots/new-form', '/gift/ABCD-EFGH', '/app/requests/1']) assert.equal(replayPage(p), false, p);
  for (const p of ['/app', '/app/account', '/app/people/12/23']) assert.equal(replayPage(p), true, p);
});

test('URLs lose queries, fragments and IDs; unknown events are dropped', () => {
  globalThis.location = { origin: 'https://www.bot2bot.link' };
  const config = privacyOptions(true);
  const e = config.before_send({ event: '$snapshot', properties: { token: 'public-project-key', $current_url: 'https://www.bot2bot.link/app/bots/123?t=secret#key', $title: 'private', $snapshot_data: [{ type: 4, data: { href: 'https://www.bot2bot.link/i/CODE?key=secret' } }] } });
  assert.doesNotMatch(JSON.stringify(e), /secret|CODE|123|private/);
  assert.equal(e.properties.token, 'public-project-key');
  assert.equal(config.before_send({ event: '$identify' }), null);
  assert.equal(config.session_recording.maskAllInputs, true);
  assert.equal(config.session_recording.compress_events, false);
  assert.equal(config.session_recording.recordBody, false);
  assert.doesNotMatch(config.session_recording.maskCapturedNetworkRequestFn({ name: 'https://www.bot2bot.link/app?t=secret' }).name, /secret/);
  assert.equal(config.session_recording.maskCapturedNetworkRequestFn({ name: '/api', requestBody: 'private' }), null);
  assert.equal(config.enable_recording_console_log, false);
  delete globalThis.location;
});

test('hosted HTML has a gated loader and EU CSP; sensitive HTML has no PostHog', async (t0) => {
  const dir = mkdtempSync(join(tmpdir(), 'b2b-analytics-'));
  writeFileSync(join(dir, 'index.html'), '<h1>site</h1>');
  const env = await setup(t0, { siteDir: dir, analyticsKey: 'phc_test' });
  const b = await login(env, 'analytics-test@example.test');
  const home = await b('/app');
  assert.match(home.text, /id="b2b-cookie"/);
  assert.ok(home.text.includes("'$$heatmap'"), 'HTML insertion preserves SDK event names');
  assert.doesNotMatch(home.text, /<script[^>]+src=[^>]*posthog/);
  assert.match(home.text, /data-cookie-settings/);
  for (const path of ['/login', '/login/link?t=invalid', '/i/ABCD-EFGH', '/app/link/ABCD-EFGH', '/app/admin']) {
    assert.doesNotMatch((await b(path)).text, /posthog|eu-assets\.i/);
  }
  const user = env.relay.db.prepare('SELECT id FROM users LIMIT 1').get();
  const session = 'analytics-test-session';
  env.relay.db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(createHash('sha256').update(session).digest('hex'), user.id, Date.now(), Date.now() + 60000);
  const response = await fetch(env.url + '/app', { headers: { cookie: `b2b_session=${session}` } });
  assert.equal(response.headers.get('content-security-policy'), ANALYTICS_CSP);
  assert.match(ANALYTICS_CSP, /connect-src 'self' https:\/\/eu.i.posthog.com https:\/\/eu-assets.i.posthog.com/);
  assert.match(ANALYTICS_CSP, /script-src 'self' 'unsafe-inline' https:\/\/eu-assets.i.posthog.com/);
  assert.match(ANALYTICS_CSP, /worker-src 'self' blob:/);
});

test('no analytics key (a self-hosted relay): no cookie banner or analytics on any page', async (t0) => {
  const dir = mkdtempSync(join(tmpdir(), 'b2b-analytics-'));
  writeFileSync(join(dir, 'index.html'), '<h1>site</h1>');
  const env = await setup(t0, { siteDir: dir });
  const home = (await (await login(env, 'self-host@example.test'))('/app')).text;
  assert.doesNotMatch(home, /id="b2b-cookie"|phc_|posthog/);
});

test('consent version agrees with site and new controls have Czech copy', () => {
  // The website isn't in the open-source copy of the relay; where it is, its consent version must match.
  const siteFile = new URL('../../site/v2/simple/src/data/site.ts', import.meta.url);
  if (existsSync(siteFile)) assert.match(readFileSync(siteFile, 'utf8'), /version: '3'/);
  assert.match(consentMarkup(t('cs'), 'test'), /Odmítnout vše/);
});


test('consented interactions retain useful public content and mask private dashboard elements', () => {
  const config = privacyOptions(true);
  const e = config.before_send({ event: '$autocapture', properties: { $event_type: 'click', $elements: [{ tag_name: 'button', $el_text: 'private', 'attr__href': '/i/SECRET' }], $elements_chain: 'private', $title: 'private' } });
  assert.doesNotMatch(JSON.stringify(e), /private|SECRET/);
  assert.equal(e.properties.$event_type, 'click');
  assert.equal(e.properties.$elements[0].tag_name, 'button');
  assert.equal(privacyOptions(false).mask_all_text, false);
  assert.equal(privacyOptions(true).mask_all_text, true);
  assert.equal(privacyOptions(false).session_recording.blockSelector.includes(', img'), false);
  globalThis.location = { origin: 'https://www.bot2bot.link' };
  assert.equal(privacyOptions(false).session_recording.maskAttributeFn('src', '/images/guide.png?t=secret'), 'https://www.bot2bot.link/images/guide.png');
  delete globalThis.location;
});


test('free diagnostics preserve useful stack frames and scrub private error context', () => {
  globalThis.location = { origin: 'https://www.bot2bot.link' };
  const config = privacyOptions(true);
  assert.equal(config.capture_exceptions, true);
  assert.equal(config.capture_heatmaps, true);
  assert.equal(config.capture_performance.web_vitals, true);
  assert.equal(config.capture_performance.network_timing, false);
  const event = config.before_send({ event: '$exception', properties: { $exception_message: 'private', $exception_list: [{ type: 'TypeError', value: 'test@example.invalid token=SECRET', stacktrace: { frames: [{ filename: 'https://www.bot2bot.link/_astro/app.js?t=SECRET', function: 'render', lineno: 12, vars: { token: 'SECRET' }, pre_context: ['private'] }] } }] } });
  assert.doesNotMatch(JSON.stringify(event), /SECRET|test@example|private/);
  assert.equal(event.properties.$exception_list[0].stacktrace.frames[0].lineno, 12);
  assert.match(event.properties.$exception_list[0].stacktrace.frames[0].filename, /app\.js$/);
  delete globalThis.location;
});


test('heatmap URL keys and performance URLs lose secrets; pathnames stay paths', () => {
  globalThis.location = { origin: 'https://www.bot2bot.link' };
  const e = privacyOptions().before_send({ event: '$$heatmap', properties: { $pathname: '/app?t=SECRET', $heatmap_data: { 'https://www.bot2bot.link/app?t=SECRET#FRAGMENT': [{ x: 2, y: 3 }] } } });
  assert.doesNotMatch(JSON.stringify(e), /SECRET|FRAGMENT/);
  assert.equal(e.properties.$pathname, '/app');
  assert.equal(e.properties.$heatmap_data['https://www.bot2bot.link/app'][0].x, 2);
  delete globalThis.location;
});

test('only four validated UTM slugs survive, including nested SDK campaign properties', () => {
  globalThis.location = { origin: 'https://www.bot2bot.link' };
  const config = privacyOptions();
  assert.equal(config.save_campaign_params, true);
  const utms = { utm_source: 'x', utm_medium: 'social', utm_campaign: 'pilot-nov', utm_content: 'dusanzabrodsky-reply-tjack' };
  const event = config.before_send({ event: '$pageview', properties: {
    ...utms, $current_url: 'https://www.bot2bot.link/start/?utm_source=x&token=SECRET#SECRET',
    utm_term: 'SECRET', $initial_utm_source: 'SECRET', gclid: 'SECRET', fbclid: 'SECRET', twclid: 'SECRET',
    igshid: 'SECRET', epik: 'SECRET', sccid: 'SECRET', oppref: 'SECRET', bfcid: 'SECRET', _kx: 'SECRET',
    $set_once: { $initial_utm_campaign: 'SECRET', $initial_gclid: 'SECRET' },
    $set: { utm_term: 'SECRET', gclid: 'SECRET' },
  } });
  for (const [key, value] of Object.entries(utms)) assert.equal(event.properties[key], value);
  assert.equal(event.properties.$current_url, 'https://www.bot2bot.link/start/');
  assert.doesNotMatch(JSON.stringify(event), /SECRET/);
  for (const value of ['someone@example.test', 'Bearer secret', 'https://private.test', 'x'.repeat(101), { secret: 'value' }]) {
    assert.equal(config.before_send({ event: '$pageview', properties: { utm_source: value } }).properties.utm_source, undefined);
  }
  assert.ok(config.before_send({ event: 'bot_connected', properties: { vendor: 'connector', ...utms } }));
  assert.equal(config.before_send({ event: 'pairing_finished', properties: {} }), null);
  delete globalThis.location;
});

test('bot_connected waits for analytics consent and fires once across callbacks and page loads', () => {
  const bot = { getAttribute: (key) => key === 'data-vendor' ? 'connector' : '42' };
  const c = client(null, [bot]);
  assert.equal(c.requests.length, 0);
  c.fields.replay.checked = true;
  c.handlers.submit({ preventDefault() {}, submitter: { value: 'save' } });
  c.requests[0].onload();
  assert.equal(c.calls[0].save_campaign_params, false);
  assert.equal(c.calls.some((call) => call.event === 'bot_connected'), false);
  c.fields.analytics.checked = true;
  c.handlers.submit({ preventDefault() {}, submitter: { value: 'save' } });
  c.handlers.submit({ preventDefault() {}, submitter: { value: 'save' } });
  const events = c.calls.filter((call) => call.event === 'bot_connected');
  assert.equal(events.length, 1);
  assert.equal(JSON.stringify(events[0]), JSON.stringify({ event: 'bot_connected', properties: { vendor: 'connector' } }));
  const storage = c.storage;
  const context = { document: { querySelectorAll: () => [bot] }, localStorage: { getItem: (key) => storage[key], setItem: (key, value) => { storage[key] = value; } }, sdk: { capture: () => assert.fail('duplicate after navigation') } };
  vm.runInNewContext(`(${captureConnectedBots.toString()})(sdk)`, context);
});

test('dashboard marks connected bots, excluding setup, paused, disconnected and web inbox states', async (t0) => {
  const dir = mkdtempSync(join(tmpdir(), 'b2b-campaign-'));
  writeFileSync(join(dir, 'index.html'), '<h1>site</h1>');
  const env = await setup(t0, { siteDir: dir });
  const b = await login(env, 'campaign-test@example.test');
  const user = env.relay.db.prepare('SELECT id FROM users LIMIT 1').get();
  const insert = env.relay.db.prepare('INSERT INTO bots (handle, display_name, created_at, user_id, vendor, platform, webhook_url, doorbell_verified_at, paused_at, disconnected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const [handle, vendor, platform, webhook, verified, paused, off] of [
    ['ready-app', 'connector', 'other', null, null, null, null],
    ['ready-private', 'grokbot', 'grokbot', 'https://example.test/hook', Date.now(), null, null],
    ['setup', 'grokbot', 'grokbot', null, null, null, null],
    ['untested', 'grokbot', 'grokbot', 'https://example.test/hook', null, null, null],
    ['paused', 'connector', 'other', null, null, Date.now(), null],
    ['off', 'connector', 'other', null, null, null, Date.now()],
    ['web', 'web', 'other', null, null, null, null],
  ]) insert.run(handle, handle, Date.now(), user.id, vendor, platform, webhook, verified, paused, off);
  const home = await b('/app');
  // Count markup only; the inline script also contains the selector.
  assert.equal([...home.text.matchAll(/<span hidden data-analytics-connected=/g)].length, 2);
  for (const handle of ['ready-app', 'ready-private', 'setup', 'paused', 'off', 'web']) {
    const bot = env.relay.db.prepare('SELECT id FROM bots WHERE handle = ?').get(handle);
    const details = await b(`/app/bots/${bot.id}`);
    assert.equal(details.text.includes('<span hidden data-analytics-connected='), handle.startsWith('ready-'), handle);
  }
});
