// "Text the founder" (FOUNDER_BOT): anyone with a bot connects to the founder's bot from /founder in one tap,
// the founder's side says yes by itself, and messages to it don't use up the free ones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, owner, browser } from './plans-helpers.mjs';

test('text the founder: one tap connects, messages to the founder are free', async (t0) => {
  const env = await setup(t0, { hosted: true, billing: { freeMessages: 1, freePeriod: 'day' }, founderBot: '@dusan' });
  const dusan = await owner(env, t0, 'dusan@example.com', 'dusan');
  await dusan.b('/app/account', { method: 'POST', form: { name: 'Dušan Z' } });
  const mia = await owner(env, t0, 'mia@example.com', 'mia');

  // Logged out: the page is there and asks to sign in.
  const anon = browser(env.url);
  const page = await anon('/founder');
  assert.equal(page.status, 200);
  assert.match(page.text, /Text the founder/);
  assert.match(page.text, /Sign in to connect/);
  assert.equal((await anon('/founder', { method: 'POST', form: { bot: '1' } })).location, '/login?next=%2Ffounder');

  // The dashboard points there while there are no friends yet.
  assert.match((await mia.b('/app')).text, /href="\/founder"/);
  // So does her bot, which can't connect itself: it asks her to, so it can test a message both ways.
  const tryIt = new RegExp(`TRY IT: nobody to message yet\\? Ask your owner to open ${env.url}/founder and tap once\\. It connects you to the founder's bot, which answers`);
  assert.match(await mia.cli('whoami'), tryIt);
  assert.match(await mia.cli('contacts'), tryIt);
  assert.doesNotMatch(await dusan.cli('whoami'), /TRY IT/, "not on the founder's own bot");

  const done = await mia.b('/founder', { method: 'POST', form: { bot: mia.botId } });
  assert.equal(done.status, 200);
  assert.match(done.text, /You(&#39;|')re connected/);
  // Connected both ways with no yes left to give.
  assert.match(await mia.cli('contacts'), /dusan/i);
  assert.doesNotMatch(await mia.cli('contacts'), /waiting/i);
  assert.doesNotMatch(await dusan.cli('contacts'), /waiting/i);
  assert.doesNotMatch(await mia.cli('whoami'), /TRY IT/, 'gone once she has someone to message');
  // Opening it again says so, and doesn't make a second contact.
  assert.match((await mia.b('/founder')).text, /already connected/);
  assert.match((await mia.b('/founder', { method: 'POST', form: { bot: mia.botId } })).text, /already connected/);

  // Messages to the founder don't count: more than the free one goes through.
  const alias = (await mia.cli('contacts')).match(/^\s*(\S+).*@dusan/m)?.[1] || 'Dušan';
  for (const n of [1, 2, 3]) assert.match(await mia.cli('send', alias, `hi ${n}`), /Sent msg_/);
  assert.match(await mia.cli('whoami'), /0\/1 messages sent today/);

  // The founder can't connect to themself.
  const self = await dusan.b('/founder', { method: 'POST', form: { bot: dusan.botId } });
  assert.notEqual(self.status, 200);
});

test('text the founder: no founder set, no page', async (t0) => {
  const env = await setup(t0, { hosted: true });
  assert.equal((await browser(env.url)('/founder')).status, 404);
});

test('text the founder: set by bot id, it keeps working after the bot is renamed', async (t0) => {
  const env = await setup(t0, { hosted: true, founderBot: '1' });
  const dusan = await owner(env, t0, 'dusan@example.com', 'dusan');
  assert.match((await browser(env.url)('/founder')).text, /@dusan/);
  await dusan.b(`/app/bots/${dusan.botId}/rename`, { method: 'POST', form: { handle: 'founder' } });
  assert.match((await browser(env.url)('/founder')).text, /@founder/);
});
