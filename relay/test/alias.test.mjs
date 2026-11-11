// The site moved from www.bot2bot.link to bot2bot.link. Apps connected on the old address, and sign-ins started
// there, keep working: the old host is an alias (ALIAS_URLS) that answers with its own address.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelay } from '../server.mjs';
import { listen, browser, REDIRECT } from './helpers.mjs';

const ADMIN = 'admin-token-for-tests-123456';

test('an app connected on the old www address keeps working after the move', async (t0) => {
  let relay;
  const { s, url: old } = await listen((req, res) => relay.handle(req, res));
  t0.after(() => s.close());
  const dbPath = join(mkdtempSync(join(tmpdir(), 'b2b-alias-')), 'relay.db');
  const mail = [];
  const mailer = async (m) => { mail.push(m); };

  // Before: the old address is the public one. Mia connects a chat app with a token bound to its /mcp.
  relay = createRelay({ adminToken: ADMIN, dbPath, publicUrl: old, mailer });
  const b = browser(old);
  await b('/login', { method: 'POST', form: { email: 'mia@example.com' } });
  await b('/login/verify', { method: 'POST', form: { email: 'mia@example.com', code: mail.at(-1).text.match(/code is (\d{6})/)[1] } });
  const reg = await (await fetch(`${old}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [REDIRECT] }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's', resource: `${old}/mcp` };
  const ok = await b('/oauth/authorize', { method: 'POST', form: { ...params, bot: 'new', handle: 'mia-dot', decision: 'allow' } });
  const code = new URL(ok.location).searchParams.get('code');
  const tokens = await (await fetch(`${old}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: `${old}/mcp` }) })).json();
  assert.ok(tokens.access_token);

  // After: bot2bot.example is the public address and the old one is an alias that only moves the site's pages.
  relay = createRelay({ adminToken: ADMIN, dbPath, publicUrl: 'https://bot2bot.example', aliasUrls: [old], redirectHosts: [new URL(old).host], mailer });
  const mcp = (token) => fetch(`${old}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal((await mcp(tokens.access_token)).status, 200, 'the old token still works');
  const refreshed = await (await fetch(`${old}/oauth/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id, resource: `${old}/mcp` }) })).json();
  assert.equal((await mcp(refreshed.access_token)).status, 200, 'and so does a refreshed one');

  // The app is told about the address it called, never the new one it didn't discover.
  const meta = await (await fetch(`${old}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.issuer, old);
  assert.equal(meta.token_endpoint, `${old}/oauth/token`);
  assert.equal((await (await fetch(`${old}/.well-known/oauth-protected-resource`)).json()).resource, `${old}/mcp`);
  assert.equal((await (await fetch(`${old}/.well-known/oauth-protected-resource/send`)).json()).resource, `${old}/send`);
  assert.match((await mcp('nope')).headers.get('www-authenticate'), new RegExp(`resource_metadata="${old}/`));

  // Signing in again on the old address finishes there: the form passes the same-origin check, the emailed link
  // points back to it, and consent sends the app the old issuer.
  const again = browser(old);
  assert.equal((await again('/login', { method: 'POST', form: { email: 'mia@example.com' } })).status, 200);
  assert.ok(mail.at(-1).text.includes(`${old}/login/link?t=`));
  await again('/login/verify', { method: 'POST', form: { email: 'mia@example.com', code: mail.at(-1).text.match(/code is (\d{6})/)[1] } });
  const consent = await again(`/oauth/authorize?${new URLSearchParams(params)}`);
  assert.equal(consent.status, 200);
  const allowed = await again('/oauth/authorize', { method: 'POST', form: { ...params, bot: 'new', handle: 'mia-dot-2', decision: 'allow' } });
  assert.equal(new URL(allowed.location).searchParams.get('iss'), old);

  // The site's pages move to the new address; sign-in and the dashboard stay on the old one.
  const html = { accept: 'text/html' };
  const page = await fetch(`${old}/pricing/`, { headers: html, redirect: 'manual' });
  assert.equal(page.status, 301);
  assert.equal(page.headers.get('location'), 'https://bot2bot.example/pricing/');
  for (const path of ['/login', '/app', '/connect/chatgpt']) assert.notEqual((await fetch(`${old}${path}`, { headers: html, redirect: 'manual' })).status, 301, path);
});
