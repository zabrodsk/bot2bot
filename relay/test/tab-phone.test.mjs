// Tab on the phone: "what did you have?" on a bill and "did it arrive?" on a payment. The owner's phone page runs
// here as it is (its real script, Node's WebCrypto, a stand-in for the page's elements), against a local relay, and
// the real tool asks the cards (b2b phone tab-ask, which calls the same tabAskPick/tabAskGot the Tab core uses).
// No real bot, phone or push service is used.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { phoneOf } from './tab-phone-helper.mjs';
import { setup, owner, waitFor } from './helpers.mjs';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'cli', 'b2b.mjs');
const cliIn = (home, env = {}) => async (...a) => {
  try { const r = await run(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: home, HOME: home, B2B_UNATTENDED: '', ...env } }); return { code: 0, out: r.stdout + r.stderr }; }
  catch (e) { return { code: e.code, out: `${e.stdout}${e.stderr}` }; }
};
const running = new Set();
afterEach(() => { for (const p of running) p.kill(); running.clear(); });
// The Tab core asking the owner's phone, as a separate run of the tool: what it prints is what tabAskPick/tabAskGot returned.
let files = 0;
function ask(home, what, data, extra = [], env = {}) {
  const file = join(home, `tab-${++files}.json`);
  writeFileSync(file, JSON.stringify(data));
  const p = spawn(process.execPath, [CLI, 'phone', 'tab-ask', what, '--file', file, ...extra], { env: { ...process.env, B2B_HOME: home, HOME: home, B2B_UNATTENDED: '', ...env } });
  running.add(p);
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { out += c; });
  return new Promise((ok) => p.on('close', (code) => { running.delete(p); let json; try { json = JSON.parse(out.trim()); } catch { json = undefined; } ok({ code, out, json }); }));
}
const cards = (env) => env.relay.db.prepare('SELECT * FROM phone_cards ORDER BY created_at').all();
const forOwner = (home) => { try { return JSON.parse(readFileSync(join(home, 'for-owner.json'), 'utf8')).lines.map((l) => l.line); } catch { return []; } };
async function linked(t) {
  const env = await setup(t);
  const cara = await owner(env, t, 'cara@example.com', 'cara', { status: 503 });
  const cli = cliIn(cara.home);
  const phone = await phoneOf(cara);
  const code = await phone.setUp();
  assert.equal((await cli('phone', 'link', code, '--agent', 'claude-code')).code, 0);
  await phone.check();
  return { env, cara, cli, phone };
}
const GROUP = { id: '7', name: 'Croatia trip' };
const bill = (id, more = {}) => ({ group: GROUP, bill: { id, payer: 'anna', place: 'Konoba Dalmata', date: '2026-11-20', currency: 'EUR', total: 8400,
  // Prices are per unit (as in the core's bill): 14 + 3×4.50 + 32 + 2×5 + tip 14.50 = 84.
  items: [{ n: 1, name: 'Burger', qty: 1, price: 1400 }, { n: 2, name: 'Beer', qty: 3, price: 450 }, { n: 3, name: 'Wine bottle', qty: 1, price: 3200 }, { n: 4, name: 'Fries', qty: 2, price: 500 }],
  extras: { tip: 1450 }, people: ['anna', 'tom', 'cara'], ...more } });

// What the relay stores in the clear: the row with each sealed box's base64 values left out
// (random ciphertext can spell "tom" by chance).
const clearPart = (c) => JSON.stringify({ ...c, boxes: Object.fromEntries(Object.entries(JSON.parse(c.boxes)).map(([k, v]) => [k, Object.keys(v)])) });

test('the pick card: tick what you had, Done, and the bot gets exactly that, signed', async (t) => {
  const { env, cara, phone } = await linked(t);
  const asked = ask(cara.home, 'pick', bill('bill_1'));
  await phone.waitFor(() => !!phone.button('Done'));
  assert.match(phone.text(), /^Croatia trip · 2026-11-20@anna paid €84\.00 at Konoba Dalmata\. What did you have\?/);
  assert.match(phone.text(), /Burger€14\.00/);
  assert.match(phone.text(), /Beer3 × €4\.50€13\.50/);
  assert.match(phone.text(), /Tip €14\.50, shared by what each person had\./);
  assert.match(phone.text(), /closes in 24 h$/);
  // The relay holds a card it can't read, for a day.
  const [card] = cards(env);
  assert.equal(card.kind, 'tab_pick');
  assert.ok(card.expires_at - card.created_at > 23 * 3_600_000);
  assert.doesNotMatch(clearPart(card), /Konoba|Burger|Beer|8400|anna/);

  // Nothing ticked: Done can't be tapped. A counter for the beers, from 1 up to 3.
  assert.equal(phone.button('Done').disabled, true);
  await phone.tick('Burger');
  await phone.tick('Beer');
  assert.equal(phone.button('Done').disabled, false);
  assert.match(phone.text(), /1 of 3/);
  const more = phone.els.cards.find((e) => e.tag === 'button' && e.attrs['aria-label'] === 'One more');
  await more.click(); await more.click(); await more.click();
  assert.match(phone.text(), /3 of 3/, 'never more than there were');
  assert.equal(more.disabled, true);
  await phone.els.cards.find((e) => e.tag === 'button' && e.attrs['aria-label'] === 'One less').click();
  assert.match(phone.text(), /2 of 3/);

  // Done shows what it did with an Undo, and only goes out when that passes.
  await phone.button('Done').click();
  assert.equal(phone.els['toast-what'].textContent, 'Picked 2 items');
  assert.equal(cards(env)[0].answered_at, null, 'nothing goes out while Undo is offered');
  await phone.passUndo();
  const r = await asked;
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.json, { items: [{ n: 1, units: 1 }, { n: 2, units: 2 }], signed: true, rev: 1, device: 'iPhone', card: card.id });
  // The relay saw that a pick was made, not what was picked.
  const stored = JSON.parse(cards(env)[0].answer);
  assert.equal(stored.decision, 'pick');
  assert.doesNotMatch(cards(env)[0].answer, /units|Burger/);

  // Asked again for the same bill: the same card, the same answer, nothing new on the phone.
  assert.deepEqual((await ask(cara.home, 'pick', bill('bill_1'))).json, r.json);
  assert.equal(cards(env).length, 1);

  // What it says now, and the next step: change it while the bill is open.
  await phone.waitFor(() => /You had Burger, 2 × Beer\./.test(phone.text()));
  assert.match(phone.text(), /You can change it until the bill closes\./);
  await phone.button('Change').click(); await phone.settle();
  assert.match(phone.text(), /2 of 3/, 'starts from what was picked');
  assert.equal(phone.item('Burger').children[0].checked, true);
  const change = ask(cara.home, 'pick', bill('bill_1'), ['--after', '1']);
  await phone.tick('Burger');
  await phone.tick('Wine bottle');
  await phone.button('Done').click(); await phone.passUndo();
  const changed = await change;
  assert.deepEqual(changed.json, { items: [{ n: 2, units: 2 }, { n: 3, units: 1 }], signed: true, rev: 2, device: 'iPhone', card: card.id });
  await phone.waitFor(() => /You had 2 × Beer, Wine bottle\./.test(phone.text()));

  // The bill closes: the card leaves the phone, and there is nothing more to wait for.
  assert.equal((await ask(cara.home, 'close', bill('bill_1'))).json, true);
  await phone.waitFor(() => phone.text() === '');
  assert.equal((await ask(cara.home, 'pick', bill('bill_1'), ['--after', '2'])).json, null);
  assert.equal((await cara.b(`/app/phone/cards/${card.id}/answer`, { method: 'POST', form: { device: phone.store.get('device').id, decision: 'even', sig: randomBytes(64).toString('base64url') } })).status, 409);
});

test('Split evenly and I wasn\'t there, with an Undo that takes the tap back', async (t) => {
  const { env, cara, phone } = await linked(t);
  const first = ask(cara.home, 'pick', bill('bill_2', { payer: 'cara', place: '' }));
  await phone.waitFor(() => !!phone.button('Split evenly'));
  assert.match(phone.text(), /You paid €84\.00\. What did you have\?/, 'the payer picks too');
  await phone.button('Split evenly').click();
  assert.equal(phone.els['toast-what'].textContent, 'Split evenly for you');
  await phone.els.undo.click(); await phone.settle();
  assert.ok(phone.button('Split evenly'), 'the buttons are back');
  assert.equal(cards(env)[0].answered_at, null);
  await phone.button('Split evenly').click(); await phone.passUndo();
  assert.deepEqual((await first).json, { even: true, signed: true, rev: 1, device: 'iPhone', card: cards(env)[0].id });
  await phone.waitFor(() => /You split it evenly\./.test(phone.text()));

  const second = ask(cara.home, 'pick', bill('bill_3'));
  await phone.waitFor(() => !!phone.button("I wasn't there"));
  await phone.button("I wasn't there").click();
  assert.equal(phone.els['toast-what'].textContent, 'Marked as not there');
  await phone.passUndo();
  assert.deepEqual((await second).json, { absent: true, signed: true, rev: 1, device: 'iPhone', card: cards(env)[1].id });
  await phone.waitFor(() => /You weren't there\./.test(phone.text()));

  // In Czech, for an owner who reads Czech.
  const cz = await phoneOf(cara, { lang: 'cs', store: phone.store });
  await cz.waitFor(() => /Nebyli jste tam\./.test(cz.text()));

  // Phone approvals off, or no phone at all: there is nothing to ask, and the core asks in the chat instead.
  assert.equal((await cliIn(cara.home)('phone', 'off')).code, 0);
  assert.equal((await ask(cara.home, 'pick', bill('bill_4'))).json, null);
  // A run nobody watches can't put made-up cards on the phone through the tool.
  assert.match((await ask(cara.home, 'pick', bill('bill_5'), [], { B2B_UNATTENDED: '1' })).out, /Only your owner changes this/);
});

test('the got card: "It arrived" or "Not yet", one tap each', async (t) => {
  const { env, cara, phone } = await linked(t);
  const paid = (id) => ({ group: GROUP, paid: { id, author: 'tom', to: 'cara', amount: 3100, currency: 'EUR' } });
  const first = ask(cara.home, 'got', paid('paid_1'));
  await phone.waitFor(() => !!phone.button('It arrived'));
  assert.match(phone.text(), /^Croatia trip@tom marked €31\.00 as sent to you\. Did it arrive\?/);
  assert.equal(cards(env)[0].kind, 'tab_got');
  assert.doesNotMatch(clearPart(cards(env)[0]), /3100|tom/);
  await phone.button('It arrived').click();
  assert.equal(phone.els['toast-what'].textContent, 'Marked as arrived');
  await phone.passUndo();
  assert.equal((await first).json, true);
  await phone.waitFor(() => /Arrived$/.test(phone.text()));

  const second = ask(cara.home, 'got', paid('paid_2'));
  await phone.waitFor(() => !!phone.button('Not yet'));
  await phone.button('Not yet').click(); await phone.passUndo();
  assert.equal((await second).json, false);
  // A got card is answered once: there's no Change.
  assert.equal(phone.button('Change'), null);
});

test('forged answers: picks changed after signing, a copied answer, the relay\'s own words. The bot keeps none of them', async (t) => {
  const { env, cara, phone } = await linked(t);
  const kept = phone.store.get('device');
  // The card goes to the phone; the core stops waiting for now.
  const pending = await ask(cara.home, 'pick', bill('bill_6'), ['--wait-ms', '500']);
  assert.equal(pending.json.pending, true);
  await phone.waitFor(() => !!phone.button('Done'));
  await phone.tick('Burger');
  await phone.button('Done').click(); await phone.passUndo();
  const card = cards(env)[0];
  const real = JSON.parse(card.answer);
  assert.equal(real.decision, 'pick');

  // Someone who got hold of the card's key swaps the picks for the wine and keeps the phone's signature.
  const rec = JSON.parse(readFileSync(join(cara.home, 'tab-phone.json'), 'utf8')).cards['pick:7:bill_6'];
  const seal = (text) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', Buffer.from(rec.rk, 'base64url'), iv); c.setAAD(Buffer.from(`b2b-phone-reply/1|${rec.id}`)); return { iv: iv.toString('base64url'), ct: Buffer.concat([c.update(text, 'utf8'), c.final(), c.getAuthTag()]).toString('base64url') }; };
  env.relay.db.prepare('UPDATE phone_cards SET answer = ? WHERE id = ?').run(JSON.stringify({ ...real, reply: seal('[{"n":3,"units":1}]') }), card.id);
  assert.equal((await ask(cara.home, 'pick', bill('bill_6'))).json, null);
  assert.match(forOwner(cara.home)[0], /^An answer to a Tab card on your phone came that none of your linked phones signed, so it was ignored and nothing was picked or confirmed/);
  // The same picks the phone signed, but not in the canonical form it signed: refused too.
  env.relay.db.prepare('UPDATE phone_cards SET answer = ? WHERE id = ?').run(JSON.stringify({ ...real, reply: seal('[{"units":1,"n":1}]') }), card.id);
  assert.equal((await ask(cara.home, 'pick', bill('bill_6'))).json, null);
  // Put back as the phone signed it, it counts.
  env.relay.db.prepare('UPDATE phone_cards SET answer = ? WHERE id = ?').run(JSON.stringify(real), card.id);
  assert.deepEqual((await ask(cara.home, 'pick', bill('bill_6'))).json.items, [{ n: 1, units: 1 }]);

  // A real pick copied onto another bill's card: refused, since it was signed for that one card.
  await ask(cara.home, 'pick', bill('bill_7'), ['--wait-ms', '500']);
  const other = cards(env)[1];
  env.relay.db.prepare('UPDATE phone_cards SET answer = ?, answered_at = ? WHERE id = ?').run(JSON.stringify(real), Date.now(), other.id);
  assert.equal((await ask(cara.home, 'pick', bill('bill_7'))).json, null);

  // The relay writes "it arrived" into its own database: not signed by the phone, so no money counts as arrived.
  await ask(cara.home, 'got', { group: GROUP, paid: { id: 'paid_9', author: 'tom', to: 'cara', amount: 3100, currency: 'EUR' } }, ['--wait-ms', '500']);
  const got = cards(env)[2];
  env.relay.db.prepare('UPDATE phone_cards SET answer = ?, answered_at = ? WHERE id = ?').run(JSON.stringify({ device: kept.id, decision: 'got', sig: randomBytes(64).toString('base64url') }), Date.now(), got.id);
  assert.equal((await ask(cara.home, 'got', { group: GROUP, paid: { id: 'paid_9', author: 'tom', to: 'cara', amount: 3100, currency: 'EUR' } })).json, null);
  // A pick the phone signed for the bill, replayed as "it arrived" on the payment: the decision is signed too.
  env.relay.db.prepare('UPDATE phone_cards SET answer = ? WHERE id = ?').run(JSON.stringify({ ...real, decision: 'got' }), got.id);
  assert.equal((await ask(cara.home, 'got', { group: GROUP, paid: { id: 'paid_9', author: 'tom', to: 'cara', amount: 3100, currency: 'EUR' } })).json, null);
});

test('the relay takes only answers of the card\'s own kind, and lets only Tab cards wait a day', async (t) => {
  const { env, cara, phone } = await linked(t);
  const kept = phone.store.get('device');
  const sig = () => randomBytes(64).toString('base64url');
  const box = { eph: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString('base64url'), iv: randomBytes(12).toString('base64url'), ct: randomBytes(40).toString('base64url') };
  const id = () => `apr_${randomBytes(17).toString('base64url').slice(0, 22)}`;
  const make = async (kind, ttl = 600) => { const c = { id: id(), kind, ttl, boxes: { [kept.id]: box } }; return { ...c, r: await cara.api('POST', '/v1/phone/cards', c) }; };
  const answer = (c, decision, more = {}) => cara.b(`/app/phone/cards/${c.id}/answer`, { method: 'POST', form: { device: kept.id, decision, sig: sig(), ...more } });
  const sealed = { reply_iv: randomBytes(12).toString('base64url'), reply_ct: randomBytes(40).toString('base64url') };

  // A day: only for Tab cards. A permission prompt still ends within half an hour.
  assert.equal((await make('permission', 86_400)).r.status, 400);
  assert.equal((await make('tab_got', 86_400 + 1)).r.status, 400);
  const pick = await make('tab_pick', 86_400); assert.equal(pick.r.status, 200);
  const got = await make('tab_got', 86_400); assert.equal(got.r.status, 200);
  const perm = await make('permission'); assert.equal(perm.r.status, 200);

  for (const d of ['allow', 'deny', 'got', 'not_yet']) assert.equal((await answer(pick, d)).status, 400, `${d} on a pick card`);
  assert.equal((await answer(pick, 'pick')).status, 400, 'a pick carries its items, encrypted');
  for (const d of ['allow', 'pick', 'even', 'absent']) assert.equal((await answer(got, d, sealed)).status, 400, `${d} on a got card`);
  for (const d of ['pick', 'even', 'absent', 'got', 'not_yet']) assert.equal((await answer(perm, d, sealed)).status, 400, `${d} on a permission card`);
  assert.ok(cards(env).every((c) => !c.answered_at));

  // Of their own kind they go through (the bot then checks the signature, as above).
  assert.equal((await answer(pick, 'pick', { ...sealed, rev: 1 })).status, 200);
  assert.equal((await answer(pick, 'even', { rev: 2 })).status, 200, 'a pick can be changed while its bill is open');
  assert.equal(JSON.parse(cards(env).find((c) => c.id === pick.id).answer).rev, 2);
  assert.equal((await answer(got, 'got')).status, 200);
  assert.equal((await answer(got, 'not_yet')).status, 409, 'a got card is answered once');
  assert.equal((await answer(perm, 'allow')).status, 200);
  assert.equal((await answer(perm, 'deny')).status, 409);
});

// Opt-in: B2B_TAB_SNAPSHOT=<dir> writes the pick and got cards as the page draws them (the same elements, as static
// HTML with the page's own styles), to look at in a browser at phone width, light and dark.
test('snapshot of the Tab cards', { skip: !process.env.B2B_TAB_SNAPSHOT }, async (t) => {
  const { cara, phone } = await linked(t);
  const asked = [ask(cara.home, 'pick', bill('bill_s')), ask(cara.home, 'got', { group: GROUP, paid: { id: 'paid_s', author: 'tom', to: 'cara', amount: 3100, currency: 'EUR' } })];
  await phone.waitFor(() => !!phone.button('Done') && !!phone.button('It arrived'));
  await phone.tick('Burger'); await phone.tick('Beer');
  await phone.els.cards.find((e) => e.tag === 'button' && e.attrs['aria-label'] === 'One more').click();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = (e) => {
    const a = [e.className && `class="${esc(e.className)}"`, e.hidden && 'hidden', e.disabled && 'disabled', e.type && `type="${e.type}"`, e.checked && 'checked', ...Object.entries(e.attrs).map(([k, v]) => `${k}="${esc(v)}"`)].filter(Boolean).join(' ');
    return e.tag === 'input' ? `<input ${a}>` : `<${e.tag}${a ? ' ' + a : ''}>${esc(e._text)}${e.children.map(html).join('')}</${e.tag}>`;
  };
  const { phonePage } = await import('../phone-page.mjs');
  for (const theme of ['light', 'dark']) {
    const page = phonePage({ theme }).html.replace(/<script>[^]*?<\/script>/, '').replace('<ul id="cards" aria-live="polite"></ul>', `<ul id="cards">${phone.els.cards.children.map(html).join('')}</ul>`);
    writeFileSync(join(process.env.B2B_TAB_SNAPSHOT, `tab-cards-${theme}.html`), page);
  }
  for (const p of running) p.kill();
  await Promise.all(asked);
});
