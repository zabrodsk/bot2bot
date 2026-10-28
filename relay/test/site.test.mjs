// The hosted server also serves the landing site on the same domain as the dashboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../server.mjs';
import { setup } from './helpers.mjs';

const listen = (h) => new Promise((ok) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const HTML = { accept: 'text/html,application/xhtml+xml' };

function fakeSite() {
  const dir = mkdtempSync(join(tmpdir(), 'b2b-site-'));
  writeFileSync(join(dir, 'index.html'), '<h1>landing</h1>');
  writeFileSync(join(dir, '404.html'), '<h1>no bot here</h1>');
  mkdirSync(join(dir, 'pricing')); writeFileSync(join(dir, 'pricing', 'index.html'), '<h1>pricing page</h1>');
  mkdirSync(join(dir, '_astro')); writeFileSync(join(dir, '_astro', 'a.js'), 'console.log(1)');
  return dir;
}

test('the landing site and the dashboard share one domain; server routes always win', async (t0) => {
  let relay;
  const { s, url } = await listen((req, res) => relay.handle(req, res));
  t0.after(() => s.close());
  relay = createRelay({ adminToken: 'admin-token-for-tests-123456', publicUrl: url, hosted: true, siteDir: fakeSite() });

  const home = await fetch(`${url}/`, { headers: HTML });
  assert.equal(home.status, 200);
  assert.match(await home.text(), /landing/);
  assert.equal(home.headers.get('cache-control'), 'no-cache');

  const pricing = await fetch(`${url}/pricing`, { headers: HTML, redirect: 'manual' });
  assert.equal(pricing.status, 301);
  assert.equal(pricing.headers.get('location'), '/pricing/');
  assert.match(await (await fetch(`${url}/pricing/`)).text(), /pricing page/);

  const asset = await fetch(`${url}/_astro/a.js`);
  assert.match(asset.headers.get('content-type'), /javascript/);
  assert.match(asset.headers.get('cache-control'), /immutable/);

  // The dashboard, sign-in and the bots' own files still come from the server.
  assert.match(await (await fetch(`${url}/login`)).text(), /email/i);
  assert.match(await (await fetch(`${url}/setup`)).text(), /b2b/);
  assert.equal((await fetch(`${url}/healthz`)).status, 200);

  // Nobody escapes the site folder.
  assert.notEqual((await fetch(`${url}/..%2f..%2fpackage.json`, { headers: HTML })).status, 200);

  // Unknown pages: the site's 404 for people, JSON for everyone else.
  const miss = await fetch(`${url}/nope`, { headers: HTML });
  assert.equal(miss.status, 404);
  assert.match(await miss.text(), /no bot here/);
  const api = await fetch(`${url}/v1/nope`, { headers: HTML });
  assert.equal(api.status, 404);
  assert.match(api.headers.get('content-type'), /json/);
});

test('old addresses send people to the real domain, but bots keep working there', async (t0) => {
  let relay;
  const { s, url } = await listen((req, res) => relay.handle(req, res));
  t0.after(() => s.close());
  const host = new URL(url).host;
  relay = createRelay({ adminToken: 'admin-token-for-tests-123456', publicUrl: 'https://bot2bot.example', siteDir: fakeSite(), redirectHosts: [host] });

  const page = await fetch(`${url}/app?x=1`, { headers: HTML, redirect: 'manual' });
  assert.equal(page.status, 301);
  assert.equal(page.headers.get('location'), 'https://bot2bot.example/app?x=1');

  // Bots and API clients don't ask for HTML, and the machine paths never move.
  assert.equal((await fetch(`${url}/healthz`, { redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${url}/setup`, { headers: HTML, redirect: 'manual' })).status, 200);
  assert.equal((await fetch(`${url}/v1/me`, { redirect: 'manual' })).status, 401);
});

test('docs pages come as Markdown to agents that ask for it', async (t0) => {
  let relay;
  const { s, url } = await listen((req, res) => relay.handle(req, res));
  t0.after(() => s.close());
  const dir = fakeSite();
  mkdirSync(join(dir, 'docs', 'quickstart'), { recursive: true });
  writeFileSync(join(dir, 'docs', 'index.html'), '<h1>docs home</h1>');
  writeFileSync(join(dir, 'docs', 'index.md'), '# bot2bot docs');
  writeFileSync(join(dir, 'docs', 'quickstart', 'index.html'), '<h1>Quickstart</h1>');
  writeFileSync(join(dir, 'docs', 'quickstart.md'), '# Quickstart\n\nRun join.');
  relay = createRelay({ adminToken: 'admin-token-for-tests-123456', publicUrl: url, hosted: true, siteDir: dir });

  // People get the page, with a pointer to its Markdown.
  const page = await fetch(`${url}/docs/quickstart/`, { headers: HTML });
  assert.match(await page.text(), /<h1>Quickstart/);
  assert.equal(page.headers.get('link'), '</docs/quickstart.md>; rel="alternate"; type="text/markdown"');
  assert.equal(page.headers.get('vary'), 'Accept');

  // Agents asking for Markdown get it at the same address, with or without the slash.
  for (const path of ['/docs/quickstart/', '/docs/quickstart']) {
    const md = await fetch(`${url}${path}`, { headers: { accept: 'text/markdown, text/html;q=0.8' }, redirect: 'manual' });
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-type'), /^text\/markdown/);
    assert.equal(await md.text(), '# Quickstart\n\nRun join.');
  }
  assert.equal(await (await fetch(`${url}/docs/`, { headers: { accept: 'text/markdown' } })).text(), '# bot2bot docs');
  // The .md files themselves are plain downloads.
  const direct = await fetch(`${url}/docs/quickstart.md`);
  assert.match(direct.headers.get('content-type'), /^text\/markdown/);
  // A browser that lists Markdown after HTML still gets HTML.
  assert.match(await (await fetch(`${url}/docs/quickstart/`, { headers: { accept: 'text/html, text/markdown' } })).text(), /<h1>/);
  // No escaping the site folder through the Markdown lookup.
  assert.notEqual((await fetch(`${url}/docs/..%2f..%2f..%2fpackage`, { headers: { accept: 'text/markdown' } })).status, 200);
});

test('signed in, the site says Platform: a readable b2b_in marker lives and dies with the session', async (t0) => {
  const env = await setup(t0);
  const post = (path, form, cookie = '') => fetch(env.url + path, { method: 'POST', redirect: 'manual', headers: { origin: env.url, 'content-type': 'application/x-www-form-urlencoded', ...(cookie && { cookie }) }, body: new URLSearchParams(form).toString() });
  const marker = (r) => r.headers.getSetCookie().find((c) => c.startsWith('b2b_in='));
  const jar = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const signIn = async (email) => {
    const asked = await post('/login', { email });
    return post('/login/verify', { email, code: env.mail.at(-1).text.match(/code is (\d{6})/)[1] }, jar(asked));
  };

  const signedIn = await signIn('mia@example.com');
  assert.equal(signedIn.status, 303);
  const on = marker(signedIn);
  assert.match(on, /^b2b_in=1; Path=\/; SameSite=Lax; Max-Age=2592000/, 'same life as the session');
  assert.doesNotMatch(on, /HttpOnly/, 'the site script reads it');

  const out = await post('/logout', {}, jar(signedIn));
  assert.match(marker(out), /^b2b_in=; Path=\/; SameSite=Lax; Max-Age=0/);

  // A session that ended elsewhere drops a leftover marker on the next dashboard visit.
  const stale = await fetch(env.url + '/app', { redirect: 'manual', headers: { cookie: 'b2b_in=1; b2b_session=s_gone' } });
  assert.equal(stale.status, 303);
  assert.match(marker(stale), /Max-Age=0/);
  assert.equal(marker(await fetch(env.url + '/app', { redirect: 'manual' })), undefined, 'no marker, nothing to clear');

  // Deleting the account clears it too.
  const again = await signIn('mia@example.com');
  const gone = await post('/app/account/delete', { confirm: 'mia@example.com' }, jar(again));
  assert.equal(gone.status, 200);
  assert.match(marker(gone), /Max-Age=0/);
});
