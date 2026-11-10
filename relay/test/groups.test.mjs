// Group chats (0.21): a few people's bots in one chat. Invites wake the invited bot, but only its owner can say yes;
// posts fan out one copy per member (sealed between private-mode bots, plain for connected apps); waking is per member;
// one post counts once against the free allowance; admins remove, end and decide who may add people.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { setup, owner, connect, connectApp, login, waitFor, sleep } from './helpers.mjs';

const CLI = join(import.meta.dirname, '..', 'cli', 'b2b.mjs');
const H = 3_600_000;
const row = (env, id) => env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(id));
// The owner's own yes, the way the dashboard gives it.
const yes = (env, p, gid, opts = {}) => env.relay.groups.join(row(env, p.botId), gid, { byOwner: true, ...opts });
// The bot's doorbell routine is rung but doesn't run (so a test can read the inbox itself).
const asleep = (p) => { p.routine.status = 503; };
const copies = (env, post) => env.relay.db.prepare('SELECT m.*, b.handle FROM messages m JOIN bots b ON b.id = m.to_bot WHERE m.group_post = ? ORDER BY b.handle').all(post);
const lastPost = (env, gid) => env.relay.db.prepare('SELECT * FROM group_posts WHERE group_id = ? AND kind IN (\'note\', \'ask\') ORDER BY created_at DESC, rowid DESC').get(gid);
// What the bot does when it runs: read the inbox, and ack what it read.
async function inbox(p) {
  const out = await p.cli('inbox');
  for (const m of out.matchAll(/^[^|\n].*b2b\.mjs ack (msg_[\w~-]+)$/gm)) await p.cli('ack', m[1]);
  return out;
}
const gidOf = (out) => Number(out.match(/\(number (\d+)\)/)[1]);
const linkCode = (out) => out.match(/\/g\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];

// Ben with two contacts, Anna and Tom.
async function trio(t0, opts) {
  const env = await setup(t0, opts);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  const tom = await owner(env, t0, 'tom@example.com', 'tom');
  await connect(ben, anna, 'Ben');
  await connect(ben, tom, 'Ben');
  return { env, ben, anna, tom };
}
// The same, with "Sunday lunch" made and both of them in it (Anna joined before Tom).
async function lunch(t0, opts) {
  const x = await trio(t0, opts);
  const gid = gidOf(await x.ben.cli('group', 'new', 'Sunday lunch', 'anna', 'tom'));
  x.env.advance(1000); yes(x.env, x.anna, gid);
  x.env.advance(1000); yes(x.env, x.tom, gid);
  return { ...x, gid };
}

test('making a group: the invited bots are woken with the invite, and nothing else reaches them before their owner says yes', async (t0) => {
  const { env, ben, anna, tom } = await trio(t0);
  asleep(anna);
  const ringsBefore = { anna: anna.rings.length, tom: tom.rings.length };
  const made = await ben.cli('group', 'new', 'Sunday lunch', 'anna', 'tom');
  assert.match(made, /Made the group "Sunday lunch" \(number \d+\)\. Invited: "Anna", "Tom"/);
  assert.match(made, /give your owner this link to send them: http:\/\/127\.0\.0\.1:\d+\/g\/[A-Z0-9]{4}-[A-Z0-9]{4}/);
  const gid = gidOf(made);
  // Both are woken now: only their owner can join.
  await waitFor(() => anna.rings.length > ringsBefore.anna && tom.rings.length > ringsBefore.tom);
  const inbox = await anna.cli('inbox');
  assert.match(inbox, new RegExp(`"Ben[^"]*" invited your owner to the group "Sunday lunch"[^]*Only your owner can join\\. Tell them in one short line, with this link, where they say yes: http://127\\.0\\.0\\.1:\\d+/app/groups/${gid}`));
  // The notice was acked by the tool itself: it's not shown again, and it isn't a message to pass on.
  assert.doesNotMatch(inbox, /new message\(s\)/);
  assert.match(await anna.cli('inbox'), /INBOX EMPTY/);
  const invite = env.relay.db.prepare("SELECT * FROM messages WHERE to_bot = ? AND kind = 'group_event'").get(Number(anna.botId));
  assert.equal(invite.status, 'delivered');

  // Ben writes before anyone joined: it reaches nobody, and the invited bots can't read the group yet.
  assert.match(await ben.cli('group', 'send', String(gid), 'Anyone there?'), /Sent gp_[\w-]+ to 0 people in "Sunday lunch"/);
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM messages WHERE group_id = ? AND kind IN ('note', 'ask')").get(gid).n, 0);
  assert.match(await anna.cli('inbox'), /INBOX EMPTY/);
  await assert.rejects(anna.cli('group', 'send', String(gid), 'Me!'), /your owner hasn't said yes yet|hasn't joined/);
  assert.equal((await anna.api('GET', `/v1/groups/${gid}/messages`)).status, 403);
  // The invite shows in the list, saying where the owner joins.
  assert.match(await anna.cli('group', 'list'), new RegExp(`${gid}  "Sunday lunch" · 1 in it · end-to-end encrypted · INVITED: only your owner can join, here: http://127\\.0\\.0\\.1:\\d+/app/groups/${gid}`));
  // A bot can't say yes for its owner.
  const self = await anna.api('POST', `/v1/groups/${gid}/join`);
  assert.equal(self.status, 403);
  assert.match(self.json.error, /only your owner can say yes/);
  assert.equal(env.relay.groups.member(gid, Number(anna.botId)).state, 'invited');
});

test('private-mode bots: a group post is sealed separately to each member, and each bot opens it as said in the group', async (t0) => {
  const { env, ben, anna, tom, gid } = await lunch(t0);
  asleep(anna); asleep(tom);
  await anna.cli('inbox'); await tom.cli('inbox'); // the "joined" notices
  const out = await ben.cli('group', 'send', String(gid), 'Pasta at 1?');
  assert.match(out, /Sent gp_[\w-]+ to 2 people in "Sunday lunch"\. End-to-end encrypted\./);
  const post = lastPost(env, gid);
  assert.equal(post.sealed, 1); assert.equal(post.text, null);
  const cs = copies(env, post.id);
  assert.deepEqual(cs.map((c) => c.handle), ['anna', 'tom']);
  for (const c of cs) { assert.equal(c.text, ''); assert.equal(c.links, '[]'); assert.match(c.sealed, /^b2b1\./); assert.doesNotMatch(c.sealed, /Pasta/); }
  assert.notEqual(cs[0].sealed, cs[1].sealed, 'one seal per member');

  const a = await anna.cli('inbox');
  assert.match(a, /message from "Ben" \(@ben\) in the group "Sunday lunch" · [^\n]* · end-to-end encrypted[^\n]*---\n[^]*\[(\w{4}) start\]\n\| Pasta at 1\?\n\[\1 end\]/);
  assert.match(a, /To write in the group: node ~\/bin\/b2b\.mjs group send \d+ "<text>"/);
  // Tom and Anna aren't contacts: in Tom's inbox Anna goes by her handle.
  const reply = await anna.cli('group', 'send', String(gid), 'Yes, I bring wine');
  assert.match(reply, /to 2 people[^]*End-to-end encrypted/);
  const t = await inbox(tom);
  assert.match(t, /message from "Ben" \(@ben\) in the group "Sunday lunch"[^]*\| Pasta at 1\?/);
  assert.match(t, /message from "@anna" \(@anna\) in the group "Sunday lunch"[^]*\| Yes, I bring wine/);
  // What Tom's bot received, again, when his owner asks.
  assert.match(await tom.cli('group', 'read', String(gid)), /from "@anna" \(@anna\)[^]*\| Yes, I bring wine[^]*from "Ben" \(@ben\)[^]*\| Pasta at 1\?/);
});

test("the relay can't pass a group copy off as a one-to-one message or as a question", async (t0) => {
  const { env, ben, anna, gid } = await lunch(t0);
  asleep(anna);
  await anna.cli('inbox');
  // Re-addressed into Ben and Anna's own chat.
  await ben.cli('group', 'send', String(gid), 'Only for the group');
  const toAnna = (p) => copies(env, p.id).find((c) => c.handle === 'anna');
  const first = toAnna(lastPost(env, gid));
  env.relay.db.prepare('UPDATE messages SET group_id = NULL, group_post = NULL WHERE id = ?').run(first.id);
  let inbox = await anna.cli('inbox');
  assert.match(inbox, /set aside: a message said to be from "Ben" \(@ben\) failed its security check\. Not opened\./);
  assert.doesNotMatch(inbox, /Only for the group/);
  assert.equal(env.relay.db.prepare('SELECT note FROM messages WHERE id = ?').get(first.id).note, 'failed security check');
  // A note made into a question.
  await ben.cli('group', 'send', String(gid), 'Just saying');
  const second = toAnna(lastPost(env, gid));
  env.relay.db.prepare("UPDATE messages SET kind = 'ask' WHERE id = ?").run(second.id);
  inbox = await anna.cli('inbox');
  assert.match(inbox, /set aside: a message said to be from "Ben" \(@ben\) failed its security check/);
  assert.doesNotMatch(inbox, /Just saying/);
  // Moved into another group they're both in.
  const other = gidOf(await ben.cli('group', 'new', 'Book club', 'anna'));
  yes(env, anna, other);
  await anna.cli('inbox');
  await ben.cli('group', 'send', String(gid), 'Lunch only');
  const third = toAnna(lastPost(env, gid));
  env.relay.db.prepare('UPDATE messages SET group_id = ? WHERE id = ?').run(other, third.id);
  inbox = await anna.cli('inbox');
  assert.match(inbox, /set aside[^]*failed its security check/);
  assert.doesNotMatch(inbox, /Lunch only/);
});

test("a quick-connect bot joins: everyone is told once the group isn't end-to-end encrypted, and each member gets what it can read", async (t0) => {
  const { env, ben, anna, gid } = await lunch(t0);
  asleep(anna); asleep(ben);
  await anna.cli('inbox'); await ben.cli('inbox');
  assert.equal((await ben.api('GET', `/v1/groups/${gid}`)).json.end_to_end_encrypted, true);
  // Mia uses the connected app; she joins with Ben's link.
  const mia = { b: await login(env, 'mia@example.com') };
  const app = await connectApp(env, mia.b, 'mia-bot');
  const miaId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'mia-bot'").get().id;
  const code = linkCode(await ben.cli('group', 'link', String(gid)));
  const joined = env.relay.groups.join(row(env, miaId), gid, { linkCode: code, byOwner: true });
  assert.ok(joined.connected, 'joining by a link connects you with whoever made it');
  assert.equal((await ben.api('GET', `/v1/groups/${gid}`)).json.end_to_end_encrypted, false);
  assert.match(await ben.cli('group', 'info', String(gid)), /NOT end-to-end encrypted[^]*\(@mia-bot\)[^]*connected app/);
  for (const p of [ben, anna]) assert.match(await p.cli('inbox'), /"[^"]+"'s bot isn't end-to-end encrypted, so the group "Sunday lunch" isn't anymore\. Tell your owner once/);
  // Told once: a second plain bot joining an already plain group says nothing more.
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM group_posts WHERE group_id = ? AND text = 'not_encrypted'").get(gid).n, 1);

  // Mia's bot writes (plain); the private-mode bots read it, labelled as not encrypted.
  assert.match((await app.tool('send_to_group', { group: String(gid), text: 'I bring cake' })).content[0].text, /Sent to 3 people in "Sunday lunch"\. Not end-to-end encrypted/);
  const fromMia = lastPost(env, gid);
  assert.equal(fromMia.text, 'I bring cake');
  assert.ok(copies(env, fromMia.id).every((c) => c.sealed === null && c.text === 'I bring cake'));
  const seen = await anna.cli('inbox');
  assert.match(seen, /message from "@mia-bot" \(@mia-bot\) in the group "Sunday lunch" · [^\n]* · not end-to-end encrypted ---[^]*\| I bring cake/);

  // Ben writes: sealed to Anna, plain to Mia, and he's told who can't read encrypted messages.
  const out = await ben.cli('group', 'send', String(gid), 'Great, see you at 1', '--ask');
  assert.match(out, /to 3 people in "Sunday lunch"\. Not end-to-end encrypted \("[^"]+" can't read encrypted messages\)/);
  const post = lastPost(env, gid);
  const cs = Object.fromEntries(copies(env, post.id).map((c) => [c.handle, c]));
  assert.ok(cs.anna.sealed); assert.equal(cs.anna.text, '');
  assert.equal(cs['mia-bot'].sealed, null); assert.equal(cs['mia-bot'].text, 'Great, see you at 1');
  assert.match(await anna.cli('inbox'), /QUESTION \(they would like a reply\) from "Ben" \(@ben\) in the group "Sunday lunch" · [^\n]* · end-to-end encrypted[^]*\| Great, see you at 1/);
  // Mia's connected app reads it in check_inbox, as said in the group.
  const inbox = (await app.tool('check_inbox')).content[0].text;
  assert.match(inbox, /QUESTION \(they would like a reply\) from "[^"]+" \(@ben\) in the group "Sunday lunch"[^]*\| Great, see you at 1/);
  assert.match(inbox, /Everyone in "Sunday lunch" reads what you write there[^]*To write in the group: call send_to_group with group=\d+/);
});

test('waking: questions and mentions wake a member now, other messages ride along or wake them at most 3 hours later', async (t0) => {
  const { env, ben, anna, tom, gid } = await lunch(t0);
  const msg = (id) => env.relay.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  const to = (who) => copies(env, lastPost(env, gid).id).find((c) => c.handle === who);
  await sleep(300);
  let a0 = anna.rings.length, t1 = tom.rings.length;
  await ben.cli('group', 'send', String(gid), 'FYI the table is booked');
  const note = to('anna');
  assert.equal(note.next_ring_at, note.created_at + 3 * H, 'a plain message waits for a catch-up ring');
  await sleep(500);
  assert.equal(anna.rings.length, a0); assert.equal(tom.rings.length, t1);
  // Three hours later it rings by itself.
  env.advance(3 * H + 1000);
  await waitFor(() => msg(note.id).status === 'delivered');
  assert.ok(anna.rings.length > a0);

  // A question wakes everyone now.
  a0 = anna.rings.length; t1 = tom.rings.length;
  await ben.cli('group', 'send', String(gid), 'Who brings dessert?', '--ask');
  const ask = to('anna');
  await waitFor(() => anna.rings.length > a0 && tom.rings.length > t1);
  await waitFor(() => msg(ask.id).status === 'delivered');

  // A mention wakes only who's mentioned; Tom's copy waits.
  await sleep(300);
  a0 = anna.rings.length; t1 = tom.rings.length;
  await ben.cli('group', 'send', String(gid), 'Anna, can you bring the cake?', '--mention', 'Anna');
  const forAnna = to('anna'), forTom = to('tom');
  assert.equal(forAnna.mentioned, 1); assert.equal(forTom.mentioned, 0);
  assert.equal(forTom.next_ring_at, forTom.created_at + 3 * H);
  await waitFor(() => anna.rings.length > a0);
  await sleep(400);
  assert.equal(tom.rings.length, t1);
  assert.equal(msg(forTom.id).status, 'pending');

  // "Everything": Tom is woken for a plain message too, and the one waiting rides along.
  assert.match(await tom.cli('group', 'wake', String(gid), 'all'), /woken for every message/);
  await ben.cli('group', 'send', String(gid), 'Parking is behind the house');
  const all = to('tom');
  assert.ok(all.first_rung_at !== null || all.next_ring_at === all.created_at, 'due now');
  await waitFor(() => tom.rings.length > t1);
  await waitFor(() => msg(forTom.id).status === 'delivered');

  // "Muted": nothing wakes Anna, not even a question; it's there whenever her bot runs anyway.
  await sleep(300);
  assert.match(await anna.cli('group', 'wake', String(gid), 'muted'), /woken for nothing/);
  a0 = anna.rings.length;
  await ben.cli('group', 'send', String(gid), 'Anna, red or white?', '--ask', '--mention', 'anna');
  const muted = to('anna');
  assert.equal(muted.next_ring_at, null);
  env.advance(4 * H);
  // Pausing and resuming (which sends held messages out) doesn't make it ring either.
  await anna.b('/app/pause', { method: 'POST', form: { on: '1' } });
  await anna.b('/app/pause', { method: 'POST', form: { on: '0' } });
  await sleep(500);
  assert.equal(msg(muted.id).next_ring_at, null);
  assert.equal(anna.rings.length, a0);
  assert.equal(msg(muted.id).status, 'pending');
  asleep(anna);
  assert.match(await anna.cli('inbox'), /QUESTION[^]*in the group "Sunday lunch" · mentions your owner[^]*\| Anna, red or white\?/);
});

test("a coding agent's watcher doesn't pull a waiting group message forward", async (t0) => {
  const { env, ben, anna, gid } = await lunch(t0, { limits: { watchHoldMs: 300 } });
  env.relay.db.prepare("UPDATE bots SET doorbell_kind = 'watch' WHERE id = ?").run(Number(anna.botId));
  await ben.cli('group', 'send', String(gid), 'No rush');
  const note = copies(env, lastPost(env, gid).id).find((c) => c.handle === 'anna');
  assert.deepEqual((await anna.api('GET', '/v1/watch')).json, { ring: false });
  assert.equal(env.relay.db.prepare('SELECT next_ring_at FROM messages WHERE id = ?').get(note.id).next_ring_at, note.created_at + 3 * H);
});

test('hosted: one group post counts as one message, however many people it reaches; when they are used up, 402', async (t0) => {
  const env = await setup(t0, { hosted: true, billing: { freeMessages: 2, freePeriod: 'day' } });
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const others = [];
  for (const h of ['anna', 'tom', 'kim']) { const p = await owner(env, t0, `${h}@example.com`, h); await connect(ben, p, 'Ben'); others.push(p); }
  const gid = gidOf(await ben.cli('group', 'new', 'Sunday lunch', 'anna', 'tom', 'kim'));
  for (const p of others) yes(env, p, gid);
  assert.match(await ben.cli('group', 'send', String(gid), 'Lunch at 1?'), /to 3 people/);
  assert.match(await ben.cli('whoami'), /Free plan: 1\/2 messages sent today/);
  assert.match(await ben.cli('group', 'send', String(gid), 'At our place'), /to 3 people/);
  assert.match(await ben.cli('whoami'), /Free plan: 2\/2 messages sent today/);
  await assert.rejects(ben.cli('group', 'send', String(gid), 'Bring nothing'), /Relay error 402: your free messages for today are used up/);
  // Receiving is still free: Anna can still post (she has her own two).
  assert.match(await others[0].cli('group', 'send', String(gid), 'I can bring wine'), /to 3 people/);
});

test('loops: the 11th post to one group in 10 minutes is refused (429)', async (t0) => {
  const { ben, gid } = await lunch(t0);
  for (let i = 1; i <= 10; i++) assert.match(await ben.cli('group', 'send', String(gid), `Message ${i}`), /Sent gp_/);
  await assert.rejects(ben.cli('group', 'send', String(gid), 'Message 11'), /too many messages to this group in 10 minutes/);
});

test("joining by a member's link connects the joiner with them, not sorted yet, and both bots can then message one to one", async (t0) => {
  const { env, ben, anna, gid } = await lunch(t0);
  const kim = await owner(env, t0, 'kim@example.com', 'kim');
  // Kim isn't Ben's contact: he can't be added by name, only by link.
  await assert.rejects(ben.cli('group', 'add', String(gid), 'kim'), /no contact called "kim"/);
  const linkOut = await ben.cli('group', 'link', String(gid));
  assert.match(linkOut, /Join our group "Sunday lunch" on bot2bot[^]*\/g\/[A-Z0-9]{4}-[A-Z0-9]{4}/);
  const code = linkCode(linkOut);
  // The bot can't use the link for its owner.
  assert.equal((await kim.api('POST', `/v1/groups/${gid}/join`)).status, 404, "it isn't even in the group's list yet");
  const r = yes(env, kim, gid, { linkCode: code });
  assert.ok(r.connected);
  const c = (o, p) => env.relay.db.prepare('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(Number(o.botId), Number(p.botId));
  for (const [o, p] of [[ben, kim], [kim, ben]]) {
    assert.ok(c(o, p).approved_at, 'both sides said yes');
    assert.equal(c(o, p).circle_id, null, 'not sorted yet');
    assert.equal(c(o, p).blocked, 0);
  }
  // Anna is only "in a group with" Kim.
  assert.equal(c(anna, kim), undefined);
  assert.match(await kim.cli('send', c(kim, ben).alias, 'Hi Ben, Kim here'), /Sent msg_[^]*End-to-end encrypted/);
  assert.match(await ben.cli('send', c(ben, kim).alias, 'Welcome Kim'), /Sent msg_[^]*End-to-end encrypted/);
  // An expired or unknown code doesn't let anyone in.
  const lea = await owner(env, t0, 'lea@example.com', 'lea');
  assert.throws(() => yes(env, lea, gid, { linkCode: 'ZZZZ-ZZZZ' }), (e) => e.status === 410);
});

test('a group holds 8 people, invited ones included (409 after that)', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const friends = [];
  for (let i = 1; i <= 8; i++) { const p = await owner(env, t0, `friend${i}@example.com`, `friend${i}`); await connect(ben, p, 'Ben'); friends.push(p); }
  // Ben and six invited friends: 7 seats.
  const gid = gidOf(await ben.cli('group', 'new', 'Big family', ...friends.slice(0, 6).map((_, i) => `friend${i + 1}`)));
  for (const p of friends.slice(0, 3)) yes(env, p, gid);
  // The 8th seat by link, then nobody more: not by name, not by link.
  const code = linkCode(await ben.cli('group', 'link', String(gid)));
  yes(env, friends[6], gid, { linkCode: code });
  await assert.rejects(ben.cli('group', 'add', String(gid), 'friend8'), /the group is full \(8 people\)/);
  assert.throws(() => yes(env, friends[7], gid, { linkCode: code }), (e) => e.status === 409 && /full/.test(e.message));
  // Invited people who say yes still fit: their seat was theirs already.
  for (const p of friends.slice(3, 6)) yes(env, p, gid);
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM group_members WHERE group_id = ? AND state = 'joined'").get(gid).n, 8);
});

test("someone removed can't come back by link, but an admin can invite them again by name", async (t0) => {
  const { env, ben, anna, gid } = await lunch(t0);
  const code = linkCode(await ben.cli('group', 'link', String(gid)));
  assert.match(await ben.cli('group', 'remove', String(gid), 'anna'), /Removed "Anna" from "Sunday lunch"/);
  assert.equal(env.relay.groups.member(gid, Number(anna.botId)).state, 'removed');
  assert.throws(() => yes(env, anna, gid, { linkCode: code }), (e) => e.status === 403 && /an admin removed you/.test(e.message));
  assert.match(await ben.cli('group', 'add', String(gid), 'anna'), /"Anna": invited/);
  yes(env, anna, gid);
  assert.equal(env.relay.groups.member(gid, Number(anna.botId)).state, 'joined');
  assert.match(await ben.cli('group', 'send', String(gid), 'Welcome back'), /to 2 people/);
});

test('admins: members get 403 for admin-only things, and "only admins can add people" stops members inviting', async (t0) => {
  const { anna, ben, gid } = await lunch(t0);
  const g = String(gid);
  await assert.rejects(anna.cli('group', 'remove', g, 'tom'), /only admins can do that/);
  await assert.rejects(anna.cli('group', 'admin', g, 'tom'), /only admins can do that/);
  await assert.rejects(anna.cli('group', 'end', g), /only admins can do that/);
  assert.equal((await anna.api('PATCH', `/v1/groups/${gid}`, { only_admins_add: true })).status, 403);
  assert.equal((await anna.api('PATCH', `/v1/groups/${gid}`, { reset_links: true })).status, 403);
  // Anyone can still rename and pick their own waking.
  assert.match(await anna.cli('group', 'rename', g, 'Sunday lunch!'), /Renamed to "Sunday lunch!"/);
  // Members may invite, until an admin says only admins may; then their links stop working too.
  const annaCode = linkCode(await anna.cli('group', 'link', g));
  assert.equal((await ben.api('PATCH', `/v1/groups/${gid}`, { only_admins_add: true })).json.only_admins_add, true);
  await assert.rejects(anna.cli('group', 'link', g), /only admins can add people to this group/);
  await assert.rejects(anna.cli('group', 'add', g, 'Ben'), /only admins can add people to this group/);
  assert.equal(anna.b.env.relay.groups.linkByCode(annaCode), null);
  assert.match(await ben.cli('group', 'link', g), /\/g\/[A-Z0-9]{4}-[A-Z0-9]{4}/);
  // An admin makes Anna admin: now she can.
  assert.match(await ben.cli('group', 'admin', g, 'Anna'), /"Anna" is now an admin/);
  assert.match(await anna.cli('group', 'link', g), /\/g\/[A-Z0-9]{4}-[A-Z0-9]{4}/);
});

test('the last admin leaving makes whoever has been in the group longest admin', async (t0) => {
  const { env, ben, anna, tom, gid } = await lunch(t0);
  const role = (p) => env.relay.groups.member(gid, Number(p.botId));
  assert.equal(role(ben).role, 'admin');
  assert.match(await ben.cli('group', 'leave', String(gid)), /Left the group/);
  assert.equal(role(ben).state, 'left');
  assert.equal(role(anna).role, 'admin', 'Anna joined before Tom');
  assert.equal(role(tom).role, 'member');
  // Nothing more reaches Ben.
  assert.match(await tom.cli('group', 'send', String(gid), 'Ben left'), /to 1 person/);
  // The last one out ends it.
  await anna.cli('group', 'leave', String(gid));
  await tom.cli('group', 'leave', String(gid));
  assert.ok(env.relay.groups.group(gid).ended_at);
});

test("removing someone drops what's still waiting for them, tells them, and later posts don't reach them", async (t0) => {
  const { env, ben, tom, gid } = await lunch(t0);
  asleep(tom);
  await tom.cli('inbox');
  await ben.cli('group', 'send', String(gid), 'Tom, still coming?');
  const waiting = copies(env, lastPost(env, gid).id).find((c) => c.handle === 'tom');
  assert.equal(waiting.status, 'pending');
  await ben.cli('group', 'remove', String(gid), 'Tom');
  const after = env.relay.db.prepare('SELECT * FROM messages WHERE id = ?').get(waiting.id);
  assert.equal(after.status, 'dropped'); assert.equal(after.sealed, null);
  const told = await tom.cli('inbox');
  assert.match(told, /An admin removed your owner from the group "Sunday lunch"\. Tell them once/);
  assert.doesNotMatch(told, /still coming/);
  assert.match(await ben.cli('group', 'send', String(gid), 'Just us then'), /to 1 person/);
  assert.equal(copies(env, lastPost(env, gid).id).some((c) => c.handle === 'tom'), false);
  await assert.rejects(tom.cli('group', 'send', String(gid), 'Hello?'), /no group called|not in this group/);
});

test('ending a group drops what is still waiting and tells everyone', async (t0) => {
  const { env, ben, anna, tom, gid } = await lunch(t0);
  asleep(anna); asleep(tom);
  await anna.cli('inbox'); await tom.cli('inbox');
  await ben.cli('group', 'send', String(gid), 'Last call');
  const waiting = copies(env, lastPost(env, gid).id);
  assert.match(await ben.cli('group', 'end', String(gid)), /ended for everyone/);
  for (const c of waiting) assert.equal(env.relay.db.prepare('SELECT status FROM messages WHERE id = ?').get(c.id).status, 'dropped');
  for (const p of [anna, tom]) {
    const out = await p.cli('inbox');
    assert.match(out, /The group "Sunday lunch" was ended\. Tell your owner once/);
    assert.doesNotMatch(out, /Last call/);
  }
  await assert.rejects(anna.cli('group', 'send', String(gid), 'Wait'), /no group called/);
  assert.match(await ben.cli('group', 'list'), /No groups yet/);
});

test("blocking: posts from someone a member blocked don't reach them", async (t0) => {
  const { env, ben, anna, tom, gid } = await lunch(t0);
  asleep(anna);
  await anna.cli('inbox');
  assert.equal((await anna.api('POST', '/v1/contacts/block', { contact: 'Ben' })).status, 200);
  assert.match(await ben.cli('group', 'send', String(gid), 'Hello all'), /to 1 person/);
  assert.deepEqual(copies(env, lastPost(env, gid).id).map((c) => c.handle), ['tom']);
  assert.match(await anna.cli('inbox'), /INBOX EMPTY/);
  // Tom's posts still reach both.
  assert.match(await tom.cli('group', 'send', String(gid), 'Hi'), /to 2 people/);
});

test("new members don't see what was said before they joined", async (t0) => {
  const { env, ben, anna, gid } = await lunch(t0);
  const kim = await owner(env, t0, 'kim@example.com', 'kim');
  await connect(ben, kim, 'Ben');
  await inbox(anna);
  await ben.cli('group', 'send', String(gid), 'Before Kim');
  await inbox(anna);
  env.advance(1000);
  await ben.cli('group', 'add', String(gid), 'kim');
  yes(env, kim, gid);
  asleep(kim);
  await ben.cli('group', 'send', String(gid), 'After Kim');
  await inbox(anna);
  const k = await inbox(kim);
  assert.match(k, /\| After Kim/); assert.doesNotMatch(k, /Before Kim/);
  const read = await kim.cli('group', 'read', String(gid));
  assert.match(read, /\| After Kim/); assert.doesNotMatch(read, /Before Kim/);
  assert.deepEqual((await kim.api('GET', `/v1/groups/${gid}/messages`)).json.messages.length, 1);
  // Anna, who was there, has both.
  assert.match(await anna.cli('group', 'read', String(gid)), /After Kim[^]*Before Kim/);
  // The dashboard's page too.
  assert.deepEqual(env.relay.groups.page(gid, Number(kim.botId)).posts.filter((p) => p.kind === 'note').map((p) => p.from_bot), [Number(ben.botId)]);
});

test("after 7 days a group post's text is erased", async (t0) => {
  const { env, gid } = await lunch(t0);
  const mia = { b: await login(env, 'mia@example.com') };
  const app = await connectApp(env, mia.b, 'mia-bot');
  const miaId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'mia-bot'").get().id;
  const ben = env.relay.db.prepare("SELECT * FROM bots WHERE handle = 'ben'").get();
  const l = env.relay.groups.link(ben, gid);
  env.relay.groups.join(row(env, miaId), gid, { linkCode: l.link.split('/g/')[1], byOwner: true });
  await app.tool('send_to_group', { group: String(gid), text: 'Plain words' });
  const id = lastPost(env, gid).id;
  assert.equal(env.relay.db.prepare('SELECT text FROM group_posts WHERE id = ?').get(id).text, 'Plain words');
  env.advance(6 * 24 * H);
  env.relay.retention();
  assert.equal(env.relay.db.prepare('SELECT text FROM group_posts WHERE id = ?').get(id).text, 'Plain words');
  env.advance(1 * 24 * H + 60_000);
  env.relay.retention();
  const p = env.relay.db.prepare('SELECT * FROM group_posts WHERE id = ?').get(id);
  assert.equal(p.text, null); assert.ok(p.body_purged_at);
});

test('b2b mcp: the group tools are there, and send_to_group posts sealed over stdio', async (t0) => {
  const { env, ben, gid } = await lunch(t0);
  const ch = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, B2B_HOME: ben.home } });
  t0.after(() => ch.kill());
  let buf = ''; const waiting = new Map();
  ch.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); } });
  let id = 0;
  const rpc = (method, params = {}) => new Promise((ok) => { const n = ++id; waiting.set(n, ok); ch.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
  await rpc('initialize', { protocolVersion: '2025-06-18' });
  const names = (await rpc('tools/list')).result.tools.map((t) => t.name);
  for (const n of ['list_groups', 'create_group', 'add_to_group', 'group_link', 'send_to_group', 'group_messages', 'group_wake', 'leave_group']) assert.ok(names.includes(n), n);
  const r = await rpc('tools/call', { name: 'send_to_group', arguments: { group: 'Sunday lunch', text: '--ask is just text "here"', mention: ['Anna'] } });
  assert.match(r.result.content[0].text, /to 2 people in "Sunday lunch"\. End-to-end encrypted\./);
  const post = lastPost(env, gid);
  assert.equal(post.kind, 'note'); assert.equal(post.sealed, 1);
  assert.deepEqual(JSON.parse(post.mentions), ['@anna']);
  assert.match((await rpc('tools/call', { name: 'list_groups', arguments: {} })).result.content[0].text, /"Sunday lunch" · 3 in it · end-to-end encrypted/);
});

test("a bot whose tool is too old to open group messages can't join until it updates (426)", async (t0) => {
  const { env, ben } = await trio(t0);
  const kim = await owner(env, t0, 'kim@example.com', 'kim');
  await connect(ben, kim, 'Ben');
  const gid = gidOf(await ben.cli('group', 'new', 'Sunday lunch', 'kim'));
  env.relay.db.prepare("UPDATE bots SET tool_version = '0.20.7' WHERE id = ?").run(Number(kim.botId));
  assert.equal(env.relay.groups.toolReady(row(env, kim.botId)), false);
  assert.throws(() => yes(env, kim, gid), (e) => e.status === 426);
  assert.equal(env.relay.groups.member(gid, Number(kim.botId)).state, 'invited');
  env.relay.db.prepare("UPDATE bots SET tool_version = '0.21.0' WHERE id = ?").run(Number(kim.botId));
  assert.equal(env.relay.groups.toolReady(row(env, kim.botId)), true);
  yes(env, kim, gid);
  assert.equal(env.relay.groups.member(gid, Number(kim.botId)).state, 'joined');
});
