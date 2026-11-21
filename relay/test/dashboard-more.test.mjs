// Features that worked only from a bot's tool now show on the dashboard (0.29.5): a job sender's own page, the
// computers a bot runs on (with Remove and Undo), briefs held for a project, a group run with Stop, and a group's
// shared folder (on, off, and who can read or write).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, owner, connect, cliHome } from './helpers.mjs';

const CLI = join(import.meta.dirname, '..', 'cli', 'b2b.mjs');
const exec = promisify(execFile);
const run = async (home, ...args) => {
  try { const r = await exec(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, B2B_HOME: home, B2B_UNATTENDED: '' } }); return { code: 0, out: r.stdout + r.stderr }; }
  catch (e) { return { code: e.code, out: `${e.stdout}${e.stderr}` }; }
};
const ok = async (home, ...args) => { const r = await run(home, ...args); assert.equal(r.code, 0, r.out); return r.out; };
const cfg = (home) => JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'));
const bare = (html) => html.replace(/<style>[^]*?<\/style>/g, '').replace(/<script>[^]*?<\/script>/g, '').replace(/<svg[^]*?<\/svg>/g, '');
const view = async (b, path) => bare((await b(path)).text);
async function go(b, path, form) {
  const r = await b(path, { method: 'POST', form });
  assert.equal(r.status, 303, `${path}: ${bare(r.text).slice(0, 400)}`);
  return bare((await b(r.location)).text);
}
const row = (env, id) => env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(id));

test('a job sender gets its own page: what it does and where it posts, no doorbell to set up', async (t0) => {
  const env = await setup(t0);
  const tom = await owner(env, t0, 'tom@example.com', 'tom', { status: 503 });
  await tom.b('/app/bots', { method: 'POST', form: { handle: 'server-jobs' } });
  const code = env.relay.db.prepare("SELECT plain_code FROM enroll_codes WHERE handle = 'server-jobs' ORDER BY rowid DESC").get().plain_code;
  const svc = cliHome();
  await svc.cli('enroll', env.url, code);
  const svcId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'server-jobs'").get().id;
  const gid = Number((await tom.cli('group', 'new', 'Server jobs', '@server-jobs')).match(/\(number (\d+)\)/)[1]);
  env.relay.groups.join(row(env, svcId), gid, { byOwner: true });
  await ok(svc.home, 'job', 'setup', String(gid), '--triage', '@tom', '--owner-ok');

  const page = await view(tom.b, `/app/bots/${svcId}`);
  assert.match(page, /<h2>Posts job reports<\/h2>[^]*badge--success">Job reports</);
  assert.match(page, new RegExp(`daily digests to <b>Server jobs</b>[^]*href="/app/groups/${gid}">Open Server jobs<`));
  assert.doesNotMatch(page, /Doorbell off|Turn on the doorbell|Start the watcher|Test the doorbell/);
  assert.match(page, /Disconnect this bot/);

  const home = await view(tom.b, '/app');
  assert.doesNotMatch(home, /Doorbell off|Watcher off/);
  assert.match(home, /No doorbell needed\. It only posts job reports to its group\./);
  // The group opens as Tom's own bot, never as the job sender.
  assert.match(home, new RegExp(`href="/app/groups/${gid}\\?bot=${tom.botId}"`));
  assert.match(await view(tom.b, `/app/groups/${gid}`), /You<\/span><span class="line__sub">@tom · admin</);
});

test('a bot on several computers: the page lists them, Remove cuts one off at once, and Undo lets it back in', async (t0) => {
  const env = await setup(t0, { autoTick: false });
  const tom = await owner(env, t0, 'tom@example.com', 'tom', { status: 503 });
  assert.doesNotMatch(await view(tom.b, `/app/bots/${tom.botId}`), /id="devices"/, 'one computer: nothing to show');

  const d = cliHome();
  const [, id, code] = (await ok(d.home, 'device', 'link', env.url, '--name', 'server')).match(/device approve (d_\w+) ([A-F0-9]{16})/);
  const confirm = (await ok(tom.home, 'device', 'approve', id, code, '--owner-ok')).match(/--confirm ([A-F0-9]{16})/)[1];
  await ok(d.home, 'device', 'link', '--confirm', confirm);
  const asDevice = () => fetch(`${env.url}/v1/me`, { headers: { authorization: `Bearer ${cfg(d.home).token}` } }).then((r) => r.status);
  assert.equal(await asDevice(), 200);

  const page = await view(tom.b, `/app/bots/${tom.botId}`);
  assert.match(page, /id="devices"[^]*Computers <span class="count">2<[^]*Main computer[^]*Wakes your bot and adds new computers[^]*server[^]*Linked just now[^]*name="device" value="d_\w+"[^]*Remove</);

  const removed = await go(tom.b, `/app/bots/${tom.botId}/devices`, { device: id, off: '1' });
  assert.match(removed, /class="toast__what">Removed server<[^]*name="device" value="d_\w+"[^]*name="undo" value="1"[^]*toast__undo">Undo</);
  assert.match(removed, /server <span class="badge badge--neutral">Removed<\/span>[^]*It can't read or send anymore\./);
  assert.equal(await asDevice(), 401, 'its token stops working right away');
  // The main computer is told how to free the place on the signed list.
  assert.match(await ok(tom.home, 'device', 'list'), /server · removed by your owner on the dashboard; finish with: b2b device revoke server --owner-ok/);

  const back = await go(tom.b, `/app/bots/${tom.botId}/devices`, { device: id, undo: '1' });
  assert.match(back, /class="toast__what">server is back</);
  assert.doesNotMatch(back, /toast__undo/);
  assert.equal(await asDevice(), 200);

  // Once the main computer revokes it, it's gone from the page and Undo can't bring it back.
  await go(tom.b, `/app/bots/${tom.botId}/devices`, { device: id, off: '1' });
  await ok(tom.home, 'device', 'revoke', 'server', '--owner-ok');
  assert.doesNotMatch(await view(tom.b, `/app/bots/${tom.botId}`), /id="devices"/);
  assert.equal((await tom.b(`/app/bots/${tom.botId}/devices`, { method: 'POST', form: { device: id, undo: '1' } })).status, 404);
  assert.equal(await asDevice(), 401);
});

test('briefs held for a project: the tool says how many, and the owner sees it with a message for the bot', async (t0) => {
  const env = await setup(t0);
  const tom = await owner(env, t0, 'tom@example.com', 'tom', { status: 503 });
  const held = (n) => ({ items: Array.from({ length: n }, (_, i) => ({ id: `msg_held${i}`, state: 'held', why: 'unknown', asked: 'acme', project: null, from: 'Anna', handle: '@anna', saved_at: new Date().toISOString() })) });
  writeFileSync(join(tom.home, 'briefs.json'), JSON.stringify(held(2)));
  await ok(tom.home, 'contacts');
  assert.equal(row(env, tom.botId).held_briefs, 2);

  const home = await view(tom.b, '/app');
  assert.match(home, new RegExp(`2 briefs for @tom are waiting for a project[^]*href="/app/bots/${tom.botId}#held">Show the message<`));
  const page = await view(tom.b, `/app/bots/${tom.botId}`);
  assert.match(page, /id="held"><h2>2 briefs are waiting for a project<\/h2>[^]*nothing started\. Paste this into your bot&#39;s chat:|id="held"><h2>2 briefs are waiting for a project<\/h2>[^]*nothing started\. Paste this into your bot's chat:/);
  assert.match(page, /run node ~\/bin\/b2b\.mjs project list/);
  // Nothing about who sent it or which project reaches the relay: only the count.
  assert.doesNotMatch(JSON.stringify(env.relay.db.prepare('SELECT * FROM bots').all()), /acme|msg_held/);

  // Sent on or dropped: the count goes and so does the card.
  writeFileSync(join(tom.home, 'briefs.json'), JSON.stringify(held(0)));
  await ok(tom.home, 'contacts');
  assert.doesNotMatch(await view(tom.b, `/app/bots/${tom.botId}`), /id="held"/);
  assert.doesNotMatch(await view(tom.b, '/app'), /waiting for a project/);
});

// Ben's group with Anna and Tom, everyone joined.
async function trio(t0) {
  const env = await setup(t0, { autoTick: false });
  const ben = await owner(env, t0, 'ben@example.com', 'ben', { status: 503 });
  const anna = await owner(env, t0, 'anna@example.com', 'anna', { status: 503 });
  const tom = await owner(env, t0, 'tom@example.com', 'tom', { status: 503 });
  await connect(ben, anna, 'Ben');
  await connect(ben, tom, 'Ben');
  const gid = Number((await ben.cli('group', 'new', 'Research', 'anna', 'tom')).match(/number (\d+)/)[1]);
  for (const p of [anna, tom]) env.relay.groups.join(row(env, p.botId), gid, { byOwner: true });
  return { env, ben, anna, tom, gid };
}
const fakeSeal = (c) => `b2b1.${c.repeat(43)}.${c.repeat(16)}.${c.repeat(20)}.${c.repeat(86)}`;

test('a group run shows who holds which role and when, and whoever started it can stop it', async (t0) => {
  const { env, ben, anna, tom, gid } = await trio(t0);
  assert.doesNotMatch(await view(ben.b, `/app/groups/${gid}`), /id="run-h"/);
  const at = env.now() + 30 * 60_000;
  const started = await ben.api('POST', `/v1/groups/${gid}/runs`, {
    roles: { editor: '@anna', fact_checker: '@tom' }, def_hash: 'a'.repeat(64),
    clock: [{ at, step: 'start' }, { at: at + 3_600_000, step: 'due' }, { at: at + 7_200_000, step: 'end' }],
    sealed: { '@ben': fakeSeal('b'), '@anna': fakeSeal('a'), '@tom': fakeSeal('t') },
  });
  assert.equal(started.status, 200, JSON.stringify(started.json));

  const page = await view(ben.b, `/app/groups/${gid}`);
  assert.match(page, /id="run-h">Group run<[^]*Starts [^<]+ <span class="badge badge--info">Scheduled<\/span>[^]*Editor: Anna · Fact checker: Tom[^]*action="\/app\/groups\/\d+\/run-stop"/);
  // Tom holds a role but didn't start it and isn't an admin: he sees it, without Stop.
  const toms = await view(tom.b, `/app/groups/${gid}`);
  assert.match(toms, /Editor: Anna · Fact checker: You/);
  assert.doesNotMatch(toms, /run-stop/);

  const stopped = await go(ben.b, `/app/groups/${gid}/run-stop`, { bot: ben.botId, run: started.json.id });
  assert.match(stopped, /class="toast__what">Stopped the run</);
  assert.doesNotMatch(stopped, /id="run-h"/);
  assert.ok(env.relay.db.prepare('SELECT stopped_at FROM group_runs WHERE id = ?').get(started.json.id).stopped_at);
  assert.doesNotMatch(await view(anna.b, `/app/groups/${gid}`), /id="run-h"/);
});

test("a group's shared folder: admins turn it on and pick who reads or writes, with Undo; members see their access", async (t0) => {
  const { env, ben, anna, tom, gid } = await trio(t0);
  const page = await view(ben.b, `/app/groups/${gid}`);
  assert.match(page, /id="folder-h">Shared folder <span class="badge badge--info">Alpha<[^]*action="\/app\/groups\/\d+\/folder"[^]*Turn on the shared folder/);
  assert.match(await view(anna.b, `/app/groups/${gid}`), /The shared folder is off\. A group admin can turn it on\./, 'off: a member only sees that it is off');

  const on = await go(ben.b, `/app/groups/${gid}/folder`, { bot: ben.botId, on: '1' });
  assert.match(on, /class="toast__what">Shared folder on<[^]*toast__undo">Undo</);
  assert.match(on, new RegExp(`id="fperm-${anna.botId}">Anna<[^]*aria-pressed="true">No access<`));

  const granted = await go(ben.b, `/app/groups/${gid}/folder-access`, { bot: ben.botId, member: anna.botId, role: 'read' });
  assert.match(granted, /class="toast__what">Anna can read the folder<[^]*name="role" value="remove"[^]*toast__undo">Undo</);
  assert.match(granted, new RegExp(`id="fperm-${anna.botId}">Anna<[^]*aria-pressed="true">Read<`));
  assert.equal(env.relay.db.prepare('SELECT role FROM team_folder_members WHERE group_id = ? AND bot_id = ?').get(gid, Number(anna.botId)).role, 'read');
  // Her bot can open the folder now, and her page opens it (no access controls: she isn't an admin).
  assert.equal((await anna.api('GET', `/v1/team-folders/${gid}`)).status, 200);
  const annas = await view(anna.b, `/app/groups/${gid}`);
  assert.match(annas, /id="folder-app"/);
  assert.doesNotMatch(annas, /folder-access/);
  // A member can't change access by posting the form.
  const refused = await anna.b(`/app/groups/${gid}/folder-access`, { method: 'POST', form: { bot: anna.botId, member: tom.botId, role: 'write' } });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /Only group admins can change who has access to the shared folder\./);

  const undone = await go(ben.b, `/app/groups/${gid}/folder-access`, { bot: ben.botId, member: anna.botId, role: 'remove', undo: '1' });
  assert.match(undone, /class="toast__what">Anna has no access to the folder</);
  assert.equal((await anna.api('GET', `/v1/team-folders/${gid}`)).status, 403);

  const off = await go(ben.b, `/app/groups/${gid}/folder`, { bot: ben.botId });
  assert.match(off, /class="toast__what">Shared folder off</);
  assert.doesNotMatch(off, /id="fperm-/);
});

test('on the hosted relay the shared folder shows only to Infinite owners', async (t0) => {
  const env = await setup(t0, { autoTick: false, hosted: true });
  const ben = await owner(env, t0, 'ben@example.com', 'ben', { status: 503 });
  const gid = Number((await ben.cli('group', 'new', 'Research')).match(/number (\d+)/)[1]);
  assert.doesNotMatch(await view(ben.b, `/app/groups/${gid}`), /id="folder-h"/);
  env.relay.db.prepare('UPDATE users SET infinite_at = ? WHERE email = ?').run(env.now(), 'ben@example.com');
  assert.match(await view(ben.b, `/app/groups/${gid}`), /id="folder-h">Shared folder/);
});
