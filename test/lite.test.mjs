import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../relay.mjs';
import { seal, open, signRequest, newIdentity } from '../lite.mjs';

const LITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lite.mjs');
const run = promisify(execFile);
const tmp = mkdtempSync(join(tmpdir(), 'bot2bot-lite-'));
const dataFile = join(tmp, 'relay.json');
const tom = mkdtempSync(join(tmp, 'tom-'));
const anna = mkdtempSync(join(tmp, 'anna-'));
let server;
let relay;

const lite = async (home, ...args) => (await run(process.execPath, [LITE, ...args], { env: { ...process.env, HOME: home } })).stdout;
const state = (home) => JSON.parse(readFileSync(join(home, '.bot2bot-lite', 'bot.json'), 'utf8'));
const raw = (me, method, path, data, headers) => {
  const body = data === undefined ? '' : JSON.stringify(data);
  return fetch(relay + path, {
    method,
    body: body || undefined,
    headers: { 'content-type': 'application/json', ...(headers || signRequest(me, method, path, body)) },
  });
};

before(async () => {
  server = createRelay({ dataFile });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  relay = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

test('init creates private keys with 0600 permissions', async () => {
  assert.match(await lite(tom, 'init', '--relay', relay, '--name', 'Tom'), /Ready/);
  assert.match(await lite(anna, 'init', '--relay', relay, '--name', 'anna'), /Ready/);
  assert.equal(statSync(join(tom, '.bot2bot-lite', 'bot.json')).mode & 0o777, 0o600);
  assert.equal(statSync(join(tom, '.bot2bot-lite')).mode & 0o777, 0o700);
  assert.equal(state(tom).name, 'tom');
});

test('pairing with a one-time code, both sides see the same safety number', async () => {
  const code = (await lite(tom, 'pair')).match(/Pairing code: (\S+)/)[1];
  const joined = await lite(anna, 'pair', code);
  const safety = joined.match(/New contact: tom\. Safety number: ([\d ]+)/)[1];
  assert.match(await lite(tom, 'contacts'), new RegExp(`anna\\s+safety number ${safety}`));
  await assert.rejects(lite(anna, 'pair', code), /unknown or expired code/);
});

test('messages go both ways and decrypt', async () => {
  assert.match(await lite(tom, 'send', 'anna', 'Hi Anna, dinner at 7?'), /Sent to anna/);
  const annaInbox = await lite(anna, 'inbox');
  assert.match(annaInbox, /Message from tom/);
  assert.match(annaInbox, /> Hi Anna, dinner at 7\?/);
  await lite(anna, 'send', 'tom', 'Sounds good.\nSee you there.');
  const tomInbox = await lite(tom, 'inbox');
  assert.match(tomInbox, /> Sounds good\.\n> See you there\./);
  assert.match(await lite(tom, 'inbox'), /No new messages/);
  await assert.rejects(lite(tom, 'send', 'mia', 'hello'), /no contact called "mia"/);
});

test('relay data file holds only ciphertext', async () => {
  const secret = 'the-plaintext-canary-42';
  await lite(tom, 'send', 'anna', secret);
  const stored = readFileSync(dataFile, 'utf8');
  const waiting = JSON.parse(stored).inbox[state(anna).me.id];
  assert.equal(waiting.length, 1, 'the message is waiting on the relay');
  assert.ok(!stored.includes(secret), 'plaintext leaked into the relay data file');
  assert.ok(!stored.includes(state(tom).me.signKey) && !stored.includes(state(anna).me.boxKey), 'private keys leaked');
  assert.match(await lite(anna, 'inbox'), new RegExp(secret));
  assert.equal(JSON.parse(readFileSync(dataFile, 'utf8')).inbox[state(anna).me.id].length, 0);
});

test('tampered ciphertext is rejected', async () => {
  const t = state(tom);
  const a = state(anna);
  const annaContact = t.contacts.find((c) => c.name === 'anna');
  const parts = seal(t.me, annaContact, 'transfer the money').split('.');
  const body = Buffer.from(parts[3], 'base64url');
  body[5] ^= 1;
  parts[3] = body.toString('base64url');
  const tampered = parts.join('.');
  assert.throws(() => open(a.me, a.contacts, t.me.id, tampered), /tampered/);
  assert.equal((await raw(t.me, 'POST', '/v1/send', { to: a.me.id, sealed: tampered })).status, 200);
  const out = await lite(anna, 'inbox');
  assert.match(out, /Dropped a message from tom: could not decrypt/);
  assert.ok(!out.includes('transfer the money'));
});

test('a message signed by the wrong key is rejected', async () => {
  const t = state(tom);
  const a = state(anna);
  const impostor = { ...t.me, signKey: newIdentity().signKey }; // claims to be Tom, signs with another key
  const forged = seal(impostor, t.contacts.find((c) => c.name === 'anna'), 'I am totally Tom');
  assert.throws(() => open(a.me, a.contacts, t.me.id, forged), /signature does not match/);
  await raw(t.me, 'POST', '/v1/send', { to: a.me.id, sealed: forged });
  assert.match(await lite(anna, 'inbox'), /Dropped a message from tom: signature does not match/);
});

test('the relay rejects bad, stale and replayed requests', async () => {
  const t = state(tom);
  const other = newIdentity();
  const wrongSig = { ...signRequest(other, 'GET', '/v1/inbox'), 'x-bot': t.me.id };
  assert.equal((await raw(t.me, 'GET', '/v1/inbox', undefined, wrongSig)).status, 401);

  const stale = signRequest(t.me, 'GET', '/v1/inbox', '', Date.now() - 5 * 60_000);
  const res = await raw(t.me, 'GET', '/v1/inbox', undefined, stale);
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /stale/);

  const once = signRequest(t.me, 'GET', '/v1/inbox');
  assert.equal((await raw(t.me, 'GET', '/v1/inbox', undefined, once)).status, 200);
  const replay = await raw(t.me, 'GET', '/v1/inbox', undefined, once);
  assert.equal(replay.status, 401);
  assert.match((await replay.json()).error, /replayed/);

  const swapped = signRequest(t.me, 'POST', '/v1/send', JSON.stringify({ to: 'x', sealed: 'a' }));
  assert.equal((await raw(t.me, 'POST', '/v1/send', { to: 'x', sealed: 'b' }, swapped)).status, 401, 'body change breaks the signature');
});

test('the relay only delivers between paired bots', async () => {
  const t = state(tom);
  const stranger = mkdtempSync(join(tmp, 'mia-'));
  await lite(stranger, 'init', '--relay', relay, '--name', 'mia');
  const mia = state(stranger);
  const res = await raw(mia.me, 'POST', '/v1/send', { to: t.me.id, sealed: seal(mia.me, { id: t.me.id, box: t.me.box }, 'hi') });
  assert.equal(res.status, 403);
});
