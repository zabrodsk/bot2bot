// Shared test helpers: a relay on a random port with a movable clock, a cookie-keeping browser,
// owners with a real CLI bot and a fake doorbell routine, and web-link connections.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
        const acks = [...out.matchAll(/b2b\.mjs ack (msg_[\w~-]+)/g)];
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
export async function connect(a, b, aliasForA, { web = false } = {}) {
  const link = (await a.b('/app/invites', { method: 'POST', form: { bot: a.botId } })).text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await b.b(`/i/${link}`, { method: 'POST', form: web ? { web: '1', alias: aliasForA } : { bot: b.botId, alias: aliasForA } });
}
export const msgId = (out) => out.match(/Sent (msg_[\w-]+)/)[1];
