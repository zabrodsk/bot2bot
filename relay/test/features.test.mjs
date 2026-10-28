// 0.11: ask their bot (owner-allowed topics answered by the bot itself), invites by chat, the bot's
// secret backup, the GrokBot skill, the backup check, and the dashboard's setup checklist and tiles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, owner, connect, login, browser, cliHome, waitFor, msgId } from './helpers.mjs';

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
  assert.match((await anna.b('/app')).text, /Ben can ask about[^]*availability/);
  assert.match((await ben.b('/app')).text, /You can ask Anna about[^]*availability/);

  // Read Anna's inbox by hand, so the test sees what her bot is told.
  db.prepare('UPDATE bots SET webhook_url = NULL WHERE id = ?').run(annaId);
  const q1 = msgId(await ben.cli('send', 'Anna', 'When are you free this week?', '--topic', 'availability'));
  const wishlist = msgId(await ben.cli('send', 'Anna', 'Any gift ideas?', '--topic', 'wishlist'));
  const sealed = db.prepare('SELECT sealed FROM messages WHERE id = ?').get(q1).sealed;
  assert.doesNotMatch(sealed, /availability/, 'the topic travels sealed');
  const inbox = await anna.cli('inbox');
  assert.match(inbox, /You may answer this yourself[^]*reply .* --auto/);
  assert.match(inbox, /"wishlist", which your owner hasn't let "Ben" ask you about/);
  assert.ok(wishlist);

  // Her bot answers on its own; Ben's bot sees it was the bot.
  await anna.cli('reply', q1, 'Thursday evening works', '--auto');
  assert.match(await ben.cli('status', q1), /their bot says it answered on its own\), written by their bot[^]*\n\| Thursday evening works/);

  // Removing it on the dashboard wins, even though the bot still remembers it.
  const peer = (await anna.b('/app')).text.match(/name="peer" value="(\d+)"/)[1];
  await anna.b('/app/contacts/disallow', { method: 'POST', form: { bot: anna.botId, peer, topic: 'availability' } });
  await ben.cli('send', 'Anna', 'And next week?', '--topic', 'availability');
  assert.match(await anna.cli('inbox'), /"availability", which your owner hasn't let "Ben" ask you about/);
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
  // The setup bot's guide, which its template's short instruction points at.
  const guide = await (await fetch(`${env.url}/setup-bot`)).text();
  assert.match(guide, /^---\nname: bot2bot setup\n/);
  assert.ok(guide.includes(`${env.url}/setup`) && !guide.includes('{{RELAY}}'));

  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  // The owner helper tests nothing, so the doorbell isn't verified yet: the checklist shows.
  assert.match((await ben.b('/app')).text, /Set up @ben[^]*2 of 4/);
  assert.match(await ben.cli('whoami'), /Setup: \d of 5 done/);

  // Backup check: chosen on the dashboard, done by the bot, shown on the tile.
  env.relay.db.prepare('UPDATE bots SET doorbell_verified_at = ? WHERE id = ?').run(env.now(), Number(ben.botId));
  await ben.b(`/app/bots/${ben.botId}/backup`, { method: 'POST', form: { every: '4' } });
  const page = (await ben.b(`/app/bots/${ben.botId}`)).text;
  assert.match(page, /also run it every 4 hours/);
  assert.match(page, /<dt>Encryption<\/dt><dd><b>On<\/b>/);
  assert.match(page, /Backup check[^]*Every 4 h/);
  await ben.cli('backup-check', 'off');
  assert.match((await ben.b(`/app/bots/${ben.botId}`)).text, /<dt>Backup check<\/dt><dd><b>Off<\/b>/);
});

test('profile pictures: picked before the dashboard, shown to friends who said yes, never to strangers', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  const zoe = await owner(env, t0, 'zoe@example.com', 'zoe');
  await connect(ben, anna, 'Ben');

  // Someone new picks a picture first, then lands where they were going.
  const b = browser(env.url);
  await b('/login', { method: 'POST', form: { email: 'new@example.com' } });
  await b('/login/verify', { method: 'POST', form: { email: 'new@example.com', code: env.mail.at(-1).text.match(/code is (\d{6})/)[1] } });
  assert.equal((await b('/app/activity')).location, '/app/picture?next=%2Fapp%2Factivity');
  const picker = (await b('/app/picture?next=/app/activity')).text;
  assert.match(picker, /Your name and picture/);
  assert.equal((picker.match(/name="avatar" value="[a-z]+"/g) || []).length, 12, 'the twelve robots, next to any stickers');
  assert.equal((await b('/app/picture', { method: 'POST', form: { next: '/app/activity' } })).status, 400, 'a picture is required');
  assert.equal((await b('/app/picture', { method: 'POST', form: { avatar: 'nope', next: '/app/activity' } })).status, 400);
  assert.equal((await b('/app/picture', { method: 'POST', form: { avatar: 'visor', next: '//evil.example' } })).location, '/app');
  assert.equal((await b('/app/activity')).status, 200);
  assert.match((await b('/app')).text, /src="\/avatars\/visor\.svg"/);
  const robot = await fetch(env.url + '/avatars/visor.svg');
  assert.equal(robot.headers.get('content-type'), 'image/svg+xml');
  assert.doesNotMatch(await robot.text(), /<script/);

  // Anna uploads her own photo. Not a JPEG: refused.
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7), Buffer.from([0xff, 0xd9])]);
  assert.equal((await anna.b('/app/picture', { method: 'POST', form: { photo: 'data:image/jpeg;base64,PHN2Zz4=' } })).status, 400);
  assert.equal((await anna.b('/app/picture', { method: 'POST', form: { photo: `data:image/jpeg;base64,${jpg.toString('base64')}`, next: '/app/account' } })).location, '/app/account');
  const src = (await anna.b('/app/account')).text.match(/<img src="(\/app\/photo\/\d+\?v=\d+)"/)[1];

  // Ben is her friend, so his overview shows it and he can load it. Zoe isn't, and signed-out visitors aren't.
  assert.ok((await ben.b('/app')).text.includes(`<img src="${src}"`));
  assert.notEqual((await fetch(env.url + src, { redirect: 'manual' })).status, 200);
  assert.equal((await ben.b(src)).status, 200);
  assert.equal((await zoe.b(src)).status, 404);
  const [, bot, peer] = (await anna.b('/app')).text.match(/name="bot" value="(\d+)"><input type="hidden" name="peer" value="(\d+)"/);
  await anna.b('/app/contacts/block', { method: 'POST', form: { bot, peer } });
  assert.equal((await ben.b(src)).status, 404, 'blocked: the photo is hidden too');
  assert.ok(!(await ben.b('/app')).text.includes(`<img src="${src}"`));

  // Switching to a robot drops the photo.
  await anna.b('/app/picture', { method: 'POST', form: { avatar: 'mint' } });
  assert.equal((await anna.b(src)).status, 404);
  assert.match((await anna.b('/app/account')).text, /src="\/avatars\/mint\.svg"/);
});

test('your name: picked on the first step, changeable in Account, and your bot name is suggested from it', async (t0) => {
  const env = await setup(t0);
  const b = browser(env.url);
  await b('/login', { method: 'POST', form: { email: 'd.zabrodsky.88@example.com' } });
  await b('/login/verify', { method: 'POST', form: { email: 'd.zabrodsky.88@example.com', code: env.mail.at(-1).text.match(/code is (\d{6})/)[1] } });
  const first = (await b('/app/picture?next=/app')).text;
  assert.match(first, /Your name and picture/);
  assert.match(first, /<label class="field">Your name<input name="name" value=""/);
  const empty = await b('/app/picture', { method: 'POST', form: { avatar: 'classic', name: '  ', next: '/app' } });
  assert.equal(empty.status, 400);
  assert.match(empty.text, /role="alert">Tell us what to call you\./);
  assert.equal((await b('/app/picture', { method: 'POST', form: { avatar: 'classic', name: 'Dušan  Zabrodský', next: '/app' } })).status, 303);
  assert.match((await b('/app/account')).text, /name="name" value="Dušan Zabrodský"/);
  // The bot name is suggested from it, without diacritics.
  assert.match((await b('/app/bots/new-form')).text, /name="handle" value="dusan-bot"/);
  // Account: change it, with Undo.
  await b('/app/account/name', { method: 'POST', form: { name: 'Dusan Jr' } });
  const acc = (await b('/app/account')).text;
  assert.match(acc, /Name saved[^]*\/app\/account\/name[^]*name="name" value="Dušan Zabrodský"/);
  assert.match(acc, /<label class="field">Your name<input name="name" value="Dusan Jr"/);
});

test("what's new: shown once after an update to people who were already here, one line or a short list", async (t0) => {
  const log = { days: [{ iso: '2026-11-01', label: '1 November 2026', items: [{ en: 'Rename your bots yourself.', cs: 'Své boty si přejmenujete sami.', release: 'r1' }, { en: 'An older change from the same day.' }] }] };
  const env = await setup(t0, { changelog: log });
  const old = await login(env, 'old@example.com');
  // Someone who signed up before this update.
  env.relay.db.prepare("UPDATE users SET seen_update = NULL WHERE email = 'old@example.com'").run();
  let home = (await old('/app')).text;
  assert.match(home, /<dialog class="dlg" id="whatsnew"[^]*What&#39;s new[^]*<p class="dlg__one">Rename your bots yourself\.<\/p>[^]*Got it/);
  assert.doesNotMatch(home, /An older change from the same day/, 'only the newest update');
  assert.equal((await old('/app/whatsnew', { method: 'POST', form: { id: '2026-11-01#r1' } })).status, 204);
  assert.doesNotMatch((await old('/app')).text, /id="whatsnew"/, 'once');
  // Czech, and nothing for someone who just signed up.
  env.relay.db.prepare("UPDATE users SET seen_update = NULL, lang = 'cs' WHERE email = 'old@example.com'").run();
  assert.match((await old('/app')).text, /Co je nového[^]*Své boty si přejmenujete sami\.[^]*Rozumím/);
  const fresh = await login(env, 'new@example.com');
  assert.doesNotMatch((await fresh('/app')).text, /id="whatsnew"/);
});

test("what's new: several changes are a list", async (t0) => {
  const env = await setup(t0, { changelog: { days: [{ iso: '2026-11-02', items: [{ en: 'One.', release: 'r2' }, { en: 'Two.', release: 'r2' }, { en: 'Earlier.' }] }] } });
  const b = await login(env, 'list@example.com');
  env.relay.db.prepare("UPDATE users SET seen_update = '2026-11-01' WHERE email = 'list@example.com'").run();
  assert.match((await b('/app')).text, /<ul class="dlg__list"><li>One\.<\/li><li>Two\.<\/li><\/ul>/);
});
