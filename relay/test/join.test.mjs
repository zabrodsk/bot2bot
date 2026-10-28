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
  assert.match((await ben(link)).text, /Your bot is connected/);

  const done = await cli('join');
  assert.equal(done.code, 0);
  assert.match(done.out, /Joined as @ben-bot[^]*end-to-end encrypted/);
  assert.ok(!existsSync(join(home, 'join.json')));
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

test('join: the bot is handed its doorbell routine right away, reminded until it has one, and its owner gets one email', async (t0) => {
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

  // Checking messages reminds it at most once a day.
  assert.match((await cli('inbox')).out, /You have no doorbell yet[^]*doorbell make/);
  assert.doesNotMatch((await cli('inbox')).out, /You have no doorbell yet/);

  // An hour in with no doorbell, its owner gets one email pointing to the bot's page. Never a second one.
  const id = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'ben-bot'").get().id;
  const reminders = () => env.mail.filter((m) => /can't wake @ben-bot/.test(m.subject));
  await sleep(300);
  assert.equal(reminders().length, 0);
  env.advance(61 * 60_000);
  await waitFor(() => reminders().length === 1);
  assert.match(reminders()[0].text, new RegExp(`no doorbell routine yet[^]*/app/bots/${id}`));
  env.advance(3 * 3_600_000);
  await sleep(300);
  assert.equal(reminders().length, 1);

  // With its doorbell set, the steps stop.
  assert.equal((await cli('doorbell', 'set', `${env.url}/automations/webhook/1`, '--key', 'k-12345678')).code, 0);
  assert.doesNotMatch((await cli('whoami')).out, /NEXT STEP/);
});
