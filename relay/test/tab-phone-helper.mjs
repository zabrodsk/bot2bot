import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { sleep } from './helpers.mjs';
import { PHONE_SCRIPT } from '../phone-page.mjs';

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
  // A tap on a checkbox: the browser flips it, then tells the page.
  toggle() { this.checked = !this.checked; return Promise.all((this.events.change ?? []).map((fn) => fn())); }
  find(pred) { for (const c of this.children) { if (pred(c)) return c; const d = c.find(pred); if (d) return d; } return null; }
  findAll(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.findAll(pred, out); } return out; }
}
export async function phoneOf(who, { lang = 'en', store = new Map() } = {}) {
  const els = Object.fromEntries(IDS.map((id) => [id, new Element(id)]));
  els.phone.dataset = { lang, vapid: 'x' };
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
    item: (name) => els.cards.find((e) => e.tag === 'label' && e.children[1]?.children[0]?.textContent === name),
    text: () => els.cards.textContent,
    async tick(name) { const box = phone.item(name).children[0]; await box.toggle(); await settle(); },
    async waitFor(pred, ms = 8000) { const end = Date.now() + ms; for (;;) { await phone.check(); if (pred()) return; if (Date.now() > end) throw new Error(`timed out; the phone shows: ${phone.text()}`); await sleep(60); } },
    async setUp() { await els.start.click(); await settle(); return els.say.textContent.match(/code ([A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1]; },
  };
  return phone;
}
