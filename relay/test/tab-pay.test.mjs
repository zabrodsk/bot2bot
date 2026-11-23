import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import jsQR from 'jsqr';
import { setup, owner, connect, waitFor } from './helpers.mjs';

const CLI = join(import.meta.dirname, '..', 'cli', 'b2b.mjs');
// The signed CLI runs its command on import. Choose the one with no I/O other than printing its version.
const argv = process.argv;
process.argv = [process.execPath, CLI, 'version'];
const { tabValidIban, tabPayPayload, tabQrSvg } = await import('../cli/b2b.mjs');
process.argv = argv;

const EUR_IBAN = 'DE89370400440532013000';
const CZK_IBAN = 'CZ9106000000000000000123';
const EPC = ['BCD', '002', '1', 'SCT', '', 'Anna Novak', EUR_IBAN, 'EUR31.00', '', '', 'Tab: Croatia trip'].join('\n');
const SPAYD = `SPD*1.0*ACC:${CZK_IBAN}+AGBACZPP*AM:450.00*CC:CZK*MSG:Tab: Croatia trip`;
const exec = promisify(execFile);

function readQR(svg) {
  const scale = 4;
  const size = Number(svg.match(/viewBox="0 0 (\d+) \d+"/)[1]);
  const width = size * scale;
  // Rasterize the exact rectangles encoded as paths, including the white quiet zone.
  const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
  for (const [, x, y] of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const offset = 4 * ((Number(y) * scale + dy) * width + Number(x) * scale + dx);
      rgba.fill(0, offset, offset + 3);
    }
  }
  return jsQR(rgba, width, width, { inversionAttempts: 'dontInvert' });
}

test('Tab validates the IBAN checksum and rejects bad input', () => {
  assert.ok(tabValidIban('de89 3704 0044 0532 0130 00'));
  assert.ok(tabValidIban(CZK_IBAN));
  for (const iban of ['', null, EUR_IBAN.slice(0, -1) + '1', 'DE00370400440532013000', 'DE89!70400440532013000']) {
    assert.equal(tabValidIban(iban), false);
  }
  assert.throws(() => tabPayPayload({ details: { iban: EUR_IBAN, name: 'Anna\nNovak' }, amount: 3100, currency: 'EUR' }), /account holder/);
});

test('Tab builds EPC and SPAYD payloads byte for byte', () => {
  const message = 'Tab: Croatia trip';
  assert.deepEqual(tabPayPayload({ details: { iban: EUR_IBAN, name: 'Anna Novak', revolut: '@anna12' }, amount: 3100, currency: 'EUR', message }), [
    { kind: 'epc', payload: EPC },
    { kind: 'revolut', payload: 'https://revolut.me/anna12' },
  ]);
  const details = { iban: CZK_IBAN, name: 'Anna Novak', bic: 'AGBACZPP' };
  assert.deepEqual(tabPayPayload({ details, amount: 45000, currency: 'czk', message }), [{ kind: 'spayd', payload: SPAYD }]);
  assert.equal(tabPayPayload({ details, amount: 10, currency: 'CZK', message: 'Ž*%😀' })[0].payload,
    `SPD*1.0*ACC:${CZK_IBAN}+AGBACZPP*AM:0.10*CC:CZK*MSG:%C5%BD%2A%25%F0%9F%98%80`);
  assert.equal(tabPayPayload({ details, amount: 999, currency: 'CHF', message })[0].payload,
    `Name: Anna Novak\nIBAN: ${CZK_IBAN}\nBIC: AGBACZPP\nAmount: 9.99 CHF\nMessage: Tab: Croatia trip`);
  const longEpc = tabPayPayload({ details: { ...details, name: 'Ž'.repeat(70) }, amount: 10, currency: 'EUR', message: '😀'.repeat(140) })[0].payload;
  assert.ok(Buffer.byteLength(longEpc) <= 331);
  assert.ok(longEpc.endsWith('😀'));
  assert.equal(tabPayPayload({ details: { ...details, name: '𐐀'.repeat(70) }, amount: 99_999_999_999, currency: 'EUR' })[0].kind, 'transfer');
  const longSpayd = tabPayPayload({ details, amount: 10, currency: 'CZK', message: '😀'.repeat(60) })[0].payload;
  assert.equal(decodeURIComponent(longSpayd.split('*MSG:')[1]), '😀'.repeat(5));
});

test('An independent QR decoder reads the SVG for both payment formats and all supported versions', () => {
  for (const payload of [EPC, SPAYD, EPC.replace('Anna Novak', 'Žofie Nováková')]) {
    assert.equal(readQR(tabQrSvg(payload))?.data, payload);
  }
  const capacities = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412, 450, 504, 560, 624, 666];
  for (const [i, capacity] of capacities.entries()) {
    const input = Array.from({ length: capacity }, (_, n) => String.fromCharCode(33 + n * 17 % 94)).join('');
    const svg = tabQrSvg(input);
    const size = 29 + 4 * i;
    assert.match(svg, new RegExp(`viewBox="0 0 ${size} ${size}"`));
    assert.equal(readQR(svg)?.data, input, `version ${i + 1}`);
  }
  assert.throws(() => tabQrSvg('A'.repeat(667)), /too long/);
});

async function trip(t0) {
  const env = await setup(t0, { hosted: true, billing: { freeMessages: 1, freePeriod: 'day' } });
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna', { status: 503 });
  const tom = await owner(env, t0, 'tom@example.com', 'tom', { status: 503 });
  t0.after(() => { for (const bot of [ben, anna, tom]) rmSync(bot.home, { recursive: true, force: true }); });
  await connect(ben, anna, 'Ben');
  await connect(ben, tom, 'Ben');
  const made = await ben.cli('group', 'new', 'Croatia trip', 'anna', 'tom');
  const gid = made.match(/\(number (\d+)\)/)[1];
  for (const p of [anna, tom]) {
    env.advance(1_000);
    const bot = env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(p.botId));
    env.relay.groups.join(bot, Number(gid), { byOwner: true });
  }
  for (const p of [anna, tom]) await p.cli('inbox');
  const bill = JSON.parse(await anna.cli('tab', 'add', gid, '--amount=62', '--currency=EUR', '--people=@tom', '--what=Dinner'));
  await anna.cli('tab', 'close', gid, bill.id);
  await tom.cli('inbox');
  await anna.cli('tab', 'payto', 'set', '--iban', EUR_IBAN, '--name', 'Anna Novak', '--revolut', 'anna12');
  return { env, anna, tom, gid };
}

function paymentRows(env) {
  return env.relay.db.prepare("SELECT * FROM messages WHERE kind IN ('tab_payto','tab_payto_reply') ORDER BY rowid").all();
}

function assertSealed(row) {
  assert.match(row.sealed, /^b2b1\./);
  assert.doesNotMatch(row.sealed, /Anna|Croatia|DE893704|anna12/);
  assert.equal(row.text, '');
  assert.equal(row.group_id, null);
  assert.equal(row.next_ring_at, null);
}

async function mcpPay(bot, group) {
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    env: { ...process.env, B2B_HOME: bot.home },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  const output = [], errors = [];
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => errors.push(chunk));
  child.stdin.end([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'tab_pay', arguments: { group, to: '@anna' } } },
  ].map((m) => JSON.stringify(m) + '\n').join(''));
  assert.equal(await done, 0, Buffer.concat(errors).toString());
  const [list, call] = Buffer.concat(output).toString().trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(list.result.tools.some((tool) => tool.name === 'tab_pay'));
  assert.equal(call.result.isError, false);
  return call.result.structuredContent;
}

test('Group-only bots exchange sealed details without waking the agent or using the free allowance', async (t0) => {
  const { env, anna, tom, gid } = await trip(t0);
  const before = (await tom.api('GET', '/v1/me')).json.plan.used_in_period;
  const profile = join(anna.home, 'tab-payto.json');
  assert.equal(statSync(profile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await anna.cli('tab', 'payto', 'show')).iban, EUR_IBAN);
  assert.match(await anna.cli('whoami'), /Free plan: 1\/1 messages sent today/);
  assert.equal((await anna.api('GET', '/v1/contacts')).json.contacts.some((c) => c.handle === '@tom'), false);
  const pay = tom.cli('tab', 'pay', gid, '@anna', '--json');
  const [request] = await waitFor(() => { const rows = paymentRows(env); return rows.length ? rows : null; });
  assertSealed(request);
  anna.routine.status = 429;
  const recipient = env.relay.db.prepare('SELECT * FROM bots WHERE id = ?').get(Number(anna.botId));
  assert.equal((await env.relay.ring(recipient, 'pending', { floorMs: 0 })).status, 429);
  assert.equal(paymentRows(env)[0].next_ring_at, null, 'retrying an unrelated doorbell keeps Tab messages silent');
  assert.equal((await anna.api('GET', '/v1/me')).json.inbox_ready, 0);
  assert.deepEqual((await anna.api('POST', '/v1/inbox/claim', { devices: 1 })).json.messages, [], 'old clients never claim silent requests');

  const watcher = spawn(process.execPath, [CLI, 'watch', '--command', '/usr/bin/true'], {
    env: { ...process.env, HOME: anna.home, B2B_HOME: anna.home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t0.after(() => watcher.kill());
  let watcherOut = '';
  watcher.stdout.on('data', (chunk) => { watcherOut += chunk; });
  watcher.stderr.on('data', (chunk) => { watcherOut += chunk; });
  const result = JSON.parse(await pay);
  assert.equal(result.status, 'ready', watcherOut);
  assert.deepEqual(result.options, [{ kind: 'epc', payload: EPC }, { kind: 'revolut', payload: 'https://revolut.me/anna12' }]);
  assert.equal(result.confirmCommand, `b2b tab paid ${gid} @anna 31.00 EUR`);
  assert.equal(statSync(result.qrPath).mode & 0o777, 0o600);
  assert.equal(readQR(readFileSync(result.qrPath, 'utf8'))?.data, EPC);
  const rows = paymentRows(env);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].to_bot, Number(tom.botId));
  assert.equal(rows[1].reply_to, request.id);
  assert.ok(rows.every((r) => r.status === 'delivered' && !r.sealed && !r.first_rung_at && !r.ring_count));
  const viaMcp = await mcpPay(tom, gid);
  assert.deepEqual(viaMcp.options, result.options);
  assert.equal(readQR(readFileSync(viaMcp.qrPath, 'utf8'))?.data, EPC);
  assert.doesNotMatch(watcherOut, /agent ran|ring:|starting "/);
  assert.equal((await anna.api('GET', '/v1/me')).json.plan.used_in_period, 1);
  assert.equal((await tom.api('GET', '/v1/me')).json.plan.used_in_period, before);
  watcher.kill();

  await anna.cli('tab', 'payto', 'clear');
  assert.equal(existsSync(profile), false);
  assert.match(await anna.cli('tab', 'payto', 'show'), /haven't set payment details/);
});

test('A requester who leaves before the sealed request is read receives no details', async (t0) => {
  const { env, anna, tom, gid } = await trip(t0);
  const pay = tom.cli('tab', 'pay', gid, '@anna', '--json');
  await waitFor(() => paymentRows(env).length);
  await tom.cli('group', 'leave', gid);
  const inbox = await anna.cli('inbox');
  assert.doesNotMatch(inbox, /tab_payto|DE893704|Anna Novak/);
  const result = JSON.parse(await pay);
  assert.equal(result.status, 'unset');
  assert.deepEqual(result.options, []);
  assert.equal(result.qrPath, null);
  assert.equal(paymentRows(env).length, 2, 'a sealed refusal went only to the requester');
  await assert.rejects(tom.cli('tab', 'pay', gid, '@anna', '--amount=31'), /no group|both need to be in this group/);
});

test('Unattended runs cannot change payment details or mark a settlement paid or received', async () => {
  const env = { ...process.env, B2B_UNATTENDED: '1' };
  for (const args of [
    ['payto', 'set', '--revolut=anna12'],
    ['payto', 'clear'],
    ['paid', '1', '@anna', '10.00', 'EUR'],
    ['got', '--signed-phone', '--', '1', 'te_example'],
  ]) {
    await assert.rejects(exec(process.execPath, [CLI, 'tab', ...args], { env }), /Ask your owner to do this in a session they opened/);
  }
});
