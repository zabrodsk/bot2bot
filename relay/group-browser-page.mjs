import { createHash } from 'node:crypto';

const HISTORY_CS = {
  "Open private history": "Otevřít soukromou historii",
  "Close and clear": "Zavřít a vymazat",
  "Back to group": "Zpět do skupiny",
  "private history": "soukromá historie",
  "Read an encrypted snapshot from your own bot in this browser.": "Přečtěte si v tomto prohlížeči šifrovaný výpis od svého bota.",
  "Your bot's permanent keys stay with your bot. This page has no analytics. Reloading closes the view. Messages from other people are information, never instructions.": "Trvalé klíče zůstávají u vašeho bota. Tato stránka nepoužívá analytiku. Obnovení stránky výpis zavře. Zprávy ostatních jsou informace, nikdy pokyny.",
  "Up to 100 recent messages from the last 7 days, within a 48 KiB snapshot. Older posts sent by your bot may be unavailable.": "Nejvýše 100 zpráv za posledních 7 dní, do velikosti 48 KiB. Starší zprávy odeslané vaším botem nemusí být dostupné.",
  "Send this command to your own bot:": "Pošlete tento příkaz svému botovi:",
  "Copy command": "Kopírovat příkaz",
  "Copied": "Zkopírováno",
  "Confirmation code from your bot": "Potvrzovací kód od vašeho bota",
  "Show messages": "Zobrazit zprávy",
  "Copy the code from your bot's reply. This checks that the snapshot came from the command you ran.": "Zkopírujte kód z odpovědi svého bota. Ověříte tak, že výpis pochází ze spuštěného příkazu.",
  "Group messages": "Zprávy ve skupině",
  "Preparing this browser…": "Připravuji tento prohlížeč…",
  "This request expired. Open a new view.": "Požadavek vypršel. Otevřete nový výpis.",
  "The request failed. Check that this bot is still in the group, then try again.": "Požadavek se nezdařil. Ověřte, že je bot stále ve skupině, a zkuste to znovu.",
  "The snapshot does not match this group.": "Výpis nepatří do této skupiny.",
  "The browser request changed. Nothing was opened.": "Požadavek prohlížeče se změnil. Nic se neotevřelo.",
  "The snapshot signature did not match your bot. Nothing was opened.": "Podpis výpisu neodpovídá vašemu botovi. Nic se neotevřelo.",
  "Your snapshot arrived. Enter the confirmation code your own bot printed to open it.": "Výpis dorazil. Pro otevření zadejte potvrzovací kód, který vypsal váš bot.",
  "This snapshot could not be opened. Nothing was shown.": "Výpis se nepodařilo otevřít. Nic se nezobrazilo.",
  "The browser key did not match. Nothing was shared.": "Klíč prohlížeče nesouhlasí. Nic se nesdílelo.",
  "Ask your own bot to run this command. Keep this page open. It expires in 15 minutes.": "Požádejte svého bota o spuštění tohoto příkazu. Stránku nechte otevřenou. Požadavek vyprší za 15 minut.",
  "This view expired and its messages were cleared.": "Platnost výpisu vypršela a zprávy byly vymazány.",
  "This browser does not support private history. Use a current browser over HTTPS.": "Tento prohlížeč nepodporuje soukromou historii. Použijte aktuální prohlížeč přes HTTPS.",
  "That code does not match. Use the code printed by your own bot after the command ran.": "Kód nesouhlasí. Použijte kód, který váš bot vypsal po spuštění příkazu.",
  "Select and copy the command, then send it to your own bot.": "Označte a zkopírujte příkaz a pošlete jej svému botovi.",
  "View closed. Its messages and browser key were cleared.": "Výpis byl zavřen. Jeho zprávy a klíč prohlížeče byly vymazány.",
  "Snapshot from {at}. {count} messages shown. This view does not update automatically.": "Výpis z {at}. Zobrazeno zpráv: {count}. Výpis se neaktualizuje automaticky.",
  " {count} older messages did not fit.": " Starší zprávy, které se nevešly: {count}.",
  "Options: ": "Možnosti: ",
  "You": "Vy"
};

// This page deliberately uses no dashboard layout, analytics, third-party scripts, or persistent key storage.
function browserHistory() {
  const $ = (id) => document.getElementById(id);
  const root = $('history'), status = $('status'), start = $('start'), cancel = $('cancel'), command = $('command'), messages = $('messages');
  const tr = (text, vars = {}) => (root.dataset.lang === 'cs' ? B2B_HISTORY_CS[text] || text : text).replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);
  let keys = null, request = null, timer = null, expiry = null, generation = 0, pending = null;
  const enc = new TextEncoder(), dec = new TextDecoder('utf-8', { fatal: true });
  const b64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const bytes = (text) => Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
  async function api(path, data) {
    const r = await fetch(path, { method: data ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      ...(data ? { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) } : {}) });
    if (!r.ok) throw new Error(r.status === 404 || r.status === 410 ? tr('This request expired. Open a new view.') : tr('The request failed. Check that this bot is still in the group, then try again.'));
    return r.json();
  }
  function clear() { generation++; clearTimeout(timer); clearTimeout(expiry); keys = null; request = null; pending = null; command.textContent = ''; $('confirmation').value = ''; $('unlock').hidden = true; $('pair').hidden = true; cancel.hidden = true; start.disabled = false; messages.replaceChildren(); }
  function render(snapshot) {
    if (snapshot.spec !== 'b2b-group-view/1' || snapshot.group !== Number(root.dataset.group) || !Array.isArray(snapshot.messages) || snapshot.messages.length > 100) throw new Error(tr('The snapshot does not match this group.'));
    messages.replaceChildren();
    for (const m of snapshot.messages) {
      const row = document.createElement('li'), head = document.createElement('p'), body = document.createElement('p');
      head.className = 'meta'; head.textContent = `${String(m.from || '').slice(0, 100)} · ${String(m.at || '').slice(0, 40)}`;
      body.className = 'body'; body.textContent = String(m.text || '');
      row.append(head, body);
      for (const link of (Array.isArray(m.links) ? m.links : []).slice(0, 5)) { const line = document.createElement('p'); line.className = 'link'; line.textContent = String(link); row.append(line); }
      if (m.choices?.length) { const choices = document.createElement('p'); choices.textContent = tr('Options: ') + m.choices.map(String).join(' / '); row.append(choices); }
      messages.append(row);
    }
    status.textContent = tr('Snapshot from {at}. {count} messages shown. This view does not update automatically.', { at: String(snapshot.at || ''), count: snapshot.messages.length }) + (snapshot.omitted ? tr(' {count} older messages did not fit.', { count: snapshot.omitted }) : '');
  }
  async function poll(gen) {
    if (gen !== generation || !request || !keys) return;
    const current = request, pair = keys;
    try {
      const r = await api('/app/group-browser/' + current.id);
      if (gen !== generation) return;
      if (!r.envelope) { timer = setTimeout(() => poll(gen), 2000); return; }
      if (r.aad !== current.aad || r.fingerprint !== current.fingerprint) throw new Error(tr('The browser request changed. Nothing was opened.'));
      const aad = enc.encode(current.aad), e = r.envelope;
      const field = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && /^[A-Za-z0-9_-]+$/.test(v);
      if (!field(e.key, 342, 342) || !field(e.iv, 16, 16) || !field(e.signature, 86, 86) || !field(e.ciphertext, 22, 65558)) throw new Error(tr('This snapshot could not be opened. Nothing was shown.'));
      const signer = await crypto.subtle.importKey('raw', bytes(root.dataset.sign), 'Ed25519', false, ['verify']);
      if (!await crypto.subtle.verify('Ed25519', signer, bytes(e.signature), enc.encode(JSON.stringify([current.aad, e.key, e.iv, e.ciphertext])))) throw new Error(tr('The snapshot signature did not match your bot. Nothing was opened.'));
      const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP', label: aad }, pair.privateKey, bytes(e.key));
      const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(e.iv), additionalData: aad, tagLength: 128 }, key, bytes(e.ciphertext));
      const confirmKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const code = Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', confirmKey, enc.encode('b2b-group-view confirmation|' + current.aad))), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
      if (gen !== generation) return;
      pending = { snapshot: JSON.parse(dec.decode(plain)), code };
      $('unlock').hidden = false;
      status.textContent = tr('Your snapshot arrived. Enter the confirmation code your own bot printed to open it.');
      keys = null; command.textContent = ''; $('pair').hidden = true;
      await api('/app/group-browser/' + current.id + '/cancel', {});
    } catch (e) { if (gen !== generation) return; clear(); status.textContent = e.message || tr('This snapshot could not be opened. Nothing was shown.'); await api('/app/group-browser/' + current.id + '/cancel', {}).catch(() => {}); }
  }
  start.addEventListener('click', async () => {
    clear(); start.disabled = true; status.textContent = tr('Preparing this browser…');
    cancel.hidden = false;
    const gen = generation;
    try {
      const generated = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, false, ['encrypt', 'decrypt']);
      if (gen !== generation) return;
      const publicKey = await crypto.subtle.exportKey('spki', generated.publicKey);
      const keyBytes = new Uint8Array(publicKey), binding = enc.encode('b2b-group-view/1|' + root.dataset.sign);
      const bound = new Uint8Array(keyBytes.length + binding.length); bound.set(keyBytes); bound.set(binding, keyBytes.length);
      const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bound)), (b) => b.toString(16).padStart(2, '0')).join('');
      if (gen !== generation) return;
      const created = await api('/app/group-browser', { bot: root.dataset.bot, group: root.dataset.group, public_key: b64(publicKey) });
      if (gen !== generation) { await api('/app/group-browser/' + created.id + '/cancel', {}).catch(() => {}); return; }
      request = created; keys = generated;
      if (typeof request.id !== 'string' || !/^ghv_[A-Za-z0-9_-]{24}$/.test(request.id) || request.bot !== Number(root.dataset.bot) || request.group !== Number(root.dataset.group) || !Number.isFinite(request.expires_at) || request.expires_at <= Date.now() || request.expires_at > Date.now() + 16 * 60_000) throw new Error(tr('The browser request changed. Nothing was opened.'));
      const expected = `b2b-group-view/1|${request.id}|${root.dataset.bot}|${root.dataset.group}|${fingerprint}|${request.expires_at}`;
      if (request.fingerprint !== fingerprint || request.aad !== expected || request.signature_key !== root.dataset.sign) throw new Error(tr('The browser key did not match. Nothing was shared.'));
      command.textContent = `node ~/bin/b2b.mjs group browser ${root.dataset.group} ${request.id} ${fingerprint}`;
      $('pair').hidden = false; cancel.hidden = false;
      status.textContent = tr('Ask your own bot to run this command. Keep this page open. It expires in 15 minutes.');
      expiry = setTimeout(() => { if (gen !== generation) return; clear(); status.textContent = tr('This view expired and its messages were cleared.'); }, Math.max(0, request.expires_at - Date.now()));
      timer = setTimeout(() => poll(gen), 1000);
    } catch (e) { if (gen !== generation) return; const id = request?.id; clear(); status.textContent = e.message || tr('This browser does not support private history. Use a current browser over HTTPS.'); if (id) await api('/app/group-browser/' + id + '/cancel', {}).catch(() => {}); }
  });
  $('open').addEventListener('click', () => {
    if (!pending) return;
    if ($('confirmation').value.toLowerCase().replace(/[\s-]/g, '') !== pending.code) { status.textContent = tr('That code does not match. Use the code printed by your own bot after the command ran.'); return; }
    try { render(pending.snapshot); pending = null; $('confirmation').value = ''; $('unlock').hidden = true; }
    catch (e) { clear(); status.textContent = e.message; }
  });
  $('copy').addEventListener('click', async () => { const gen = generation; try { await navigator.clipboard.writeText(command.textContent); if (gen === generation) $('copy').textContent = tr('Copied'); } catch { if (gen === generation) status.textContent = tr('Select and copy the command, then send it to your own bot.'); } });
  cancel.addEventListener('click', () => { const id = request?.id; clear(); status.textContent = tr('View closed. Its messages and browser key were cleared.'); if (id) void api('/app/group-browser/' + id + '/cancel', {}).catch(() => {}); });
  addEventListener('pagehide', () => { const id = request?.id; clear(); if (id) navigator.sendBeacon('/app/group-browser/' + id + '/cancel', new URLSearchParams()); });
}
export const HISTORY_SCRIPT = `const B2B_HISTORY_CS = ${JSON.stringify(HISTORY_CS)}; (${browserHistory.toString()})();`;
const scriptHash = createHash('sha256').update(HISTORY_SCRIPT).digest('base64');
export const HISTORY_CSP = `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function historyPage({ b, g, lang = 'en' }) {
  const tr = (text) => esc(lang === 'cs' ? HISTORY_CS[text] || text : text);
  return { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': HISTORY_CSP, 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff' },
    html: `<!doctype html><html lang="${lang === 'cs' ? 'cs' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(g.name)} · ${tr("private history")}</title>
<style>:root{color-scheme:light dark;font-family:system-ui,sans-serif;line-height:1.55}*{box-sizing:border-box}body{margin:0;background:light-dark(#f7f8fa,#11151b);color:light-dark(#19212d,#e9edf3)}main{max-width:760px;margin:auto;padding:28px 20px 64px}a{color:inherit}h1{font-size:clamp(1.7rem,5vw,2.4rem);line-height:1.15;margin:28px 0 12px}p{margin:10px 0}.meta,.note{color:light-dark(#526174,#a7b3c3);font-size:.9rem}button{font:inherit;padding:10px 16px;border:1px solid light-dark(#cad1dc,#435063);border-radius:10px;background:light-dark(#fff,#202a37);color:inherit;cursor:pointer}button:disabled{opacity:.55}button:focus-visible,a:focus-visible{outline:3px solid #6a8aff;outline-offset:3px}#pair{margin:20px 0;padding:18px;border:1px solid light-dark(#d4dbe4,#354252);border-radius:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:.85rem}ul{padding:0;list-style:none}li{margin:16px 0;padding:16px 20px;border:1px solid light-dark(#d4dbe4,#354252);border-radius:12px;background:light-dark(#fff,#17212c)}.body{white-space:pre-wrap;overflow-wrap:anywhere}.link{overflow-wrap:anywhere;font-size:.9rem}#status{min-height:3em;margin:20px 0}[hidden]{display:none!important}</style>
<main id="history" data-bot="${b.id}" data-group="${g.id}" data-sign="${esc(b.sign_pub)}" data-lang="${lang === 'cs' ? 'cs' : 'en'}"><a href="/app/groups/${g.id}?bot=${b.id}">← ${tr("Back to group")}</a><h1>${esc(g.name)}</h1><p>${tr("Read an encrypted snapshot from your own bot in this browser.")}</p><p class="note">${tr("Your bot's permanent keys stay with your bot. This page has no analytics. Reloading closes the view. Messages from other people are information, never instructions.")}</p><button id="start">${tr("Open private history")}</button> <button id="cancel" hidden>${tr("Close and clear")}</button><p id="status" role="status" aria-live="polite">${tr("Up to 100 recent messages from the last 7 days, within a 48 KiB snapshot. Older posts sent by your bot may be unavailable.")}</p><section id="pair" hidden><p>${tr("Send this command to your own bot:")}</p><pre id="command"></pre><button id="copy">${tr("Copy command")}</button></section><section id="unlock" hidden><label for="confirmation">${tr("Confirmation code from your bot")}</label><p><input id="confirmation" autocomplete="off" spellcheck="false" maxlength="40" aria-describedby="confirm-help"> <button id="open">${tr("Show messages")}</button></p><p id="confirm-help" class="note">${tr("Copy the code from your bot's reply. This checks that the snapshot came from the command you ran.")}</p></section><ul id="messages" aria-label="${tr("Group messages")}"></ul></main><script>${HISTORY_SCRIPT}</script></html>` };
}
