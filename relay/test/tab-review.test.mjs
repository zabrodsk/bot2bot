// Unit cases use the production fold. The integration cases use real CLI homes on a loopback relay.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { webcrypto } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setup, owner, connect, cliHome, waitFor } from './helpers.mjs';
import { phoneOf } from './tab-phone-helper.mjs';

const dir = mkdtempSync(join(tmpdir(), 'tab-review-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'fixture.mjs');
const source = readFileSync(new URL('../cli/b2b.mjs', import.meta.url), 'utf8');
writeFileSync(file, source.replace("  case 'version':", `  case 'review-expire': {
    const now = Date.now() + 86401000;
    const Clock = Date;
    globalThis.Date = class extends Clock {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
    await tabCloseDue(loadCfg(), new Map());
    break;
  }
  case 'review-card': {
    const cfg = loadCfg();
    const group = await api('GET', gpath(pos[0]), null, cfg);
    await tabAnswer(cfg, group, tabLoad(group.id).find(e => e.id === pos[1]));
    break;
  }
  case 'review-event': {
    const cfg = loadCfg();
    if (pos[1] === 'unlisted') cfg.keys.sign = pair('ed25519');
    const { group, at, ...fields } = JSON.parse(readFileSync(pos[0]));
    globalThis.Date = class extends Date {
      constructor(...args) { super(...(args.length ? args : [at])); }
    };
    console.log(JSON.stringify({ event: tabSign(cfg, group, fields), key: cfg.keys.sign.x }));
    break;
  }
  case 'version':`) + '\nexport { tabFold, tabSort, tabCardBill };\n');
const argv = process.argv;
process.argv = [process.execPath, file, 'version'];
const { tabFold, tabSort, tabCardBill } = await import(pathToFileURL(file));
process.argv = argv;

const day = 86400000;
const start = Date.parse('2026-01-01T00:00:00Z');
const time = delta => new Date(start + delta).toISOString();
const anna = '@anna', tom = '@tom';
const item = (price, n = 1) => ({ n, qty: 1, name: 'Tea', price });
const bill = (price = 100) => ({
  type: 'bill', id: 'bill', author: anna, payer: anna, at: time(0), date: '2026-01-01',
  currency: 'EUR', base: 'EUR', rate: 1, place: 'Cafe', people: [anna, tom], total: price, items: [item(price)],
});
const event = (type, delta, fields = {}) => ({ type, id: type + delta, author: anna, bill: 'bill', at: time(delta), ...fields });
const fold = (events, now = start + 10000) => tabFold([...events].sort(tabSort), anna, new Set(), now);

test('settled balance stays zero through a currency change', () => {
  const events = [bill(), event('close', 1), event('paid', 2, { author: tom, to: anna, amount: 50, currency: 'EUR' }),
    event('got', 3, { paid: 'paid2' })];
  assert.deepEqual(fold(events).balances, { [anna]: 0, [tom]: 0 });
  events.push(event('currency', 4, { from: 'EUR', currency: 'GBP', rate: 0.85 }));
  assert.deepEqual(fold(events).balances, { [anna]: 0, [tom]: 0 });
});

test('renaming a same-currency receipt preserves its effective rate', () => {
  const events = [{ ...bill(), rate: 25 }, event('close', 1)];
  const before = fold(events);
  // tab fix carries the previous fields along when the owner edits the place.
  events.push(event('fix', 2, { place: 'Cafe Roma', currency: 'EUR', rate: 25 }));
  assert.deepEqual(fold(events).balances, before.balances);
});

test('identical history has identical balances across the close deadline', () => {
  const events = [bill()];
  assert.deepEqual(fold(events, start + day - 1).balances, fold(events, start + day + 1).balances);
});

test('a receipt answer survives a one-second difference between member clocks', () => {
  const events = [bill(), event('pick', -1000, { author: tom, absent: true }), event('close', 2000)];
  assert.equal(fold(events).bills[0].shares[tom], 0);
});

test('the plan takes three transfers when three settle all five members', () => {
  const events = [];
  for (const [index, [payer, debtor, debt]] of [[anna, '@mia', 7], [anna, '@tim', 5], ['@liz', tom, 8]].entries()) {
    const id = 'bill' + index;
    events.push({ ...bill(debt * 2), id, payer, author: payer, people: [payer, debtor] },
      event('close', index + 1, { author: payer, bill: id }));
  }
  assert.equal(fold(events).plan.length, 3);
});

test('the phone card includes every valid receipt line and quantity', () => {
  const items = Array.from({ length: 101 }, (_, i) => item(1, i + 1));
  const receipt = { ...bill(101), items };
  assert.deepEqual(tabCardBill({ handle: 'tom' }, 1, receipt).items, items);
  items[0].qty = 100;
  assert.equal(tabCardBill({ handle: 'tom' }, 1, { ...receipt, total: 200 }).items[0].qty, 100);
});

async function trip(t) {
  const env = await setup(t, { autoTick: false, limits: { groupPostsPer10Min: 100, groupReinviteMs: 0, watchHoldMs: 250 } });
  const people = [];
  for (const name of ['anna', 'tom', 'mia']) {
    const bot = await owner(env, t, name + '@example.test', name, { status: 503 });
    t.after(() => rmSync(bot.home, { recursive: true, force: true }));
    people.push(bot);
  }
  const [payer, member, other] = people;
  await connect(payer, member, 'Anna');
  await connect(payer, other, 'Anna');
  const gid = (await payer.cli('group', 'new', 'Trip', 'tom', 'mia')).match(/number (\d+)/)[1];
  for (const who of [member, other]) {
    const bot = env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(who.botId));
    env.relay.groups.join(bot, Number(gid), { byOwner: true });
  }
  for (const who of people) await who.cli('inbox');
  return { env, payer, member, other, gid };
}

test('a bill rings only members included on it, including after lease expiry', async t => {
  const { env, payer, other, gid } = await trip(t);
  await payer.cli('tab', 'add', gid, '--amount=12', '--what=Lunch', '--people=tom');
  const nextRing = () => env.relay.db.prepare("SELECT next_ring_at FROM messages WHERE group_id=? AND to_bot=? AND kind='tab_bill'").get(gid, other.botId).next_ring_at;
  const initial = nextRing();
  const claim = await other.api('POST', '/v1/inbox/claim', { watch_scan: true, watch_tab_only: true });
  assert.equal(claim.json.messages.length, 1);
  env.advance(claim.json.lease_seconds * 1000 + 1);
  await env.relay.tick();
  assert.deepEqual([initial, nextRing()], [null, null]);
});

async function linkPhone(member) {
  const phone = await phoneOf(member);
  await promisify(execFile)(process.execPath, [file, 'phone', 'link', await phone.setUp(), '--agent', 'claude-code'], {
    env: { ...process.env, B2B_HOME: member.home, HOME: member.home },
  });
  return phone;
}

test('a phone signs the revision of a changeable answer', async t => {
  const { env, payer, member, gid } = await trip(t);
  const phone = await linkPhone(member);
  const id = JSON.parse(await payer.cli('tab', 'add', gid, '--amount=1')).id;
  await member.cli('inbox');
  const child = spawn(process.execPath, [file, 'review-card', gid, id], {
    env: { ...process.env, B2B_HOME: member.home, B2B_UNATTENDED: '1' }, stdio: 'ignore',
  });
  t.after(() => child.kill());
  await phone.waitFor(() => !!phone.button('Split evenly'));
  await phone.button('Split evenly').click();
  await phone.passUndo();
  const row = env.relay.db.prepare('SELECT id, answer FROM phone_cards').get();
  const answer = JSON.parse(row.answer);
  const record = JSON.parse(readFileSync(join(member.home, 'tab-phone.json'))).cards['pick:' + gid + ':' + id];
  const signed = ['b2b-phone-answer/1', row.id, record.hash, 'even', '', answer.rev].join('|');
  assert.ok(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, phone.store.get('device').sign.publicKey,
    Buffer.from(answer.sig, 'base64url'), Buffer.from(signed)), 'revision is covered by the signature');
});

test('a delayed phone pick is never charged against a replacement item', async t => {
  const { env, payer, member, gid } = await trip(t);
  const phone = await linkPhone(member);
  const id = JSON.parse(await payer.cli('tab', 'add', gid, '--amount=1', '--what=Tea')).id;
  await member.cli('inbox');
  const child = spawn(process.execPath, [file, 'review-card', gid, id], {
    env: { ...process.env, B2B_HOME: member.home, B2B_UNATTENDED: '1' }, stdio: 'ignore',
  });
  t.after(() => child.kill());
  await phone.waitFor(() => !!phone.item('Tea'));
  const revision = JSON.parse(await payer.cli('tab', 'fix', gid, id, '--amount=90', '--what=Dinner')).id;
  await member.cli('inbox');
  // A phone may already have the old card open when the corrected bill arrives.
  await phone.tick('Tea');
  await phone.button('Done').click();
  await phone.passUndo();
  await waitFor(() => env.relay.db.prepare("SELECT 1 FROM phone_cards WHERE answered_at IS NOT NULL OR closed_at IS NOT NULL").get());
  await phone.waitFor(() => !!phone.item('Dinner'));
  const corrected = JSON.parse(await member.cli('tab', gid));
  assert.equal(corrected.bills[0].revision, revision);
  assert.ok(corrected.open_for_me.includes(id));
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM phone_cards WHERE closed_at IS NULL').get().n, 1);
  await payer.cli('tab', 'close', gid, id);
  await member.cli('inbox');
  const state = JSON.parse(await member.cli('tab', gid));
  assert.equal(state.bills[0].shares[tom], 3000, 'the unclaimed dinner is shared by three people');
});

test('resync preserves a bill signed on a subsequently retired device', async t => {
  const { env, payer, member, other, gid } = await trip(t);
  const device = cliHome();
  t.after(() => rmSync(device.home, { recursive: true, force: true }));
  const link = await device.cli('device', 'link', env.url, '--name', 'laptop');
  const [, deviceId, code] = link.match(/device approve (d_\w+) ([A-F0-9]{16})/);
  const approval = await payer.cli('device', 'approve', deviceId, code, '--owner-ok');
  await device.cli('device', 'link', '--confirm', approval.match(/--confirm ([A-F0-9]{16})/)[1]);
  const id = JSON.parse(await device.cli('tab', 'add', gid, '--amount=12')).id;
  await member.cli('inbox');
  assert.equal(JSON.parse(await member.cli('tab', gid)).bills[0].id, id);
  env.advance(8 * day);
  await env.relay.tick();
  env.relay.retention();
  await payer.cli('device', 'revoke', 'laptop', '--owner-ok');
  // A responder can forward a backdated event signed with the retired key or a key
  // that never belonged to Anna. Neither has a commitment accepted from her device.
  const { event: original } = JSON.parse(readFileSync(join(member.home, 'tabs', gid, id + '.json')));
  const template = join(device.home, 'bill.json');
  writeFileSync(template, JSON.stringify({ ...original, place: 'Injected bill' }));
  for (const signer of ['retired', 'unlisted']) {
    const { stdout } = await promisify(execFile)(process.execPath, [file, 'review-event', template, signer], {
      env: { ...process.env, B2B_HOME: device.home },
    });
    const { event } = JSON.parse(stdout);
    writeFileSync(join(member.home, 'tabs', gid, event.id + '.json'), stdout);
  }
  assert.equal(JSON.parse(await member.cli('tab', 'history', gid)).length, 3);
  await other.cli('tab', 'resync', gid, '--from', 'tom');
  await member.cli('inbox');
  await other.cli('inbox');
  assert.deepEqual(JSON.parse(await other.cli('tab', gid)).bills.map(b => b.id), [id]);
});

test('rejoining reconciles a previously known bill dropped during the absence', async t => {
  const { env, payer, member, gid } = await trip(t);
  const id = JSON.parse(await payer.cli('tab', 'add', gid, '--amount=12')).id;
  await payer.cli('tab', 'close', gid, id);
  await member.cli('inbox');
  assert.equal(JSON.parse(await member.cli('tab', gid)).balances[tom], -400);
  const paid = (await member.cli('tab', 'paid', gid, '@anna', '4', 'EUR')).trim().split(' ').at(-1);
  await payer.cli('inbox');
  await member.cli('group', 'leave', gid);
  await payer.cli('tab', 'drop', gid, id);
  await payer.cli('tab', 'got', gid, paid);
  const privateBill = JSON.parse(await payer.cli('tab', 'add', gid, '--amount=9', '--people=mia')).id;
  await payer.cli('group', 'add', gid, 'tom');
  const bot = env.relay.db.prepare('SELECT * FROM bots WHERE id=?').get(Number(member.botId));
  env.relay.groups.join(bot, Number(gid), { byOwner: true });
  await member.cli('tab', 'resync', gid, '--from', 'anna');
  await payer.cli('inbox');
  await member.cli('inbox');
  assert.deepEqual(JSON.parse(await member.cli('tab', gid)).balances, JSON.parse(await payer.cli('tab', gid)).balances);
  const history = JSON.parse(await member.cli('tab', 'history', gid));
  assert.ok(history.some(e => e.type === 'got' && e.paid === paid));
  assert.ok(!history.some(e => e.id === privateBill));
});

test('payment instructions use a currency the paid command can record', async t => {
  const { payer, member, gid } = await trip(t);
  await payer.cli('tab', 'add', gid, '--amount=1', '--currency=EUR');
  await member.cli('inbox');
  await assert.rejects(member.cli('tab', 'pay', gid, '@anna', '--amount=1', '--currency=CZK'), /group currency/);
});

test('a quiet paid event reaches the watcher without unrelated traffic', async t => {
  const { env, payer, member, gid } = await trip(t);
  const phone = await linkPhone(payer);
  await payer.cli('tab', 'add', gid, '--amount=12');
  await member.cli('inbox');
  assert.equal((await payer.api('POST', '/v1/doorbell', { kind: 'watch', agent: 'codex' })).status, 200);
  await member.cli('tab', 'paid', gid, '@anna', '4', 'EUR');
  const config = JSON.parse(readFileSync(join(payer.home, 'config.json'), 'utf8'));
  const result = await fetch(env.url + '/v1/watch', { headers: {
    authorization: 'Bearer ' + config.token, 'x-b2b-tab-payto': '1',
  } });
  const wake = await result.json();
  assert.equal(wake.ring, false);
  assert.ok(wake.tab_pending, 'the watcher must be able to process the settlement and ask the phone');
  const cli = fileURLToPath(new URL('../cli/b2b.mjs', import.meta.url));
  const watcher = spawn(process.execPath, [cli, 'watch', '--command', '/usr/bin/true'], {
    env: { ...process.env, B2B_HOME: payer.home, HOME: payer.home, B2B_UNATTENDED: '1' }, stdio: 'ignore',
  });
  t.after(() => watcher.kill());
  await phone.waitFor(() => !!phone.button('It arrived'));
});

test('correcting the receipt currency after a group currency change converts once', async t => {
  const { payer, gid } = await trip(t);
  const id = JSON.parse(await payer.cli('tab', 'add', gid, '--amount=12', '--currency=EUR')).id;
  await payer.cli('tab', 'currency', gid, 'CZK', '--rate=25');
  await payer.cli('tab', 'fix', gid, id, '--amount=12', '--currency=CZK');
  await payer.cli('tab', 'close', gid, id);
  assert.equal(JSON.parse(await payer.cli('tab', gid)).balances[tom], -400, 'Tom owes 4 CZK');
});

test('the final pick removes the now-closed bill from linked phones', async t => {
  const { env, payer, member, gid } = await trip(t);
  const phone = await linkPhone(member);
  const id = JSON.parse(await payer.cli('tab', 'add', gid, '--people=tom', '--amount=1')).id;
  await payer.cli('tab', 'pick', gid, id, '--even');
  await member.cli('inbox');
  const child = spawn(process.execPath, [file, 'review-card', gid, id], {
    env: { ...process.env, B2B_HOME: member.home, B2B_UNATTENDED: '1' }, stdio: 'ignore',
  });
  t.after(() => child.kill());
  await phone.waitFor(() => !!phone.button('Split evenly'));
  await phone.button('Split evenly').click();
  await phone.passUndo();
  await waitFor(async () => JSON.parse(await member.cli('tab', gid)).bills[0].status === 'closed');
  await phone.check();
  assert.equal(phone.button('Change'), null, 'the closed bill can no longer offer edits');
});

test('a signed close includes the named answer even if its author clock is ahead', () => {
  const seen = event('pick', 5000, { author: tom, absent: true, revision: 'bill' });
  const unseen = event('pick', 10, { author: tom, even: true, revision: 'bill' });
  const close = event('close', 100, { revision: 'bill', picks: [seen.id] });
  const state = fold([bill(), close, seen, unseen]);
  assert.equal(state.bills[0].status, 'closed');
  assert.equal(state.bills[0].shares[tom], 0);
  assert.deepEqual(state.bills[0].picks, [seen.id]);
});

test('a member watcher signs a deadline close with its observed pick IDs', async t => {
  const { payer, member, gid } = await trip(t);
  const id = JSON.parse(await payer.cli('tab', 'add', gid, '--amount=12')).id;
  await member.cli('inbox');
  const answer = JSON.parse(await member.cli('tab', 'pick', gid, id, '--absent')).id;
  await promisify(execFile)(process.execPath, [file, 'review-expire'], {
    env: { ...process.env, B2B_HOME: member.home, HOME: member.home, B2B_UNATTENDED: '1' },
  });
  await payer.cli('inbox');
  const close = JSON.parse(await payer.cli('tab', 'history', gid)).find(e => e.type === 'close');
  assert.equal(close.author, tom);
  assert.equal(close.revision, id);
  assert.deepEqual(close.picks, [answer]);
  const receipt = JSON.parse(await payer.cli('tab', gid)).bills[0];
  assert.equal(receipt.status, 'closed');
  assert.equal(receipt.shares[tom], 0);
});

test('a metadata fix asks again when the previous revision had signed answers', () => {
  const events = [bill(), event('pick', 1, { author: tom, absent: true, revision: 'bill' }),
    event('close', 2, { revision: 'bill', picks: ['pick1'] }), event('fix', 3, { place: 'Hotel cafe' })];
  const state = tabFold(events, tom);
  assert.deepEqual(state.open_for_me, ['bill']);
  assert.deepEqual(state.bills[0].picks, []);
});
