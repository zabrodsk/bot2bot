// Project routing and task delivery through a local relay with fake providers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, mkdtempSync, chmodSync, realpathSync, existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, login, cliHome, waitFor, sleep, owner, connectHandled, connectApp, listen, REDIRECT } from './helpers.mjs';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'b2b.mjs');
const runIn = (home, env = {}, cwd = undefined) => async (...a) => {
  try { const r = await run(process.execPath, [CLI, ...a], { cwd, env: { ...process.env, B2B_HOME: home, HOME: home, B2B_UNATTENDED: '', ...env } }); return { code: 0, out: r.stdout + r.stderr }; }
  catch (e) { return { code: e.code, out: `${e.stdout}${e.stderr}` }; }
};
// A hook the agent runs: what it hands over on stdin (its session and folder), and what the hook prints.
const hook = (home, input, ...args) => new Promise((ok, fail) => {
  const p = spawn(process.execPath, [CLI, 'waiting', '--hook', ...args], { env: { ...process.env, B2B_HOME: home, HOME: home, B2B_UNATTENDED: '' } });
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { out += c; });
  p.on('close', () => ok(out)).on('error', fail);
  p.stdin.end(JSON.stringify(input));
});
const linkIn = (out) => out.match(/(\/app\/link\/[A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
const folder = (name) => realpathSync(mkdtempSync(join(tmpdir(), `b2b-${name}-`)));
const forOwner = (home) => { try { return JSON.parse(readFileSync(join(home, 'for-owner.json'), 'utf8')).lines.map((l) => l.line); } catch { return []; } };
const briefs = (home) => { try { return JSON.parse(readFileSync(join(home, 'briefs.json'), 'utf8')).items; } catch { return []; } };

const codexId = '019a1234-5678-7000-8000-00000000c0de';
function fakeAgent(name = 'claude') {
  const d = mkdtempSync(join(tmpdir(), 'b2b-agent-'));
  const bin = join(d, name), logPath = join(d, 'runs.log'), history = join(d, 'threads.json');
  const busy = join(d, 'busy');
  writeFileSync(history, '[]');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = (extra) => fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args, cwd: process.cwd(), unattended: process.env.B2B_UNATTENDED, ...extra }) + '\\n');
if (args[0] === 'app-server') {
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const { id, method, params } = JSON.parse(line);
    if (method === 'initialize') console.log(JSON.stringify({ id, result: {} }));
    if (method === 'thread/list') {
      log({ query: params });
      const data = JSON.parse(fs.readFileSync(${JSON.stringify(history)}, 'utf8'))
        .filter((thread) => thread.cwd === params.cwd && params.sourceKinds.includes(thread.source))
        .sort((a, b) => (params.sortKey === 'updated_at' ? b.updatedAt - a.updatedAt : b.createdAt - a.createdAt))
        .slice(0, params.limit);
      console.log(JSON.stringify({ id, result: { data } }));
    }
  });
} else {
  const prompt = args.at(-1);
  const fileAt = (prompt.match(/saved at "([^"]+)"/) || [])[1];
  const fileText = fileAt && fs.existsSync(fileAt) ? fs.readFileSync(fileAt, 'utf8') : null;
  const resumed = args.includes('resume') ? args[args.indexOf('resume') + 1] : null;
  log({ fileText, resumed });
  if (resumed && fs.existsSync(${JSON.stringify(busy)})) {
    console.error('thread already has an active writer');
    process.exit(1);
  }
  const text = 'Finished the test task.';
  if (args[0] === 'exec') {
    console.log(JSON.stringify({ type: 'thread.started', thread_id: resumed || ${JSON.stringify(codexId)} }));
    fs.writeFileSync(args[args.indexOf('-o') + 1], text);
  } else {
    console.log(JSON.stringify({ type: 'result', session_id: 'claude-test-session', result: text }));
  }
}
`);
  chmodSync(bin, 0o755);
  const logs = () => { try { return readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
  return { bin, busy, history, runs: () => logs().filter((r) => !r.query), queries: () => logs().filter((r) => r.query) };
}
async function joinAgent(env, email, handle, agent = 'claude-code') {
  const b = await login(env, email);
  const { home } = cliHome();
  const cli = runIn(home);
  const start = await cli('join', env.url, '--name', handle, '--agent', agent);
  assert.equal(start.code, 0, start.out);
  await b(linkIn(start.out), { method: 'POST', form: { decision: 'allow', bot: 'new', handle } });
  await cli('join');
  const botId = env.relay.db.prepare('SELECT id FROM bots WHERE handle = ?').get(handle).id;
  return { b, home, cli, botId };
}
const startWatcher = async (t0, who, bin, agent = 'claude-code', env = {}) => {
  const p = spawn(process.execPath, [CLI, 'watch', '--agent', agent, '--bin', bin], { env: { ...process.env, B2B_HOME: who.home, HOME: who.home, ...env } });
  let log = '';
  p.stdout.on('data', (c) => { log += c; });
  p.stderr.on('data', (c) => { log += c; });
  t0.after(() => p.kill());
  await waitFor(async () => (await who.b(`/app/bots/${who.botId}/state`)).json().watching, 10_000);
  return { p, log: () => log };
};
// Cara runs Claude Code with a project folder; Ben's bot is a contact she lets send work there, Dan's is not.
async function world(t0, agent = 'claude-code') {
  const env = await setup(t0, { limits: { watchHoldMs: 400 } });
  const cara = await joinAgent(env, 'cara@example.com', 'cara-claude', agent);
  const ben = await owner(env, t0, 'ben@example.com', 'ben', { status: 503 });
  const dan = await owner(env, t0, 'dan@example.com', 'dan', { status: 503 });
  await connectHandled(ben, { ...cara }, 'ben');
  await connectHandled(dan, { ...cara }, 'dan');
  const proj = folder('acme-leads');
  return { env, cara, ben, dan, proj };
}
const sentId = (out) => out.match(/Sent (msg_[\w-]+)/)[1];

test('a direct note stays in the inbox and a project brief waits for the project hook', async (t) => {
  const { env, cara, ben, proj } = await world(t);
  const agent = fakeAgent();
  await cara.cli('project', 'add', 'acme-leads', proj, '--allow', 'ben');
  await startWatcher(t, cara, agent.bin);
  const note = sentId(await ben.cli('send', '@cara-claude', 'Do the import now', '--want', 'start it'));
  const project = sentId(await ben.cli('send', '@cara-claude/acme-leads', 'Scoring notes', '--want', 'a plan'));
  const get = env.relay.db.prepare('SELECT * FROM messages WHERE id = ?');
  await waitFor(() => get.get(note).note === 'watch_deferred' && briefs(cara.home).some((b) => b.id === project));
  assert.equal(get.get(note).status, 'pending');
  assert.equal(get.get(note).next_ring_at, null);
  assert.equal(get.get(project).project, null);
  assert.equal(get.get(project).status, 'delivered');
  assert.equal(briefs(cara.home).find((b) => b.id === project).state, 'waiting');
  assert.deepEqual(agent.runs(), []);
  assert.match((await cara.cli('inbox')).out, /\| Do the import now/);
  assert.doesNotMatch(await hook(cara.home, { session_id: 'elsewhere-session', cwd: tmpdir() }, 'turn'), /waiting for this project/);
  mkdirSync(join(proj, 'src'));
  assert.match(await hook(cara.home, { session_id: 'project-session', cwd: join(proj, 'src') }, 'turn'), /waiting for this project \("acme-leads"\): "Scoring notes" from "ben"/);
  assert.equal(await hook(cara.home, { session_id: 'project-session', cwd: proj }, 'turn'), '');
  assert.match((await runIn(cara.home, { B2B_UNATTENDED: '1' }, proj)('project', 'load')).out, /Only your owner/);
  assert.match((await runIn(cara.home, {}, proj)('project', 'load')).out, /\| Scoring notes/);
  assert.deepEqual(agent.runs(), []);
});

function sameOwner(env, recipient, sender) {
  env.relay.db.prepare('UPDATE bots SET user_id = (SELECT user_id FROM bots WHERE id = ?) WHERE id = ?').run(recipient.botId, sender.botId);
}
const brief = (cara, id) => briefs(cara.home).find((b) => b.id === id);
const groupPostId = (out) => out.match(/Sent (gp_[\w-]+)/)[1];
const groupCopy = (env, post, bot) => env.relay.db.prepare('SELECT * FROM messages WHERE group_post = ? AND to_bot = ?').get(post, Number(bot.botId));
async function taskGroup(env, cara, ...members) {
  const made = await cara.cli('group', 'new', 'Importer', ...members.map((p) => '@' + env.relay.db.prepare('SELECT handle FROM bots WHERE id = ?').get(Number(p.botId)).handle));
  const gid = made.out.match(/\(number (\d+)\)/)[1];
  for (const p of members) env.relay.groups.join(env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(p.botId)), Number(gid), { byOwner: true });
  return gid;
}

test('a sealed group task resumes the linked folder, waits for a busy thread and replies in the group', async (t) => {
  const { env, cara, ben, dan, proj } = await world(t, 'codex');
  const gid = await taskGroup(env, cara, ben, dan);
  sameOwner(env, cara, ben);
  assert.match((await cara.cli('group', 'folder', 'Importer', proj)).out, /Code folder for "Importer"/);
  assert.equal((await cara.cli('group', 'folder', gid)).out.trim(), proj);
  assert.match((await runIn(cara.home, { B2B_UNATTENDED: '1' })('group', 'folder', gid, '--clear')).out, /Only your owner/);
  assert.match((await cara.cli('group', 'folder', gid, join(proj, 'missing'))).out, /isn't a folder on this computer/);
  assert.equal((await cara.cli('group', 'folder', gid)).out.trim(), proj);
  const cfg = JSON.parse(readFileSync(join(cara.home, 'config.json')));
  const shared = folder('shared');
  mkdirSync(join(cara.home, 'folder-state'));
  writeFileSync(join(cara.home, 'folder-state', gid + '.json'), JSON.stringify({ root: shared, relay: cfg.relay, identity: cfg.keys.sign.x, files: {}, seq: 0 }));
  const agent = fakeAgent('codex');
  writeFileSync(agent.history, JSON.stringify([
    { id: 'latest-importer', cwd: proj, updatedAt: 3, createdAt: 1, source: 'cli' },
    { id: 'older-importer', cwd: proj, updatedAt: 2, createdAt: 2, source: 'cli' },
  ]));
  writeFileSync(agent.busy, '');
  await runIn(cara.home, { B2B_SESSION: 'another-lead', B2B_SESSION_AGENT: 'codex' }, proj)('group', 'bind', gid);
  const watcher = await startWatcher(t, cara, agent.bin, 'codex', { CODEX_HOME: join(cara.home, '.codex') });
  await assert.rejects(ben.cli('group', 'send', gid, 'Update the importer.', '--do'), /Mention who should do it, e.g. @anna\./);
  const post = groupPostId(await ben.cli('group', 'send', gid, '@cara-claude Update the importer.', '--do'));
  const copy = groupCopy(env, post, cara), unmentioned = groupCopy(env, post, dan);
  assert.ok(copy.sealed && copy.task === null && copy.text === '' && copy.mentioned === 1);
  assert.equal(unmentioned.mentioned, 0);
  // Even a changed relay mention bit cannot turn the other member's sealed copy into a task.
  env.relay.db.prepare('UPDATE messages SET mentioned = 1 WHERE id = ?').run(unmentioned.id);
  writeFileSync(join(dan.home, 'tool.json'), JSON.stringify({ agent: 'codex' }));
  assert.match(await dan.cli('inbox'), /Update the importer/);
  assert.equal(brief(dan, unmentioned.id), undefined);
  await waitFor(() => /retrying task .* in 30 s/.test(watcher.log()), 20_000);
  assert.equal(brief(cara, copy.id).session, 'latest-importer');
  unlinkSync(agent.busy);
  const saved = briefs(cara.home);
  saved.find((b) => b.id === copy.id).resume_retry_at = Date.now() - 1;
  writeFileSync(join(cara.home, 'briefs.json'), JSON.stringify({ items: saved }));
  await waitFor(() => brief(cara, copy.id)?.state === 'done', 15_000);
  assert.equal(groupCopy(env, post, cara).note, 'received');
  assert.deepEqual(agent.runs().map((r) => r.resumed), ['latest-importer', 'latest-importer']);
  assert.equal(agent.queries().length, 1);
  const task = agent.runs().at(-1);
  assert.equal(task.cwd, proj);
  assert.equal(task.args[task.args.indexOf('--add-dir') + 1], shared);
  assert.match(task.args.at(-1), /from the group "Importer", sent by "ben"[^]*Write code in the current folder\./);
  assert.ok(task.args.at(-1).includes(`shared folder at "${shared}" for plans, notes and summaries`));
  const result = env.relay.db.prepare("SELECT * FROM group_posts WHERE group_id = ? AND from_bot = ? AND kind = 'note'").get(Number(gid), cara.botId);
  assert.ok(result.sealed && result.text === null);
  const resultCopy = groupCopy(env, result.id, ben);
  assert.equal(resultCopy.reply_to, null, 'the reply link stays sealed');
  assert.match(resultCopy.client_id, /^g-[\w-]{12}$/);
  assert.ok(groupCopy(env, result.id, dan), 'the result goes to the whole group');
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM messages WHERE from_bot = ? AND kind = 'reply'").get(cara.botId).n, 0);
  const reply = (await ben.cli('inbox', '--json')).trim().split('\n').map(JSON.parse).find((m) => m.group?.post === result.id);
  assert.equal(reply.re, post);
  assert.equal(reply.untrusted.text, 'Finished the test task.');
});

test('a missing code folder holds the group task, and clearing the link starts a fresh chat', async (t) => {
  const { env, cara, ben, proj } = await world(t);
  const gid = await taskGroup(env, cara, ben);
  sameOwner(env, cara, ben);
  const missing = join(proj, 'old-importer');
  mkdirSync(missing);
  await cara.cli('group', 'folder', gid, missing);
  rmSync(missing, { recursive: true });
  const agent = fakeAgent();
  await startWatcher(t, cara, agent.bin);
  const post = groupPostId(await ben.cli('group', 'send', gid, 'Check the importer.', '--mention', 'cara-claude', '--do'));
  const { id } = groupCopy(env, post, cara);
  await waitFor(() => forOwner(cara.home).some((line) => line.endsWith(`group folder ${gid} <folder>`)), 15_000);
  assert.equal(brief(cara, id).state, 'held');
  assert.deepEqual(agent.runs(), []);
  assert.match((await cara.cli('group', 'folder', gid, '--clear')).out, /Cleared the code folder/);
  assert.match((await cara.cli('group', 'folder', gid)).out, /No code folder linked here/);
  await waitFor(() => brief(cara, id)?.state === 'done', 15_000);
  const [task] = agent.runs();
  assert.equal(task.cwd, realpathSync(cara.home));
  assert.ok(!task.args.includes('--continue'));
});

test('the connected MCP sends a plain group task and gets a plain group reply', async (t) => {
  const { env, cara, dan } = await world(t);
  const gid = await taskGroup(env, cara, dan);
  const owner = await login(env, 'mia@example.com');
  const app = await connectApp(env, owner, 'mia');
  const mia = env.relay.db.prepare("SELECT * FROM bots WHERE handle = 'mia'").get();
  const link = (await cara.cli('group', 'link', gid)).out.match(/\/g\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  env.relay.groups.join(mia, Number(gid), { linkCode: link, byOwner: true });
  sameOwner(env, cara, { botId: mia.id });
  const agent = fakeAgent();
  await startWatcher(t, cara, agent.bin);
  const missing = await app.tool('send_to_group', { group: gid, text: 'Check the importer.', task: true });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /Mention who should do it, e.g. @anna\./);
  const sent = await app.tool('send_to_group', { group: gid, text: '@cara-claude Check the importer.', task: true });
  assert.match(sent.content[0].text, /Sent to 2 people/);
  const post = env.relay.db.prepare("SELECT id FROM group_posts WHERE from_bot = ? AND group_id = ? AND kind = 'note'").get(mia.id, Number(gid)).id;
  const task = groupCopy(env, post, cara);
  assert.equal(task.task, 1);
  assert.equal(task.sealed, null);
  assert.equal(groupCopy(env, post, dan).task, null);
  await waitFor(() => brief(cara, task.id)?.state === 'done', 15_000);
  const result = (await app.tool('group_messages', { group: gid })).content[0].text;
  assert.ok(result.includes(`reply to ${post}`));
  assert.match(result, /Finished the test task/);
});

test('an own-bot task without a project starts fresh in the default folder and replies to the original', async (t) => {
  const { env, cara, ben } = await world(t);
  sameOwner(env, cara, ben);
  const agent = fakeAgent();
  await startWatcher(t, cara, agent.bin);
  const text = 'Write a short test report.';
  const passive = sentId(await ben.cli('send', '@cara-claude', text, '--want', 'task:true'));
  const explicit = sentId(await ben.cli('send', '@cara-claude', text, '--do'));
  assert.notEqual(passive, explicit, 'a want string cannot collide with the sealed task flag');
  await waitFor(() => brief(cara, explicit)?.state === 'done', 15_000);
  const id = sentId(await ben.cli('send', '@cara-claude', text, '--do', '--want', 'a summary'));
  await waitFor(() => brief(cara, id)?.state === 'done', 15_000);
  assert.deepEqual(agent.queries(), []);
  const run = agent.runs().at(-1);
  assert.equal(run.cwd, realpathSync(cara.home));
  assert.equal(run.unattended, '1');
  assert.doesNotMatch(run.args.join(' '), /resume|--continue|dangerously|--permission-mode/);
  assert.match(run.args.at(-1), /"a summary"[^]*\| Write a short test report/);
  assert.match(forOwner(cara.home)[0], /claude --resume claude-test-session/);
  assert.match(await ben.cli('status', id), /reply[^]*\| Finished the test task/);
  const row = env.relay.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  assert.ok(row.sealed && row.project === null && row.task === null && row.text === '');
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM messages WHERE reply_to = ?').get(id).n, 1);
});

test('Codex selects the most recently updated chat in the exact project and retries the same ID after a busy writer', async (t) => {
  const { env, cara, ben, proj } = await world(t, 'codex');
  sameOwner(env, cara, ben);
  await cara.cli('project', 'add', 'acme-leads', proj, '--allow', 'mine');
  const agent = fakeAgent('codex');
  const other = folder('other');
  const threads = [
    { id: 'project-newest', cwd: proj, updatedAt: 5, createdAt: 1, source: 'vscode' },
    { id: 'project-older', cwd: proj, updatedAt: 2, createdAt: 2, source: 'cli' },
    { id: 'elsewhere-newer', cwd: other, updatedAt: 10, createdAt: 10, source: 'appServer' },
    { id: 'subagent-newer', cwd: proj, updatedAt: 11, createdAt: 11, source: 'subAgent' },
  ];
  writeFileSync(agent.history, JSON.stringify(threads));
  writeFileSync(agent.busy, '');
  const codexHome = join(cara.home, '.codex');
  const watcher = await startWatcher(t, cara, agent.bin, 'codex', { CODEX_HOME: codexHome });
  const hooks = JSON.parse(readFileSync(join(codexHome, 'hooks.json'))).hooks;
  assert.match(hooks.UserPromptSubmit[0].hooks[0].command, /waiting --hook turn$/);
  const id = sentId(await ben.cli('send', '@cara-claude/acme-leads', 'Run the original task.', '--do'));
  await waitFor(() => /retrying task .* in 30 s/.test(watcher.log()), 15_000).catch((e) => { throw new Error(e.message + '\n' + watcher.log()); });
  assert.equal(brief(cara, id).session, 'project-newest');
  assert.ok(brief(cara, id).resume_retry_at > Date.now());
  assert.deepEqual(agent.runs().map((r) => r.resumed), ['project-newest']);
  assert.equal(agent.queries()[0].query.cwd, proj);
  assert.equal(agent.queries()[0].query.sortKey, 'updated_at');
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM messages WHERE reply_to = ?').get(id).n, 0);
  await new Promise((resolve) => { watcher.p.once('exit', resolve); watcher.p.kill(); });
  threads[1].updatedAt = 20;
  writeFileSync(agent.history, JSON.stringify(threads));
  unlinkSync(agent.busy);
  const restarted = await startWatcher(t, cara, agent.bin, 'codex', { CODEX_HOME: codexHome });
  await waitFor(() => /watching @cara-claude/.test(restarted.log()));
  await sleep(500);
  assert.equal(agent.runs().length, 1);
  const saved = briefs(cara.home);
  saved.find((b) => b.id === id).resume_retry_at = Date.now() - 1;
  writeFileSync(join(cara.home, 'briefs.json'), JSON.stringify({ items: saved }));
  await waitFor(() => brief(cara, id)?.state === 'done', 15_000).catch((e) => { throw new Error(e.message + '\n' + restarted.log()); });
  assert.equal(brief(cara, id).resume_retry_at, undefined);
  assert.deepEqual(agent.runs().map((r) => r.resumed), ['project-newest', 'project-newest']);
  assert.equal(agent.queries().length, 1);
  assert.match(forOwner(cara.home)[0], /codex resume project-newest/);
});

test('a misspelled project or a sender who is not allowed never starts a session: the owner is asked', async (t0) => {
  const { cara, ben, dan, proj } = await world(t0);
  await cara.cli('project', 'add', 'acme-leads', proj, '--allow', 'ben');
  const agent = fakeAgent();
  await startWatcher(t0, cara, agent.bin);

  const typo = sentId(await ben.cli('send', '@cara-claude/acme-leeds', 'Secret plan for the misspelled project', '--want', 'a plan'));
  const stranger = sentId(await dan.cli('send', '@cara-claude/acme-leads', 'Work from someone not on the list', '--do'));
  await waitFor(() => forOwner(cara.home).length === 2, 20_000);
  const lines = forOwner(cara.home);
  assert.ok(lines.some((l) => l.startsWith(`ben (@ben) sent work for a project called "acme-leeds", which isn't set up on this computer, so nothing was started. Did you mean "acme-leads"? Then: B2B_HOME=${cara.home} node `) && l.includes(realpathSync(CLI)) && l.endsWith(` project route ${typo} acme-leads`)), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`dan (@dan) sent work for your project "acme-leads", but isn't on its list of allowed senders, so nothing was started. To allow them and release what's held:`) && l.endsWith('project allow acme-leads @dan')), lines.join('\n'));
  await sleep(1500);
  assert.deepEqual(agent.runs(), []);
  assert.deepEqual(briefs(cara.home).map((b) => [b.id, b.state, b.why]).sort(), [[typo, 'held', 'unknown'], [stranger, 'held', 'sender']].sort());
  const listed = (await cara.cli('project', 'list')).out;
  assert.match(listed, /Held for your owner \(nothing was started\):[^]*Did you mean "acme-leads"\?[^]*project drop msg_/);

  // Only the owner sends a held message on: once, to a project that exists.
  assert.match((await runIn(cara.home, { B2B_UNATTENDED: '1' })('project', 'route', typo, 'acme-leads')).out, /Only your owner/);
  assert.match((await runIn(cara.home, { B2B_UNATTENDED: '1' })('project', 'allow', 'acme-leads', 'dan')).out, /Only your owner/);
  assert.match((await cara.cli('project', 'route', typo, 'acme-leeds')).out, /No project "acme-leeds" on this computer/);
  const routed = await cara.cli('project', 'route', typo, 'acme-leads');
  assert.match(routed.out, /"Secret plan for the misspelled project" from "ben" waits for the project "acme-leads" now/);
  assert.equal(brief(cara, typo).state, 'waiting');
  const allowed = await cara.cli('project', 'allow', 'acme-leads', 'dan');
  assert.match(allowed.out, /May send work to "acme-leads" now: ben \(@ben\), dan \(@dan\)\. 1 held message is waiting for it now/);
  // Allowing project access still requires contact approval before the task starts.
  await waitFor(() => brief(cara, stranger)?.state === 'waiting', 15_000);
  assert.match(await dan.cli('status', stranger), /left it waiting/);
  assert.deepEqual(agent.runs(), []);
  // And a message can simply be dropped.
  const again = sentId(await ben.cli('send', '@cara-claude/nowhere', 'Another one', '--want', 'a plan'));
  await waitFor(() => briefs(cara.home).some((b) => b.id === again), 20_000);
  assert.match((await cara.cli('project', 'drop', again)).out, /Dropped "Another one" from "ben"\. Nothing was started for it/);
  assert.ok(!briefs(cara.home).some((b) => b.id === again));
});

test('without a watcher: a session in the project folder reads its brief itself, and one elsewhere is told where it waits', async (t0) => {
  const { cara, ben, proj } = await world(t0);
  await cara.cli('project', 'add', 'acme-leads', proj, '--allow', 'ben');
  await ben.cli('send', '@cara-claude/acme-leads', 'First brief: tidy the importer', '--want', 'a plan');
  const away = await runIn(cara.home, {}, tmpdir())('inbox');
  assert.match(away.out, /--- for the project "acme-leads": a brief "First brief: tidy the importer" from "ben" \(@ben\) came in\. It waits for a session in ".*", marked delivered\. ---\nTell your owner in one short line\. To read it in this session instead: .* project load acme-leads/);
  assert.doesNotMatch(away.out, /\| First brief/);
  assert.match(away.out, /INBOX EMPTY\. Tell your owner what's above for them/);

  await ben.cli('send', '@cara-claude/acme-leads', 'Second brief: add retries', '--want', 'a plan');
  const here = await runIn(cara.home, {}, proj)('inbox');
  assert.match(here.out, /\| Second brief: add retries/);
  assert.match(here.out, /It's a brief for the project "acme-leads", whose folder this session is in, from a bot your owner lets send work here\. Tell your owner what it asks for and plan it with them: change nothing until their own clear go\./);
  assert.deepEqual(briefs(cara.home).map((b) => b.title), ['First brief: tidy the importer']);
  // Codex and others start a session with "waiting": the folder they run in decides.
  assert.match((await runIn(cara.home, {}, proj)('waiting')).out, /1 handoff is waiting for this project \("acme-leads"\): "First brief: tidy the importer" from "ben"/);

  // A reply is an answer to whoever asked, and an ordinary message has no project: both arrive as always.
  await ben.cli('send', '@cara-claude', 'No project here', '--want', 'a look');
  assert.match((await runIn(cara.home, {}, tmpdir())('inbox')).out, /\| No project here/);
});

test('a handoff package sent to a project keeps its title and thread, and waits for that folder', async (t0) => {
  const { cara, ben, proj } = await world(t0);
  await cara.cli('project', 'add', 'acme-leads', proj, '--allow', 'ben');
  const file = join(folder('pkg'), 'handoff.md');
  writeFileSync(file, `---\nspec: b2b-handoff/1\nid: h_projectabcdef12\nthread: t_projectabcdef12\nfrom: "@ben"\nask: continue\ntitle: "Lead scoring v2"\nrefs:\n  - {type: pr, url: https://github.com/org/leads/pull/7}\n---\n## Goal\nScore every lead.\n## Current state\nThe model is chosen (PR 7).\n## Decisions\nFit plus intent.\n## Open questions\nWhich weights?\n## Constraints\nNo new services.\n## What I need from you\nBuild it.\n## How to verify\nnpm test\n`);
  const sent = await ben.cli('handoff', 'send', '@cara-claude/acme-leads', file, '--owner-ok', '--transport', 'inline');
  assert.match(sent, /package h_projectabcdef12 in thread t_projectabcdef12[^]*For their project "acme-leads"/);
  const away = await runIn(cara.home, {}, tmpdir())('inbox');
  assert.match(away.out, /--- for the project "acme-leads": a brief "Lead scoring v2" from "ben" \(@ben\) came in/);
  assert.deepEqual(briefs(cara.home).map((b) => [b.title, b.thread, b.handoff?.ask, b.state]), [['Lead scoring v2', 't_projectabcdef12', 'continue', 'waiting']]);
  const loaded = await runIn(cara.home, {}, proj)('project', 'load');
  assert.match(loaded.out, /brief "Lead scoring v2" from "ben"[^]*Task thread t_projectabcdef12\. For its context: .* thread show t_projectabcdef12 --brief[^]*\| ## Goal\n\| Score every lead\./);
  // The thread is on this computer too, so the session can read the whole task.
  assert.match((await cara.cli('thread', 'show', 't_projectabcdef12', '--brief')).out, /Lead scoring v2/);
});

test('project rules: names, folders, who may send, and what a removed project leaves behind', async (t0) => {
  const { cara, ben, proj } = await world(t0);
  const bad = async (re, ...a) => { const r = await cara.cli(...a); assert.equal(r.code, 1, r.out); assert.match(r.out, re); };
  await bad(/A project name is short/, 'project', 'add', 'acme leads!', proj);
  await bad(/isn't a folder on this computer/, 'project', 'add', 'acme-leads', join(proj, 'missing'));
  await bad(/your whole home folder/, 'project', 'add', 'acme-leads', cara.home);
  await bad(/"nobody" isn't one of your owner's contacts/, 'project', 'add', 'acme-leads', proj, '--allow', 'nobody');
  await bad(/None of this bot's contacts is another of your owner's own bots yet/, 'project', 'add', 'acme-leads', proj, '--allow', 'mine');
  assert.match((await runIn(cara.home, { B2B_UNATTENDED: '1' })('project', 'add', 'acme-leads', proj)).out, /Only your owner changes projects/);
  assert.match((await cara.cli('project', 'list')).out, /No projects yet/);

  // With nobody allowed, a message for it is held; the folder defaults to the one the owner is in.
  const add = await runIn(cara.home, {}, proj)('project', 'add', 'acme-leads');
  assert.match(add.out, new RegExp(`The project "acme-leads" is ${proj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\nMay send work there: nobody yet\\.`));
  await ben.cli('send', '@cara-claude/acme-leads', 'Before I was allowed', '--want', 'a plan');
  const held = await runIn(cara.home, {}, proj)('inbox');
  assert.match(held.out, /--- held for your owner: a message from "ben" \(@ben\) was sent to a project that isn't set up for them here\. Nothing was started\. ---\nTell your owner this, in one short line: ben \(@ben\) sent work for your project "acme-leads", but isn't on its list of allowed senders/);
  assert.doesNotMatch(held.out, /\| Before I was allowed/);
  assert.match((await cara.cli('project', 'allow', 'acme-leads', 'ben')).out, /ben \(@ben\)\. 1 held message is waiting for it now/);
  assert.deepEqual(briefs(cara.home).map((b) => b.state), ['waiting']);
  assert.match((await cara.cli('project', 'disallow', 'acme-leads', '@ben')).out, /May send work to "acme-leads" now: nobody yet/);
  const json = JSON.parse((await cara.cli('project', 'list', '--json')).out);
  assert.deepEqual(json.projects['acme-leads'].allow, []);
  assert.equal(json.briefs[0].text, undefined, 'the list never prints what a brief says');

  // Removing the project leaves its folder alone, and what waited is held again.
  assert.match((await cara.cli('project', 'remove', 'acme-leads')).out, /Removed the project "acme-leads"\. Its folder wasn't touched, and messages for it start nothing now\. 1 waiting message is held/);
  assert.ok(existsSync(proj));
  assert.deepEqual(briefs(cara.home).map((b) => [b.state, b.why, b.asked]), [['held', 'unknown', 'acme-leads']]);

  // The sender's side: one project, a short name.
  const sendBad = async (re, ...a) => { try { await ben.cli(...a); assert.fail('sent'); } catch (e) { assert.match(`${e.stdout}${e.stderr}`, re); } };
  await sendBad(/A project is a short name/, 'send', '@cara-claude/bad name', 'x', '--want', 'y');
  await sendBad(/A project is a short name/, 'send', '@cara-claude', 'x', '--project', '../etc', '--want', 'y');
  await sendBad(/Two different projects/, 'send', '@cara-claude/one', 'x', '--project', 'two', '--want', 'y');
});

// A chat app signing in for /send (as in send-only.test.mjs), and a local stand-in for the file storage.
async function connectSender(env, b, name) {
  const resource = `${env.url}/send`;
  const meta = await (await fetch(`${env.url}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's1', resource };
  await b(`/oauth/authorize?${new URLSearchParams(params)}`);
  const ok = await b('/oauth/authorize', { method: 'POST', form: { ...params, decision: 'allow' } });
  const tokens = await (await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: new URL(ok.location).searchParams.get('code'), redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource }) })).json();
  let id = 0;
  const tool = async (n, args = {}) => (await (await fetch(`${env.url}/send`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: n, arguments: args } }) })).json()).result;
  return { tool };
}

test('a chat app sends a task and file to a project with no Codex chat yet and can read the reply', async (t0) => {
  const blobs = new Map();
  const store = await listen(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (req.method === 'PUT') { const parts = []; for await (const c of req) parts.push(c); blobs.set(path, Buffer.concat(parts)); return res.writeHead(200).end(); }
    if (req.method === 'GET') return blobs.has(path) ? res.writeHead(200).end(blobs.get(path)) : res.writeHead(404).end();
    if (req.method === 'DELETE') { blobs.delete(path); return res.writeHead(204).end(); }
    res.writeHead(405).end();
  });
  t0.after(() => store.s.close());
  const env = await setup(t0, { keySecret: 'local-project-file-test-secret', files: { s3: { endpoint: store.url, bucket: 'chat-files', region: 'auto', keyId: 'test-key', secret: 'test-secret', style: 'path' }, alpha: true }, limits: { watchHoldMs: 400 } });
  const mia = await owner(env, t0, 'mia@example.com', 'mia', { status: 503 });
  env.relay.db.prepare("UPDATE bots SET platform = 'codex' WHERE id = ?").run(Number(mia.botId));
  const cli = runIn(mia.home);
  const chat = await connectSender(env, mia.b, 'Claude');
  const proj = folder('acme-leads');
  // "mine" = every contact that is another of this owner's own bots: here, the chat.
  const added = await cli('project', 'add', 'acme-leads', proj, '--allow', 'mine');
  assert.match(added.out, /May send work there: .*\(@[a-z0-9-]+\)\./);
  const agent = fakeAgent('codex');
  await startWatcher(t0, mia, agent.bin, 'codex');

  const refused = await chat.tool('send_to_bot', { to: 'codex', text: 'x', project: '../../etc' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /project is the short name your owner uses for it/);
  const spec = '# Scoring spec\n\nfit + intent, capped at 100.\n';
  const r = await chat.tool('send_to_bot', { to: 'codex', title: 'Lead scoring v2', text: 'Build what the spec says.', want: 'an implementation', task: true, project: 'Acme Leads', documents: [{ name: 'spec.md', text: spec }] });
  assert.equal(r.isError, false, r.content[0].text);
  assert.match(r.content[0].text, /with 1 file, for the project "acme-leads"\. Task message ID: msg_/);
  const row = env.relay.db.prepare("SELECT * FROM messages WHERE kind = 'note'").get();
  assert.ok(row.sealed === null && row.project === 'acme-leads' && row.task === 1);
  await waitFor(() => brief(mia, row.id)?.state === 'done', 15_000);
  const [task] = agent.runs();
  assert.deepEqual(task.args.slice(0, 7), ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', proj, '--json']);
  assert.doesNotMatch(task.args.join(' '), /ignore-user-config|dangerously|resume/);
  assert.match(task.args.at(-1), /\| # Lead scoring v2\n\| \n\| Build what the spec says\./);
  assert.equal(task.fileText, spec);
  assert.match(forOwner(mia.home)[0], /codex resume 019a1234-5678-7000-8000-00000000c0de$/);
  const result = await chat.tool('get_task_result', { message_id: row.id });
  assert.match(result.content[0].text, /Finished the test task/);
  assert.equal((await chat.tool('get_task_result', { message_id: 'msg_unknown' })).isError, true);
  assert.equal(env.relay.db.prepare('SELECT project FROM messages WHERE id = ?').get(row.id).project, 'acme-leads');
  // Erasing a message's content takes the project's name with it.
  env.advance(8 * 86_400_000);
  await env.relay.tick();
  await waitFor(() => env.relay.db.prepare('SELECT body_purged_at FROM messages WHERE id = ?').get(row.id)?.body_purged_at != null || !env.relay.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(row.id), 10_000);
  const purged = env.relay.db.prepare('SELECT project, task FROM messages WHERE id = ?').get(row.id);
  assert.ok(!purged?.project && !purged?.task);
});
