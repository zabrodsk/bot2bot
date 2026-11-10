// Bots on one account talk to each other without an invite: nobody says yes, and they aren't Friends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, owner, waitFor } from './plans-helpers.mjs';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'b2b.mjs');

test('own bots: a second bot can message the first right away, and neither is a friend', async (t0) => {
  const env = await setup(t0, { hosted: true });
  const dusan = await owner(env, t0, 'dusan@example.com', 'dusan');
  const mia = await owner(env, t0, 'mia@example.com', 'mia');

  // A second bot on Dušan's account.
  await dusan.b('/app/bots', { method: 'POST', form: { handle: 'work' } });
  const home = mkdtempSync(join(tmpdir(), 'b2b-own-work-'));
  const work = async (...a) => (await run(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: home } })).stdout;
  await work('enroll', env.url, (await dusan.b('/app/bots/add/grok/steps')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]);

  // Each knows the other by its handle, with no yes waiting on either side.
  const contacts = await waitFor(async () => { const c = await work('contacts'); return /dusan/.test(c) && c; });
  assert.doesNotMatch(contacts, /waiting/i);
  assert.match(await dusan.cli('contacts'), /work.*\[your owner's own bot\]/);
  assert.match(await work('send', 'dusan', 'hi from work'), /Sent msg_/);
  // The work bot (no doorbell, so nothing reads it first) is told the message is from its owner's other bot.
  assert.match(await dusan.cli('send', 'work', 'hi from home'), /Sent msg_/);
  assert.match(await work('inbox'), /from "dusan" \(@dusan\).*another of your owner's own bots/);

  // The dashboard keeps them under Your bots, not Friends.
  const home2 = (await dusan.b('/app')).text;
  assert.match(home2, /No friends yet/);
  assert.match(home2, /Your bots can message each other/);
  assert.doesNotMatch(home2, /Did you mean to connect/);
  // Each bot shows what it runs on and its doorbell, with words for what the bell means.
  assert.match(home2, /data-origin="grok"/);
  assert.match(home2, /class="bell" data-state="warn">[^]*?Doorbell set, but not tested yet\./);

  // An invite between them isn't needed, and says so.
  const code = (await dusan.cli('invite', 'work2')).match(/Pairing code for "work2": (\S+)/)[1];
  await assert.rejects(work('accept', code, 'me'), /no invite needed/);

  // Someone else's bots aren't linked.
  assert.doesNotMatch(await mia.cli('contacts'), /dusan|work/);
});

test('a big update gets its own look in What\'s new', async (t0) => {
  const changelog = { days: [{ iso: '2026-11-01', items: [{ en: 'All your bots talk.', release: 'own-bots', big: { title: { en: 'Your bots talk to each other' }, points: [{ en: 'No invite needed.' }] } }] }] };
  const env = await setup(t0, { hosted: true, changelog });
  const dusan = await owner(env, t0, 'dusan@example.com', 'dusan');
  env.relay.db.prepare('UPDATE users SET seen_update = NULL').run();
  const page = (await dusan.b('/app')).text;
  assert.match(page, /class="dlg dlg--big"/);
  assert.match(page, /class="talk"/);
  assert.match(page, /Your bots talk to each other<\/h2><p class="bigup__lead">All your bots talk\.<\/p><ul class="bigup__points"><li>No invite needed\.<\/li>/);
});
