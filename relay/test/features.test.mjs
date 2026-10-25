// 0.11: ask their bot (owner-allowed topics answered by the bot itself), invites by chat, the bot's
// secret backup, the GrokBot skill, the backup check, and the dashboard's setup checklist and tiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, owner, connect, login, cliHome, waitFor, msgId } from './helpers.mjs';

test('ask their bot: only topics the owner allowed, answered by the bot, removable on the dashboard', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  const db = env.relay.db;
  const annaId = db.prepare("SELECT id FROM bots WHERE handle = 'anna'").get().id;

  // Anna's owner tells her bot that Ben's bot may ask about her availability.
  assert.match(await anna.cli('allow', 'Ben', 'availability'), /may now ask you directly about: availability/);
  assert.match((await ben.cli('contacts')), /Anna/);
  assert.match((await anna.b('/app')).text, /Their bot may ask yours about[^]*availability/);
  assert.match((await ben.b('/app')).text, /Your bot may ask theirs about[^]*availability/);

  // Read Anna's inbox by hand, so the test sees what her bot is told.
  db.prepare('UPDATE bots SET webhook_url = NULL WHERE id = ?').run(annaId);
  const q1 = msgId(await ben.cli('send', 'Anna', 'When are you free this week?', '--topic', 'availability'));
  const wishlist = msgId(await ben.cli('send', 'Anna', 'Any gift ideas?', '--topic', 'wishlist'));
  const sealed = db.prepare('SELECT sealed FROM messages WHERE id = ?').get(q1).sealed;
  assert.doesNotMatch(sealed, /availability/, 'the topic travels sealed');
  const inbox = await anna.cli('inbox');
  assert.match(inbox, /You may answer this yourself[^]*reply .* --auto/);
  assert.match(inbox, /"wishlist", which your owner hasn't let Ben ask you about/);
  assert.ok(wishlist);

  // Her bot answers on its own; Ben's bot sees it was the bot.
  await anna.cli('reply', q1, 'Thursday evening works', '--auto');
  assert.match(await ben.cli('status', q1), /answered by their bot on its own\): Thursday evening works/);

  // Removing it on the dashboard wins, even though the bot still remembers it.
  const peer = (await anna.b('/app')).text.match(/name="peer" value="(\d+)"/)[1];
  await anna.b('/app/contacts/disallow', { method: 'POST', form: { bot: anna.botId, peer, topic: 'availability' } });
  await ben.cli('send', 'Anna', 'And next week?', '--topic', 'availability');
  assert.match(await anna.cli('inbox'), /"availability", which your owner hasn't let Ben ask you about/);
  assert.doesNotMatch((await anna.b('/app')).text, /Their bot may ask yours about/);
});

test('invite by chat: the bot gets a link, the friend connects, the owner says yes', async (t0) => {
  const env = await setup(t0, { webInbox: true });
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const out = await ben.cli('invite', 'Gran');
  const link = out.match(/Invite link for "Gran": (\S+)/)[1];
  assert.ok(link.startsWith(`${env.url}/i/`));
  const gran = await login(env, 'gran@example.com');
  const path = new URL(link).pathname;
  assert.match(out, /Add the setup bot to your Grok Bot: https:\/\/x\.ai\/bot\/[^]*Then open my invite: http/);
  assert.match((await gran(path)).text, /wants your bots to talk[^]*Add the setup bot[^]*accept_invite tool: code/);
  await gran(path, { method: 'POST', form: { web: '1', alias: 'Ben' } });
  // Ben's bot made the invite, so Ben confirms on the dashboard; the name his bot used is kept.
  const dash = (await ben.b('/app')).text;
  assert.match(dash, /Did you mean to connect with/);
  const peer = dash.match(/action="\/app\/contacts\/approve"><input type="hidden" name="bot" value="\d+"><input type="hidden" name="peer" value="(\d+)"/)[1];
  await ben.b('/app/contacts/approve', { method: 'POST', form: { bot: ben.botId, peer } });
  assert.match(await ben.cli('send', 'Gran', 'Hello Gran'), /Sent msg_/);
});

test('a reset computer reconnects from the saved secret, keys and all', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  assert.match(await ben.cli('backup'), /B2B_SECRET/);
  const secret = readFileSync(join(ben.home, 'secret.txt'), 'utf8').trim();
  // A fresh computer: nothing on disk, only the secret.
  const fresh = cliHome();
  const { promisify } = await import('node:util');
  const execFile = promisify((await import('node:child_process')).execFile);
  const run = async (...a) => (await execFile(process.execPath, [join(import.meta.dirname, '..', 'cli', 'b2b.mjs'), ...a], { env: { ...process.env, B2B_HOME: fresh.home, B2B_SECRET: secret } })).stdout;
  assert.match(await run('whoami'), /@ben[^]*Encryption: on[^]*Secret backup: stored/);
  const id = msgId(await run('send', 'Anna', 'still me'));
  await waitFor(async () => /passed_on/.test(await ben.cli('status', id)));
  assert.match(await anna.cli('received'), /still me/);
});

test('the skill, the backup check, the setup checklist and the bot tiles', async (t0) => {
  const env = await setup(t0);
  const skill = await (await fetch(`${env.url}/skill`)).text();
  assert.match(skill, /^---\nname: b2b messaging\ndescription: /);
  assert.ok(skill.includes(`${env.url}/cli/b2b.mjs`));

  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  // The owner helper tests nothing, so the doorbell isn't verified yet: the checklist shows.
  assert.match((await ben.b('/app')).text, /Set up @ben[^]*2 of 4/);
  assert.match(await ben.cli('whoami'), /Setup: \d of 5 done/);

  // Backup check: chosen on the dashboard, done by the bot, shown on the tile.
  env.relay.db.prepare('UPDATE bots SET doorbell_verified_at = ? WHERE id = ?').run(env.now(), Number(ben.botId));
  await ben.b(`/app/bots/${ben.botId}/backup`, { method: 'POST', form: { every: '4' } });
  const page = (await ben.b(`/app/bots/${ben.botId}`)).text;
  assert.match(page, /also run it every 4 hours/);
  assert.match(page, /class="tile"[^]*Encryption[^]*<b>On<\/b>/);
  assert.match(page, /Backup check[^]*Every 4 h/);
  await ben.cli('backup-check', 'off');
  assert.match((await ben.b(`/app/bots/${ben.botId}`)).text, /Backup check<\/span><b>Off<\/b>/);
});
