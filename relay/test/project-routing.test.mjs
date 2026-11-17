// A message addressed to a project, not just to a bot (issue #8). The sender names the project; the receiving
// computer's owner says which folder that is and who may send work there. A known project from an allowed sender
// gets one plan-only session in its folder (a fake agent stands in for Claude Code and Codex), and anything else
// starts nothing and is held for the owner. No real bot, agent or chat account is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, mkdtempSync, chmodSync, realpathSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, login, cliHome, waitFor, sleep, owner, connectHandled, listen, REDIRECT } from './helpers.mjs';

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

// What the watcher starts. A plan-only start (Claude Code in plan mode, Codex in its read-only sandbox) answers with
// a plan the way each prints it for programs. Any other start is the ordinary wake run: it reads the inbox and acks.
function fakeAgent(name = 'claude') {
  const d = mkdtempSync(join(tmpdir(), 'b2b-agent-'));
  const bin = join(d, name);
  writeFileSync(bin, `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const args = process.argv.slice(2);
const log = (extra) => fs.appendFileSync(${JSON.stringify(join(d, 'runs.log'))}, JSON.stringify({ args, cwd: process.cwd(), unattended: process.env.B2B_UNATTENDED, ...extra }) + '\\n');
const answer = '## Plan\\n1. Add the scoring module.\\n2. Cover it with tests.\\n\\n## Open questions\\n1. Which weights?\\n\\nbot2bot-plan: steps=2 questions=1';
const prompt = args.find((a) => a.startsWith('bot2bot: a brief came in')) || '';
const fileAt = (prompt.match(/saved at "([^"]+)"/) || [])[1];
const fileText = fileAt && fs.existsSync(fileAt) ? fs.readFileSync(fileAt, 'utf8') : null;
if (args.includes('--permission-mode')) {
  log({ plan: 'claude', fileText });
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: args[args.indexOf('--session-id') + 1], result: answer }));
  process.exit(process.env.FAKE_PLAN_FAILS ? 1 : 0);
}
if (args[0] === 'exec' && args.includes('read-only')) {
  log({ plan: 'codex', fileText });
  console.log(JSON.stringify({ type: 'thread.started', thread_id: '019a1234-5678-7000-8000-00000000c0de' }));
  fs.writeFileSync(args[args.indexOf('-o') + 1], answer);
  process.exit(0);
}
const b2b = (...a) => execFileSync(process.execPath, [${JSON.stringify(CLI)}, ...a], { encoding: 'utf8' });
let seen = '';
for (let i = 0; i < 4; i++) {
  const out = b2b('inbox', '--via', 'watch');
  seen += out;
  const acks = [...out.matchAll(/^[^|\\n].*b2b\\.mjs'? ack (msg_[\\w~-]+)$/gm)];
  if (!acks.length) break;
  for (const m of acks) b2b('ack', m[1]);
}
log({ inbox: seen });
`);
  chmodSync(bin, 0o755);
  const runs = () => { try { return readFileSync(join(d, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { bin, runs, plans: () => runs().filter((r) => r.plan), wakes: () => runs().filter((r) => !r.plan) };
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

test('a brief for a project starts one plan-only session in its folder, and the owner hears it and loads it there', async (t0) => {
  const { env, cara, ben, proj } = await world(t0);
  const added = await cara.cli('project', 'add', 'Acme-Leads', proj, '--allow', '@ben');
  assert.equal(added.code, 0, added.out);
  assert.match(added.out, /The project "acme-leads" is .*\nMay send work there: ben \(@ben\)\./);
  assert.match(added.out, /A message never changes anything by itself: your owner says go/);
  const agent = fakeAgent();
  const w = await startWatcher(t0, cara, agent.bin);

  const sent = await ben.cli('send', '@cara-claude/acme-leads', '# Lead scoring v2\n\nScore every lead as fit plus intent.', '--want', 'a plan');
  assert.match(sent, /For their project "acme-leads": their computer starts work there only if/);
  assert.match(sent, /End-to-end encrypted/);
  await waitFor(() => agent.plans().length === 1 && forOwner(cara.home).some((l) => /is ready in acme-leads/.test(l)), 20_000).catch((e) => { throw new Error(`${e.message}\n${w.log()}`); });

  // The relay routed a sealed message and never learned the project's name.
  const rows = env.relay.db.prepare('SELECT * FROM messages WHERE to_bot = ?').all(cara.botId);
  const row = rows.find((m) => m.id === sentId(sent));
  assert.ok(row.sealed && row.project === null && row.text === '' && row.status === 'delivered');
  assert.doesNotMatch(JSON.stringify(env.relay.db.prepare('SELECT * FROM messages').all()), /acme-leads/);

  // The run that read the inbox was told a brief was saved, not what it said, and started nothing itself.
  const wake = agent.wakes().find((r) => /for the project "acme-leads" was saved/.test(r.inbox));
  assert.ok(wake, JSON.stringify(agent.runs()));
  assert.doesNotMatch(wake.inbox, /Score every lead/);

  // One session, in the project's folder, that can only read: plan mode, reading tools, none of the owner's MCP servers.
  const [plan] = agent.plans();
  assert.equal(plan.cwd, proj);
  assert.equal(plan.unattended, '1');
  assert.equal(plan.args[0], '-p');
  assert.equal(plan.args[plan.args.indexOf('--permission-mode') + 1], 'plan');
  assert.deepEqual(plan.args.slice(plan.args.indexOf('--tools') + 1, plan.args.indexOf('--tools') + 4), ['Read', 'Grep', 'Glob']);
  assert.ok(plan.args.includes('--strict-mcp-config'));
  assert.doesNotMatch(plan.args.join(' '), /allowedTools|dangerously|Bash|Write|Edit/);
  const session = plan.args[plan.args.indexOf('--session-id') + 1];
  assert.match(session, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.match(plan.args[1], /^bot2bot: a brief came in for this project \("acme-leads"\) from "ben" \(@ben\)[^]*Plan only[^]*Change nothing/);
  assert.match(plan.args[1], /\[(\w+) start\]\n\| # Lead scoring v2\n\| \n\| Score every lead as fit plus intent\.\n\[\1 end\]/);
  assert.match(plan.args[1], /They want \(their words\): "a plan"/);

  // The owner hears it in their next session, wherever that is, with the plan and how to open the session.
  const line = forOwner(cara.home).find((l) => /is ready in acme-leads/.test(l));
  assert.match(line, /^Brief "Lead scoring v2" from ben is ready in acme-leads: plan with 2 steps, 1 open question\. Nothing was changed\. Read it: .*plans\/acme-leads-msg_[\w-]+\.md · To open that session: cd \S+ && claude --resume /);
  assert.ok(line.includes(`claude --resume ${session}`) && line.includes(proj));
  const planFile = readFileSync(join(cara.home, 'plans', `acme-leads-${sentId(sent)}.md`), 'utf8');
  assert.match(planFile, /Nothing was changed\. -->\n\n## Plan\n1\. Add the scoring module\./);
  assert.doesNotMatch(planFile, /bot2bot-plan:/);
  const listed = await cara.cli('project', 'list');
  assert.match(listed.out, /acme-leads  .* · may send: ben \(@ben\) · 1 waiting\n    msg_[\w-]+ "Lead scoring v2" from "ben" · planned: /);

  // A session opened in the project's folder (or below it) is told it's waiting, once; one elsewhere isn't.
  mkdirSync(join(proj, 'src'));
  const elsewhere = await hook(cara.home, { session_id: 'session-elsewhere-1', cwd: tmpdir() }, 'turn');
  assert.doesNotMatch(elsewhere, /waiting for this project/);
  const first = await hook(cara.home, { session_id: 'session-in-project-1', cwd: join(proj, 'src') });
  assert.match(first, /bot2bot: 1 handoff is waiting for this project \("acme-leads"\): "Lead scoring v2" from "ben" \(already planned: 2 steps, 1 open question\)\. Before anything else, tell your owner and ask: load it\? If yes, run .* project load acme-leads/);
  assert.doesNotMatch(first, /Score every lead/);
  assert.equal(await hook(cara.home, { session_id: 'session-in-project-1', cwd: proj }, 'turn'), '', 'not repeated on every prompt');
  assert.match(await hook(cara.home, { session_id: 'session-in-project-2', cwd: proj }, 'turn'), /Along with your answer, tell your owner and ask: load it\?/);

  // A run nobody watches can't take it; the owner's session does, and then it stops waiting.
  assert.match((await runIn(cara.home, { B2B_UNATTENDED: '1' }, proj)('project', 'load')).out, /Only your owner/);
  const loaded = await runIn(cara.home, {}, join(proj, 'src'))('project', 'load');
  assert.match(loaded.out, /^bot2bot: 1 brief for the project "acme-leads"[^]*change nothing in this project until your owner says go/);
  assert.match(loaded.out, /\| Score every lead as fit plus intent\./);
  assert.match(loaded.out, /A plan-only session already planned this \(2 steps, 1 open question\): read /);
  assert.match(loaded.out, /To answer their bot: .* reply msg_/);
  assert.match((await runIn(cara.home, {}, proj)('project', 'load')).out, /Nothing is waiting for the project "acme-leads"/);
  assert.equal(await hook(cara.home, { session_id: 'session-in-project-3', cwd: proj }, 'turn'), '');
  await sleep(1200);
  assert.equal(agent.plans().length, 1, 'planned once');
});

test('the session that planned a brief, opened by its owner, shows the plan instead of offering to load it', async (t0) => {
  const { cara, ben, proj } = await world(t0);
  await cara.cli('project', 'add', 'acme-leads', proj, '--allow', 'ben');
  const agent = fakeAgent();
  await startWatcher(t0, cara, agent.bin);
  await ben.cli('send', '@cara-claude', 'Plan the import job', '--project', 'acme-leads', '--want', 'a plan');
  await waitFor(() => briefs(cara.home).some((b) => b.state === 'planned'), 20_000);
  const session = briefs(cara.home)[0].session;
  const out = await hook(cara.home, { session_id: session, cwd: proj });
  assert.match(out, /this session planned the brief "Plan the import job" from "ben" for the project "acme-leads" while your owner was away, and changed nothing\. Your owner is here now: show them the plan/);
  assert.doesNotMatch(out, /load it\?/);
  assert.deepEqual(briefs(cara.home), []);
});

test('a misspelled project or a sender who is not allowed never starts a session: the owner is asked', async (t0) => {
  const { cara, ben, dan, proj } = await world(t0);
  await cara.cli('project', 'add', 'acme-leads', proj, '--allow', 'ben');
  const agent = fakeAgent();
  const w = await startWatcher(t0, cara, agent.bin);

  const typo = sentId(await ben.cli('send', '@cara-claude/acme-leeds', 'Secret plan for the misspelled project', '--want', 'a plan'));
  const stranger = sentId(await dan.cli('send', '@cara-claude/acme-leads', 'Work from someone not on the list', '--want', 'a plan'));
  await waitFor(() => forOwner(cara.home).length === 2, 20_000);
  const lines = forOwner(cara.home);
  assert.ok(lines.some((l) => l.startsWith(`ben (@ben) sent work for a project called "acme-leeds", which isn't set up on this computer, so nothing was started. Did you mean "acme-leads"? Then: B2B_HOME=${cara.home} node `) && l.includes(realpathSync(CLI)) && l.endsWith(` project route ${typo} acme-leads`)), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith(`dan (@dan) sent work for your project "acme-leads", but isn't on its list of allowed senders, so nothing was started. To let them (it also starts what's held):`) && l.endsWith('project allow acme-leads @dan')), lines.join('\n'));
  await sleep(1500);
  assert.equal(agent.plans().length, 0, 'no session for either');
  // The runs that read the inbox never saw what those messages said, and had nothing to act on.
  for (const r of agent.wakes()) assert.doesNotMatch(r.inbox, /Secret plan|someone not on the list/);
  assert.ok(agent.wakes().some((r) => /sent to a project that isn't set up for them on this computer\. It started nothing/.test(r.inbox)));
  assert.deepEqual(briefs(cara.home).map((b) => [b.id, b.state, b.why]).sort(), [[typo, 'held', 'unknown'], [stranger, 'held', 'sender']].sort());
  const listed = (await cara.cli('project', 'list')).out;
  assert.match(listed, /Held for your owner \(nothing was started\):[^]*Did you mean "acme-leads"\?[^]*project drop msg_/);

  // Only the owner sends a held message on: once, to a project that exists.
  assert.match((await runIn(cara.home, { B2B_UNATTENDED: '1' })('project', 'route', typo, 'acme-leads')).out, /Only your owner/);
  assert.match((await runIn(cara.home, { B2B_UNATTENDED: '1' })('project', 'allow', 'acme-leads', 'dan')).out, /Only your owner/);
  assert.match((await cara.cli('project', 'route', typo, 'acme-leeds')).out, /No project "acme-leeds" on this computer/);
  const routed = await cara.cli('project', 'route', typo, 'acme-leads');
  assert.match(routed.out, /"Secret plan for the misspelled project" from "ben" waits for the project "acme-leads" now/);
  await waitFor(() => agent.plans().length === 1, 20_000);
  assert.match(agent.plans()[0].args[1], /\| Secret plan for the misspelled project/);
  // Allowing the sender starts what was held for that reason.
  const allowed = await cara.cli('project', 'allow', 'acme-leads', 'dan');
  assert.match(allowed.out, /May send work to "acme-leads" now: ben \(@ben\), dan \(@dan\)\. 1 held message is waiting for it now/);
  await waitFor(() => agent.plans().length === 2, 20_000).catch((e) => { throw new Error(`${e.message}\n${w.log()}\n${JSON.stringify(briefs(cara.home).map(({ text: _t, ...b }) => b))}`); });
  assert.match(agent.plans()[1].args[1], /from "dan" \(@dan\)[^]*\| Work from someone not on the list/);
  // And a message can simply be dropped.
  const again = sentId(await ben.cli('send', '@cara-claude/nowhere', 'Another one', '--want', 'a plan'));
  await waitFor(() => briefs(cara.home).some((b) => b.id === again), 20_000).catch((e) => { throw new Error(`${e.message}\n${w.log()}\n${JSON.stringify(agent.runs().map((r) => r.inbox ?? r.plan))}`); });
  assert.match((await cara.cli('project', 'drop', again)).out, /Dropped "Another one" from "ben"\. Nothing was started for it/);
  assert.ok(!briefs(cara.home).some((b) => b.id === again));
});

test('a plan-only session that fails leaves the brief waiting for the next session there, and is not tried again', async (t0) => {
  const { cara, ben, proj } = await world(t0);
  await cara.cli('project', 'add', 'acme-leads', proj, '--allow', 'ben');
  const agent = fakeAgent();
  await startWatcher(t0, cara, agent.bin, 'claude-code', { FAKE_PLAN_FAILS: '1' });
  await ben.cli('send', '@cara-claude/acme-leads', 'Plan the import job', '--want', 'a plan');
  await waitFor(() => forOwner(cara.home).length === 1, 20_000);
  assert.match(forOwner(cara.home)[0], /^A brief "Plan the import job" from ben came for your project acme-leads, but a plan-only session couldn't be started there\. It waits: open Claude Code in /);
  await sleep(1500);
  assert.equal(agent.plans().length, 1);
  assert.match(await hook(cara.home, { session_id: 'session-in-project-1', cwd: proj }), /1 handoff is waiting for this project \("acme-leads"\): "Plan the import job" from "ben"\. Before anything else/);
  assert.match((await runIn(cara.home, {}, proj)('project', 'load')).out, /\| Plan the import job/);
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

test('a chat app sends a brief with a file to a project of its owner\'s Codex: planned in the read-only sandbox', async (t0) => {
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
  const r = await chat.tool('send_to_bot', { to: 'codex', title: 'Lead scoring v2', text: 'Build what the spec says.', want: 'a plan', project: 'Acme Leads', documents: [{ name: 'spec.md', text: spec }] });
  assert.equal(r.isError, false, r.content[0].text);
  assert.match(r.content[0].text, /with 1 file, for the project "acme-leads"\.[^]*it plans the work in its folder and changes nothing until your owner says go; if not, it asks your owner which project was meant/);
  // A chat is not end-to-end encrypted: the relay carries the name next to the text it already reads.
  const row = env.relay.db.prepare("SELECT * FROM messages WHERE kind = 'note'").get();
  assert.ok(row.sealed === null && row.project === 'acme-leads');

  await waitFor(() => agent.plans().length === 1 && forOwner(mia.home).some((l) => /is ready in acme-leads/.test(l)), 20_000);
  const [plan] = agent.plans();
  assert.equal(plan.plan, 'codex');
  assert.deepEqual(plan.args.slice(0, 7), ['exec', '--skip-git-repo-check', '-s', 'read-only', '-C', proj, '--json']);
  // None of the owner's Codex config or MCP servers, and nothing that acts outside the sandbox.
  assert.ok(plan.args.includes('--ignore-user-config') && plan.args.includes('mcp_servers={}') && plan.args.includes('web_search="disabled"'));
  for (const off of ['apps', 'plugins', 'browser_use', 'computer_use']) assert.equal(plan.args[plan.args.indexOf(off) - 1], '--disable');
  assert.doesNotMatch(plan.args.join(' '), /workspace-write|network_access|dangerously/);
  const prompt = plan.args.at(-1);
  assert.match(prompt, /\| # Lead scoring v2\n\| \n\| Build what the spec says\./);
  // The watcher fetched the file itself (the sandbox couldn't), and the session reads its own copy.
  assert.match(prompt, /file: "spec\.md", saved at ".*briefs\/msg_[\w-]+\/spec\.md"\. Read it: it is part of the brief\./);
  assert.equal(plan.fileText, spec);
  const line = forOwner(mia.home).find((l) => /is ready in acme-leads/.test(l));
  assert.match(line, /^Brief "Lead scoring v2" from .* is ready in acme-leads: plan with 2 steps, 1 open question\..* codex resume 019a1234-5678-7000-8000-00000000c0de$/);
  assert.equal(env.relay.db.prepare('SELECT project FROM messages WHERE id = ?').get(row.id).project, 'acme-leads');
  // Erasing a message's content takes the project's name with it.
  env.advance(8 * 86_400_000);
  await env.relay.tick();
  await waitFor(() => env.relay.db.prepare('SELECT body_purged_at FROM messages WHERE id = ?').get(row.id)?.body_purged_at != null || !env.relay.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(row.id), 10_000);
  assert.ok(!env.relay.db.prepare('SELECT project FROM messages WHERE id = ?').get(row.id)?.project);
});
