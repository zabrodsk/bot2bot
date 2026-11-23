// The owner's phone page (/app/phone): cards from their coding agents, opened and answered in this browser.
// Like the private group history page it stands on its own: no dashboard scripts, no analytics, nothing from
// another site, and whatever an agent wrote is only ever shown as text. The script runs as it is in the tests.
import { createHash } from 'node:crypto';

const PHONE_CS = {
  "Approve from your phone": "Schvalujte z telefonu",
  "Your phone": "Váš telefon",
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
  "{who} paid {total} at {place}. What did you have?": "{who} zaplatil(a) {total} v podniku {place}. Co jste měli?",
  "You paid {total} at {place}. What did you have?": "Zaplatili jste {total} v podniku {place}. Co jste měli?",
  "{who} paid {total}. What did you have?": "{who} zaplatil(a) {total}. Co jste měli?",
  "You paid {total}. What did you have?": "Zaplatili jste {total}. Co jste měli?",
  "{n} × {price}": "{n} × {price}",
  "One less": "O jeden méně",
  "One more": "O jeden víc",
  "{n} of {qty}": "{n} z {qty}",
  "Tax": "Daň",
  "Tip": "Spropitné",
  "Service": "Obsluha",
  "{extras}, shared by what each person had.": "{extras}, rozdělí se podle toho, co kdo měl.",
  "Done": "Hotovo",
  "Split evenly": "Rozdělit rovným dílem",
  "I wasn't there": "Nebyl(a) jsem tam",
  "Picked 1 item": "Vybrána 1 položka",
  "Picked {n} items": "Vybrané položky: {n}",
  "Split evenly for you": "Rozděleno rovným dílem",
  "Marked as not there": "Označeno, že jste tam nebyli",
  "You had {items}.": "Měli jste: {items}.",
  "You split it evenly.": "Rozdělili jste to rovným dílem.",
  "You weren't there.": "Nebyli jste tam.",
  "Change": "Změnit",
  "You can change it until the bill closes.": "Změnit to můžete, dokud se účet neuzavře.",
  "closes in {n} h": "uzavře se za {n} h",
  "closes in {n} min": "uzavře se za {n} min",
  "{who} marked {amount} as sent to you. Did it arrive?": "{who} vám podle svých slov poslal(a) {amount}. Dorazilo to?",
  "It arrived": "Dorazilo",
  "Not yet": "Ještě ne",
  "Marked as arrived": "Označeno jako doručené",
  "Marked as not arrived yet": "Označeno, že ještě nedorazilo",
  "Arrived": "Dorazilo",
  "Not arrived yet": "Ještě nedorazilo",
};

function phoneApp() {
  // iOS Safari only shows :active (the button press) once the page listens for touches.
  document.addEventListener?.('touchstart', () => {}, { passive: true });
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
  const picking = new Map(); // tab card id → Map(item n → units), what the owner ticked so far
  const changing = new Set(); // tab cards answered already, opened again to change the pick
  const pickedBefore = new Map(); // tab card id → the picks this phone sent last (decrypted), to show and to start from

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
  // A reply's words, or the items picked from a bill (as canonical JSON), travel encrypted with the card's own key, and
  // the signature covers them too: the reply by its hash, the picks as they are. So nobody can change what was picked.
  async function answer(card, plain, decision, text) {
    const said = decision === 'reply' ? String(text || '').trim().slice(0, 2000) : decision === 'pick' ? String(text) : '';
    const data = { device: me.id, decision };
    let tail = '';
    if (decision === 'reply' || decision === 'pick') {
      const key = await crypto.subtle.importKey('raw', bytes(plain.rk), 'AES-GCM', false, ['encrypt']);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      data.reply_iv = b64(iv);
      data.reply_ct = b64(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode('b2b-phone-reply/1|' + card.id), tagLength: 128 }, key, enc.encode(said)));
      tail = decision === 'pick' ? said : hex(await crypto.subtle.digest('SHA-256', enc.encode(said)));
    }
    if (card.kind === 'tab_pick') data.rev = (card.answered?.rev ?? 0) + 1;
    data.sig = b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, me.sign.privateKey, enc.encode('b2b-phone-answer/1|' + card.id + '|' + plain.hash + '|' + decision + '|' + tail + (data.rev ? '|' + data.rev : ''))));
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
    if (plain && /^tab_/.test(card.kind) && plain.kind !== card.kind) plain = false;
    if (plain === null || plain === false) {
      row.append(el('p', 'who', card.bot), el('p', 'note', plain === null ? tr('Sent to another phone of yours.') : tr("This request couldn't be opened on this phone.")));
      return row;
    }
    if (card.kind === 'tab_pick' || card.kind === 'tab_got') return tabRow(card, plain, row);
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
  // ───── Tab: "what did you have?" on a bill, and "did the money arrive?" ─────
  const money = (cents, cur) => {
    const n = Math.round(Number(cents) || 0) / 100;
    try { return new Intl.NumberFormat(root.dataset.lang === 'cs' ? 'cs-CZ' : 'en-IE', { style: 'currency', currency: str(cur, 3) || 'EUR' }).format(n); }
    catch { return n.toFixed(2) + ' ' + str(cur, 3); }
  };
  const tabItems = (plain) => (plain.tab && Array.isArray(plain.tab.items) ? plain.tab.items : [])
    .filter((i) => i && Number.isInteger(i.n) && Number.isInteger(i.qty) && i.qty >= 1 && i.qty <= 10000).slice(0, 200);
  // The picks as the bot checks them: sorted by item, whole units, nothing else in it.
  const canonical = (picks) => JSON.stringify([...picks].filter(([, u]) => u > 0).sort((a, b) => a[0] - b[0]).map(([n, units]) => ({ n, units })));
  const pickedText = (plain, picks) => {
    const byN = new Map(tabItems(plain).map((i) => [i.n, i]));
    return [...picks].filter(([, u]) => u > 0).sort((a, b) => a[0] - b[0]).map(([n, u]) => { const i = byN.get(n); const name = i ? str(i.name, 80) : '#' + n; return i && i.qty > 1 ? u + ' × ' + name : name; }).join(', ');
  };
  async function unseal(card, plain) {
    const sealed = card.answered && card.answered.sealed;
    if (!sealed) return null;
    const key = (card.answered.rev || 1) + '|' + sealed.ct;
    const had = pickedBefore.get(card.id);
    if (had && had.key === key) return had.picks;
    try {
      const k = await crypto.subtle.importKey('raw', bytes(plain.rk), 'AES-GCM', false, ['decrypt']);
      const list = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(sealed.iv), additionalData: enc.encode('b2b-phone-reply/1|' + card.id), tagLength: 128 }, k, bytes(sealed.ct))));
      const picks = new Map(Array.isArray(list) ? list.filter((p) => p && Number.isInteger(p.n) && Number.isInteger(p.units)).map((p) => [p.n, p.units]) : []);
      pickedBefore.set(card.id, { key, picks });
      return picks;
    } catch { return null; }
  }
  function tabAct(card, plain, decision, picks) {
    const what = decision === 'pick' ? (picks.size === 1 ? tr('Picked 1 item') : tr('Picked {n} items', { n: picks.size }))
      : { even: tr('Split evenly for you'), absent: tr('Marked as not there'), got: tr('Marked as arrived'), not_yet: tr('Marked as not arrived yet') }[decision];
    const wasChanging = changing.delete(card.id);
    card.sending = what; card.sendingRev = card.answered ? card.answered.rev || 1 : 0;
    card.sendingDone = decision === 'pick' ? tr('You had {items}.', { items: pickedText(plain, picks) }) : null;
    shown = ''; void draw();
    soon(what, async () => { await answer(card, plain, decision, decision === 'pick' ? canonical(picks) : ''); },
      () => { delete card.sending; delete card.sendingDone; if (wasChanging) changing.add(card.id); });
  }
  function tabRow(card, plain, row) {
    const tab = plain.tab && typeof plain.tab === 'object' ? plain.tab : {};
    const cur = str(tab.currency, 3);
    const head = el('p', 'who');
    head.append(el('strong', '', str(tab.group, 80) || card.bot));
    if (tab.date) head.append(el('span', '', ' · ' + str(tab.date, 20)));
    row.append(head);
    if (card.kind === 'tab_got') {
      row.append(el('p', 'ask', tr('{who} marked {amount} as sent to you. Did it arrive?', { who: str(tab.from, 40) || '?', amount: money(tab.amount, cur) })));
      const done = card.answered ? { got: tr('Arrived'), not_yet: tr('Not arrived yet') }[card.answered.decision] : card.sending;
      if (done) { row.append(el('p', 'done', done)); row.className = 'card card--done'; return row; }
      const bar = el('div', 'bar');
      const yes = el('button', 'btn primary', tr('It arrived')), no = el('button', 'btn', tr('Not yet'));
      yes.addEventListener('click', () => tabAct(card, plain, 'got'));
      no.addEventListener('click', () => tabAct(card, plain, 'not_yet'));
      bar.append(yes, no);
      row.append(bar, el('p', 'note', closesIn(card)));
      return row;
    }
    const total = money(tab.total, cur), place = str(tab.place, 80);
    row.append(el('p', 'ask', tab.you_paid
      ? tr(place ? 'You paid {total} at {place}. What did you have?' : 'You paid {total}. What did you have?', { total, place })
      : tr(place ? '{who} paid {total} at {place}. What did you have?' : '{who} paid {total}. What did you have?', { who: str(tab.payer, 40) || '?', total, place })));
    const items = tabItems(plain);
    const before = pickedBefore.get(card.id);
    // Answered: what was picked, and a way to change it while the bill is open.
    if (card.sending || (card.answered && !changing.has(card.id))) {
      const d = card.sending ? (card.sendingDone || card.sending) : card.answered.decision === 'pick' ? (before ? tr('You had {items}.', { items: pickedText(plain, before.picks) }) : tr('Done'))
        : card.answered.decision === 'even' ? tr('You split it evenly.') : tr("You weren't there.");
      row.append(el('p', 'done', d));
      if (!card.sending && card.answered.open) {
        const bar = el('div', 'bar');
        const again = el('button', 'btn quiet', tr('Change'));
        again.addEventListener('click', () => { changing.add(card.id); picking.set(card.id, new Map(before ? before.picks : [])); shown = ''; void draw(); });
        bar.append(again);
        row.append(bar, el('p', 'note', tr('You can change it until the bill closes.')));
      } else row.className = 'card card--done';
      return row;
    }
    if (!picking.has(card.id)) picking.set(card.id, new Map());
    const picks = picking.get(card.id);
    const doneBtn = el('button', 'btn primary', tr('Done'));
    const sync = () => { doneBtn.disabled = ![...picks.values()].some((u) => u > 0); };
    const list = el('ul', 'items');
    for (const it of items) {
      const li = el('li', 'item');
      const label = el('label', 'pick');
      const box = el('input', 'check');
      box.type = 'checkbox'; box.checked = (picks.get(it.n) || 0) > 0;
      const name = el('span', 'name');
      name.append(el('span', '', str(it.name, 80) || '#' + it.n));
      if (it.qty > 1) name.append(el('span', 'unit', tr('{n} × {price}', { n: it.qty, price: money(it.price, cur) }))); // price is per unit
      label.append(box, name, el('span', 'price', money(it.price * it.qty, cur)));
      li.append(label);
      let step = null;
      if (it.qty > 1) {
        step = el('div', 'step');
        const less = el('button', 'btn round', '−'), count = el('span', 'count'), more = el('button', 'btn round', '+');
        less.setAttribute('aria-label', tr('One less')); more.setAttribute('aria-label', tr('One more'));
        const show = () => { const u = picks.get(it.n) || 0; count.textContent = tr('{n} of {qty}', { n: u, qty: it.qty }); less.disabled = u <= 1; more.disabled = u >= it.qty; step.hidden = u === 0; box.checked = u > 0; sync(); };
        less.addEventListener('click', () => { picks.set(it.n, Math.max(1, (picks.get(it.n) || 1) - 1)); show(); });
        more.addEventListener('click', () => { picks.set(it.n, Math.min(it.qty, (picks.get(it.n) || 0) + 1)); show(); });
        step.append(less, count, more);
        step.show = show;
        li.append(step);
        show();
      }
      box.addEventListener('change', () => { if (box.checked) picks.set(it.n, Math.max(1, picks.get(it.n) || 0)); else picks.delete(it.n); if (step) step.show(); else sync(); });
      list.append(li);
    }
    row.append(list);
    const extras = tab.extras && typeof tab.extras === 'object' ? [['tax', 'Tax'], ['tip', 'Tip'], ['service', 'Service']].filter(([k]) => Number(tab.extras[k]) > 0).map(([k, label]) => tr(label) + ' ' + money(tab.extras[k], cur)) : [];
    if (extras.length) row.append(el('p', 'note', tr('{extras}, shared by what each person had.', { extras: extras.join(' · ') })));
    sync();
    doneBtn.addEventListener('click', () => { if ([...picks.values()].some((u) => u > 0)) tabAct(card, plain, 'pick', new Map([...picks].filter(([, u]) => u > 0))); });
    const even = el('button', 'btn', tr('Split evenly')), absent = el('button', 'btn', tr("I wasn't there"));
    even.addEventListener('click', () => tabAct(card, plain, 'even'));
    absent.addEventListener('click', () => tabAct(card, plain, 'absent'));
    const bar = el('div', 'bar bar--tab'); bar.append(doneBtn, even, absent);
    row.append(bar, el('p', 'note', closesIn(card)));
    return row;
  }
  const closesIn = (card) => { const mins = Math.max(0, Math.round((card.expires_at - view.now) / 60000)); return mins >= 120 ? tr('closes in {n} h', { n: Math.round(mins / 60) }) : mins > 1 ? tr('closes in {n} min', { n: mins }) : tr('ends soon'); };

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
    const now = cards.map((c) => c.id + (c.answered ? c.answered.decision + (c.answered.rev || '') : '') + (c.sending || '')).join('|') + '#' + (replying || '') + '#' + (me ? me.id : '') + '#' + [...changing].join(',');
    $('empty').hidden = !mine || cards.length > 0;
    if (now === shown) return;
    const rows = [];
    for (const c of cards) {
      const plain = await open(c);
      if (plain && c.kind === 'tab_pick') await unseal(c, plain);
      rows.push(cardRow(c, plain));
    }
    shown = now;
    list.replaceChildren(...rows);
  }
  async function refresh() {
    try {
      const fresh = await api('/app/phone/state' + (me ? '?device=' + me.id : ''));
      // This phone was removed on another device: its keys are no use any more.
      if (me && !fresh.known) { await save(null); me = null; opened.clear(); }
      const sending = new Map((view ? view.cards : []).filter((c) => c.sending).map((c) => [c.id, c]));
      for (const c of fresh.cards) {
        const was = sending.get(c.id);
        // Still going out: not answered yet, or (a changed pick) the relay still has the earlier answer.
        if (was && (!c.answered || (c.kind === 'tab_pick' && (c.answered.rev || 1) <= was.sendingRev))) { c.sending = was.sending; c.sendingRev = was.sendingRev; c.sendingDone = was.sendingDone; }
      }
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
a,button,summary,label,input,textarea{touch-action:manipulation}button,summary,.pick{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}
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
.detail{max-height:40vh;overflow:auto;overscroll-behavior:contain;padding:12px 14px;background:var(--surface-muted);border-radius:12px}details{margin:8px 0}summary{cursor:pointer;color:var(--text-secondary);font-size:14px;padding:6px 0}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.bar .btn{flex:1 1 auto}
.reply{display:block;width:100%;margin-top:12px;padding:12px 14px;font:inherit;color:inherit;background:var(--surface-muted);border:1px solid var(--border);border-radius:12px;resize:vertical}
.done{margin:12px 0 0;font-weight:500;color:var(--success)}.card--done{opacity:.72}
#status{min-height:1.5em;color:var(--text-secondary);font-size:14px}
#toast{position:fixed;left:50%;bottom:calc(20px + env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:center;gap:6px;max-width:calc(100vw - 24px);padding:6px 6px 6px 18px;border-radius:999px;background:var(--foreground);color:var(--background);font-size:15px;font-weight:500;box-shadow:0 8px 24px rgb(0 0 0/.18)}
#toast button{font:inherit;min-height:40px;padding:8px 14px;border:0;border-radius:999px;background:transparent;color:inherit;text-decoration:underline;cursor:pointer}
.items{gap:0;margin:14px 0 0;border-top:1px solid var(--border)}.item{border-bottom:1px solid var(--border)}
.pick{display:flex;align-items:center;gap:14px;min-height:56px;padding:10px 2px;cursor:pointer}
.check{flex:none;width:24px;height:24px;margin:0;accent-color:var(--accent);cursor:pointer}
.name{flex:1;min-width:0;display:flex;flex-direction:column;overflow-wrap:anywhere}.unit{color:var(--text-secondary);font-size:14px}
.price{flex:none;font-variant-numeric:tabular-nums}
.step{display:flex;align-items:center;gap:10px;padding:0 0 12px 38px}.count{min-width:4.5em;text-align:center;font-variant-numeric:tabular-nums;color:var(--text-secondary);font-size:15px}
.btn.round{min-height:44px;min-width:44px;padding:0;border-radius:999px;font-size:20px;line-height:1}
.bar--tab .btn.primary{flex-basis:100%}
input:focus{outline:none}input:focus-visible{outline:3px solid var(--ring);outline-offset:3px}
[hidden]{display:none!important}
@media (prefers-reduced-motion:reduce){.btn{transition:none}.btn:active{transform:none}}`;

export function phonePage({ lang = 'en', theme = '', vapid = '' }) {
  const cs = lang === 'cs';
  const tr = (text) => esc(cs ? PHONE_CS[text] || text : text);
  return { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': PHONE_CSP, 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' },
    html: `<!doctype html><html lang="${cs ? 'cs' : 'en'}"${['light', 'dark'].includes(theme) ? ` data-theme="${theme}"` : ''}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${tr('Your phone')} · bot2bot</title>
${theme === 'light' || theme === 'dark' ? `<meta name="theme-color" content="${theme === 'dark' ? '#0e131b' : '#f3f5f8'}">` : '<meta name="theme-color" content="#f3f5f8" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0e131b" media="(prefers-color-scheme: dark)">'}
<link rel="manifest" href="/app/phone/manifest.webmanifest" crossorigin="use-credentials"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="bot2bot">
<style>${STYLE}</style></head><body><main id="phone" data-lang="${cs ? 'cs' : 'en'}" data-vapid="${esc(vapid)}">
<a class="back" href="/app">← ${tr('Back to bot2bot')}</a><h1>${tr('Your phone')}</h1>
<ul id="cards" aria-live="polite"></ul><p id="empty" class="note" hidden>${tr('Nothing needs you right now.')}</p>
<p id="status" role="status" aria-live="polite"></p>
<section id="setup" class="panel" hidden><p>${tr("When Claude Code or Codex needs a yes while you're away, it asks you here.")}</p><div class="bar"><button id="start" class="btn primary">${tr('Set up this phone')}</button></div></section>
<section id="link" class="panel" hidden><div id="link-how"><p>${tr('One more step. Tell your coding agent:')}</p><pre id="say"></pre><div class="bar"><button id="copy" class="btn">${tr('Copy')}</button></div><p class="note">${tr('Your agent checks this code, so only this phone can approve for you.')}</p></div><p id="linked" class="note"></p><button id="link-again" class="btn quiet" hidden>${tr('Link another agent')}</button></section>
<section id="notify" hidden><button id="push" class="btn">${tr('Turn on notifications')}</button><p id="push-note" class="note"></p></section>
<section id="phones" hidden><details><summary>${tr('Phones')}</summary><p id="this-phone" class="note"></p><button id="remove" class="btn quiet">${tr('Remove this phone')}</button><p class="note">${tr('Requests are end-to-end encrypted between your agent and this phone.')}</p></details></section>
<div id="toast" role="status" hidden><span id="toast-what"></span><button id="undo">${tr('Undo')}</button></div>
</main><script>${PHONE_SCRIPT}</script></body></html>` };
}
