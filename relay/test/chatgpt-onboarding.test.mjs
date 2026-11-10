import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { setup, browser, login, connectApp } from './helpers.mjs';

test('ChatGPT setup is public, does not start sign-in, and keeps invite context without accepting it', async (t) => {
  const env = await setup(t);
  const anon = browser(env.url);
  const guide = await anon('/connect/chatgpt?invite=TEST-ABCD');
  assert.equal(guide.status, 200);
  assert.match(guide.text, /href="https:\/\/chatgpt.com\/plugins"/);
  assert.match(guide.text, new RegExp(`${env.url}/mcp`));
  assert.match(guide.text, /Only say I am connected if that call succeeds/);
  assert.match(guide.text, /After the connection check succeeds, turn on end-to-end encryption: I say yes to it\. Call bot2bot's turn_on_encryption tool[^]*stay on quick connect, which isn't end-to-end encrypted\.\nThen watch bot2bot/);
  assert.match(guide.text, /Report the connection, encryption and watching status separately/);
  assert.match(guide.text, /href="\/i\/TEST-ABCD"/);
  assert.match(guide.text, /finish accepting my invite/);
  assert.doesNotMatch(guide.text, /<form|client_id=|code_challenge=/);
  assert.equal(env.mail.length, 0);
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM bots').get().n, 0);
  const badInvite = (await anon('/connect/chatgpt?invite=%22%3E%3Cscript%3Ebad-invite')).text;
  assert.doesNotMatch(badInvite, /bad-invite|finish accepting my invite/);
  const cz = await browser(env.url, { 'accept-language': 'cs' })('/connect/chatgpt');
  assert.match(cz.text, /<html lang="cs">[^]*Otevřít Plugins v ChatGPT/);

  const owner = await login(env, 'owner@example.com');
  // A new person picks OpenAI dots, names it, and its page leads to the ChatGPT guide.
  assert.match((await owner('/app')).text, /href="\/app\/bots\/add\/dots"/);
  await owner('/app/bots/add/dots', { method: 'POST', form: { handle: 'test-dot' } });
  const choices = await owner('/app/bots/add/dots/steps');
  assert.match(choices.text, /href="\/connect\/chatgpt"/);
  assert.doesNotMatch(choices.text, /Add the custom MCP connector[^<]*sign me in/);
  await connectApp(env, owner, 'test-dot', 'ChatGPT');
  assert.equal((await owner('/connect/chatgpt')).status, 200, 'the same guide also works after connecting');
});

test('incomplete or unregistered authorization links offer recovery without redirecting', async (t) => {
  const env = await setup(t);
  for (const path of ['/oauth/authorize', '/oauth/authorize?client_id=missing&redirect_uri=https://evil.example']) {
    const r = await browser(env.url)(path);
    assert.equal(r.status, 400);
    assert.equal(r.location, null);
    assert.match(r.text, /Start the connection again[^]*href="\/connect\/chatgpt"/);
    assert.doesNotMatch(r.text, /href="https:\/\/evil.example/);
  }
});

test('ChatGPT authorization survives owner sign-in and verifies with a real local tool call', async (t) => {
  const env = await setup(t);
  const b = browser(env.url);
  const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const registration = await fetch(`${env.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [callback] }) });
  const client = await registration.json();
  const verifier = randomBytes(32).toString('base64url');
  const params = { response_type: 'code', client_id: client.client_id, redirect_uri: callback, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'local-test-state', resource: `${env.url}/mcp` };
  const authorize = `/oauth/authorize?${new URLSearchParams(params)}`;
  const start = await b(authorize);
  assert.equal(start.status, 303);
  const next = new URL(start.location, env.url).searchParams.get('next');
  assert.equal(new URL(next, env.url).pathname, '/oauth/authorize');
  const kept = new URL(next, env.url).searchParams;
  for (const [key, value] of Object.entries(params)) assert.equal(kept.get(key), value);
  await b('/login', { method: 'POST', form: { email: 'test@example.com', next } });
  const code = env.mail.at(-1).text.match(/code is (\d{6})/)[1];
  const signedIn = await b('/login/verify', { method: 'POST', form: { email: 'test@example.com', code, next } });
  assert.equal(signedIn.location, next);
  const consent = await b(next);
  assert.equal(consent.status, 200);
  assert.match(consent.text, /name="state" value="local-test-state"/);
  const approved = await b('/oauth/authorize', { method: 'POST', form: { ...params, decision: 'allow', bot: 'new', handle: 'test-chatgpt' } });
  const returned = new URL(approved.location);
  assert.equal(returned.origin + returned.pathname, callback);
  assert.equal(returned.searchParams.get('state'), params.state);
  const exchanged = await fetch(`${env.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code: returned.searchParams.get('code'), redirect_uri: callback, code_verifier: verifier, resource: params.resource }) });
  const tokens = await exchanged.json();
  assert.ok(tokens.access_token);
  const check = await fetch(`${env.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }) });
  assert.equal(check.status, 200);
  assert.match((await check.json()).result.content[0].text, /@test-chatgpt/);
});
