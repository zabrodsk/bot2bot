// Approve from your phone (issue #10). The owner's phone page runs here as it is (its real script, Node's WebCrypto,
// a small stand-in for the page's elements), against a local relay, and the real tool is the agent's hook.
// No real bot, agent, phone or push service is used.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createPublicKey, verify, randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { setup, owner, waitFor, sleep, listen } from './helpers.mjs';
import { PHONE_SCRIPT, PHONE_CSP } from '../phone-page.mjs';
import { phoneCode } from '../phone.mjs';

const run = promisify(execFile);
const CLI = join(import.meta.dirname, '..', 'cli', 'b2b.mjs');
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
  find(pred) { for (const c of this.children) { if (pred(c)) return c; const d = c.find(pred); if (d) return d; } return null; }
}
// The owner's phone: the page's own script, with this browser's keys kept in a stand-in for IndexedDB.
async function phoneOf(who, { lang = 'en', store = new Map() } = {}) {
  const els = Object.fromEntries(IDS.map((id) => [id, new Element(id)]));
  els.phone.dataset = { lang, vapid: 'x' };
  let seq = 0;
  const timers = new Map(), calls = [];
  const req = (run_) => { const r = {}; queueMicrotask(() => { try { r.result = run_(); r.onsuccess?.(); } catch (e) { r.error = e; r.onerror?.(); } }); return r; };
  const db = { createObjectStore() {}, transaction() { const t = { objectStore: () => ({ get: (k) => req(() => store.get(k)), put: (v, k) => { store.set(k, v); queueMicrotask(() => t.oncomplete?.()); }, delete: (k) => { store.delete(k); queueMicrotask(() => t.oncomplete?.()); } }) }; return t; } };
  const doc = { visibilityState: 'visible', getElementById: (id) => els[id] ?? assert.fail(`no element ${id}`), createElement: (tag) => new Element(tag), addEventListener() {} };
  vm.runInNewContext(PHONE_SCRIPT, {
    document: doc, crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array, URLSearchParams, btoa, atob, queueMicrotask,
    indexedDB: { open: () => { const r = req(() => db); return r; } },
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)', clipboard: { writeText: async () => {} } },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id),
    fetch: async (path, opts) => {
      calls.push({ path, body: opts.body?.toString() });
      const r = await who.b(path, { method: opts.method, ...(opts.body ? { form: Object.fromEntries(opts.body) } : {}) });
      return { ok: r.status === 200, status: r.status, type: 'basic', json: async () => r.json() };
    },
  });
  const fire = async (ms) => { const next = [...timers].find(([, t]) => t.ms === ms); assert.ok(next, `a ${ms} ms timer`); timers.delete(next[0]); await next[1].fn(); };
  const settle = async () => { for (let i = 0; i < 20; i++) await sleep(10); };
  await settle();
  const phone = { els, calls, timers, store, settle,
    check: async () => { await fire(3000); await settle(); },       // the page looks again, as it does every few seconds
    passUndo: async () => { await fire(4000); await settle(); },    // the Undo passes and the action goes out
    button: (text) => els.cards.find((e) => e.tag === 'button' && e.textContent === text),
    text: () => els.cards.textContent,
    async waitFor(pred, ms = 8000) { const end = Date.now() + ms; for (;;) { await phone.check(); if (pred()) return; if (Date.now() > end) throw new Error(`timed out; the phone shows: ${phone.text()}`); await sleep(60); } },
    async setUp() { await els.start.click(); await settle(); return els.say.textContent.match(/code ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1]; },
  };
  return phone;
}
const cliIn = (home, env = {}) => async (...a) => {
  try { const r = await run(process.execPath, [CLI, ...a], { env: { ...process.env, B2B_HOME: home, HOME: home, CODEX_HOME: join(home, '.codex'), B2B_UNATTENDED: '', ...env } }); return { code: 0, out: r.stdout + r.stderr }; }
  catch (e) { return { code: e.code, out: `${e.stdout}${e.stderr}` }; }
};
// The agent's hook: what the agent hands it on stdin, and what it prints when it's done.
const running = new Set();
afterEach(() => { for (const p of running) p.kill(); running.clear(); });
function hook(home, what, input, { idle = '600', env = {}, agent = 'claude-code' } = {}) {
  const idleFile = join(home, 'idle');
  writeFileSync(idleFile, idle);
  const p = spawn(process.execPath, [CLI, 'phone', 'hook', what, '--agent', agent], { env: { ...process.env, B2B_HOME: home, HOME: home, B2B_UNATTENDED: '', B2B_IDLE_FILE: idleFile, ...env } });
  running.add(p);
  let out = '';
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { out += c; });
  const done = new Promise((ok) => p.on('close', (code) => { running.delete(p); let json = null; try { json = out.trim() ? JSON.parse(out.trim()) : null; } catch { /* not JSON: the test shows it */ } ok({ code, out, json }); }));
  p.stdin.end(JSON.stringify({ session_id: 'session-0001', cwd: home, hook_event_name: what === 'stop' ? 'Stop' : 'PermissionRequest', ...input }));
  return { done, setIdle: (v) => writeFileSync(idleFile, String(v)), kill: () => p.kill() };
}
const cards = (env) => env.relay.db.prepare('SELECT * FROM phone_cards ORDER BY created_at').all();
const forOwner = (home) => { try { return JSON.parse(readFileSync(join(home, 'for-owner.json'), 'utf8')).lines.map((l) => l.line); } catch { return []; } };
// Cara's bot (Claude Code), her phone set up and linked.
async function linked(t, opts = {}) {
  const env = await setup(t, opts);
  const cara = await owner(env, t, 'cara@example.com', 'cara', { status: 503 });
  const cli = cliIn(cara.home);
  const phone = await phoneOf(cara);
  const code = await phone.setUp();
  const link = await cli('phone', 'link', code, '--agent', 'claude-code');
  assert.equal(link.code, 0, link.out);
  await phone.check();
  return { env, cara, cli, phone, code, link };
}

test('the phone page: its own keys, a code to read to your agent, and nothing from another site', async (t) => {
  const env = await setup(t);
  const cara = await owner(env, t, 'cara@example.com', 'cara', { status: 503 });
  const cli = cliIn(cara.home);
  // Signed out, the page is the sign-in page.
  assert.ok([302, 303].includes((await fetch(`${env.url}/app/phone`, { redirect: 'manual' })).status));
  const page = await fetch(`${env.url}/app/phone`, { headers: { cookie: (await (async () => { const r = await cara.b('/app/phone'); assert.equal(r.status, 200); return ''; })()) } }).catch(() => null);
  void page;
  const html = (await cara.b('/app/phone')).text;
  assert.match(html, /<h1>Approve from your phone<\/h1>/);
  assert.ok(html.includes(PHONE_SCRIPT), 'the page runs exactly the script tested here');
  assert.match(PHONE_CSP, /^default-src 'none'; script-src 'sha256-[A-Za-z0-9+/=]+'; style-src 'unsafe-inline'; connect-src 'self'/);
  assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/, 'nothing is loaded from another site');
  assert.equal((await cara.b('/app/phone/manifest.webmanifest')).json().start_url, '/app/phone');
  assert.match((await cara.b('/app/phone/sw.js')).text, /showNotification\('bot2bot'/);

  // Before any phone is set up, the bot says how to get a code, and a made-up code links nothing.
  assert.match((await cli('phone')).out, /No phone is linked\. Your owner opens http:\/\/127\.0\.0\.1:\d+\/app\/phone on their phone, taps "Set up this phone" and tells you the code/);
  assert.match((await cli('phone', 'link', 'ABCD-EFGH-JKLM')).out, /None of your owner's phones shows that code[^]*none is set up yet/);

  const phone = await phoneOf(cara);
  assert.equal(phone.els.setup.hidden, false);
  const code = await phone.setUp();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(phone.els.say.textContent, `Link my phone, code ${code}`);
  assert.equal(phone.els.setup.hidden, true);
  // The secret halves of the keys can't be read out of the browser, and the relay has only the public ones.
  const kept = phone.store.get('device');
  assert.equal(kept.sign.privateKey.extractable, false); assert.equal(kept.box.privateKey.extractable, false);
  const row = env.relay.db.prepare('SELECT * FROM phone_devices').get();
  assert.equal(row.name, 'iPhone'); assert.equal(row.code, code); assert.equal(phoneCode(row.sign_pub, row.box_pub), code);

  // Linking: the owner reads the code to their agent at the keyboard. A run nobody watches can't link a phone.
  assert.match((await cliIn(cara.home, { B2B_UNATTENDED: '1' })('phone', 'link', code)).out, /Only your owner changes this/);
  assert.match((await cli('phone', 'link', 'ZZZZ-ZZZZ-ZZZZ')).out, /None of your owner's phones shows that code/);
  const link = await cli('phone', 'link', code.toLowerCase().replace(/-/g, ' '), '--agent', 'claude-code');
  assert.match(link.out, new RegExp(`^Linked your owner's iPhone \\(${code}\\)\\. Only that phone can approve for them now\\.`));
  assert.match(link.out, /Claude Code asks through two hooks added to ~\/\.claude\/settings\.json[^]*Never asked on the phone: deleting data, force pushes, secrets, production deploys and sudo/);
  const settings = JSON.parse(readFileSync(join(cara.home, '.claude', 'settings.json'), 'utf8'));
  for (const [event, what] of [['PermissionRequest', 'permission'], ['Stop', 'stop']]) {
    assert.equal(settings.hooks[event].length, 1);
    assert.match(settings.hooks[event][0].hooks[0].command, new RegExp(`^B2B_HOME=\\S+ .* phone hook ${what} --agent claude-code$`));
    assert.equal(settings.hooks[event][0].hooks[0].timeout, 1860);
  }
  await phone.check();
  assert.equal(phone.els.linked.textContent, 'Linked with @cara.');
  assert.equal(phone.els.empty.hidden, false);
  assert.match((await cli('phone')).out, new RegExp(`^Linked: iPhone \\(${code}\\)\\.\\nMode auto[^]*Claude Code asks the phone through its PermissionRequest and Stop hooks`));
  // In Czech, for an owner who reads Czech.
  const cz = await phoneOf(cara, { lang: 'cs', store: phone.store });
  assert.equal(cz.els.say.textContent, `Propoj můj telefon, kód ${code}`);
});

test('blocked agent, owner away: a card on the phone, one tap, and the agent goes on', async (t) => {
  const { env, cara, phone } = await linked(t);
  const t0 = Date.now();
  const h = hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm publish --tag next', description: 'Publish @acme/leads 1.4.0' } });
  await phone.waitFor(() => !!phone.button('Approve once'));
  assert.match(phone.text(), /^Claude Code · .*wants to runnpm publish --tag next/);
  assert.match(phone.text(), /Publish @acme\/leads 1\.4\.0/);
  // The relay holds a card it can't read.
  const [card] = cards(env);
  assert.equal(card.kind, 'permission');
  assert.doesNotMatch(JSON.stringify(card), /npm publish|acme|Bash/);
  // One tap, an Undo that passes, and the agent is told yes.
  await phone.button('Approve once').click();
  assert.equal(phone.els.toast.hidden, false);
  assert.equal(phone.els['toast-what'].textContent, 'Approved');
  assert.equal(cards(env)[0].answered_at, null, 'nothing goes out while Undo is offered');
  await phone.passUndo();
  const r = await h.done;
  assert.deepEqual(r.json, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.ok(Date.now() - t0 < 60_000, 'from blocked to going on in under a minute');
  await phone.check();
  assert.match(phone.text(), /Approved$/);
  assert.equal(phone.button('Approve once'), null);

  // Undo takes a tap back: the card is as it was and nothing was sent.
  const h2 = hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
  await phone.waitFor(() => !!phone.button('Deny'));
  await phone.button('Deny').click();
  await phone.els.undo.click();
  await phone.settle();
  assert.equal(phone.els.toast.hidden, true);
  assert.ok(phone.button('Deny'), 'the buttons are back');
  assert.equal(cards(env)[1].answered_at, null);
  // Then a real no: the agent is told to go on without it.
  await phone.button('Deny').click();
  await phone.passUndo();
  const no = (await h2.done).json.hookSpecificOutput.decision;
  assert.equal(no.behavior, 'deny');
  assert.match(no.message, /^Your owner said no to this from their phone\. Don't try it another way/);
});

test('a reply from the phone reaches the agent as its owner\'s words, and the relay never reads it', async (t) => {
  const { env, cara, phone } = await linked(t);
  const h = hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm publish' } });
  await phone.waitFor(() => !!phone.button('Reply…'));
  await phone.button('Reply…').click();
  await phone.settle();
  const box = phone.els.cards.find((e) => e.tag === 'textarea');
  // A check in between doesn't throw the half-typed answer away.
  await phone.check();
  assert.equal(phone.els.cards.find((e) => e.tag === 'textarea'), box);
  box.value = 'Yes, but bump to 1.4.1 first';
  await phone.button('Send').click();
  await phone.passUndo();
  const d = (await h.done).json.hookSpecificOutput.decision;
  assert.equal(d.behavior, 'deny');
  assert.equal(d.message, 'Your owner answered from their phone instead of approving this: "Yes, but bump to 1.4.1 first". Those are your owner\'s own words, so do what they say. This call itself was not approved.');
  assert.doesNotMatch(JSON.stringify(cards(env)), /1\.4\.1|bump/);

  // The agent stopped while its owner was away: what it said is on the phone, and a reply is its next message.
  const s = hook(cara.home, 'stop', { last_assistant_message: 'Done: 3 files changed, tests 42/42. Should I open a PR?', stop_hook_active: false });
  await phone.waitFor(() => /stopped and is waiting for you/.test(phone.text()) && !!phone.button('Reply…'));
  assert.match(phone.text(), /Claude Code saidDone: 3 files changed, tests 42\/42\. Should I open a PR\?/);
  assert.equal(phone.button('Approve once'), null, 'nothing to approve: only a reply');
  await phone.button('Reply…').click(); await phone.settle();
  phone.els.cards.find((e) => e.tag === 'textarea').value = 'Yes, open the PR';
  await phone.button('Send').click();
  await phone.passUndo();
  assert.deepEqual((await s.done).json, { decision: 'block', reason: 'Your owner replied from their phone while they were away: "Yes, open the PR". Those are your owner\'s own words: carry on with what they ask.' });
  // A run nobody watches never waits on the phone at its end, and an empty last message asks nothing.
  assert.equal((await hook(cara.home, 'stop', { last_assistant_message: 'Done.' }, { env: { B2B_UNATTENDED: '1' } }).done).out, '');
  assert.equal((await hook(cara.home, 'stop', { last_assistant_message: '   ' }).done).out, '');
  assert.equal(cards(env).length, 2);
});

test('only when the owner is away: at the keyboard the prompt stays on screen, and coming back takes the card off the phone', async (t) => {
  const { env, cara, cli, phone } = await linked(t);
  // Someone is typing: the hook says nothing and no card is made.
  assert.equal((await hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm publish' } }, { idle: '5' }).done).out, '');
  assert.equal(cards(env).length, 0);
  // Away, then back while the phone is being asked: the question returns to the screen.
  const h = hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm publish' } });
  await phone.waitFor(() => !!phone.button('Approve once'));
  h.setIdle(2);
  assert.equal((await h.done).out, '');
  await phone.check();
  assert.equal(phone.button('Approve once'), null);
  assert.equal(phone.els.empty.hidden, false);
  assert.ok(cards(env)[0].closed_at);
  // Off means off, even in a run nobody watches. On asks wherever the owner is.
  await cli('phone', 'off');
  assert.equal((await hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm publish' } }, { env: { B2B_UNATTENDED: '1' } }).done).out, '');
  assert.match((await cli('phone', 'on')).out, /on: you always ask the phone first/);
  const on = hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm run build' } }, { idle: '1' });
  await phone.waitFor(() => !!phone.button('Approve once'));
  // Turning it off from another terminal ends the wait.
  await cli('phone', 'off');
  assert.equal((await on.done).out, '');
  assert.match((await cliIn(cara.home, { B2B_UNATTENDED: '1' })('phone', 'on')).out, /Only your owner changes this/);
});

test('no answer is a no: the agent is told to go on with what it can', async (t) => {
  const { env, cara } = await linked(t);
  const p = JSON.parse(readFileSync(join(cara.home, 'phone.json'), 'utf8'));
  writeFileSync(join(cara.home, 'phone.json'), JSON.stringify({ ...p, wait: 0.03 }));
  const d = (await hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm publish' } }).done).json.hookSpecificOutput.decision;
  assert.equal(d.behavior, 'deny');
  assert.match(d.message, /^Your owner didn't answer on their phone within .* so this was not approved\. Don't try it again now/);
  assert.ok(cards(env)[0].closed_at, 'the card leaves the phone');
});

test('keyboard only: deleting data, force pushes, secrets, deploys and sudo are never asked on the phone', async (t) => {
  const { env, cara, cli, phone } = await linked(t);
  const ask = (tool_name, tool_input, opts) => hook(cara.home, 'permission', { tool_name, tool_input }, opts).done;
  for (const command of ['rm -rf build', 'git push --force origin main', 'git push -f', 'cat .env', 'railway up --service relay', 'sudo systemctl restart app', 'psql -c "DROP TABLE leads"', 'git reset --hard HEAD~3', 'terraform apply', 'cat ~/.ssh/id_ed25519']) {
    assert.equal((await ask('Bash', { command })).out, '', `${command}: the prompt on screen waits for the keyboard`);
  }
  assert.equal((await ask('Write', { file_path: '/srv/app/.env.production', content: 'KEY=1' })).out, '');
  // The owner sees on the phone that something waits, with nothing to tap.
  await phone.check();
  assert.match(phone.text(), /wants to runrm -rf build[^]*This one needs you at the keyboard\./);
  assert.equal(phone.button('Approve once'), null);
  assert.ok(cards(env).every((c) => c.kind === 'info' && !c.answered_at));
  // An answer to such a card is refused by the relay as well.
  const kept = phone.store.get('device');
  const tried = await cara.b(`/app/phone/cards/${cards(env)[0].id}/answer`, { method: 'POST', form: { device: kept.id, decision: 'allow', sig: randomBytes(64).toString('base64url') } });
  assert.notEqual(tried.status, 200);
  // In a run nobody watches there is no keyboard: the agent is told to go on without it.
  const un = (await ask('Bash', { command: 'git push --force' }, { env: { B2B_UNATTENDED: '1' } })).json.hookSpecificOutput.decision;
  assert.equal(un.behavior, 'deny');
  assert.match(un.message, /^This waits for your owner at the keyboard, because it is a force push\. It can't be approved from their phone/);
  // Ordinary things do go to the phone.
  for (const command of ['npm publish', 'git push origin main', 'npm run build', 'rmdir empty && ls', 'git push']) {
    const h = hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command } });
    await waitFor(() => cards(env).some((c) => c.kind === 'permission' && !c.closed_at && !c.answered_at), 8000);
    h.setIdle(1); await h.done;
    await waitFor(() => !cards(env).some((c) => c.kind === 'permission' && !c.closed_at && !c.answered_at), 8000);
  }
  // The owner keeps more for the keyboard, for everything or for one project.
  assert.match((await cli('phone', 'rule', 'add', 'npm publish')).out, /Anything matching "npm publish" waits for the keyboard now/);
  assert.equal((await ask('Bash', { command: 'npm publish --tag next' })).out, '');
  assert.match((await cli('phone', 'rule', 'list')).out, /also: "npm publish"/);
  assert.match((await cliIn(cara.home, { B2B_UNATTENDED: '1' })('phone', 'rule', 'remove', 'npm publish')).out, /Only your owner changes this/);
});

test('only the owner\'s linked phone can approve: a bot, the relay, another account and an old answer can not', async (t) => {
  const { env, cara, phone } = await linked(t);
  const dan = await owner(env, t, 'dan@example.com', 'dan', { status: 503 });
  const kept = phone.store.get('device');
  const open = async (command) => { const h = hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command } }); await waitFor(() => cards(env).some((c) => !c.answered_at && !c.closed_at), 8000); return { h, card: cards(env).find((c) => !c.answered_at && !c.closed_at) }; };
  const denied = async (h) => { const r = await h.done; assert.equal(r.json?.hookSpecificOutput.decision.behavior, 'deny', r.out); return r.json.hookSpecificOutput.decision.message; };

  // A bot has no way to answer: not its own card with its own token, and not through the page's address.
  let { h, card } = await open('npm publish');
  for (const who of [cara, dan]) {
    for (const path of [`/app/phone/cards/${card.id}/answer`, `/v1/phone/cards/${card.id}/answer`, `/v1/phone/cards/${card.id}`]) {
      const token = JSON.parse(readFileSync(join(who.home, 'config.json'), 'utf8')).token;
      const r = await fetch(env.url + path, { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', origin: env.url }, body: JSON.stringify({ device: kept.id, decision: 'allow', sig: randomBytes(64).toString('base64url') }) });
      assert.notEqual(r.status, 200, `${path} with a bot's token`);
    }
  }
  assert.equal((await dan.api('GET', `/v1/phone/cards/${card.id}`)).status, 404, "another bot can't even see it");
  // Another person, signed in to their own account with their own phone, can't answer it either.
  const danPhone = await phoneOf(dan); await danPhone.setUp();
  const theirs = danPhone.store.get('device');
  assert.notEqual((await dan.b(`/app/phone/cards/${card.id}/answer`, { method: 'POST', form: { device: theirs.id, decision: 'allow', sig: randomBytes(64).toString('base64url') } })).status, 200);
  assert.equal(cards(env)[0].answered_at, null);

  // The relay itself writes "approved" into its own database: the bot throws it away, because no linked phone signed it.
  env.relay.db.prepare('UPDATE phone_cards SET answer = ?, answered_at = ? WHERE id = ?').run(JSON.stringify({ device: kept.id, decision: 'allow', sig: randomBytes(64).toString('base64url') }), Date.now(), card.id);
  assert.match(await denied(h), /^An answer arrived that your owner's phone did not sign, so it was ignored and this was not approved/);
  assert.match(forOwner(cara.home)[0], /^An answer to a phone request came that none of your linked phones signed, so it was ignored and nothing was approved/);

  // A real approval of one request, copied onto another: refused, since an approval is for one request only.
  const first = await open('npm test');
  await phone.waitFor(() => !!phone.button('Approve once'));
  await phone.button('Approve once').click(); await phone.passUndo();
  assert.equal((await first.h.done).json.hookSpecificOutput.decision.behavior, 'allow');
  const real = JSON.parse(cards(env).find((c) => c.id === first.card.id).answer);
  const second = await open('npm publish --tag latest');
  env.relay.db.prepare('UPDATE phone_cards SET answer = ?, answered_at = ? WHERE id = ?').run(JSON.stringify(real), Date.now(), second.card.id);
  assert.match(await denied(second.h), /did not sign/);

  // A phone the relay adds to the account by itself was never linked at the keyboard: nothing is encrypted to it,
  // and its signature counts for nothing.
  const fake = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const fakeBox = await webcrypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const raw = async (k) => Buffer.from(await webcrypto.subtle.exportKey('raw', k)).toString('base64url');
  env.relay.db.prepare("INSERT INTO phone_devices (id, user_id, name, sign_pub, box_pub, code, created_at) SELECT 'dev_relayaddedphone', user_id, 'iPhone', ?, ?, 'X', ? FROM phone_devices LIMIT 1").run(await raw(fake.publicKey), await raw(fakeBox.publicKey), Date.now());
  const third = await open('npm publish --tag beta');
  assert.deepEqual(Object.keys(JSON.parse(third.card.boxes)), [kept.id]);
  const sig = Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, fake.privateKey, new TextEncoder().encode(`b2b-phone-answer/1|${third.card.id}|${'0'.repeat(64)}|allow|`))).toString('base64url');
  env.relay.db.prepare('UPDATE phone_cards SET answer = ?, answered_at = ? WHERE id = ?').run(JSON.stringify({ device: 'dev_relayaddedphone', decision: 'allow', sig }), Date.now(), third.card.id);
  assert.match(await denied(third.h), /did not sign/);
});

test('push: a notification with no content, signed for the browser\'s push service, and only to a push service', async (t) => {
  const rings = []; let answer = 201;
  const push = await listen((req, res) => { rings.push({ path: req.url, auth: req.headers.authorization, ttl: req.headers.ttl, length: req.headers['content-length'] }); res.writeHead(answer).end(); });
  t.after(() => push.s.close());
  const { env, cara, phone } = await linked(t);
  const kept = phone.store.get('device');
  const set = (endpoint) => cara.b(`/app/phone/devices/${kept.id}/push`, { method: 'POST', form: { endpoint } });
  for (const bad of ['https://evil.example/push', 'http://169.254.169.254/latest', 'https://user:pw@fcm.googleapis.com/x', 'javascript:alert(1)']) assert.notEqual((await set(bad)).status, 200, bad);
  assert.equal((await set('https://fcm.googleapis.com/fcm/send/abc')).status, 200);
  assert.equal((await set('https://web.push.apple.com/QAbc')).status, 200);
  assert.equal((await set(`${push.url}/subscription-1`)).json().push, true);
  const h = hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm publish' } });
  await waitFor(() => rings.length === 1, 8000);
  assert.equal(rings[0].path, '/subscription-1'); assert.equal(rings[0].length, '0', 'no content: what waits is only in the card');
  const [, jwt, key] = rings[0].auth.match(/^vapid t=([\w.-]+), k=([\w-]+)$/);
  const [head, body, sig] = jwt.split('.');
  const raw = Buffer.from(key, 'base64url');
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(`${head}.${body}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  assert.equal(JSON.parse(Buffer.from(body, 'base64url')).aud, push.url);
  assert.equal(key, (await cara.b('/app/phone')).text.match(/data-vapid="([\w-]+)"/)[1], 'the key the page subscribes with');
  h.setIdle(1); await h.done;
  // The browser dropped the subscription: it isn't rung again.
  answer = 410;
  const h2 = hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm publish' } });
  await waitFor(() => rings.length === 2, 8000);
  await waitFor(() => env.relay.db.prepare('SELECT push_endpoint FROM phone_devices WHERE id = ?').get(kept.id).push_endpoint === null, 8000);
  h2.setIdle(1); await h2.done;
});

test('removing a phone, unlinking, Codex hooks next to another tool\'s, and deleting the account', async (t) => {
  const { env, cara, cli, phone, code } = await linked(t);
  // Codex: the hooks go into its hooks.json, beside whatever is there, and the owner is told to trust them.
  mkdirSync(join(cara.home, '.codex'), { recursive: true });
  const other = { hooks: { Stop: [{ matcher: '.*', hooks: [{ type: 'command', command: "'/Applications/Other.app/stop.cjs'" }] }] } };
  writeFileSync(join(cara.home, '.codex', 'hooks.json'), JSON.stringify(other));
  const cx = await cli('phone', 'link', code, '--agent', 'codex');
  assert.match(cx.out, /Codex runs a new hook only once its owner trusts it: ask your owner to type \/hooks in Codex and trust the two bot2bot hooks/);
  const hooks = JSON.parse(readFileSync(join(cara.home, '.codex', 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(hooks.Stop[0], other.hooks.Stop[0]);
  assert.match(hooks.Stop[1].hooks[0].command, / phone hook stop --agent codex$/); assert.equal(hooks.Stop[1].matcher, '.*');
  assert.match(hooks.PermissionRequest[0].hooks[0].command, / phone hook permission --agent codex$/);
  // Codex's hooks get the same answers in the same shape.
  const h = hook(cara.home, 'permission', { tool_name: 'exec_command', tool_input: { cmd: 'cargo publish' }, turn_id: 't1' }, { agent: 'codex' });
  await phone.waitFor(() => !!phone.button('Approve once'));
  assert.match(phone.text(), /^Codex · .*wants to runcargo publish/);
  await phone.button('Approve once').click(); await phone.passUndo();
  assert.deepEqual((await h.done).json, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  // Unlinking takes this bot's hooks out again and leaves the other tool's.
  assert.match((await cli('phone', 'unlink', 'iphone', '--agent', 'codex')).out, /^Unlinked iPhone\. No phone is linked now/);
  assert.deepEqual(JSON.parse(readFileSync(join(cara.home, '.codex', 'hooks.json'), 'utf8')).hooks, other.hooks);
  assert.equal((await hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm publish' } }).done).out, '');
  await phone.check();
  assert.equal(phone.els.linked.textContent, '');

  // Removed on the phone (with an Undo first): its keys are gone from the browser and the relay.
  await cli('phone', 'link', code, '--agent', 'claude-code');
  await phone.els.remove.click(); await phone.settle();
  assert.equal(phone.els['toast-what'].textContent, 'Phone removed');
  await phone.els.undo.click(); await phone.settle();
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM phone_devices').get().n, 1, 'Undo: still there');
  await phone.els.remove.click(); await phone.passUndo();
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM phone_devices').get().n, 0);
  assert.equal(phone.store.get('device'), undefined);
  assert.equal(phone.els.setup.hidden, false);
  // The bot still has it pinned, but there is nobody to ask: the prompt on screen decides.
  assert.equal((await hook(cara.home, 'permission', { tool_name: 'Bash', tool_input: { command: 'npm publish' } }).done).out, '');
  // Deleting the account takes phones and cards with it.
  const again = await phoneOf(cara); await again.setUp();
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM phone_devices').get().n, 1);
  await cara.b('/app/account/delete', { method: 'POST', form: { confirm: 'cara@example.com' } });
  if (env.relay.db.prepare('SELECT count(*) AS n FROM users').get().n === 0 || env.relay.db.prepare("SELECT 1 FROM bots WHERE display_name = 'Deleted user'").get()) assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM phone_devices').get().n, 0);
});

// The same with the real Claude Code as the agent. Off unless B2B_LIVE_CLAUDE=1: it starts one real session on this
// machine's own Claude Code account, against the local relay made here. No other bot or person is involved.
test('live: the real Claude Code, blocked on a command, goes on after a tap, and takes a reply from the phone', { skip: process.env.B2B_LIVE_CLAUDE !== '1' }, async (t) => {
  const { cara, phone } = await linked(t);
  const work = mkdtempSync(join(tmpdir(), 'b2b-live-'));
  // The hooks exactly as "phone link" wrote them, given to this one session only.
  const settings = join(work, 'settings.json');
  writeFileSync(settings, JSON.stringify({ hooks: JSON.parse(readFileSync(join(cara.home, '.claude', 'settings.json'), 'utf8')).hooks }));
  writeFileSync(join(cara.home, 'phone.json'), JSON.stringify({ ...JSON.parse(readFileSync(join(cara.home, 'phone.json'), 'utf8')), wait: 2 }));
  const idle = join(cara.home, 'idle');
  writeFileSync(idle, '600');
  const skipped = ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_ENTRYPOINT', 'B2B_UNATTENDED'];
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !skipped.includes(k))), B2B_IDLE_FILE: idle };
  mkdirSync(join(work, 'proj'));
  const p = spawn('claude', ['-p', 'Run exactly this one shell command with the Bash tool: echo approved-from-phone > proof.txt   Then answer with the single word DONE.', '--settings', settings, '--setting-sources', 'project,local', '--tools', 'Bash', '--strict-mcp-config', '--output-format', 'json'], { cwd: join(work, 'proj'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => p.kill());
  let out = ''; p.stdout.on('data', (c) => { out += c; });
  const exited = new Promise((ok) => p.on('close', ok));
  await phone.waitFor(() => !!phone.button('Approve once'), 90_000);
  const t0 = Date.now();
  assert.match(phone.text(), /Claude Code · proj.*wants to runecho approved-from-phone > proof\.txt/);
  await phone.button('Approve once').click(); await phone.passUndo();
  await waitFor(() => existsSync(join(work, 'proj', 'proof.txt')), 60_000);
  const took = Date.now() - t0;
  assert.ok(took < 60_000, `from the tap to the command running: ${took} ms`);
  // It stops and says so on the phone; a reply there is its owner's next message.
  await phone.waitFor(() => /stopped and is waiting for you/.test(phone.text()) && !!phone.button('Reply…'), 90_000);
  await phone.button('Reply…').click(); await phone.settle();
  phone.els.cards.find((e) => e.tag === 'textarea').value = 'Thanks. Now also say the word PINEAPPLE.';
  await phone.button('Send').click(); await phone.passUndo();
  // It stops again; the owner is back at the keyboard, so the phone is left alone.
  await phone.waitFor(() => /PINEAPPLE/.test(phone.text()), 90_000);
  writeFileSync(idle, '1');
  await exited;
  const result = JSON.parse(out.trim().split('\n').pop());
  assert.match(result.result, /PINEAPPLE/);
  console.log(`live: tap to command ${took} ms, cost $${result.total_cost_usd}`);
});
