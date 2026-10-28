// Czech on the dashboard: who gets it (the browser's language at sign-up, the Account setting, the lang cookie
// when signed out), that the pages people use are in Czech, that bots still get English, and that English stays
// as it was. Plus the dictionary itself: every string the dashboard uses has a Czech entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, owner, login, browser, connect } from './helpers.mjs';
import { t, langFromHeader, CS, CS_MESSAGES } from '../i18n.mjs';
import { loginEmail } from '../email.mjs';

const relay = join(dirname(fileURLToPath(import.meta.url)), '..');
const CZ = { 'accept-language': 'cs-CZ,cs;q=0.9,en;q=0.8' };
const userLang = (env, email) => env.relay.db.prepare('SELECT lang FROM users WHERE email = ?').get(email).lang;
const czech = (env, email) => env.relay.db.prepare("UPDATE users SET lang = 'cs' WHERE email = ?").run(email);

// Sign up in a browser that sends these headers. The code comes from the email, whatever its language.
async function signUp(env, email, headers) {
  const b = browser(env.url, headers);
  const sent = await b('/login', { method: 'POST', form: { email } });
  const mail = env.mail.filter((m) => m.to === email).at(-1);
  await b('/login/verify', { method: 'POST', form: { email, code: mail.subject.match(/(\d{6})$/)[1] } });
  return { b, sent, mail };
}

test('the browser language picks Czech for new sign-ups: cs or sk first, else English', async (t0) => {
  assert.equal(langFromHeader('cs-CZ,cs;q=0.9,en;q=0.8'), 'cs');
  assert.equal(langFromHeader('sk'), 'cs');
  assert.equal(langFromHeader('en;q=0.4, cs;q=0.9'), 'cs', 'by quality, not order');
  assert.equal(langFromHeader('en-US,cs;q=0.5'), 'en');
  assert.equal(langFromHeader('de-DE'), 'en');
  assert.equal(langFromHeader('*'), 'en');
  assert.equal(langFromHeader(undefined), 'en');

  const env = await setup(t0);
  // Signed out, the login page follows the browser, and so does the email.
  assert.match((await browser(env.url, CZ)('/login')).text, /<html lang="cs">[^]*href="\/lang\/en"[^>]*>English<[^]*Přihlášení a registrace[^]*Poslat kód/);
  const cz = await signUp(env, 'jana@example.com', CZ);
  assert.match(cz.sent.text, /Zkontrolujte e-mail[^]*Na <b>jana@example\.com<\/b> jsme poslali šestimístný kód/);
  assert.match(cz.mail.subject, /^Váš přihlašovací kód do bot2bot: \d{6}$/);
  assert.match(cz.mail.text, /^Váš přihlašovací kód do bot2bot je \d{6}[^]*Platí 15 minut\./);
  assert.match(cz.mail.html, /<html lang="cs">[^]*Přihlásit se do bot2bot/);
  assert.equal(userLang(env, 'jana@example.com'), 'cs');
  assert.match((await cz.b('/app/picture')).text, /<html lang="cs">[^]*Jméno a obrázek/);

  await signUp(env, 'zuzka@example.com', { 'accept-language': 'sk-SK,sk;q=0.9' });
  assert.equal(userLang(env, 'zuzka@example.com'), 'cs');
  const en = await signUp(env, 'john@example.com', { 'accept-language': 'en-US,cs;q=0.5' });
  assert.equal(userLang(env, 'john@example.com'), null, 'English is stored as none');
  assert.match(en.mail.subject, /^Your bot2bot login code: \d{6}$/);
  assert.match((await en.b('/app/picture')).text, /<html lang="en">[^]*Your name and picture/);
});

test('signed out, the language picked at the top is remembered and the page comes back in it', async (t0) => {
  const env = await setup(t0);
  // An English browser, on the login page with somewhere to go next.
  const b = browser(env.url, { referer: `${env.url}/login?next=%2Fapp` });
  assert.match((await b('/login')).text, /<html lang="en">[^]*<a class="langswitch" href="\/lang\/cs" hreflang="cs" lang="cs">Čeština<\/a>/);
  const pick = await b('/lang/cs');
  assert.equal(pick.status, 303);
  assert.equal(pick.location, '/login?next=%2Fapp', 'back to the same page');
  assert.match((await b('/login')).text, /<html lang="cs">[^]*Přihlášení a registrace/);
  // The choice beats the browser's language, and signing up keeps it.
  await b('/login', { method: 'POST', form: { email: 'pick@example.com' } });
  const code = env.mail.filter((m) => m.to === 'pick@example.com').at(-1).subject.match(/(\d{6})$/)[1];
  assert.match(env.mail.filter((m) => m.to === 'pick@example.com').at(-1).subject, /^Váš přihlašovací kód/);
  await b('/login/verify', { method: 'POST', form: { email: 'pick@example.com', code } });
  assert.equal(userLang(env, 'pick@example.com'), 'cs');
  // A Czech browser can switch to English the same way.
  const cz = browser(env.url, CZ);
  await cz('/lang/en');
  assert.match((await cz('/login')).text, /<html lang="en">[^]*Log in or sign up/);
});

test('a Czech person sees Czech on the overview, account, invite, bot and person pages; bots still get English', async (t0) => {
  const env = await setup(t0, { privacyPilot: true });
  const ann = await owner(env, t0, 'ann@example.com', 'ann-bot');
  const ben = await owner(env, t0, 'ben@example.com', 'ben-bot');
  await connect(ann, ben, 'Ann', { basket: 'friends' });
  czech(env, 'ann@example.com');
  env.relay.db.prepare('UPDATE bots SET doorbell_verified_at = ?, last_ring_at = ? WHERE id = ?').run(Date.now(), Date.now(), ann.botId);

  const home = (await ann.b('/app')).text;
  assert.match(home, /<html lang="cs">/);
  assert.match(home, /<title>Přehled · bot2bot<\/title>/);
  assert.match(home, />Přehled<\/a>[^]*>Lidé<\/a>[^]*>Aktivita<\/a>[^]*>Účet<\/a>/);
  assert.match(home, /<h1>Vítejte<\/h1>[^]*(1 bot připravený|Nastavuje se) · 1 přítel/);
  assert.match(home, /Přátelé <span class="count">1<\/span>[^]*Vaši boti[^]*Přidat bota[^]*Pozastavit vše[^]*Pozastavit všechny boty\?/);
  assert.match(home, /<dt>Košík<\/dt><dd><span class="hand basket-word">friends<\/span>/);
  assert.match(home, /Šifrované end-to-end|Zatím nešifrované/);
  for (const en of ['>Overview<', '>Your bots<', 'Pause everything', '>Activity<', 'Invite a friend']) assert.ok(!home.includes(en), `no "${en}"`);

  const acc = (await ann.b('/app/account')).text;
  assert.match(acc, /<title>Účet · bot2bot<\/title>[^]*Vaše jméno[^]*Profilový obrázek[^]*id="lang-l">Jazyk<[^]*aria-pressed="true">Čeština<[^]*Tichý režim[^]*Časové pásmo[^]*Stáhnout moje data[^]*Smazat účet/);

  const bot = (await ann.b(`/app/bots/${ann.botId}`)).text;
  assert.match(bot, /<dt>Zvonek<\/dt><dd><b>Zapnuto<\/b>[^]*<dt>Šifrování<\/dt>[^]*<dt>Tichý režim<\/dt>[^]*Záložní kontrola[^]*Interval kontroly/);
  assert.match(bot, /Odpojit tohoto bota[^]*Odpojit @ann-bot\?[^]*class="cm__secondary">Zrušit</);
  assert.match(bot, /copybtn__label">Kopírovat<|Změnit zvonek/);

  // The invite page and what gets sent: the page is Czech, the message for the friend's bot is not.
  const inv = (await ann.b('/app/invites', { method: 'POST', form: { bot: ann.botId } })).text;
  assert.match(inv, /<h1>Pozvat<\/h1>|Pozvat · bot2bot/);
  assert.match(inv, /Pošlete tohle tomu, koho zvete[^]*Zpráva k odeslání[^]*Jak kontaktu říkáte\?[^]*Zrušit pozvánku/);
  assert.match(inv, /Propojme naše AI boty přes bot2bot[^]*Otevři moji pozvánku: http/, 'the message for a friend (a person) is Czech too');
  const code = inv.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  // Someone opening it signed out in a Czech browser gets Czech; in an English one, English.
  assert.match((await browser(env.url, CZ)(`/i/${code}`)).text, /<html lang="cs">[^]*chce, aby si vaši boti psali[^]*Přidat bota pro nastavení[^]*Set yourself up for bot2bot in private mode/);
  assert.match((await browser(env.url)(`/i/${code}`)).text, /<html lang="en">[^]*wants your bots to talk/);

  const person = (await ann.b(`/app/people/${ann.botId}/${ben.botId}`)).text;
  assert.match(person, /<legend class="row-label">Košík<\/legend>[^]*zatím nezařazení[^]*Nejdřív se zeptá[^]*Jak kontaktu říkáte[^]*Kdo to je[^]*Pokyny pro kontakt Ben[^]*Pravidla[^]*Přidat pravidlo/);
  const people = (await ann.b(`/app/people?bot=${ann.botId}`)).text;
  assert.match(people, /zatím nezařazení[^]*\+ nový košík[^]*Každý košík bot vyřizuje sám/);
  assert.match(people, /Kam přesunout: \$\{esc\(el\.dataset\.name\)\}/, 'the drag-and-drop script speaks Czech too');

  // Toasts and errors come in Czech.
  await ann.b('/app/contacts/block', { method: 'POST', form: { bot: ann.botId, peer: ben.botId } });
  assert.match((await ann.b('/app')).text, /class="toast__what">Zablokováno: Ben<[^]*toast__undo">Vrátit</);
  assert.match((await ann.b('/app/nope')).text, /<html lang="cs">[^]*<h1>Nenalezeno<\/h1><p>Stránka nenalezena<\/p>/);
  // The setup message for a new bot stays English: bots read it.
  await ann.b('/app/bots/new', { method: 'POST', form: {} });
  await ann.b('/app/bots', { method: 'POST', form: { handle: 'ann-two' } });
  assert.match((await ann.b('/app')).text, /Připojte @ann-two[^]*Please set yourself up for bot2bot/);
});

test('switching the language in Account: a toast with Undo, the login page follows after logging out', async (t0) => {
  const env = await setup(t0);
  const b = await login(env, 'swap@example.com');
  assert.match((await b('/app/account')).text, /<html lang="en">[^]*id="lang-l">Language<[^]*<button name="lang" value="en" lang="en" aria-pressed="true">English<\/button><button name="lang" value="cs" lang="cs" aria-pressed="false">Čeština<\/button>/);
  const r = await b('/app/account/lang', { method: 'POST', form: { lang: 'cs' } });
  assert.equal(r.location, '/app/account');
  assert.equal(userLang(env, 'swap@example.com'), 'cs');
  const cs = (await b('/app/account')).text;
  assert.match(cs, /<html lang="cs">[^]*aria-pressed="true">Čeština</);
  assert.match(cs, /toast__what">Jazyk uložen<[^]*action="\/app\/account\/lang"><input type="hidden" name="lang" value="en"><input type="hidden" name="undo" value="1"><button class="toast__undo">Vrátit</);
  // Undo puts English back, without another Undo.
  await b('/app/account/lang', { method: 'POST', form: { lang: 'en', undo: '1' } });
  const en = (await b('/app/account')).text;
  assert.match(en, /<html lang="en">[^]*toast__what">Language saved</);
  assert.doesNotMatch(en, /<button class="toast__undo">/);
  // The choice is also kept in the browser, so the login page matches after logging out.
  await b('/app/account/lang', { method: 'POST', form: { lang: 'cs' } });
  await b('/logout', { method: 'POST' });
  assert.match((await b('/login')).text, /<html lang="cs">[^]*Přihlášení a registrace/);
});

test('English stays as it was', async (t0) => {
  const env = await setup(t0);
  const b = await login(env, 'plain@example.com');
  const home = (await b('/app')).text;
  assert.match(home, /<html lang="en">[^]*<title>Set up · bot2bot<\/title>[^]*Add the setup bot[^]*Waiting for your bot…/);
  assert.doesNotMatch(home.replace(/<(style|script)>[^]*?<\/\1>/g, ''), /[ěščřžýáíéůú]/i, 'no Czech on an English page');
  assert.match(loginEmail({ code: '123456', url: 'https://x/l', home: 'https://x' }).subject, /^Your bot2bot login code: 123456$/);
  const tr = t('en');
  assert.equal(tr('[noun]Change'), 'Change');
  assert.equal(tr.n(1, '{n} friend|{n} friends'), '1 friend');
  assert.equal(tr.n(0, '{n} friend|{n} friends'), '0 friends');
  assert.equal(tr.msg('this contact is not reachable'), 'this contact is not reachable');
  assert.equal(tr.date(Date.UTC(2026, 9, 28, 12)), '28 October 2026');
});

test('Czech helpers: plurals, dates, relay errors', () => {
  const tr = t('cs');
  assert.deepEqual([1, 2, 4, 5, 0].map((n) => tr.n(n, '{n} friend|{n} friends')), ['1 přítel', '2 přátelé', '4 přátelé', '5 přátel', '0 přátel']);
  assert.equal(tr.date(Date.UTC(2026, 9, 28, 12)), '28. října 2026');
  assert.equal(tr.ago(Date.now() - 3 * 86_400_000, Date.now()), 'před 3 dny');
  assert.equal(tr.msg('This contact is not reachable'), 'Tento kontakt není dostupný.');
  assert.equal(tr.msg('@anna-bot is taken.'), '@anna-bot je obsazené.');
  assert.equal(tr.msg('€24 a year'), '24 € ročně');
  assert.equal(tr.msg('Something new from the relay'), 'Something new from the relay', 'unknown text stays as it is');
});

// Every string the dashboard and the emails use is a plain tr('…') literal, so this finds them all.
const sources = ['app.mjs', 'email.mjs', 'i18n.mjs'].map((f) => readFileSync(join(relay, f), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
const unq = (s) => s.replace(/\\(.)/g, '$1');
const used = new Map();
for (const src of sources) for (const m of src.matchAll(/\btr(\.n\([^,]+,\s*|\(\s*)(['"])((?:\\.|(?!\2).)*)\2/g)) used.set(unq(m[3]), m[1].startsWith('.n') ? 'plural' : 'text');
// The robots' names are translated where the picker lists them.
for (const m of sources[0].matchAll(/\{ key: '\w+', name: '([^']+)'/g)) used.set(m[1], 'text');

test('every dashboard string has a Czech entry, and every Czech entry is used', () => {
  assert.ok(used.size > 500, `found ${used.size} strings`);
  const missing = [...used].filter(([k, kind]) => (kind === 'plural' ? !(Array.isArray(CS[k]) && CS[k].length === 3) : typeof CS[k] !== 'string'));
  assert.deepEqual(missing.map(([k]) => k), [], 'missing Czech');
  assert.deepEqual(Object.keys(CS).filter((k) => !used.has(k)), [], 'Czech nobody uses');
});

test('every error the dashboard raises has Czech', () => {
  const thrown = [...sources[0].matchAll(/HttpError\(\d+, (['"])((?:\\.|(?!\1).)*)\1\)/g)].map((m) => unq(m[2]));
  assert.ok(thrown.length > 20);
  assert.deepEqual(thrown.filter((m) => typeof CS_MESSAGES[m] !== 'string'), []);
});

test('the Czech copy keeps the placeholders and markup, and has no dashes', () => {
  const tags = (s) => (s.match(/<\/?[a-z]+/g) || []).sort().join(' ');
  const holes = (s) => new Set(s.match(/\{\w+\}/g) || []);
  for (const [k, v] of Object.entries(CS)) {
    const key = k.replace(/^\[\w+\]/, '');
    for (const one of [v].flat()) {
      for (const h of holes(one)) assert.ok(key.includes(h) || h === '{n}', `${h} in "${one}" is not in "${key}"`);
      assert.equal(tags(one), tags(key), `markup of "${key}"`);
      assert.doesNotMatch(one, /[—–]/, `dash in "${one}"`);
    }
  }
  for (const v of Object.values(CS_MESSAGES)) assert.doesNotMatch(v, /[—–]/);
});
