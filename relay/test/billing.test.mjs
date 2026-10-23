// Hosted tier: a few free sent messages a month (receiving and web inboxes are always free), a signed
// Stripe payment removes the limit, and one payment covers a household. Self-hosted relays have no plans.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
const listen = (h) => new Promise((ok) => { const s = http.createServer(h).listen(0, '127.0.0.1', () => ok({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); }
  throw new Error('timed out');
};
const SECRET = 'whsec_test_secret';

function browser(base) {
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

async function setup(t0, opts) {
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

async function owner(env, t0, email, handle) {
  const b = browser(env.url);
  await b('/login', { method: 'POST', form: { email } });
  await b('/login/verify', { method: 'POST', form: { email, code: env.mail.at(-1).text.match(/code is (\d{6})/)[1] } });
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
        const acks = [...out.matchAll(/b2b\.mjs ack (msg_[\w~-]+)/g)];
        if (!acks.length) break;
        for (const m of acks) await cli('ack', m[1]);
      }
    } catch { /* closed */ }
  });
  t0.after(() => s.close());
  await b(`/app/bots/${botId}/doorbell`, { method: 'POST', form: { url: `${url}/automations/webhook/1`, key: 'k-12345678' } });
  return { b, cli, botId, rings };
}

const signed = (env, event) => {
  const raw = JSON.stringify(event);
  const t = Math.floor(env.now() / 1000);
  return { raw, header: `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex')}` };
};

test('hosted: free messages each month, receiving stays free, signed payment, household', async (t0) => {
  const env = await setup(t0, { hosted: true, billing: { stripeKey: 'sk_test_x', priceId: 'price_x', webhookSecret: SECRET, freeMessages: 3 } });
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const mia = await owner(env, t0, 'mia@example.com', 'mia');
  const tom = await owner(env, t0, 'tom@example.com', 'tom');
  const invite = async (to) => {
    const link = (await ben.b('/app/invites', { method: 'POST', form: { bot: ben.botId } })).text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
    await to.b(`/i/${link}`, { method: 'POST', form: to.botId ? { bot: to.botId, alias: 'Ben' } : { web: '1', alias: 'Ben' } });
  };
  await invite(mia); await invite(tom);
  const sent = (out) => out.match(/Sent (msg_[\w-]+)/)[1];

  // Three free messages; the fourth is refused with a clear reason. Nothing already sent is affected.
  assert.match((await ben.b('/app')).text, /3 of 3 free messages left this month/);
  const ids = [];
  for (const t of ['one', 'two', 'three']) ids.push(sent(await ben.cli('send', 'Mia', t)));
  await assert.rejects(ben.cli('send', 'Mia', 'four'), /402.*3 free messages for this month are used up/s);
  for (const id of ids) await waitFor(async () => /passed_on/.test(await ben.cli('status', id)));
  assert.match((await ben.b('/app')).text, /You've used your 3 free messages this month/);
  assert.match((await ben.b('/app/billing')).text, /3 of 3 messages sent this month/);

  // Receiving is never limited: Mia's own allowance is untouched and she can answer.
  assert.match((await mia.b('/app')).text, /3 of 3 free messages left this month/);
  const back = sent(await mia.cli('send', 'Ben', 'got all three'));
  await waitFor(async () => /passed_on/.test(await mia.cli('status', back)));

  // A friend on the web inbox never pays and never counts.
  const granB = browser(env.url);
  await granB('/login', { method: 'POST', form: { email: 'gran@example.com' } });
  await granB('/login/verify', { method: 'POST', form: { email: 'gran@example.com', code: env.mail.at(-1).text.match(/code is (\d{6})/)[1] } });
  await invite({ b: granB });
  const page = (await granB('/app/inbox')).text;
  const [bot, peer] = [page.match(/name="bot" value="(\d+)"/)[1], page.match(/name="peer" value="(\d+)"/)[1]];
  for (let i = 0; i < 4; i++) assert.equal((await granB('/app/inbox/send', { method: 'POST', form: { bot, peer, text: `hello ${i}` } })).status, 303);
  assert.match((await granB('/app/inbox')).text, /Not end-to-end encrypted/);

  // A new month brings the free messages back. (Sessions last 30 days, so Ben signs in again.)
  const d = new Date(env.now());
  env.advance(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) + 3_600_000 - env.now());
  sent(await ben.cli('send', 'Mia', 'new month'));
  ben.b = browser(env.url);
  await ben.b('/login', { method: 'POST', form: { email: 'ben@example.com' } });
  await ben.b('/login/verify', { method: 'POST', form: { email: 'ben@example.com', code: env.mail.at(-1).text.match(/code is (\d{6})/)[1] } });
  assert.match((await ben.b('/app')).text, /2 of 3 free messages left this month/);

  // Paying (checked signature, recorded once) removes the limit.
  const co = await ben.b('/app/billing/checkout', { method: 'POST' });
  assert.equal(co.status, 303);
  assert.match(co.location, /^https:\/\/checkout\.stripe\.com\//);
  const benId = env.stripeCalls.at(-1).client_reference_id;
  const event = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { payment_status: 'paid', client_reference_id: benId } } };
  const forged = await fetch(env.url + '/billing/stripe', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: JSON.stringify(event) });
  assert.equal(forged.status, 400);
  const { raw, header } = signed(env, event);
  assert.equal((await fetch(env.url + '/billing/stripe', { method: 'POST', headers: { 'stripe-signature': header }, body: raw })).status, 200);
  const again = await (await fetch(env.url + '/billing/stripe', { method: 'POST', headers: { 'stripe-signature': signed(env, event).header }, body: raw })).json();
  assert.equal(again.duplicate, true);
  assert.match((await ben.b('/app/billing')).text, /Paid until/);
  for (const t of ['a', 'b', 'c', 'd']) sent(await ben.cli('send', 'Mia', t));
  assert.doesNotMatch((await ben.b('/app')).text, /free messages/);

  // Ben adds Tom to his household: Tom has no limit either.
  for (const t of ['1', '2', '3']) sent(await tom.cli('send', 'Ben', t));
  await assert.rejects(tom.cli('send', 'Ben', '4'), /402/);
  await ben.b('/app/billing/members', { method: 'POST', form: { email: 'tom@example.com' } });
  assert.match((await tom.b('/app/billing')).text, /Covered by Ben/);
  sent(await tom.cli('send', 'Ben', '4'));
});

test('self-hosted: no plans, no pricing page, never held for payment', async (t0) => {
  const env = await setup(t0, {});
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  assert.equal((await ben.b('/pricing')).status, 404);
  assert.doesNotMatch((await ben.b('/app')).text, /free messages/i);
  env.advance(400 * 86_400_000);
  assert.doesNotMatch((await ben.b('/app')).text, /free messages/i);
});
