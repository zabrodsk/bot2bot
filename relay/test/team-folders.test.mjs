import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  truncateSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { store } from './s3-store.mjs';
import {
  randomBytes,
  createPrivateKey,
  createPublicKey,
  createHash,
  generateKeyPairSync,
  diffieHellman,
  hkdfSync,
  createCipheriv,
  sign,
} from 'node:crypto';
import { ADMIN, setup, owner, connect, cliHome, waitFor, listen } from './helpers.mjs';

async function team(t, opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'b2b-folder-tests-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = await setup(t, { dbPath: join(dir, 'relay.db'), autoTick: false, ...opts });
  const a = await owner(env, t, 'ben@example.com', 'ben'),
    b = await owner(env, t, 'anna@example.com', 'anna');
  await connect(a, b, 'Ben');
  const group = (await a.cli('group', 'new', 'Research', 'anna')).match(/number (\d+)/)[1];
  const db = env.relay.db,
    root = '/v1/team-folders/' + group;
  env.relay.groups.join(db.prepare('SELECT * FROM bots WHERE id=?').get(b.botId), Number(group), { byOwner: true });
  const cmd = (bot, verb, ...args) => bot.cli('folder', verb, group, ...args);
  const sync = (bot) => cmd(bot, 'sync', '--once');
  const file = (bot, name) => join(bot.home, 'shared', 'Research', name);
  return {
    env,
    db,
    dir,
    group,
    a,
    b,
    root,
    cmd,
    sync,
    file,
    async enable() {
      await cmd(a, 'on');
      await sync(a);
      await sync(b);
    },
  };
}

test('two homes exchange saves, merge Markdown, keep suggestions on the document, skip binary files, and propagate deletes and renames', async (t) => {
  const { a, b, db, cmd, sync, file, enable } = await team(t);
  await enable();
  const messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
  const name = 'brief.md',
    af = file(a, name),
    bf = file(b, name);
  writeFileSync(af, 'one\ntwo\nthree\n');
  await sync(a);
  await sync(b);
  assert.equal(readFileSync(bf, 'utf8'), 'one\ntwo\nthree\n');
  writeFileSync(af, 'A\ntwo\nthree\n');
  writeFileSync(bf, 'one\ntwo\nB\n');
  await sync(a);
  await sync(b);
  await sync(a);
  assert.equal(readFileSync(af, 'utf8'), 'A\ntwo\nB\n');
  writeFileSync(af, 'ours\n');
  writeFileSync(bf, 'theirs\n');
  writeFileSync(file(a, 'img.pdf'), Buffer.from([1, 2, 255]));
  await sync(a);
  const conflict = await sync(b);
  const pendingId = conflict.match(/became suggestion (p_[a-f0-9]{32})/)[1];
  const ownerNote = await b.cli('waiting');
  assert.ok(ownerNote.includes(pendingId));
  assert.match(ownerNote, /brief.md.*now shows the accepted version/);
  assert.deepEqual(readdirSync(file(b, '')), [name]);
  assert.equal(readFileSync(bf, 'utf8'), 'ours\n');
  const listing = await cmd(b, 'suggestions', name);
  assert.match(listing, /pending "brief.md"/);
  assert.match(listing, /theirs/);
  assert.doesNotMatch(await cmd(a, 'list'), /img.pdf/);
  renameSync(af, file(a, 'renamed.md'));
  await sync(a);
  await sync(b);
  assert.equal(existsSync(bf), false);
  assert.equal(readFileSync(file(b, 'renamed.md'), 'utf8'), 'ours\n');
  writeFileSync(file(b, 'renamed.md'), 'keep this local edit');
  rmSync(file(a, 'renamed.md'));
  await sync(a);
  await sync(b);
  await sync(a);
  assert.equal(readFileSync(file(a, 'renamed.md'), 'utf8'), 'keep this local edit');
  await cmd(a, 'restore', name, '1');
  await sync(b);
  assert.equal(readFileSync(bf, 'utf8'), 'one\ntwo\nthree\n');
  assert.match(await cmd(a, 'history', name), /v1 "brief.md"/);
  assert.match(await cmd(a, 'status'), /Pending uploads: 0/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, messages);
});

test('a stale whole-file save keeps peer additions and tells both owners where to review it', async (t) => {
  const { a, b, cmd, sync, file, enable } = await team(t);
  await enable();
  const name = 'timeline.md';
  const original = 'My obsolete line\nTimeline\nEnd\n';
  writeFileSync(file(a, name), original);
  await sync(a);
  await sync(b);
  // Two revisions arrive together. The newest one doesn't introduce the line in danger.
  const updated = original.replace('End', 'Anna was here\nEnd');
  writeFileSync(file(b, name), updated);
  await sync(b);
  await cmd(b, 'edit', name, '--base', '2', '--old', 'End', '--new', 'Done');
  await sync(a);
  const accepted = updated.replace('End', 'Done');
  assert.equal(readFileSync(file(a, name), 'utf8'), accepted);
  writeFileSync(file(a, name), original + 'Ben was here\n');
  const result = await sync(a);
  assert.match(result, /1 line @anna added/);
  assert.match(result, /1 line @anna changed/);
  const id = result.match(/suggestion (p_[0-9a-f]{32})/)[1];
  assert.equal(readFileSync(file(a, name), 'utf8'), accepted);
  const waiting = await a.cli('waiting');
  assert.ok(waiting.includes(id));
  assert.match(waiting, /timeline.md.*now shows the accepted version/);
  assert.match(await cmd(a, 'status'), new RegExp('Your pending suggestions:\n"timeline.md" ' + id));
  assert.doesNotMatch(await cmd(b, 'status'), /Your pending suggestions/);
  await sync(b);
  assert.match(await b.cli('waiting'), new RegExp('proposed removing your lines.*timeline.md.*' + id));
  await sync(b);
  assert.doesNotMatch(await b.cli('waiting'), /proposed removing/);
  const reviewed = await cmd(b, 'suggestions', name);
  assert.ok(reviewed.includes('proposed\n' + original + 'Ben was here'));
  // Removing one's own line while keeping the peer's addition is an ordinary save.
  writeFileSync(file(a, name), accepted.replace('My obsolete line\n', ''));
  assert.doesNotMatch(await sync(a), /suggestion/);
  await sync(b);
  assert.equal(readFileSync(file(b, name), 'utf8'), 'Timeline\nAnna was here\nDone\n');
  await cmd(a, 'resolve', id, 'withdraw');
  assert.doesNotMatch(await cmd(a, 'status'), /Your pending suggestions/);
});

test('read-only drafts survive pulls and write grants until explicitly uploaded', async (t) => {
  const { a, b, cmd, sync, file, enable } = await team(t);
  await enable();
  writeFileSync(file(a, 'shared.md'), 'one\ntwo\n');
  await sync(a);
  await sync(b);
  await cmd(a, 'grant', 'anna', 'read');
  writeFileSync(file(b, 'shared.md'), 'mine\ntwo\n');
  writeFileSync(file(b, 'local.md'), 'only here');
  writeFileSync(file(a, 'shared.md'), 'one\ntheirs\n');
  await sync(a);
  writeFileSync(file(a, 'other.md'), 'arrived');
  await sync(a);
  await assert.rejects(sync(b), (err) => {
    assert.notEqual(err.code, 0);
    assert.doesNotMatch(err.stdout, /Synced/);
    assert.match(err.stderr, /Not uploaded.*read access.*2 local edits/);
    assert.ok(err.stderr.includes('shared.md') && err.stderr.includes('local.md'));
    return true;
  });
  assert.equal(readFileSync(file(b, 'other.md'), 'utf8'), 'arrived');
  assert.equal(readFileSync(file(b, 'shared.md'), 'utf8'), 'mine\ntwo\n');
  // The next edit happens between the last read-only scan and the grant.
  writeFileSync(file(b, 'another.md'), 'also held');
  await cmd(a, 'grant', 'anna', 'write');
  await assert.rejects(sync(b), /3 local edits.*--upload-drafts/);
  await assert.rejects(sync(b), /3 local edits.*--upload-drafts/);
  await sync(a);
  assert.equal(existsSync(file(a, 'local.md')), false);
  assert.equal(readFileSync(file(a, 'shared.md'), 'utf8'), 'one\ntheirs\n');
  await cmd(b, 'sync', '--upload-drafts');
  await sync(a);
  assert.equal(readFileSync(file(a, 'shared.md'), 'utf8'), 'mine\ntheirs\n');
  assert.equal(readFileSync(file(a, 'local.md'), 'utf8'), 'only here');
  assert.equal(readFileSync(file(a, 'another.md'), 'utf8'), 'also held');
  // Even an offline member who missed the entire read-only interval must consent.
  await cmd(a, 'grant', 'anna', 'read');
  writeFileSync(file(b, 'offline.md'), 'while offline');
  await cmd(a, 'grant', 'anna', 'write');
  await assert.rejects(sync(b), /1 local edit.*offline.md.*--upload-drafts/);
  assert.doesNotMatch(await cmd(a, 'list'), /offline.md/);
});

test('CLI history shows who saved each change and revert preserves newer edits or leaves a suggestion', async (t) => {
  const { a, b, root, cmd, sync, file, enable } = await team(t);
  await enable();
  const name = 'timeline.md';
  const original = 'alpha\nbeta\ngamma\n';
  writeFileSync(file(a, name), original);
  await sync(a);
  const edit = async (bot, base, old, value) => {
    const out = await cmd(bot, 'edit', name, '--base', String(base), '--old', old, '--new=' + value);
    assert.equal(JSON.parse(out).outcome, 'accepted');
  };
  await edit(b, 1, 'beta\n', '');
  await edit(a, 2, 'gamma\n', 'gamma\ndelta\n');

  const id = (await cmd(a, 'list')).match(/(f_[a-f0-9]+) v3/)[1];
  const { versions } = (await a.api('GET', root + '/files/' + id + '/history')).json;
  assert.deepEqual((await cmd(b, 'history', name)).trim().split('\n'), [
    `${id} v3 "${name}"  @ben  ${new Date(versions[0].created_at).toISOString()} (current)  +1 −0 lines`,
    `${id} v2 "${name}"  @anna  ${new Date(versions[1].created_at).toISOString()}  +0 −1 lines`,
    `${id} v1 "${name}"  @ben  ${new Date(versions[2].created_at).toISOString()}  +3 −0 lines`,
  ]);
  await assert.rejects(cmd(a, 'revert', name, 'v1'), /Choose a saved version after v1/);
  assert.equal((await cmd(a, 'revert', name, 'v2')).trim(), 'Undid v2 in timeline.md as v4.');
  assert.match(await cmd(b, 'read', name), /v4[^]*alpha\nbeta\ngamma\ndelta\n/);
  assert.match(await cmd(a, 'revert', name, 'v2'), /nothing left to undo/);
  await edit(b, 4, 'beta\n', 'later\n');
  const clash = await cmd(a, 'revert', name, 'v4');
  const suggestion = clash.match(/That clashes with newer edits, so it's suggestion (p_[a-f0-9]{32})\./)[1];
  assert.match(await cmd(b, 'read', name), /v5[^]*alpha\nlater\ngamma\ndelta\n/);
  assert.match(await cmd(b, 'suggestions', name), new RegExp(`${suggestion} pending`));
  assert.deepEqual(JSON.parse(await cmd(b, 'resolve', suggestion, 'accept')), {
    outcome: 'accepted', proposal_id: suggestion, version: 6,
  });
  assert.match(await cmd(a, 'read', name), /v6[^]*alpha\ngamma\ndelta\n/);

  await sync(a);
  rmSync(file(a, name));
  await sync(a);
  assert.match(await cmd(b, 'history', name), /v7 "timeline.md"[^\n]+\(current\) \(deleted\)  \+0 −3 lines/);
});

test('CLI history keeps older saves visible and limits line counts to the latest 20', async (t) => {
  const { a, cmd, sync, file, enable } = await team(t);
  await enable();
  const name = 'count.txt';
  writeFileSync(file(a, name), 'count 1');
  await sync(a);
  for (let v = 2; v <= 22; v++) {
    const out = await cmd(a, 'edit', name, '--base', String(v - 1), '--old', `count ${v - 1}`, '--new', `count ${v}`);
    assert.equal(JSON.parse(out).version, v);
  }
  const history = await cmd(a, 'history', name);
  assert.equal(history.match(/\+1 −1 lines/g)?.length, 20);
  assert.match(history, /v3 "count.txt"[^\n]+\+1 −1 lines/);
  assert.match(history, /v2 "count.txt"  @ben  [\d:T.Z-]+\n[^\n]+v1 "count.txt"  @ben  [\d:T.Z-]+\n/);
  assert.match(history, /Line counts cover the latest 20 versions\./);
});

test('multipart ciphertext verifies order, length, digest and identity before publication; limits reserve concurrent uploads', async (t) => {
  const { env, db, dir, group, a, b, root, file, sync, enable } = await team(t);
  await enable();
  const name = 'large.txt',
    data = Buffer.alloc(20 * 1024 ** 2 + 1, 'a');
  writeFileSync(file(a, name), data);
  await sync(a);
  const row = db.prepare('SELECT * FROM folder_uploads WHERE committed=1').get();
  const key = (i) => join(dir, 'folders', group, row.id, String(i));
  const first = readFileSync(key(0)),
    second = readFileSync(key(1));
  const corrupted = Buffer.from(first);
  corrupted[0] ^= 1;
  for (const wrong of [second, first.subarray(1), corrupted]) {
    writeFileSync(key(0), wrong);
    await assert.rejects(sync(b));
    assert.equal(existsSync(file(b, name)), false);
  }
  writeFileSync(key(0), first);
  await sync(b);
  assert.ok(readFileSync(file(b, name)).equals(data));
  const id = 'f_' + 'a'.repeat(32),
    up = (size, chunks) => a.api('POST', root + '/uploads', { file_id: id, size, chunks });
  assert.equal((await up(200 * 1024 ** 2 + 1, 51)).status, 413);
  const tooLarge = file(a, 'over-limit.txt');
  writeFileSync(tooLarge, '');
  truncateSync(tooLarge, 200 * 1024 ** 2 + 1);
  await assert.rejects(sync(a), /200 MiB/);
  rmSync(tooLarge);
  const usage = (await a.api('GET', root)).json.quota.used;
  assert.equal(usage, data.length + 6 * 16);
  db.prepare('UPDATE folder_limits SET max_bytes=?').run(usage + 20);
  const upload = (await up(4, 1)).json;
  assert.ok(upload.upload_id);
  assert.equal((await up(0, 1)).status, 413);
  const u = upload.urls[0],
    blob = Buffer.alloc(20);
  assert.equal((await fetch(u, { method: 'PUT', body: blob })).status, 204);
  assert.equal((await fetch(u, { method: 'PUT', body: blob })).status, 412);
  env.advance(17 * 60000);
  env.relay.retention();
  assert.equal((await fetch(u, { method: 'PUT', body: blob })).status, 403);
  assert.equal(existsSync(join(dir, 'folders', group, upload.upload_id)), false);
});

test('folder access follows grants and signed device lists; retention and group end delete owned objects', async (t) => {
  const { env, db, dir, group, a, b, root, cmd, sync, file } = await team(t);
  assert.equal((await a.api('GET', root)).status, 404);
  await cmd(a, 'on');
  await cmd(a, 'grant', '@ben', 'write');
  await sync(a);
  assert.equal((await b.api('GET', root)).json.role, 'write');
  await cmd(a, 'revoke', '@anna');
  await assert.rejects(cmd(b, 'grant', '@anna', 'write'), /only group admins/);
  writeFileSync(file(a, 'draft.md'), 'first');
  await sync(a);
  await cmd(a, 'grant', '@anna', 'write');
  await sync(b);
  assert.equal(existsSync(file(b, 'draft.md')), false);
  const linked = cliHome();
  const [, id, code] = (await linked.cli('device', 'link', env.url, '--name', 'laptop')).match(
    /device approve (d_\w+) ([A-F0-9]{16})/,
  );
  const approved = await b.cli('device', 'approve', id, code, '--owner-ok');
  await linked.cli('device', 'link', '--confirm', approved.match(/--confirm ([A-F0-9]{16})/)[1]);
  db.prepare('UPDATE bots SET paused_at=1 WHERE id=?').run(b.botId);
  writeFileSync(file(a, 'draft.md'), 'second');
  await sync(a);
  assert.equal((await b.api('GET', root)).status, 403);
  db.prepare('UPDATE bots SET paused_at=NULL WHERE id=?').run(b.botId);
  await sync(linked);
  assert.equal(readFileSync(file(linked, 'draft.md'), 'utf8'), 'second');
  writeFileSync(file(linked, 'draft.md'), 'third');
  await sync(linked);
  await sync(a);
  assert.equal(readFileSync(file(a, 'draft.md'), 'utf8'), 'third');
  const row = db.prepare('SELECT * FROM team_folder_revisions WHERE version=3').get();
  assert.equal(row.author_device, id);
  const retry = { base: 2, request_id: row.request_id };
  const config = JSON.parse(readFileSync(join(linked.home, 'config.json'), 'utf8'));
  const r = await fetch(env.url + root + '/files/' + row.file_id, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + config.token },
    body: JSON.stringify(retry),
  });
  assert.equal(r.status, 409, 'same request ID cannot be retried with a different body');
  await cmd(a, 'revoke', '@anna');
  assert.equal((await b.api('GET', root + '/changes')).status, 403);
  await cmd(a, 'grant', '@anna', 'read');
  assert.deepEqual((await b.api('GET', root + '/changes')).json.changes, []);
  assert.equal((await b.api('POST', root + '/uploads', {})).status, 403);
  const other = (await a.cli('group', 'new', 'Another')).match(/number (\d+)/)[1];
  await a.cli('folder', 'on', other);
  await a.cli('folder', 'grant', other, '@ben', 'write');
  assert.equal((await a.api('GET', '/v1/team-folders/' + other + '/files/' + row.file_id + '/3')).status, 404);
  const objects = join(dir, 'folders', group);
  env.advance(10 * 86400_000);
  env.relay.retention();
  assert.equal(readdirSync(objects).length, 3);
  env.advance(21 * 86400_000);
  env.relay.retention();
  assert.deepEqual(readdirSync(objects), [row.upload_id]);
  assert.deepEqual(
    (await a.api('GET', root + '/files/' + row.file_id + '/history')).json.versions.map((r) => r.version),
    [3],
  );
  rmSync(file(a, 'draft.md'));
  await sync(a);
  env.advance(31 * 86400_000);
  env.relay.retention();
  assert.deepEqual(readdirSync(objects), []);
  assert.equal((await a.api('GET', root + '/files/' + row.file_id + '/4')).json.deleted, true);
  writeFileSync(file(a, 'one-more.md'), 'still here');
  await sync(a);
  assert.equal(readdirSync(objects).length, 1);
  await a.cli('group', 'end', group);
  assert.deepEqual(readdirSync(objects), []);
  assert.equal(db.prepare('SELECT count(*) n FROM team_folder_revisions').get().n, 0);
});

test('watch syncs both homes without launching the configured agent', async (t) => {
  const { a, b, dir, enable, file } = await team(t);
  await enable();
  const marker = join(dir, 'wake'),
    script = join(dir, 'agent');
  writeFileSync(script, '#!/bin/sh\ntouch "' + marker + '"\n', { mode: 0o700 });
  for (const bot of [a, b]) {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../cli/b2b.mjs', import.meta.url)), 'watch', '--command', script, '--force'],
      {
        env: { ...process.env, B2B_HOME: bot.home, HOME: bot.home },
        stdio: 'ignore',
      },
    );
    t.after(() => child.kill());
  }
  writeFileSync(file(a, 'live.md'), 'A');
  await waitFor(() => existsSync(file(b, 'live.md')), 30000);
  writeFileSync(file(b, 'live.md'), 'B');
  await waitFor(() => readFileSync(file(a, 'live.md'), 'utf8') === 'B', 30000);
  assert.equal(existsSync(marker), false);
});
test('hosted: shared folders are an alpha for Infinite accounts, marked as alpha', async (t) => {
  const env = await setup(t, { hosted: true, autoTick: false });
  const db = env.relay.db;
  const ben = await owner(env, t, 'ben@example.com', 'ben');
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  await connect(ben, anna, 'Ben');
  const group = Number((await ben.cli('group', 'new', 'Research', 'anna')).match(/number (\d+)/)[1]);
  env.relay.groups.join(db.prepare('SELECT * FROM bots WHERE id=?').get(anna.botId), group, { byOwner: true });
  const root = '/v1/team-folders/' + group;
  const args = (action, ...rest) => ['folder', action, String(group), ...rest];
  const infinite = (email, off = false) =>
    fetch(env.url + '/admin/infinite', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + ADMIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email, ...(off && { off: true }) }),
    });

  // Not on Infinite: the folder isn't there for you, and the plan page doesn't offer it.
  await assert.rejects(ben.cli(...args('on')), /in alpha, for Infinite accounts only/);
  assert.match((await ben.api('GET', root)).json.error, /in alpha, for Infinite accounts only/);
  assert.doesNotMatch((await ben.b('/app/billing')).text, /Shared folders/);

  // On Infinite: the plan page shows it with an Alpha badge, and the group admin turns it on.
  assert.equal((await infinite('ben@example.com')).status, 200);
  assert.match((await ben.b('/app/billing')).text, /badge--info">Alpha<\/span> Shared folders are yours to try/);
  await assert.rejects(anna.cli(...args('on')), /in alpha, for Infinite accounts only/);
  assert.match(await ben.cli(...args('on')), /The shared folder \(alpha\) is on for group/);
  assert.match(await ben.cli(...args('grant', '@ben', 'write')), /read and write the shared folder \(alpha\)/);
  await assert.rejects(ben.cli(...args('grant', '@anna', 'read')), /@anna isn't on an Infinite account/);
  assert.equal((await infinite('anna@example.com')).status, 200);
  assert.equal((await anna.api('GET', root)).json.role, 'write');
  await assert.rejects(anna.cli(...args('off')), /only group admins can turn the shared folder on or off/);
  await ben.cli(...args('grant', '@anna', 'read'));
  assert.match(await anna.cli(...args('list')), /^Shared folder \(alpha\)\. Access: @ben \(write\), @anna \(read\)/);

  // Losing Infinite closes the folder to that bot but never blocks the others; it reads again once it's back.
  assert.equal((await infinite('anna@example.com', true)).status, 200);
  assert.equal((await anna.api('GET', root)).status, 403);
  await ben.cli(...args('sync'));
  const path = join(ben.home, 'shared', 'Research', 'brief.md');
  writeFileSync(path, 'written while anna was off the alpha');
  await ben.cli(...args('sync'));
  assert.equal((await infinite('anna@example.com')).status, 200);
  await anna.cli(...args('sync'));
  const out = join(anna.home, 'shared', 'Research', 'brief.md');
  assert.equal(readFileSync(out, 'utf8'), 'written while anna was off the alpha');

  assert.match(await ben.cli(...args('off')), /The shared folder is off for group/);
  assert.equal((await ben.api('GET', root)).status, 404);
});

test('S3 commit checks every chunk and binds immutable PUTs; object cleanup is separate from attachments', async (t) => {
  const st = await store(t);
  const { env, group, a, b, root, sync, file, enable, db } = await team(t, { files: { s3: st.s3 } });
  await enable();
  writeFileSync(file(a, 'empty.md'), '');
  await sync(a);
  await sync(b);
  assert.equal(readFileSync(file(b, 'empty.md')).length, 0);
  const { file_id, request_id, seq } = db.prepare('SELECT * FROM team_folder_revisions').get();
  const get = async () => (await a.api('GET', root + '/files/' + file_id + '/1')).json;
  const old = await get(),
    folder = (await a.api('GET', root)).json;
  const bOld = (await b.api('GET', root + '/files/' + file_id + '/1')).json;
  const upload = (await a.api('POST', root + '/uploads', { file_id, size: 0, chunks: 1 })).json;
  const body = {
    base: 1,
    request_id: 'req_' + 'e'.repeat(32),
    upload_id: upload.upload_id,
    roster: folder.roster,
    envelopes: { 'anna:primary': bOld.envelope, 'ben:primary': old.envelope },
  };
  const commit = (patch) => a.api('POST', root + '/files/' + file_id, { ...body, ...patch });
  assert.equal((await commit({})).status, 409, 'missing object');
  const url = upload.urls[0],
    bytes = Buffer.alloc(16);
  assert.equal((await fetch(url, { method: 'PUT', body: bytes })).status, 403, 'must send signed create-only header');
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'if-none-match': '*' }, body: bytes })).status, 200);
  assert.equal((await fetch(url, { method: 'PUT', headers: { 'if-none-match': '*' }, body: bytes })).status, 412);
  const key = new URL(url).pathname;
  st.bucket.set(key, bytes.subarray(1));
  assert.equal((await commit({})).status, 409, 'wrong object length');
  st.bucket.set(key, bytes);
  assert.equal((await commit({ envelopes: {} })).status, 409);
  assert.equal((await commit({ roster: 'stale' })).status, 409);
  const stale = await commit({ base: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.current, 1);
  assert.equal((await commit({ base: 0, request_id })).status, 409);
  assert.equal((await commit({})).status, 200);
  assert.deepEqual((await commit({})).json, { file_id, version: 2, seq: 2 });
  // The existing attachment sweep addresses only files/<id>.
  env.advance(8 * 86400_000);
  env.relay.retention();
  assert.equal(st.bucket.size, 2);
  await a.cli('group', 'end', group);
  await waitFor(() => st.bucket.size === 0);
});

test('a remote path cannot write through a symlink; ignored files and symlinks stay local', async (t) => {
  const { a, b, dir, enable, file, cmd, sync } = await team(t);
  await enable();
  const outside = join(dir, 'private.md');
  writeFileSync(outside, 'private');
  symlinkSync(outside, file(b, 'notes.md'));
  writeFileSync(file(a, 'notes.md'), 'team notes');
  writeFileSync(file(a, '~$notes.md'), 'office lock');
  writeFileSync(file(a, 'incoming.crdownload'), 'partial');
  await sync(a);
  assert.doesNotMatch(await cmd(a, 'list'), /office lock|~\$notes|crdownload/);
  await assert.rejects(sync(b), /symbolic link/);
  assert.equal(readFileSync(outside, 'utf8'), 'private');
  rmSync(file(b, 'notes.md'));
  await sync(b);
  assert.equal(readFileSync(file(b, 'notes.md'), 'utf8'), 'team notes');
});

// Independent protocol writer: seal the manifest itself, and use WebCrypto's AES-GCM
// ciphertext||tag representation so the real CLI must agree with browser byte ordering.
test('format 2 independently verifies the plaintext hash and rejects ciphertext swapped across files', async (t) => {
  const { a, b, dir, root, group, enable, file, sync } = await team(t);
  await enable();
  const cfg = JSON.parse(readFileSync(join(a.home, 'config.json'), 'utf8')),
    folder = (await a.api('GET', root)).json;
  const data = Buffer.from('browser protocol vector'),
    key = randomBytes(32);
  const signing = createPrivateKey({ key: { ...cfg.keys.sign, kty: 'OKP', crv: 'Ed25519' }, format: 'jwk' });
  const secret = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
  async function publish(id, version, digest) {
    const upload = (await a.api('POST', root + '/uploads', { file_id: id, size: data.length, chunks: 1 })).json;
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(12),
        additionalData: Buffer.from(`b2b-folder/2|${group}|${id}|${version}|0|1`),
        tagLength: 128,
      },
      secret,
      data,
    );
    assert.equal((await fetch(upload.urls[0], { method: 'PUT', body: encrypted })).status, 204);
    const manifest = {
      v: 2,
      path: id + '.txt',
      size: data.length,
      sha256: digest,
      mime: 'text/plain',
      mtime: Date.now(),
      key: key.toString('base64url'),
      chunk_size: 4 * 1024 ** 2,
      chunks: 1,
      base: version - 1,
    };
    const envelopes = {};
    for (const d of folder.recipients) {
      const ephemeral = generateKeyPairSync('x25519'),
        x = ephemeral.publicKey.export({ format: 'jwk' }).x;
      const to = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: d.box }, format: 'jwk' });
      const salt = Buffer.concat([Buffer.from(x, 'base64url'), Buffer.from(d.box, 'base64url')]);
      const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: to });
      const nonce = randomBytes(12),
        aad = Buffer.from(`b2b1|${cfg.keys.sign.x}|${d.box}|team-folder/2/${group}/${id}/${version}|`);
      const c = createCipheriv('chacha20-poly1305', hkdfSync('sha256', shared, salt, 'b2b1 message', 32), nonce, {
        authTagLength: 16,
      });
      c.setAAD(aad);
      const ct = Buffer.concat([c.update(JSON.stringify(manifest)), c.final(), c.getAuthTag()]);
      const signature = sign(null, Buffer.concat([aad, Buffer.from(x, 'base64url'), nonce, ct]), signing);
      envelopes[d.handle + ':' + d.device] = [
        'b2b1',
        x,
        nonce.toString('base64url'),
        ct.toString('base64url'),
        signature.toString('base64url'),
      ].join('.');
    }
    const commit = await a.api('POST', root + '/files/' + id, {
      base: version - 1,
      upload_id: upload.upload_id,
      request_id: 'req_' + randomBytes(16).toString('hex'),
      roster: folder.roster,
      envelopes,
    });
    assert.equal(commit.status, 200);
    return join(dir, 'folders', group, upload.upload_id, '0');
  }
  const id = 'f_' + '1'.repeat(32),
    other = 'f_' + '2'.repeat(32),
    digest = createHash('sha256').update(data).digest('hex');
  await publish(id, 1, '0'.repeat(64));
  await assert.rejects(sync(b), /checksum/);
  assert.equal(existsSync(file(b, id + '.txt')), false);
  const original = await publish(id, 2, digest);
  await sync(b);
  assert.deepEqual(readFileSync(file(b, id + '.txt')), data);
  const swapped = await publish(other, 1, digest);
  // Both encrypted chunks have the same length, nonce, plaintext and key. Only AAD differs.
  writeFileSync(swapped, readFileSync(original));
  await assert.rejects(sync(b));
  assert.equal(existsSync(file(b, other + '.txt')), false);
});

test('precise edits rebase by unique anchor; concurrent sections, inserted headers and a dependent batch keep one ID', async (t) => {
  const { a, b, db, dir, cmd, sync, file, enable } = await team(t);
  await enable();
  const name = 'report.md',
    original = 'Budget: 40\nMarket: initial\nRisks: initial\nConclusion: undecided\n';
  writeFileSync(file(a, name), original);
  await sync(a);
  await Promise.all([cmd(a, 'read', name), cmd(b, 'read', name)]);
  const edit = (bot, ...args) => cmd(bot, 'edit', name, ...args).then(JSON.parse);
  const results = await Promise.all([
    edit(a, '--old', 'Market: initial', '--new', 'Market: growing'),
    edit(b, '--old', 'Risks: initial', '--new', 'Risks: supply'),
  ]);
  assert.deepEqual(
    results.map((r) => r.outcome),
    ['accepted', 'accepted'],
  );
  const both = await cmd(a, 'read', name);
  assert.match(both, /Market: growing\nRisks: supply/);
  const batch = join(dir, 'edits.json');
  writeFileSync(
    batch,
    JSON.stringify([
      { old: 'Budget: 40', new: 'Research report\nBudget: 80' },
      { old: 'Conclusion: undecided', new: 'Conclusion: fund the work' },
    ]),
  );
  assert.equal((await edit(a, '--base', '3', '--edits', batch)).version, 4);
  assert.equal((await edit(b, '--base', '3', '--old', 'Risks: supply', '--new', 'Risks: pricing')).version, 5);
  const view = await cmd(b, 'read', name);
  assert.match(view, /Research report\nBudget: 80\nMarket: growing\nRisks: pricing\nConclusion: fund the work/);
  const again = await edit(a, '--base', '4', '--old', 'Risks: supply', '--new', 'Risks: pricing');
  assert.equal(again.outcome, 'already_satisfied');
  await assert.rejects(edit(a, '--base', '5', '--old', ': ', '--new', '.'), /exactly once/);
  writeFileSync(
    batch,
    JSON.stringify([
      { old: 'Budget: 80', new: 'Budget: 90' },
      { old: 'absent', new: 'anything' },
    ]),
  );
  await assert.rejects(edit(a, '--base', '5', '--edits', batch), /exactly once/);
  const counts = db.prepare('SELECT count(*) n,count(DISTINCT file_id) ids FROM team_folder_revisions').get();
  assert.equal(counts.n, 5);
  assert.equal(counts.ids, 1);
  const out = join(dir, 'export.md');
  await cmd(b, 'export', name, out, '--base', '1');
  assert.equal(readFileSync(out, 'utf8'), original);
});

test('declared dependencies stop stale edits; proposals survive expiry, and resolve atomically against the latest text', async (t) => {
  const { a, b, db, env, dir, root, cmd, file, sync, enable } = await team(t);
  await enable();
  const name = 'plan.md';
  writeFileSync(file(a, name), 'Budget: 40\nDecision: wait\nNotes: initial\n');
  await sync(a);
  const edit = (bot, ...args) => cmd(bot, 'edit', name, ...args).then(JSON.parse);
  await Promise.all([cmd(a, 'read', name), cmd(b, 'read', name)]);
  await edit(a, '--old', 'Budget: 40', '--new', 'Budget: 10');
  const p = await edit(b, '--depends', 'Budget: 40', '--old', 'Decision: wait', '--new', 'Decision: hire');
  assert.equal(p.outcome, 'needs_resolution');
  assert.match(p.proposal_id, /^p_[0-9a-f]{32}$/);
  const id = p.proposal_id;
  assert.match(await cmd(a, 'read', name), /1 pending suggestions[^]*Budget: 10\nDecision: wait/);
  const feed = await a.api('GET', root + '/changes?since=0');
  assert.equal(feed.json.suggestion_events[0].proposal_id, id);
  assert.deepEqual((await a.api('GET', root + '/changes?since=0')).json, feed.json);
  const inspect = await cmd(a, 'suggestions', name);
  assert.match(inspect, /dependency_changed/);
  assert.match(inspect, /original\nBudget: 40/);
  assert.match(inspect, /proposed\nBudget: 40\nDecision: hire/);
  const stored = JSON.stringify((await a.api('GET', root + '/suggestions/' + id)).json);
  assert.doesNotMatch(stored, /plan\.md|Budget|Decision|dependency_changed/);
  const snapshotSeq = feed.json.seq;
  env.advance(40 * 86400_000);
  env.relay.retention();
  assert.match(await cmd(b, 'suggestions', name), /Decision: hire/);
  // A different author cannot withdraw. A read grant cannot change a pending proposal.
  assert.equal(JSON.parse(await cmd(a, 'resolve', id, 'withdraw')).outcome, 'access_denied');
  await cmd(a, 'grant', 'anna', 'read');
  assert.equal(JSON.parse(await cmd(b, 'resolve', id, 'accept')).outcome, 'access_denied');
  assert.equal(
    (await edit(b, '--base', '2', '--old', 'Decision: wait', '--new', 'Decision: hire')).outcome,
    'access_denied',
  );
  await cmd(a, 'grant', 'anna', 'write');
  await edit(a, '--base', '2', '--old', 'Notes: initial', '--new', 'Notes: independently updated');
  const accepted = JSON.parse(await cmd(b, 'resolve', id, 'accept'));
  assert.equal(accepted.version, 4);
  assert.match(await cmd(a, 'read', name), /Budget: 10\nDecision: hire\nNotes: independently updated/);
  const later = (await a.api('GET', root + '/changes?since=' + snapshotSeq)).json;
  assert.equal(later.changes.at(-1).version, 4);
  assert.equal(later.suggestion_events.at(-1).state, 'accepted');
  assert.equal((await a.api('GET', root + '/suggestions/' + id)).json.resolved_version, 4);
  const other = (await a.cli('group', 'new', 'Other')).match(/number (\d+)/)[1];
  await a.cli('folder', 'on', other);
  await a.cli('folder', 'grant', other, 'ben', 'write');
  assert.equal((await a.api('GET', '/v1/team-folders/' + other + '/suggestions/' + id)).status, 404);
  env.advance(31 * 86400_000);
  env.relay.retention();
  assert.equal((await a.api('GET', root + '/suggestions/' + id)).status, 404);
  const replacement = join(dir, 'rewrite.txt');
  writeFileSync(replacement, 'obsolete entire body');
  await edit(a, '--base', '4', '--old', 'Decision: hire', '--new', 'Decision: reconsider');
  const stale = await edit(b, '--replace', replacement, '--base', '4');
  assert.equal(stale.outcome, 'needs_resolution');
  assert.match(await cmd(b, 'read', name), /Decision: reconsider/);
  assert.equal(JSON.parse(await cmd(b, 'resolve', stale.proposal_id, 'withdraw')).state, 'withdrawn');
  const otherChange = await edit(b, '--base', '4', '--old', 'Decision: hire', '--new', 'Decision: postpone');
  assert.equal(JSON.parse(await cmd(a, 'resolve', otherChange.proposal_id, 'reject')).state, 'rejected');
  const pending = await edit(b, '--base', '4', '--old', 'Decision: hire', '--new', 'Decision: pause');
  env.advance(91 * 86400_000);
  env.relay.retention();
  assert.equal((await a.api('GET', root + '/suggestions/' + pending.proposal_id)).status, 404);
  assert.equal(db.prepare('SELECT count(*) n FROM folder_suggestion_parts').get().n, 0);
});

test('same-position insertions append in commit order, large text reconciles, non-text never uploads', async (t) => {
  const { a, b, cmd, sync, file, enable } = await team(t);
  await enable();
  for (const [name, start, left, right] of [
    ['list.md', '- first\n', '- second\n', '- third\n'],
    ['rows.csv', 'name,value\n', 'Ada,1\n', 'Ben,2\n'],
  ]) {
    writeFileSync(file(a, name), start);
    await sync(a);
    await sync(b);
    writeFileSync(file(a, name), start + left);
    writeFileSync(file(b, name), start + right);
    await sync(a);
    await sync(b);
    await sync(a);
    assert.equal(readFileSync(file(a, name), 'utf8'), start + left + right);
  }
  const list = 'precise.md';
  writeFileSync(file(a, list), '- first\n');
  await sync(a);
  for (const [bot, line] of [
    [a, 'second'],
    [b, 'third'],
  ]) {
    const result = JSON.parse(
      await cmd(bot, 'edit', list, '--base', '1', '--old', '- first\n', '--new', '- first\n- ' + line + '\n'),
    );
    assert.equal(result.outcome, 'accepted');
  }
  assert.match(await cmd(a, 'read', list), /- first\n- second\n- third\n/);
  const name = 'large.md',
    padding = 'a'.repeat(10 * 1024 ** 2);
  writeFileSync(file(a, name), 'Market: X\n' + padding + '\nRisk: X');
  await sync(a);
  await sync(b);
  writeFileSync(file(a, name), 'Market: A\n' + padding + '\nRisk: X');
  writeFileSync(file(b, name), 'Market: X\n' + padding + '\nRisk: B');
  await sync(a);
  await sync(b);
  assert.equal(readFileSync(file(b, name), 'utf8'), 'Market: A\n' + padding + '\nRisk: B');
  assert.equal(
    JSON.parse(await cmd(b, 'edit', name, '--old', 'Risk: B', '--new', 'Risk: accepted')).outcome,
    'accepted',
  );
  for (const n of ['image.png', 'table.xlsx', 'note.pdf', 'letter.docx']) writeFileSync(file(a, n), 'looks like text');
  writeFileSync(file(a, 'invalid.txt'), Buffer.from([255]));
  const note = await sync(a);
  assert.equal(note.match(/Skipped non-text/g)?.length, 1);
  assert.match(await a.cli('waiting'), /Skipped non-text files.*image.png/);
  assert.doesNotMatch(await sync(a), /Skipped non-text/);
  assert.doesNotMatch(await a.cli('waiting'), /Skipped non-text/);
  assert.doesNotMatch(await cmd(a, 'list'), /image.png|table.xlsx|note.pdf|letter.docx|invalid.txt/);
});

test('large concurrent saves become a suggestion; removing the document removes pending suggestions', async (t) => {
  const { a, b, db, root, cmd, sync, file, enable } = await team(t);
  await enable();
  const name = 'big.txt',
    pad = 'x'.repeat(13 * 1024 ** 2);
  writeFileSync(file(a, name), 'base' + pad);
  await sync(a);
  await sync(b);
  writeFileSync(file(a, name), 'left' + pad);
  writeFileSync(file(b, name), 'right' + pad);
  await sync(a);
  const result = await sync(b);
  const id = result.match(/suggestion (p_[a-f0-9]+)/)[1];
  assert.deepEqual(readdirSync(file(b, '')), [name]);
  assert.equal(readFileSync(file(b, name), 'utf8'), 'left' + pad);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM folder_suggestion_parts').get().n, 4);
  rmSync(file(a, name));
  await sync(a);
  assert.equal((await a.api('GET', root + '/suggestions/' + id)).status, 404);
});

// The real CLI still encrypts, signs, uploads, and verifies. This local HTTP
// intermediary schedules competing writes at the commit boundary or drops an
// already-committed response. No production fault-injection switches.
async function interceptFolderCommit(t, env, bot, hook) {
  const path = join(bot.home, 'config.json'),
    cfg = JSON.parse(readFileSync(path));
  const proxy = await listen(async (req, res) => {
    try {
      const data = [];
      for await (const b of req) data.push(b);
      const bytes = Buffer.concat(data);
      const commit = req.method === 'POST' && /\/team-folders\/\d+\/files\/f_[0-9a-f]+$/.test(req.url);
      const drop = commit && (await hook(JSON.parse(bytes), req.url));
      const r = await fetch(env.url + req.url, {
        method: req.method,
        headers: { authorization: req.headers.authorization, 'content-type': 'application/json' },
        ...(req.method === 'POST' && { body: bytes }),
      });
      const result = await r.text();
      if (drop) return res.destroy();
      res.writeHead(r.status, { 'content-type': 'application/json' }).end(result);
    } catch (e) {
      res.writeHead(500).end(JSON.stringify({ error: e.message }));
    }
  });
  t.after(() => proxy.s.close());
  writeFileSync(path, JSON.stringify({ ...cfg, relay: proxy.url }));
}

test('revert rebases when a newer save lands during the commit', async (t) => {
  const { a, b, env, cmd, sync, file, enable } = await team(t);
  await enable();
  const name = 'race.md';
  writeFileSync(file(a, name), 'undo: original\nkeep: original\n');
  await sync(a);
  await cmd(a, 'edit', name, '--base', '1', '--old', 'undo: original', '--new', 'undo: changed');

  const attemptedBases = [];
  await interceptFolderCommit(t, env, a, async (body) => {
    attemptedBases.push(body.base);
    if (attemptedBases.length === 1)
      await cmd(b, 'edit', name, '--base', '2', '--old', 'keep: original', '--new', 'keep: changed');
  });
  assert.match(await cmd(a, 'revert', name, 'v2'), /Undid v2 in race.md as v4\./);
  assert.deepEqual(attemptedBases, [2, 3]);
  assert.match(await cmd(b, 'read', name), /v4[^]*undo: original\nkeep: changed\n/);
});

test('a lost response retries the exact attempt once; repeated stale saves stop after three attempts and retain the edit', async (t) => {
  const { a, b, env, db, cmd, sync, file, enable } = await team(t);
  await enable();
  const name = 'race.md';
  writeFileSync(file(a, name), 'ours: 0\ncount: 0\n');
  await sync(a);
  let race = false,
    competing = 0;
  const attempts = [];
  await interceptFolderCommit(t, env, a, async (body) => {
    attempts.push(body);
    if (!race) return attempts.length === 1;
    const base = db.prepare('SELECT MAX(version) v FROM team_folder_revisions').get().v;
    await cmd(
      b,
      'edit',
      name,
      '--base',
      String(base),
      '--old',
      'count: ' + competing,
      '--new',
      'count: ' + ++competing,
    );
  });
  assert.equal(JSON.parse(await cmd(a, 'edit', name, '--old', 'ours: 0', '--new', 'ours: 1')).outcome, 'accepted');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM team_folder_revisions').get().n, 2);
  race = true;
  attempts.length = 0;
  const exhausted = JSON.parse(await cmd(a, 'edit', name, '--base', '2', '--old', 'ours: 1', '--new', 'ours: 2'));
  assert.equal(exhausted.outcome, 'retry_exhausted');
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map((a) => a.request_id)).size, 3);
  assert.equal(new Set(attempts.map((a) => a.logical_edit_id)).size, 1);
  assert.match(await cmd(b, 'suggestions', name), /retry_limit[^]*ours: 2/);
  assert.match(await cmd(b, 'read', name), /ours: 1\ncount: 3/);
});

test('revocation between upload and commit cancels publication; an issued ciphertext URL expires', async (t) => {
  const { a, b, env, db, root, cmd, sync, file, enable } = await team(t);
  await enable();
  const name = 'access.md';
  writeFileSync(file(a, name), 'approved');
  await sync(a);
  const id = db.prepare('SELECT file_id FROM team_folder_revisions').get().file_id;
  const url = (await b.api('GET', root + '/files/' + id + '/1')).json.urls[0];
  await interceptFolderCommit(t, env, b, async () => {
    await cmd(a, 'revoke', 'anna');
  });
  const denied = JSON.parse(await cmd(b, 'edit', name, '--old', 'approved', '--new', 'unpublished'));
  assert.equal(denied.outcome, 'access_denied');
  assert.match(await cmd(a, 'read', name), /approved/);
  assert.equal((await b.api('GET', root + '/files/' + id + '/1')).status, 403);
  assert.equal((await fetch(url)).status, 200);
  env.advance(16 * 60_000);
  assert.equal((await fetch(url)).status, 403);
});

test('proposal acceptance preserves unrelated text and rejects another change to the reviewed target', async (t) => {
  const { a, b, root, cmd, sync, file, enable } = await team(t);
  await enable();
  const name = 'date.md';
  writeFileSync(file(a, name), 'Date: 1 December\nOwner: Ann\n');
  await sync(a);
  const edit = (bot, base, old, value) =>
    cmd(bot, 'edit', name, '--base', String(base), '--old', old, '--new', value).then(JSON.parse);
  await edit(a, 1, '1 December', '5 December');
  const p = await edit(b, 1, '1 December', '8 December');
  await edit(a, 2, 'Owner: Ann', 'Owner: Ben');
  assert.equal(JSON.parse(await cmd(b, 'resolve', p.proposal_id, 'accept')).outcome, 'accepted');
  assert.match(await cmd(b, 'read', name), /Date: 8 December\nOwner: Ben/);
  await edit(a, 4, '8 December', '10 December');
  const q = await edit(b, 4, '8 December', '15 December');
  await edit(a, 5, '10 December', '20 December');
  await assert.rejects(cmd(b, 'resolve', q.proposal_id, 'accept'), /still pending/);
  assert.equal((await a.api('GET', root + '/suggestions/' + q.proposal_id)).json.state, 'pending');
});

test('pairing adds the current head and pending suggestions to a new device', async (t) => {
  const { env, db, root, group, a, b, cmd, file, sync, enable } = await team(t);
  await enable();
  const name = 'research.md';
  writeFileSync(file(b, name), 'Decision: undecided\n');
  await sync(b);
  const edit = (value, base) =>
    cmd(b, 'edit', name, '--base', String(base), '--old', 'undecided', '--new', value).then(JSON.parse);
  await edit('accepted', 1);
  const pending = (await edit('proposed', 1)).proposal_id;
  const rejected = (await edit('dismissed', 1)).proposal_id;
  await cmd(b, 'resolve', rejected, 'reject');
  const linked = cliHome();
  const [, device, code] = (await linked.cli('device', 'link', env.url, '--name', 'web-safari')).match(
    /device approve (d_\w+) ([A-F0-9]{16})/,
  );
  const approved = await a.cli('device', 'approve', device, code, '--owner-ok');
  await linked.cli('device', 'link', '--confirm', approved.match(/--confirm ([A-F0-9]{16})/)[1]);
  const cfg = JSON.parse(readFileSync(join(linked.home, 'config.json')));
  const get = async (suffix) =>
    (await fetch(env.url + root + suffix, { headers: { authorization: 'Bearer ' + cfg.token } })).json();
  await sync(linked);
  assert.equal(existsSync(file(linked, name)), false);
  const cursor = (await get('/changes')).seq;
  const todo = (await a.api('GET', root + '/backfill')).json.items;
  const id = todo[0].file_id;
  assert.deepEqual(todo, [
    { file_id: id, version: 2, missing: [device] },
    { file_id: id, proposal_id: pending, missing: [device] },
  ]);
  assert.deepEqual((await b.api('GET', root + '/backfill')).json.items.map((r) => r.missing_members), [[{ handle: 'ben', device }], [{ handle: 'ben', device }]]);
  const roster = (await a.api('GET', root)).json.roster;
  const request = { roster, file_id: id, version: 2, device, envelope: 'invalid' };
  assert.equal((await b.api('POST', root + '/backfill', request)).status, 403);
  assert.equal((await a.api('POST', root + '/backfill', { ...request, version: 1 })).status, 409);
  assert.equal((await a.api('POST', root + '/backfill', request)).status, 400);
  await cmd(a, 'grant', 'ben', 'read'); // Resharing within one's own identity needs only the existing read grant.
  await sync(a);
  const feed = await get('/changes?since=' + cursor);
  assert.deepEqual(
    feed.changes.map((r) => r.version),
    [2],
  );
  assert.equal(feed.changes[0].author, 'anna');
  assert.equal(feed.changes[0].backfill.device, 'primary');
  assert.deepEqual(
    feed.suggestion_events.map((e) => [e.proposal_id, e.state]),
    [[pending, 'pending']],
  );
  assert.ok(feed.changes[0].seq > cursor && feed.suggestion_events[0].seq > cursor);
  assert.equal((await get('/files/' + id + '/history')).versions.length, 1);
  assert.match(await cmd(linked, 'history', name), /v2 "research.md"[^\n]+\(current\)  Change summary unavailable/);
  assert.deepEqual(
    (await get('/suggestions')).suggestions.map((s) => s.proposal_id),
    [pending],
  );
  const again = await a.api('POST', root + '/backfill', {
    ...request,
    roster: (await a.api('GET', root)).json.roster,
    envelope: feed.changes[0].envelope,
  });
  assert.deepEqual(again.json, { added: false, seq: feed.seq });
  await sync(linked);
  assert.equal(readFileSync(file(linked, name), 'utf8'), 'Decision: accepted\n');
  assert.match(await cmd(linked, 'suggestions', name), /Decision: proposed/);
  const copy = db.prepare('SELECT * FROM team_folder_copies WHERE device=?').get(device);
  db.prepare('UPDATE team_folder_copies SET envelope=? WHERE device=?').run(
    copy.envelope.replace(/\.[^.]+$/, '.' + 'A'.repeat(86)),
    device,
  );
  await assert.rejects(cmd(linked, 'read', name), /signature/);
  db.prepare('UPDATE team_folder_copies SET envelope=? WHERE device=?').run(copy.envelope, device);
  assert.deepEqual((await a.api('GET', root + '/backfill')).json.items, []);
  await a.cli('device', 'revoke', 'web-safari', '--owner-ok');
  assert.equal((await a.api('POST', root + '/backfill', request)).status, 403);
  await cmd(a, 'revoke', 'ben');
  assert.equal((await a.api('GET', root + '/backfill')).status, 403);
  assert.ok(group);
});

test('the rejecting member can reopen for ten minutes only at the same version', async (t) => {
  const { a, b, env, root, cmd, sync, file, enable } = await team(t);
  await enable();
  const name = 'report.md';
  writeFileSync(file(a, name), 'Status: draft\n');
  await sync(a);
  const edit = (bot, base, old, value) =>
    cmd(bot, 'edit', name, '--base', String(base), '--old', old, '--new', value).then(JSON.parse);
  await edit(a, 1, 'draft', 'ready');
  const id = (await edit(b, 1, 'draft', 'deferred')).proposal_id;
  await cmd(a, 'resolve', id, 'reject');
  assert.equal(JSON.parse(await cmd(b, 'resolve', id, 'reopen')).outcome, 'access_denied');
  assert.equal(JSON.parse(await cmd(a, 'resolve', id, 'reopen')).state, 'pending');
  let events = (await a.api('GET', root + '/changes')).json.suggestion_events;
  assert.deepEqual(
    events.map((e) => e.state),
    ['pending', 'rejected', 'pending'],
  );
  await cmd(a, 'resolve', id, 'reject');
  const body = { decision: 'reopen', base: 2, request_id: 'req_' + randomBytes(16).toString('hex') };
  const reopened = await a.api('POST', root + '/suggestions/' + id + '/resolve', body);
  assert.equal(reopened.json.state, 'pending');
  assert.deepEqual((await a.api('POST', root + '/suggestions/' + id + '/resolve', body)).json, reopened.json);
  await cmd(a, 'resolve', id, 'reject');
  await edit(a, 2, 'ready', 'updated');
  await assert.rejects(cmd(a, 'resolve', id, 'reopen'), /version for reopening/);
  const second = (await edit(b, 2, 'ready', 'delayed')).proposal_id;
  await cmd(a, 'resolve', second, 'reject');
  env.advance(600_000);
  await assert.rejects(cmd(a, 'resolve', second, 'reopen'), /time or document version/);
  assert.equal((await a.api('GET', root + '/suggestions/' + second)).json.state, 'rejected');
});

test('two CLI homes creating the same path leave one document and a base-zero suggestion', async (t) => {
  const { a, b, env, db, root, cmd, sync, file, enable } = await team(t);
  const name = 'collision.md';
  let raced = false;
  await interceptFolderCommit(t, env, a, async (body) => {
    if (raced) return;
    raced = true;
    assert.equal(body.if_seq, 0);
    await sync(b);
  });
  await enable();
  writeFileSync(file(a, name), 'My first draft.\n');
  writeFileSync(file(b, name), 'Their accepted draft.\n');
  const result = await sync(a);
  assert.match(result, /became suggestion p_[a-f0-9]{32}/);
  const p = db.prepare('SELECT * FROM folder_suggestions').get();
  assert.equal(p.base, 0);
  assert.equal(p.observed, 1);
  assert.equal(p.file_id, db.prepare('SELECT file_id FROM team_folder_revisions').get().file_id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM team_folder_revisions').get().n, 1);
  const data = await cmd(b, 'suggestions', name);
  assert.match(data, /create_collision/);
  assert.match(data, /original\n\ncurrent\nTheir accepted draft\.[^]*proposed\nMy first draft\./);
  for (const bot of [a, b]) {
    assert.deepEqual(readdirSync(file(bot, '')), [name]);
    assert.equal(readFileSync(file(bot, name), 'utf8'), 'Their accepted draft.\n');
  }
  const rejected = 'f_' + randomBytes(16).toString('hex');
  const response = await b.api('POST', root + '/files/' + rejected, {
    base: 0,
    if_seq: 0,
    request_id: 'req_' + randomBytes(16).toString('hex'),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(response.json, {
    file_id: rejected,
    seq: 2,
    error: 'refresh the folder before creating a document',
  });
  assert.equal(JSON.parse(await cmd(b, 'resolve', p.proposal_id, 'accept')).version, 2);
  assert.match(await cmd(b, 'read', name), /My first draft/);
});
