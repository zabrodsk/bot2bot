// Tab end to end: the core (signed events, balances), the phone cards and payments working together.
// Anna, Tom and Mia are three real CLI homes in an end-to-end encrypted group on a local relay. Tom and later Anna
// have the phone page linked (its real script under Node's WebCrypto, as in tab-phone.test.mjs), and their real
// watchers ("b2b watch") put the Tab cards on it. Mia has no phone and answers through her normal inbox run.
// No real bot, phone, push service or bot2bot.link is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import jsQR from 'jsqr';
import { setup, owner, connect, waitFor, sleep } from './helpers.mjs';
import { PHONE_SCRIPT } from '../phone-page.mjs';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'cli', 'b2b.mjs');

// ---- The phone page harness, as in tab-phone.test.mjs ----
const IDS = ['phone', 'status', 'cards', 'setup', 'link', 'notify', 'phones', 'say', 'linked', 'link-how', 'link-again', 'this-phone', 'push', 'push-note', 'empty', 'start', 'copy', 'remove', 'toast', 'toast-what', 'undo'];
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.hidden = false; this.value = ''; this._text = ''; this.className = ''; this.attrs = {}; }
  set textContent(s) { this._text = String(s); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(type, fn) { (this.events[type] ??= []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = v; }
  click() { return Promise.all((this.events.click ?? []).map((fn) => fn())); }
  toggle() { this.checked = !this.checked; return Promise.all((this.events.change ?? []).map((fn) => fn())); }
  find(pred) { for (const c of this.children) { if (pred(c)) return c; const d = c.find(pred); if (d) return d; } return null; }
}
async function phoneOf(who) {
  const els = Object.fromEntries(IDS.map((id) => [id, new Element(id)]));
  els.phone.dataset = { lang: 'en', vapid: 'x' };
  const store = new Map();
  let seq = 0;
  const timers = new Map();
  const req = (run_) => { const r = {}; queueMicrotask(() => { try { r.result = run_(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }); return r; };
  const db = { createObjectStore() {}, transaction() { const t = { objectStore: () => ({ get: (k) => req(() => store.get(k)), put: (v, k) => { store.set(k, v); queueMicrotask(() => t.oncomplete?.()); }, delete: (k) => { store.delete(k); queueMicrotask(() => t.oncomplete?.()); } }) }; return t; } };
  const doc = { visibilityState: 'visible', getElementById: (id) => els[id] ?? assert.fail(`no element ${id}`), createElement: (tag) => new Element(tag), addEventListener() {} };
  vm.runInNewContext(PHONE_SCRIPT, {
    document: doc, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, URLSearchParams, btoa, atob, queueMicrotask,
    indexedDB: { open: () => req(() => db) },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)', clipboard: { writeText: async () => {} } },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id),
    fetch: async (path, opts) => {
      const r = await who.b(path, { method: opts.method, ...(opts.body ? { form: Object.fromEntries(opts.body) } : {}) });
      return { ok: r.status === 200, status: r.status, type: 'basic', json: async () => r.json() };
    },
  });
  const fire = async (ms) => { const next = [...timers].find(([, t]) => t.ms === ms); assert.ok(next, `a ${ms} ms timer`); timers.delete(next[0]); await next[1].fn(); };
  const settle = async () => { for (let i = 0; i < 20; i++) await sleep(10); };
  await settle();
  const phone = { els, store, settle,
    check: async () => { await fire(3000); await settle(); },
    passUndo: async () => { await fire(4000); await settle(); },
    button: (text) => els.cards.find((e) => e.tag === 'button' && e.textContent === text),
    row: (name) => els.cards.find((e) => e.tag === 'li' && e.children[0]?.tag === 'label' && e.children[0].children[1]?.children[0]?.textContent === name),
    text: () => els.cards.textContent,
    async tick(name) { await phone.row(name).children[0].children[0].toggle(); await settle(); },
    async more(name) { await phone.row(name).find((e) => e.tag === 'button' && e.attrs['aria-label'] === 'One more').click(); await settle(); },
    async waitFor(pred, ms = 15000) { const end = Date.now() + ms; for (;;) { await phone.check(); if (pred()) return; if (Date.now() > end) throw new Error(`timed out; the phone shows: ${phone.text()}`); await sleep(60); } },
    async setUp() { await els.start.click(); await settle(); return els.say.textContent.match(/code ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1]; },
  };
  return phone;
}

// ---- Payment QR reading, as in tab-pay.test.mjs ----
function readQR(svg) {
  const scale = 4;
  const size = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)[1]);
  const width = size * scale;
  const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const [, x, y] of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const offset = 4 * ((Number(y) * scale + dy) * width + Number(x) * scale + dx);
      rgba.fill(0, offset, offset + 3);
    }
  }
  return jsQR(rgba, width, width, { inversionAttempts: 'dontInvert' });
}

const cliEnv = (u, env = {}) => ({ ...process.env, B2B_HOME: u.home, HOME: u.home, B2B_UNATTENDED: '', ...env });
// The owner's own session: never unattended.
const cliOf = (u) => async (...a) => (await run(process.execPath, [CLI, ...a], { env: cliEnv(u) })).stdout;
// The bot's real watcher. Started as the service would start it: nobody is watching this run.
function watcher(t, u) {
  const p = spawn(process.execPath, [CLI, 'watch', '--command', '/usr/bin/true'], { env: cliEnv(u, { B2B_UNATTENDED: '1' }), stdio: ['ignore', 'pipe', 'pipe'] });
  const w = { out: '' };
  p.stdout.on('data', (c) => { w.out += c; });
  p.stderr.on('data', (c) => { w.out += c; });
  t.after(() => p.kill());
  return w;
}
const records = (out) => out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const EUR_IBAN = 'DE89370400440532013000';

// Anna, Tom and Mia in an end-to-end encrypted group. Tom's phone is linked and his watcher is running.
async function trip(t) {
  const env = await setup(t, { hosted: true, limits: { groupPostsPer10Min: 100 } });
  const anna = await owner(env, t, 'anna@example.com', 'anna', { status: 503 });
  const tom = await owner(env, t, 'tom@example.com', 'tom', { status: 503 });
  const mia = await owner(env, t, 'mia@example.com', 'mia', { status: 503 });
  for (const u of [anna, tom, mia]) u.run = cliOf(u);
  await connect(anna, tom, 'Anna');
  await connect(anna, mia, 'Anna');
  const g = (await anna.run('group', 'new', 'Croatia trip', 'tom', 'mia')).match(/number (\d+)/)[1];
  for (const u of [tom, mia]) {
    env.advance(1_000);
    env.relay.groups.join(env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(u.botId)), Number(g), { byOwner: true });
  }
  // A normal inbox run, as many times as there is more: what the owner's bot does when it checks in.
  const inbox = async (u) => {
    const all = [];
    for (;;) {
      const recs = records(await u.run('inbox', '--json'));
      all.push(...recs);
      if (!recs.at(-1).more) return all;
    }
  };
  for (const u of [anna, tom, mia]) await inbox(u);
  const state = async (u) => JSON.parse(await u.run('tab', g));
  const tabMsgs = (botId) => env.relay.db.prepare("SELECT * FROM messages WHERE to_bot = ? AND kind IN ('tab', 'tab_bill') ORDER BY created_at").all(Number(botId));
  const phoneCards = () => env.relay.db.prepare('SELECT * FROM phone_cards ORDER BY created_at').all();

  // Tom links his phone, and his watcher runs as the service would: unattended.
  const tomPhone = await phoneOf(tom);
  const code = await tomPhone.setUp();
  assert.ok(code, 'the phone page shows a link code');
  await tom.run('phone', 'link', code, '--agent', 'claude-code');
  await tomPhone.check();
  const tomWatch = watcher(t, tom);
  await waitFor(async () => (await tom.api('GET', '/v1/me')).json.doorbell?.watching, 15000);
  // Prices are per unit, in cents: 14 + 3 × 4.50 + 32 + 2 × 5 + tip 14.50 = 84.
  const receipt = join(anna.home, 'receipt.json');
  writeFileSync(receipt, JSON.stringify({
    items: [{ n: 1, name: 'Burger', qty: 1, price: 1400 }, { n: 2, name: 'Beer', qty: 3, price: 450 }, { n: 3, name: 'Wine bottle', qty: 1, price: 3200 }, { n: 4, name: 'Fries', qty: 2, price: 500 }],
    extras: { tip: 1450 }, total: 8400,
  }));
  const addBill = async () => JSON.parse(await anna.run('tab', 'add', g, '--items', receipt, '--what', 'Konoba Dalmata', '--currency', 'EUR')).id;
  const tomPicks = async () => (await inbox(anna), JSON.parse(await anna.run('tab', 'history', g)).filter((e) => e.type === 'pick' && e.author === '@tom'));
  return { env, anna, tom, mia, g, inbox, state, tabMsgs, phoneCards, tomPhone, tomWatch, addBill, tomPicks };
}

test('Tab end to end: a receipt, picks on a phone and in a chat, Change, close, the same balances everywhere, a QR payment and "It arrived"', { timeout: 240_000 }, async (t) => {
  const { env, anna, tom, mia, g, inbox, state, tabMsgs, phoneCards, tomPhone, tomWatch, addBill, tomPicks } = await trip(t);

  // 1-2. Tom's phone is linked (above). Anna adds the receipt.
  const bill = await addBill();
  // The relay holds the bill sealed: no item, place or amount in what it stores.
  for (const m of [...tabMsgs(tom.botId), ...tabMsgs(mia.botId)]) {
    assert.equal(m.text, '');
    assert.match(m.sealed, /^b2b/, 'sealed end to end');
    assert.doesNotMatch(m.sealed ?? '', /Konoba|Burger|8400/);
  }

  // 3. Tom's watcher gets the bill, and the card shows up on his phone. He ticks the burger and two beers, then Done.
  await tomPhone.waitFor(() => !!tomPhone.button('Done'), 30000);
  assert.match(tomPhone.text(), /^Croatia trip · \d{4}-\d{2}-\d{2}@anna paid €84\.00 at Konoba Dalmata\. What did you have\?/);
  assert.match(tomPhone.text(), /Beer3 × €4\.50€13\.50/);
  assert.match(tomPhone.text(), /Tip €14\.50, shared by what each person had\./);
  assert.equal(phoneCards()[0].kind, 'tab_pick');
  await tomPhone.tick('Burger');
  await tomPhone.tick('Beer');
  await tomPhone.more('Beer');
  assert.match(tomPhone.text(), /2 of 3/);
  await tomPhone.button('Done').click();
  await tomPhone.passUndo();
  // The pick reaches the group, signed by Tom's bot, from a run nobody watches (B2B_UNATTENDED=1).
  const [first] = await waitFor(async () => { const p = await tomPicks(); return p.length ? p : null; }, 20000);
  assert.deepEqual(first.items, [{ n: 1, units: 1 }, { n: 2, units: 2 }]);
  assert.equal(first.bill, bill);
  assert.match(first.signature, /^[\w-]{86}$/);
  assert.doesNotMatch(tomWatch.out, /owner needs to say yes/i);
  await tomPhone.waitFor(() => /You had Burger, 2 × Beer\./.test(tomPhone.text()));
  const before = (await state(anna)).bills[0].shares;

  // 4. Tom taps Change before the bill closes: two beers and the wine, no burger.
  await tomPhone.button('Change').click(); await tomPhone.settle();
  await tomPhone.tick('Burger');
  await tomPhone.tick('Wine bottle');
  await tomPhone.button('Done').click();
  await tomPhone.passUndo();
  const changed = await waitFor(async () => { const p = await tomPicks(); return p.length === 2 ? p[1] : null; }, 20000);
  assert.deepEqual(changed.items, [{ n: 2, units: 2 }, { n: 3, units: 1 }]);
  await tomPhone.waitFor(() => /You had 2 × Beer, Wine bottle\./.test(tomPhone.text()));
  // While the bill is open, Anna's view already uses the newer pick: Tom's share went up with the wine.
  assert.ok((await state(anna)).bills[0].shares['@tom'] > before['@tom']);

  // 5. Mia has no phone. Her normal inbox run tells her owner, and never waits on a phone.
  const miaRecs = await inbox(mia);
  const ask = miaRecs.find((r) => r.code === 'tab');
  assert.ok(ask, `Mia's owner is asked: ${JSON.stringify(miaRecs)}`);
  assert.equal(ask.tell, true);
  assert.match(ask.text, /@anna added a bill for .Konoba Dalmata., 84\.00 EUR\. What did you have\?/);
  assert.ok(!miaRecs.some((r) => r.code === 'tab_card'), 'a normal inbox run never hands out phone cards');
  // Her owner had a beer, the wine and one portion of fries.
  await mia.run('tab', 'pick', g, bill, '--items', '2,3,4');

  // 6. Anna closes the bill early (she never picked: what nobody claimed is split evenly). Tom's card leaves his phone.
  await inbox(anna);
  await anna.run('tab', 'close', g, bill);
  await inbox(tom);
  await tomPhone.waitFor(() => tomPhone.text() === '', 20000);
  assert.ok(phoneCards()[0].closed_at, 'the relay closed the card');
  await inbox(mia);

  // 7. The same balances in every home, matching a hand calculation.
  // Item costs per person, in thirds of a cent (the burger and the second fries nobody claimed are split three ways):
  //   Anna: 1400/3 burger + 500/3 fries                                        = 1900/3
  //   Tom:  1400/3 + 2 × 450 beer + 3200/2 wine + 500/3                         = 9400/3
  //   Mia:  1400/3 + 1 × 450 beer + 3200/2 wine + 500 fries + 500/3              = 9550/3   (sum 20850/3 = 6950 = items)
  // The tip goes by what each had, so each pays 8400 × w / 20850, rounded down, and the leftover cent goes to Anna.
  const w = { '@anna': 1900, '@tom': 9400, '@mia': 9550 };
  const shares = Object.fromEntries(Object.entries(w).map(([h, n]) => [h, Math.floor(8400 * n / 20850)]));
  shares['@anna'] += 8400 - Object.values(shares).reduce((a, b) => a + b, 0);
  assert.deepEqual(shares, { '@anna': 766, '@tom': 3787, '@mia': 3847 });
  const [sa, st, sm] = await Promise.all([anna, tom, mia].map(state));
  assert.deepEqual(st, sa);
  assert.deepEqual(sm, sa);
  assert.equal(sa.bills.length, 1);
  assert.equal(sa.bills[0].status, 'closed');
  assert.deepEqual(sa.bills[0].shares, shares);
  assert.deepEqual(sa.balances, { '@anna': 8400 - 766, '@tom': -3787, '@mia': -3847 });
  assert.deepEqual(sa.plan, [{ from: '@mia', to: '@anna', amount: 3847, currency: 'EUR' }, { from: '@tom', to: '@anna', amount: 3787, currency: 'EUR' }]);
  // Both of Tom's picks are in the signed history; only the newer one counts.
  assert.equal(JSON.parse(await tom.run('tab', 'history', g)).filter((e) => e.type === 'pick' && e.author === '@tom').length, 2);

  // 8. Anna stores her payment details; her watcher answers payment requests on its own. Tom asks how to pay her.
  await anna.run('tab', 'payto', 'set', '--iban', EUR_IBAN, '--name', 'Anna Novak');
  const annaPhone = await phoneOf(anna);
  await anna.run('phone', 'link', await annaPhone.setUp(), '--agent', 'claude-code');
  await annaPhone.check();
  const annaWatch = watcher(t, anna);
  await waitFor(async () => (await anna.api('GET', '/v1/me')).json.doorbell?.watching, 15000);
  const pay = JSON.parse(await tom.run('tab', 'pay', g, '@anna', '--json'));
  const EPC = ['BCD', '002', '1', 'SCT', '', 'Anna Novak', EUR_IBAN, 'EUR37.87', '', '', 'Tab: Croatia trip'].join('\n');
  assert.equal(pay.status, 'ready', annaWatch.out);
  assert.equal(pay.amount, '37.87');
  assert.deepEqual(pay.options, [{ kind: 'epc', payload: EPC }]);
  assert.equal(readQR(readFileSync(pay.qrPath, 'utf8'))?.data, EPC);
  assert.equal(pay.confirmCommand, `b2b tab paid ${g} @anna 37.87 EUR`);
  await tom.run('tab', 'paid', g, '@anna', '37.87', 'EUR');
  await mia.run('tab', 'paid', g, '@anna', '38.47', 'EUR');
  // "I paid" alone changes nothing: only Anna's confirmation does.
  assert.deepEqual((await state(tom)).balances, sa.balances);

  // 9. Anna's watcher puts a got card for each on her phone. "It arrived" posts a signed got, and everyone is settled.
  await annaPhone.waitFor(() => (annaPhone.text().match(/Did it arrive\?/g) ?? []).length === 2, 30000);
  assert.match(annaPhone.text(), /@tom marked €37\.87 as sent to you\. Did it arrive\?/);
  assert.match(annaPhone.text(), /@mia marked €38\.47 as sent to you\. Did it arrive\?/);
  for (let i = 0; i < 2; i++) {
    await annaPhone.button('It arrived').click();
    await annaPhone.passUndo();
  }
  const gots = await waitFor(async () => { const h = JSON.parse(await anna.run('tab', 'history', g)).filter((e) => e.type === 'got'); return h.length === 2 ? h : null; }, 20000);
  assert.ok(gots.every((e) => e.author === '@anna'));
  for (const u of [tom, mia]) await inbox(u);
  const settled = await Promise.all([anna, tom, mia].map(state));
  for (const s of settled) {
    assert.deepEqual(s, settled[0]);
    assert.deepEqual(Object.values(s.balances), [0, 0, 0]);
    assert.deepEqual(s.plan, []);
  }
  assert.doesNotMatch(annaWatch.out + tomWatch.out, /owner needs to say yes|Ask your owner/i);
});

test('Tab end to end: when the last person picks, the bill closes and the card leaves the phone with no close', { timeout: 120_000 }, async (t) => {
  const { env, anna, tom, mia, g, inbox, state, phoneCards, tomPhone, addBill, tomPicks } = await trip(t);
  const bill = await addBill();
  await tomPhone.waitFor(() => !!tomPhone.button('Split evenly'), 30000);
  await tomPhone.button('Split evenly').click();
  await tomPhone.passUndo();
  await waitFor(async () => (await tomPicks()).length === 1, 20000);
  await tomPhone.waitFor(() => /You split it evenly\./.test(tomPhone.text()));
  await inbox(mia);
  await mia.run('tab', 'pick', g, bill, '--items', '1');
  await inbox(anna);
  // Anna answers last: everyone has, so the bill is closed. Nobody posts close.
  await anna.run('tab', 'pick', g, bill, '--absent');
  assert.equal((await state(anna)).bills[0].status, 'closed');
  assert.ok(!JSON.parse(await anna.run('tab', 'history', g)).some((e) => e.type === 'close'));
  await inbox(tom);
  await tomPhone.waitFor(() => tomPhone.text() === '', 20000);
  assert.ok(phoneCards()[0].closed_at, 'the relay closed the card');
  await inbox(mia);
  const states = await Promise.all([anna, tom, mia].map(state));
  for (const s of states) assert.deepEqual(s, states[0]);
  // Anna wasn't there; Mia had the burger. Tom and Mia split everything else evenly: 5550 / 2 = 2775 each.
  //   Tom 2775 and Mia 1400 + 2775 = 4175 of 6950 in items. With the tip, 8400 × 2775 / 6950 = 3353.96 → 3353 and
  //   8400 × 4175 / 6950 = 5046.04 → 5046. The leftover cent goes to the payer, even though she wasn't there.
  assert.deepEqual(states[0].bills[0].shares, { '@anna': 1, '@tom': 3353, '@mia': 5046 });
  void env;
});
