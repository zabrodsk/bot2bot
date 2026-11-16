// Private simulator only. These tests never contact real bots or email services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { setup, owner, connectHandled, browser } from './helpers.mjs';
import { HISTORY_SCRIPT, HISTORY_CSP } from '../group-browser-page.mjs';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'cli', 'b2b.mjs');
async function fixture(t) {
  const env = await setup(t);
  const ann = await owner(env, t, 'ann@example.com', 'ann', { status: 503 });
  const ben = await owner(env, t, 'ben@example.com', 'ben', { status: 503 });
  await connectHandled(ann, ben, 'ben');
  const gid = Number((await ann.cli('group', 'new', 'Private review', '@ben')).match(/number (\d+)/)[1]);
  await ben.b(`/app/groups/${gid}/join`, { method: 'POST', form: { bot: ben.botId } });
  return { env, ann, ben, gid, q: (sql) => env.relay.db.prepare(sql) };
}
const publicKey = async () => {
  const keys = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
  return Buffer.from(await webcrypto.subtle.exportKey('spki', keys.publicKey)).toString('base64url');
};
const create = (a, gid, key) => a.b('/app/group-browser', { method: 'POST', form: { bot: a.botId, group: gid, public_key: key } });
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.dataset = {}; this.hidden = false; this.value = ''; this._text = ''; }
  set textContent(s) { this._text = String(s); this.children = []; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(type, fn) { this.events[type] = fn; }
}
function client(a, gid, { crypto = webcrypto } = {}) {
  const els = Object.fromEntries(['history', 'status', 'start', 'cancel', 'command', 'messages', 'pair', 'copy', 'unlock', 'confirmation', 'open'].map((id) => [id, new Element(id)]));
  const config = JSON.parse(readFileSync(join(a.home, 'config.json')));
  els.history.dataset = { bot: a.botId, group: String(gid), sign: config.keys.sign.x };
  let seq = 0;
  const timers = new Map(), calls = [], pageEvents = {};
  vm.runInNewContext(HISTORY_SCRIPT, {
    document: { getElementById: (id) => els[id], createElement: (tag) => new Element(tag) },
    crypto, TextEncoder, TextDecoder, Uint8Array, Date, URLSearchParams, btoa, atob,
    navigator: { clipboard: { writeText: async () => {} }, sendBeacon: () => true },
    addEventListener: (e, fn) => { pageEvents[e] = fn; },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id),
    fetch: async (path, opts) => {
      calls.push({ path, body: opts.body?.toString() });
      const r = await a.b(path, { method: opts.method, ...(opts.body ? { form: Object.fromEntries(opts.body) } : {}) });
      return { ok: r.status === 200, status: r.status, json: async () => r.json() };
    },
  });
  return { els, calls, timers, pageEvents, click: (id) => els[id].events.click(), async poll() { const next = [...timers].find(([, t]) => t.ms <= 2000); assert.ok(next); timers.delete(next[0]); await next[1].fn(); } };
}

test('owner-paired browser verifies and decrypts incoming and own group history without relay plaintext', async (t) => {
  const { env, ann, ben, gid, q } = await fixture(t);
  const dangerous = '<img src=x onerror=alert(1)> SECRET SNAPSHOT';
  await ben.cli('group', 'send', String(gid), dangerous);
  await ann.cli('group', 'send', String(gid), 'Own private message');
  const page = await ann.b(`/app/groups/${gid}/history?bot=${ann.botId}`);
  assert.equal(page.status, 200); assert.match(page.text, /Open private history/);
  assert.doesNotMatch(page.text, /posthog|analytics\.js|SECRET SNAPSHOT|Own private message|class="in"/);
  assert.match((await ann.b(`/app/groups/${gid}?bot=${ann.botId}`)).text, new RegExp(`/app/groups/${gid}/history`));
  assert.ok(HISTORY_CSP.includes(`'sha256-${createHash('sha256').update(HISTORY_SCRIPT).digest('base64')}'`));
  q("UPDATE users SET lang = 'cs' WHERE email = ?").run('ann@example.com');
  const czech = await ann.b(`/app/groups/${gid}/history?bot=${ann.botId}`);
  assert.match(czech.text, /<html lang="cs">/); assert.match(czech.text, /id="start">Otevřít soukromou historii</);
  assert.match((await ann.b(`/app/groups/${gid}?bot=${ann.botId}`)).text, /Otevřít soukromou historii<\/a>/);
  const ui = client(ann, gid);
  ui.els.history.dataset.lang = 'cs';
  await ui.click('start');
  const [request, fingerprint] = ui.els.command.textContent.match(/(ghv_[\w-]+) ([a-f0-9]{64})/).slice(1);
  const out = await ann.cli('group', 'browser', String(gid), request, fingerprint);
  assert.doesNotMatch(out, /SECRET SNAPSHOT|Own private message/);
  const code = out.match(/confirmation code.*: ([a-f0-9-]{27})/)[1];
  const row = q('SELECT * FROM group_browser_views WHERE id = ?').get(request);
  assert.doesNotMatch(JSON.stringify(row), /SECRET SNAPSHOT|Own private message/);
  const cfg = JSON.parse(readFileSync(join(ann.home, 'config.json')));
  for (const value of [cfg.token, cfg.keys.sign.d, cfg.keys.box.d]) assert.ok(!JSON.stringify(row).includes(value));
  const posts = q('SELECT text,self_sealed FROM group_posts WHERE group_id = ? AND kind = ?').all(gid, 'note');
  assert.ok(posts.every((p) => !p.text && p.self_sealed?.startsWith('b2b1.')));
  await ui.poll();
  assert.equal(ui.els.messages.textContent, '', 'messages require the code from the genuine bot');
  assert.equal(ui.els.unlock.hidden, false);
  ui.els.confirmation.value = '000000-000000-000000-000000'; await ui.click('open');
  assert.equal(ui.els.messages.textContent, '');
  ui.els.confirmation.value = code; await ui.click('open');
  assert.match(ui.els.messages.textContent, /SECRET SNAPSHOT/);
  assert.match(ui.els.messages.textContent, /Own private message/);
  assert.equal(ui.els.messages.children.length, 2);
  assert.ok(ui.els.messages.children.every((row) => row.children.every((e) => e.tag === 'p')), 'untrusted strings never become elements');
  assert.equal(q('SELECT count(*) AS n FROM group_browser_views').get().n, 0, 'ciphertext is deleted after download');
  assert.ok(ui.calls.every((c) => !c.body?.includes(code) && !c.body?.includes('SECRET SNAPSHOT')), 'confirmation and plaintext stay in browser');
  ui.click('cancel'); assert.equal(ui.els.messages.textContent, '');
  env.advance(8 * 86_400_000); env.relay.retention();
  assert.ok(q('SELECT self_sealed FROM group_posts WHERE group_id = ?').all(gid).every((p) => p.self_sealed == null));
});

test('browser requests are owner, bot and joined-group scoped; expired requests and duplicate uploads fail', async (t) => {
  const { env, ann, ben, gid, q } = await fixture(t);
  const key = await publicKey();
  const response = await create(ann, gid, key); assert.equal(response.status, 200);
  const r = response.json();
  assert.equal((await ben.b('/app/group-browser/' + r.id)).status, 404);
  assert.equal((await ben.b('/app/group-browser/' + r.id + '/cancel', { method: 'POST', form: {} })).status, 404);
  assert.equal((await ben.api('GET', '/v1/group-browser/' + r.id)).status, 404);
  assert.equal((await ben.b('/app/group-browser', { method: 'POST', form: { bot: ann.botId, group: gid, public_key: key } })).status, 403);
  assert.equal((await browser(env.url)(`/app/groups/${gid}/history?bot=${ann.botId}`)).status, 303);
  await assert.rejects(ann.cli('group', 'browser', String(gid), r.id, '0'.repeat(64)), /pairing does not match/);
  await assert.rejects(run(process.execPath, [CLI, 'group', 'browser', String(gid), r.id, r.fingerprint], { env: { ...process.env, B2B_HOME: ann.home, B2B_UNATTENDED: '1' } }), /Only your owner may pair/);
  assert.equal((await ann.api('POST', '/v1/group-browser/' + r.id, { text: 'must never store plaintext' })).status, 400);
  const fake = { key: Buffer.alloc(256).toString('base64url'), iv: Buffer.alloc(12).toString('base64url'), ciphertext: Buffer.alloc(16).toString('base64url'), signature: Buffer.alloc(64).toString('base64url') };
  assert.equal((await ann.api('POST', '/v1/group-browser/' + r.id, { ...fake, ciphertext: Buffer.alloc(49 * 1024).toString('base64url') })).status, 400);
  assert.equal((await ann.api('POST', '/v1/group-browser/' + r.id, fake)).status, 200);
  assert.equal((await ann.api('POST', '/v1/group-browser/' + r.id, fake)).status, 409);
  assert.equal((await ann.api('GET', '/v1/group-browser/' + r.id)).status, 409);
  env.advance(16 * 60_000); env.relay.retention();
  assert.equal((await ann.b('/app/group-browser/' + r.id)).status, 404);
  assert.equal(q('SELECT count(*) AS n FROM group_browser_views').get().n, 0);
  q("UPDATE group_members SET state = 'invited' WHERE group_id = ? AND bot_id = ?").run(gid, Number(ben.botId));
  assert.equal((await create(ben, gid, key)).status, 403);
  const fresh = (await create(ann, gid, key)).json();
  q("UPDATE group_members SET state = 'left' WHERE group_id = ? AND bot_id = ?").run(gid, Number(ann.botId));
  assert.equal((await ann.api('GET', '/v1/group-browser/' + fresh.id)).status, 404);
  assert.equal((await ann.b('/app/group-browser/' + fresh.id)).status, 404);
});

test('browser cancellation during key generation cannot revive a cancelled view', async () => {
  let release;
  const generated = new Promise((resolve) => { release = resolve; });
  // No network call is needed before cancellation, so the fake owner contains only public test keys.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const a = { botId: '1', home: mkdtempSync(join(tmpdir(), 'b2b-history-cancel-')), b: () => { throw new Error('A cancelled view reached the relay'); } };
  writeFileSync(join(a.home, 'config.json'), JSON.stringify({ keys: { sign: { x: 'unused' } } }));
  const ui = client(a, 1, { crypto: { subtle: { generateKey: () => generated } } });
  const starting = ui.click('start'); ui.click('cancel');
  release({ privateKey: {}, publicKey: {} }); await starting;
  assert.equal(ui.els.command.textContent, ''); assert.equal(ui.calls.length, 0); assert.equal(ui.timers.size, 0);
  assert.equal(ui.els.start.disabled, false);
});

test('modified ciphertext is never rendered, and account deletion erases snapshots and sent private copies', async (t) => {
  const { ann, gid, q } = await fixture(t);
  await ann.cli('group', 'send', String(gid), 'Delete this private copy');
  const ui = client(ann, gid); await ui.click('start');
  const [id, fingerprint] = ui.els.command.textContent.match(/(ghv_[\w-]+) ([a-f0-9]{64})/).slice(1);
  await ann.cli('group', 'browser', String(gid), id, fingerprint);
  const envelope = JSON.parse(q('SELECT envelope FROM group_browser_views WHERE id = ?').get(id).envelope);
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64url'); ciphertext[0] ^= 1;
  envelope.ciphertext = ciphertext.toString('base64url');
  q('UPDATE group_browser_views SET envelope = ? WHERE id = ?').run(JSON.stringify(envelope), id);
  await ui.poll();
  assert.equal(ui.els.messages.textContent, ''); assert.equal(ui.els.unlock.hidden, true);
  assert.match(ui.els.status.textContent, /signature did not match/);
  const next = (await create(ann, gid, await publicKey())).json();
  assert.ok(next.id);
  assert.equal((await ann.b('/app/account/delete', { method: 'POST', form: { confirm: 'ann@example.com' } })).status, 200);
  assert.equal(q('SELECT count(*) AS n FROM group_browser_views WHERE bot_id = ?').get(Number(ann.botId)).n, 0);
  assert.ok(q('SELECT self_sealed FROM group_posts WHERE from_bot = ?').all(Number(ann.botId)).every((p) => p.self_sealed == null));
});

test('a cancelled pending request response cannot replace a newer browser pairing', async (t) => {
  const { ann, gid, q } = await fixture(t);
  let release, waiting = new Promise((resolve) => { release = resolve; });
  let first = true, sawCreate;
  const created = new Promise((resolve) => { sawCreate = resolve; });
  const originalBrowser = ann.b;
  const delayed = { ...ann, b: async (path, options) => {
    const result = await originalBrowser(path, options);
    if (path === '/app/group-browser' && first) { first = false; sawCreate(); await waiting; }
    return result;
  } };
  const ui = client(delayed, gid);
  const one = ui.click('start'); await created;
  ui.click('cancel'); await ui.click('start');
  const newCommand = ui.els.command.textContent;
  assert.match(newCommand, /group browser/);
  release(); await one;
  assert.equal(ui.els.command.textContent, newCommand);
  assert.equal(q('SELECT count(*) AS n FROM group_browser_views').get().n, 1, 'the cancelled late response is removed');
  assert.equal(ui.els.start.disabled, true);
});

test('an old poll cannot display a snapshot after cancellation or disturb a new view', async (t) => {
  const { ann, gid } = await fixture(t);
  let release, arrived;
  const gate = new Promise((resolve) => { release = resolve; });
  const received = new Promise((resolve) => { arrived = resolve; });
  let delay = true;
  const delayed = { ...ann, b: async (path, options) => {
    const result = await ann.b(path, options);
    if (delay && /^\/app\/group-browser\/ghv_/.test(path) && options?.method === 'GET') { delay = false; arrived(); await gate; }
    return result;
  } };
  const ui = client(delayed, gid); await ui.click('start');
  const [id, fingerprint] = ui.els.command.textContent.match(/(ghv_[\w-]+) ([a-f0-9]{64})/).slice(1);
  await ann.cli('group', 'browser', String(gid), id, fingerprint);
  const oldPoll = ui.poll(); await received;
  ui.click('cancel'); await ui.click('start');
  const command = ui.els.command.textContent;
  release(); await oldPoll;
  assert.equal(ui.els.command.textContent, command);
  assert.equal(ui.els.messages.textContent, ''); assert.equal(ui.els.unlock.hidden, true);
  assert.equal(ui.els.start.disabled, true);
});

test('the optional self copy does not break a large group message that already fits the relay limit', async (t) => {
  const { env, ann, gid, q } = await fixture(t);
  const cara = await owner(env, t, 'cara@example.com', 'cara', { status: 503 });
  await connectHandled(ann, cara, 'cara');
  await ann.cli('group', 'add', String(gid), '@cara');
  await cara.b(`/app/groups/${gid}/join`, { method: 'POST', form: { bot: cara.botId } });
  const links = Array.from({ length: 5 }, (_, i) => `--link=https://example.com/${i}/${'a'.repeat(1940)}`);
  const out = await ann.cli('group', 'send', String(gid), '文'.repeat(8000), ...links);
  assert.match(out, /Sent gp_[\w-]+ to 2 people/);
  const row = q("SELECT * FROM group_posts WHERE group_id = ? AND kind = 'note' ORDER BY rowid DESC LIMIT 1").get(gid);
  assert.equal(row.self_sealed, null); assert.equal(row.text, null); assert.equal(row.sealed, 1);
  assert.equal(q('SELECT count(*) AS n FROM messages WHERE group_post = ? AND sealed IS NOT NULL').get(row.id).n, 2);
});
