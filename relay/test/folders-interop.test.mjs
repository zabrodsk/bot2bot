// Shared folders v2 end to end: the real relay, two real CLI homes (Ben and Anna, each syncing a local folder), and the
// browser's own client code (folders-web.mjs) paired as one of Ben's linked devices. Everything crosses the real API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { folderCrypto, folderMerge, folderClient } from '../folders-web.mjs';
import { setup, owner, connect } from './helpers.mjs';

const core = folderCrypto(globalThis.crypto);
const merge = folderMerge();
const enc = new TextEncoder(), dec = new TextDecoder();

// The browser pairs exactly like the dashboard does: its own keys, the link request, the owner's bot approves.
async function pairBrowser(env, bot, name) {
  const post = async (path, body) => (await fetch(env.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const keys = await core.newDeviceKeys();
  const link = await core.linkRequest(keys, name);
  await post('/v1/devices/link', { request: link.request, proof: link.proof });
  const said = await bot.cli('device', 'approve', link.request.id, await core.deviceCode(link.request), '--owner-ok');
  const back = said.match(/--confirm ([0-9A-F]{16})/)[1];
  const approved = await post('/v1/devices/link/poll', { id: link.request.id, proof: await core.pollProof(keys, link.request.id) });
  const done = await core.finishLink(link, keys, approved, back);
  return { keys, done };
}

test('browser and two CLI folders share one document over the real relay: backfill, merge, suggestion, one file', async (t) => {
  const env = await setup(t, { autoTick: false });
  const ben = await owner(env, t, 'ben@example.com', 'ben');
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  const gid = Number((await ben.cli('group', 'new', 'Research', 'anna')).match(/number (\d+)/)[1]);
  const G = String(gid);
  await ben.cli('folder', 'on', G);

  const dirB = mkdtempSync(join(tmpdir(), 'b2b-fold-ben-')), dirA = mkdtempSync(join(tmpdir(), 'b2b-fold-anna-'));
  t.after(() => { rmSync(dirB, { recursive: true, force: true }); rmSync(dirA, { recursive: true, force: true }); });
  const first = '# Report\n\n## Market\nTBD\n\n## Risks\nTBD\n\n## Decision\nwait\n';
  writeFileSync(join(dirB, 'report.md'), first);
  await ben.cli('folder', 'sync', G, dirB, '--once');
  const root = '/v1/team-folders/' + G;
  const db = env.relay.db;
  const targets = async () => (await ben.api('GET', root + '/backfill')).json.items;
  const attempt = async (handle) => (await ben.api('POST', root + '/backfill', {
    handle, device: 'primary', roster: (await ben.api('GET', root)).json.roster,
    file_id: db.prepare('SELECT file_id FROM team_folder_revisions').get().file_id, version: 1,
  })).status;
  assert.deepEqual(await targets(), []);
  assert.equal(await attempt('anna'), 403);
  assert.equal(await attempt('outsider'), 403);
  env.relay.groups.join(env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(anna.botId), gid, { byOwner: true });
  assert.deepEqual((await anna.api('GET', '/v1/team-folders')).json.groups, [gid]);
  assert.deepEqual((await targets())[0].missing_members, [{ handle: 'anna', device: 'primary' }]);
  const block = db.prepare('UPDATE contacts SET blocked=? WHERE owner_bot=? AND peer_bot=?');
  block.run(1, anna.botId, ben.botId);
  assert.deepEqual(await targets(), []);
  assert.equal(await attempt('anna'), 403);
  block.run(0, anna.botId, ben.botId);
  await ben.cli('folder', 'sync', G, '--once');
  const copy = db.prepare('SELECT rowid,backfill,envelope FROM team_folder_copies WHERE backfill IS NOT NULL').get();
  const descriptor = JSON.parse(copy.backfill);
  assert.equal(descriptor.handle, 'ben');
  const setCopy = db.prepare('UPDATE team_folder_copies SET backfill=?,envelope=? WHERE rowid=?');
  setCopy.run(JSON.stringify({ ...descriptor, device_list: { signature: 'forged' } }), copy.envelope, copy.rowid);
  await assert.rejects(anna.cli('folder', 'sync', G, dirA, '--once'), /signature/);
  assert.equal(existsSync(join(dirA, 'report.md')), false);
  setCopy.run(copy.backfill, copy.envelope.replace(/\.[^.]+$/, '.' + 'A'.repeat(86)), copy.rowid);
  await assert.rejects(anna.cli('folder', 'sync', G, dirA, '--once'), /signature/);
  assert.equal(existsSync(join(dirA, 'report.md')), false);
  setCopy.run(copy.backfill, copy.envelope, copy.rowid);
  await anna.cli('folder', 'sync', G, dirA, '--once');
  assert.equal(readFileSync(join(dirA, 'report.md'), 'utf8'), first);

  // Anna forwards her verified copy to Ben's newly paired browser.
  const { keys, done } = await pairBrowser(env, ben, 'web-chrome');
  const store = new Map(), pins = { get: async (h) => store.get(h), set: async (h, v) => store.set(h, v) };
  const web = folderClient({ core, merge, fetch, base: env.url, group: gid, keys, pins,
    device: { token: done.token, handle: done.handle, device: { id: done.device.id, name: done.device.name }, root: done.device.root } });
  await web.refresh();
  await anna.cli('folder', 'sync', G, '--once');
  await web.sync();
  const doc = web.live().find((f) => f.manifest?.path === 'report.md');
  assert.ok(doc, 'the browser sees the file written before it was paired');
  const textAt = async (v) => dec.decode((await web.load(doc.file_id, v)).data);
  assert.equal(await textAt(doc.version), first);

  // Different sections at once: Anna's folder edits Market, the browser edits Risks from the same version. Both land.
  const base = doc.version, baseText = first;
  writeFileSync(join(dirA, 'report.md'), first.replace('## Market\nTBD', '## Market\nGrowing 20%'));
  await anna.cli('folder', 'sync', G, '--once');
  const merged = await web.write({ fileId: doc.file_id, path: 'report.md', data: enc.encode(baseText.replace('## Risks\nTBD', '## Risks\nSupply')), base, baseData: enc.encode(baseText) });
  assert.equal(merged.outcome, 'merged');
  await anna.cli('folder', 'sync', G, '--once');
  await ben.cli('folder', 'sync', G, '--once');
  const both = '# Report\n\n## Market\nGrowing 20%\n\n## Risks\nSupply\n\n## Decision\nwait\n';
  assert.equal(readFileSync(join(dirA, 'report.md'), 'utf8'), both);
  assert.equal(readFileSync(join(dirB, 'report.md'), 'utf8'), both);

  // The same line: Anna decides "hire" in her folder, the browser decides "pause" from the older version.
  await web.sync();
  const cur = web.state.files.get(doc.file_id);
  const curText = await textAt(cur.version);
  writeFileSync(join(dirA, 'report.md'), both.replace('## Decision\nwait', '## Decision\nhire'));
  await anna.cli('folder', 'sync', G, '--once');
  const clash = await web.write({ fileId: doc.file_id, path: 'report.md', data: enc.encode(curText.replace('## Decision\nwait', '## Decision\npause')), base: cur.version, baseData: enc.encode(curText) });
  assert.equal(clash.outcome, 'suggestion');
  // Anna's CLI sees the browser's suggestion and accepts it: only the decision changes, the rest stays.
  const listed = await anna.cli('folder', 'suggestions', G);
  const id = listed.match(/p_[0-9a-f]{32}/)[0];
  await anna.cli('folder', 'resolve', G, id, 'accept');
  await anna.cli('folder', 'sync', G, '--once');
  const after = readFileSync(join(dirA, 'report.md'), 'utf8');
  assert.equal(after, both.replace('## Decision\nwait', '## Decision\npause'));
  await web.sync();
  assert.equal(web.state.proposals.get(id)?.state, 'accepted');

  // A precise edit from Anna's CLI reaches the browser.
  await anna.cli('folder', 'edit', G, 'report.md', '--old', 'Growing 20%', '--new', 'Growing 25%');
  await web.sync();
  assert.match(await textAt(web.state.files.get(doc.file_id).version), /Growing 25%/);

  // One document throughout: no copies in either folder.
  assert.deepEqual(readdirSync(dirA).filter((n) => !n.startsWith('.')), ['report.md']);
  await ben.cli('folder', 'sync', G, '--once');
  assert.deepEqual(readdirSync(dirB).filter((n) => !n.startsWith('.')), ['report.md']);
  await ben.cli('folder', 'revoke', G, '@anna');
  assert.deepEqual(await targets(), []);
  assert.equal(await attempt('anna'), 403);
  await ben.cli('folder', 'grant', G, '@anna', 'write');
  assert.equal((await anna.api('GET', root)).json.role, 'write');
  await anna.cli('group', 'leave', G);
  assert.deepEqual(await targets(), []);
  assert.equal(await attempt('anna'), 403);
});
