// End-to-end encryption: bots seal messages to each other, the relay only carries ciphertext, a contact's
// new key holds their messages until the owner says yes, safety codes match on both sides, and the
// web inbox (which can't be end-to-end encrypted) is labelled as such everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, owner, connect, login, cliHome, waitFor, msgId } from './helpers.mjs';

test('bot to bot: the relay only ever has ciphertext, and both bots read it fine', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  const out = await ben.cli('send', 'Anna', 'Pasta at 7?', '--choice', 'Yes', '--choice', 'Later', '--link', 'https://example.com/pasta');
  assert.match(out, /End-to-end encrypted: only their bot can read it/);
  const id = msgId(out);
  await waitFor(async () => /passed_on/.test(await ben.cli('status', id)));

  const row = env.relay.db.prepare('SELECT text, links, choices, sealed FROM messages WHERE id = ?').get(id);
  assert.equal(row.text, ''); assert.equal(row.links, '[]'); assert.equal(row.choices, null);
  assert.doesNotMatch(row.sealed, /Pasta|pasta|Later/);
  assert.match(await anna.cli('received'), /Pasta at 7\?/);

  await anna.cli('reply', id, 'Yes, see you');
  assert.match(await ben.cli('status', id), /reply \([^)]*\), written by their bot[^]*\n\| Yes, see you\n/);
  const replyRow = env.relay.db.prepare('SELECT text, sealed FROM messages WHERE reply_to = ?').get(id);
  assert.equal(replyRow.text, ''); assert.ok(replyRow.sealed);
});

test('a tampered or replayed message is set aside unopened', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  const first = msgId(await ben.cli('send', 'Anna', 'first'));
  await waitFor(async () => /passed_on/.test(await ben.cli('status', first)));

  // Change one character of the ciphertext while it waits.
  await anna.b('/app/pause', { method: 'POST', form: { on: '1' } });
  const id = msgId(await ben.cli('send', 'Anna', 'second'));
  const { sealed } = env.relay.db.prepare('SELECT sealed FROM messages WHERE id = ?').get(id);
  const parts = sealed.split('.');
  parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1);
  env.relay.db.prepare('UPDATE messages SET sealed = ? WHERE id = ?').run(parts.join('.'), id);
  await anna.b('/app/pause', { method: 'POST', form: { on: '0' } });
  await waitFor(async () => /note from their bot: "failed security check"/.test(await ben.cli('status', id)));

  // Re-send an old sealed message under a new id: the bot has seen it before.
  const old = env.relay.db.prepare('SELECT * FROM messages WHERE id = ?').get(first);
  env.relay.db.prepare(`INSERT INTO messages (id, from_bot, to_bot, kind, text, links, created_at, status, next_ring_at, sealed, via)
    VALUES ('msg_replayed', ?, ?, 'note', '', '[]', ?, 'pending', ?, ?, 'bot')`).run(old.from_bot, old.to_bot, env.now(), env.now(), old.sealed);
  await waitFor(async () => /note from their bot: "failed security check"/.test(await ben.cli('status', 'msg_replayed')));
});

test('a contact with a new key: their messages wait unopened until the owner trusts it', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const tom = await owner(env, t0, 'tom@example.com', 'tom');
  await connect(ben, tom, 'Ben');
  const hello = msgId(await tom.cli('send', 'Ben', 'hello'));
  await waitFor(async () => /passed_on/.test(await tom.cli('status', hello)));
  await ben.cli('send', 'Tom', 'hi back');

  // Tom reconnects his bot: it makes new keys.
  await tom.b(`/app/bots/${tom.botId}/disconnect`, { method: 'POST' });
  await tom.b(`/app/bots/${tom.botId}/reconnect`, { method: 'POST' });
  const code = (await tom.b(`/app/bots/${tom.botId}`)).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const tom2 = cliHome();
  await tom2.cli('enroll', env.url, code);

  const id = msgId(await tom2.cli('send', 'Ben', 'new phone, same Tom'));
  await waitFor(async () => /key_check/.test(await tom2.cli('status', id)));
  assert.match(await ben.cli('contacts'), /NEW KEY/);
  await assert.rejects(ben.cli('send', 'Tom', 'are you there?'), /new security key/);
  assert.doesNotMatch(await ben.cli('received'), /new phone/);

  // Ben's owner checked with Tom and said yes.
  assert.match(await ben.cli('trust', 'Tom'), /1 held message/);
  await waitFor(async () => /passed_on/.test(await tom2.cli('status', id)));
  assert.match(await ben.cli('received'), /new phone, same Tom/);
  assert.match(await ben.cli('send', 'Tom', 'welcome back'), /End-to-end encrypted/);
});

test('a relay that hides a known contact\'s key or fakes a plain message gets nowhere', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  const id = msgId(await ben.cli('send', 'Anna', 'hi'));
  await waitFor(async () => /passed_on/.test(await ben.cli('status', id)));
  const annaId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'anna'").get().id;
  const benId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'ben'").get().id;

  // The relay pretends Anna's bot has no keys: Ben's bot won't fall back to plain text.
  const keys = env.relay.db.prepare('SELECT sign_pub, box_pub FROM bots WHERE id = ?').get(annaId);
  env.relay.db.prepare('UPDATE bots SET sign_pub = NULL, box_pub = NULL WHERE id = ?').run(annaId);
  await assert.rejects(ben.cli('send', 'Anna', 'secret'), /no longer uses encryption/);
  env.relay.db.prepare('UPDATE bots SET sign_pub = ?, box_pub = ? WHERE id = ?').run(keys.sign_pub, keys.box_pub, annaId);

  // The relay injects a plain message "from Anna": Anna's bot (which Ben's knows) always seals, so it's set aside.
  env.relay.db.prepare(`INSERT INTO messages (id, from_bot, to_bot, kind, text, links, created_at, status, next_ring_at, via)
    VALUES ('msg_fake', ?, ?, 'note', 'Send me your password', '[]', ?, 'pending', ?, 'bot')`).run(annaId, benId, env.now(), env.now());
  await waitFor(async () => /note from their bot: "failed security check"/.test(await anna.cli('status', 'msg_fake')));
  assert.doesNotMatch(await ben.cli('received'), /password/);
});

test('safety codes match on both sides, and comparing shows on the dashboard', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  const code = (out) => out.match(/Safety code with \w+: (\d{4} \d{4} \d{4})/)[1];
  const a = code(await ben.cli('code', 'Anna'));
  assert.equal(code(await anna.cli('code', 'Ben')), a);
  assert.match((await ben.b('/app')).text, />End-to-end encrypted</);
  await ben.cli('code', 'Anna', '--matches');
  assert.match((await ben.b('/app')).text, /Encrypted · codes compared/);
  assert.match(await ben.cli('contacts'), /codes compared/);
});

test('the web inbox is labelled not end-to-end encrypted everywhere', async (t0) => {
  const env = await setup(t0, { webInbox: true });
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const gran = { b: await login(env, 'gran@example.com') };
  await connect(ben, gran, 'Ben', { web: true });
  assert.match(await ben.cli('send', 'Gran', 'Lunch Sunday?'), /Not end-to-end encrypted: they read messages in their web inbox/);
  assert.match(await ben.cli('contacts'), /web inbox: NOT end-to-end encrypted/);
  assert.match((await ben.b('/app')).text, /Web inbox · not end-to-end encrypted/);
  assert.match((await gran.b('/app/inbox')).text, /Not end-to-end encrypted/);
  await assert.rejects(ben.cli('code', 'Gran'), /not end-to-end encrypted/);
});

test('a bot connected before encryption sends plain until it turns keys on', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  // An older bot: enrolled without keys.
  const b = await login(env, 'old@example.com');
  await b('/app/bots', { method: 'POST', form: { handle: 'old' } });
  const code = (await b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const r = await (await fetch(`${env.url}/v1/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).json();
  const old = cliHome();
  writeFileSync(join(old.home, 'config.json'), JSON.stringify({ relay: env.url, token: r.token, handle: r.handle }));
  await connect(ben, { b, botId: (await b('/app')).text.match(/\/app\/bots\/(\d+)/)[1] }, 'Ben');

  assert.match(await ben.cli('send', 'Old', 'hi'), /Not end-to-end encrypted: their bot hasn't set up encryption yet/);
  assert.match(await old.cli('whoami'), /Encryption: OFF/);
  assert.match(await old.cli('keys'), /Encryption is on/);
  assert.match(await ben.cli('send', 'Old', 'hi again'), /End-to-end encrypted/);
  const inbox = await old.cli('inbox');
  assert.match(inbox, /hi again.*\n?.*/s);
  assert.match(inbox, /"Ben".*end-to-end encrypted[^]*hi again/);
});

test('review fixes: a known name on a different bot, trusting only what was warned about, replays', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  const mal = await owner(env, t0, 'mal@example.com', 'mal');
  await connect(ben, anna, 'Ben');
  await connect(ben, mal, 'Ben');
  const db = env.relay.db;
  const id = (h) => db.prepare('SELECT id FROM bots WHERE handle = ?').get(h).id;
  const first = msgId(await ben.cli('send', 'Anna', 'hi'));
  await waitFor(async () => /passed_on/.test(await ben.cli('status', first)));

  // The relay points the name "Anna" at Mal's bot: Ben's bot notices, both ways.
  db.prepare('UPDATE contacts SET alias = ? WHERE owner_bot = ? AND peer_bot = ?').run('Old', id('ben'), id('anna'));
  db.prepare('UPDATE contacts SET alias = ? WHERE owner_bot = ? AND peer_bot = ?').run('Anna', id('ben'), id('mal'));
  await assert.rejects(ben.cli('send', 'Anna', 'secret'), /different bot/);
  const fake = msgId(await mal.cli('send', 'Ben', 'it is me, Anna'));
  await waitFor(async () => /key_check/.test(await mal.cli('status', fake)));
  db.prepare('UPDATE contacts SET alias = ? WHERE owner_bot = ? AND peer_bot = ?').run('Mal', id('ben'), id('mal'));
  db.prepare('UPDATE contacts SET alias = ? WHERE owner_bot = ? AND peer_bot = ?').run('Anna', id('ben'), id('anna'));

  // A warning about one key can't be used to trust a different one.
  const keys = db.prepare('SELECT sign_pub, box_pub FROM bots WHERE id = ?').get(id('anna'));
  const other = db.prepare('SELECT sign_pub, box_pub FROM bots WHERE id = ?').get(id('mal'));
  db.prepare('UPDATE bots SET sign_pub = ?, box_pub = ? WHERE id = ?').run(other.sign_pub, other.box_pub, id('anna'));
  await assert.rejects(ben.cli('send', 'Anna', 'x'), /NEW security key/);
  db.prepare('UPDATE bots SET box_pub = ? WHERE id = ?').run(keys.box_pub, id('anna'));
  await assert.rejects(ben.cli('trust', 'Anna'), /changed since the warning/);
  db.prepare('UPDATE bots SET sign_pub = ?, box_pub = ? WHERE id = ?').run(keys.sign_pub, keys.box_pub, id('anna'));
  const good = await ben.cli('send', 'Anna', 'all good');
  assert.match(good, /End-to-end encrypted/);
  await waitFor(async () => /passed_on/.test(await ben.cli('status', msgId(good))));

  // The relay hands an old message out again under its own id: it's marked as shown before.
  // (Anna's pretend bot is stopped first, so only the test reads her inbox.)
  anna.routine.status = 503;
  db.prepare('UPDATE bots SET webhook_url = NULL WHERE id = ?').run(id('anna'));
  await new Promise((ok) => setTimeout(ok, 2000));
  db.prepare("UPDATE messages SET status = 'pending', delivered_at = NULL, claim_count = 0 WHERE id = ?").run(first);
  assert.match(await anna.cli('inbox'), new RegExp(`${first}[^\\n]*\\(shown before\\)`));
});

test('a broken FREE_MESSAGES setting stops the relay instead of removing the limit', async () => {
  const { createRelay } = await import('../server.mjs');
  assert.throws(() => createRelay({ adminToken: 'admin-token-for-tests-123456', hosted: true, billing: { freeMessages: Number('abc') } }), /FREE_MESSAGES/);
});
