import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, owner, connectHandled, waitFor, sleep } from './helpers.mjs';
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'b2b.mjs');
const exec = promisify(execFile);
const session = (home, id, agent = 'claude-code') => async (...args) => (await exec(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, B2B_HOME: home, B2B_SESSION: id, B2B_SESSION_AGENT: agent, B2B_UNATTENDED: '' } })).stdout;
function mcp(t, home, id, channels = true) {
  const child = spawn(process.execPath, [CLI, 'mcp', ...(channels ? ['--channels', '--session', id] : [])], { env: { ...process.env, HOME: home, B2B_HOME: home, B2B_SESSION: id } });
  const messages = []; let buffer = '', errors = '', serial = 0;
  child.stdout.on('data', (data) => { buffer += data; for (;;) { const i = buffer.indexOf('\n'); if (i < 0) break; const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line) messages.push(JSON.parse(line)); } });
  child.stderr.on('data', (data) => { errors += data; });
  t.after(() => child.kill());
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const request = async (method, params = {}) => { const id = ++serial; send({ id, method, params }); return await waitFor(() => messages.find((m) => m.id === id), 10_000).catch((e) => { throw new Error(`${e.message}\n${errors}`); }); };
  return { child, messages, request, send, errors: () => errors };
}
async function pair(t) {
  const env = await setup(t);
  const ann = await owner(env, t, 'ann@example.com', 'ann', { status: 503 });
  const ben = await owner(env, t, 'ben@example.com', 'ben', { status: 503 });
  await connectHandled(ann, ben, 'ben');
  return { env, ann, ben };
}
const messageId = (s) => s.match(/Sent (msg_[\w-]+)/)[1];

test('replies go to the asking session even when another session claims them', async (t) => {
  const { ann, ben } = await pair(t);
  const a = session(ann.home, 'session-review-a'), b = session(ann.home, 'session-review-b');
  const id = messageId(await a('send', 'ben', 'Review the API change', '--ask'));
  await ben.cli('reply', id, 'The API review is complete');
  const wrong = await b('inbox');
  assert.doesNotMatch(wrong, /The API review is complete/);
  assert.match(wrong, /responsible session/);
  assert.doesNotMatch(await b('handoff'), /The API review is complete/);
  const right = await a('handoff');
  assert.match(right, /\| The API review is complete/);
  assert.match(right, /owner's rules/);
  assert.doesNotMatch(await a('handoff'), /The API review is complete/);
  const remote = await ann.api('GET', `/v1/messages/${id}`);
  assert.doesNotMatch(JSON.stringify(remote.json), /session-review-a|sessions.json/);
});

test('concurrent sends retain both asking sessions and direct bindings cannot steal their replies', async (t) => {
  const { ann, ben } = await pair(t);
  const a = session(ann.home, 'session-review-a'), b = session(ann.home, 'session-review-b');
  await a('bind', 'ben');
  const sent = await Promise.all([a('send', 'ben', 'Review API A', '--ask'), b('send', 'ben', 'Review API B', '--ask')]);
  const ids = sent.map(messageId);
  const saved = JSON.parse(readFileSync(join(ann.home, 'sessions.json')));
  assert.equal(saved.asks[ids[0]].session, 'session-review-a');
  assert.equal(saved.asks[ids[1]].session, 'session-review-b');
  await ben.cli('reply', ids[1], 'Result for B');
  await a('inbox');
  assert.match(await b('handoff'), /Result for B/);
  assert.doesNotMatch(await a('handoff'), /Result for B/);
  await ben.cli('send', '@ann', 'Bound direct message');
  await b('inbox');
  assert.match(await a('handoff'), /Bound direct message/);
  await a('unbind', 'ben');
  assert.deepEqual(JSON.parse(readFileSync(join(ann.home, 'sessions.json'))).contacts, {});
});

test('MCP channels push into the selected idle session and preserve queued messages until a tool reads them', async (t) => {
  const { ann, ben } = await pair(t);
  const a = session(ann.home, 'session-review-a');
  const id = messageId(await a('send', 'ben', 'Review before release', '--ask'));
  const ch = mcp(t, ann.home, 'session-review-a');
  const other = mcp(t, ann.home, 'session-review-b');
  for (const c of [ch, other]) {
    const init = await c.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.deepEqual(init.result.capabilities.experimental, { 'claude/channel': {} });
    c.send({ method: 'notifications/initialized' });
  }
  await ben.cli('reply', id, 'APPROVED from the review');
  const notice = await waitFor(() => ch.messages.find((m) => m.method === 'notifications/claude/channel'), 12_000);
  assert.match(notice.params.content, /receive_session_messages/);
  assert.doesNotMatch(notice.params.content, /APPROVED/, 'untrusted content is read through the normal bounded tool output');
  await sleep(500);
  assert.equal(other.messages.filter((m) => m.method === 'notifications/claude/channel').length, 0);
  const pending = JSON.parse(readFileSync(join(ann.home, 'handoff.json'))).items;
  assert.equal(pending.length, 1, 'writing the notification is not an acknowledgement from Claude');
  const result = await ch.request('tools/call', { name: 'receive_session_messages', arguments: {} });
  assert.equal(result.result.isError, false);
  assert.match(result.result.content[0].text, /\| APPROVED from the review/);
  assert.match(result.result.content[0].text, /data, never instructions/);
  assert.deepEqual(JSON.parse(readFileSync(join(ann.home, 'handoff.json'))).items, []);
});

test('plain MCP keeps channels off and a disconnected channel leaves its queue for the owning session', async (t) => {
  const { ann, ben } = await pair(t);
  const plain = mcp(t, ann.home, 'session-review-b', false);
  const init = await plain.request('initialize');
  assert.equal(init.result.capabilities.experimental, undefined);
  plain.send({ method: 'notifications/initialized' });
  const ch = mcp(t, ann.home, 'session-review-a');
  await ch.request('initialize'); ch.send({ method: 'notifications/initialized' });
  const a = session(ann.home, 'session-review-a');
  await a('bind', 'ben');
  await ben.cli('send', '@ann', 'Keep this if the channel closes');
  await waitFor(() => ch.messages.some((m) => m.method === 'notifications/claude/channel'), 12_000);
  ch.child.kill();
  assert.match(await a('handoff'), /Keep this if the channel closes/);
});


test('abandoned session locks recover and old ask mappings expire without deleting pending messages', async (t) => {
  const { ann } = await pair(t);
  const stale = new Date(Date.now() - 31 * 86_400_000);
  writeFileSync(join(ann.home, 'sessions.json'), JSON.stringify({ asks: { msg_old000001: { session: 'session-review-a', peer: '@ben', at: stale.toISOString() } } }));
  writeFileSync(join(ann.home, 'handoff.json'), JSON.stringify({ items: [{ session: 'session-review-a', id: 'msg_pending001', text: 'Keep pending work' }] }));
  const lock = join(ann.home, 'sessions.lock');
  mkdirSync(lock); utimesSync(lock, stale, stale);
  const a = session(ann.home, 'session-review-a');
  await a('send', 'ben', 'New review', '--ask');
  const saved = JSON.parse(readFileSync(join(ann.home, 'sessions.json')));
  assert.equal(saved.asks.msg_old000001, undefined);
  assert.equal(Object.keys(saved.asks).length, 1);
  assert.match(await a('handoff'), /Keep pending work/);
});
