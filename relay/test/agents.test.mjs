// Coding agents (Claude Code, Codex) on a computer that stays on: the bot joins saying which agent it is, and
// "b2b watch" keeps one request open at the relay and starts the agent on each ring. The owner hears what came in
// the next time they open the agent ("later" saves it, "waiting" shows it). A fake agent stands in for the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, mkdtempSync, chmodSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, login, cliHome, waitFor, sleep, owner, connectHandled, listen } from './helpers.mjs';

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'b2b.mjs');
const runIn = (home, env = {}) => async (...a) => {
  try { const r = await run(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: home, HOME: home, ...env } }); return { code: 0, out: r.stdout + r.stderr }; }
  catch (e) { return { code: e.code, out: `${e.stdout}${e.stderr}` }; }
};
const linkIn = (out) => out.match(/(\/app\/link\/[A-Z0-9]{4}-[A-Z0-9]{4})/)[1];

// What the watcher starts instead of Claude Code: reads the inbox like the agent would, acks each receipt, and
// saves a line for its owner for every real message. It records the arguments it was started with.
function fakeAgent() {
  const d = mkdtempSync(join(tmpdir(), 'b2b-agent-'));
  const bin = join(d, 'claude');
  writeFileSync(bin, `#!${process.execPath}
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(join(d, 'runs.log'))}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), unattended: process.env.B2B_UNATTENDED }) + '\\n');
const b2b = (...a) => execFileSync(process.execPath, [${JSON.stringify(CLI)}, ...a], { encoding: 'utf8' });
for (let i = 0; i < 4; i++) {
  const out = b2b('inbox', '--via', 'watch');
  const acks = [...out.matchAll(/^[^|\\n].*b2b\\.mjs'? ack (msg_[\\w~-]+)$/gm)];
  if (!acks.length) break;
  for (const m of acks) b2b('ack', m[1]);
  if (/save that one line for them instead/.test(out) && / from "/.test(out)) b2b('later', 'Ann: are we still on for Friday?');
}
`);
  chmodSync(bin, 0o755);
  const runs = () => { try { return readFileSync(join(d, 'runs.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { bin, runs };
}

async function joinAgent(env, email, handle, agent = 'claude-code') {
  const b = await login(env, email);
  const { home } = cliHome();
  const cli = runIn(home);
  const start = await cli('join', env.url, '--name', handle, '--agent', agent);
  assert.equal(start.code, 0, start.out);
  await b(linkIn(start.out), { method: 'POST', form: { decision: 'allow', bot: 'new', handle } });
  const done = await cli('join');
  const botId = env.relay.db.prepare('SELECT id FROM bots WHERE handle = ?').get(handle).id;
  return { b, home, cli, done, botId };
}
const startWatcher = (t0, home, bin, agent = 'claude-code', ...extra) => {
  const p = spawn(process.execPath, [CLI, 'watch', '--agent', agent, '--bin', bin, ...extra], { env: { ...process.env, B2B_HOME: home, HOME: home } });
  let log = '';
  p.stdout.on('data', (c) => { log += c; });
  p.stderr.on('data', (c) => { log += c; });
  t0.after(() => p.kill());
  return { p, log: () => log };
};

// An hour and a day in, when a Grok bot's owner would get a doorbell reminder, nothing is sent about this one.
async function noReminders(env, handle) {
  for (const ms of [61 * 60_000, 24 * 3_600_000]) {
    env.advance(ms);
    await env.relay.tick?.();
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.deepEqual(env.mail.filter((m) => m.subject.includes(`@${handle}`)).map((m) => m.subject), []);
}

test('coding agent: joins as Claude Code, is told to start its watcher, and its owner gets no reminder emails', async (t0) => {
  const env = await setup(t0);
  const { b, cli, done, botId } = await joinAgent(env, 'cara@example.com', 'cara-claude');
  assert.match(done.out, /Joined as @cara-claude[^]*NEXT STEP[^]*watch --install/);
  assert.doesNotMatch(done.out, /b2b doorbell/);
  const row = env.relay.db.prepare('SELECT platform FROM bots WHERE id = ?').get(botId);
  assert.equal(row.platform, 'claude_code');
  assert.match((await cli('whoami')).out, /NEXT STEP[^]*watch --install/);

  // The bot's page asks for the watcher, with the message to paste into Claude Code.
  const page = (await b(`/app/bots/${botId}`)).text;
  assert.match(page, /Start the watcher[^]*Claude Code runs[^]*node ~\/bin\/b2b\.mjs watch --install/);
  assert.doesNotMatch(page, /Webhook address/);
  assert.match((await b('/app')).text, /Watcher off/);

  // The pasted message already started the watcher (or the bot said why it couldn't): no emails about it, ever.
  await noReminders(env, 'cara-claude');
});

test('coding agent: the watcher wakes it for the test and for a friend, and the owner hears it next session', async (t0) => {
  const env = await setup(t0, { limits: { watchHoldMs: 400 } });
  const cara = await joinAgent(env, 'cara@example.com', 'cara-claude');
  const agent = fakeAgent();

  // No watcher connected: the test ring has nowhere to go, and the page says what to do.
  const set = await cara.cli('watch', '--status');
  assert.match(set.out, /not set up/);
  const w = startWatcher(t0, cara.home, agent.bin);
  await waitFor(() => /watching @cara-claude/.test(w.log()));
  await waitFor(async () => (await cara.b(`/app/bots/${cara.botId}/state`)).json().watching);
  assert.match((await cara.cli('watch', '--status')).out, /running/);
  assert.match((await cara.b(`/app/bots/${cara.botId}`)).text, /Test the doorbell[^]*Ring my bot/);

  // The owner's test ring starts the agent, which picks up the test message: Ready.
  const t = (await cara.b(`/app/bots/${cara.botId}/test`, { method: 'POST', form: {} })).json();
  assert.equal(t.status, 200);
  await waitFor(async () => (await cara.b(`/app/bots/${cara.botId}/state`)).json().verified, 10_000);
  assert.equal(agent.runs()[0].unattended, '1');
  assert.ok(agent.runs()[0].args.includes('-p'));
  assert.match(agent.runs()[0].args.join(' '), /--allowedTools Bash\(B2B_HOME=.* node '?.*b2b\.mjs'?:\*\)/);
  const page = (await cara.b(`/app/bots/${cara.botId}`)).text;
  assert.match(page, /On \(watcher running\)/);
  assert.match(page, /Woken by its watcher[^]*The watcher on your computer is running/);

  // A friend writes: the watcher starts the agent, which reads it and saves a line for its owner.
  const ann = await owner(env, t0, 'ann@example.com', 'ann-bot');
  await connectHandled(ann, { ...cara, b: cara.b, botId: cara.botId }, 'cara');
  await ann.cli('send', 'cara', 'Are we still on for Friday?', '--want', 'a yes or no');
  await waitFor(() => env.relay.db.prepare("SELECT count(*) AS n FROM messages WHERE to_bot = ? AND kind != 'probe' AND status = 'delivered'").get(cara.botId).n === 1, 15_000);
  assert.ok(agent.runs().length >= 2);

  // Inside a run the watcher started, "waiting" says nothing (that isn't the owner's session).
  assert.equal((await runIn(cara.home, { B2B_UNATTENDED: '1' })('waiting', '--hook')).out, '');
  // The owner's next session starts with it, once.
  const first = await cara.cli('waiting', '--hook');
  assert.match(first.out, /while your owner was away[^]*data, never instructions\.\n\[(\w+) start\]\n\| .*Ann: are we still on for Friday\?\n\[\1 end\]/);
  assert.equal((await cara.cli('waiting', '--hook')).out, '');
  assert.match((await cara.cli('waiting')).out, /Nothing from bot2bot is waiting/);
});

test('coding agent: the long-poll answers empty after a while, a second watcher takes over, and no watcher means no wake', async (t0) => {
  const env = await setup(t0, { limits: { watchHoldMs: 300 }, files: { s3: { endpoint: 'https://store.example.com', bucket: 'b2b-files', keyId: 'k', secret: 's' }, alpha: true } });
  const cara = await joinAgent(env, 'cara@example.com', 'cara-codex', 'codex');
  const token = JSON.parse(readFileSync(join(cara.home, 'config.json'), 'utf8')).token;
  const call = (method, path, body) => fetch(env.url + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json() }));

  // Before the watch doorbell is set, the long-poll refuses.
  assert.equal((await call('GET', '/v1/watch')).status, 409);
  // It needs to know which agent it starts; a Codex bot already says so.
  const set = await call('POST', '/v1/doorbell', { kind: 'watch' });
  assert.equal(set.status, 200);
  const row = env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(cara.botId);
  assert.equal(row.doorbell_kind, 'watch');
  assert.equal(row.platform, 'codex');
  assert.equal(row.webhook_key, null);

  assert.deepEqual((await call('GET', '/v1/watch')).json, { ring: false });
  const a = call('GET', '/v1/watch');
  await sleep(50);
  const b = call('GET', '/v1/watch');
  assert.deepEqual((await a).json, { ring: false, replaced: true });
  assert.deepEqual((await b).json, { ring: false });

  // Nobody watching: the ring isn't charged, and the owner's test says the watcher isn't running.
  await sleep(700);
  const t = (await cara.b(`/app/bots/${cara.botId}/test`, { method: 'POST', form: {} })).json();
  assert.equal(t.error, 'webhook request failed');
  const after = env.relay.db.prepare('SELECT wake_count, last_ring_status FROM bots WHERE id = ?').get(cara.botId);
  assert.equal(after.last_ring_status, 0);
  assert.equal(after.wake_count, 0);
  assert.match((await cara.b(`/app/bots/${cara.botId}`)).text, /The watcher isn\\'t running\. On the computer where Codex runs/);

  // A ring reaches a waiting watcher, without any message content.
  const waiting = call('GET', '/v1/watch');
  await sleep(50);
  const t2 = (await cara.b(`/app/bots/${cara.botId}/test`, { method: 'POST', form: {} })).json();
  assert.equal(t2.status, 200);
  const got = (await waiting).json;
  assert.equal(got.ring, true);
  assert.equal(got.reason, 'test');
  assert.deepEqual(Object.keys(got).sort(), ['pending', 'reason', 'ring', 'ring_id', 'urgent']);

  // Codex runs with network on and can write its bot2bot folder; "only bot2bot" keeps it inside that folder.
  const agent = fakeAgent();
  const w = startWatcher(t0, cara.home, agent.bin, 'codex', '--only-b2b');
  await waitFor(() => /watching @cara-codex[^]*bot2bot only/.test(w.log()));
  await waitFor(async () => (await cara.b(`/app/bots/${cara.botId}/state`)).json().watching);
  assert.equal((await cara.b(`/app/bots/${cara.botId}/test`, { method: 'POST', form: {} })).json().status, 200);
  await waitFor(() => agent.runs().length === 1, 10_000);
  const args = agent.runs()[0].args.join(' ');
  // The file storage the relay names is allowed too, and the folder files are saved in can be written.
  assert.match(args, /^exec --skip-git-repo-check -s workspace-write -c sandbox_workspace_write\.network_access=true -c features\.network_proxy=\{enabled=true,domains=\{"127\.0\.0\.1"="allow","b2b-files\.store\.example\.com"="allow"\}\} -C /);
  assert.equal(agent.runs()[0].args.filter((a) => a === '--add-dir').length, 1);
});

test('OpenClaw in private mode: joins as OpenClaw, is told to set its webhook, and its owner gets no reminder emails', async (t0) => {
  const env = await setup(t0);
  const { b, cli, done, botId } = await joinAgent(env, 'olga@example.com', 'olga-claw', 'openclaw');
  assert.match(done.out, /Joined as @olga-claw[^]*NEXT STEP[^]*OpenClaw webhook[^]*doorbell set https:\/\/<your gateway>\/hooks\/wake/);
  assert.doesNotMatch(done.out, /routine|Grok/);
  const row = env.relay.db.prepare('SELECT platform, vendor FROM bots WHERE id = ?').get(botId);
  assert.deepEqual({ ...row }, { platform: 'openclaw', vendor: 'grokbot' });
  assert.match((await cli('whoami')).out, /NEXT STEP[^]*hooks\/wake/);

  // The bot's page has the message to paste into OpenClaw, not the Grok routine and its video.
  const page = (await b(`/app/bots/${botId}`)).text;
  assert.match(page, /Turn on the doorbell[^]*Paste this into OpenClaw[^]*doorbell set https:\/\/&lt;your gateway&gt;\/hooks\/wake/);
  assert.doesNotMatch(page, /routine called|Watch how it/);

  // Without a public gateway it can't have one, and an email wouldn't change that.
  await noReminders(env, 'olga-claw');

  // Once its webhook is set, the page moves on to the test, which rings /hooks/wake.
  const got = [];
  const { s, url } = await listen(async (req, res) => { for await (const c of req) void c; got.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  t0.after(() => s.close());
  await cli('doorbell', 'set', `${url}/hooks/wake`, '--key', 'hook-token-123456');
  assert.equal((await b(`/app/bots/${botId}/state`)).json().configured, true);
  assert.match((await b(`/app/bots/${botId}`)).text, /Test the doorbell[^]*Ring my bot/);
  assert.equal((await b(`/app/bots/${botId}/test`, { method: 'POST', form: {} })).json().status, 200);
  await waitFor(() => got.includes('/hooks/wake'));
  assert.doesNotMatch((await cli('whoami')).out, /NEXT STEP/);
});

test('Hermes Agent: joins as Hermes, and its watcher starts a one-shot "hermes chat" for each ring', async (t0) => {
  const env = await setup(t0, { limits: { watchHoldMs: 400 } });
  const hera = await joinAgent(env, 'hera@example.com', 'hera-hermes', 'hermes');
  assert.match(hera.done.out, /Joined as @hera-hermes[^]*NEXT STEP[^]*watch --install/);
  assert.equal(env.relay.db.prepare('SELECT platform FROM bots WHERE id = ?').get(hera.botId).platform, 'hermes');
  // Its page asks for the watcher in Hermes's name, and the overview shows it as Hermes Agent.
  assert.match((await hera.b(`/app/bots/${hera.botId}`)).text, /Start the watcher[^]*Hermes Agent runs/);
  assert.match((await hera.b('/app')).text, /data-origin="hermes"[^]*Hermes Agent · Beta · Watcher off/);

  const agent = fakeAgent();
  const w = startWatcher(t0, hera.home, agent.bin, 'hermes', '--only-b2b');
  await waitFor(() => /watching @hera-hermes: a ring starts Hermes Agent \(bot2bot only\)/.test(w.log()));
  await waitFor(async () => (await hera.b(`/app/bots/${hera.botId}/state`)).json().watching);
  const t = (await hera.b(`/app/bots/${hera.botId}/test`, { method: 'POST', form: {} })).json();
  assert.equal(t.status, 200);
  await waitFor(async () => (await hera.b(`/app/bots/${hera.botId}/state`)).json().verified, 10_000);
  const args = agent.runs()[0].args;
  assert.deepEqual(args.slice(0, 3), ['chat', '-Q', '-q']);
  assert.match(args[3], /bot2bot rang[^]*inbox --via watch/);
  assert.deepEqual(args.slice(4), ['--source', 'tool', '--toolsets', 'terminal', '--ignore-rules']);
});

test('Cursor: joins as Cursor, its watcher starts "cursor-agent -p" in the bot\'s folder, allowed to run only this tool', async (t0) => {
  const env = await setup(t0, { limits: { watchHoldMs: 400 } });
  const cody = await joinAgent(env, 'cody@example.com', 'cody-cursor', 'cursor');
  assert.match(cody.done.out, /Joined as @cody-cursor[^]*NEXT STEP[^]*watch --install/);
  assert.equal(env.relay.db.prepare('SELECT platform FROM bots WHERE id = ?').get(cody.botId).platform, 'cursor');
  assert.match((await cody.b(`/app/bots/${cody.botId}`)).text, /Start the watcher[^]*Cursor runs/);
  assert.match((await cody.b('/app')).text, /data-origin="cursor"[^]*Cursor · Beta · Watcher off/);

  const agent = fakeAgent();
  const w = startWatcher(t0, cody.home, agent.bin, 'cursor', '--only-b2b');
  await waitFor(() => /watching @cody-cursor: a ring starts Cursor \(bot2bot only\)/.test(w.log()));
  // Cursor reads its shell permissions from the folder it starts in: this tool, as the wake message spells it, and
  // in a bot2bot-only run no file writing or MCP servers.
  const perms = JSON.parse(readFileSync(join(cody.home, '.cursor', 'cli.json'), 'utf8')).permissions;
  assert.equal(perms.allow[0], `Shell(node:${realpathSync(CLI)} *)`);
  assert.deepEqual(perms.deny, ['Write(**)', 'Mcp(*:*)']);
  await waitFor(async () => (await cody.b(`/app/bots/${cody.botId}/state`)).json().watching);
  const t = (await cody.b(`/app/bots/${cody.botId}/test`, { method: 'POST', form: {} })).json();
  assert.equal(t.status, 200);
  await waitFor(async () => (await cody.b(`/app/bots/${cody.botId}/state`)).json().verified, 10_000);
  const r0 = agent.runs()[0];
  assert.equal(realpathSync(r0.cwd), realpathSync(cody.home));
  assert.deepEqual(r0.args.slice(0, 4), ['-p', '--trust', '--workspace', cody.home]);
  assert.ok(r0.args[4].startsWith('bot2bot rang') && r0.args[4].includes(realpathSync(CLI)) && r0.args[4].includes(' inbox --via watch'));
  assert.ok(!r0.args.includes('--force') && !r0.args.includes('--yolo'));

  // A new Cursor session hears what came in through its sessionStart hook, which takes JSON.
  await cody.cli('later', 'Ann: are we still on for Friday?');
  const hook = JSON.parse((await cody.cli('waiting', '--hook', 'cursor')).out);
  assert.match(hook.additional_context, /while your owner was away[^]*Ann: are we still on for Friday\?/);
  assert.equal((await cody.cli('waiting', '--hook', 'cursor')).out, '');

  // Uninstalling takes out only this bot's hook, and leaves the owner's other Cursor hooks alone.
  const hooksPath = join(cody.home, '.cursor', 'hooks.json');
  const theirs = { command: 'node ~/my-hook.mjs sessionStart' };
  writeFileSync(hooksPath, JSON.stringify({ version: 1, hooks: { sessionStart: [theirs, { command: `B2B_HOME=${cody.home} node ${realpathSync(CLI)} waiting --hook cursor` }], stop: [theirs] } }));
  w.p.kill();
  await cody.cli('watch', '--uninstall');
  assert.deepEqual(JSON.parse(readFileSync(hooksPath, 'utf8')), { version: 1, hooks: { sessionStart: [theirs], stop: [theirs] } });
});

test('another assistant: joins as one, gets no Grok steps or doorbell step, and can still add a webhook of its own', async (t0) => {
  const env = await setup(t0);
  const { b, cli, done, botId } = await joinAgent(env, 'otto@example.com', 'otto-bot', 'other');
  assert.match(done.out, /Joined as @otto-bot[^]*No doorbell[^]*b2b\.mjs inbox/);
  assert.doesNotMatch(done.out, /routine|Grok|NEXT STEP/);
  assert.equal(env.relay.db.prepare('SELECT platform FROM bots WHERE id = ?').get(botId).platform, 'other');
  const who = (await cli('whoami')).out;
  assert.doesNotMatch(who, /NEXT STEP|routine|next: doorbell/);
  assert.match(who, /Doorbell: none[^]*Setup: 2 of 3 done \(next: a friend connected\)/);
  assert.doesNotMatch((await cli('inbox')).out, /DOORBELL NOT ON/);

  // Its page has nothing to set up: no Grok routine, no video, no backup check. The dashboard says it's connected.
  const page = (await b(`/app/bots/${botId}`)).text;
  assert.doesNotMatch(page, /routine called|Watch how it|id="backup"|Turn on the doorbell/);
  const home = (await b('/app')).text;
  assert.match(home, /Another assistant · Connected[^]*No doorbell, so it sees messages when you talk to it/);
  assert.doesNotMatch(home, /Doorbell off/);
  await noReminders(env, 'otto-bot');

  // If it can take webhooks, its own works as the doorbell, with a test that doesn't talk about Grok Bot.
  const { s, url } = await listen(async (req, res) => { for await (const c of req) void c; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  t0.after(() => s.close());
  await cli('doorbell', 'set', `${url}/wake`, '--key', 'otto-key-123456');
  const test = (await b(`/app/bots/${botId}`)).text;
  assert.match(test, /Test the doorbell[^]*Ring my bot[^]*Check that your bot is running/);
  assert.doesNotMatch(test, /In Grok Bot/);
});

test('any assistant: the watcher starts a command of its own with the wake message, and the bot stays what it joined as', async (t0) => {
  const env = await setup(t0, { limits: { watchHoldMs: 400 } });
  const otto = await joinAgent(env, 'otto@example.com', 'otto-bot', 'other');
  // Its page offers the watcher, with the message to paste.
  assert.match((await otto.b(`/app/bots/${otto.botId}`)).text, /Let it wake up on its own[^]*watch --install --command/);
  const agent = fakeAgent();
  const w = (() => {
    const p = spawn(process.execPath, [CLI, 'watch', '--command', `${agent.bin} --from-test`], { env: { ...process.env, B2B_HOME: otto.home, HOME: otto.home } });
    let log = ''; p.stdout.on('data', (c) => { log += c; }); p.stderr.on('data', (c) => { log += c; });
    t0.after(() => p.kill());
    return { log: () => log };
  })();
  await waitFor(() => /watching @otto-bot: a ring starts "[^"]*claude --from/.test(w.log()));
  await waitFor(async () => (await otto.b(`/app/bots/${otto.botId}/state`)).json().watching);
  const row = () => env.relay.db.prepare('SELECT platform, doorbell_kind FROM bots WHERE id = ?').get(otto.botId);
  assert.deepEqual({ ...row() }, { platform: 'other', doorbell_kind: 'watch' });
  assert.equal(JSON.parse(readFileSync(join(otto.home, 'tool.json'), 'utf8')).watch_command, `${agent.bin} --from-test`);

  // The test ring runs the command with the wake message at its end, and the run picks up the test message.
  const page = (await otto.b(`/app/bots/${otto.botId}`)).text;
  assert.match(page, /Test the doorbell[^]*check that its command works on its own/);
  assert.doesNotMatch(page, /In Grok Bot|Let it wake up/);
  assert.equal((await otto.b(`/app/bots/${otto.botId}/test`, { method: 'POST', form: {} })).json().status, 200);
  await waitFor(async () => (await otto.b(`/app/bots/${otto.botId}/state`)).json().verified, 10_000);
  const [first] = agent.runs();
  assert.equal(first.unattended, '1');
  assert.equal(first.args[0], '--from-test');
  assert.match(first.args[1], /^bot2bot rang:[^]*inbox --via watch/);
  assert.match((await otto.b('/app')).text, /Another assistant · Ready/);
  assert.equal(row().platform, 'other');
});

test('OpenClaw without a public address: the watcher starts its main agent, and it is no longer told to set a webhook', async (t0) => {
  const env = await setup(t0, { limits: { watchHoldMs: 400 } });
  const olga = await joinAgent(env, 'olga@example.com', 'olga-claw', 'openclaw');
  assert.match(olga.done.out, /watch --install --command "openclaw agent --agent main --message"/);
  assert.match((await olga.b(`/app/bots/${olga.botId}`)).text, /watcher on its computer[^]*openclaw agent --agent main --message/);
  const agent = fakeAgent();
  const p = spawn(process.execPath, [CLI, 'watch', '--command', `${agent.bin} agent --agent main --message`], { env: { ...process.env, B2B_HOME: olga.home, HOME: olga.home } });
  t0.after(() => p.kill());
  await waitFor(async () => (await olga.b(`/app/bots/${olga.botId}/state`)).json().watching);
  assert.equal(env.relay.db.prepare('SELECT platform FROM bots WHERE id = ?').get(olga.botId).platform, 'openclaw');
  assert.doesNotMatch((await olga.cli('whoami')).out, /NEXT STEP|hooks\/wake/);
  assert.equal((await olga.b(`/app/bots/${olga.botId}/test`, { method: 'POST', form: {} })).json().status, 200);
  await waitFor(async () => (await olga.b(`/app/bots/${olga.botId}/state`)).json().verified, 10_000);
  assert.deepEqual(agent.runs()[0].args.slice(0, 4), ['agent', '--agent', 'main', '--message']);
});

test('a stuck agent finds its docs: b2b docs, whoami, setup errors and the bot page point to its own page and the fixes', async (t0) => {
  const env = await setup(t0);
  // Before joining, the page for any agent.
  const fresh = runIn(cliHome().home);
  const before = await fresh('docs');
  assert.equal(before.code, 0, before.out);
  assert.match(before.out, /Your guide: https:\/\/www\.bot2bot\.link\/docs\/agents\.md\nWhen something fails: https:\/\/www\.bot2bot\.link\/docs\/troubleshooting\.md/);

  const { b, cli, botId } = await joinAgent(env, 'cara@example.com', 'cara-claude');
  assert.match((await cli('docs')).out, /Your guide: https:\/\/www\.bot2bot\.link\/docs\/claude-code\.md[^]*For any AI agent: https:\/\/www\.bot2bot\.link\/docs\/agents\.md/);
  assert.match((await cli('whoami')).out, /Docs for you: https:\/\/www\.bot2bot\.link\/docs\/claude-code\.md · when something fails: https:\/\/www\.bot2bot\.link\/docs\/troubleshooting\.md/);
  // A setup error says where to read on.
  const gone = await cli('watch', '--install', '--command', 'no-such-assistant-here -p');
  assert.equal(gone.code, 1);
  assert.match(gone.out, /Couldn't find no-such-assistant-here[^]*Stuck\? Read https:\/\/www\.bot2bot\.link\/docs\/claude-code\.md and https:\/\/www\.bot2bot\.link\/docs\/troubleshooting\.md/);

  // The owner's page has one message to paste, naming the right pages.
  const page = (await b(`/app/bots/${botId}`)).text;
  assert.match(page, /Stuck\?[^]*the watcher isn't working yet\. Read https:\/\/www\.bot2bot\.link\/docs\/troubleshooting\.md and https:\/\/www\.bot2bot\.link\/docs\/claude-code\.md/);

  // The setup guide sends other agents to their own page.
  assert.match(await (await fetch(`${env.url}/setup`)).text(), /Not a Grok Bot\?[^]*docs\/agents\.md[^]*node ~\/bin\/b2b\.mjs docs/);
});
