import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cp from 'node:child_process';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const source = fs.readFileSync(path.join(import.meta.dirname, '../cli/b2b.mjs'), 'utf8');
const block = source.slice(source.indexOf('// ───── shared read sandbox:'), source.indexOf('// ───── end shared read sandbox'));
function context(overrides = {}) {
  const c = vm.createContext({ ...fs, ...os, ...path, ...cp, Buffer, process, createHash, readJson: () => ({}), ...overrides });
  vm.runInContext(block + '\nthis.api = {readSandboxProfile, sandboxLogin, sandboxExecutable, confinedRun, loginSecrets, loginLeak};', c); return c.api;
}
const folder = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'b2b-sandbox-test-')));

test('OS boundary denies outside reads, symlink and data-volume aliases, writes, and shell execution', { skip: process.platform !== 'darwin' }, () => {
  const root = folder(), work = path.join(root, 'work'), home = path.join(root, 'home'), outside = path.join(root, 'private.txt');
  fs.mkdirSync(work); fs.mkdirSync(home); fs.writeFileSync(path.join(work, 'inside.txt'), 'inside'); fs.writeFileSync(outside, 'private'); fs.symlinkSync(outside, path.join(work, 'escape.txt'));
  const node = fs.realpathSync(process.execPath), api = context();
  const profile = api.readSandboxProfile([work], home, { reads: [node], execs: [node] });
  const code = `const fs=require('node:fs'),cp=require('node:child_process'),assert=require('node:assert/strict');
assert.equal(fs.readFileSync(${JSON.stringify(path.join(work,'inside.txt'))},'utf8'),'inside');
for(const p of ${JSON.stringify([outside, path.join(work,'../private.txt'), path.join(work,'escape.txt'), '/System/Volumes/Data'+outside])}) assert.throws(()=>fs.readFileSync(p),e=>['EPERM','EACCES'].includes(e.code));
assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(work,'write.txt'))},'no'),e=>e.code==='EPERM');
assert.throws(()=>cp.execFileSync('/bin/sh',['-c','echo escaped']),e=>e.code==='EPERM');
fs.writeFileSync(${JSON.stringify(path.join(home,'output.txt'))},'allowed'); console.log('inside read; outside EPERM; shell EPERM; writes confined');`;
  try { const r = cp.spawnSync('/usr/bin/sandbox-exec', ['-p', profile, node, '-e', code], { encoding: 'utf8', cwd: work, env: { HOME: home, PATH: path.dirname(node) } }); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout,/outside EPERM/); }
  finally { fs.rmSync(root, {recursive:true,force:true}); }
});

test('login staging strips Claude history, settings and unrelated Keychain credentials', () => {
  const root = folder(); const calls = [];
  const api = context({ process: { ...process, env: { USER: 'pretend', CLAUDE_CONFIG_DIR: '/owner/claude' } }, readJson: (p) => { calls.push(p); return { oauthAccount: { accountUuid:'pretend' }, projects: { secret: 'history' }, mcpServers: { private: {} } }; }, spawnSync: (exe, args) => { assert.equal(exe,'/usr/bin/security'); assert.ok(args.includes('find-generic-password')); return {status:0,stdout:JSON.stringify({claudeAiOauth:{accessToken:'fake-test-token'},mcpOAuth:{private:'do-not-copy'},trustedDeviceToken:'do-not-copy'})}; } });
  try {
    const env = api.sandboxLogin('claude-code',root);
    assert.equal(env.CLAUDE_CONFIG_DIR,path.join(root,'.claude'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'.claude/.credentials.json'))),{claudeAiOauth:{accessToken:'fake-test-token'}});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'.claude/.claude.json'))),{hasCompletedOnboarding:true,oauthAccount:{accountUuid:'pretend'}});
    assert.deepEqual(calls,['/owner/claude/.claude.json']);
    assert.equal(fs.statSync(path.join(root,'.claude/.credentials.json')).mode & 0o777,0o600);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test('unsupported platforms return no sandbox without staging or starting anything', () => {
  const api=context({process:{...process,platform:'linux'},mkdtempSync:()=>{throw Error('must not stage');},spawnSync:()=>{throw Error('must not start');}});
  const result=api.confinedRun('claude-code','missing',[],[]);assert.equal(result.confined,false);assert.match(result.reason,/No sandbox/);
});

test('an answer carrying a piece of the staged login is caught: plain, split by spaces, reversed, base64 or hex', () => {
  const root = folder(); const api = context();
  try {
    fs.mkdirSync(path.join(root, '.claude')); fs.mkdirSync(path.join(root, '.codex'));
    const access = 'pretend-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', refresh = 'pretend-ort01-ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210';
    fs.writeFileSync(path.join(root, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt: 1, scopes: ['user:inference'] } }));
    fs.writeFileSync(path.join(root, '.codex/auth.json'), JSON.stringify({ tokens: { id_token: 'pretend.eyJhbGciOiJSUzI1NiJ9.signature-part-0001' } }));
    const secrets = api.loginSecrets(root, { OPENAI_API_KEY: 'pretend-key-000000000000000000' });
    assert.equal(secrets.length, 4);
    const leak = (t) => api.loginLeak(t, secrets);
    assert.equal(leak('Looks fine. No idempotency key on POST /leads (src/sync/retry.ts:48).'), false);
    assert.equal(leak('user:inference is a scope name'), false, 'short public words are not secrets');
    assert.equal(leak(`finding: ${access}`), true);
    assert.equal(leak(`finding: ${access.slice(8, 40)}`), true, 'a piece is enough');
    assert.equal(leak(`finding: ${refresh.match(/.{1,6}/g).join(' ')}`), true, 'spaces and line breaks do not hide it');
    assert.equal(leak([...access].reverse().join('')), true);
    assert.equal(leak(Buffer.from(access).toString('base64')), true);
    assert.equal(leak(Buffer.from(refresh).toString('hex')), true);
    assert.equal(leak('pretend-key-000000000000000000'), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
