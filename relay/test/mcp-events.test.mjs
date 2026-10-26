// ChatGPT (dots, Work chats) and OpenClaw: OAuth with a resource, MCP 2.0 discovery, MCP Events with a
// verification challenge, signed wake-ups that carry no content, secret rotation, unsubscribe and clean-up.
// Plus OpenClaw's own /hooks/wake doorbell for private mode. A local receiver plays ChatGPT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { setup, login, owner, connect, listen, waitFor, sleep } from './helpers.mjs';
import { verifyWebhook, newWebhookSecret, createSafePost, isBlockedAddress } from '../doorbells.mjs';

const CHATGPT_REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const V2 = '2026-07-28';

// A pretend ChatGPT callback: checks signatures, echoes challenges, records events.
async function receiver(t0) {
  const r = { secret: null, mode: 'ok', got: [] };
  const { s, url } = await listen(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const h = req.headers;
    const rec = { path: req.url, headers: h, body, json: JSON.parse(body), signedBy: [r.secret, r.oldSecret].filter(Boolean).filter((sec) => verifyWebhook({ id: h['webhook-id'], timestamp: h['webhook-timestamp'], body, signature: h['webhook-signature'], secret: sec })) };
    r.got.push(rec);
    if (r.mode === 'fail') { res.writeHead(500); return res.end(); }
    if (r.mode === 'gone') { res.writeHead(410); return res.end(); }
    if (rec.json.type === 'verification') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ challenge: r.mode === 'wrong' ? 'nope' : rec.json.challenge }));
    }
    res.writeHead(202); res.end();
  });
  t0.after(() => s.close());
  r.url = `${url}/mcp-events/callback_123`;
  r.events = () => r.got.filter((g) => !g.json.type);
  r.challenges = () => r.got.filter((g) => g.json.type === 'verification');
  return r;
}

// ChatGPT's OAuth: dynamic registration as "ChatGPT", a resource on authorize and token, iss on the way back.
async function connectChatGPT(env, b, handle) {
  const meta = await (await fetch(`${env.url}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.authorization_response_iss_parameter_supported, true);
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [CHATGPT_REDIRECT] }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const resource = `${env.url}/mcp`;
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: CHATGPT_REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's1', resource };
  const bad = await b('/oauth/authorize', { method: 'POST', form: { ...params, resource: 'https://evil.example/mcp', bot: 'new', handle, decision: 'allow' } });
  assert.equal(new URL(bad.location).searchParams.get('error'), 'invalid_target');
  assert.equal(new URL(bad.location).searchParams.get('iss'), env.url, 'iss on errors too');
  const ok = await b('/oauth/authorize', { method: 'POST', form: { ...params, bot: 'new', handle, decision: 'allow' } });
  const loc = new URL(ok.location);
  assert.equal(loc.searchParams.get('iss'), env.url);
  const swap = (form) => fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
  assert.equal((await swap({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: CHATGPT_REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource: 'https://evil.example/mcp' })).status, 400, 'wrong resource');
  const tokens = await (await swap({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), redirect_uri: CHATGPT_REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource })).json();
  assert.ok(tokens.access_token);
  let id = 0;
  const rpc = async (method, p = {}) => {
    const r = await fetch(`${env.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', 'mcp-protocol-version': V2 },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: { ...p, _meta: { 'io.modelcontextprotocol/protocolVersion': V2 } } }) });
    return r.json();
  };
  const tool = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result;
  const botId = env.relay.db.prepare('SELECT id FROM bots WHERE handle = ?').get(handle).id;
  return { rpc, tool, botId, tokens };
}

test('ChatGPT: MCP 2.0 discovery, events with a challenge, signed wake-ups without content, rotation, unsubscribe', async (t) => {
  const env = await setup(t);
  const recv = await receiver(t);
  const ann = await owner(env, t, 'ann@example.com', 'ann');
  const mia = await login(env, 'mia@example.com');
  const gpt = await connectChatGPT(env, mia, 'mia');
  const bot = () => env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(gpt.botId);
  assert.equal(bot().platform, 'chatgpt', 'named after the app that signed in');

  // Discovery and the event catalogue.
  const disc = await gpt.rpc('server/discover');
  assert.equal(disc.result.resultType, 'complete');
  assert.ok(disc.result.supportedVersions.includes(V2));
  assert.deepEqual(disc.result.capabilities, { tools: {}, events: {} });
  const list = await gpt.rpc('events/list');
  assert.equal(list.result.resultType, 'complete');
  assert.equal(list.result.events[0].name, 'message.received');
  assert.deepEqual(list.result.events[0].delivery, ['webhook']);
  const tools = (await gpt.rpc('tools/list')).result.tools;
  assert.equal(tools.find((x) => x.name === 'get_settings').annotations.readOnlyHint, true);
  assert.equal(tools.find((x) => x.name === 'send_message').annotations.openWorldHint, true);

  // Before watching, whoami says how to start; encryption isn't offered on ChatGPT.
  assert.match((await gpt.tool('whoami')).content[0].text, /Watch bot2bot for new messages/);
  assert.match((await gpt.tool('turn_on_encryption')).content[0].text, /ChatGPT doesn't offer that yet/);

  // Bad subscriptions.
  const sub = (secret, extra = {}) => gpt.rpc('events/subscribe', { name: 'message.received', arguments: {}, delivery: { mode: 'webhook', url: recv.url, secret }, cursor: null, ...extra });
  assert.equal((await sub('whsec_short')).error.code, -32602);
  assert.equal((await gpt.rpc('events/subscribe', { name: 'nope', arguments: {}, delivery: { mode: 'webhook', url: recv.url, secret: newWebhookSecret() } })).error.code, -32023);
  recv.secret = newWebhookSecret();
  recv.mode = 'wrong';
  let r = await sub(recv.secret);
  assert.equal(r.error.code, -32015); assert.equal(r.error.data.reason, 'challenge_failed');
  recv.mode = 'fail';
  r = await sub(recv.secret);
  assert.equal(r.error.code, -32015); assert.equal(r.error.data.reason, 'http_5xx');
  assert.equal(bot().doorbell_kind, null, 'nothing turned on yet');

  // A good subscription: the challenge is signed with the new secret and echoed back.
  recv.mode = 'ok';
  const before = recv.challenges().length;
  r = await sub(recv.secret);
  assert.equal(r.result.resultType, 'complete');
  assert.match(r.result.id, /^sub_/);
  assert.equal(r.result.cursor, null); assert.equal(r.result.truncated, false);
  assert.ok(Date.parse(r.result.refreshBefore) > Date.now());
  const ch = recv.challenges().at(-1);
  assert.equal(recv.challenges().length, before + 1);
  assert.equal(ch.signedBy.length, 1, 'challenge signed with the subscription secret');
  assert.equal(ch.headers['x-mcp-subscription-id'], r.result.id);
  assert.equal(bot().doorbell_kind, 'mcp_events');
  assert.ok(bot().doorbell_verified_at);
  // Same subscription again: same ID, no second challenge.
  const again = await sub(recv.secret);
  assert.equal(again.result.id, r.result.id);
  assert.equal(recv.challenges().length, before + 1);
  assert.match((await gpt.tool('whoami')).content[0].text, /Doorbell: on: ChatGPT watching/);
  assert.match((await mia('/app/bots/' + gpt.botId)).text, /ChatGPT is watching for messages/);

  // A friend writes: ChatGPT gets one signed event with counts only, then reads the message itself.
  await connect(ann, { b: mia, botId: String(gpt.botId) }, 'Ann');
  const alias = env.relay.db.prepare('SELECT alias FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(Number(ann.botId), gpt.botId).alias;
  await ann.cli('send', alias, 'Secret dinner plan');
  const evt = await waitFor(() => recv.events().at(-1));
  assert.deepEqual(Object.keys(evt.json).sort(), ['cursor', 'data', 'eventId', 'name', 'timestamp']);
  assert.equal(evt.json.name, 'message.received');
  assert.deepEqual(evt.json.data, { pending: 1, urgent: false });
  assert.equal(evt.headers['webhook-id'], evt.json.eventId);
  assert.equal(evt.headers['x-mcp-subscription-id'], r.result.id);
  assert.equal(evt.signedBy.length, 1);
  assert.doesNotMatch(evt.body, /dinner/, 'no content in the event');
  const inbox = (await gpt.tool('check_inbox')).content[0].text;
  assert.match(inbox, /Secret dinner plan/);

  // A refresh with a new secret: both signatures for a while, so the old receiver key still checks out.
  recv.oldSecret = recv.secret; recv.secret = newWebhookSecret();
  r = await sub(recv.secret);
  assert.equal(r.result.id, again.result.id);
  await sleep(300); // past the cooldown between two wake-ups
  await gpt.tool('test_doorbell');
  const rotated = await waitFor(() => recv.events().find((e) => e !== evt && e.headers['webhook-signature'].split(' ').length === 2));
  assert.equal(rotated.signedBy.length, 2);

  // Unsubscribe: idempotent, and the doorbell goes off.
  assert.deepEqual((await gpt.rpc('events/unsubscribe', { name: 'message.received', arguments: {}, delivery: { mode: 'webhook', url: recv.url } })).result, { resultType: 'complete' });
  assert.deepEqual((await gpt.rpc('events/unsubscribe', { name: 'message.received', arguments: {}, delivery: { mode: 'webhook', url: recv.url } })).result, { resultType: 'complete' });
  assert.equal(bot().doorbell_kind, null);
  assert.equal(bot().webhook_url, null);
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM mcp_subscriptions WHERE bot_id = ? AND secret != ''").get(gpt.botId).n, 0, 'secrets wiped');

  // Watching again, then the owner stops it on the dashboard; disconnecting wipes everything too.
  recv.oldSecret = null;
  await sub(recv.secret);
  assert.equal(bot().doorbell_kind, 'mcp_events');
  await mia(`/app/bots/${gpt.botId}/doorbell/off`, { method: 'POST' });
  assert.equal(bot().doorbell_kind, null);
  await sub(recv.secret);
  await mia(`/app/bots/${gpt.botId}/disconnect`, { method: 'POST' });
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM mcp_subscriptions WHERE bot_id = ? AND revoked_at IS NULL').get(gpt.botId).n, 0);
});

test('callbacks only go to public HTTPS: private addresses, plain http and DNS tricks are refused', async () => {
  for (const a of ['127.0.0.1', '10.0.0.1', '172.16.5.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00:ec2::254', '::ffff:10.0.0.1', '0.0.0.0']) assert.ok(isBlockedAddress(a), a);
  for (const a of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.equal(isBlockedAddress(a), false, a);
  const post = createSafePost({ lookup: (h, o, cb) => cb(null, [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]) });
  await assert.rejects(post('https://rebind.example/cb', {}), (e) => e.code === 'blocked');
  await assert.rejects(post('http://example.com/cb', {}), (e) => e.code === 'bad_url');
  await assert.rejects(post('https://example.com:8443/cb', {}), (e) => e.code === 'bad_url');
  await assert.rejects(post('https://user:pw@example.com/cb', {}), (e) => e.code === 'bad_url');
});

test('OpenClaw: a private-mode bot rings its gateway\'s /hooks/wake with its hook token, nothing else', async (t) => {
  const env = await setup(t);
  const got = [];
  const { s, url } = await listen(async (req, res) => { let body = ''; for await (const c of req) body += c; got.push({ path: req.url, auth: req.headers.authorization, json: JSON.parse(body) }); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"eventOutcome":"queued"}'); });
  t.after(() => s.close());
  const claw = await owner(env, t, 'oc@example.com', 'claw');
  // Only a /hooks/wake address counts as an OpenClaw doorbell; other hosts still have to be a Grok routine.
  await assert.rejects(claw.cli('doorbell', 'set', 'https://gateway.example/hooks/agent', '--key', 'hook-token-123456'), /webhook host must be one of/);
  await claw.cli('doorbell', 'set', `${url}/hooks/wake`, '--key', 'hook-token-123456');
  assert.equal(env.relay.db.prepare('SELECT doorbell_kind FROM bots WHERE handle = ?').get('claw').doorbell_kind, 'hook');
  await claw.cli('doorbell', 'test');
  const ring = await waitFor(() => got.at(-1));
  assert.equal(ring.path, '/hooks/wake');
  assert.equal(ring.auth, 'Bearer hook-token-123456');
  assert.equal(ring.json.mode, 'now');
  assert.match(ring.json.text, /bot2bot: messages from a friend's bot may be waiting/);
  assert.equal(ring.json.event, 'b2b_pending');
});
