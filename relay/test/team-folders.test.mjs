import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN, setup, owner, connect } from './helpers.mjs';

test('team folders require separate grants and preserve encrypted, conflict-checked revisions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'b2b-team-db-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'relay.db');
  const env = await setup(t, { autoTick: false, dbPath });
  const ben = await owner(env, t, 'ben@example.com', 'ben');
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  const made = await ben.cli('group', 'new', 'Research', 'anna');
  const group = Number(made.match(/number (\d+)/)[1]);
  const root = '/v1/team-folders/' + group;
  const args = (action, ...rest) => ['folder', action, String(group), ...rest];
  const grant = async (handle, role, groupId = group) =>
    (
      await fetch(env.url + '/admin/team-folder/member', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' },
        body: JSON.stringify({ group: groupId, handle, role }),
      })
    ).status;
  assert.equal((await ben.api('GET', root)).status, 403);
  assert.equal(
    (await ben.api('POST', '/admin/team-folder/member', { group, handle: 'ben', role: 'write' })).status,
    403,
  );
  assert.equal(await grant('anna', 'read'), 400);
  env.relay.groups.join(env.relay.db.prepare('SELECT * FROM bots WHERE id=?').get(anna.botId), group, {
    byOwner: true,
  });
  assert.equal(await grant('ben', 'write'), 200);
  assert.equal((await anna.api('GET', root)).status, 403);
  const beforeGrant = (await ben.api('GET', root)).json.roster;
  assert.equal(await grant('anna', 'read'), 200);
  assert.equal((await ben.api('POST', root + '/doc_' + '0'.repeat(32), { roster: beforeGrant })).status, 409);
  const path = join(ben.home, 'brief.md'),
    out = join(anna.home, 'download');
  writeFileSync(path, 'first private draft');
  const id = (await ben.cli(...args('create', path))).match(/doc_[a-f0-9]{32}/)[0];
  const otherGroup = Number((await ben.cli('group', 'new', 'Another team')).match(/number (\d+)/)[1]);
  assert.equal(await grant('ben', 'write', otherGroup), 200);
  assert.equal((await ben.api('GET', '/v1/team-folders/' + otherGroup + '/' + id + '/1')).status, 404);
  const oversized = join(ben.home, 'oversized');
  writeFileSync(oversized, Buffer.alloc(48 * 1024 + 1));
  await assert.rejects(ben.cli(...args('create', oversized)), /48 KiB/);
  assert.match(await anna.cli(...args('list')), /r1 "brief.md"/);
  const raw = await anna.api('GET', root + '/' + id + '/1');
  assert.equal(raw.status, 200);
  assert.doesNotMatch(JSON.stringify(raw.json), /first private draft|brief\.md/);
  assert.equal((await anna.api('POST', root + '/' + id, {})).status, 403);
  await anna.cli(...args('get', id, '1', out));
  assert.equal(readFileSync(out, 'utf8'), 'first private draft');
  await assert.rejects(anna.cli(...args('get', id, '1', out)), /EEXIST/);
  writeFileSync(path, 'second draft');
  const outcomes = await Promise.allSettled([
    ben.cli(...args('update', id, '1', path)),
    ben.cli(...args('update', id, '1', path)),
  ]);
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  assert.match(String(outcomes.find((o) => o.status === 'rejected').reason), /stale revision/);
  await ben.cli(...args('restore', id, '1', '2'));
  assert.match(await anna.cli(...args('history', id)), /r3[^]*r2[^]*r1/);
  env.advance(9 * 86400000);
  env.relay.retention();
  await anna.cli(...args('get', id, '3', out + '3'));
  assert.equal(readFileSync(out + '3', 'utf8'), 'first private draft');
  assert.equal(await grant('anna', 'remove'), 200);
  assert.equal((await anna.api('GET', root + '/' + id + '/1')).status, 403);
  assert.equal(await grant('anna', 'read'), 200);
  assert.equal((await anna.api('GET', root + '/' + id + '/1')).status, 404);
  await ben.cli(...args('update', id, '3', path));
  assert.match(await anna.cli(...args('list')), /r4/);
  // A new relay instance opens the existing database. The same primary bot can read
  // the saved metadata, decrypt the revision, and detect damage to stored bytes.
  const reopened = await setup(t, { autoTick: false, dbPath });
  const configPath = join(anna.home, 'config.json');
  const saved = readFileSync(configPath, 'utf8');
  writeFileSync(configPath, JSON.stringify({ ...JSON.parse(saved), relay: reopened.url }));
  await anna.cli(...args('get', id, '4', out + '4'));
  assert.equal(readFileSync(out + '4', 'utf8'), 'second draft');
  reopened.relay.db
    .prepare('UPDATE team_folder_revisions SET ciphertext=zeroblob(length(ciphertext)) WHERE file_id=? AND revision=4')
    .run(id);
  await assert.rejects(anna.cli(...args('get', id, '4', out + 'bad')));
  assert.equal(existsSync(out + 'bad'), false);
  writeFileSync(configPath, saved);
  await anna.cli('group', 'leave', String(group));
  assert.equal((await anna.api('GET', root)).status, 403);
  assert.equal(
    env.relay.db.prepare('SELECT count(*) AS n FROM team_folder_members WHERE bot_id=?').get(anna.botId).n,
    0,
  );
  await ben.cli('group', 'end', String(group));
  assert.equal(
    env.relay.db.prepare('SELECT count(*) AS n FROM team_folder_revisions WHERE group_id=?').get(group).n,
    0,
  );
});
