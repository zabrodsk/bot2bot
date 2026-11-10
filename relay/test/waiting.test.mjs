// A message its bot hasn't picked up: its owner sees it on the bot's page, and after a day gets one email (who wrote,
// never what), so nothing sits unnoticed until it expires. For bots that only run when asked, or a broken doorbell.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, owner, connect, waitFor } from './helpers.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3_600_000;

test('a message nobody picked up: the bot page says so, and a day later its owner gets one email', async (t0) => {
  const env = await setup(t0);
  const ann = await owner(env, t0, 'ann@example.com', 'ann');
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  ben.routine.status = 503; // Ben's bot can't be woken: it only sees messages when he talks to it
  const waiting = () => env.mail.filter((m) => /wrote to @ben/.test(m.subject));

  await ann.cli('send', 'ben', 'Dinner on Friday?');
  const page = async () => (await ben.b(`/app/bots/${ben.botId}`)).text;
  assert.doesNotMatch(await page(), /waiting for @ben/, 'not for a message that just came');
  env.advance(2 * HOUR);
  await sleep(300);
  assert.match(await page(), /1 message is waiting for @ben[^]*The oldest came [^.]+\. Your bot gets them the next time it checks\./);
  assert.equal(waiting().length, 0, 'no email the same day');

  env.advance(22 * HOUR + 2 * 60_000);
  await waitFor(() => waiting().length === 1);
  const mail = waiting()[0];
  assert.equal(mail.to, 'ben@example.com');
  assert.match(mail.subject, /^Ann wrote to @ben$/);
  assert.match(mail.text, /1 message is waiting for @ben\n\nFrom Ann, over a day ago\. @ben hasn't checked its messages since\.\n\nTo get it now, tell your bot: “Check my bot2bot messages\.”/);
  assert.match(mail.text, new RegExp(`/app/bots/${ben.botId}`));
  assert.doesNotMatch(mail.text + mail.html, /Dinner/, 'never what it says');

  // One email for these messages, however long they wait.
  env.advance(3 * 24 * HOUR);
  await sleep(300);
  assert.equal(waiting().length, 1);

  // Once Ben's bot checks, the page is clear again.
  await ben.cli('inbox');
  assert.doesNotMatch(await page(), /waiting for @ben/);
});

test('waiting messages: nothing for a paused bot, a group message or a bot that picks its messages up', async (t0) => {
  const env = await setup(t0);
  const ann = await owner(env, t0, 'ann@example.com', 'ann');
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  // Delivered as usual: the doorbell wakes Ben's bot and it reads its inbox.
  await ann.cli('send', 'ben', 'Hello');
  await waitFor(() => env.relay.db.prepare("SELECT count(*) AS n FROM messages WHERE to_bot = ? AND status = 'pending' AND kind != 'probe'").get(ben.botId).n === 0);
  // Paused on purpose: held, not forgotten.
  ben.routine.status = 503;
  env.relay.db.prepare('UPDATE bots SET paused_at = ? WHERE id = ?').run(env.now(), ben.botId);
  await ann.cli('send', 'ben', 'Still there?');
  env.advance(25 * HOUR);
  await sleep(400);
  assert.equal(env.mail.filter((m) => /wrote to @ben/.test(m.subject)).length, 0);
});

test('a bot with no doorbell at all: its owner hears after two hours, with how to switch one on', async (t0) => {
  const env = await setup(t0);
  const ann = await owner(env, t0, 'ann@example.com', 'ann');
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  env.relay.db.prepare('UPDATE bots SET webhook_url = NULL, webhook_key = NULL, doorbell_kind = NULL WHERE id = ?').run(ben.botId);
  const waiting = () => env.mail.filter((m) => /wrote to @ben/.test(m.subject));

  await ann.cli('send', 'ben', 'Dinner on Friday?');
  env.advance(HOUR);
  await sleep(300);
  assert.equal(waiting().length, 0, 'not after an hour');
  env.advance(HOUR + 2 * 60_000);
  await waitFor(() => waiting().length === 1);
  const mail = waiting()[0];
  assert.match(mail.text, /From Ann, 2 hours ago\. @ben has no doorbell yet, so it only sees messages when you talk to it\./);
  assert.match(mail.text, /Switch its doorbell on and it wakes up by itself next time\.[^]*Switch on the doorbell: \S+\/app\/bots\//);
  assert.doesNotMatch(mail.text + mail.html, /Dinner/, 'never what it says');
});
