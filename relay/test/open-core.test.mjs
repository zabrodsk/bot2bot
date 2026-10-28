// Open core: billing, the service dashboard and usage analytics are in hosted-*.mjs files that the open-source
// relay doesn't include. With them the hosted features work; without them each hook does nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, ADMIN } from './helpers.mjs';
import { HOSTED_PARTS } from '../server.mjs';

test('the service dashboard and its stats are there only with the hosted files', async (t0) => {
  const env = await setup(t0, { adminEmails: ['boss@example.com'] });
  const boss = await login(env, 'boss@example.com');
  const dashboard = HOSTED_PARTS.admin && HOSTED_PARTS.usage;
  assert.equal((await boss('/app/admin')).status, dashboard ? 200 : 404);
  assert.equal(/href="\/app\/admin"/.test((await boss('/app')).text), dashboard, 'menu link');
  const stats = await fetch(`${env.url}/admin/stats`, { headers: { authorization: `Bearer ${ADMIN}` } });
  assert.equal(stats.status, HOSTED_PARTS.usage ? 200 : 404);
  // Deleting an account works either way (its active days go with it when they're kept).
  const del = await boss('/app/account/delete', { method: 'POST', form: { confirm: 'boss@example.com' } });
  assert.equal(del.status, 200);
  assert.match(del.text, /Your account is deleted/);
});

test('paying is there only with the hosted billing file', async (t0) => {
  const env = await setup(t0, { hosted: true, billing: { stripeKey: 'sk_test_x', priceId: 'price_x', webhookSecret: 'whsec_x' } });
  const ben = await login(env, 'ben.oc@example.com');
  const plan = (await ben('/app/billing')).text;
  assert.equal(/action="\/app\/billing\/checkout"/.test(plan), HOSTED_PARTS.billing);
  if (!HOSTED_PARTS.billing) {
    assert.match(plan, /The paid plan is coming soon/);
    const co = await ben('/app/billing/checkout', { method: 'POST' });
    assert.equal(co.status, 400);
    assert.match(co.text, /Payments are not set up on this server yet/);
  }
  const hook = await fetch(`${env.url}/billing/stripe`, { method: 'POST', headers: { 'stripe-signature': 't=1,v1=00' }, body: '{}' });
  assert.equal(hook.status, HOSTED_PARTS.billing ? 400 : 404);
});
