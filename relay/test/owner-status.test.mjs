// 0.19.14: "queued", "rung" and the other status words are the tool's. After a send or a status check, the
// owner hears what happened in plain words, from a "Tell your owner" line the tool prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, owner, login, connect, connectApp, msgId } from './helpers.mjs';
import { statusForOwner, sentForOwner } from '../connector.mjs';

// The words in quotes are what the bot says to its owner.
const said = (out) => out.match(/Tell your owner[^"]*"([^"]*)"/)[1];
const STATUSES = ['key_check', 'queued', 'rung', 'not_answering', 'stalled', 'held', 'in_web_inbox', 'quiet_hours', 'seen', 'doorbell_off', 'picked_up', 'passed_on', 'replied', 'not_delivered'];
const TOOL_WORDS = /queued|rung|not_answering|stalled|in_web_inbox|quiet_hours|doorbell_off|picked_up|passed_on|not_delivered|key_check/i;

test('every status has plain owner words, and a fresh send says it went', () => {
  for (const s of STATUSES) {
    const line = statusForOwner(s, '@anna');
    assert.doesNotMatch(said(line), TOOL_WORDS, s);
    assert.match(said(line), /anna|Not delivered/, s);
    assert.match(line, /never show them to your owner/);
  }
  assert.equal(said(statusForOwner('queued', '@anna')), "Sent. anna's bot gets woken up in a moment.");
  assert.equal(said(sentForOwner('Anna', { status: 'queued', recipient_can_be_woken: true })), 'Sent to Anna.');
  assert.equal(said(sentForOwner('Anna', { status: 'queued', recipient_can_be_woken: false })), "Sent to Anna. Anna's bot will see it next time it checks.");
  assert.equal(said(sentForOwner('Anna', { status: 'queued', recipient_uses_web_inbox: true })), 'Sent to Anna. Anna gets an email and reads it in the browser.');
});

test('b2b send keeps "Status: queued" for the tool and tells the owner "Sent"', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  const out = await ben.cli('send', 'Anna', 'Pasta at 7?');
  assert.match(out, /Status: queued\./);
  assert.match(out, /^Tell your owner it went, in their language: "Sent to Anna\.[^"]*"/m);
  assert.doesNotMatch(said(out), TOOL_WORDS);
  // Asked "did Anna get it?", the bot gets owner words too, whatever the status is right now.
  const st = await ben.cli('status', msgId(out));
  assert.match(st, /^Tell your owner, in their language: "/m);
  assert.doesNotMatch(said(st), TOOL_WORDS);
});

test('quick connect send_message and message_status tell the owner the same way', async (t0) => {
  const env = await setup(t0);
  const miaOwner = { b: await login(env, 'mia@example.com') };
  const app = await connectApp(env, miaOwner.b, 'mia-bot');
  const ben = await owner(env, t0, 'ben@example.com', 'ben', { status: 500 });
  const link = (await app.tool('invite', { name: 'Ben' })).content[0].text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await ben.b(`/i/${link}`, { method: 'POST', form: { bot: ben.botId, alias: 'Mia' } });
  const peer = (await miaOwner.b('/app')).text.match(/action="\/app\/contacts\/approve"><input type="hidden" name="bot" value="(\d+)"><input type="hidden" name="peer" value="(\d+)"/);
  await miaOwner.b('/app/contacts/approve', { method: 'POST', form: { bot: peer[1], peer: peer[2] } });
  const sent = (await app.tool('send_message', { to: 'Ben', text: 'Free Friday?' })).content[0].text;
  assert.match(sent, /Tell your owner it went, in their language: "Sent to Ben\.[^"]*"/);
  assert.doesNotMatch(said(sent), TOOL_WORDS);
  const st = (await app.tool('message_status', { message_id: msgId(sent) })).content[0].text;
  assert.match(st, /Tell your owner, in their language: "/);
  assert.doesNotMatch(said(st), TOOL_WORDS);
});
