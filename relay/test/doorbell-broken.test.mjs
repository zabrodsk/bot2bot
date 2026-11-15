// A doorbell that worked and then stops taking rings (the routine got a new key when it was edited, or was paused):
// nobody can wake the bot, so the relay stops calling it verified, its owner gets one email, the dashboard shows how to
// fix it, and the bot tells its owner the next time they talk to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, owner, connect, waitFor } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a routine that stops taking rings: one email, the page says how to fix it, and the bot tells its owner', async (t0) => {
  const env = await setup(t0);
  const ann = await owner(env, t0, 'ann@example.com', 'ann');
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  await ben.api('POST', '/v1/doorbell/test');
  await waitFor(async () => (await ben.api('GET', '/v1/me')).json.doorbell.verified);
  const broken = () => env.mail.filter((m) => /doorbell stopped working/.test(m.subject));

  ben.routine.status = 401; // Ben's bot edited its routine and the routine got a new key
  // A run woken before that may still be reading the inbox: let it finish, so the message waits for a ring.
  await waitFor(async () => (await ben.api('GET', '/v1/me')).json.inbox_pending === 0 && (await sleep(1000), (await ben.api('GET', '/v1/me')).json.inbox_pending === 0), 15_000);
  await ann.cli('send', 'ben', 'Dinner on Friday?');
  await waitFor(() => broken().length === 1, 15_000);
  const mail = broken()[0];
  assert.equal(mail.to, 'ben@example.com');
  assert.equal(mail.subject, "@ben's doorbell stopped working");
  assert.match(mail.text, /its b2b doorbell routine stopped taking rings\. That happens when the routine gets a new key or is paused\./);
  assert.match(mail.text, /COMPUTER ONLY/);
  assert.match(mail.text, new RegExp(`Fix the doorbell: ${env.url}/app/bots/${ben.botId}`));
  assert.doesNotMatch(mail.text + mail.html, /Dinner/);

  const me = (await ben.api('GET', '/v1/me')).json.doorbell;
  assert.equal(me.verified, false);
  assert.equal(me.refused, true);
  assert.match((await ben.b('/app')).text, /Doorbell not working/);
  const page = (await ben.b(`/app/bots/${ben.botId}`)).text;
  assert.match(page, /Fix the doorbell[^]*stopped taking rings[^]*name="key"/);

  // Ringing on doesn't send more email.
  for (let i = 0; i < 3; i++) { env.advance(61_000); await sleep(250); }
  assert.ok(ben.rings.length >= 3);
  assert.equal(broken().length, 1);

  // Ben talks to his bot: it tells him, without asking for the key in the chat.
  const out = await ben.cli('inbox');
  assert.match(out, /DOORBELL STOPPED WORKING/);
  assert.match(out, new RegExp(`open ${env.url}/app/bots/${ben.botId}`));
  assert.match(out, /Never ask for the key in this chat/);

  // Once the routine takes rings again, a test wakes the bot and it's on again.
  ben.routine.status = 200;
  await ben.api('POST', '/v1/doorbell/test');
  await waitFor(async () => (await ben.api('GET', '/v1/me')).json.doorbell.verified);
  assert.equal((await ben.api('GET', '/v1/me')).json.doorbell.refused, undefined);
});

test('a test ring that is refused says so on the page but sends no email', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben', { status: 401 });
  assert.equal((await ben.api('POST', '/v1/doorbell/test')).json.status, 401);
  await sleep(300);
  assert.equal(env.mail.filter((m) => /doorbell stopped working/.test(m.subject)).length, 0);
  assert.equal((await ben.api('GET', '/v1/me')).json.doorbell.refused, true);
});
