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
