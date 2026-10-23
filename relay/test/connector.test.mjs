// 0.12: bot2bot as a GrokBot connected app (MCP + OAuth), private mode over stdio (`b2b mcp`), and both
// kinds of bots talking to each other with honest labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setup, owner, login, waitFor, msgId } from './helpers.mjs';
import { TOOLS } from '../connector.mjs';

const REDIRECT = 'https://grok.example/oauth/callback';

// The OAuth dance a connected app does: register, send the person to sign in and approve, swap the code.
async function connectApp(env, b, handle) {
  const meta = await (await fetch(`${env.url}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Grok Bot', redirect_uris: [REDIRECT] }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'xyz' };
  const consent = await b(`/oauth/authorize?${new URLSearchParams(params)}`);
  assert.match(consent.text, /Connect Grok Bot to bot2bot[^]*not end-to-end encrypted/);
  const ok = await b('/oauth/authorize', { method: 'POST', form: { ...params, bot: 'new', handle, decision: 'allow' } });
  const loc = new URL(ok.location);
  assert.equal(loc.searchParams.get('state'), 'xyz');
  const swap = (form) => fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  assert.equal((await swap({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: 'x'.repeat(43) })).status, 400, 'wrong verifier');
  const tokens = await (await swap({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier })).json();
  assert.ok(tokens.access_token && tokens.refresh_token);
  let id = 0;
  const rpc = async (method, params_ = {}, token = tokens.access_token) => {
    const r = await fetch(`${env.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params_ }) });
    return { status: r.status, body: r.status === 200 ? await r.json() : null, headers: r.headers };
  };
  const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).body.result;
  return { tokens, rpc, tool, swap, clientId: reg.client_id };
}

test('connected app: sign in with OAuth, tools over MCP, chat with a private-mode bot', async (t0) => {
  const env = await setup(t0);
  // No token: the client is told where to sign in.
  const anon = await fetch(`${env.url}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);

  const mia = { b: await login(env, 'mia@example.com') };
  // A new person sees two ways in; quick connect is one message to paste into their bot.
  const first = (await mia.b('/app')).text;
  assert.match(first, /Quick connect[^]*Add the custom MCP connector http:\/\/127\.0\.0\.1:\d+\/mcp[^]*Private/);
  const app = await connectApp(env, mia.b, 'mia-bot');
  // Right after connecting, the bot is told its next step: make its own doorbell routine.
  assert.match((await app.tool('whoami')).content[0].text, /NEXT STEP: Make yourself a routine called "b2b doorbell"/);
  // Saving the doorbell on the bot page rings the bot straight away.
  const botId = (await mia.b('/app')).text.match(/\/app\/bots\/(\d+)/)[1];
  const saved = await mia.b(`/app/bots/${botId}/doorbell`, { method: 'POST', form: { url: `${env.url}/automations/webhook/9`, key: 'k-12345678' } });
  assert.equal(saved.location, `/app/bots/${botId}?ring=1`);
  const init = await app.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.body.result.serverInfo.name, 'bot2bot');
  assert.deepEqual((await app.rpc('tools/list')).body.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.match((await app.tool('whoami')).content[0].text, /@mia-bot[^]*NOT end-to-end encrypted/);

  // Ben (private mode) and Mia's connected-app bot become contacts through a link Mia's bot makes.
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const link = (await app.tool('invite', { name: 'Ben' })).content[0].text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await ben.b(`/i/${link}`, { method: 'POST', form: { bot: ben.botId, alias: 'Mia' } });
  const peer = (await mia.b('/app')).text.match(/action="\/app\/contacts\/approve"><input type="hidden" name="bot" value="(\d+)"><input type="hidden" name="peer" value="(\d+)"/);
  await mia.b('/app/contacts/approve', { method: 'POST', form: { bot: peer[1], peer: peer[2] } });
  assert.match((await app.tool('list_contacts')).content[0].text, /Ben .*connected/);
  assert.match(await ben.cli('contacts'), /connected app: NOT end-to-end encrypted/);
  assert.match((await ben.b('/app')).text, /Connected app · not end-to-end encrypted/);

  // Ben's bot sends plain text (and says so); Mia's bot reads it through check_inbox and confirms.
  const sent = await ben.cli('send', 'Mia', 'Lunch Sunday?', '--choice', 'Yes', '--choice', 'No');
  assert.match(sent, /Not end-to-end encrypted: their bot uses the bot2bot connected app/);
  const inbox = (await app.tool('check_inbox')).content[0].text;
  assert.match(inbox, /QUESTION[^]*<<<\nLunch Sunday\?\n>>>[^]*answer options: "Yes" \/ "No"/);
  const receipt = inbox.match(/receipt=(msg_[\w~-]+)/)[1];
  assert.match((await app.tool('mark_delivered', { receipt })).content[0].text, /delivered/);
  await waitFor(async () => /passed_on/.test(await ben.cli('status', msgId(sent))));
  await app.tool('reply', { message_id: msgId(sent), text: 'Yes!' });
  assert.match(await ben.cli('status', msgId(sent)), /reply .*: Yes!/);

  // Ask their bot works in plain text too: Mia allows "availability"; Ben's bot asks; Mia's bot may answer itself.
  await app.tool('allow_topics', { contact: 'Ben', topics: ['availability'] });
  const q = msgId(await ben.cli('send', 'Mia', 'Free Friday?', '--topic', 'availability'));
  const inbox2 = (await app.tool('check_inbox')).content[0].text;
  assert.match(inbox2, /You may answer this yourself/);
  await app.tool('reply', { message_id: q, text: 'Friday after 6', auto: true });
  assert.match(await ben.cli('status', q), /answered by their bot on its own\): Friday after 6/);
});

test('connected app: refresh tokens rotate, and disconnecting revokes everything', async (t0) => {
  const env = await setup(t0);
  const mia = { b: await login(env, 'mia@example.com') };
  const app = await connectApp(env, mia.b, 'mia-bot');
  const fresh = await (await app.swap({ grant_type: 'refresh_token', refresh_token: app.tokens.refresh_token, client_id: app.clientId })).json();
  assert.ok(fresh.access_token);
  assert.equal((await app.swap({ grant_type: 'refresh_token', refresh_token: app.tokens.refresh_token, client_id: app.clientId })).status, 400, 'old refresh token is used up');
  assert.equal((await app.rpc('ping', {}, fresh.access_token)).status, 200);
  const botId = (await mia.b('/app')).text.match(/\/app\/bots\/(\d+)/)[1];
  await mia.b(`/app/bots/${botId}/disconnect`, { method: 'POST' });
  assert.equal((await app.rpc('ping', {}, fresh.access_token)).status, 401);
  assert.equal((await app.swap({ grant_type: 'refresh_token', refresh_token: fresh.refresh_token, client_id: app.clientId })).status, 400);
});

test('private mode: `b2b mcp` serves the same tools over stdio, still end-to-end encrypted', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  const link = (await ben.b('/app/invites', { method: 'POST', form: { bot: ben.botId } })).text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await anna.b(`/i/${link}`, { method: 'POST', form: { bot: anna.botId, alias: 'Ben' } });
  const ch = spawn(process.execPath, [join(import.meta.dirname, '..', 'cli', 'b2b.mjs'), 'mcp'], { env: { ...process.env, B2B_HOME: ben.home } });
  t0.after(() => ch.kill());
  let buf = ''; const waiting = new Map();
  ch.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  let id = 0;
  const rpc = (method, params = {}) => new Promise((ok) => { const n = ++id; waiting.set(n, ok); ch.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.serverInfo.name, 'bot2bot');
  const tools = (await rpc('tools/list')).result.tools;
  assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name), 'same tools as the connected app');
  assert.deepEqual(tools.map((t) => Object.keys(t.inputSchema.properties).sort()), TOOLS.map((t) => Object.keys(t.inputSchema.properties).sort()));
  const r = await rpc('tools/call', { name: 'send_message', arguments: { to: 'Anna', text: 'Sealed hello' } });
  assert.match(r.result.content[0].text, /End-to-end encrypted: only their bot can read it/);
  const row = env.relay.db.prepare("SELECT text, sealed FROM messages WHERE kind = 'note' ORDER BY created_at DESC").get();
  assert.equal(row.text, ''); assert.ok(row.sealed);
});
