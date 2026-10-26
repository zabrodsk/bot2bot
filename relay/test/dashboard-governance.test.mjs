// Part U: the owner's side of governance. People in baskets as stickers, the requests page (replies waiting
// for a yes, and changes the bot can't make alone), sticker pictures for everyone, and the bot tools.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, owner, login, browser, connect, connectApp, msgId, waitFor, cliHome } from './helpers.mjs';

const CLI = join(import.meta.dirname, '..', 'cli', 'b2b.mjs');
const cliIn = (home, input, ...args) => new Promise((ok, fail) => {
  const ch = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, B2B_HOME: home } });
  let out = '', err = '';
  ch.stdout.on('data', (d) => { out += d; }); ch.stderr.on('data', (d) => { err += d; });
  ch.on('close', (code) => (code === 0 ? ok(out) : fail(Object.assign(new Error(err), { stderr: err, code }))));
  ch.stdin.end(input);
});
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
function stickerDir(list) {
  const dir = mkdtempSync(join(tmpdir(), 'b2b-stickers-'));
  if (list) writeFileSync(join(dir, 'index.json'), JSON.stringify(list));
  writeFileSync(join(dir, 'fox.png'), PNG);
  return dir;
}
const settings = (env, who) => env.relay.getSettings(Number(who.botId));
const contactOf = (env, who, other) => settings(env, who).contacts.find((c) => c.peer_bot === Number(other.botId));
const circleId = (env, who, name) => settings(env, who).circles.find((c) => c.name === name).id;
const putIn = (env, who, other, name) => env.relay.applyOwnerOps(Number(who.botId), [{ op: 'move', contact: Number(other.botId), circle: name ? circleId(env, who, name) : null }]);
const gen = (env, who, other) => env.relay.db.prepare('SELECT gen FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(who.botId, other.botId).gen;
// A bot enrolled without a doorbell or keys, so its inbox waits until the test reads it.
async function quietBot(env, email, handle) {
  const b = await login(env, email);
  await b('/app/bots', { method: 'POST', form: { handle } });
  const code = (await b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const r = await (await fetch(`${env.url}/v1/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })).json();
  const { home, cli } = cliHome();
  writeFileSync(join(home, 'config.json'), JSON.stringify({ relay: env.url, token: r.token, handle }));
  return { b, cli, home, token: r.token, botId: String(env.relay.db.prepare('SELECT id FROM bots WHERE handle = ?').get(handle).id) };
}
// The owner's own session cookie, for posting with any Origin header.
async function sessionCookie(env, email) {
  await browser(env.url)('/login', { method: 'POST', form: { email } });
  const code = env.mail.filter((m) => m.to === email).at(-1).text.match(/code is (\d{6})/)[1];
  const r = await fetch(`${env.url}/login/verify`, { method: 'POST', redirect: 'manual', headers: { origin: env.url, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, code }) });
  return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

test('pictures: the sticker set is for everyone, read from index.json, robots stay, and the pilot pages stay hidden', async (t0) => {
  const dir = stickerDir([{ key: 'fox', name: 'Fox' }, 'ghost', { key: '../etc', name: 'Bad' }]);
  const env = await setup(t0, { stickersDir: dir });
  const b = await login(env, 'kim@example.com');
  for (const p of ['/app/people', '/app/requests', '/app/requests/req_abcdefgh', '/app/proposals/prop_abcdefgh']) assert.equal((await b(p)).status, 404, p);
  assert.doesNotMatch((await b('/app')).text, /href="\/app\/people"|href="\/app\/requests"/);
  let html = (await b('/app/picture')).text;
  assert.match(html, /<legend class="pfp__legend">Stickers<\/legend>/);
  assert.match(html, /<input type="radio" name="avatar" value="sticker:fox"><span class="pfp__img pfp__img--cut"><img src="\/stickers\/fox\.png"/);
  assert.doesNotMatch(html, /sticker:ghost|sticker:\.\.|stickers\/ghost/, 'listed without a file, or not a key: left out');
  assert.equal((html.match(/name="avatar" value="[a-z]+"/g) || []).length, 12, 'the twelve robots are still there');
  assert.equal((await b('/app/picture', { method: 'POST', form: { avatar: 'sticker:fox' } })).status, 303);
  assert.equal(env.relay.db.prepare("SELECT avatar FROM users WHERE email = 'kim@example.com'").get().avatar, 'sticker:fox');
  html = (await b('/app')).text;
  assert.match(html, /<span class="avatar avatar--md avatar--cut" aria-hidden="true">K<img src="\/stickers\/fox\.png"/);
  // Only real stickers: an unknown one changes nothing.
  assert.equal((await b('/app/picture', { method: 'POST', form: { avatar: 'sticker:ghost' } })).status, 303);
  assert.equal(env.relay.db.prepare("SELECT avatar FROM users WHERE email = 'kim@example.com'").get().avatar, 'sticker:fox');
  const png = await fetch(`${env.url}/stickers/fox.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await png.arrayBuffer()), PNG);
  for (const p of ['/stickers/ghost.png', '/stickers/FOX.png', '/stickers/..%2Findex.json.png', '/stickers/index.json']) assert.equal((await fetch(env.url + p)).status, 404, p);
  const font = await fetch(`${env.url}/hand/caveat-latin.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/woff2');
  assert.match((await b('/app')).text, /url\(\/hand\/caveat-latin\.woff2\)/);
  // The set changes without a restart; with no list there are only robots.
  writeFileSync(join(dir, 'index.json'), '[]');
  html = (await b('/app/picture')).text;
  assert.doesNotMatch(html, />Stickers<|sticker:fox/);
  assert.equal((await fetch(`${env.url}/stickers/fox.png`)).status, 404);
  const none = await setup(t0, { stickersDir: stickerDir(null) });
  assert.doesNotMatch((await (await login(none, 'lou@example.com'))('/app/picture')).text, />Stickers</);
});

test('people: baskets and modes are the owner\'s, for their own bots, from their own pages', async (t0) => {
  const env = await setup(t0, { privacyPilot: ['ann@example.com', 'ben@example.com'] });
  const ann = await owner(env, t0, 'ann@example.com', 'ann');
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  const people = `/app/people/${ann.botId}/${ben.botId}`;
  let html = (await ann.b('/app/people')).text;
  assert.match(html, /<a class="tabs__item" href="\/app\/people" aria-current="page">People<\/a><a class="tabs__item" href="\/app\/requests">Requests<\/a>/);
  assert.match(html, /<h1>People<\/h1>/);
  for (const name of ['family', 'friends', 'work']) assert.match(html, new RegExp(`<h2 class="basket__name hand">${name}</h2>`));
  // A sticker: a link to their page, the name for screen readers, and in sight only on hover or focus.
  assert.match(html, new RegExp(`<a class="stk" href="${people}" draggable="false" aria-label="Ben, not sorted yet"[^>]*data-peer="${ben.botId}" data-name="Ben" data-in="">`));
  assert.match(html, /<span class="stk__name" aria-hidden="true">ben<\/span>/);
  assert.match(html, /<p class="sr" id="stk-help">Press Enter to move them to another basket, or Space to open their page\.<\/p>/);
  assert.match(html, /<div class="pool" data-drop="" aria-label="Not sorted yet, 1 person">/);
  assert.equal(contactOf(env, ann, ben).effective_mode, 'asks');

  // Drag and drop and the keyboard menu post this same form.
  const g0 = gen(env, ann, ben);
  let r = await ann.b('/app/people/move', { method: 'POST', form: { bot: ann.botId, peer: ben.botId, circle: circleId(env, ann, 'friends') } });
  assert.equal(r.status, 303);
  assert.equal(r.location, `/app/people?bot=${ann.botId}`);
  assert.equal(contactOf(env, ann, ben).circle.name, 'friends');
  assert.equal(contactOf(env, ann, ben).effective_mode, 'handles', 'the owner widens directly; no proposal');
  assert.ok(gen(env, ann, ben) > g0);
  assert.match((await ann.b('/app/people')).text, /<section class="basket" data-drop="\d+" data-mode="handles" aria-label="friends, 1 person">/);

  // By default a basket shows no mode: the bot handles it and asks when it isn't sure.
  html = (await ann.b('/app/people')).text;
  assert.doesNotMatch(html.match(/<section class="basket" data-drop="\d+" data-mode="handles" aria-label="friends[^]*?<\/section>/)[0], /asks you first<\/span>/);
  assert.match(html, /<p class="people__how">Your bot handles each basket on its own and asks you when it isn't sure\.<\/p>/);
  // "Asks you first" in the basket's menu switches the whole basket, and the basket says so.
  assert.match(html, /<button role="menuitemcheckbox" aria-checked="false">Asks you first<\/button>/);
  r = await ann.b('/app/people/mode', { method: 'POST', form: { bot: ann.botId, circle: circleId(env, ann, 'friends'), mode: 'asks' } });
  assert.equal(r.status, 303);
  assert.equal(contactOf(env, ann, ben).effective_mode, 'asks');
  html = (await ann.b('/app/people')).text;
  assert.match(html, /<section class="basket" data-drop="\d+" data-mode="asks" aria-label="friends, 1 person, asks you first">[^]*?<div class="basket__tag"><span class="tag" data-mode="asks">/);
  assert.match(html, /<button role="menuitemcheckbox" aria-checked="true">Asks you first<\/button>/);

  // Baskets of their own: new ones work like the three, names are unique, and removing one unsorts its people.
  assert.equal((await ann.b('/app/people/baskets', { method: 'POST', form: { bot: ann.botId, name: 'school' } })).status, 303);
  const school = settings(env, ann).circles.find((c) => c.name === 'school');
  assert.equal(school.mode, 'handles');
  r = await ann.b('/app/people/baskets', { method: 'POST', form: { bot: ann.botId, name: 'School' } });
  assert.equal(r.status, 409);
  assert.match(r.text, /You already have a basket with that name\./);
  assert.equal((await ann.b('/app/people/baskets', { method: 'POST', form: { bot: ann.botId, circle: school.id, name: 'college' } })).status, 303);
  putIn(env, ann, ben, 'college');
  assert.equal((await ann.b('/app/people/baskets', { method: 'POST', form: { bot: ann.botId, circle: school.id, delete: '1' } })).status, 303);
  assert.equal(contactOf(env, ann, ben).circle, null);
  assert.equal((await ann.b('/app/people/baskets', { method: 'POST', form: { bot: ann.botId, circle: circleId(env, ann, 'work'), delete: '1' } })).status, 400, 'the three stay');

  // Someone else's bot, contact or basket: not found, and nothing changes.
  const before = JSON.stringify(settings(env, ann));
  assert.equal((await ben.b('/app/people/move', { method: 'POST', form: { bot: ann.botId, peer: ben.botId, circle: '' } })).status, 404);
  assert.equal((await ben.b('/app/people/mode', { method: 'POST', form: { bot: ben.botId, circle: circleId(env, ann, 'family'), mode: 'asks' } })).status, 404);
  assert.equal((await ben.b(people)).status, 404);
  assert.equal((await ann.b(`/app/people/${ann.botId}/${ann.botId}`)).status, 404);
  assert.equal(JSON.stringify(settings(env, ann)), before);
  // Outside the pilot, and without a session or from another site.
  const cara = await owner(env, t0, 'cara@example.com', 'cara');
  assert.equal((await cara.b('/app/people')).status, 404);
  assert.equal((await cara.b('/app/people/move', { method: 'POST', form: { bot: cara.botId, peer: ann.botId, circle: '' } })).status, 404);
  const r2 = await browser(env.url, { authorization: `Bearer ${JSON.parse(readFileSync(join(ann.home, 'config.json'), 'utf8')).token}` })('/app/people');
  assert.equal(r2.status, 303);
  assert.match(r2.location, /^\/login/);
  const cookie = await sessionCookie(env, 'ann@example.com');
  const post = (origin) => fetch(`${env.url}/app/people/move`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) }, body: new URLSearchParams({ bot: ann.botId, peer: ben.botId, circle: circleId(env, ann, 'family') }) });
  assert.equal((await post('https://evil.example')).status, 403);
  assert.equal((await post(null)).status, 403);
  assert.equal(contactOf(env, ann, ben).circle, null);
  assert.equal((await post(env.url)).status, 303);
  assert.equal(contactOf(env, ann, ben).circle.name, 'family');
});

test('a person\'s page: basket and override, who they are, notes, topics and rules, learned ones labelled', async (t0) => {
  const env = await setup(t0, { privacyPilot: true });
  const ann = await owner(env, t0, 'ann@example.com', 'ann');
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  const base = `/app/people/${ann.botId}/${ben.botId}`;
  let html = (await ann.b(base)).text;
  assert.match(html, /<h1 class="person__name hand" id="person-h">Ben<\/h1>/);
  assert.match(html, /Ben isn't in a basket yet, so your bot asks you first\./);
  // Not sorted yet already asks first, so the switch shows it and waits for a basket.
  assert.match(html, /name="mode" value="asks" aria-labelledby="ask-first" data-autosave checked disabled>/);
  assert.match(html, /<a class="crumb" href="\/app\/people\?bot=\d+">/);

  assert.equal((await ann.b(`${base}/basket`, { method: 'POST', form: { circle: circleId(env, ann, 'work'), mode: 'asks' } })).status, 303);
  let c = contactOf(env, ann, ben);
  assert.deepEqual([c.circle.name, c.mode_override, c.effective_mode], ['work', 'asks', 'asks']);
  assert.match((await ann.b(base)).text, /Your bot asks you before it answers Ben\./);
  assert.equal((await ann.b(`${base}/basket`, { method: 'POST', form: { circle: circleId(env, ann, 'work'), mode: '' } })).status, 303);
  assert.equal(contactOf(env, ann, ben).effective_mode, 'handles');
  assert.equal((await ann.b(`${base}/basket`, { method: 'POST', form: { circle: circleId(env, ann, 'work'), mode: 'invalid' } })).status, 400);
  assert.equal(contactOf(env, ann, ben).effective_mode, 'handles');

  const r = await ann.b(`${base}/about`, { method: 'POST', form: { purpose: 'football friend', notes: 'Only football.\r\nAnything else, ask me first.' } });
  assert.equal(r.location, `${base}#about`);
  c = contactOf(env, ann, ben);
  assert.deepEqual([c.purpose, c.notes], ['football friend', 'Only football. Anything else, ask me first.']);
  assert.equal((await ann.b(`${base}/about`, { method: 'POST', form: { purpose: 'x'.repeat(61), notes: '' } })).status, 400);

  await ann.b(`${base}/topics`, { method: 'POST', form: { add: 'Football' } });
  assert.deepEqual(contactOf(env, ann, ben).topics, ['football'], 'the owner adds topics directly');
  await ann.b(`${base}/rules`, { method: 'POST', form: { add: 'Never says yes to a meeting without me' } });
  await ann.api('POST', '/v1/decisions', { contact: 'Ben', topic: 'location', answer: 'share', always_days: ['wed'] });
  html = (await ann.b(base)).text;
  assert.match(html, /<p class="person__note hand">football friend<\/p>/);
  assert.match(html, /<span>football<\/span><input type="hidden" name="remove" value="football"><button aria-label="Stop Ben asking about football">/);
  assert.match(html, /<li class="rule"><span class="rule__text">Never says yes to a meeting without me<\/span>\n<span class="rule__meta"><span>Set by you<\/span><\/span>/);
  assert.match(html, /<li class="rule is-new"><span class="rule__text">Shares location on Wednesdays<\/span>\n<span class="rule__meta"><span class="hand">learned<\/span><span>from your answers<\/span><\/span>/);
  const learned = contactOf(env, ann, ben).rules.find((x) => x.source === 'learned');
  assert.equal((await ann.b(`${base}/rules`, { method: 'POST', form: { remove: learned.id } })).status, 303);
  await ann.b(`${base}/topics`, { method: 'POST', form: { remove: 'football' } });
  c = contactOf(env, ann, ben);
  assert.deepEqual([c.topics, c.rules.map((x) => x.source)], [[], ['owner']]);
  // Another person's rule id, through this page: not found.
  await ben.b(`/app/people/${ben.botId}/${ann.botId}/rules`, { method: 'POST', form: { add: 'Ben rule' } });
  const bensRule = contactOf(env, ben, ann).rules[0].id;
  assert.equal((await ann.b(`${base}/rules`, { method: 'POST', form: { remove: bensRule } })).status, 404);
  assert.equal(contactOf(env, ben, ann).rules.length, 1);
});

test('requests: an end-to-end pair, decided on the page, sent sealed by the bot exactly once', async (t0) => {
  const env = await setup(t0, { privacyPilot: true });
  const ann = await owner(env, t0, 'ann@example.com', 'ann');
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  putIn(env, ben, ann, 'friends');
  const ask = msgId(await ben.cli('send', 'Ann', 'Where are you?', '--ask'));
  await assert.rejects(ann.cli('reply', ask, 'At the park'), (e) => /owner_approval_required: .*Use propose_reply\./.test(e.stderr));
  const out = await ann.cli('propose', ask, 'At the park', '--question', 'Share where you are with Ben?');
  const id = out.match(/Draft saved as (req_[\w-]+)\. Nothing is sent yet\. Give your owner this link to okay, edit or decline it: (\S+) \(it expires in 24 hours\)\./)[1];
  assert.match(out, new RegExp(`${env.url}/app/requests/${id}`));

  let html = (await ann.b('/app/requests')).text;
  assert.match(html, /Requests<span class="tabs__count" aria-hidden="true">1<\/span><span class="sr"> \(1 waiting\)<\/span>/);
  assert.match(html, /<p class="ask__q">Share where you are with Ben\?<\/p>/);
  assert.match(html, /End-to-end encrypted, so only your bot could read their message\./);
  assert.match(html, /<p class="ask__label">Your bot's draft<\/p><p class="ask__text">At the park<\/p>/);
  for (const label of ['Send once', 'Decline']) assert.match(html, new RegExp(`<button class="btn( ghost)?">${label}</button>`));
  for (const label of ['Edit', 'Write my own']) assert.match(html, new RegExp(`<summary class="btn ghost">${label}</summary>`));
  assert.match((await ann.b('/app')).text, /Your bot needs your okay/);

  const decide = (form, who = ann) => who.b(`/app/requests/${id}`, { method: 'POST', form });
  assert.equal((await decide({ action: 'send', revision: '1' }, ben)).status, 404, 'only its owner');
  const stale = await decide({ action: 'send', revision: '7' });
  assert.equal(stale.status, 409);
  assert.match(stale.text, /Your bot changed the draft while you were looking\./);
  const r = await decide({ action: 'edit', revision: '1', text: 'At the park entrance' });
  assert.equal(r.location, '/app/requests', 'back to what is still waiting');
  assert.equal(env.relay.getRequest(Number(ann.botId), id).state, 'APPROVED', 'an end-to-end pair: the bot seals and sends it');
  assert.equal((await decide({ action: 'decline', revision: '2' })).status, 303, 'a retry returns what was recorded');
  assert.equal(env.relay.getRequest(Number(ann.botId), id).state, 'APPROVED');
  assert.match((await ann.b(`/app/requests/${id}`)).text, /Okayed\. Your bot sends it end-to-end encrypted the next time it runs\./);
  assert.match(await ann.cli('settings'), new RegExp(`Okayed by your owner, not sent yet: ${id}\\. Send it: node ~/bin/b2b\\.mjs request ${id}`));

  const sent = await ann.cli('request', id);
  assert.match(sent, new RegExp(`Your owner okayed ${id}\\. Sent it as msg_[\\w-]+\\. End-to-end encrypted\\.`));
  const row = env.relay.db.prepare('SELECT * FROM messages WHERE privacy_request_id = ?').get(id);
  assert.ok(row.sealed);
  assert.equal(row.text, '');
  assert.equal(row.reply_to, ask);
  assert.equal(env.relay.getRequest(Number(ann.botId), id).state, 'ENQUEUED');
  assert.match(await ann.cli('request', id), new RegExp(`Your owner okayed ${id} and it was sent as ${row.id}\\.`));
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM messages WHERE from_bot = ? AND to_bot = ? AND kind != ?').get(ann.botId, ben.botId, 'probe').n, 1);
  await waitFor(async () => /At the park entrance/.test(await ben.cli('received')));
  assert.doesNotMatch((await ann.b('/app/requests')).text, /class="tabs__count"/);
});

test('requests: a connected-app bot asks, the owner writes their own answer, and it goes out at once', async (t0) => {
  const env = await setup(t0, { privacyPilot: true });
  const ann = await owner(env, t0, 'ann@example.com', 'ann');
  const mia = { b: await login(env, 'mia@example.com') };
  const app = await connectApp(env, mia.b, 'mia-bot');
  mia.botId = String(env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'mia-bot'").get().id);
  await connect(ann, mia, 'Ann');
  putIn(env, ann, mia, 'friends');
  const ask = msgId(await ann.cli('send', 'Mia', 'Free Friday?', '--ask'));

  const inbox = await app.tool('check_inbox');
  assert.match(inbox.content[0].text, new RegExp(`Your owner's settings for "Ann" \\(not in a basket yet\\): your owner okays anything you send them first\\. To answer, draft a reply and ask them: call propose_reply with message_id=${ask} and a short topic, then give your owner the link it returns`));
  const rec = inbox.structuredContent.records.find((x) => x.type === 'message');
  assert.deepEqual(rec.owner_rules, { topic_allowed: false, mode: 'asks', circle: null, purpose: null, notes: null, rules: [] });
  await app.tool('mark_delivered', { receipt: rec.receipt });
  const refused = await app.tool('reply', { message_id: ask, text: 'Yes' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /owner_approval_required/);

  const proposed = await app.tool('propose_reply', { message_id: ask, text: 'Yes, Friday works', question: 'Tell Ann Friday works?' });
  const id = proposed.structuredContent.id;
  assert.match(proposed.content[0].text, new RegExp(`Draft saved as ${id}\\.`));
  assert.match((await mia.b('/app/requests')).text, /<figcaption>Ann's bot wrote<\/figcaption><blockquote>Free Friday\?<\/blockquote>/);
  const r = await mia.b(`/app/requests/${id}`, { method: 'POST', form: { action: 'write', revision: '1', text: 'Friday works, see you at 7!' } });
  assert.equal(r.status, 303);
  const req = env.relay.getRequest(Number(mia.botId), id, { owner: true });
  assert.equal(req.state, 'ENQUEUED');
  const out = env.relay.db.prepare('SELECT * FROM messages WHERE id = ?').get(req.outbound_message_id);
  assert.deepEqual([out.text, out.from_bot, out.to_bot, out.kind, out.reply_to, out.privacy_request_id], ['Friday works, see you at 7!', Number(mia.botId), Number(ann.botId), 'reply', ask, id]);
  assert.match((await app.tool('get_request', { id })).content[0].text, new RegExp(`Your owner okayed ${id} and it was sent as ${out.id}\\.`));
  assert.match((await mia.b(`/app/requests/${id}`)).text, /<span class="ask__stamp" aria-hidden="true">sent<\/span><div class="ask__done"><p role="status">Sent to Ann\.<\/p>/);

  // A new message, declined: nothing goes out.
  const second = (await app.tool('propose_reply', { to: 'Ann', text: 'Lunch tomorrow?' })).structuredContent.id;
  assert.equal((await mia.b(`/app/requests/${second}`, { method: 'POST', form: { action: 'decline', revision: '1' } })).status, 303);
  assert.match((await app.tool('get_request', { id: second })).content[0].text, /declined .*Nothing was sent\. Don't send it another way\./);
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM messages WHERE from_bot = ?').get(mia.botId).n, 1);

  // Settings and decisions from the connected app.
  const upd = await app.tool('update_settings', { ops: [{ op: 'set_purpose', contact: 'Ann', purpose: 'climbing buddy' }, { op: 'set_mode', contact: 'Ann', mode: 'handles' }] });
  assert.match(upd.content[0].text, /^Done: set_purpose\.\nSome of it gives you more freedom, so your owner decides\. Give them this link to okay it: http\S+\/app\/proposals\/prop_[\w-]+ Nothing else changes until they do\.$/);
  const st = await app.tool('get_settings');
  assert.match(st.content[0].text, /^Baskets: family \(you handle it\), friends \(you handle it\), work \(you handle it\)\nPeople:\n- "Ann" \(@ann\): not in a basket, your owner okays first · who they are: "climbing buddy"/);
  assert.match(st.content[0].text, /Waiting for your owner: a settings change, link /);
  assert.match((await app.tool('record_decision', { contact: 'Ann', topic: 'location', answer: 'share', always_days: ['wed'] })).content[0].text, /That taught you a new rule\./);
  assert.match((await app.tool('get_settings')).content[0].text, /New rules learned from your owner's answers\. Tell your owner about each one once:\n {2}"Shares location with Ann on wed"\nThen mark them as told: call update_settings with \[\{"op":"ack_learned","ids":\["rule_[\w-]+"\]\}\]/);
});

test('proposals: changes that give the bot more freedom wait for a tap, and are checked again on approval', async (t0) => {
  const env = await setup(t0, { privacyPilot: true });
  const ann = await quietBot(env, 'ann@example.com', 'ann');
  const ben = await quietBot(env, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  const out = await cliIn(ann.home, JSON.stringify([{ op: 'set_notes', contact: 'Ben', notes: 'Only football' }, { op: 'move', contact: 'Ben', circle: 'friends' }]), 'settings', 'apply', '-');
  assert.match(out, /^Done: set_notes\.\nSome of it gives you more freedom, so your owner decides\. Give them this link to okay it: \S+\/app\/proposals\/(prop_[\w-]+) Nothing else changes until they do\.\n$/);
  const id = out.match(/(prop_[\w-]+)/)[1];
  assert.equal(contactOf(env, ann, ben).notes, 'Only football');
  assert.equal(contactOf(env, ann, ben).circle, null);
  let html = (await ann.b('/app/requests')).text;
  assert.match(html, /<p class="ask__q">Okay to change this\?<\/p>\n<ul class="changes"><li>Put Ben in friends<\/li><\/ul>/);
  assert.equal((await ben.b(`/app/proposals/${id}`)).status, 404);
  assert.equal((await ben.b(`/app/proposals/${id}`, { method: 'POST', form: { decision: 'approve' } })).status, 404);
  assert.equal(contactOf(env, ann, ben).circle, null);
  const r = await ann.b(`/app/proposals/${id}`, { method: 'POST', form: { decision: 'approve' } });
  assert.equal(r.location, '/app/requests', 'back to what is still waiting');
  assert.equal(contactOf(env, ann, ben).circle.name, 'friends');
  assert.match((await ann.b(`/app/proposals/${id}`)).text, /Done\. Your bot has the new settings\./);

  // Declined: nothing changes.
  const topic = (await cliIn(ann.home, '{"ops":[{"op":"add_topic","contact":"Ben","topic":"football"}]}', 'settings', 'apply', '-')).match(/(prop_[\w-]+)/)[1];
  assert.match((await ann.b('/app/requests')).text, /<li>Let Ben ask about football<\/li>/);
  await ann.b(`/app/proposals/${topic}`, { method: 'POST', form: { decision: 'decline' } });
  assert.deepEqual(contactOf(env, ann, ben).topics, []);
  assert.match((await ann.b(`/app/proposals/${topic}`)).text, /Declined\. Nothing changed\./);

  // Checked again: the basket it named is gone by the time the owner taps yes.
  env.relay.applyOwnerOps(Number(ann.botId), [{ op: 'add_circle', name: 'club', mode: 'handles' }, { op: 'move', contact: Number(ben.botId), circle: null }]);
  const club = (await cliIn(ann.home, '[{"op":"move","contact":"Ben","circle":"club"}]', 'settings', 'apply', '-')).match(/(prop_[\w-]+)/)[1];
  env.relay.applyOwnerOps(Number(ann.botId), [{ op: 'delete_circle', circle: 'club' }]);
  const late = await ann.b(`/app/proposals/${club}`, { method: 'POST', form: { decision: 'approve' } });
  assert.equal(late.status, 409);
  assert.match(late.text, /This change doesn't fit any more: Circle not found\. Ask your bot again\./);
  assert.equal(contactOf(env, ann, ben).circle, null);
  assert.equal(env.relay.db.prepare('SELECT state FROM settings_proposals WHERE id = ?').get(club).state, 'PENDING_OWNER');
});

test('tools: settings, decisions and an inbox that carries what the owner set for each sender', async (t0) => {
  const env = await setup(t0, { privacyPilot: ['ann@example.com', 'ben@example.com'] });
  const ann = await quietBot(env, 'ann@example.com', 'ann');
  const ben = await quietBot(env, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  putIn(env, ben, ann, 'friends');
  env.relay.applyOwnerOps(Number(ann.botId), [{ op: 'move', contact: Number(ben.botId), circle: circleId(env, ann, 'friends') },
    { op: 'set_purpose', contact: Number(ben.botId), purpose: 'football friend' }, { op: 'set_notes', contact: Number(ben.botId), notes: 'Plays on Wednesdays' },
    { op: 'add_rule', contact: Number(ben.botId), text: 'Only football' }]);
  const s = JSON.parse(await ann.cli('settings', '--json'));
  assert.deepEqual(s.circles.map((c) => c.name), ['family', 'friends', 'work']);
  const text = await ann.cli('settings');
  assert.match(text, /^Baskets: family \(you handle it\), friends \(you handle it\), work \(you handle it\)\nPeople:\n- "Ben" \(@ben\): basket "friends", you handle it · who they are: "football friend"\n {2}notes: "Plays on Wednesdays"\n {2}rule rule_[\w-]+: "Only football"\nQuiet hours: /);

  assert.match(await ann.cli('decision', 'Ben', 'location', 'share', '--always', 'wed,thu'), /^Noted\. That taught you a new rule\./);
  const ids = settings(env, ann).new_learned_rules.map((r) => r.id);
  assert.equal(ids.length, 2);
  assert.match(await ann.cli('settings'), new RegExp(`Then mark them as told: node ~/bin/b2b\\.mjs settings apply - \\(the JSON on stdin\\) with \\[\\{"op":"ack_learned","ids":\\["${ids[0]}","${ids[1]}"\\]\\}\\]`));
  assert.match(await cliIn(ann.home, JSON.stringify([{ op: 'ack_learned', ids }]), 'settings', 'apply', '-'), /^Done: ack_learned\.\n$/);
  assert.equal(settings(env, ann).new_learned_rules.length, 0);
  await assert.rejects(ann.cli('decision', 'Ben', 'location', 'maybe'), (e) => /Usage: b2b decision/.test(e.stderr));

  await ben.cli('send', 'Ann', 'Training moved to 8?');
  const recs = (await ann.cli('inbox', '--json')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const m = recs.find((x) => x.type === 'message');
  assert.deepEqual({ ...m.owner_rules, rules: [...m.owner_rules.rules].sort() }, { topic_allowed: false, mode: 'handles', circle: 'friends', purpose: 'football friend', notes: 'Plays on Wednesdays',
    rules: ['Only football', "Shares location with Ben on thu (learned from your owner's answers)", "Shares location with Ben on wed (learned from your owner's answers)"] });
  await ann.cli('ack', m.receipt);
  await ben.cli('send', 'Ann', 'And Friday?');
  const inbox = await ann.cli('inbox');
  assert.match(inbox, /\nYour owner's settings for "Ben" \(basket "friends"\): decide for this message\. Answer it yourself when it's ordinary for this basket or a rule below covers it, and tell your owner when it matters\. When it's sensitive \(where your owner is, their plans, money, health, private details, or saying yes to something for them\) or nothing below covers it, ask your owner first: either node ~\/bin\/b2b\.mjs propose msg_[\w-]+ - --topic "<topic>" \(your draft on stdin\) and give your owner the link it prints, or ask in your own chat and then record their answer: node ~\/bin\/b2b\.mjs decision @ben "<topic>" share\|decline\.\nWho they are to your owner: "football friend"\nYour owner's notes: "Plays on Wednesdays"\nRule: "Only football"\n/);

  // Outside the pilot the inbox is as before, and the new commands say so plainly.
  const cy = await quietBot(env, 'cy@example.com', 'cy');
  await connect(cy, ben, 'Cy');
  env.relay.db.prepare('UPDATE contacts SET mode_override = ? WHERE owner_bot = ?').run('handles', ben.botId);
  await ben.cli('send', 'Cy', 'Hi Cy');
  const cyMsg = (await cy.cli('inbox', '--json')).split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.type === 'message');
  assert.deepEqual(cyMsg.owner_rules, { topic_allowed: false });
  for (const args of [['settings'], ['request', 'req_abcdefgh'], ['decision', 'Ben', 'x', 'share']]) {
    await assert.rejects(cy.cli(...args), (e) => e.stderr === "Baskets and owner okays aren't turned on for your owner yet.\n", args.join(' '));
  }
});

test('review: every new owner POST rejects foreign or missing origins for forms and JSON', async (t) => {
  const env = await setup(t, { privacyPilot: true });
  const ann = await quietBot(env, 'ann@example.com', 'ann'), ben = await quietBot(env, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  const req = (await ann.cli('propose', 'Ben', 'Draft')).match(/req_[\w-]+/)[0];
  const prop = (await cliIn(ann.home, '[{"op":"add_topic","contact":"Ben","topic":"plans"}]', 'settings', 'apply', '-')).match(/prop_[\w-]+/)[0];
  const circle = circleId(env, ann, 'friends'), base = `/app/people/${ann.botId}/${ben.botId}`;
  const cases = [
    ['/app/people/move', { bot: ann.botId, peer: ben.botId, circle }],
    ['/app/people/mode', { bot: ann.botId, circle, mode: 'asks' }],
    ['/app/people/baskets', { bot: ann.botId, name: 'school' }],
    [`${base}/basket`, { circle, mode: 'handles' }], [`${base}/about`, { purpose: 'changed', notes: '' }],
    [`${base}/topics`, { add: 'football' }], [`${base}/rules`, { add: 'changed' }],
    [`/app/requests/${req}`, { action: 'send', revision: 1 }], [`/app/proposals/${prop}`, { decision: 'approve' }],
  ];
  const cookie = await sessionCookie(env, 'ann@example.com');
  const before = JSON.stringify(settings(env, ann));
  for (const [path, body] of cases) for (const json of [false, true]) for (const origin of [null, 'https://evil.example']) {
    const r = await fetch(env.url + path, { method: 'POST', redirect: 'manual', headers: { cookie,
      'content-type': json ? 'application/json' : 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}) }, body: json ? JSON.stringify(body) : new URLSearchParams(body) });
    assert.equal(r.status, 403, `${path}, JSON=${json}, origin=${origin}`);
  }
  assert.equal(JSON.stringify(settings(env, ann)), before);
  for (const [path, body] of cases) {
    const r = await browser(env.url, { authorization: `Bearer ${ann.token}` })(path, { method: 'POST', form: body });
    assert.equal(r.status, 303); assert.match(r.location, /^\/login/);
  }
  // Same-origin JSON works and still checks ownership.
  const post = (path, body) => fetch(env.url + path, { method: 'POST', redirect: 'manual', headers: { cookie, origin: env.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/app/people/move', { bot: ben.botId, peer: ann.botId, circle: '' })).status, 404);
  assert.equal((await post('/app/people/baskets', { bot: ann.botId, name: 'club' })).status, 303);
  assert.equal((await post('/app/people/baskets', null)).status, 400);
  assert.equal((await post(`/app/proposals/${prop}`, { decision: 'garbage' })).status, 400);
  assert.equal(env.relay.db.prepare('SELECT state FROM settings_proposals WHERE id = ?').get(prop).state, 'PENDING_OWNER');
  const cookieBen = await sessionCookie(env, 'ben@example.com');
  for (const path of [`/app/requests/${req}`, `/app/proposals/${prop}`]) {
    const r = await fetch(env.url + path, { method: 'POST', redirect: 'manual', headers: { cookie: cookieBen, origin: env.url, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'send', revision: 1, decision: 'approve' }) });
    assert.equal(r.status, 404);
  }
});

test('review: People, person and Requests escape every free-text field, including script data', async (t) => {
  const env = await setup(t, { privacyPilot: true }), ann = await quietBot(env, 'ann@example.com', 'ann'), ben = await quietBot(env, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  const payload = '</script><img src=x onerror="alert(1)">';
  const escaped = '&lt;/script&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;';
  env.relay.db.prepare('UPDATE contacts SET alias = ? WHERE owner_bot = ? AND peer_bot = ?').run(payload, ann.botId, ben.botId);
  env.relay.applyOwnerOps(Number(ann.botId), [{ op: 'add_circle', name: '</script><svg onload=x>', mode: 'asks' },
    { op: 'set_purpose', contact: Number(ben.botId), purpose: payload }, { op: 'set_notes', contact: Number(ben.botId), notes: payload },
    { op: 'add_rule', contact: Number(ben.botId), text: payload }]);
  const base = `/app/people/${ann.botId}/${ben.botId}`;
  for (const path of ['/app/people', base]) {
    const html = (await ann.b(path)).text;
    assert.doesNotMatch(html, /<img src=x|<svg onload=x>/);
    assert.match(html, new RegExp(escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const people = (await ann.b('/app/people')).text;
  const data = people.match(/<script type="application\/json" id="people-data">([^]*?)<\/script>/)[1];
  assert.doesNotMatch(data, /</);
  assert.equal(JSON.parse(data).baskets.at(-1).name, '</script><svg onload=x>');
  const inbound = env.relay.db.prepare("INSERT INTO messages(id, from_bot, to_bot, kind, text, links, created_at, status) VALUES ('msg_escape', ?, ?, 'ask', ?, '[]', ?, 'delivered')").run(ben.botId, ann.botId, payload, env.now());
  assert.ok(inbound.changes);
  env.relay.db.exec('BEGIN IMMEDIATE');
  const req = env.relay.governance.proposeReplyInTx(Number(ann.botId), { inbound_message_id: 'msg_escape', draft: { text: payload, links: ['https://example.com/?q="<x>'] }, question: payload });
  env.relay.db.exec('COMMIT');
  for (const path of ['/app/requests', `/app/requests/${req.id}`]) {
    const html = (await ann.b(path)).text;
    assert.doesNotMatch(html, /<img src=x|href="https:\/\/example.com\/\?q="<x>/);
    assert.ok(html.split(escaped).length >= 4, 'alias, inbound, draft and question all escaped');
  }
});

test('review: bot announcement cannot clear owner new-rule markers; Seen is owned and explicit', async (t) => {
  const env = await setup(t, { privacyPilot: true }), ann = await quietBot(env, 'ann@example.com', 'ann'), ben = await quietBot(env, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  await ann.cli('decision', 'Ben', 'location', 'share', '--always', 'wed');
  const learned = settings(env, ann).new_learned_rules[0];
  await cliIn(ann.home, JSON.stringify([{ op: 'ack_learned', ids: [learned.id] }, { op: 'add_rule', contact: 'Ben', text: 'Added in chat' }]), 'settings', 'apply', '-');
  const added = contactOf(env, ann, ben).rules.find((r) => r.via === 'bot');
  const base = `/app/people/${ann.botId}/${ben.botId}`;
  let html = (await ann.b(base)).text;
  assert.equal((html.match(/class="rule is-new"/g) || []).length, 2);
  assert.match(html, /Added by your bot/);
  assert.equal((await ben.b(`/app/people/${ben.botId}/${ann.botId}/rules`, { method: 'POST', form: { seen: learned.id } })).status, 404);
  for (const id of [learned.id, added.id]) assert.equal((await ann.b(`${base}/rules`, { method: 'POST', form: { seen: id } })).status, 303);
  html = (await ann.b(base)).text;
  assert.doesNotMatch(html, /class="rule is-new"/);
  assert.equal(contactOf(env, ann, ben).rules.length, 2);
});

test('review: no-JS person forms expose save and topic buttons, requests disclose draft visibility', async (t) => {
  const env = await setup(t, { privacyPilot: true }), ann = await quietBot(env, 'ann@example.com', 'ann'), ben = await quietBot(env, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  const base = `/app/people/${ann.botId}/${ben.botId}`;
  const html = (await ann.b(base)).text;
  assert.match(html, /<noscript><div><button class="btn small ghost">Save<\/button>/);
  assert.match(html, /<noscript><button class="btn small ghost">Add topic<\/button>/);
  await ann.b(`${base}/topics`, { method: 'POST', form: { add: 'football' } });
  const req = (await ann.cli('propose', 'Ben', 'Hello')).match(/req_[\w-]+/)[0];
  for (const path of ['/app/requests', `/app/requests/${req}`]) assert.match((await ann.b(path)).text, /For end-to-end chats, the relay can read drafts you send here for approval\./);
});

test('review: all thirty shipped stickers serve exact PNG bytes; font licence and Docker copies are present', async (t) => {
  const env = await setup(t), root = join(import.meta.dirname, '..');
  const list = JSON.parse(readFileSync(join(root, 'public/stickers/index.json'), 'utf8'));
  assert.equal(list.length, 30);
  for (const { key } of list) {
    const disk = readFileSync(join(root, 'public/stickers', `${key}.png`));
    assert.equal(disk.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const res = await fetch(`${env.url}/stickers/${key}.png`);
    assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), disk);
  }
  for (const path of ['/stickers/%2e%2e%2fhand/OFL.txt', '/stickers/%252e%252e%252fsecret.png', '/stickers/unlisted.png']) assert.equal((await fetch(env.url + path)).status, 404);
  for (const name of ['caveat-latin', 'caveat-latin-ext']) {
    const res = await fetch(`${env.url}/hand/${name}.woff2`);
    assert.equal(res.headers.get('content-type'), 'font/woff2');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(join(root, 'public/hand', `${name}.woff2`)));
  }
  assert.match(readFileSync(join(root, 'public/hand/OFL.txt'), 'utf8'), /Caveat Project Authors[^]*SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(readFileSync(join(root, 'Dockerfile'), 'utf8'), /COPY public \.\/public/);
  assert.match(readFileSync(join(root, '../Dockerfile'), 'utf8'), /COPY relay\/public \.\/public/);
  assert.equal(JSON.parse(readFileSync(join(root, 'package.json'))).version, '0.17.3');
  assert.equal((await cliHome().cli('version')).trim(), '0.17.3');
});

function privateMcp(t, who) {
  const child = spawn(process.execPath, [CLI, 'mcp'], { env: { ...process.env, B2B_HOME: who.home } });
  t.after(() => child.kill());
  let buffer = '', id = 0; const waiting = new Map();
  child.stdout.on('data', (data) => {
    buffer += data;
    for (let i; (i = buffer.indexOf('\n')) >= 0;) {
      const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
      waiting.get(message.id)?.(message); waiting.delete(message.id);
    }
  });
  return (name, args) => new Promise((resolve, reject) => {
    const n = ++id, timer = setTimeout(() => reject(new Error(`MCP timed out: ${name}`)), 10000);
    waiting.set(n, (r) => { clearTimeout(timer); resolve(r.result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

test('review: private MCP uses governance APIs and seals only the fetched approved draft', async (t) => {
  const env = await setup(t, { privacyPilot: true }), ann = await owner(env, t, 'ann@example.com', 'ann'), ben = await owner(env, t, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  const tool = privateMcp(t, ann);
  assert.match((await tool('get_settings', {})).content[0].text, /Baskets:/);
  assert.match((await tool('update_settings', { ops: [{ op: 'set_notes', contact: 'Ben', notes: 'Only football' }] })).content[0].text, /Done: set_notes/);
  assert.equal(contactOf(env, ann, ben).notes, 'Only football');
  for (let i = 0; i < 2; i++) assert.match((await tool('record_decision', { contact: 'Ben', topic: 'location', answer: 'share', client_id: 'mcp-answer' })).content[0].text, /Noted/);
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM owner_decisions').get().n, 1);
  const proposed = await tool('propose_reply', { to: 'Ben', text: 'Model draft' });
  const id = proposed.content[0].text.match(/req_[\w-]+/)[0];
  await ann.b(`/app/requests/${id}`, { method: 'POST', form: { action: 'edit', revision: '1', text: 'Owner final answer' } });
  const sent = await tool('get_request', { id, text: 'Injected replacement', links: ['https://evil.example'], to: 'Someone else' });
  assert.match(sent.content[0].text, /Sent it as msg_/);
  const row = env.relay.db.prepare('SELECT * FROM messages WHERE privacy_request_id = ?').get(id);
  assert.ok(row.sealed); assert.equal(row.text, '');
  await waitFor(async () => /Owner final answer/.test(await ben.cli('received')));
  assert.doesNotMatch(await ben.cli('received'), /Injected replacement|evil\.example/);
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM privacy_candidates WHERE request_id = ?').get(id).n, 0);
});

test('review: connector and private MCP gate every governance tool outside the pilot', async (t) => {
  const env = await setup(t), who = { b: await login(env, 'mia@example.com') }, app = await connectApp(env, who.b, 'mia');
  const legacy = await quietBot(env, 'ann@example.com', 'ann'), tool = privateMcp(t, legacy);
  const cases = [['get_settings', {}], ['update_settings', { ops: [{ op: 'pause', on: true }] }],
    ['propose_reply', { to: 'Other', text: 'Draft' }], ['get_request', { id: 'req_missing' }],
    ['record_decision', { contact: 'Other', topic: 'location', answer: 'share' }]];
  for (const [name, args] of cases) for (const call of [app.tool, tool]) {
    const out = await call(name, args);
    assert.equal(out.isError, true, name);
    assert.match(out.content[0].text, /Baskets and owner okays aren't turned on/);
  }
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM settings_proposals').get().n, 0);
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM privacy_requests').get().n, 0);
});

test('review: the legacy privacy switch reflects effective pilot mode even with a divergent bit', async (t) => {
  const env = await setup(t, { privacyPilot: true }), ann = await quietBot(env, 'ann@example.com', 'ann'), ben = await quietBot(env, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  env.relay.db.prepare('UPDATE contacts SET privacy_on = 0 WHERE owner_bot = ?').run(ann.botId);
  assert.match((await ann.b('/app')).text, /<dt>Basket<\/dt><dd>Not sorted yet · asks you first · /);
  putIn(env, ann, ben, 'friends');
  env.relay.db.prepare('UPDATE contacts SET privacy_on = 1 WHERE owner_bot = ?').run(ann.botId);
  const html = (await ann.b('/app')).text;
  assert.match(html, /<dt>Basket<\/dt><dd><span class="hand basket-word">friends<\/span> · <a /);
  assert.doesNotMatch(html, /contacts\/privacy/);
});

// Every change says what just happened, how to take it back, and what to do next; Undo posts the earlier values.
test('every change is confirmed where it happened, with an Undo that works, once', async (t) => {
  const env = await setup(t, { privacyPilot: true }), ann = await quietBot(env, 'ann@example.com', 'ann'), ben = await quietBot(env, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  const toast = (html) => {
    const m = html.match(/<div class="toast[^"]*" role="status">[^]*?<\/div>/);
    if (!m) return null;
    const undo = m[0].match(/<form method="post" action="([^"]+)">([^]*?)<button/);
    return { what: m[0].match(/<span class="toast__what">([^<]*)/)[1],
      undo: undo && { action: undo[1].replace(/&amp;/g, '&'), form: Object.fromEntries([...undo[2].matchAll(/name="([^"]+)" value="([^"]*)"/g)].map((x) => [x[1], x[2].replace(/&amp;/g, '&')])) } };
  };
  const follow = async (r) => toast((await ann.b(r.location.replace(/#.*/, ''))).text);

  // Sorting someone: one short line, Undo puts them back, and it shows only once.
  let n = await follow(await ann.b('/app/people/move', { method: 'POST', form: { bot: ann.botId, peer: ben.botId, circle: circleId(env, ann, 'friends') } }));
  assert.equal(n.what, 'Moved Ben to friends');
  assert.deepEqual(n.undo, { action: '/app/people/move', form: { bot: ann.botId, peer: ben.botId, circle: '', undo: '1' } });
  assert.equal(toast((await ann.b('/app/people')).text), null, 'shown once');
  n = await follow(await ann.b(n.undo.action, { method: 'POST', form: n.undo.form }));
  assert.equal(n.what, 'Moved Ben to not sorted yet');
  assert.equal(n.undo, null, 'an undo does not offer another');
  assert.equal(contactOf(env, ann, ben).circle, null);

  // Removing a basket with someone in it: Undo brings back the basket and who was in it.
  await ann.b('/app/people/baskets', { method: 'POST', form: { bot: ann.botId, name: 'school' } });
  putIn(env, ann, ben, 'school');
  n = await follow(await ann.b('/app/people/baskets', { method: 'POST', form: { bot: ann.botId, circle: circleId(env, ann, 'school'), delete: '1' } }));
  assert.equal(n.what, 'Removed school');
  assert.equal(n.undo.action, '/app/people/restore');
  n = await follow(await ann.b(n.undo.action, { method: 'POST', form: n.undo.form }));
  assert.equal(n.what, 'school is back');
  assert.equal(contactOf(env, ann, ben).circle.name, 'school');

  // A removed rule comes back with Undo; someone else's confirmation never shows up for Ann.
  const base = `/app/people/${ann.botId}/${ben.botId}`;
  n = await follow(await ann.b(`${base}/rules`, { method: 'POST', form: { add: 'Only football' } }));
  assert.equal(n.what, 'Rule added');
  const rule = contactOf(env, ann, ben).rules[0].id;
  n = await follow(await ann.b(`${base}/rules`, { method: 'POST', form: { remove: rule } }));
  assert.equal(n.what, 'Rule removed');
  await ben.b('/app/pause', { method: 'POST', form: { on: '1' } });
  n = await follow(await ann.b(n.undo.action, { method: 'POST', form: n.undo.form }));
  assert.equal(n.what, 'Rule is back');
  assert.deepEqual(contactOf(env, ann, ben).rules.map((r) => r.id), [rule]);
  assert.equal(toast((await ann.b('/app')).text), null);
  assert.equal(toast((await ben.b('/app')).text).what, 'Paused');

  // Blocking undoes the same way; a sent reply just says so, and the owner lands on what's still waiting.
  n = await follow(await ann.b('/app/contacts/block', { method: 'POST', form: { bot: ann.botId, peer: ben.botId } }));
  assert.equal(n.what, 'Blocked Ben');
  assert.equal(n.undo.form.unblock, '1');
  n = await follow(await ann.b(n.undo.action, { method: 'POST', form: n.undo.form }));
  assert.equal(n.what, 'Unblocked Ben');
  const req = (await ann.cli('propose', 'Ben', 'See you at 6', '--topic', 'plans')).match(/req_[\w-]+/)[0];
  const sent = await ann.b(`/app/requests/${req}`, { method: 'POST', form: { action: 'send', revision: 1 } });
  assert.equal(sent.location, '/app/requests');
  n = await follow(sent);
  assert.deepEqual(n, { what: 'Sent to Ben', undo: null });
  // No explaining banner anywhere: just the line.
  assert.doesNotMatch((await ann.b('/app')).text, /class="notice|<b>Next:<\/b>/);
});

test('everything the dashboard changes, the bot can change too, from the ops its settings list', async (t) => {
  const env = await setup(t, { privacyPilot: true }), ann = await quietBot(env, 'ann@example.com', 'ann'), ben = await quietBot(env, 'ben@example.com', 'ben');
  await connect(ann, ben, 'Ann');
  const text = await ann.cli('settings');
  assert.match(text, /Your owner can change all of this by telling you, just like on their dashboard\./);
  const shown = [...text.matchAll(/\{"op":[^\n]*?\}(?=[,\s(]|$)/gm)].map((m) => JSON.parse(m[0]));
  const ops = new Set(shown.map((o) => o.op));
  for (const op of ['move', 'set_mode', 'add_circle', 'rename_circle', 'delete_circle', 'set_purpose', 'set_notes', 'add_topic', 'remove_topic', 'add_rule', 'remove_rule', 'block', 'pause', 'quiet_hours']) assert.ok(ops.has(op), `settings shows ${op}`);
  // Each example works as printed (for Ben instead of Jon); some come back as a link for the owner instead.
  for (const o of shown) {
    const op = JSON.parse(JSON.stringify(o).replaceAll('"Jon"', '"Ben"').replaceAll('"Dad"', '"Ben"'));
    if (op.op === 'delete_circle') op.circle = 'class';
    if (op.op === 'remove_rule') op.rule = contactOf(env, ann, ben).rules[0].id;
    if (op.op === 'block' || op.op === 'pause') op.on = false;
    const out = await cliIn(ann.home, JSON.stringify([op]), 'settings', 'apply', '-');
    assert.match(out, /^Done: |gives you more freedom/, `${op.op}: ${out}`);
  }
  const c = contactOf(env, ann, ben);
  assert.equal(c.purpose, 'football friend');
  assert.equal(settings(env, ann).circles.some((g) => g.name === 'school' || g.name === 'class'), false, 'added, renamed and removed');
  assert.deepEqual(c.rules, [], 'added and removed');
  assert.match((await cliIn(ann.home, '[{"op":"rename_everything"}]', 'settings', 'apply', '-').catch((e) => e)).stderr, /use move, set_mode, add_circle/);
});

test('inviting picks the basket: friends by default, changeable, and a bot can name one too', async (t) => {
  const env = await setup(t, { privacyPilot: true });
  const ann = await quietBot(env, 'ann@example.com', 'ann'), ben = await quietBot(env, 'ben@example.com', 'ben'), cat = await quietBot(env, 'cat@example.com', 'cat');
  // The dashboard link: friends unless Ann picks another basket; Ben picks for his side when he says yes.
  const made = await ann.b('/app/invites', { method: 'POST', form: { bot: ann.botId } });
  assert.match(made.text, /<label>Their basket<select name="basket" data-autosave><option>family<\/option><option selected>friends<\/option>/);
  const code = made.text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const picked = await ann.b('/app/invites/basket', { method: 'POST', form: { bot: ann.botId, code, basket: 'family' } });
  assert.match(picked.text, /<span class="toast__what">They&#39;ll be in family<\/span>|<span class="toast__what">They'll be in family<\/span>/);
  assert.match(picked.text, /<option selected>family<\/option>/);
  const page = await ben.b(`/i/${code}`);
  assert.match(page.text, /<label>Their basket<select name="basket"><option>family<\/option><option selected>friends<\/option>/);
  const done = await ben.b(`/i/${code}`, { method: 'POST', form: { bot: ben.botId, alias: 'Ann', basket: 'work' } });
  assert.match(done.text, /Ann is in work\./);
  assert.doesNotMatch(done.text, /in a basket<\/a>/, 'nothing left to sort');
  assert.equal(contactOf(env, ann, ben).circle.name, 'family');
  assert.equal(contactOf(env, ben, ann).circle.name, 'work');
  assert.equal(contactOf(env, ann, ben).effective_mode, 'handles', 'Ann\'s bot can write to Ben right away');

  // A bot invites with a basket; an unknown basket names the real ones and makes nothing.
  await assert.rejects(cliIn(ann.home, '', 'invite', 'cat', '--basket', 'golf'), (e) => /basket not found; the baskets are family, friends, work/.test(e.stderr));
  const out = await ann.cli('invite', 'cat', '--basket', 'work');
  assert.match(out, /They go in "work" once connected\./);
  const accepted = await cat.cli('accept', out.match(/accept ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1], 'Ann', '--basket', 'friends');
  assert.match(accepted, /They're in "friends"\./);
  assert.equal(contactOf(env, ann, cat).circle.name, 'work');
  assert.equal(contactOf(env, cat, ann).circle.name, 'friends');
});
