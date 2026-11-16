import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, owner, connect } from './helpers.mjs';
const execute = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'cli', 'b2b.mjs');
const read = (home) => JSON.parse(readFileSync(join(home, 'threads.json'), 'utf8')).threads;
const local = (home, ...args) => execute(process.execPath, [CLI, ...args], { env: { ...process.env, B2B_HOME: home } });
const now = () => new Date().toISOString();
const thread = (id, extra = {}) => ({ id, state: 'open', created_at: now(), updated_at: now(), events: [], ...extra });

test('concurrent local thread changes keep all active threads and histories beyond the old count limits', async () => {
  const home = mkdtempSync(join(tmpdir(), 'b2b-thread-store-'));
  const threads = Object.fromEntries(Array.from({ length: 220 }, (_, i) => {
    const id = `t_active${String(i).padStart(8, '0')}`;
    return [id, thread(id)];
  }));
  threads.t_active00000000.events = Array.from({ length: 130 }, (_, i) => ({ dir: 'out', msg: `msg_history${String(i).padStart(8, '0')}`, at: now(), text: `Message ${i}` }));
  writeFileSync(join(home, 'threads.json'), JSON.stringify({ threads }));
  await Promise.all(Array.from({ length: 20 }, (_, i) => local(home, 'thread', 'new', `Concurrent task ${i}`)));
  await local(home, 'thread', 'close', 't_active00000000');
  let saved = read(home);
  assert.equal(Object.keys(saved).length, 240);
  assert.equal(saved.t_active00000000.events.length, 130);
  assert.equal(new Set(Object.values(saved).map((t) => t.title).filter(Boolean)).size, 20);
  assert.equal(saved.t_active00000000.state, 'closed');
  await Promise.all([local(home, 'thread', 'reopen', 't_active00000000'), ...Array.from({ length: 8 }, () => local(home, 'thread', 'list', '--all'))]);
  saved = read(home);
  assert.equal(saved.t_active00000000.state, 'open');
  assert.equal(saved.t_active00000000.events.length, 130);
});

const packageText = (body) => `---\nspec: b2b-handoff/1\nid: h_samepackage001\nthread: t_samepackage001\nfrom: "@ann"\nask: review\nrefs:\n  - https://example.com/review\n---\n## Goal\nReview the API.\n## Current state\n${body}\n## Decisions\nUse a cursor.\n## Open questions\nNone.\n## Constraints\nNo schema changes.\n## What I need from you\nReview the code.\n## How to verify\nRun tests.\n`;

test('reusing a package id keeps immutable copies; expiry removes only unreferenced managed copies', async (t) => {
  const env = await setup(t);
  const ann = await owner(env, t, 'ann@example.com', 'ann', { status: 503 });
  const ben = await owner(env, t, 'ben@example.com', 'ben', { status: 503 });
  await connect(ann, ben, 'Ann');
  const source = join(ann.home, 'my-original-package.md');
  const first = packageText('First version.'), second = packageText('Second version.');
  writeFileSync(source, first);
  await ann.cli('handoff', 'send', '@ben', source, '--owner-ok', '--transport', 'inline');
  const one = read(ann.home).t_samepackage001.events.at(-1).path;
  writeFileSync(source, second);
  await ann.cli('handoff', 'send', '@ben', source, '--owner-ok', '--transport', 'inline');
  const two = read(ann.home).t_samepackage001.events.at(-1).path;
  assert.notEqual(one, two);
  assert.match(one, /\.out\.[a-f0-9]{64}\.md$/);
  assert.equal(readFileSync(one, 'utf8'), first);
  assert.equal(readFileSync(two, 'utf8'), second);
  const history = await ann.cli('thread', 'show', 't_samepackage001');
  assert.match(history, /First version\.[^]*Second version\./);
  const busy = read(ann.home);
  busy.t_samepackage001.events.push(...Array.from({ length: 110 }, (_, i) => ({ dir: 'out', msg: `msg_followup${String(i).padStart(8, '0')}`, at: now(), text: `Follow-up ${i}` })));
  writeFileSync(join(ann.home, 'threads.json'), JSON.stringify({ threads: busy }));
  await ann.cli('send', '@ben', 'Newest follow-up', '--thread', 't_samepackage001');
  assert.equal(read(ann.home).t_samepackage001.events.length, 113);
  let brief = await ann.cli('thread', 'show', 't_samepackage001', '--brief');
  assert.match(brief, /Second version\.[^]*Follow-up 0/);
  assert.doesNotMatch(brief, /Newest follow-up/);
  let pages = 1;
  while (brief.includes('More messages remain:')) {
    const after = brief.match(/--after (msg_[\w-]+)/)[1];
    brief = await ann.cli('thread', 'show', 't_samepackage001', '--brief', '--after', after);
    assert.ok(++pages <= 6, 'pagination advances through the history');
  }
  assert.match(brief, /Second version\.[^]*Newest follow-up/);
  assert.equal(pages, 6);

  // A second active thread still references the first copy. The expired thread also has an original path;
  // retention may remove tool-owned snapshots only, even if another path was recorded in its history.
  const saved = read(ann.home);
  const old = new Date(Date.now() - 31 * 86_400_000).toISOString();
  saved.t_samepackage001.updated_at = old;
  saved.t_samepackage001.events.push({ path: source });
  saved.t_stillactive001 = thread('t_stillactive001', { events: [{ path: one }] });
  writeFileSync(join(ann.home, 'threads.json'), JSON.stringify({ threads: saved }));
  await Promise.all(Array.from({ length: 6 }, () => ann.cli('thread', 'list', '--all')));
  assert.equal(read(ann.home).t_samepackage001, undefined, 'expiry is saved, not just hidden from output');
  assert.ok(existsSync(one), 'a retained thread still needs this copy');
  assert.equal(existsSync(two), false);
  assert.equal(readFileSync(source, 'utf8'), second, 'the original remains untouched');
  const remaining = read(ann.home);
  remaining.t_stillactive001.updated_at = old;
  writeFileSync(join(ann.home, 'threads.json'), JSON.stringify({ threads: remaining }));
  await ann.cli('thread', 'list');
  assert.equal(existsSync(one), false);
  assert.ok(existsSync(source));
});

test('concurrent share-rule changes preserve each contact rule', async (t) => {
  const env = await setup(t);
  const ann = await owner(env, t, 'ann@example.com', 'ann', { status: 503 });
  const ben = await owner(env, t, 'ben@example.com', 'ben', { status: 503 });
  const cara = await owner(env, t, 'cara@example.com', 'cara', { status: 503 });
  await connect(ann, ben, 'Ann'); await connect(ann, cara, 'Ann');
  await Promise.all(Array.from({ length: 12 }, (_, i) => ann.cli('handoff', 'share', i % 2 ? '@ben' : '@cara', 'allow')));
  assert.deepEqual(JSON.parse(readFileSync(join(ann.home, 'handoff-rules.json'), 'utf8')).share, { '@ben': 'allow', '@cara': 'allow' });
});
