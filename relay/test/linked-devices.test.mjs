// Only temporary CLI homes and a local relay. No real agents or external services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, privateDecrypt, createDecipheriv } from 'node:crypto';
import { setup, owner, connectHandled, cliHome, msgId } from './helpers.mjs';
import { lintHandoff, handoffTemplate } from '../handoff.mjs';
const run = promisify(execFile), CLI = join(dirname(fileURLToPath(import.meta.url)), '../cli/b2b.mjs');
const cfg = (h) => JSON.parse(readFileSync(join(h, 'config.json'), 'utf8'));
const command = (home, env = {}) => async (...a) => {
  try { const r = await run(process.execPath, [CLI, ...a], { env: { ...process.env, HOME: home, B2B_HOME: home, B2B_UNATTENDED: '', ...env } }); return { code: 0, out: r.stdout + r.stderr }; }
  catch (e) { return { code: e.code, out: e.stdout + e.stderr }; }
};
const ok = async (cli, ...a) => { const r = await cli(...a); assert.equal(r.code, 0, r.out); return r.out; };
const api = async (env, config, method, path, body) => {
  const r = await fetch(env.url + path, { method, headers: { authorization: `Bearer ${config.token}`, 'x-b2b-version': '0.24.1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};
async function fixture(t) {
  const env = await setup(t, { autoTick: false });
  const a = await owner(env, t, 'tom@example.test', 'tom', { status: 503 });
  const b = await owner(env, t, 'anna@example.test', 'anna', { status: 503 });
  await connectHandled(a, b, 'Tom');
  return { env, a, b, ac: command(a.home), bc: command(b.home) };
}
async function startLink(env, name = 'server') {
  const d = cliHome(), cli = command(d.home);
  const out = await ok(cli, 'device', 'link', env.url, '--name', name);
  const [, id, code] = out.match(/device approve (d_\w+) ([A-F0-9]{16})/);
  return { ...d, cli, id, code };
}
async function finishLink(primary, d) {
  const out = await ok(primary, 'device', 'approve', d.id, d.code, '--owner-ok');
  const confirmation = out.match(/--confirm ([A-F0-9]{16})/)[1];
  await ok(d.cli, 'device', 'link', '--confirm', confirmation);
  return d;
}
async function claim(env, home) { return api(env, cfg(home), 'POST', '/v1/inbox/claim', { devices: 1 }); }
async function ack(env, home, m) { return api(env, cfg(home), 'POST', `/v1/messages/${m.id}/ack`, { lease: m.lease }); }

test('link checks both owner-carried codes, independent secrets, primary-only controls and unattended refusals', async (t) => {
  const { env, b, bc } = await fixture(t), d = await startLink(env);
  assert.notEqual((await bc('device', 'approve', d.id, 'BAD', '--owner-ok')).code, 0);
  assert.notEqual((await bc('device', 'approve', d.id, d.code)).code, 0);
  assert.notEqual((await command(b.home, { B2B_UNATTENDED: '1' })('device', 'approve', d.id, d.code, '--owner-ok')).code, 0);
  const approved = await ok(bc, 'device', 'approve', d.id, d.code, '--owner-ok');
  assert.notEqual((await d.cli('device', 'link', '--confirm', 'BAD')).code, 0);
  assert.equal(existsSync(join(d.home, 'config.json')), false);
  await ok(d.cli, 'device', 'link', '--confirm', approved.match(/--confirm ([A-F0-9]{16})/)[1]);
  const primary = cfg(b.home), linked = cfg(d.home);
  assert.notEqual(linked.token, primary.token);
  assert.notEqual(linked.keys.sign.d, primary.keys.sign.d);
  assert.notEqual(linked.keys.box.d, primary.keys.box.d);
  const dump = JSON.stringify(env.relay.db.prepare('SELECT * FROM device_links').all()) + JSON.stringify(env.relay.db.prepare('SELECT * FROM device_rosters').all());
  assert.ok(!dump.includes(primary.keys.sign.d) && !dump.includes(linked.keys.box.d) && !dump.includes(linked.token));
  assert.match(await ok(d.cli, 'device', 'list'), /server \(this device\)/);
  assert.equal((await api(env, linked, 'POST', '/v1/doorbell', { kind: 'watch', agent: 'codex' })).status, 403);
  assert.equal((await api(env, linked, 'GET', '/v1/watch')).status, 403);
  assert.notEqual((await d.cli('device', 'revoke', 'server', '--owner-ok')).code, 0);
  assert.notEqual((await command(d.home, { B2B_UNATTENDED: '1' })('device', 'link', '--confirm', 'BAD')).code, 0);
});

test('pinned identity accepts vouched devices; all copies decrypt; claim fencing and handled notices', async (t) => {
  const { env, a, b, ac, bc } = await fixture(t);
  await ok(ac, 'send', '@anna', 'before linking');
  const first = (await claim(env, b.home)).data.messages[0]; await ack(env, b.home, first);
  const pin = JSON.parse(readFileSync(join(a.home, 'peers.json'), 'utf8'));
  const d = await finishLink(bc, await startLink(env));
  const id = msgId(await ok(ac, 'send', '@anna', 'private work for either computer'));
  const row = env.relay.db.prepare('SELECT sealed FROM messages WHERE id = ?').get(id);
  assert.ok(row.sealed.startsWith('b2bd1.'));
  const bundle = JSON.parse(Buffer.from(row.sealed.slice(6), 'base64url'));
  assert.equal(Object.keys(bundle.copies).length, 2);
  assert.ok(!row.sealed.includes('private work'));
  const delivered = await ok(d.cli, 'inbox');
  assert.match(delivered, /private work for either computer/);
  assert.doesNotMatch(delivered, /NEW security key|failed its security/);
  const receipt = delivered.match(new RegExp(`${id}~[A-Za-z0-9_-]+`))[0];
  const held = await claim(env, b.home); assert.equal(held.data.messages.length, 0);
  assert.equal((await api(env, cfg(b.home), 'POST', `/v1/messages/${receipt}/ack`, {})).status, 409);
  await ok(d.cli, 'ack', receipt);
  assert.match(await ok(bc, 'inbox'), /handled on "server"/);
  assert.doesNotMatch(await ok(bc, 'inbox'), /handled on/);
  await ok(ac, 'send', '@anna', 'primary reads this');
  const out = await ok(bc, 'inbox'); assert.match(out, /primary reads this/);
  await ok(bc, 'ack', out.match(/msg_[\w-]+~[\w-]+/)[0]);
  assert.match(await ok(d.cli, 'inbox'), /handled on "primary"/);
  assert.deepEqual(JSON.parse(readFileSync(join(a.home, 'peers.json'), 'utf8')), pin);
  await ok(d.cli, 'send', '@tom', 'signed by the server');
  assert.match(await ok(ac, 'inbox'), /signed by the server/);
});

test('old tools fail explicitly and pre-link encrypted messages remain for the primary', async (t) => {
  const { env, a, b, ac, bc } = await fixture(t);
  const oldId = msgId(await ok(ac, 'send', '@anna', 'only the original keys can open this'));
  const oldSeal = env.relay.db.prepare('SELECT sealed FROM messages WHERE id = ?').get(oldId).sealed;
  const d = await finishLink(bc, await startLink(env));
  assert.equal((await claim(env, d.home)).data.messages.length, 0);
  assert.match(await ok(bc, 'inbox'), /only the original keys/);
  const legacy = await api(env, cfg(a.home), 'POST', '/v1/messages', { to: '@anna', sealed: oldSeal, again: true });
  assert.equal(legacy.status, 409); assert.match(legacy.data.error, /Update/);
  await ok(d.cli, 'send', '@tom', 'new format from server');
  const oldReader = await api(env, cfg(a.home), 'POST', '/v1/inbox/claim', {});
  assert.equal(oldReader.status, 409);
  assert.match(await ok(ac, 'inbox'), /new format from server/);
});

test('revocation removes token access, releases the lease, stops sealing to it and rejects stale lists', async (t) => {
  const { env, a, b, ac, bc } = await fixture(t), d = await finishLink(bc, await startLink(env));
  const saved = cfg(d.home);
  const id = msgId(await ok(ac, 'send', '@anna', 'finish on primary'));
  const lease = (await claim(env, d.home)).data.messages[0]; assert.equal(lease.id, id);
  const stale = (await api(env, cfg(a.home), 'GET', '/v1/contacts')).data;
  await ok(bc, 'device', 'revoke', 'server', '--owner-ok');
  assert.equal((await api(env, saved, 'GET', '/v1/me')).status, 401);
  assert.match(await ok(bc, 'inbox'), /finish on primary/);
  const id2 = msgId(await ok(ac, 'send', '@anna', 'after revoke'));
  const bundle = JSON.parse(Buffer.from(env.relay.db.prepare('SELECT sealed FROM messages WHERE id = ?').get(id2).sealed.slice(6), 'base64url'));
  assert.deepEqual(Object.keys(bundle.copies), ['primary']);
  const current = env.relay.db.prepare('SELECT manifest FROM device_rosters WHERE bot_id = ?').get(Number(b.botId)).manifest;
  env.relay.db.prepare('UPDATE device_rosters SET manifest = ? WHERE bot_id = ?').run(JSON.stringify(stale.contacts.find((c) => c.handle === '@anna').devices), Number(b.botId));
  assert.match((await ac('send', '@anna', 'must refuse rollback')).out, /went backwards/);
  env.relay.db.prepare('UPDATE device_rosters SET manifest = ? WHERE bot_id = ?').run(current, Number(b.botId));
});

test('relay-invented keys, forged approvals, wrong-owner approval and expired links are refused', async (t) => {
  const { env, a, b, ac, bc } = await fixture(t), d = await startLink(env);
  const r = await api(env, cfg(b.home), 'POST', '/v1/devices/approve', { id: d.id, code: d.code, manifest: { roster: {}, signature: 'fake' } });
  assert.equal(r.status, 400);
  await finishLink(bc, d);
  assert.equal((await api(env, cfg(a.home), 'GET', `/v1/devices/link/${d.id}`)).status, 403);
  await ok(ac, 'send', '@anna', 'pins the real root');
  const manifest = JSON.parse(env.relay.db.prepare('SELECT manifest FROM device_rosters WHERE bot_id = ?').get(Number(b.botId)).manifest);
  manifest.roster.devices[1].box = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x;
  env.relay.db.prepare('UPDATE device_rosters SET manifest = ? WHERE bot_id = ?').run(JSON.stringify(manifest), Number(b.botId));
  assert.match((await ac('send', '@anna', 'must not reach fake device')).out, /signature does not match/);
  const pending = await startLink(env, 'laptop'); env.advance(17 * 60_000);
  assert.equal((await api(env, cfg(a.home), 'GET', `/v1/devices/link/${pending.id}`)).status, 404);
});

test('own Codex shorthand resolves by ownership and platform, and refuses ambiguity', async (t) => {
  const { env, a, b, ac } = await fixture(t);
  env.relay.db.prepare("UPDATE bots SET platform = 'codex', user_id = (SELECT user_id FROM bots WHERE id = ?) WHERE id = ?").run(Number(a.botId), Number(b.botId));
  assert.match(await ok(ac, 'send', 'my Codex', 'own codex work'), /Sent msg_/);
  const c = await owner(env, t, 'mia@example.test', 'mia', { status: 503 }); await connectHandled(a, c, 'Tom');
  env.relay.db.prepare("UPDATE bots SET platform = 'codex', user_id = (SELECT user_id FROM bots WHERE id = ?) WHERE id = ?").run(Number(a.botId), Number(c.botId));
  const ambiguous = await ac('send', 'my Codex', 'which identity');
  assert.notEqual(ambiguous.code, 0); assert.match(ambiguous.out, /Which Codex identity/);
});

test('repo handoff fields stay optional and warn before an unpushed handoff', async () => {
  const text = handoffTemplate({ id: 'h_abcdefgh', thread: 't_abcdefgh', from: '@tom', repo: { repo_branch: 'lead-v2', repo_commit: 'a'.repeat(40), repo_pushed: false, repo_tests: '12 passed' } });
  const result = lintHandoff(text);
  assert.ok(result.warnings.includes("lead-v2 is not pushed. Codex on the server won't see it."));
  assert.ok(!result.warnings.some((w) => /unknown field.*repo_/.test(w)));
  assert.ok(!lintHandoff(handoffTemplate({ id: 'h_abcdefgh', thread: 't_abcdefgh', from: '@tom' })).errors.some((e) => /repo_/.test(e)));
});

test('group membership stays one identity and group copies reach both devices', async (t) => {
  const { env, a, b, ac, bc } = await fixture(t);
  const d = await finishLink(bc, await startLink(env));
  const made = await ok(ac, 'group', 'new', 'Shared work', '@anna');
  const gid = Number(made.match(/number (\d+)/)[1]);
  env.relay.groups.join(env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(b.botId)), gid, { byOwner: true });
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM group_members WHERE group_id = ? AND state = 'joined'").get(gid).n, 2);
  await ok(ac, 'group', 'send', String(gid), 'group brief to both machines');
  const out = await ok(d.cli, 'inbox'); assert.match(out, /group brief to both machines/);
  const receipt = out.match(/b2b\.mjs ack (msg_[\w-]+~[\w-]+)/)[1]; await ok(d.cli, 'ack', receipt);
  assert.match(await ok(bc, 'inbox'), /handled on "server"/);
  await ok(d.cli, 'group', 'send', String(gid), 'server answers once');
  assert.match(await ok(ac, 'inbox'), /server answers once/);
  assert.match(await ok(bc, 'group', 'read', String(gid)), /group brief to both machines/);
  env.relay.groups.remove(env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(a.botId)), gid, '@anna');
  assert.notEqual((await d.cli('group', 'send', String(gid), 'cannot remain as another device')).code, 0);
});

test('ciphertext tampering and incomplete fanout are refused; erasure removes every copy', async (t) => {
  const { env, a, b, ac, bc } = await fixture(t), d = await finishLink(bc, await startLink(env));
  const id = msgId(await ok(ac, 'send', '@anna', 'all copies must disappear'));
  const row = env.relay.db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
  const e = JSON.parse(Buffer.from(row.sealed.slice(6), 'base64url'));
  delete e.copies[d.id];
  const r = await api(env, cfg(a.home), 'POST', '/v1/messages', { to: '@anna', sealed: `b2bd1.${Buffer.from(JSON.stringify(e)).toString('base64url')}` });
  assert.equal(r.status, 409);
  const full = JSON.parse(Buffer.from(row.sealed.slice(6), 'base64url'));
  const parts = full.copies[d.id].split('.'); parts[3] = (parts[3][0] === 'A' ? 'B' : 'A') + parts[3].slice(1); full.copies[d.id] = parts.join('.');
  env.relay.db.prepare('UPDATE messages SET sealed = ? WHERE id = ?').run(`b2bd1.${Buffer.from(JSON.stringify(full)).toString('base64url')}`, id);
  assert.match(await ok(d.cli, 'inbox'), /failed its security check/);
  env.advance(8 * 24 * 60 * 60_000); env.relay.retention();
  assert.equal(env.relay.db.prepare('SELECT sealed FROM messages WHERE id = ?').get(id).sealed, null);
});

test('reconnecting a primary invalidates linked tokens and removes the old roster', async (t) => {
  const { env, b, bc } = await fixture(t), d = await finishLink(bc, await startLink(env));
  const saved = cfg(d.home);
  env.relay.db.prepare('UPDATE bots SET token_hash = ? WHERE id = ?').run('reconnected-token', Number(b.botId));
  assert.equal((await api(env, saved, 'GET', '/v1/me')).status, 401);
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM device_rosters').get().n, 0);
});

test('handoff new snapshots local repo state without running the stated test command', async (t) => {
  const { ac } = await fixture(t);
  const repo = mkdtempSync(join(tmpdir(), 'b2b-device-repo-'));
  await run('git', ['init', '-b', 'lead-v2', repo]);
  await run('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '--allow-empty', '-m', 'fixture']);
  const out = join(repo, 'handoff.md');
  await ok(ac, 'handoff', 'new', '--repo', repo, '--tests', 'not run: owner will run npm test', '--out', out);
  const text = readFileSync(out, 'utf8');
  assert.match(text, /repo_branch: "lead-v2"/);
  assert.match(text, /repo_pushed: false/);
  assert.match(text, /repo_tests: "not run: owner will run npm test"/);
  assert.match((await ac('handoff', 'lint', out)).out, /lead-v2 is not pushed/);
});

test('reused SQLite rowids after retention do not hide new messages from a linked device', async (t) => {
  const { env, ac, bc } = await fixture(t);
  await ok(ac, 'send', '@anna', 'message before linking');
  const d = await finishLink(bc, await startLink(env));
  env.relay.db.prepare('DELETE FROM messages').run();
  await ok(ac, 'send', '@anna', 'new message after cleanup');
  assert.match(await ok(d.cli, 'inbox'), /new message after cleanup/);
});

test('a handoff to my Codex warns before sending and opens on the linked machine', async (t) => {
  const { env, a, b, ac, bc } = await fixture(t);
  env.relay.db.prepare("UPDATE bots SET platform = 'codex', user_id = (SELECT user_id FROM bots WHERE id = ?) WHERE id = ?").run(Number(a.botId), Number(b.botId));
  const d = await finishLink(bc, await startLink(env));
  const path = join(a.home, 'package.md');
  const text = handoffTemplate({ id: 'h_devicebrief1', thread: 't_devicebrief1', from: '@tom', repo: { repo_branch: 'lead-v2', repo_commit: 'a'.repeat(40), repo_pushed: false, repo_tests: '12 passed' } }).replace(/<!--[^]*?-->/g, 'Verified locally.');
  writeFileSync(path, text);
  const before = env.relay.db.prepare('SELECT count(*) AS n FROM messages').get().n;
  const blocked = await ac('handoff', 'send', 'my Codex', path, '--owner-ok', '--transport', 'inline');
  assert.notEqual(blocked.code, 0); assert.match(blocked.out, /lead-v2 is not pushed/);
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM messages').get().n, before);
  await ok(ac, 'handoff', 'send', 'my Codex', path, '--owner-ok', '--transport', 'inline', '--allow-unpushed');
  const out = await ok(d.cli, 'inbox');
  assert.match(out, /h_devicebrief1/); assert.match(out, /repo_tests: "12 passed"/);
  await ok(d.cli, 'ack', out.match(/b2b\.mjs ack (msg_[\w-]+~[\w-]+)/)[1]);
  assert.match(await ok(bc, 'inbox'), /handled on "server"/);
});

test('primary browser history opens a sent copy signed by a linked device', async (t) => {
  const { env, a, b, ac, bc } = await fixture(t), d = await finishLink(bc, await startLink(env));
  const gid = Number((await ok(ac, 'group', 'new', 'Review', '@anna')).match(/number (\d+)/)[1]);
  env.relay.groups.join(env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(b.botId)), gid, { byOwner: true });
  await ok(d.cli, 'group', 'send', String(gid), 'Own history from the server');
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const response = await b.b('/app/group-browser', { method: 'POST', form: { bot: b.botId, group: String(gid), public_key: rsa.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url') } });
  assert.equal(response.status, 200);
  const request = response.json();
  const metadata = (await api(env, cfg(b.home), 'GET', `/v1/group-browser/${request.id}`)).data;
  assert.equal((await api(env, cfg(d.home), 'GET', `/v1/group-browser/${request.id}`)).status, 403);
  await ok(bc, 'group', 'browser', String(gid), request.id, request.fingerprint);
  const sealed = JSON.parse(env.relay.db.prepare('SELECT envelope FROM group_browser_views WHERE id = ?').get(request.id).envelope);
  const key = privateDecrypt({ key: rsa.privateKey, oaepHash: 'sha256', oaepLabel: Buffer.from(metadata.aad) }, Buffer.from(sealed.key, 'base64url'));
  const ct = Buffer.from(sealed.ciphertext, 'base64url'), dec = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64url'));
  dec.setAAD(Buffer.from(metadata.aad)); dec.setAuthTag(ct.subarray(-16));
  const snapshot = JSON.parse(Buffer.concat([dec.update(ct.subarray(0, -16)), dec.final()]));
  assert.ok(snapshot.messages.some((m) => m.text === 'Own history from the server'));
});

test('session startup reports handled devices and secondary readiness excludes older encrypted history', async (t) => {
  const { env, a, b, ac, bc } = await fixture(t);
  await ok(ac, 'send', '@anna', 'before this machine joined');
  const d = await finishLink(bc, await startLink(env));
  const me = await api(env, cfg(d.home), 'GET', '/v1/me');
  assert.equal(me.data.inbox_ready, 0); assert.equal(me.data.inbox_pending, 0);
  await ok(ac, 'send', '@anna', 'handoff on either machine');
  assert.match(await ok(d.cli, 'waiting'), /1 more message is still waiting/);
  const out = await ok(d.cli, 'inbox');
  await ok(d.cli, 'ack', out.match(/b2b\.mjs ack (msg_[\w-]+~[\w-]+)/)[1]);
  assert.match(await ok(bc, 'waiting'), /handled on "server"/);
  assert.doesNotMatch(await ok(bc, 'waiting'), /handled on/);
});

test('a damaged device-list cache fails closed instead of forgetting revocations', async (t) => {
  const { env, a, ac, bc } = await fixture(t);
  await finishLink(bc, await startLink(env));
  await ok(ac, 'send', '@anna', 'learn the device list');
  writeFileSync(join(a.home, 'device-lists.json'), '{truncated');
  const result = await ac('send', '@anna', 'must not forget the device list');
  assert.notEqual(result.code, 0); assert.match(result.out, /saved device list is unreadable/);
});
