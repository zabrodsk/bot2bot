// Public contact links (bot2bot.link/to/<name>) and the "Talk to my agent" badge: the owner's card (on, off, a new
// name, each with Undo), the name rules, the public page (only a first name, the assistant's logo and one button,
// noindex), asking (the same pending contact as asking from a group), and the limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, browser } from './helpers.mjs';

const db = (env) => env.relay.db;
// Pages without their styles and scripts, so a failing match prints what matters.
const bare = (html) => html.replace(/<style>[^]*?<\/style>/g, '').replace(/<script>[^]*?<\/script>/g, '');
// A signed-in person with one ready bot (made straight in the database: no tool needed to ask or be asked).
async function person(env, email, handle, name) {
  const b = await login(env, email);
  const u = db(env).prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (name) db(env).prepare('UPDATE users SET name = ? WHERE id = ?').run(name, u.id);
  const botId = addBot(env, u.id, handle, name);
  return { b, botId, userId: u.id };
}
function addBot(env, userId, handle, name = handle) {
  db(env).prepare("INSERT INTO bots (handle, display_name, token_hash, created_at, user_id, webhook_url, doorbell_verified_at) VALUES (?, ?, NULL, ?, ?, 'https://hook.example/x', ?)").run(handle, name, env.now(), userId, env.now());
  return db(env).prepare('SELECT id FROM bots WHERE handle = ?').get(handle).id;
}
const contact = (env, owner, peer) => db(env).prepare('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(owner, peer);
async function post(b, path, form) {
  const r = await b(path, { method: 'POST', form });
  return r.status === 303 ? { ...r, page: bare((await b(r.location)).text) } : { ...r, page: bare(r.text) };
}
// Ben turns his link on as "ben".
async function withLink(t0) {
  const env = await setup(t0);
  const ben = await person(env, 'ben@example.com', 'ben-bot', 'Ben Novak');
  const on = await post(ben.b, `/app/bots/${ben.botId}/link`, { do: 'on', name: 'ben' });
  assert.equal(on.status, 303);
  return { env, ben };
}

test('the card: off by default with a suggested name, then on with the link and the badge, off and a new name with Undo', async (t0) => {
  const env = await setup(t0);
  const ben = await person(env, 'ben@example.com', 'ben-bot', 'Běn Novák');
  const off = bare((await ben.b(`/app/bots/${ben.botId}`)).text);
  assert.match(off, /id="link"[^]*<h2>Public link<\/h2>[^]*badge--neutral">Off<[^]*name="name" value="ben"[^]*Turn on</);

  const on = await post(ben.b, `/app/bots/${ben.botId}/link`, { do: 'on', name: 'Ben' });
  assert.equal(on.location, `/app/bots/${ben.botId}#link`);
  assert.match(on.page, /toast__what">Public link on<[^]*name="do" value="off"[^]*toast__undo">Undo</);
  assert.match(on.page, /badge--success">On<[^]*id="clink">http:[^<]*\/to\/ben<[^]*src="\/badge\.svg"/);
  assert.match(on.page, new RegExp(`id="cmd">\\[!\\[Talk to my agent on bot2bot\\]\\(${env.url}/badge\\.svg\\)\\]\\(${env.url}/to/ben\\)<`));
  assert.match(on.page, /id="chtml">&lt;a href=&quot;http:[^<]*\/to\/ben&quot;&gt;&lt;img src=&quot;http:[^<]*\/badge\.svg&quot;/);
  assert.equal((await browser(env.url)('/to/ben')).status, 200);

  // A new name: the old one stops working, and Undo puts it back.
  const renamed = await post(ben.b, `/app/bots/${ben.botId}/link`, { do: 'rename', name: 'ben-novak' });
  assert.match(renamed.page, /toast__what">Link renamed to ben-novak<[^]*name="name" value="ben"[^]*toast__undo">Undo</);
  assert.equal((await browser(env.url)('/to/ben')).status, 404);
  assert.equal((await browser(env.url)('/to/ben-novak')).status, 200);
  const back = await post(ben.b, `/app/bots/${ben.botId}/link`, { do: 'rename', name: 'ben', undo: '1' });
  assert.match(back.page, /toast__what">Link renamed to ben</);
  assert.doesNotMatch(back.page, /toast__undo/, 'an undo offers no other');
  assert.equal((await browser(env.url)('/to/ben-novak')).status, 404);

  // Off, then Undo turns it back on under the same name.
  const offNow = await post(ben.b, `/app/bots/${ben.botId}/link`, { do: 'off' });
  assert.match(offNow.page, /toast__what">Public link off<[^]*name="do" value="on"[^]*name="name" value="ben"[^]*toast__undo">Undo</);
  assert.match(offNow.page, /badge--neutral">Off</);
  assert.equal((await browser(env.url)('/to/ben')).status, 404);
  await post(ben.b, `/app/bots/${ben.botId}/link`, { do: 'on', name: 'ben', undo: '1' });
  assert.equal((await browser(env.url)('/to/ben')).status, 200);
});

test('name rules: 3 to 30 letters, numbers or dashes, unique ignoring case, some names reserved', async (t0) => {
  const { env, ben } = await withLink(t0);
  const ana = await person(env, 'ana@example.com', 'ana-bot', 'Ana');
  // Ben has "ben", so Ana is offered her own first name.
  assert.match(bare((await ana.b(`/app/bots/${ana.botId}`)).text), /name="name" value="ana"/);
  const tryName = (name) => post(ana.b, `/app/bots/${ana.botId}/link`, { do: 'on', name });
  for (const bad of ['ab', 'a'.repeat(31), 'ana bot', 'ana_bot', '-ana', 'ana-', 'aňa']) {
    const r = await tryName(bad);
    assert.equal(r.status, 400, bad);
    assert.match(r.page, /field__error[^>]*>Use 3 to 30 lowercase letters, numbers or dashes\.</, bad);
  }
  for (const reserved of ['admin', 'support', 'bot2bot', 'bot2bot-help', 'founder', 'docs']) {
    const r = await tryName(reserved);
    assert.equal(r.status, 400, reserved);
    assert.match(r.page, /That name is reserved\. Try another\./);
  }
  const taken = await tryName('BEN');
  assert.equal(taken.status, 409);
  assert.match(taken.page, /value="BEN"[^]*That name is taken\. Try another\./);
  assert.equal(db(env).prepare('SELECT count(*) AS n FROM contact_links WHERE bot_id = ?').get(ana.botId).n, 0, 'nothing saved');
  assert.equal((await tryName('Ana-2')).status, 303, 'upper case is the same name in lower case');
  assert.equal(db(env).prepare('SELECT name FROM contact_links WHERE bot_id = ?').get(ana.botId).name, 'ana-2');
  // Renaming into someone else's name fails too, and the link keeps its name.
  assert.equal((await post(ana.b, `/app/bots/${ana.botId}/link`, { do: 'rename', name: 'ben' })).status, 409);
  // Someone else's bot isn't yours to change.
  assert.equal((await ana.b(`/app/bots/${ben.botId}/link`, { method: 'POST', form: { do: 'off' } })).status, 404);
  assert.equal((await browser(env.url)('/to/ben')).status, 200);
});

test('the public page: first name, logo and one button, noindex, nothing personal; unknown or off is a 404', async (t0) => {
  const { env, ben } = await withLink(t0);
  const anon = browser(env.url);
  const r = await anon('/to/ben');
  assert.equal(r.status, 200);
  const html = bare(r.text);
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
  assert.match(html, /<h1>Talk to Ben&#39;s agent<\/h1>|<h1>Talk to Ben's agent<\/h1>/);
  assert.match(html, /class="botmark botmark--lg"/);
  assert.match(html, /<a class="btn wide" href="\/login\?next=%2Fto%2Fben">Connect your bot<\/a>/);
  assert.match(html, /href="https:\/\/bot2bot\.link\/">What&#39;s bot2bot\?</);
  for (const secret of ['ben@example.com', 'ben-bot', 'Novak']) assert.ok(!html.includes(secret), `no ${secret}`);
  // One address for each name.
  assert.equal((await anon('/to/BEN')).location, '/to/ben');
  for (const p of ['/to/nobody', '/to/x', '/to/', '/to/%E0%A4%A']) {
    const nf = await anon(p);
    assert.equal(nf.status, 404, p);
    assert.match(nf.text, /noindex, follow/);
  }
  await post(ben.b, `/app/bots/${ben.botId}/link`, { do: 'off' });
  assert.equal((await anon('/to/ben')).status, 404);
  // A disconnected bot's link doesn't work either.
  await post(ben.b, `/app/bots/${ben.botId}/link`, { do: 'on', name: 'ben' });
  db(env).prepare('UPDATE bots SET disconnected_at = ? WHERE id = ?').run(env.now(), ben.botId);
  assert.equal((await anon('/to/ben')).status, 404);
  // Not in the sitemap or robots.txt (the site's own files don't know about it).
  assert.equal((await anon('/robots.txt')).text.includes('/to/'), false);
});

test('asking: a pending contact for the owner, labelled as from the link; their yes makes both sides approved', async (t0) => {
  const { env, ben } = await withLink(t0);
  const ana = await person(env, 'ana@example.com', 'ana-bot', 'Ana Svoboda');
  const ana2 = addBot(env, ana.userId, 'ana-two');
  // Signed out: asking needs signing in, and comes back here.
  assert.equal((await browser(env.url)('/to/ben', { method: 'POST', form: { bot: ana.botId } })).location, '/login?next=%2Fto%2Fben');
  const pick = bare((await ana.b('/to/ben')).text);
  assert.match(pick, new RegExp(`<select name="bot"><option value="${ana.botId}" selected>@ana-bot</option><option value="${ana2}">@ana-two</option></select>[^]*Connect your bot`));
  const asked = await post(ana.b, '/to/ben', { bot: ana.botId });
  assert.equal(asked.status, 200);
  assert.match(asked.page, /<h2>Asked<\/h2><p>Ben says yes on their side\.<\/p><a class="btn wide" href="\/app">/);
  const mine = contact(env, ana.botId, ben.botId), theirs = contact(env, ben.botId, ana.botId);
  assert.ok(mine.approved_at, 'the visitor said yes by asking');
  assert.equal(theirs.approved_at, null, 'the owner says yes on their side');
  assert.equal(mine.alias, 'Ben');
  assert.equal(theirs.alias, 'Ana');
  // The owner sees it in the usual pending list, saying where it came from.
  const overview = bare((await ben.b('/app')).text);
  assert.match(overview, /Ana Svoboda wants to connect[^]*asked through your public link for <span class="handle">@ben-bot<\/span>[^]*Yes, connect[^]*No, remove/);
  // Asking again changes nothing.
  assert.match((await post(ana.b, '/to/ben', { bot: ana.botId })).page, /<h2>Asked<\/h2>/);
  assert.equal(db(env).prepare('SELECT count(*) AS n FROM contacts WHERE owner_bot = ?').get(ben.botId).n, 1);
  // The owner gets the usual reminder email after a few minutes.
  env.advance(6 * 60_000);
  await (async () => { for (let i = 0; i < 40 && !env.mail.some((m) => m.to === 'ben@example.com' && !/login code/.test(m.subject)); i++) await new Promise((r) => setTimeout(r, 50)); })();
  const reminder = env.mail.find((m) => m.to === 'ben@example.com' && !/login code/.test(m.subject));
  assert.ok(reminder, 'approve reminder');
  // It says what happened: someone asked through the link (not "your bot accepted an invite").
  assert.match(reminder.subject, /^Ana Svoboda wants to connect$/);
  assert.match(reminder.text, /Ana Svoboda asked through your public link to connect with your bot @ben-bot\. Tap Yes, connect/);
  assert.doesNotMatch(reminder.text, /accepted an invite|Next time, try inviting/);
  // Yes: both sides approved, and the visitor's page says they're connected.
  const yes = await ben.b('/app/contacts/approve', { method: 'POST', form: { bot: ben.botId, peer: ana.botId } });
  assert.equal(yes.status, 303);
  assert.ok(contact(env, ben.botId, ana.botId).approved_at);
  assert.ok(contact(env, ana.botId, ben.botId).approved_at);
  const already = await post(ana.b, '/to/ben', { bot: ana.botId });
  assert.match(already.page, /<h2>You&#39;re already connected<\/h2>|<h2>You're already connected<\/h2>/);
  assert.match(already.page, /href="\/app#friends">Open Ben</);
});

test('your own bot, already connected, and a blocked visitor (who sees "Asked" while nothing is made)', async (t0) => {
  const { env, ben } = await withLink(t0);
  // Ben opens his own link.
  assert.match(bare((await ben.b('/to/ben')).text), /That’s your own bot[^]*href="\/app\/bots\/\d+#link">Go to your bot/);
  assert.match((await post(ben.b, '/to/ben', { bot: ben.botId })).page, /That’s your own bot/);
  assert.equal(db(env).prepare('SELECT count(*) AS n FROM contacts WHERE owner_bot = ?').get(ben.botId).n, 0);
  // Tom asked once, Ben said no and blocked him: asking again shows "Asked" and makes nothing.
  const tom = await person(env, 'tom@example.com', 'tom-bot', 'Tom');
  await post(tom.b, '/to/ben', { bot: tom.botId });
  await ben.b('/app/contacts/block', { method: 'POST', form: { bot: ben.botId, peer: tom.botId } });
  db(env).prepare('DELETE FROM contacts WHERE owner_bot = ? AND peer_bot = ?').run(tom.botId, ben.botId); // Tom removed Ben on his side
  const tom2 = addBot(env, tom.userId, 'tom-two');
  const again = await post(tom.b, '/to/ben', { bot: tom2 });
  assert.match(again.page, /<h2>Asked<\/h2>/);
  assert.equal(contact(env, tom2, ben.botId), undefined);
  assert.equal(contact(env, ben.botId, tom2), undefined);
  // No bot yet: adding one comes first.
  const mia = await login(env, 'mia@example.com');
  const none = bare((await mia('/to/ben')).text);
  assert.match(none, /Add your bot first, then open this link again\.[^]*<a class="btn wide" href="\/app\/bots\/add">Connect your bot</);
  // Someone else's bot id in the form isn't theirs to ask with.
  assert.equal((await mia('/to/ben', { method: 'POST', form: { bot: tom.botId } })).status, 400);
});

test('limits: 10 requests per account a day, 25 waiting per link', async (t0) => {
  const env = await setup(t0, { limits: { loginEmailsPerIpPerHour: 100 } });
  const ana = await person(env, 'ana@example.com', 'ana-bot', 'Ana');
  // Eleven people with links.
  for (let i = 1; i <= 11; i++) {
    const u = await person(env, `p${i}@example.com`, `p${i}-bot`, `P${i}`);
    db(env).prepare('INSERT INTO contact_links (bot_id, name, on_at, created_at) VALUES (?, ?, ?, ?)').run(u.botId, `p${i}-link`, env.now(), env.now());
  }
  for (let i = 1; i <= 10; i++) assert.match((await post(ana.b, `/to/p${i}-link`, { bot: ana.botId })).page, /<h2>Asked<\/h2>/, `ask ${i}`);
  const eleventh = await post(ana.b, '/to/p11-link', { bot: ana.botId });
  assert.equal(eleventh.status, 429);
  assert.match(eleventh.page, /You&#39;ve asked enough people for today\. Try again tomorrow\.|You've asked enough people for today/);
  env.advance(86_400_000 + 1000);
  assert.match((await post(ana.b, '/to/p11-link', { bot: ana.botId })).page, /<h2>Asked<\/h2>/, 'a day later');

  // 25 people wait on Ben's link: the next one hears it's busy until Ben answers someone.
  const ben = await person(env, 'ben@example.com', 'ben-bot', 'Ben');
  await post(ben.b, `/app/bots/${ben.botId}/link`, { do: 'on', name: 'ben' });
  for (let i = 1; i <= 25; i++) {
    const id = addBot(env, ana.userId + 100 + i, `w${i}-bot`);
    db(env).prepare('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at, gen) VALUES (?, ?, ?, ?, NULL, ?)').run(ben.botId, id, `W${i}`, env.now(), env.now());
    db(env).prepare('INSERT INTO contact_link_asks (owner_bot, from_bot, created_at) VALUES (?, ?, ?)').run(ben.botId, id, env.now());
  }
  const tom = await person(env, 'tom@example.com', 'tom-bot', 'Tom');
  const busy = await post(tom.b, '/to/ben', { bot: tom.botId });
  assert.equal(busy.status, 429);
  assert.match(busy.page, /This link is busy, try again later\./);
  assert.equal(contact(env, tom.botId, ben.botId), undefined);
  db(env).prepare('UPDATE contacts SET approved_at = ? WHERE owner_bot = ? AND alias = ?').run(env.now(), ben.botId, 'W1');
  assert.match((await post(tom.b, '/to/ben', { bot: tom.botId })).page, /<h2>Asked<\/h2>/);
});

test('the badge is one static SVG with long cache headers', async (t0) => {
  const env = await setup(t0);
  const r = await fetch(`${env.url}/badge.svg`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/svg+xml');
  assert.match(r.headers.get('cache-control'), /public, max-age=\d{7,}/);
  const svg = await r.text();
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*aria-label="Talk to my agent · bot2bot"/);
  assert.match(svg, />Talk to my agent<[^]*>bot2bot</);
  assert.doesNotMatch(svg, /<script|href=/);
});

test('deleting an account frees its link name', async (t0) => {
  const { env, ben } = await withLink(t0);
  await ben.b('/app/account/delete', { method: 'POST', form: { confirm: 'ben@example.com' } });
  assert.equal((await browser(env.url)('/to/ben')).status, 404);
  assert.equal(db(env).prepare('SELECT count(*) AS n FROM contact_links').get().n, 0);
});
