// Staying up to date: the relay says which tool is newest and which is too old, the tool updates itself
// (signed, never older, swapped in one step, ~/.b2b untouched), hands out the matching skill and routine
// texts, and the dashboard tells an owner when their bot runs a tool too old to update itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { setup, login, owner } from './helpers.mjs';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(root, 'cli', 'b2b.mjs');
const SOURCE = readFileSync(CLI, 'utf8');
const VERSION = SOURCE.match(/^const VERSION = '([\d.]+)';$/m)[1];
const sha = (s) => createHash('sha256').update(s).digest('hex');

// A release key for the tests, and a relay folder serving a release signed with it (or with another key).
const releaseKey = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, x: publicKey.export({ format: 'jwk' }).x };
};
function release(version, key, { broken = false, signer = key } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'b2b-rel-'));
  let code = SOURCE.replace(/^const VERSION = '[\d.]+';$/m, `const VERSION = '${version}';`);
  if (broken) code += '\n}}} not javascript\n';
  writeFileSync(join(d, 'b2b.mjs'), code);
  writeFileSync(join(d, 'b2b.mjs.sig'), `${sign(null, Buffer.from(code), signer.privateKey).toString('base64url')}\n`);
  return d;
}
// A bot with its own copy of the tool in ~/bin, the way bots install it, enrolled with the relay.
async function installed(env, key, email, handle, { source = SOURCE } = {}) {
  const b = await login(env, email);
  await b('/app/bots', { method: 'POST', form: { handle } });
  const base = mkdtempSync(join(tmpdir(), 'b2b-home-'));
  const home = join(base, '.b2b');
  mkdirSync(join(base, 'bin'));
  const tool = join(base, 'bin', 'b2b.mjs');
  writeFileSync(tool, source, { mode: 0o755 });
  const cli = async (...a) => {
    try { const r = await run(process.execPath, [tool, ...a], { env: { ...process.env, B2B_HOME: home, B2B_RELEASE_KEY: key.x } }); return { code: 0, out: r.stdout, err: r.stderr }; }
    catch (e) { return { code: e.code, out: e.stdout, err: e.stderr }; }
  };
  const code = (await b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  assert.equal((await cli('enroll', env.url, code)).code, 0);
  const botId = Number((await b('/app')).text.match(/\/app\/bots\/(\d+)/)[1]);
  return { b, cli, tool, home, bin: join(base, 'bin'), botId };
}
const versionOf = (file) => readFileSync(file, 'utf8').match(/^const VERSION = '([\d.]+)';$/m)[1];

test('the skill and doorbell routine texts are the ones signed into the tool', async (t0) => {
  const skill = readFileSync(join(root, 'skill', 'SKILL.md'), 'utf8');
  const doorbell = readFileSync(join(root, 'SETUP-FOR-BOTS.md'), 'utf8').split('## 3. Doorbell')[1].match(/^> (.+)$/m)[1];
  const texts = SOURCE.match(/^const TEXTS = \{ skill: '([0-9a-f]{64})', doorbell: '([0-9a-f]{64})' \};$/m);
  assert.ok(texts, 'cli/b2b.mjs has TEXTS');
  assert.equal(texts[1], sha(skill), 'update TEXTS.skill in cli/b2b.mjs after changing skill/SKILL.md (then sign)');
  assert.equal(texts[2], sha(doorbell), 'update TEXTS.doorbell in cli/b2b.mjs after changing the routine in SETUP-FOR-BOTS.md (then sign)');
  const env = await setup(t0);
  const served = await (await fetch(`${env.url}/cli/texts`)).json();
  assert.equal(sha(served.skill), texts[1]);
  assert.equal(sha(served.doorbell), texts[2]);
  // The committed release verifies with the release key built into it.
  const { verify, createPublicKey } = await import('node:crypto');
  const x = SOURCE.match(/RELEASE_KEY = process\.env\.B2B_RELEASE_KEY \|\| '([\w-]+)'/)[1];
  const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  assert.ok(verify(null, readFileSync(CLI), pub, Buffer.from(readFileSync(`${CLI}.sig`, 'utf8').trim(), 'base64url')), 'cli/b2b.mjs.sig matches cli/b2b.mjs: run npm run sign');
});

test('the relay says which tool is newest, remembers which one each bot runs, and stops one that is too old', async (t0) => {
  const env = await setup(t0);
  const a = await owner(env, t0, 'ann@example.com', 'ann');
  assert.deepEqual((await (await fetch(`${env.url}/api`)).json()).tool, { latest: VERSION, min: '0.10.0' });
  await a.cli('whoami');
  const row = () => env.relay.db.prepare('SELECT tool_version FROM bots WHERE id = ?').get(a.botId).tool_version;
  assert.equal(row(), VERSION);
  // A tool from before 0.19 doesn't say its version: remembered as ''.
  const me = await a.api('GET', '/v1/me');
  assert.deepEqual(me.json.tool, { latest: VERSION, min: '0.10.0' });
  assert.equal(row(), '');
  assert.deepEqual((await a.api('POST', '/v1/inbox/claim', {})).json.tool, { latest: VERSION, min: '0.10.0' });

  const strict = await setup(t0, { minTool: '0.19.0' });
  const s = await owner(strict, t0, 'sam@example.com', 'sam');
  const old = await s.api('GET', '/v1/me');
  assert.equal(old.status, 426);
  assert.match(old.json.error, /too old[^]*node ~\/bin\/b2b\.mjs update[^]*then run the same command again/);
  assert.match(await s.cli('whoami'), /@sam/);
});

test('the doorbell run updates the tool: signed, swapped in whole, keys and contacts untouched', async (t0) => {
  const key = releaseKey();
  const env = await setup(t0, { cliDir: release('99.0.0', key) });
  const a = await installed(env, key, 'ann@example.com', 'ann');
  const config = readFileSync(join(a.home, 'config.json'));
  const r = await a.cli('inbox', '--via', 'doorbell');
  assert.match(r.out, new RegExp(`updated itself from ${VERSION.replace(/\./g, '\\.')} to 99\\.0\\.0 \\(signature checked\\)[^\\n]*Nothing to tell your owner\\.`));
  assert.match(r.out, /INBOX EMPTY/);
  assert.equal(versionOf(a.tool), '99.0.0');
  assert.equal((await a.cli('version')).out.trim(), '99.0.0');
  assert.deepEqual(readFileSync(join(a.home, 'config.json')), config);
  assert.deepEqual(readdirSync(a.bin), ['b2b.mjs'], 'no half-written files left behind');
  // The next run is the new version, already up to date.
  const again = await a.cli('inbox');
  assert.doesNotMatch(again.out, /updated itself/);
  assert.equal(env.relay.db.prepare('SELECT tool_version FROM bots WHERE id = ?').get(a.botId).tool_version, '99.0.0');
});

test('never an unsigned, older or broken tool: the old one keeps working', async (t0) => {
  const key = releaseKey();
  const cases = [
    ['unsigned', release('99.0.0', key, { signer: releaseKey() }), /Not updated: the download is not signed with the bot2bot release key\. Version [\d.]+ keeps working/],
    ['older', release('0.1.0', key), /Not updated: the relay offers 0\.1\.0, which is older than this tool/],
    ['broken', release('99.0.0', key, { broken: true }), /Not updated: the new version doesn't start with this Node\.js/],
  ];
  for (const [name, dir, says] of cases) {
    const env = await setup(t0, { cliDir: dir });
    const a = await installed(env, key, `${name}@example.com`, name);
    const before = readFileSync(a.tool);
    const r = await a.cli('update');
    assert.match(`${r.out}${r.err}`, says, name);
    assert.deepEqual(readFileSync(a.tool), before, `${name}: the tool is unchanged`);
    assert.deepEqual(readdirSync(a.bin), ['b2b.mjs'], `${name}: nothing left behind`);
    assert.equal((await a.cli('version')).out.trim(), VERSION);
    // The doorbell run doesn't install it either, and says so at most once a day.
    if (name !== 'older') {
      const first = await a.cli('inbox');
      assert.match(first.out, /couldn't update itself to 99\.0\.0[^]*It keeps working as it is[^]*Tell your owner once/);
      assert.match(first.out, /INBOX EMPTY/);
      assert.doesNotMatch((await a.cli('inbox')).out, /couldn't update itself/);
      assert.deepEqual(readFileSync(a.tool), before);
    }
  }
});

test('a tool the relay calls too old updates itself and asks to run the command again', async (t0) => {
  const key = releaseKey();
  const env = await setup(t0, { cliDir: release('99.0.0', key), minTool: '50.0.0' });
  // Enrolling has no token yet, so it works; every call after that needs a new enough tool.
  const a = await installed(env, key, 'ann@example.com', 'ann');
  const r = await a.cli('whoami');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /too old for the relay, so it updated itself to 99\.0\.0 \(signature checked\)\. Run the same command again\./);
  assert.equal(versionOf(a.tool), '99.0.0');
  assert.match((await a.cli('whoami')).out, /@ann/);
});

test('refresh: an upgraded bot is told once a day, gets texts matching its tool, and --done stops the reminder', async (t0) => {
  const key = releaseKey();
  const env = await setup(t0);
  const a = await installed(env, key, 'ann@example.com', 'ann');
  // A fresh setup already has the current texts.
  assert.doesNotMatch((await a.cli('inbox')).out, /newer version/);
  assert.match((await a.cli('refresh')).out, /already match this version/);
  // An install from before 0.19 has no record of them.
  rmSync(join(a.home, 'tool.json'));
  const first = await a.cli('inbox');
  assert.match(first.out, /"b2b messaging" skill and "b2b doorbell" routine have a newer version\. Run: node ~\/bin\/b2b\.mjs refresh and follow it\. Nothing to tell your owner unless refresh says so\./);
  assert.match(first.out, /INBOX EMPTY/);
  assert.doesNotMatch((await a.cli('inbox')).out, /newer version/);
  const r = (await a.cli('refresh')).out;
  assert.match(r, /Replace your "b2b messaging" skill[^]*-----\n---\nname: b2b messaging/);
  assert.ok(r.includes(`through ${env.url}.`), 'the relay address is filled in');
  assert.ok(!r.includes('{{RELAY}}'));
  assert.match(r, /Change only the instruction of your "b2b doorbell" routine[^]*Keep the routine itself and its webhook trigger[^]*-----\nb2b messages may be waiting for my owner\. Run `node ~\/bin\/b2b\.mjs inbox --via doorbell` and do exactly what it says\./);
  assert.match(r, /refresh --done\. There's nothing to tell your owner about this\./);
  assert.match((await a.cli('refresh', '--done')).out, /Noted[^]*Nothing to tell your owner\./);
  assert.match((await a.cli('refresh')).out, /already match/);
});

test('refresh never hands out texts the tool was not signed with', async (t0) => {
  const key = releaseKey();
  const env = await setup(t0);
  const a = await installed(env, key, 'ann@example.com', 'ann', { source: SOURCE.replace(/skill: '[0-9a-f]{64}'/, `skill: '${'0'.repeat(64)}'`) });
  const r = await a.cli('refresh', '--show');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /different texts than this version of the tool expects\. Run: node ~\/bin\/b2b\.mjs update, then refresh again/);
  assert.doesNotMatch(r.out, /name: b2b messaging/);
});

test('dashboard: an owner sees when their bot runs a tool too old to update itself, with one message to fix it', async (t0) => {
  const env = await setup(t0);
  const a = await owner(env, t0, 'ann@example.com', 'ann');
  const db = env.relay.db;
  db.prepare('UPDATE bots SET doorbell_verified_at = 1 WHERE id = ?').run(a.botId);
  // Not heard from with a version yet (before its first call after this release): nothing to say.
  db.prepare('UPDATE bots SET tool_version = NULL WHERE id = ?').run(a.botId);
  assert.doesNotMatch((await a.b('/app')).text, /old bot2bot tool/);
  // A tool from before 0.19 (it didn't say its version).
  await a.api('GET', '/v1/me');
  const home = (await a.b('/app')).text;
  assert.match(home, /@ann runs an old bot2bot tool/);
  assert.ok(home.includes(`href="/app/bots/${a.botId}#update"`));
  const page = (await a.b(`/app/bots/${a.botId}`)).text;
  assert.match(page, /id="update"[^]*Update the bot2bot tool[^]*Paste this into your bot's chat\. After that, it keeps itself up to date\./);
  assert.match(page, /Please update your bot2bot tool\. Run: node ~\/bin\/b2b\.mjs update/);
  assert.ok(page.includes(`curl -fsSL ${env.url}/cli/b2b.mjs -o ~/bin/b2b.mjs`));
  assert.match(page, /node ~\/bin\/b2b\.mjs refresh/);
  assert.match(page, /Older than 0\.19/);
  assert.doesNotMatch(page, /—/);
  // Once the bot runs this tool, it keeps itself up to date: no more warning.
  await a.cli('whoami');
  assert.doesNotMatch((await a.b('/app')).text, /old bot2bot tool/);
  assert.match((await a.b(`/app/bots/${a.botId}`)).text, new RegExp(`bot2bot tool</dt><dd><b>${VERSION.replace(/\./g, '\\.')}</b><span>Up to date`));
  // A newer tool than the bot's, but one that updates itself: it says so, without asking the owner for anything.
  const key = releaseKey();
  const later = await setup(t0, { cliDir: release('99.0.0', key) });
  const c = await installed(later, key, 'cy@example.com', 'cy');
  later.relay.db.prepare(`UPDATE bots SET tool_version = '${VERSION}', webhook_url = 'https://x.example/hook', doorbell_verified_at = 1 WHERE id = ?`).run(c.botId);
  const p2 = (await c.b(`/app/bots/${c.botId}`)).text;
  assert.match(p2, /Updates itself to 99\.0\.0 next time it checks messages/);
  assert.doesNotMatch(p2, /id="update"/);
});
