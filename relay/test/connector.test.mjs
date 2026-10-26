// 0.12: bot2bot as a GrokBot connected app (MCP + OAuth), private mode over stdio (`b2b mcp`), and both
// kinds of bots talking to each other with honest labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { setup, owner, login, waitFor, msgId, listen, cliHome, sleep, connectApp, REDIRECT } from './helpers.mjs';
import { TOOLS, ENCRYPTION_MESSAGE } from '../connector.mjs';

test('connected app: sign in with OAuth, tools over MCP, chat with a private-mode bot', async (t0) => {
  const env = await setup(t0);
  // No token: the client is told where to sign in.
  const anon = await fetch(`${env.url}/mcp`, { method: 'POST', body: '{}' });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource"/);

  const mia = { b: await login(env, 'mia@example.com') };
  // A new person sees the setup bot, then one private-mode message to paste; quick connect is the fallback.
  const first = (await mia.b('/app')).text;
  assert.match(first, /Add the setup bot[^]*private mode \(end-to-end encrypted\)[^]*b2b\.mjs join http:\/\/127\.0\.0\.1:\d+[^]*Quick connect[^]*Add the custom MCP connector http:\/\/127\.0\.0\.1:\d+\/mcp/);
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
  assert.match(inbox, /QUESTION[^]*\[(\w{4}) start\]\n\| Lunch Sunday\?\n\[\1 end\][^]*answer options: "Yes" \/ "No"/);
  const receipt = inbox.match(/receipt=(msg_[\w~-]+)/)[1];
  assert.match((await app.tool('mark_delivered', { receipt })).content[0].text, /delivered/);
  await waitFor(async () => /passed_on/.test(await ben.cli('status', msgId(sent))));
  await app.tool('reply', { message_id: msgId(sent), text: 'Yes!' });
  assert.match(await ben.cli('status', msgId(sent)), /reply \([^)]*\), written by their bot[^]*\n\| Yes!/);

  // Ask their bot works in plain text too: Mia allows "availability"; Ben's bot asks; Mia's bot may answer itself.
  await app.tool('allow_topics', { contact: 'Ben', topics: ['availability'] });
  const q = msgId(await ben.cli('send', 'Mia', 'Free Friday?', '--topic', 'availability'));
  const inbox2 = (await app.tool('check_inbox')).content[0].text;
  assert.match(inbox2, /You may answer this yourself/);
  await app.tool('reply', { message_id: q, text: 'Friday after 6', auto: true });
  assert.match(await ben.cli('status', q), /their bot says it answered on its own\), written by their bot[^]*\n\| Friday after 6/);
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

test('quick connect → private mode: one yes, same name and contacts, encrypted from then on', async (t0) => {
  const env = await setup(t0);
  const mia = { b: await login(env, 'mia@example.com') };
  const app = await connectApp(env, mia.b, 'mia-bot');
  const botId = (await mia.b('/app')).text.match(/\/app\/bots\/(\d+)/)[1];
  // Mia's doorbell routine: through the app before the switch, through the tool after. "off" = rung but asleep.
  const { cli } = cliHome();
  const routine = { mode: 'app', seen: [] };
  const { s, url } = await listen(async (req, res) => {
    res.writeHead(200).end('{}');
    try {
      for (let i = 0; i < 4; i++) {
        if (routine.mode === 'app') {
          const out = (await app.tool('check_inbox')).content[0].text; routine.seen.push(out);
          const receipts = [...out.matchAll(/receipt=(msg_[\w~-]+)/g)];
          if (!receipts.length) break;
          for (const r of receipts) await app.tool('mark_delivered', { receipt: r[1] });
        } else if (routine.mode === 'cli') {
          const out = await cli('inbox', '--via', 'doorbell'); routine.seen.push(out);
          const acks = [...out.matchAll(/^[^|\n].*b2b\.mjs ack (msg_[\w~-]+)$/gm)];
          if (!acks.length) break;
          for (const m of acks) await cli('ack', m[1]);
        }
      }
    } catch { /* relay closed */ }
  });
  t0.after(() => s.close());
  await mia.b(`/app/bots/${botId}/doorbell`, { method: 'POST', form: { url: `${url}/automations/webhook/7`, key: 'k-12345678' } });
  await app.tool('test_doorbell');
  await waitFor(async () => /Doorbell: working/.test((await app.tool('whoami')).content[0].text));

  // Ben (private mode) and Mia become contacts. Setup is done, so Mia's bot offers encryption.
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const link = (await app.tool('invite', { name: 'Ben' })).content[0].text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await ben.b(`/i/${link}`, { method: 'POST', form: { bot: ben.botId, alias: 'Mia' } });
  const peer = (await mia.b('/app')).text.match(/action="\/app\/contacts\/approve"><input type="hidden" name="bot" value="(\d+)"><input type="hidden" name="peer" value="(\d+)"/);
  await mia.b('/app/contacts/approve', { method: 'POST', form: { bot: peer[1], peer: peer[2] } });
  assert.match((await app.tool('whoami')).content[0].text, /NEXT STEP: If you haven't asked your owner yet[^]*Want end-to-end encryption[^]*Only if they say yes, call turn_on_encryption/);
  assert.match((await app.tool('whoami')).content[0].text, /anything on their dashboard [^]* they can just tell you/);
  const page = (await mia.b(`/app/bots/${botId}`)).text;
  assert.match(page, /Turn on end-to-end encryption/);
  assert.ok(page.includes(ENCRYPTION_MESSAGE.replaceAll("'", '&#39;')) || page.includes(ENCRYPTION_MESSAGE), 'the dashboard gives the message to paste');

  // A plain-text message is still waiting when Mia's bot switches. It isn't lost.
  routine.mode = 'off';
  await ben.cli('send', 'Mia', 'Sent before the switch');

  const steps = (await app.tool('turn_on_encryption')).content[0].text;
  const code = steps.match(/b2b\.mjs enroll \S+ ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  assert.match(steps, /Keep the same routine and its webhook[^]*-----\nb2b messages may be waiting[^]*inbox --via doorbell[^]*\n-----/);
  // On a computer where another bot already uses private mode, the switch refuses instead of taking it over,
  // the code still works, and it says how to use a folder of its own.
  await assert.rejects(ben.cli('enroll', env.url, code), /already has a bot2bot connection, @ben[^]*B2B_HOME=/);
  assert.match(await ben.cli('whoami'), /@ben /);
  assert.match(steps, /If it says this computer already has a bot2bot connection[^]*B2B_HOME=~\/\.b2b-mia-bot/);
  assert.match(await cli('enroll', env.url, code), /Enrolled as @mia-bot/);
  assert.match(await cli('whoami'), /Encryption: on/);
  await assert.rejects(cli('enroll', env.url, code, '--again'), /invalid, used or expired/, 'the code works once');

  // The app's sign-in is over: nothing can go out in plain text that way any more.
  assert.equal((await app.rpc('ping')).status, 401);
  assert.equal((await app.swap({ grant_type: 'refresh_token', refresh_token: app.tokens.refresh_token, client_id: app.clientId })).status, 400);

  // Same doorbell, new instruction: the test passes without Mia pasting the key again, and the waiting message arrives.
  routine.mode = 'cli';
  // (A test ring right after another ring is skipped by the cooldown, so ring again until it lands.)
  await waitFor(async () => {
    if (/Doorbell: verified/.test(await cli('whoami'))) return true;
    await cli('doorbell', 'test'); await sleep(300); return false;
  });
  await waitFor(async () => routine.seen.some((o) => o.includes('Sent before the switch')));

  // Ben's bot just starts encrypting: no new-key alarm, because it never had keys for Mia's bot.
  assert.doesNotMatch(await ben.cli('contacts'), /NEW KEY|connected app/);
  const sent = await ben.cli('send', 'Mia', 'Sealed after the switch');
  assert.match(sent, /End-to-end encrypted: only their bot can read it/);
  await waitFor(async () => routine.seen.some((o) => o.includes('Sealed after the switch')));
  const row = env.relay.db.prepare('SELECT sealed, text FROM messages WHERE id = ?').get(msgId(sent));
  assert.ok(row.sealed && !row.text, 'the relay only ever held the sealed message');
  assert.match(await cli('contacts'), /Ben .*end-to-end encrypted/);

  // The dashboard agrees, and the offer is gone.
  const after = (await mia.b('/app')).text;
  assert.match(after, /Private mode/);
  assert.doesNotMatch((await mia.b(`/app/bots/${botId}`)).text, /Turn on end-to-end encryption/);
});

test('connected app: app registrations are limited per address, and unused ones are cleared', async (t0) => {
  const env = await setup(t0, { limits: { oauthRegisterPerIpPerHour: 3 } });
  const reg = () => fetch(`${env.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'x', redirect_uris: [REDIRECT] }) });
  for (let i = 0; i < 3; i++) assert.equal((await reg()).status, 201);
  const r = await reg();
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error, 'too_many_requests');
  env.advance(3_600_001);
  assert.equal((await reg()).status, 201, 'the limit is per hour');
  env.advance(8 * 86_400_000);
  env.relay.retention(env.now());
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM oauth_clients').get().n, 0, 'registrations that never signed anyone in are cleared after a week');
});

test('connected app consent: a new bot by default, a disconnected bot when one waits to come back', async (t0) => {
  const env = await setup(t0);
  const mia = { b: await login(env, 'mia@example.com') };
  await connectApp(env, mia.b, 'mia-bot');
  const meta = await (await fetch(`${env.url}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Cursor', redirect_uris: [REDIRECT] }) })).json();
  const consent = async () => (await mia.b(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', state: 's' })}`)).text;
  // An existing bot is never pre-picked: signing in again makes a new bot unless the person chooses otherwise.
  let page = await consent();
  assert.match(page, /Connect your bot to bot2bot[^]*Requested by the app "Cursor"/);
  assert.match(page, /<option value="new" selected>A new bot<\/option><option value="\d+">@mia-bot<\/option>/);
  assert.match(page, /<label id="newname">Name for the new bot/);
  // Once that bot is disconnected, it's the one waiting to come back, so it's pre-picked and the name field hides.
  const botId = (await mia.b('/app')).text.match(/\/app\/bots\/(\d+)/)[1];
  await mia.b(`/app/bots/${botId}/disconnect`, { method: 'POST' });
  page = await consent();
  assert.match(page, /<option value="new">A new bot<\/option><option value="\d+" selected>@mia-bot \(reconnect\)<\/option>/);
  assert.match(page, /<label id="newname" hidden>/);
});
