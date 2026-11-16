// 0.23: handoff packages and task threads. A package is one Markdown file (bounded front matter + fixed sections),
// checked before it leaves (sections, size, secrets, refs the other bot can't reach), and sent the way the other bot
// can read it, from the capability profile the relay keeps for it. Only pretend bots on a private relay here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setup, owner, connect, listen, connectApp, msgId } from './helpers.mjs';
import { presign } from '../files.mjs';
import { parseHandoff, lintHandoff, handoffTemplate, handoffInfo, findSecrets, newHandoffId, newThreadId, HANDOFF_LIMITS } from '../handoff.mjs';
import { capabilityProfile } from '../capabilities.mjs';

const CLI = join(import.meta.dirname, '..', 'cli', 'b2b.mjs');
const H = 'h_8f2cabcdef12';
const T = 't_41aaabcdef12';
const SECTIONS = '## Goal\nShip the new orders endpoint.\n## Current state\nDone in 3e1a9c0.\n## Decisions\nPagination by cursor, because offsets drift.\n## Open questions\nNone\n## Constraints\nNo schema change.\n## What I need from you\nA review.\n## How to verify\nnpm test\n';
const pkg = (front = '', body = SECTIONS) => `---\nspec: b2b-handoff/1\nid: ${H}\nthread: ${T}\nfrom: "@ben"\nask: review\ntitle: "Orders API"\n${front}---\n${body}`;
const RESULT = (front = 'verdict: changes\nfindings:\n  - "Cursor isn\'t signed"\nrefs:\n  - {type: pr, url: https://github.com/org/api/pull/42}\n') =>
  `---\nspec: b2b-handoff/1\nid: h_resultabcdef12\nthread: ${T}\nask: result\nin_reply_to: ${H}\n${front}---\n## Summary\nTwo changes needed.\n## Findings\nThe cursor isn't signed (api/orders.js:40).\n## How to verify\nnpm test\n`;

test('the shared package code is the same in the relay and in the b2b tool', () => {
  const block = (f) => {
    const s = readFileSync(join(import.meta.dirname, '..', f), 'utf8');
    const a = s.indexOf('// ---- handoff package v1: begin'); const b = s.indexOf('// ---- handoff package v1: end ----');
    assert.ok(a >= 0 && b > a, `${f} has the block`);
    return s.slice(a, b);
  };
  assert.equal(block('cli/b2b.mjs'), block('handoff.mjs'));
});

test('front matter: a small, bounded YAML subset, read without a parser library', () => {
  const ok = parseHandoff(pkg('refs:\n  - {type: git, url: https://github.com/org/api, commit: 3e1a9c0, path: "a, b.yaml"}   # pinned\n  - https://example.com/doc\n  - {type: local, path: ~/notes.md, portable: false}\nreply_by: 2026-11-16T12:00+01:00 # soon\n'));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.meta.from, '@ben');
  assert.deepEqual({ ...ok.meta.refs[0] }, { type: 'git', url: 'https://github.com/org/api', commit: '3e1a9c0', path: 'a, b.yaml' });
  assert.equal(ok.meta.refs[1], 'https://example.com/doc');
  assert.equal(ok.meta.refs[2].portable, false);
  assert.equal(ok.meta.reply_by, '2026-11-16T12:00+01:00');
  assert.equal(ok.sections['what i need from you'], 'A review.\n');
  // What a YAML parser would do more is refused: anchors, aliases, tags, block text, nesting, tabs, repeats.
  for (const [front, why] of [['a: &x 1\n', /anchors/], ['a: *x\n', /anchors/], ['a: !!str x\n', /anchors/], ['a: |\n', /anchors/], ['refs:\n  nested: 1\n', /nested fields/],
    ['refs:\n  - [1, 2]\n', /nested lists/], ['refs:\n  - {a: {b: 1}}\n', /nested/], ['\ta: 1\n', /expected|tabs/], ['title: "x"\n', /appears twice/], ['a: "open\n', /quote isn't closed/], ['- x\n', /no field above/], ['a: {b: 1}\n', /can't be a map/]]) {
    assert.match(parseHandoff(pkg(front)).errors.join('\n'), why, front);
  }
  // Keys that would reach Object.prototype in a naive parser are plain fields here.
  const proto = parseHandoff(pkg('__proto__: x\nconstructor: y\n'));
  assert.equal(({}).polluted, undefined);
  assert.equal(proto.meta.__proto__, 'x');
  // Bounded: front matter size and lines, list length and value length.
  assert.match(parseHandoff(pkg(`refs:\n${'  - https://example.com/x\n'.repeat(HANDOFF_LIMITS.refs + 5)}`)).errors.join(), /too many items/);
  assert.match(parseHandoff(pkg(`title2: "${'x'.repeat(HANDOFF_LIMITS.value + 1)}"\n`)).errors.join(), /longer than 600/);
  assert.match(parseHandoff(pkg('x: 1\n'.repeat(HANDOFF_LIMITS.frontLines + 1))).errors.join(), /front matter is longer/);
  assert.match(parseHandoff('no front matter').errors.join(), /must start with front matter/);
  assert.match(parseHandoff('---\nspec: b2b-handoff/1\n').errors.join(), /no closing/);
  // Headings inside code fences aren't sections.
  assert.equal(parseHandoff(pkg('', `${SECTIONS}\`\`\`\n## Goal\nnot a heading\n\`\`\`\n`)).sections.goal, 'Ship the new orders endpoint.\n');
});

test('lint: required fields and sections, size, secrets and refs the other bot can\'t reach', () => {
  assert.deepEqual(lintHandoff(pkg('refs:\n  - {type: pr, url: https://github.com/org/api/pull/42}\n')).errors, []);
  // A fresh template isn't ready until every section is written.
  const tpl = handoffTemplate({ id: newHandoffId(), thread: newThreadId(), from: '@ben', title: 'Orders' });
  const tl = lintHandoff(tpl);
  assert.equal(tl.errors.length, 7);
  assert.ok(tl.errors.every((e) => /is empty/.test(e)));
  assert.match(tl.warnings.join(), /no refs/);
  assert.match(lintHandoff(pkg('', SECTIONS.replace('## Constraints\nNo schema change.\n', ''))).errors.join(), /missing section "## Constraints"/);
  for (const [front, why] of [['ask: maybe\n', /appears twice|ask must be/], ['reply_by: tomorrow\n', /reply_by/], ['from: "not a handle!"\n', /appears twice|from must be/]]) assert.match(lintHandoff(pkg(front)).errors.join(), why);
  assert.match(lintHandoff(pkg().replace(`id: ${H}`, 'id: 42')).errors.join(), /id must look like h_/);
  assert.match(lintHandoff(pkg().replace(`thread: ${T}`, 'thread: x')).errors.join(), /thread must look like t_/);
  assert.match(lintHandoff(pkg().replace('spec: b2b-handoff/1', 'spec: b2b-handoff/9')).errors.join(), /spec must be b2b-handoff\/1/);
  // Size: words and bytes.
  assert.match(lintHandoff(pkg('', SECTIONS.replace('A review.', 'word '.repeat(HANDOFF_LIMITS.words)))).errors.join(), /words; keep it under 2000/);
  assert.match(lintHandoff(pkg('', SECTIONS + 'x'.repeat(HANDOFF_LIMITS.bytes))).errors.join(), /bigger than 64 KB/);
  assert.match(lintHandoff(pkg('', SECTIONS.replace('A review.', 'A review.‮'))).errors.join(), /control or text-direction/);
  // Secrets: reported by kind and line, never echoed.
  const secrets = {
    'a GitHub token': `ghp_${'a1B2'.repeat(9)}`, 'an AWS access key': 'AKIAIOSFODNN7EXAMPLE', 'an OpenAI API key': `sk-proj-${'x'.repeat(30)}`, 'an Anthropic API key': `sk-ant-api03-${'y'.repeat(30)}`,
    'a private key': '-----BEGIN OPENSSH PRIVATE KEY-----', 'a Slack token': 'xoxb-1234567890-abcdef', 'a password in a URL': 'postgres://admin:hunter22@db.example.com/x',
    'a password or secret': 'DB_PASSWORD=correcthorsebattery', 'a JSON web token': `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(12)}`, 'a bot2bot token': `b2b_${'z'.repeat(30)}`,
  };
  for (const [what, value] of Object.entries(secrets)) {
    const l = lintHandoff(pkg('', SECTIONS.replace('Done in 3e1a9c0.', `Done. ${value}`)));
    assert.ok(l.errors.some((e) => e.includes(`looks like ${what}`) && e.includes('line 12')), what);
    assert.ok(!l.errors.join().includes(value), 'the secret itself is never printed');
  }
  assert.deepEqual(findSecrets('password: <redacted>\napi_key = ${API_KEY}\nThe token rotates daily.'), []);
  assert.match(lintHandoff(pkg('', SECTIONS.replace('None', 'k3y-0123456789abcdef')), { secrets: [{ what: "this bot's secret key", value: 'k3y-0123456789abcdef' }] }).errors.join(), /looks like this bot's secret key/);
  // Refs: what the other bot can and can't open.
  const refs = 'refs:\n  - {type: git, url: https://github.com/org/api}\n  - {type: local, path: ~/notes.md}\n  - {type: url, url: http://localhost:3000/preview}\n  - {type: b2b-file, name: diff.patch}\n  - {type: wiki, url: https://x.example}\n  - {type: pr, url: "javascript:alert(1)"}\n';
  const l = lintHandoff(pkg(refs), { profile: { files: true, repo: false }, files: [] });
  assert.match(l.warnings.join('\n'), /ref 1: pin a commit/);
  assert.match(l.warnings.join('\n'), /ref 2 is a path on your computer \(mark it portable: false\)/);
  assert.match(l.warnings.join('\n'), /ref 3 points to your computer or network/);
  assert.match(l.warnings.join('\n'), /can't open repositories: attach a diff/);
  assert.match(l.errors.join('\n'), /ref 4: "diff.patch" isn't attached/);
  assert.match(l.errors.join('\n'), /ref 5: type must be one of/);
  assert.match(l.errors.join('\n'), /ref 6: needs url/);
  assert.match(lintHandoff(pkg('refs:\n  - {type: b2b-file, name: diff.patch}\n'), { profile: { files: false } }).errors.join(), /can't receive files/);
  assert.match(lintHandoff(pkg(`refs:\n  - {type: b2b-file, name: d.patch, sha256: ${'a'.repeat(64)}}\n`), { files: [{ name: 'd.patch', sha256: 'b'.repeat(64) }] }).errors.join(), /sha256 differs/);
});

test('a result package has a verdict, findings and refs', () => {
  assert.deepEqual(lintHandoff(RESULT()).errors, []);
  assert.deepEqual(lintHandoff(RESULT('verdict: approve\nfindings: []\nrefs: []\n')).errors, []);
  const bad = lintHandoff(RESULT('verdict: maybe\n')).errors.join('\n');
  assert.match(bad, /verdict: one of approve, changes, blocked, answer/);
  assert.match(bad, /needs findings/);
  assert.match(bad, /needs refs/);
  assert.match(lintHandoff(RESULT().replace('## Summary', '## Goal')).errors.join(), /missing section "## Summary"/);
  assert.deepEqual(handoffInfo(RESULT()), { id: 'h_resultabcdef12', thread: T, ask: 'result', verdict: 'changes', in_reply_to: H, title: null, reply_by: null });
  assert.equal(handoffInfo('just a message\n---\nspec: b2b-handoff/1'), null);
  assert.equal(handoffInfo('---\nspec: other\n---\n'), null);
});

test('capability profiles: what each kind of bot can do, never which app it is', () => {
  const p = (vendor, platform) => { const x = capabilityProfile({ vendor, platform }); return `${x.files}/${x.repo}/${x.shell}/${x.transport}`; };
  for (const a of ['claude_code', 'codex', 'cursor', 'hermes', 'openclaw', 't3code']) assert.equal(p('grokbot', a), 'true/true/true/attachment', a);
  assert.equal(p('grokbot', 'grok'), 'true/false/true/attachment+inline', 'Grok Bot: files yes, no repo access');
  assert.equal(p('grokbot', 'chatgpt'), 'null/false/true/inline', 'a dot in private mode: files not assumed');
  assert.equal(p('grokbot', 'instinct'), 'null/false/true/inline');
  assert.equal(p('connector', 'chatgpt'), 'false/false/false/inline', 'quick connect: package in the message');
  assert.equal(p('web', null), 'false/false/false/inline');
  assert.ok(!('platform' in capabilityProfile({ vendor: 'grokbot', platform: 'codex' })));
});

// An S3 stand-in, as in files.test.mjs: every request must carry a valid presigned link.
async function store(t0) {
  const bucket = new Map(); const box = {};
  const { s, url } = await listen(async (req, res) => {
    const u = new URL(req.url, url);
    const at = Date.parse(u.searchParams.get('X-Amz-Date')?.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));
    const sized = (u.searchParams.get('X-Amz-SignedHeaders') || '').split(';').includes('content-length');
    const want = presign(box.s3, { method: req.method, key: decodeURIComponent(u.pathname.replace(`/${box.s3.bucket}/`, '')), expiresSec: Number(u.searchParams.get('X-Amz-Expires')), at, size: sized ? req.headers['content-length'] : null });
    if (want !== `${url}${req.url}`) return res.writeHead(403).end();
    if (req.method === 'PUT') { const parts = []; for await (const c of req) parts.push(c); bucket.set(u.pathname, Buffer.concat(parts)); return res.writeHead(200).end(); }
    if (req.method === 'GET') return bucket.has(u.pathname) ? res.writeHead(200, { 'content-length': bucket.get(u.pathname).length }).end(bucket.get(u.pathname)) : res.writeHead(404).end();
    if (req.method === 'DELETE') { bucket.delete(u.pathname); return res.writeHead(204).end(); }
    res.writeHead(405).end();
  });
  box.s3 = { endpoint: url, bucket: 'test-files', region: 'auto', keyId: 'test-key', secret: 'test-secret-0123456789', style: 'path' };
  t0.after(() => s.close());
  return { s3: box.s3, bucket, uploads: () => [...bucket.values()] };
}
async function pair(t0, annaPlatform) {
  const st = await store(t0);
  process.env.B2B_FILES = mkdtempSync(join(tmpdir(), 'b2b-files-'));
  const env = await setup(t0, { files: { s3: st.s3, alpha: ['ben@example.com', 'anna@example.com'] } });
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  for (const p of [ben, anna]) p.routine.status = 503; // the bots read their inbox when the test says so
  env.relay.db.prepare("UPDATE bots SET platform = 'claude_code' WHERE handle = 'ben'").run();
  env.relay.db.prepare('UPDATE bots SET platform = ? WHERE handle = ?').run(annaPlatform, 'anna');
  await connect(ben, anna, 'Ben');
  await ben.cli('contacts'); await anna.cli('contacts'); // keys pinned both ways
  return { env, st, ben, anna };
}
const fill = (path, body = SECTIONS, refs = '') => writeFileSync(path, readFileSync(path, 'utf8').replace(/refs:\n(\s+#.*\n)*/, refs ? `refs:\n${refs}` : 'refs:\n  - {type: pr, url: https://github.com/org/api/pull/42}\n').replace(/## Goal[^]*$/, body));
const cliIn = (home, input, ...args) => new Promise((ok, fail) => {
  const ch = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, B2B_HOME: home } });
  let out = ''; let err = '';
  ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
  ch.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(err || out))));
  ch.stdin.end(input);
});

test('a package to a coding agent goes as an encrypted file; the receiver reads the thread, answers with a result, and the thread follows', async (t0) => {
  const { env, st, ben, anna } = await pair(t0, 'codex');
  // The relay tells Ben's tool what Anna's bot can do, and nothing about which app it is.
  const c = (await ben.api('GET', '/v1/contacts')).json.contacts[0];
  assert.deepEqual(c.profile, { spec: 'b2b-capabilities/1', files: true, repo: true, shell: true, transport: 'attachment' });
  assert.ok(!JSON.stringify(c).includes('codex'));
  assert.equal((await ben.api('GET', '/v1/me')).json.profile.transport, 'attachment');

  const made = await ben.cli('handoff', 'new', '--to', 'anna', '--title', 'Orders API');
  const path = made.match(/to fill in: (.+)/)[1];
  assert.ok(path.startsWith(join(ben.home, 'handoffs')), 'drafts live in the bot folder, not the repo');
  const thread = made.match(/thread (t_\w+)/)[1];
  await assert.rejects(ben.cli('handoff', 'lint', path), /section "## Goal" is empty/);
  fill(path);
  assert.match(await ben.cli('handoff', 'lint', path, '--to', 'anna'), /OK: package h_\w+ \(review, \d+ words\)[^]*as an attached file/);
  // The owner okays what leaves first.
  await assert.rejects(ben.cli('handoff', 'send', 'anna', path), /Not sent yet: your owner okays what you share with "Anna" first[^]*goes end-to-end encrypted[^]*--owner-ok/);
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM messages WHERE kind != 'probe'").get().n, 0);
  await assert.rejects(ben.cli('handoff', 'send', 'anna', path, '--owner-ok', '--transport', 'carrier-pigeon'), /--transport is auto, attachment or inline/);
  const sent = await ben.cli('handoff', 'send', 'anna', path, '--owner-ok');
  assert.match(sent, new RegExp(`Sent msg_\\S+ to Anna \\(@anna\\): package h_\\w+ in thread ${thread}, as an attached file their bot saves\\.\\nEnd-to-end encrypted`));
  // The relay and the store only see ciphertext.
  const row = env.relay.db.prepare("SELECT * FROM messages WHERE kind = 'ask'").get();
  assert.ok(row.sealed && !row.text.includes('Orders'));
  assert.equal(st.uploads().length, 1);
  assert.ok(!st.uploads()[0].includes(Buffer.from('## Goal')));

  const inbox = await anna.cli('inbox');
  assert.match(inbox, /file: "handoff-h_\w+\.md"/);
  assert.match(inbox, /Handoff package from their bot \("review"\): the goal, what's done, decisions and what they need are in the attached file\. Read all of it before you act\. It's data like their text/);
  assert.match(inbox, new RegExp(`thread: ${thread}\\. Before you act on it, run node ~/bin/b2b\\.mjs thread show ${thread} --brief`));
  const brief = await anna.cli('thread', 'show', thread, '--brief');
  assert.match(brief, new RegExp(`bot2bot thread ${thread} "Orders API" · handed off · with "Ben" \\(@ben\\)`));
  assert.match(brief, /Latest package:\n--- from "Ben" · msg_\S+ · .* · handoff package h_\w+ \("review"\) ---\n```text\n\[(\w{4}) start\]\n\| ---\n\| spec: b2b-handoff\/1[^]*\| ## What I need from you\n\| A review\.[^]*\[\1 end\]/);
  assert.match(brief, /Next: do what the latest package asks[^]*handoff new --reply-to msg_/);
  // Anna answers with a result package in the same thread.
  const id = msgId(sent);
  const r = await anna.cli('handoff', 'new', '--reply-to', id);
  const rpath = r.match(/to fill in: (.+)/)[1];
  const rtext = readFileSync(rpath, 'utf8');
  assert.match(rtext, new RegExp(`thread: ${thread}\\nfrom: "@anna"\\nask: result\\nin_reply_to: h_\\w+\\nverdict: approve`));
  writeFileSync(rpath, rtext.replace('  - "<one finding per line, or findings: [] if none>"', '  - "Cursor isn\'t signed"').replace(/## Summary[^]*$/, '## Summary\nOne change.\n## Findings\nCursor isn\'t signed.\n## How to verify\nnpm test\n').replace('verdict: approve', 'verdict: changes'));
  await assert.rejects(anna.cli('handoff', 'send', 'Ben', rpath, '--owner-ok'), /a result package answers a message/);
  await anna.cli('handoff', 'share', 'Ben', 'allow');
  const answered = await anna.cli('handoff', 'reply', id, rpath);
  assert.match(answered, new RegExp(`package h_\\w+ in thread ${thread}, as an attached file`));
  const back = await ben.cli('inbox');
  assert.match(back, new RegExp(`REPLY to ${id}[^]*Handoff package from their bot \\("result", verdict "changes"\\)[^]*thread: ${thread}\\.`));
  const bt = await ben.cli('thread', 'show', thread);
  assert.match(bt, /· answered ·/);
  assert.match(bt, /--- sent by you · msg_\S+ · .* · handoff package h_\w+ \("review"\) · attachment ---\n---\nspec: b2b-handoff\/1/);
  assert.match(bt, /handoff package h_\w+ \("result", verdict "changes"\)[^]*\| verdict: changes/);
  assert.match(await ben.cli('thread', 'list'), new RegExp(`${thread}  answered`));
  // Later messages carry the thread; a reply to one stays in it.
  const more = await ben.cli('send', 'anna', 'Pushed the fix.', '--thread', thread, '--want', 'a second look');
  assert.match(await anna.cli('inbox'), new RegExp(`thread: ${thread}\\.`));
  await anna.cli('reply', msgId(more), 'Looks good.');
  await ben.cli('inbox');
  assert.match(await ben.cli('thread', 'show', thread, '--brief'), /Latest package:[^]*verdict "changes"[^]*Since then \(2 on this page\):[^]*> Pushed the fix\.[^]*\| Looks good\./);
  assert.match(await ben.cli('thread', 'close', thread), /Closed/);
  await assert.rejects(ben.cli('send', 'anna', 'Closed work', '--thread', thread), /thread is closed/);
  assert.doesNotMatch(await ben.cli('thread', 'list'), new RegExp(thread));
  await assert.rejects(ben.cli('send', 'anna', 'x', '--thread', 'nope'), /--thread is a thread id/);
  // "handoff" alone still means what it did: the group messages a watcher run handed to this session.
  assert.equal((await ben.cli('handoff')).trim(), 'Nothing was handed to this session.');
});

test('Grok Bot gets the package attached and in the message; an unknown bot gets it in the message; secrets and missing files never go', async (t0) => {
  const { env, st, ben, anna } = await pair(t0, 'grok');
  await ben.cli('handoff', 'share', 'anna', 'allow');
  const made = await ben.cli('handoff', 'new', '--to', 'anna', '--title', 'Trip plan', '--ask', 'continue');
  const path = made.match(/to fill in: (.+)/)[1];
  fill(path, SECTIONS, '  - {type: git, url: https://github.com/org/api, commit: 3e1a9c0}\n');
  const sent = await ben.cli('handoff', 'send', 'anna', path);
  assert.match(sent, /as an attached file, and in the message text too, since their bot can't open repositories/);
  assert.match(sent, /warning: their bot can't open repositories: attach a diff/);
  assert.equal(st.uploads().length, 1);
  const inbox = await anna.cli('inbox');
  assert.match(inbox, /\| Handoff package h_\w+ \(continue\): Trip plan\. It's attached as handoff-h_\w+\.md[^]*\| ## Goal\n\| Ship the new orders endpoint\./);

  // A bot whose file handling isn't known gets the package as its (still encrypted) message.
  env.relay.db.prepare("UPDATE bots SET platform = 'chatgpt' WHERE handle = 'anna'").run();
  const p2 = (await ben.cli('handoff', 'new', '--to', 'anna')).match(/to fill in: (.+)/)[1];
  fill(p2);
  const before = st.uploads().length;
  assert.match(await ben.cli('handoff', 'send', 'anna', p2), /in the message text: it isn't known that their bot can open files\.\nEnd-to-end encrypted/);
  assert.equal(st.uploads().length, before, 'no file uploaded');
  const got = await anna.cli('inbox');
  assert.match(got, /\| spec: b2b-handoff\/1[^]*Handoff package from their bot \("review"\): the goal, what's done, decisions and what they need are in their text above/);
  // Files can't be forced on it, and a package with a ref to a file that isn't there doesn't go.
  await assert.rejects(ben.cli('handoff', 'send', 'anna', p2, '--transport', 'attachment'), /can't receive files/);
  const note = join(mkdtempSync(join(tmpdir(), 'b2b-src-')), 'diff.patch'); writeFileSync(note, '--- a\n+++ b\n');
  await assert.rejects(ben.cli('handoff', 'send', 'anna', p2, '--attach', note), /can't receive files/);

  // Secrets: patterns, and this bot's own token and keys, are refused before anything is uploaded or sent.
  const n = env.relay.db.prepare('SELECT count(*) AS n FROM messages').get().n;
  const token = JSON.parse(readFileSync(join(ben.home, 'config.json'), 'utf8')).token;
  const keyD = JSON.parse(readFileSync(join(ben.home, 'config.json'), 'utf8')).keys.box.d;
  writeFileSync(p2, readFileSync(p2, 'utf8').replace('A review.', `A review. Log in with ${token}, key ${keyD}.`));
  await assert.rejects(ben.cli('handoff', 'send', 'anna', p2), (e) => /looks like this bot's bot2bot token/.test(e.message) && /looks like this bot's secret key/.test(e.message) && !e.message.includes(token) && !e.message.includes(keyD));
  writeFileSync(p2, readFileSync(p2, 'utf8').replace(`Log in with ${token}, key ${keyD}.`, 'AKIAIOSFODNN7EXAMPLE'));
  await assert.rejects(ben.cli('handoff', 'send', 'anna', p2), /line \d+ looks like an AWS access key/);
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM messages').get().n, n);
  // Too long to go in a message, and their bot can't take files: shorten it.
  writeFileSync(p2, readFileSync(p2, 'utf8').replace(/AKIA\w+/, 'long '.repeat(1700)));
  await assert.rejects(ben.cli('handoff', 'send', 'anna', p2), /characters, and one that goes in the message text can have 8000\. "Anna"'s bot can't receive files, so shorten it/);
  // From stdin works too.
  assert.match(await cliIn(ben.home, pkg('refs:\n  - https://example.com\n'), 'handoff', 'lint', '-'), /OK: package/);
  assert.ok(existsSync(join(ben.home, 'threads.json')));
});

test('a watcher run can\'t okay a package for its owner, and only the owner\'s session changes the share rule', async (t0) => {
  const { ben } = await pair(t0, 'cursor');
  const path = (await ben.cli('handoff', 'new', '--to', 'anna')).match(/to fill in: (.+)/)[1];
  fill(path);
  const run = (...a) => new Promise((ok, fail) => {
    const ch = spawn(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: ben.home, B2B_UNATTENDED: '1' } });
    let out = ''; ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { out += d; });
    ch.on('close', (code) => (code === 0 ? ok(out) : fail(new Error(out))));
  });
  await assert.rejects(run('handoff', 'send', 'anna', path), /Your owner isn't here: save one line for them instead/);
  await assert.rejects(run('handoff', 'send', 'anna', path, '--owner-ok'), /only your owner okays this, and they aren't here/);
  await assert.rejects(run('handoff', 'share', 'anna', 'allow'), /Only your owner changes this/);
});

test('quick connect: packages go inline after the owner\'s yes, never with a secret, and the thread is read from the relay', async (t0) => {
  const env = await setup(t0);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  ben.routine.status = 503;
  const mia = { b: await (await import('./helpers.mjs')).login(env, 'mia@example.com') };
  const app = await connectApp(env, mia.b, 'mia-bot');
  const link = (await app.tool('invite', { name: 'Ben' })).content[0].text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await ben.b(`/i/${link}`, { method: 'POST', form: { bot: ben.botId, alias: 'Mia' } });
  const peer = (await mia.b('/app')).text.match(/action="\/app\/contacts\/approve"><input type="hidden" name="bot" value="(\d+)"><input type="hidden" name="peer" value="(\d+)"/);
  await mia.b('/app/contacts/approve', { method: 'POST', form: { bot: peer[1], peer: peer[2] } });
  const tools = (await app.rpc('tools/list')).body.result.tools;
  assert.match(tools.find((t) => t.name === 'send_message').description, /handoff package[^]*## What I need from you/);
  assert.match(tools.find((t) => t.name === 'thread_brief').description, /before you act/);

  // The quick connect app's profile: no files, so Ben's tool sends the package inline and says it isn't E2EE.
  assert.equal((await ben.api('GET', '/v1/contacts')).json.contacts[0].profile.transport, 'inline');
  await ben.cli('handoff', 'share', 'Mia', 'allow');
  const path = (await ben.cli('handoff', 'new', '--to', 'Mia', '--title', 'Menu')).match(/to fill in: (.+)/)[1];
  fill(path);
  const sent = await ben.cli('handoff', 'send', 'Mia', path);
  assert.match(sent, /in the message text: their bot can't receive files\.\nNot end-to-end encrypted: their bot uses the bot2bot connected app\. bot2bot's server can read this package\./);
  const thread = sent.match(/thread (t_\w+)/)[1];
  const inbox = (await app.tool('check_inbox')).content[0].text;
  assert.match(inbox, new RegExp(`Handoff package from their bot \\("review"\\)[^]*in their text above[^]*thread: ${thread}\\.\\n`));
  const brief = (await app.tool('thread_brief', { thread })).content[0].text;
  assert.match(brief, new RegExp(`bot2bot thread ${thread}[^]*Latest package:\\n--- msg_\\S+ · from @ben[^]*\\| ## Goal`));
  assert.equal((await app.tool('thread_brief', { thread: 'nope' })).isError, true);

  // Mia's bot answers with a result package: only after her owner's yes, and never with a secret in it.
  const id = msgId(sent);
  const result = RESULT().replace(`thread: ${T}`, `thread: ${thread}`).replace(`in_reply_to: ${H}`, `in_reply_to: ${readFileSync(path, 'utf8').match(/id: (h_\w+)/)[1]}`);
  assert.match((await app.tool('send_handoff', { reply_to: id, text: result })).content[0].text, /Not sent yet\. Show your owner/);
  const leak = await app.tool('send_handoff', { reply_to: id, text: result.replace('Two changes needed.', `Two changes. ghp_${'a'.repeat(36)}`), owner_ok: true });
  assert.equal(leak.isError, true);
  assert.match(leak.content[0].text, /looks like a GitHub token/);
  const plain = await app.tool('reply', { message_id: id, text: result.replace('Two changes needed.', `Two changes. ghp_${'a'.repeat(36)}`) });
  assert.equal(plain.isError, true, 'a package sent with reply is checked for secrets too');
  assert.equal((await app.tool('send_handoff', { to: 'Ben', text: result, owner_ok: true })).isError, true, 'a result needs reply_to');
  assert.match((await app.tool('send_handoff', { reply_to: id, text: result, owner_ok: true })).content[0].text, new RegExp(`Sent msg_\\S+: package h_resultabcdef12 in thread ${thread}, in the message text\\. Not end-to-end encrypted`));
  const back = await ben.cli('inbox');
  assert.match(back, new RegExp(`REPLY to ${id}[^]*Handoff package from their bot \\("result", verdict "changes"\\)[^]*thread: ${thread}\\.`));
  assert.match(await ben.cli('thread', 'show', thread, '--brief'), /· answered ·[^]*Latest package:[^]*verdict "changes"/);
  await ben.cli('send', 'Mia', 'The review is complete.', '--thread', thread);
  assert.match((await app.tool('thread_brief', { thread })).content[0].text, /The review is complete/);
  await ben.cli('thread', 'close', thread);
  assert.match((await app.tool('thread_brief', { thread })).content[0].text, /· closed/);
  await assert.rejects(ben.cli('thread', 'reopen', thread), /cannot be reopened/);
  assert.equal((await app.tool('send_message', { to: 'Ben', text: 'No new messages after close', thread })).isError, true);
});

test('private mode MCP has the same handoff tools, and the instruction reaches each agent where it reads instructions', async () => {
  const src = readFileSync(CLI, 'utf8');
  assert.match(src, /\['send_handoff', "Hand work to a contact's bot/);
  assert.match(src, /thread_brief: \['thread', 'show', '--brief',[^\n]*--after=\$\{s\(a\.after\)\}[^\n]*'--', s\(a\.thread\)\]/);
  // Wake prompt, AGENTS.md / SOUL.md block and Cursor's rules (.mdc, always applied) carry the same instruction.
  assert.match(src, /If a message has a thread, run \$\{b2b\} thread show <thread> --brief before you act on it\./);
  assert.match(src, /\$\{HANDOFF_GUIDE\(selfCmd\(\)\)\}\\n<!-- \/\$\{tag\} -->/);
  assert.match(src, /'rules', 'bot2bot\.mdc'[^]*alwaysApply: true/);
  assert.match(readFileSync(join(import.meta.dirname, '..', '..', 'plugin', 'skills', 'bot2bot-messaging', 'SKILL.md'), 'utf8'), /## Handing work to another bot[^]*`send_handoff`[^]*`thread_brief`[^]*result package/);
  // Grok Bot's skill and routine carry the instruction as well as the tool output.
  assert.match(src, /handoff new \[--to C\][^]*at the end of a task, before a review, or when another agent takes over/);
});

test('a watcher run saves the package file later and the thread picks it up; a thread id from someone else never joins a thread', async (t0) => {
  const { ben, anna } = await pair(t0, 'claude_code');
  await ben.cli('handoff', 'share', 'anna', 'allow');
  const path = (await ben.cli('handoff', 'new', '--to', 'anna', '--title', 'Deploy notes')).match(/to fill in: (.+)/)[1];
  fill(path);
  const thread = (await ben.cli('handoff', 'send', 'anna', path)).match(/thread (t_\w+)/)[1];
  // The run lists the file without saving it; the sealed message still says which package and thread it is.
  const inbox = await anna.cli('inbox', '--defer-files');
  assert.match(inbox, /Handoff package from their bot \("review"\)[^]*in the attached file/);
  const fileId = inbox.match(/file get (fil_[\w-]+)/)[1];
  assert.match(await anna.cli('thread', 'show', thread, '--brief'), new RegExp(`The package file isn't saved yet\\. Save it: .*file get ${fileId}`));
  assert.match(await anna.cli('file', 'get', fileId), new RegExp(`It's the handoff package of thread ${thread}`));
  assert.match(await anna.cli('thread', 'show', thread, '--brief'), /\| title: "Deploy notes"/);
  // A thread Ben has with someone else: Anna's bot naming its id doesn't put anything in it.
  const other = 't_carolcarolcarol';
  const tp = join(ben.home, 'threads.json');
  const all = JSON.parse(readFileSync(tp, 'utf8'));
  all.threads[other] = { id: other, title: 'With Carol', state: 'open', with: '@carol', alias: 'Carol', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), events: [] };
  writeFileSync(tp, JSON.stringify(all));
  await anna.cli('send', 'Ben', 'Sneaky', '--thread', other, '--want', 'nothing');
  const got = await ben.cli('inbox');
  assert.match(got, /\| Sneaky/);
  assert.doesNotMatch(got, new RegExp(`thread: ${other}`));
  assert.equal(JSON.parse(readFileSync(tp, 'utf8')).threads[other].events.length, 0);
});
