// The Tab alpha on the hosted relay: only owners on the list start a bill; anyone in their groups picks and pays back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, owner, connect } from './helpers.mjs';

const ADMIN = 'admin-token-for-tests-123456';

test('Tab alpha: only listed and Infinite owners start a bill, others still pick on it', async t => {
  const env = await setup(t, { hosted: true, tabOpen: false, limits: { groupPostsPer10Min: 100 } });
  const anna = await owner(env, t, 'anna@example.com', 'anna', { status: 503 });
  const tom = await owner(env, t, 'tom@example.com', 'tom', { status: 503 });
  await connect(anna, tom, 'Anna');
  const g = (await anna.cli('group', 'new', 'Trip', 'tom')).match(/number (\d+)/)[1];
  env.relay.groups.join(env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(tom.botId)), Number(g), { byOwner: true });
  await anna.cli('inbox'); await tom.cli('inbox');

  await assert.rejects(anna.cli('tab', 'add', g, '--amount=20', '--what=Dinner', '--currency=EUR'), /early testing/);
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM group_posts WHERE kind = 'tab_bill'").get().n, 0);

  const admin = (body) => fetch(`${env.url}/admin/tab-alpha`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await admin({ email: 'nobody@example.com' })).status, 404);
  assert.deepEqual(await (await admin({ email: 'anna@example.com' })).json(), { ok: true, tab_alpha: true });

  const bill = JSON.parse(await anna.cli('tab', 'add', g, '--amount=20', '--what=Dinner', '--currency=EUR')).id;
  await tom.cli('inbox');
  await tom.cli('tab', 'pick', g, bill, '--items', '1');
  await anna.cli('inbox');
  await anna.cli('tab', 'close', g, bill);
  const state = JSON.parse(await anna.cli('tab', g));
  assert.equal(state.bills[0].status, 'closed');
  assert.equal(state.bills[0].shares['@tom'], 2000);

  // Tom isn't on the list: he can answer bills, not start one.
  await assert.rejects(tom.cli('tab', 'add', g, '--amount=5', '--what=Coffee', '--currency=EUR'), /early testing/);
  assert.deepEqual(await (await admin({ email: 'anna@example.com', off: true })).json(), { ok: true, tab_alpha: false });
  await assert.rejects(anna.cli('tab', 'add', g, '--amount=5', '--what=Coffee', '--currency=EUR'), /early testing/);

  // Infinite (unlimited) owners are in the alpha without being on the list.
  const infinite = (body) => fetch(`${env.url}/admin/infinite`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await infinite({ email: 'tom@example.com' })).status, 200);
  assert.ok(JSON.parse(await tom.cli('tab', 'add', g, '--amount=5', '--what=Coffee', '--currency=EUR')).id);
});

test('Tab alpha: a self-hosted relay and TAB_OPEN have no list', async t => {
  for (const opts of [{ hosted: false, tabOpen: false }, { hosted: true, tabOpen: true }]) {
    const env = await setup(t, { ...opts, limits: { groupPostsPer10Min: 100 } });
    const anna = await owner(env, t, 'anna@example.com', 'anna', { status: 503 });
    const tom = await owner(env, t, 'tom@example.com', 'tom', { status: 503 });
    await connect(anna, tom, 'Anna');
    const g = (await anna.cli('group', 'new', 'Trip', 'tom')).match(/number (\d+)/)[1];
    env.relay.groups.join(env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(tom.botId)), Number(g), { byOwner: true });
    await anna.cli('inbox'); await tom.cli('inbox');
    assert.ok(JSON.parse(await anna.cli('tab', 'add', g, '--amount=20', '--what=Dinner', '--currency=EUR')).id);
  }
});
