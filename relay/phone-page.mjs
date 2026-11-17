// The owner's phone page (/app/phone): cards from their coding agents, opened and answered in this browser.
// Like the private group history page it stands on its own: no dashboard scripts, no analytics, nothing from
// another site, and whatever an agent wrote is only ever shown as text. The script runs as it is in the tests.
import { createHash } from 'node:crypto';

const PHONE_CS = {
  "Approve from your phone": "Schvalujte z telefonu",
  "When Claude Code or Codex needs a yes while you're away, it asks you here.": "Když Claude Code nebo Codex potřebuje vaše ano a vy nejste u počítače, zeptá se vás tady.",
  "Set up this phone": "Nastavit tento telefon",
  "One more step. Tell your coding agent:": "Ještě jeden krok. Řekněte svému agentovi:",
  "Link my phone, code {code}": "Propoj můj telefon, kód {code}",
  "Copy": "Kopírovat",
  "Copied": "Zkopírováno",
  "Your agent checks this code, so only this phone can approve for you.": "Agent si kód ověří, takže za vás může schvalovat jen tento telefon.",
  "Linked with {names}.": "Propojeno s {names}.",
  "Link another agent": "Propojit dalšího agenta",
  "Turn on notifications": "Zapnout oznámení",
  "Notifications are on.": "Oznámení jsou zapnutá.",
  "On iPhone, add this page to your Home Screen first, then open it from there.": "Na iPhonu si stránku nejdřív přidejte na plochu a otevřete ji odtamtud.",
  "Notifications are blocked for this site. Allow them in your browser settings.": "Oznámení jsou pro tento web zablokovaná. Povolte je v nastavení prohlížeče.",
  "This browser can't show notifications. Keep this page open instead.": "Tento prohlížeč neumí oznámení. Nechte si stránku otevřenou.",
  "Nothing needs you right now.": "Teď vás nic nepotřebuje.",
  "Approve once": "Schválit jednou",
  "Deny": "Zamítnout",
  "Reply…": "Odpovědět…",
  "Send": "Odeslat",
  "Cancel": "Zrušit",
  "Your answer": "Vaše odpověď",
  "Details": "Podrobnosti",
  "{agent} said": "{agent} napsal",
  "This one needs you at the keyboard.": "Tohle počká, až budete u počítače.",
  "Approved": "Schváleno",
  "Denied": "Zamítnuto",
  "Replied": "Odpovězeno",
  "Undo": "Zpět",
  "ends in {n} min": "skončí za {n} min",
  "ends soon": "brzy skončí",
  "Sent to another phone of yours.": "Odesláno na váš jiný telefon.",
  "This request couldn't be opened on this phone.": "Tento požadavek se na tomto telefonu nepodařilo otevřít.",
  "This phone": "Tento telefon",
  "Remove this phone": "Odebrat tento telefon",
  "Phone removed": "Telefon odebrán",
  "Phones": "Telefony",
  "Requests are end-to-end encrypted between your agent and this phone.": "Požadavky jsou mezi agentem a tímto telefonem end-to-end šifrované.",
  "Preparing this phone…": "Připravuji tento telefon…",
  "This browser can't keep a key for approvals. Use a current browser over HTTPS.": "Tento prohlížeč neumí uchovat klíč pro schvalování. Použijte aktuální prohlížeč přes HTTPS.",
  "Something went wrong. Try again.": "Něco se nepovedlo. Zkuste to znovu.",
  "That request ended before your answer arrived.": "Požadavek skončil dřív, než dorazila vaše odpověď.",
  "You're signed out. Open bot2bot and sign in again.": "Jste odhlášeni. Otevřete bot2bot a přihlaste se znovu.",
  "Back to bot2bot": "Zpět do bot2bot",
  "One of your agents needs you.": "Jeden z vašich agentů vás potřebuje.",
};

function phoneApp() {
  const $ = (id) => document.getElementById(id);
  const root = $('phone'), status = $('status'), list = $('cards');
  const tr = (text, vars = {}) => (root.dataset.lang === 'cs' ? B2B_PHONE_CS[text] || text : text).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
  const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const bytes = (text) => Uint8Array.from(atob(String(text).replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
  const hex = (buffer) => Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  let me = null, view = null, shown = '', timer = null, later = null, replying = null;
  const opened = new Map(); // card id → what it says, once decrypted

  // The code the owner tells their agent: the same 60 bits of both public keys' hash the agent computes.
  async function codeOf(sign, box) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode('b2b-phone/1|' + sign + '|' + box)));
    let bits = 0n;
    for (let i = 0; i < 8; i++) bits = (bits << 8n) | BigInt(h[i]);
    let out = '';
    for (let i = 0; i < 12; i++) out += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Number((bits >> BigInt(59 - i * 5)) & 31n)];
    return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8);
  }
  // This phone's keys stay in this browser, and their secret halves can't be read out of it, even by this page.
  const db = () => new Promise((ok, no) => { const r = indexedDB.open('b2b-phone', 1); r.onupgradeneeded = () => r.result.createObjectStore('keys'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const load = async () => { const d = await db(); return new Promise((ok, no) => { const r = d.transaction('keys').objectStore('keys').get('device'); r.onsuccess = () => ok(r.result || null); r.onerror = () => no(r.error); }); };
  const save = async (v) => { const d = await db(); return new Promise((ok, no) => { const t = d.transaction('keys', 'readwrite'); if (v) t.objectStore('keys').put(v, 'device'); else t.objectStore('keys').delete('device'); t.oncomplete = () => ok(); t.onerror = () => no(t.error); }); };

  async function api(path, data) {
    const r = await fetch(path, { method: data ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
      ...(data ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) } : {}) });
    // Signed out: the dashboard answers with its sign-in page instead.
    if (r.type === 'opaqueredirect' || r.status === 0 || r.status === 401 || r.status === 302 || r.status === 303) throw new Error(tr("You're signed out. Open bot2bot and sign in again."));
    if (r.status === 409 || r.status === 404) throw new Error(tr('That request ended before your answer arrived.'));
    if (!r.ok) throw new Error(tr('Something went wrong. Try again.'));
    return r.json();
  }
  function say(text) { status.textContent = text || ''; }
  // What, undo, next: an action shows what it did with an Undo, and only goes out when that passes.
  function soon(what, run, undo) {
    if (later) { clearTimeout(later.timer); const go = later.run; later = null; void go(); }
    $('toast-what').textContent = what; $('toast').hidden = false;
    later = { run, undo, timer: setTimeout(() => { const go = later.run; later = null; $('toast').hidden = true; void go(); }, 4000) };
  }
  $('undo').addEventListener('click', () => { if (!later) return; clearTimeout(later.timer); const back = later.undo; later = null; $('toast').hidden = true; back(); shown = ''; void draw(); });

  async function open(card) {
    if (opened.has(card.id)) return opened.get(card.id);
    if (!card.box || !me) return null;
    try {
      const eph = await crypto.subtle.importKey('raw', bytes(card.box.eph), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: eph }, me.box.privateKey, 256);
      const hk = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: bytes(card.box.eph), info: enc.encode('b2b-phone-card/1') }, hk, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const plain = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(card.box.iv), additionalData: enc.encode('b2b-phone-card/1|' + card.id + '|' + me.id), tagLength: 128 }, key, bytes(card.box.ct))));
      if (!plain || plain.v !== 1 || plain.id !== card.id || typeof plain.hash !== 'string' || !/^[0-9a-f]{64}$/.test(plain.hash)) throw new Error('not this card');
      opened.set(card.id, plain);
      return plain;
    } catch { opened.set(card.id, false); return false; }
  }
  // The answer is signed by this phone for this one request: its id and the hash of exactly what was asked.
  async function answer(card, plain, decision, text) {
    const said = decision === 'reply' ? String(text || '').trim().slice(0, 2000) : '';
    const data = { device: me.id, decision };
    let replyHash = '';
    if (decision === 'reply') {
      const key = await crypto.subtle.importKey('raw', bytes(plain.rk), 'AES-GCM', false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      data.reply_iv = b64(iv);
      data.reply_ct = b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('b2b-phone-reply/1|' + card.id), tagLength: 128 }, key, enc.encode(said)));
      replyHash = hex(await crypto.subtle.digest('SHA-256', enc.encode(said)));
    }
    data.sig = b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, me.sign.privateKey, enc.encode('b2b-phone-answer/1|' + card.id + '|' + plain.hash + '|' + decision + '|' + replyHash)));
    try { await api('/app/phone/cards/' + card.id + '/answer', data); say(''); } catch (e) { say(e.message); }
    await refresh();
  }
  function act(card, plain, decision, text) {
    replying = null;
    const what = { allow: tr('Approved'), deny: tr('Denied'), reply: tr('Replied') }[decision];
    card.sending = what; shown = ''; void draw();
    soon(what, async () => { await answer(card, plain, decision, text); }, () => { delete card.sending; });
  }

  function cardRow(card, plain) {
    const row = el('li', 'card');
    if (plain === null || plain === false) {
      row.append(el('p', 'who', card.bot), el('p', 'note', plain === null ? tr('Sent to another phone of yours.') : tr("This request couldn't be opened on this phone.")));
      return row;
    }
    const mins = Math.max(0, Math.round((card.expires_at - view.now) / 60000));
    const head = el('p', 'who');
    head.append(el('strong', '', str(plain.agent, 40) || 'Agent'), el('span', '', ' · ' + (str(plain.project, 80) || card.bot)));
    row.append(head);
    if (plain.title) row.append(el('p', 'ask', str(plain.title, 200)));
    if (plain.summary) row.append(el('pre', 'what', str(plain.summary, 1200)));
    if (plain.context) { row.append(el('p', 'label', tr('{agent} said', { agent: str(plain.agent, 40) || 'Agent' })), el('p', 'context', str(plain.context, 4000))); }
    if (plain.detail) { const d = el('details', 'more'); d.append(el('summary', '', tr('Details')), el('pre', 'detail', str(plain.detail, 6000))); row.append(d); }
    const done = card.answered ? { allow: tr('Approved'), deny: tr('Denied'), reply: tr('Replied') }[card.answered.decision] : card.sending;
    if (done) { row.append(el('p', 'done', done)); row.className = 'card card--done'; return row; }
    const actions = Array.isArray(plain.actions) ? plain.actions : [];
    if (card.kind === 'info' || !actions.length) { row.append(el('p', 'note', tr('This one needs you at the keyboard.'))); return row; }
    if (replying === card.id) {
      const box = el('textarea', 'reply'); box.rows = 3; box.maxLength = 2000; box.setAttribute('aria-label', tr('Your answer'));
      const send = el('button', 'btn primary', tr('Send')), cancel = el('button', 'btn', tr('Cancel'));
      send.addEventListener('click', () => { if (String(box.value || '').trim()) act(card, plain, 'reply', box.value); });
      cancel.addEventListener('click', () => { replying = null; shown = ''; draw(); });
      const bar = el('div', 'bar'); bar.append(send, cancel);
      row.append(box, bar);
      return row;
    }
    const bar = el('div', 'bar');
    if (actions.includes('approve')) { const b = el('button', 'btn primary', tr('Approve once')); b.addEventListener('click', () => act(card, plain, 'allow')); bar.append(b); }
    if (actions.includes('deny')) { const b = el('button', 'btn', tr('Deny')); b.addEventListener('click', () => act(card, plain, 'deny')); bar.append(b); }
    if (actions.includes('reply')) { const b = el('button', 'btn', tr('Reply…')); b.addEventListener('click', () => { replying = card.id; shown = ''; draw(); }); bar.append(b); }
    row.append(bar, el('p', 'note', mins > 1 ? tr('ends in {n} min', { n: mins }) : tr('ends soon')));
    return row;
  }
  async function draw() {
    const mine = me && view ? view.devices.find((d) => d.id === me.id) : null;
    $('setup').hidden = !!me;
    $('link').hidden = !mine;
    $('notify').hidden = !mine;
    $('phones').hidden = !mine;
    if (mine) {
      $('say').textContent = tr('Link my phone, code {code}', { code: me.code });
      const linked = mine.linked.length > 0;
      $('linked').textContent = linked ? tr('Linked with {names}.', { names: mine.linked.map((h) => '@' + h).join(', ') }) : '';
      $('link-how').hidden = linked; $('link-again').hidden = !linked;
      $('this-phone').textContent = tr('This phone') + ' · ' + mine.name + ' · ' + me.code;
      if (mine.push) { $('push').hidden = true; $('push-note').textContent = tr('Notifications are on.'); } else $('push').hidden = false;
    }
    const cards = me && view ? view.cards : [];
    // Drawn again only when something changed, so a reply being typed isn't thrown away by the next check.
    const now = cards.map((c) => c.id + (c.answered ? c.answered.decision : '') + (c.sending || '')).join('|') + '#' + (replying || '') + '#' + (me ? me.id : '');
    $('empty').hidden = !mine || cards.length > 0;
    if (now === shown) return;
    const rows = [];
    for (const c of cards) rows.push(cardRow(c, await open(c)));
    shown = now;
    list.replaceChildren(...rows);
  }
  async function refresh() {
    try {
      const fresh = await api('/app/phone/state' + (me ? '?device=' + me.id : ''));
      // This phone was removed on another device: its keys are no use any more.
      if (me && !fresh.known) { await save(null); me = null; opened.clear(); }
      const sending = new Map((view ? view.cards : []).filter((c) => c.sending).map((c) => [c.id, c.sending]));
      for (const c of fresh.cards) if (sending.has(c.id) && !c.answered) c.sending = sending.get(c.id);
      view = fresh;
      await draw();
    } catch (e) { say(e.message); }
  }
  function loop() { clearTimeout(timer); timer = setTimeout(async () => { if (document.visibilityState !== 'hidden') await refresh(); loop(); }, 3000); }

  $('start').addEventListener('click', async () => {
    $('start').disabled = true; say(tr('Preparing this phone…'));
    try {
      const sign = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const box = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
      const signPub = b64(await crypto.subtle.exportKey('raw', sign.publicKey)), boxPub = b64(await crypto.subtle.exportKey('raw', box.publicKey));
      const code = await codeOf(signPub, boxPub);
      const ua = navigator.userAgent || '';
      const made = await api('/app/phone/devices', { sign: signPub, box: boxPub, name: /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : 'Browser' });
      if (made.code !== code || typeof made.id !== 'string') throw new Error(tr('Something went wrong. Try again.'));
      me = { id: made.id, sign, box, signPub, boxPub, code };
      await save(me);
      say('');
      await refresh();
    } catch (e) { say(e && e.message && !/subtle|indexedDB|undefined/i.test(e.message) ? e.message : tr("This browser can't keep a key for approvals. Use a current browser over HTTPS.")); }
    $('start').disabled = false;
  });
  $('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('say').textContent); $('copy').textContent = tr('Copied'); } catch { /* they can select it */ } });
  $('link-again').addEventListener('click', () => { $('link-how').hidden = false; $('link-again').hidden = true; });
  $('push').addEventListener('click', async () => {
    const note = $('push-note');
    try {
      if (!('serviceWorker' in navigator) || typeof PushManager === 'undefined' || typeof Notification === 'undefined') {
        note.textContent = /iPhone|iPad/.test(navigator.userAgent || '') ? tr('On iPhone, add this page to your Home Screen first, then open it from there.') : tr("This browser can't show notifications. Keep this page open instead.");
        return;
      }
      if (await Notification.requestPermission() !== 'granted') { note.textContent = tr('Notifications are blocked for this site. Allow them in your browser settings.'); return; }
      const reg = await navigator.serviceWorker.register('/app/phone/sw.js?lang=' + (root.dataset.lang === 'cs' ? 'cs' : 'en'));
      await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(root.dataset.vapid) });
      await api('/app/phone/devices/' + me.id + '/push', { endpoint: sub.endpoint });
      await refresh();
    } catch { note.textContent = tr("This browser can't show notifications. Keep this page open instead."); }
  });
  $('remove').addEventListener('click', () => {
    const gone = me; if (!gone) return;
    me = null; shown = ''; void draw();
    // Undo before it goes out, and this phone is as it was.
    soon(tr('Phone removed'), async () => { try { await api('/app/phone/devices/' + gone.id + '/remove', {}); } catch { /* already gone */ } await save(null); opened.clear(); await refresh(); }, () => { me = gone; });
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') void refresh(); });

  (async () => {
    try { me = await load(); } catch { me = null; }
    await refresh();
    loop();
  })();
}

export const PHONE_SCRIPT = `const B2B_PHONE_CS = ${JSON.stringify(PHONE_CS)}; (${phoneApp.toString()})();`;
const scriptHash = createHash('sha256').update(PHONE_SCRIPT).digest('base64');
export const PHONE_CSP = `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; font-src 'self'; img-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
// The service worker only shows that something waits. What it is stays encrypted until the page opens it.
export const PHONE_SW = `const cs = new URL(self.location).searchParams.get('lang') === 'cs';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('push', (e) => e.waitUntil(self.registration.showNotification('bot2bot', { body: cs ? ${JSON.stringify(PHONE_CS['One of your agents needs you.'])} : 'One of your agents needs you.', tag: 'b2b-phone', renotify: true, icon: '/icon-192.png', badge: '/icon-192.png' })));
self.addEventListener('notificationclick', (e) => { e.notification.close(); e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((all) => { const open = all.find((c) => new URL(c.url).pathname === '/app/phone'); return open ? open.focus() : self.clients.openWindow('/app/phone'); })); });
`;
export const phoneManifest = () => ({ name: 'bot2bot', short_name: 'bot2bot', start_url: '/app/phone', scope: '/app/', display: 'standalone', background_color: '#f3f5f8', theme_color: '#f3f5f8',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }] });

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// The dashboard's own colours, type and shapes (Arc), so the page feels like the rest of bot2bot.
const STYLE = `@font-face{font-family:"Hubot";src:url(/fonts/hubot-display.woff2) format("woff2");font-weight:400 640;font-display:swap}
@font-face{font-family:"Mona";src:url(/fonts/mona-text.woff2) format("woff2");font-weight:400 600;font-display:swap}
:root{color-scheme:light;--background:#f3f5f8;--surface:#fff;--surface-muted:#eef1f5;--foreground:#1a2230;--text-secondary:#586377;--border:#dde2e9;--accent:#2747c9;--accent-foreground:#fff;--success:#1f7a4d;--ring:#6a8aff}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--background:#0e131b;--surface:#171d28;--surface-muted:#1f2734;--foreground:#e8ecf3;--text-secondary:#a4aec0;--border:#2a3342;--accent:#7f97ff;--accent-foreground:#0e131b;--success:#5fcf96}}
:root[data-theme="dark"]{color-scheme:dark;--background:#0e131b;--surface:#171d28;--surface-muted:#1f2734;--foreground:#e8ecf3;--text-secondary:#a4aec0;--border:#2a3342;--accent:#7f97ff;--accent-foreground:#0e131b;--success:#5fcf96}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--background);color:var(--foreground);font:400 16px/1.5 "Mona",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent}
main{max-width:560px;margin:auto;padding:calc(20px + env(safe-area-inset-top)) 16px calc(96px + env(safe-area-inset-bottom))}
a{color:inherit}.back{display:inline-block;color:var(--text-secondary);font-size:14px;text-decoration:none;padding:6px 0}
h1{margin:14px 0 8px;font:500 28px/1.12 "Hubot","Mona",ui-sans-serif,system-ui,sans-serif;letter-spacing:-.01em}
p{margin:8px 0}.note,.label{color:var(--text-secondary);font-size:14px}.label{margin:14px 0 2px}
section{margin:16px 0}section.panel,.card{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:18px}
.btn{font:500 16px/1.2 inherit;font-family:inherit;min-height:48px;padding:12px 18px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:inherit;cursor:pointer;transition:transform 120ms ease}
.btn:active{transform:scale(.97)}.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-foreground)}.btn:disabled{opacity:.55}
.btn.quiet{min-height:40px;padding:8px 12px;font-size:14px;color:var(--text-secondary);background:transparent}
button:focus{outline:none}button:focus-visible,a:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--ring);outline-offset:3px}
pre{margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere;font:400 14px/1.45 ui-monospace,"SF Mono",Menlo,Consolas,monospace}
#say{font-size:17px;font-weight:500;padding:14px;background:var(--surface-muted);border-radius:12px}
ul{padding:0;margin:16px 0;list-style:none;display:grid;gap:12px}
.who{margin:0;font-size:14px;color:var(--text-secondary)}.who strong{color:var(--foreground);font-weight:500}
.ask{margin:6px 0 0;font:500 19px/1.25 "Hubot","Mona",ui-sans-serif,system-ui,sans-serif}
.what{padding:12px 14px;background:var(--surface-muted);border-radius:12px}.context{white-space:pre-wrap;overflow-wrap:anywhere}
.detail{max-height:40vh;overflow:auto;padding:12px 14px;background:var(--surface-muted);border-radius:12px}details{margin:8px 0}summary{cursor:pointer;color:var(--text-secondary);font-size:14px;padding:6px 0}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.bar .btn{flex:1 1 auto}
.reply{display:block;width:100%;margin-top:12px;padding:12px 14px;font:inherit;color:inherit;background:var(--surface-muted);border:1px solid var(--border);border-radius:12px;resize:vertical}
.done{margin:12px 0 0;font-weight:500;color:var(--success)}.card--done{opacity:.72}
#status{min-height:1.5em;color:var(--text-secondary);font-size:14px}
#toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:center;gap:6px;max-width:calc(100vw - 24px);padding:6px 6px 6px 18px;border-radius:999px;background:var(--foreground);color:var(--background);font-size:15px;font-weight:500;box-shadow:0 8px 24px rgb(0 0 0/.18)}
#toast button{font:inherit;min-height:40px;padding:8px 14px;border:0;border-radius:999px;background:transparent;color:inherit;text-decoration:underline;cursor:pointer}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){.btn{transition:none}.btn:active{transform:none}}`;

export function phonePage({ lang = 'en', theme = '', vapid = '' }) {
  const cs = lang === 'cs';
  const tr = (text) => esc(cs ? PHONE_CS[text] || text : text);
  return { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PHONE_CSP, 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' },
    html: `<!doctype html><html lang="${cs ? 'cs' : 'en'}"${['light', 'dark'].includes(theme) ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${tr('Approve from your phone')} · bot2bot</title>
<link rel="manifest" href="/app/phone/manifest.webmanifest" crossorigin="use-credentials"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="bot2bot">
<style>${STYLE}</style></head><body><main id="phone" data-lang="${cs ? 'cs' : 'en'}" data-vapid="${esc(vapid)}">
<a class="back" href="/app">← ${tr('Back to bot2bot')}</a><h1>${tr('Approve from your phone')}</h1>
<ul id="cards" aria-live="polite"></ul><p id="empty" class="note" hidden>${tr('Nothing needs you right now.')}</p>
<p id="status" role="status" aria-live="polite"></p>
<section id="setup" class="panel" hidden><p>${tr("When Claude Code or Codex needs a yes while you're away, it asks you here.")}</p><div class="bar"><button id="start" class="btn primary">${tr('Set up this phone')}</button></div></section>
<section id="link" class="panel" hidden><div id="link-how"><p>${tr('One more step. Tell your coding agent:')}</p><pre id="say"></pre><div class="bar"><button id="copy" class="btn">${tr('Copy')}</button></div><p class="note">${tr('Your agent checks this code, so only this phone can approve for you.')}</p></div><p id="linked" class="note"></p><button id="link-again" class="btn quiet" hidden>${tr('Link another agent')}</button></section>
<section id="notify" hidden><button id="push" class="btn">${tr('Turn on notifications')}</button><p id="push-note" class="note"></p></section>
<section id="phones" hidden><details><summary>${tr('Phones')}</summary><p id="this-phone" class="note"></p><button id="remove" class="btn quiet">${tr('Remove this phone')}</button><p class="note">${tr('Requests are end-to-end encrypted between your agent and this phone.')}</p></details></section>
<div id="toast" role="status" hidden><span id="toast-what"></span><button id="undo">${tr('Undo')}</button></div>
</main><script>${PHONE_SCRIPT}</script></body></html>` };
}
