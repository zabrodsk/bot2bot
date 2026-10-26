// Shared test helpers: a relay on a random port with a movable clock, a cookie-keeping browser,
// owners with a real CLI bot and a fake doorbell routine, and web-link connections.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createRelay } from '../server.mjs';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'b2b.mjs');
export const ADMIN = 'admin-token-for-tests-123456';
export const listen = (h) => new Promise((ok) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('timed out');
};

export async function setup(t0, opts = {}) {
  const mail = [];
  let offset = 0;
  let relay;
  const { s, url } = await listen((req, res) => relay.handle(req, res));
  const mailer = opts.mailer ?? (async (m) => { mail.push(m); });
  relay = createRelay({ ...opts, adminToken: ADMIN, allowLocalWebhooks: true, publicUrl: url, clock: () => Date.now() + offset,
    limits: { ringFloorMs: 200, urgentFloorMs: 100, ...opts.limits }, mailer: async (m) => { if (/login code/.test(m.subject)) mail.push(m); else await mailer(m); } });
  const timer = setInterval(() => relay.tick().catch(() => {}), 100);
  t0.after(() => { clearInterval(timer); s.close(); });
  return { relay, url, mail, advance: (ms) => { offset += ms; }, now: () => Date.now() + offset };
}

export function browser(base, headers0 = {}) {
  const jar = {};
  return async (path, { method = 'GET', form } = {}) => {
    const headers = { origin: base, ...headers0 };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    for (const sc of r.headers.getSetCookie?.() ?? []) { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = await r.text();
    return { status: r.status, location: r.headers.get('location'), text, json: () => JSON.parse(text) };
  };
}

export async function login(env, email) {
  const b = browser(env.url);
  await b('/login', { method: 'POST', form: { email } });
  await b('/login/verify', { method: 'POST', form: { email, code: env.mail.filter((m) => m.to === email).at(-1).text.match(/code is (\d{6})/)[1] } });
  await b('/app/picture', { method: 'POST', form: { avatar: 'classic' } });
  b.env = env;
  return b;
}

export function cliHome() {
  const home = mkdtempSync(join(tmpdir(), 'b2b-t-'));
  const cli = async (...a) => (await run(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: home } })).stdout;
  return { home, cli };
}

// A person with a connected bot whose fake routine reads the inbox and acks when rung.
export async function owner(env, t0, email, handle, { status = 200 } = {}) {
  const b = await login(env, email);
  await b('/app/bots', { method: 'POST', form: { handle } });
  const { cli, home } = cliHome();
  await cli('enroll', env.url, (await b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]);
  const botId = (await b('/app')).text.match(/\/app\/bots\/(\d+)/)[1];
  const rings = [];
  const routine = { status };
  const { s, url } = await listen(async (req, res) => {
    rings.push(Date.now());
    res.writeHead(routine.status).end('{}');
    if (routine.status !== 200) return;
    try {
      for (let i = 0; i < 4; i++) {
        const out = await cli('inbox', '--via', 'doorbell');
        const acks = [...out.matchAll(/^[^|\n].*b2b\.mjs ack (msg_[\w~-]+)$/gm)];
        if (!acks.length) break;
        for (const m of acks) await cli('ack', m[1]);
      }
    } catch { /* relay closed */ }
  });
  t0.after(() => s.close());
  await b(`/app/bots/${botId}/doorbell`, { method: 'POST', form: { url: `${url}/automations/webhook/1`, key: 'k-12345678' } });
  const token = JSON.parse((await import('node:fs')).readFileSync(join(home, 'config.json'), 'utf8')).token;
  const api = async (method, path, body) => {
    const r = await fetch(env.url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  return { b, cli, home, botId, rings, routine, api };
}

// Both people say yes through the invite link.
// Both sides start "not sorted yet" unless a basket is passed (the dashboard's own default is friends).
export async function connect(a, b, aliasForA, { web = false, basket = '' } = {}) {
  const link = (await a.b('/app/invites', { method: 'POST', form: { bot: a.botId, basket } })).text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await b.b(`/i/${link}`, { method: 'POST', form: web ? { web: '1', alias: aliasForA } : { bot: b.botId, alias: aliasForA } });
  return link;
}
export const msgId = (out) => out.match(/Sent (msg_[\w-]+)/)[1];

export const REDIRECT = 'https://grok.example/oauth/callback';

// The OAuth dance a connected app does: register, send the person to sign in and approve, swap the code.
export async function connectApp(env, b, handle) {
  const meta = await (await fetch(`${env.url}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Grok Bot', redirect_uris: [REDIRECT] }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'xyz' };
  const consent = await b(`/oauth/authorize?${new URLSearchParams(params)}`);
  assert.match(consent.text, /Connect your bot to bot2bot[^]*Requested by the app "Grok Bot"[^]*not end-to-end encrypted/);
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

// Pre-governance gate/privacy tests assume autonomous sends until their explicit privacy switch.
// Give those fixtures a real owner-selected basket under the new pilot defaults.
export async function connectHandled(a, b, ...args) {
  const link = await connect(a, b, ...args);
  const relay = a.b.env.relay;
  const peerId = relay.db.prepare('SELECT used_by FROM invites WHERE code_hash = ?').get(createHash('sha256').update(link).digest('hex')).used_by;
  for (const id of [Number(a.botId), b.botId ? Number(b.botId) : peerId]) {
    if (!relay.inPilot(id)) continue;
    const friends = relay.getSettings(id).circles.find((c) => c.name === 'friends');
    const other = id === Number(a.botId) ? (b.botId ? Number(b.botId) : peerId) : Number(a.botId);
    relay.applyOwnerOps(id, [{ op: 'move', contact: other, circle: friends.id }]);
  }
}
