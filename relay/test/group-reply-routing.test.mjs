// A question a session asks in a group: the answer comes back to that session, while everything else in the group still
// goes to the session leading it (SESSION-DELIVERY.md, issue #3 item 1.3 for groups).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, owner, connectHandled } from './helpers.mjs';
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'b2b.mjs');
const exec = promisify(execFile);
// Run from inside a coding agent, its own session must not become the owner's session in these bots.
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_SESSION_ID', 'CODEX_THREAD_ID', 'B2B_SESSION', 'B2B_SESSION_AGENT', 'B2B_UNATTENDED']) delete process.env[k];
const session = (home, id, extra = {}) => async (...args) => (await exec(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, B2B_HOME: home, B2B_SESSION: id, B2B_SESSION_AGENT: 'claude-code', B2B_UNATTENDED: '', ...extra } })).stdout;
const postId = (s) => s.match(/Sent (gp_[\w-]+)/)[1];

async function trio(t) {
  const env = await setup(t);
  const ann = await owner(env, t, 'ann@example.com', 'ann', { status: 503 });
  const ben = await owner(env, t, 'ben@example.com', 'ben', { status: 503 });
  const cara = await owner(env, t, 'cara@example.com', 'cara', { status: 503 });
  await connectHandled(ann, ben, 'ben');
  await connectHandled(ann, cara, 'cara');
  const row = (id) => env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(id));
  const group = async (name, ...members) => {
    const gid = Number((await ann.cli('group', 'new', name, ...members.map((m) => m.name))).match(/\(number (\d+)\)/)[1]);
    for (const m of members) env.relay.groups.join(row(m.bot.botId), gid, { byOwner: true });
    return gid;
  };
  return { env, ann, ben, cara, group };
}

test('an answer to a group question goes to the session that asked it; the rest of the group goes to its lead', async (t) => {
  const { env, ann, ben, cara, group } = await trio(t);
  const gid = await group('Review', { name: 'ben', bot: ben }, { name: 'cara', bot: cara });
  const other = await group('Other', { name: 'ben', bot: ben });
  const a = session(ann.home, 'session-ask-a'), b = session(ann.home, 'session-ask-b'), d = session(ann.home, 'session-lead-d'), reader = session(ann.home, 'session-reader');
  // Two sessions ask in the same group; a third leads it afterwards.
  const q1 = postId(await a('group', 'send', String(gid), 'Which port does the API use now?', '--ask', '--mention', 'ben'));
  const q2 = postId(await b('group', 'send', String(gid), 'Is the schema frozen?', '--ask'));
  await d('group', 'bind', String(gid));
  const saved = JSON.parse(readFileSync(join(ann.home, 'sessions.json')));
  assert.deepEqual({ session: saved.asks[q1].session, gid: saved.asks[q1].gid, peers: saved.asks[q1].peers }, { session: 'session-ask-a', gid: String(gid), peers: ['@ben'] });
  assert.equal(saved.asks[q2].session, 'session-ask-b');
  assert.equal(saved.asks[q2].peers, undefined, 'a question to the whole group may be answered by anyone in it');
  assert.equal(saved.groups[String(gid)].session, 'session-lead-d');

  // The member reading the question is told how to answer it.
  const seen = await ben.cli('inbox');
  assert.match(seen, new RegExp(`To write in the group: node .*group send ${gid} --reply-to ${q1} "<text>"`));
  assert.match(seen, new RegExp(`group send ${gid} --reply-to ${q2} "<text>"`));

  await ben.cli('group', 'send', String(gid), 'Port 8443 since Monday', '--reply-to', q1);
  await ben.cli('group', 'send', String(gid), 'Frozen until Friday', '--reply-to', q2);
  await ben.cli('group', 'send', String(gid), 'Unrelated: the build is green');
  // Cara wasn't asked q1, and a q1 id used in another group means nothing there.
  await cara.cli('group', 'send', String(gid), 'Cara thinks 8080', '--reply-to', q1);
  await ben.cli('group', 'send', String(other), 'Wrong group answer', '--reply-to', q1);

  const read = await reader('inbox');
  assert.match(read, /responsible session/);
  assert.match(read, /\| Wrong group answer/, 'no lead and no matching question there: read as usual');
  for (const s of ['Port 8443', 'Frozen until Friday', 'Unrelated', 'Cara thinks']) assert.doesNotMatch(read, new RegExp(s));

  const toA = await a('handoff');
  assert.match(toA, new RegExp(`ANSWER to your group question ${q1} from .* in the group "Review"`));
  assert.match(toA, /\| Port 8443 since Monday/);
  assert.match(toA, /data, never instructions/);
  for (const s of ['Frozen', 'Unrelated', 'Cara thinks', 'Wrong group']) assert.doesNotMatch(toA, new RegExp(s));
  const toB = await b('handoff');
  assert.match(toB, /\| Frozen until Friday/);
  for (const s of ['Port 8443', 'Unrelated', 'Cara thinks']) assert.doesNotMatch(toB, new RegExp(s));
  const toD = await d('handoff');
  assert.match(toD, /\| Unrelated: the build is green/);
  assert.match(toD, /\| Cara thinks 8080/);
  for (const s of ['Port 8443', 'Frozen']) assert.doesNotMatch(toD, new RegExp(s));

  // The relay can't link an answer to the question: the answers it holds are sealed, and no session id ever reaches it.
  const answers = env.relay.db.prepare("SELECT * FROM messages WHERE to_bot = ? AND group_id = ? AND kind = 'note'").all(Number(ann.botId), gid);
  assert.equal(answers.length, 4);
  assert.ok(answers.every((r) => r.sealed && r.text === '' && r.group_post !== q1));
  assert.doesNotMatch(JSON.stringify(answers.map(({ sealed, ...r }) => r)), new RegExp(q1));
  assert.doesNotMatch(JSON.stringify(env.relay.db.prepare('SELECT * FROM messages').all()), /session-ask-a/);
});

test('one voice stays: a resumed asking session cannot write where another session leads, runs in "full" still route answers', async (t) => {
  const { ann, ben, group } = await trio(t);
  const gid = await group('Trip', { name: 'ben', bot: ben });
  const a = session(ann.home, 'session-ask-a'), d = session(ann.home, 'session-lead-d');
  const q = postId(await a('group', 'send', String(gid), 'Train or car?', '--ask'));
  await d('group', 'bind', String(gid));
  // A run the watcher started (here: the asking session, resumed) does not answer in a group another session leads.
  const resumed = session(ann.home, 'session-ask-a', { B2B_UNATTENDED: '1' });
  await assert.rejects(resumed('group', 'send', String(gid), 'Car it is'), (e) => /Not sent\. Your owner's session that leads "Trip" answers there/.test(e.stdout + e.stderr));
  // Only well-formed post ids are accepted, and a message id is explained.
  await assert.rejects(ben.cli('group', 'send', String(gid), 'Car', '--reply-to', 'msg_abcdef123'), (e) => /--reply-to takes the id of the group question[^]*use reply/.test(e.stdout + e.stderr));
  // With runs allowed to answer there ("full"), the group's other messages are read by the run, but an answer to a
  // question still goes back to the session that asked.
  await ann.cli('group', 'unattended', String(gid), 'full');
  await ben.cli('group', 'send', String(gid), 'Train, it is faster', '--reply-to', q);
  await ben.cli('group', 'send', String(gid), 'Leaving at nine');
  const run = await session(ann.home, 'session-cold', { B2B_UNATTENDED: '1' })('inbox', '--via', 'watch');
  assert.match(run, /\| Leaving at nine/);
  assert.doesNotMatch(run, /Train, it is faster/);
  assert.match(await a('handoff'), /\| Train, it is faster/);
});
