// Plans on a hosted relay: a few free sent messages a day or a month (receiving and web inboxes are always free),
// and the Infinite plan the operator can give. Self-hosted relays have no plans. Paying is in hosted-billing.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, owner } from './plans-helpers.mjs';

test('self-hosted: no plans, no pricing page, never held for payment', async (t0) => {
  const env = await setup(t0, {});
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  assert.equal((await ben.b('/pricing')).status, 404);
  assert.doesNotMatch((await ben.b('/app')).text, /free messages/i);
  env.advance(400 * 86_400_000);
  assert.doesNotMatch((await ben.b('/app')).text, /free messages/i);
});

test('hosted: the free allowance can be per day (what the hosted relay runs)', async (t0) => {
  const env = await setup(t0, { hosted: true, billing: { freeMessages: 2, freePeriod: 'day' } });
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const mia = await owner(env, t0, 'mia@example.com', 'mia');
  const link = (await ben.b('/app/invites', { method: 'POST', form: { bot: ben.botId } })).text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await mia.b(`/i/${link}`, { method: 'POST', form: { bot: mia.botId, alias: 'Ben' } });
  assert.match((await ben.b('/app')).text, /2 of 2 free messages left today/);
  await ben.cli('send', 'Mia', 'one'); await ben.cli('send', 'Mia', 'two');
  await assert.rejects(ben.cli('send', 'Mia', 'three'), /2 free messages for today are used up. They come back at midnight UTC/);
  assert.match(await ben.cli('whoami'), /Free plan: 2\/2 messages sent today/);
  const d = new Date(env.now());
  env.advance(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) + 60_000 - env.now());
  assert.match(await ben.cli('send', 'Mia', 'a new day'), /Sent msg_/);
});

test('hosted: a plan named for one person is only words, the limits stay free', async (t0) => {
  const env = await setup(t0, { hosted: true, billing: { freeMessages: 1, freePeriod: 'day' } });
  const tim = await owner(env, t0, 'tim@example.com', 'tim');
  const mia = await owner(env, t0, 'mia8@example.com', 'mia8');
  const link = (await tim.b('/app/invites', { method: 'POST', form: { bot: tim.botId } })).text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await mia.b(`/i/${link}`, { method: 'POST', form: { bot: mia.botId, alias: 'Tim' } });
  const admin = (body) => fetch(`${env.url}/admin/tier`, { method: 'POST', headers: { authorization: 'Bearer admin-token-for-tests-123456', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${env.url}/admin/tier`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await admin({ email: 'tim@example.com' })).status, 400);
  assert.equal((await admin({ email: 'tim@example.com', name: 'X', theme: 'disco' })).status, 400);
  assert.equal((await admin({ email: 'Tim@example.com', name: 'Mr Luckbased', note: 'No perks for you buddy, still 50 messages.' })).status, 200);
  assert.match((await tim.b('/app')).text, /<span class="umenu__plan">Mr Luckbased<\/span>/);
  let plan = (await tim.b('/app/billing')).text;
  assert.match(plan, /<section class="card"><h2>Your plan <span class="umenu__plan">Mr Luckbased<\/span><\/h2><p class="tiernote">No perks for you buddy, still 50 messages\.<\/p>[^]*Free plan: 0 of 1 messages sent today/);
  // The golf look: the card becomes a fairway with a flag, the pill goes green.
  assert.equal((await admin({ email: 'tim@example.com', name: 'Mr Luckbased', note: 'No perks for you buddy, still 50 messages.', theme: 'golf' })).status, 200);
  plan = (await tim.b('/app/billing')).text;
  assert.match(plan, /<section class="card card--golf"><svg class="golf__scene"[^]*<\/svg><h2>Your plan <span class="umenu__plan umenu__plan--golf">Mr Luckbased<\/span>[^]*class="tiernote"/);
  assert.match((await tim.b('/app')).text, /<span class="umenu__plan umenu__plan--golf">Mr Luckbased<\/span>/);
  assert.match(await tim.cli('send', 'Mia8', 'one'), /Sent msg_/);
  await assert.rejects(tim.cli('send', 'Mia8', 'two'), /free messages for today are used up/);
  await admin({ email: 'tim@example.com', off: true });
  assert.doesNotMatch((await tim.b('/app/billing')).text, />Mr Luckbased<|class="tiernote"|card--golf"/);
});

test('hosted: the Infinite plan has no limit, shows a rainbow Infinite pill, and can be taken back', async (t0) => {
  const env = await setup(t0, { hosted: true, billing: { freeMessages: 1, freePeriod: 'day' } });
  const ben = await owner(env, t0, 'dad@example.com', 'dad');
  const mia = await owner(env, t0, 'mia9@example.com', 'mia9');
  const link = (await ben.b('/app/invites', { method: 'POST', form: { bot: ben.botId } })).text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await mia.b(`/i/${link}`, { method: 'POST', form: { bot: mia.botId, alias: 'Dad' } });
  const admin = (body) => fetch(`${env.url}/admin/infinite`, { method: 'POST', headers: { authorization: 'Bearer admin-token-for-tests-123456', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await admin({ email: 'nobody@example.com' })).status, 404);
  assert.equal((await admin({ email: 'Dad@example.com' })).status, 200);
  for (const t of ['one', 'two', 'three']) assert.match(await ben.cli('send', 'Mia9', t), /Sent msg_/);
  const home = (await ben.b('/app')).text;
  assert.match(home, /umenu__plan umenu__plan--infinite"><span class="inf" aria-hidden="true">∞<\/span>Infinite</);
  assert.doesNotMatch(home, /free messages left/);
  const plan = (await ben.b('/app/billing')).text;
  assert.match(plan, /No limit, for good/);
  assert.doesNotMatch(plan, /Pay €|coming soon/);
  await admin({ email: 'dad@example.com', off: true });
  await assert.rejects(ben.cli('send', 'Mia9', 'four'), /free messages for today are used up/);
});
