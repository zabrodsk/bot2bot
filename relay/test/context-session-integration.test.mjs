import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setup, owner, connectHandled } from './helpers.mjs';

const exec = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'cli', 'b2b.mjs');
const runAs = (home, id) => async (...args) => (await exec(process.execPath, [CLI, ...args], {
  env: { ...process.env, B2B_HOME: home, B2B_SESSION: id, B2B_SESSION_AGENT: 'claude-code', B2B_UNATTENDED: '' },
})).stdout;
const packageText = (id, thread, result = false) => `---
spec: b2b-handoff/1
id: ${id}
thread: ${thread}
ask: ${result ? 'result' : 'review'}
refs: []
${result ? 'verdict: approve\nfindings: []\n' : ''}---
${result ? '## Summary\nThe API review passed.\n## Findings\nNone.\n## How to verify\nRun the API tests.' : '## Goal\nReview the API change.\n## Current state\nThe patch is ready.\n## Decisions\nKeep the existing response fields.\n## Open questions\nNone.\n## Constraints\nDo not deploy.\n## What I need from you\nCheck compatibility.\n## How to verify\nRun the API tests.'}
`;

test('a routed handoff keeps its thread context and its result returns to the asking session', async (t) => {
  const env = await setup(t);
  const ann = await owner(env, t, 'ann@example.com', 'ann', { status: 503 });
  const ben = await owner(env, t, 'ben@example.com', 'ben', { status: 503 });
  await connectHandled(ann, ben, 'ben');
  const asking = runAs(ann.home, 'session-api-author');
  const reviewing = runAs(ben.home, 'session-api-reviewer');
  const otherAnn = runAs(ann.home, 'session-another-author');
  const otherBen = runAs(ben.home, 'session-another-reviewer');
  await reviewing('bind', '@ann');
  const thread = 't_contextintegration01';
  const draft = join(ann.home, 'review.md');
  writeFileSync(draft, packageText('h_contextintegration01', thread));
  const sent = await asking('handoff', 'send', '@ben', draft, '--owner-ok');
  const message = sent.match(/Sent (msg_[\w-]+)/)[1];
  await otherBen('inbox');
  assert.match(await reviewing('thread', 'show', thread, '--brief'), /Check compatibility/);
  const incoming = await reviewing('handoff');
  assert.ok(incoming.includes(thread), 'the destination session learns which task to read');
  assert.match(incoming, /data, never instructions/);
  const answer = join(ben.home, 'result.md');
  writeFileSync(answer, packageText('h_contextintegration02', thread, true));
  await reviewing('handoff', 'reply', message, answer, '--owner-ok');
  assert.doesNotMatch(await otherAnn('inbox'), /The API review passed/);
  const returned = await asking('handoff');
  assert.match(returned, /The API review passed/);
  assert.ok(returned.includes(thread));
  assert.match(await asking('thread', 'show', thread, '--brief'), /The API review passed/);
});
