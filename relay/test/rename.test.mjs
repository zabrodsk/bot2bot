// Renaming a bot (admin): its keys stay, its own tool takes the new name, its contacts' tools move their pin,
// and messages sealed to or from the old name still open. No new-key warnings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setup, owner, connect, waitFor, msgId, ADMIN } from './helpers.mjs';

const rename = (env, body) => fetch(`${env.url}/admin/rename`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('renaming a bot keeps end-to-end encryption working both ways, with no new-key warning', async (t0) => {
  const env = await setup(t0);
  const karel = await owner(env, t0, 'karel@example.com', 'karel');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  await connect(karel, anna, 'Uncle');
  // Both pin each other's keys.
  const first = await karel.cli('send', 'Anna', 'Hi from Karel');
  assert.match(first, /Sent msg_/, first);
  await waitFor(async () => /passed_on/.test(await karel.cli('status', msgId(first))));
  const hi = msgId(await anna.cli('send', 'Uncle', 'Hi back'));
  await waitFor(async () => /passed_on/.test(await anna.cli('status', hi)));

  // Pause Karel so Anna's next message waits, sealed to the old name.
  await karel.b('/app/pause', { method: 'POST', form: { on: '1' } });
  const queued = msgId(await anna.cli('send', 'Uncle', 'Sent before the rename'));

  // Checks: taken, bad name, unknown bot.
  assert.equal((await rename(env, { from: 'karel', to: 'anna' })).status, 409);
  assert.equal((await rename(env, { from: 'karel', to: 'X!' })).status, 400);
  assert.equal((await rename(env, { from: 'nobody', to: 'marek' })).status, 404);
  const r = await rename(env, { from: '@karel', to: 'marek' });
  assert.equal(r.status, 200, await r.clone().text());

  // Karel's bot reads the queued message (sealed to @karel) and takes its new name.
  await karel.b('/app/pause', { method: 'POST', form: { on: '0' } });
  await waitFor(async () => /passed_on/.test(await anna.cli('status', queued)));
  assert.equal(JSON.parse(readFileSync(join(karel.home, 'config.json'), 'utf8')).handle, 'marek');
  assert.match(await karel.cli('received'), /Sent before the rename/);
  assert.match(await karel.cli('whoami'), /@marek/);

  // Karel writes as @marek: Anna's tool moves the pin, no warning, still encrypted.
  const out = await karel.cli('send', 'Anna', 'Now I am Marek');
  assert.match(out, /End-to-end encrypted/);
  await waitFor(async () => /passed_on/.test(await karel.cli('status', msgId(out))));
  const got = await anna.cli('received');
  assert.match(got, /Now I am Marek/);
  assert.doesNotMatch(got, /NEW security key|set aside/);
  const peers = JSON.parse(readFileSync(join(anna.home, 'peers.json'), 'utf8'));
  assert.ok(peers['@marek'] && !peers['@karel']);
  assert.deepEqual(peers['@marek'].was, ['@karel']);

  // And Anna writes to @marek.
  const back = await anna.cli('send', 'Uncle', 'Hi Marek');
  assert.match(back, /End-to-end encrypted/);
  await waitFor(async () => /passed_on/.test(await anna.cli('status', msgId(back))));
  assert.match(await karel.cli('received'), /Hi Marek/);
});

test('a rename waits until the bot and its contacts run a tool that understands it', async (t0) => {
  const env = await setup(t0);
  const karel = await owner(env, t0, 'karel2@example.com', 'karel2');
  const anna = await owner(env, t0, 'anna2@example.com', 'anna2');
  await connect(karel, anna, 'Uncle');
  await anna.cli('whoami');
  env.relay.db.prepare("UPDATE bots SET tool_version = '0.19.0' WHERE handle = 'anna2'").run();
  const r = await rename(env, { from: 'karel2', to: 'marek2' });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /@anna2 \(0\.19\.0\)/);
});
