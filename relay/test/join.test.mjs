// Private mode without a code: the bot runs `join`, its owner opens the link, signs in and says yes,
// and the bot collects its token. Covers waiting, saying no, expiry, switching from quick connect and backups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, login, cliHome, waitFor, sleep } from './helpers.mjs';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'b2b.mjs');
// Like cliHome's cli, but also returns the exit code instead of throwing on a non-zero one.
const runIn = (home, env = {}) => async (...a) => {
  try { const r = await run(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: home, ...env } }); return { code: 0, out: r.stdout + r.stderr }; }
  catch (e) { return { code: e.code, out: `${e.stdout}${e.stderr}` }; }
};
const linkIn = (out) => out.match(/(\/app\/link\/[A-Z0-9]{4}-[A-Z0-9]{4})/)[1];

test('join: link, owner says yes, bot collects its token once, encrypted from the start', async (t0) => {
  const env = await setup(t0);
  const ben = await login(env, 'ben@example.com');
  const { home } = cliHome();
  const cli = runIn(home);

  const start = await cli('join', env.url, '--name', 'ben-bot');
  assert.equal(start.code, 0);
  assert.match(start.out, /Give your owner this link[^]*\/app\/link\/[A-Z0-9]{4}-[A-Z0-9]{4}[^]*run this same command again/);
  const link = linkIn(start.out);

  // Not approved yet: waiting gives up after --wait seconds with the same link.
  const early = await cli('join', '--wait', '1');
  assert.equal(early.code, 3);
  assert.match(early.out, new RegExp(`hasn't approved yet[^]*${link}`));

  // Signed out, the link sends you to sign in first and back.
  const anon = await fetch(env.url + link, { redirect: 'manual' });
  assert.equal(anon.status, 303);
  assert.match(anon.headers.get('location'), new RegExp(`^/login\\?next=${encodeURIComponent(link)}`));

  const page = (await ben(link)).text;
  assert.match(page, /Connect your bot[^]*private mode[^]*Only say yes if your own bot gave you this link/);
  assert.match(page, /name="handle"[^>]*value="ben-bot"/);
  const yes = await ben(link, { method: 'POST', form: { decision: 'allow', bot: 'new', handle: 'ben-bot' } });
  assert.equal(yes.status, 303);
  assert.match((await ben(link)).text, /You said yes[^]*ask it to run its join command again/);

  const done = await cli('join');
  assert.equal(done.code, 0);
  assert.match(done.out, /Joined as @ben-bot[^]*end-to-end encrypted/);
  assert.ok(!existsSync(join(home, 'join.json')));
  assert.match((await ben(link)).text, /Your bot is connected/);
  assert.match((await cli('whoami')).out, /@ben-bot[^]*Encryption: on/);
  const row = env.relay.db.prepare("SELECT * FROM bots WHERE handle = 'ben-bot'").get();
  assert.equal(row.vendor, 'grokbot');
  assert.ok(row.box_pub && row.sign_pub && row.token_hash);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).keys.box.x, row.box_pub);

  // The poll secret works once; a connected bot doesn't join again by accident.
  const poll = env.relay.db.prepare('SELECT collected_at FROM join_requests').get();
  assert.ok(poll.collected_at);
  assert.match((await cli('join', env.url)).out, /Already connected as @ben-bot[^]*--again/);
  // The dashboard knows the bot, and the link can't be used a second time.
  assert.match((await ben('/app')).text, /@ben-bot/);
  assert.equal((await ben(link, { method: 'POST', form: { decision: 'allow', bot: 'new', handle: 'other' } })).status, 410);
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM bots WHERE handle = 'other'").get().n, 0);
});

test('join: the owner says no, or the link expires', async (t0) => {
  const env = await setup(t0);
  const ben = await login(env, 'ben@example.com');
  const cli = runIn(cliHome().home);

  const link = linkIn((await cli('join', env.url)).out);
  await ben(link, { method: 'POST', form: { decision: 'deny' } });
  const no = await cli('join');
  assert.notEqual(no.code, 0);
  assert.match(no.out, /your owner said no[^]*make a new link/);
  assert.match((await ben(link)).text, /This link expired/);

  // A new link (the old request is gone), then 16 minutes pass.
  const link2 = linkIn((await cli('join', env.url)).out);
  assert.notEqual(link2, link);
  env.advance(16 * 60_000);
  assert.match((await ben(link2)).text, /This link expired/);
  const late = await ben(link2, { method: 'POST', form: { decision: 'allow', bot: 'new', handle: 'late' } });
  assert.equal(late.status, 410);
  assert.match(late.text, /This link expired/);
  // The bot is told the link expired; running join again makes a fresh one.
  assert.match((await cli('join', env.url)).out, /the link expired before your owner opened it[^]*make a new link/);
  const again = await cli('join', env.url);
  assert.match(again.out, /Give your owner this link/);
  assert.notEqual(linkIn(again.out), link2);
});

test('join: someone else\'s bot or a taken name is refused; a bad name says why', async (t0) => {
  const env = await setup(t0);
  const ben = await login(env, 'ben@example.com');
  const ann = await login(env, 'ann@example.com');
  const benCli = runIn(cliHome().home);
  await ben(linkIn((await benCli('join', env.url)).out), { method: 'POST', form: { decision: 'allow', bot: 'new', handle: 'ben' } });
  await benCli('join');
  const benBot = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'ben'").get().id;

  const link = linkIn((await runIn(cliHome().home)('join', env.url)).out);
  assert.equal((await ann(link, { method: 'POST', form: { decision: 'allow', bot: String(benBot) } })).status, 404);
  assert.match((await ann(link, { method: 'POST', form: { decision: 'allow', bot: 'new', handle: 'ben' } })).text, /That name is taken/);
  assert.match((await ann(link, { method: 'POST', form: { decision: 'allow', bot: 'new', handle: 'Ann Bot' } })).text, /lowercase letters/);
  // Ben's bot still works.
  assert.match((await benCli('whoami')).out, /@ben/);
});

test('join: a quick-connect bot moves to private mode and keeps its contacts', async (t0) => {
  const env = await setup(t0);
  const ben = await login(env, 'ben@example.com');
  const db = env.relay.db;
  const user = db.prepare("SELECT id FROM users WHERE email = 'ben@example.com'").get().id;
  db.prepare("INSERT INTO bots (handle, display_name, token_hash, created_at, user_id, vendor) VALUES ('ben-app', 'Ben', NULL, ?, ?, 'connector')").run(Date.now(), user);
  const id = db.prepare("SELECT id FROM bots WHERE handle = 'ben-app'").get().id;
  db.prepare("INSERT INTO bots (handle, display_name, token_hash, created_at, vendor) VALUES ('gran', 'Gran', 'x', ?, 'grokbot')").run(Date.now());
  const gran = db.prepare("SELECT id FROM bots WHERE handle = 'gran'").get().id;
  db.prepare('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at) VALUES (?, ?, ?, ?, ?)').run(id, gran, 'gran', Date.now(), Date.now());
  db.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, bot_id, created_at, expires_at) VALUES ('h', 'access', 'c', ?, ?, ?)").run(id, Date.now(), Date.now() + 3_600_000);

  const cli = runIn(cliHome().home);
  const link = linkIn((await cli('join', env.url)).out);
  assert.match((await ben(link)).text, /@ben-app \(switch from quick connect\)/);
  await ben(link, { method: 'POST', form: { decision: 'allow', bot: String(id) } });
  assert.match((await cli('join')).out, /Joined as @ben-app/);

  const b = db.prepare('SELECT * FROM bots WHERE id = ?').get(id);
  assert.equal(b.vendor, 'grokbot');
  assert.ok(b.box_pub);
  assert.ok(db.prepare("SELECT revoked_at FROM oauth_tokens WHERE token_hash = 'h'").get().revoked_at, 'the app sign-in stops working');
  assert.match((await cli('contacts')).out, /gran/);
});

test('backup carries the pinned contacts and restores them after a reset', async (t0) => {
  const env = await setup(t0);
  const ben = await login(env, 'ben@example.com');
  const { home } = cliHome();
  const cli = runIn(home);
  await ben(linkIn((await cli('join', env.url)).out), { method: 'POST', form: { decision: 'allow', bot: 'new', handle: 'ben' } });
  await cli('join');
  const pinned = { anna: { sign: 'A'.repeat(43), box: 'B'.repeat(43), alias: 'Anna', since: new Date().toISOString() } };
  writeFileSync(join(home, 'peers.json'), JSON.stringify(pinned));
  await cli('backup');
  const secret = readFileSync(join(home, 'secret.txt'), 'utf8').trim();
  assert.deepEqual(JSON.parse(Buffer.from(secret, 'base64url').toString('utf8')).peers, pinned);

  const fresh = cliHome().home;
  assert.match((await runIn(fresh, { B2B_SECRET: secret })('whoami')).out, /@ben/);
  assert.deepEqual(JSON.parse(readFileSync(join(fresh, 'peers.json'), 'utf8')), pinned);
  assert.ok(!('peers' in JSON.parse(readFileSync(join(fresh, 'config.json'), 'utf8'))));
});

test('join: the bot is handed its doorbell routine right away, reminded until it has one, and its owner gets a few emails', async (t0) => {
  const env = await setup(t0);
  const ben = await login(env, 'ben@example.com');
  const { home } = cliHome();
  const cli = runIn(home);
  const link = linkIn((await cli('join', env.url, '--name', 'ben-bot')).out);
  await ben(link, { method: 'POST', form: { decision: 'allow', bot: 'new', handle: 'ben-bot' } });

  // Joining ends with the exact routine to make on this bot, its instruction straight from the signed texts.
  const steps = /NEXT STEP, do it now[^]*on yourself \(this bot, not another one\) named "b2b doorbell", with a webhook trigger[^]*-----\nb2b messages may be waiting for my owner\. Run `B2B_HOME=\S+ node ~\/bin\/b2b\.mjs inbox --via doorbell`[^]*make the routine first, then add a webhook trigger[^]*Never ask for the key/;
  const done = await cli('join');
  assert.equal(done.code, 0);
  assert.match(done.out, /Joined as @ben-bot[^]*/);
  assert.match(done.out, steps);
  assert.match((await cli('whoami')).out, steps);
  assert.match((await cli('doorbell', 'make')).out, steps);

  // Checking messages reminds it at most once a day to tell its owner the computer step, with the bot's own page.
  const id = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'ben-bot'").get().id;
  assert.match((await cli('inbox')).out, new RegExp(`DOORBELL NOT ON[^]*Tell your owner[^]*On a computer \\(phones don't show it\\), open \\S+/app/bots/${id}[^]*POST to and key[^]*doorbell make`));
  assert.doesNotMatch((await cli('inbox')).out, /DOORBELL NOT ON/);
  // ...and that once a day is shared with everything else the owner asks for.
  assert.doesNotMatch((await cli('contacts')).out, /DOORBELL NOT ON/);

  // A day in with no doorbell, its owner gets one email, which opens with the setup video. Never another.
  const reminders = () => env.mail.filter((m) => /@ben-bot/.test(m.subject) && /One last step|in one minute/.test(m.subject));
  env.advance(2 * 3_600_000);
  await sleep(300);
  assert.equal(reminders().length, 0, 'nothing an hour or two in');
  env.advance(22 * 3_600_000 + 60_000);
  await waitFor(() => reminders().length === 1);
  assert.match(reminders()[0].subject, /Set up @ben-bot in one minute/);
  assert.match(reminders()[0].text, new RegExp(`whole setup in Grok Bot\\.\n\nWatch how it’s done in Grok Bot \\(1 min\\): https://www\\.loom\\.com/share/[^]*COMPUTER ONLY: This needs Grok Bot on a Mac or PC\\. Phones don't show the webhook[^]*/app/bots/${id}[^]*This is the only email about it`));
  assert.match(reminders()[0].html, /<a href="https:\/\/www\.loom\.com\/share\/[^"]+"[^>]*><img src="[^"]*\/art\/doorbell\.jpg"[^]*Computer only[^]*This needs Grok Bot on a Mac or PC/);
  assert.equal((await fetch(`${env.url}/art/doorbell.jpg`)).status, 200);
  env.advance(6 * 86_400_000);
  await sleep(300);
  assert.equal(reminders().length, 1);

  // With its doorbell set, the steps stop.
  assert.equal((await cli('doorbell', 'set', `${env.url}/automations/webhook/1`, '--key', 'k-12345678')).code, 0);
  assert.doesNotMatch((await cli('whoami')).out, /NEXT STEP/);
});

test('doorbell reminder: a doorbell that never passed its test gets the test version, and a failed send is tried again', async (t0) => {
  let failOnce = true;
  const sent = [];
  const env = await setup(t0, { mailer: async (m) => { if (/One last step/.test(m.subject) && failOnce) { failOnce = false; throw new Error('mail down'); } sent.push(m); } });
  const ben = await login(env, 'ben@example.com');
  const { home } = cliHome();
  const cli = runIn(home);
  const link = linkIn((await cli('join', env.url, '--name', 'ben-bot')).out);
  await ben(link, { method: 'POST', form: { decision: 'allow', bot: 'new', handle: 'ben-bot' } });
  await cli('join');
  // A pasted "Authorization: Bearer …" header is taken as just the key.
  assert.equal((await cli('doorbell', 'set', `${env.url}/automations/webhook/1`, '--key', 'Authorization: Bearer k-12345678')).code, 0);
  const row = () => env.relay.db.prepare("SELECT * FROM bots WHERE handle = 'ben-bot'").get();
  env.advance(24 * 3_600_000 + 60_000);
  await waitFor(() => row().doorbell_nudge_fails === 1);
  env.advance(61_000);
  await waitFor(() => sent.some((m) => /One last step for @ben-bot/.test(m.subject)));
  const mail = sent.find((m) => /One last step/.test(m.subject));
  assert.match(mail.html, /One last step: test the doorbell/);
  assert.doesNotMatch(mail.html, /art\/doorbell\.jpg/);
  assert.match(mail.text, /hasn't answered a test ring yet[^]*Ring my bot/);
  env.advance(3 * 3_600_000);
  await sleep(300);
  assert.equal(sent.filter((m) => /One last step/.test(m.subject)).length, 1);
});

test('doorbell reminder in chat: whatever the owner asks for, the bot reminds them once a day, with the computer step', async (t0) => {
  const env = await setup(t0);
  const ben = await login(env, 'ben@example.com');
  const { home } = cliHome();
  const cli = runIn(home);
  const link = linkIn((await cli('join', env.url, '--name', 'ben-bot')).out);
  await ben(link, { method: 'POST', form: { decision: 'allow', bot: 'new', handle: 'ben-bot' } });
  await cli('join');
  const id = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'ben-bot'").get().id;
  const first = await cli('contacts');
  assert.equal(first.code, 0);
  assert.match(first.out, new RegExp(`No contacts yet[^]*DOORBELL NOT ON[^]*On a computer \\(phones don't show it\\), open \\S+/app/bots/${id}`));
  assert.doesNotMatch((await cli('contacts')).out, /DOORBELL/);
  // Set but never answered its test ring: whoami says how to test it from the bot's page.
  assert.equal((await cli('doorbell', 'set', `${env.url}/automations/webhook/1`, '--key', 'k-12345678')).code, 0);
  assert.match((await cli('whoami')).out, new RegExp(`DOORBELL NOT TESTED[^]*/app/bots/${id} and press Ring my bot`));
});
