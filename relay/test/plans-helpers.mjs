// Helpers for the plan tests: a relay with a fake Stripe, owners with a real CLI bot and a doorbell that reads the inbox.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { createRelay } from '../server.mjs';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'b2b.mjs');
export const listen = (h) => new Promise((ok) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('timed out');
};
export const SECRET = 'whsec_test_secret';

export function browser(base) {
  let cookie = '';
  return async (path, { method = 'GET', form } = {}) => {
    const headers = { origin: base };
    if (cookie) headers.cookie = cookie;
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  };
}

export async function setup(t0, opts) {
  const mail = []; const stripeCalls = [];
  let offset = 0; let relay;
  const { s, url } = await listen((req, res) => relay.handle(req, res));
  // Stripe is faked; doorbell rings go to the local fake routines.
  const fetchImpl = async (u, init) => {
    if (String(u).startsWith('https://api.stripe.com/')) { stripeCalls.push(Object.fromEntries(new URLSearchParams(String(init.body)))); return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), { status: 200 }); }
    return fetch(u, init);
  };
  relay = createRelay({ adminToken: 'admin-token-for-tests-123456', allowLocalWebhooks: true, publicUrl: url, clock: () => Date.now() + offset, fetchImpl,
    mailer: async (m) => { mail.push(m); }, limits: { ringFloorMs: 200, urgentFloorMs: 100 }, ...opts });
  const timer = setInterval(() => relay.tick().catch(() => {}), 100);
  t0.after(() => { clearInterval(timer); s.close(); });
  return { relay, url, mail, stripeCalls, advance: (ms) => { offset += ms; }, now: () => Date.now() + offset };
}

export async function owner(env, t0, email, handle) {
  const b = browser(env.url);
  await b('/login', { method: 'POST', form: { email } });
  await b('/login/verify', { method: 'POST', form: { email, code: env.mail.at(-1).text.match(/code is (\d{6})/)[1] } });
  await b('/app/picture', { method: 'POST', form: { avatar: 'classic' } });
  await b('/app/bots', { method: 'POST', form: { handle } });
  const home = mkdtempSync(join(tmpdir(), `b2b-bill-${handle}-`));
  const cli = async (...a) => (await run(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: home } })).stdout;
  await cli('enroll', env.url, (await b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]);
  const botId = (await b('/app')).text.match(/\/app\/bots\/(\d+)/)[1];
  const rings = [];
  const { s, url } = await listen(async (req, res) => {
    rings.push(1); res.writeHead(200).end('{}');
    try {
      for (let i = 0; i < 4; i++) {
        const out = await cli('inbox', '--via', 'doorbell');
        const acks = [...out.matchAll(/^[^|\n].*b2b\.mjs ack (msg_[\w~-]+)$/gm)];
        if (!acks.length) break;
        for (const m of acks) await cli('ack', m[1]);
      }
    } catch { /* closed */ }
  });
  t0.after(() => s.close());
  await b(`/app/bots/${botId}/doorbell`, { method: 'POST', form: { url: `${url}/automations/webhook/1`, key: 'k-12345678' } });
  return { b, cli, botId, rings };
}

export const signed = (env, event) => {
  const raw = JSON.stringify(event);
  const t = Math.floor(env.now() / 1000);
  return { raw, header: `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}` };
};
