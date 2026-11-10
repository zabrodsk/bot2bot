// Group chats on the dashboard (0.21): making a group with contacts, saying yes from the overview, the group page
// (members, the honest encryption badge, the composer only where nothing is end-to-end encrypted), joining by a
// member's link, waking and hiding with Undo, and the overview's friends by basket with a filter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, owner, connect, connectApp, login, browser } from './helpers.mjs';

const db = (env) => env.relay.db;
const botOf = (env, handle) => db(env).prepare('SELECT * FROM bots WHERE handle = ?').get(handle);
const memberOf = (env, gid, botId) => db(env).prepare('SELECT * FROM group_members WHERE group_id = ? AND bot_id = ?').get(gid, Number(botId));
// Pages without their styles and scripts, so a failing match prints what matters.
const bare = (html) => html.replace(/<style>[^]*?<\/style>/g, '').replace(/<script>[^]*?<\/script>/g, '').replace(/<svg[^]*?<\/svg>/g, '');
const view = async (b, path) => bare((await b(path)).text);
const gidFrom = (location) => Number(location.match(/^\/app\/groups\/(\d+)\?bot=\d+$/)[1]);
// A POST that answers with a redirect, then the page it leads to (with the toast on it).
async function go(b, path, form) {
  const r = await b(path, { method: 'POST', form });
  assert.equal(r.status, 303, `${path}: ${r.text.slice(0, 300)}`);
  return { location: r.location, page: bare((await view(b, r.location))) };
}
// Ben with two contacts, Anna and Tom; all three are private-mode bots with keys.
async function trio(t0, opts) {
  const env = await setup(t0, opts);
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const anna = await owner(env, t0, 'anna@example.com', 'anna');
  const tom = await owner(env, t0, 'tom@example.com', 'tom');
  await connect(ben, anna, 'Ben');
  await connect(ben, tom, 'Ben');
  return { env, ben, anna, tom };
}
const groupsPart = (html) => html.slice(html.indexOf('id="groups-h"'), html.indexOf('id="bots-h"'));

test('making a group on the dashboard: invited friends say yes from their overview, and the page shows who and how private it is', async (t0) => {
  const { env, ben, anna, tom } = await trio(t0);

  const form = (await view(ben.b, '/app/groups/new'));
  assert.match(form, /<h1>New group<\/h1>[^]*name="name"[^]*Who to invite[^]*Make the group/);
  assert.match(form, new RegExp(`name="peer_${anna.botId}"[^]*Anna[^]*name="peer_${tom.botId}"[^]*Tom`));
  assert.match(form, /class="crumb" href="\/app"/, 'a way back');

  // An empty name stays on the form, with what was picked.
  const bad = await ben.b('/app/groups/new', { method: 'POST', form: { bot: ben.botId, name: ' ', [`peer_${anna.botId}`]: '1' } });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /A group name is 1 to 40 characters\.[^]*name="peer_\d+" value="1" checked/);

  const made = await go(ben.b, '/app/groups/new', { bot: ben.botId, name: 'Sunday lunch', [`peer_${anna.botId}`]: '1', [`peer_${tom.botId}`]: '1' });
  const gid = gidFrom(made.location);
  assert.match(made.page, /class="toast__what">Made Sunday lunch and invited 2 people<[^]*action="\/app\/groups\/\d+\/end"[^]*toast__undo">Undo</);
  assert.match(made.page, /<h1>Sunday lunch<\/h1>[^]*badge--success">End-to-end encrypted</);
  assert.doesNotMatch(made.page, /Not end-to-end encrypted/);
  // Every bot here has keys: owners can't type in it, they tell their bot.
  assert.doesNotMatch(made.page, /<textarea[^>]*name="text"/);
  assert.match(made.page, /This group is end-to-end encrypted, so only the bots can read it\. Tell your bot what to say\./);
  assert.match(made.page, /Ben made the group/);
  assert.match(made.page, /Anna<\/span><span class="line__sub">@anna · invited</);
  assert.match(made.page, /You<\/span><span class="line__sub">@ben · admin</);
  // The maker's invite link is ready from the start.
  assert.match(made.page, /Invite link[^]*id="glink">http:[^<]*\/g\/[A-Z0-9]{4}-[A-Z0-9]{4}<[^]*Wake your bot for[^]*aria-pressed="true">Questions and mentions<[^]*Only admins can add people[^]*End group/);

  // Anna's overview: the invite first, with Join and No thanks.
  const home = groupsPart((await view(anna.b, '/app')));
  assert.match(home, /Groups <span class="count">1<\/span>[^]*Sunday lunch[^]*Ben invited you · End-to-end encrypted/);
  assert.match(home, new RegExp(`action="/app/groups/${gid}/join"><input type="hidden" name="bot" value="${anna.botId}"><button class="btn small">Join<[^]*action="/app/groups/${gid}/decline"[^]*No thanks`));
  // Her group page asks the same, and nothing of the conversation shows before she says yes.
  const invited = (await view(anna.b, `/app/groups/${gid}`));
  assert.match(invited, /Join Sunday lunch\?[^]*Ben invited you\./);
  assert.doesNotMatch(invited, /Conversation|Wake your bot for/);

  // Someone who isn't in it can't open it, or act with another person's bot.
  assert.equal((await tom.b(`/app/groups/${gid}?bot=${ben.botId}`)).status, 404);
  assert.equal((await anna.b(`/app/groups/${gid}/wake`, { method: 'POST', form: { bot: ben.botId, wake: 'muted' } })).status, 404);
  const stranger = await owner(env, t0, 'zoe@example.com', 'zoe');
  assert.equal((await stranger.b(`/app/groups/${gid}`)).status, 404);

  const joined = await go(anna.b, `/app/groups/${gid}/join`, { bot: anna.botId });
  assert.equal(joined.location, `/app/groups/${gid}?bot=${anna.botId}`);
  assert.equal(memberOf(env, gid, anna.botId).state, 'joined');
  assert.match(joined.page, /class="toast__what">You joined Sunday lunch</);
  assert.match(joined.page, /Ben<\/span><span class="line__sub">@ben · admin</);
  assert.match(joined.page, /Anna joined/, 'she sees the group from when she joined');
  assert.doesNotMatch(joined.page, /made the group/);
  assert.match(joined.page, new RegExp(`action="/app/groups/${gid}/link"[^]*Make an invite link`), 'her own link is one tap away');
  assert.doesNotMatch(groupsPart((await view(anna.b, '/app'))), /No thanks/);

  // Tom says no from his overview: it's gone from there.
  const no = await go(tom.b, `/app/groups/${gid}/decline`, { bot: tom.botId });
  assert.equal(no.location, '/app');
  assert.match(no.page, /class="toast__what">You said no to Sunday lunch</);
  assert.doesNotMatch(groupsPart(no.page), /Sunday lunch/);
  assert.equal(memberOf(env, gid, tom.botId).state, 'left');

  // Someone who said no isn't asked again the same day; a day later Ben adds Tom again and Tom joins.
  env.advance(24 * 3_600_000 + 60_000);
  // Ben adds Tom again; Tom joins. Anna isn't Tom's contact: one tap asks to connect, Tom says yes on his side.
  const added = await go(ben.b, `/app/groups/${gid}/add`, { bot: ben.botId, [`peer_${tom.botId}`]: '1' });
  assert.match(added.page, /class="toast__what">1 person invited</);
  await go(tom.b, `/app/groups/${gid}/join`, { bot: tom.botId });
  const annaPage = (await view(anna.b, `/app/groups/${gid}?bot=${anna.botId}`));
  assert.match(annaPage, new RegExp(`Tom<\\/span><span class="line__sub">@tom<\\/span>[^]*action="/app/groups/${gid}/contact"[^]*name="peer" value="${tom.botId}"[^]*Add as contact`));
  const asked = await go(anna.b, `/app/groups/${gid}/contact`, { bot: anna.botId, peer: tom.botId });
  assert.match(asked.page, /class="toast__what">Asked Tom to connect<[^]*action="\/app\/contacts\/remove"/);
  assert.match(asked.page, /Tom<\/span><span class="line__sub">@tom · waiting for them</);
  const pair = db(env).prepare('SELECT owner_bot, approved_at FROM contacts WHERE (owner_bot = ? AND peer_bot = ?) OR (owner_bot = ? AND peer_bot = ?) ORDER BY owner_bot = ? DESC').all(anna.botId, tom.botId, tom.botId, anna.botId, Number(anna.botId));
  assert.ok(pair[0].approved_at && !pair[1].approved_at, 'her side said yes, his waits');
  assert.match((await view(tom.b, '/app')), /Did you mean to connect with/);

  // Admin: make Anna admin (Undo takes it back), remove Tom.
  const adm = await go(ben.b, `/app/groups/${gid}/admin`, { bot: ben.botId, member: anna.botId, on: '1' });
  assert.match(adm.page, /class="toast__what">Anna is an admin now<[^]*toast__undo/);
  assert.equal(memberOf(env, gid, anna.botId).role, 'admin');
  await go(ben.b, `/app/groups/${gid}/admin`, { bot: ben.botId, member: anna.botId, undo: '1' });
  assert.equal(memberOf(env, gid, anna.botId).role, 'member');
  const rm = await go(ben.b, `/app/groups/${gid}/remove`, { bot: ben.botId, member: tom.botId });
  assert.match(rm.page, /class="toast__what">Removed Tom from the group</);
  assert.equal(memberOf(env, gid, tom.botId).state, 'removed');
  // Anna isn't an admin: no admin menu or switches for her, and the relay says no if she tries.
  const plain = (await view(anna.b, `/app/groups/${gid}?bot=${anna.botId}`));
  assert.doesNotMatch(plain, /Only admins can add people|End group|Remove from the group/);
  const denied = await anna.b(`/app/groups/${gid}/end`, { method: 'POST', form: { bot: anna.botId } });
  assert.equal(denied.status, 403);
  assert.match(denied.text, /Only admins can do that\./);

  // Renaming, with Undo.
  const rn = await go(anna.b, `/app/groups/${gid}/rename`, { bot: anna.botId, name: 'Lunch crew' });
  assert.match(rn.page, /<h1>Lunch crew<\/h1>[^]*class="toast__what">Renamed to Lunch crew<[^]*name="name" value="Sunday lunch"/);
  await go(anna.b, `/app/groups/${gid}/rename`, { bot: anna.botId, name: 'Sunday lunch', undo: '1' });
  assert.equal(env.relay.groups.group(gid).name, 'Sunday lunch');

  // The overview without baskets: one flat list of friends.
  const flat = (await view(ben.b, '/app'));
  assert.match(flat, /id="friends"><ul class="list"><li class="acc" data-open="false" data-who="anna /);
  assert.doesNotMatch(flat, /class="bsec"/);

  // Ending it: gone from both overviews.
  const end = await go(ben.b, `/app/groups/${gid}/end`, { bot: ben.botId });
  assert.equal(end.location, '/app');
  assert.match(end.page, /class="toast__what">Ended Sunday lunch</);
  assert.doesNotMatch(groupsPart(end.page), /Sunday lunch/);
  assert.equal((await anna.b(`/app/groups/${gid}`)).status, 404);
});

test("a group link: signed out it shows the group, a connected app joins it, and then nobody's text is end-to-end encrypted, so owners can type", async (t0) => {
  const env = await setup(t0, { privacyPilot: true });
  const ben = await owner(env, t0, 'ben@example.com', 'ben');
  const made = await go(ben.b, '/app/groups/new', { bot: ben.botId, name: 'Book club' });
  const gid = gidFrom(made.location);
  assert.match(made.page, /class="toast__what">Made Book club</);
  const linked = await go(ben.b, `/app/groups/${gid}/link`, { bot: ben.botId });
  assert.match(linked.location, /#invite$/);
  assert.match(linked.page, /class="toast__what">Invite link ready</);
  const code = linked.page.match(/\/g\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  assert.match(linked.page, new RegExp(`id="glink">${env.url.replace(/[.:/]/g, '\\$&')}/g/${code}<`));

  // Signed out: the group, who asked, and the way in (sign in, or connect a bot first).
  const out = browser(env.url);
  const shown = (await view(out, `/g/${code}`));
  assert.match(shown, /<h1>Book club<\/h1>[^]*Ben invited you to their group chat[^]*End-to-end encrypted[^]*Ben/);
  assert.match(shown, new RegExp(`href="/login\\?next=${encodeURIComponent(`/g/${code}`).replace(/[%]/g, '%')}"[^]*Already on bot2bot\\? Sign in`));
  assert.match(shown, /When your bot is connected, open this link again to join\./);
  const post = await out(`/g/${code}`, { method: 'POST', form: { bot: '1' } });
  assert.equal(post.status, 303);
  assert.match(post.location, /^\/login\?next=/);
  assert.equal((await out('/g/AAAA-BBBB')).status, 404);
  assert.match((await view(out, '/g/AAAA-BBBB')), /This group link has expired/);

  // Mia uses a connected app (no keys). Her page offers her bot and a basket for Ben (not sorted yet unless she picks).
  const mia = await login(env, 'mia@example.com');
  await connectApp(env, mia, 'mia-app');
  const miaBot = botOf(env, 'mia-app');
  const page = (await view(mia, `/g/${code}`));
  assert.match(page, /badge--neutral">Not end-to-end encrypted</, 'her bot has no keys, so the group won\'t be encrypted once she joins');
  assert.match(page, new RegExp(`action="/g/${code}"[^]*name="bot" value="${miaBot.id}"[^]*name="basket"[^]*<option value="" selected>not sorted yet<[^]*Join the group`));
  const joined = await go(mia, `/g/${code}`, { bot: miaBot.id, basket: '' });
  assert.equal(joined.location, `/app/groups/${gid}?bot=${miaBot.id}`);
  assert.match(joined.page, /class="toast__what">You joined Book club · Ben is a contact now</);
  assert.match(joined.page, /badge--neutral">Not end-to-end encrypted</);
  assert.doesNotMatch(joined.page, /badge--success">End-to-end encrypted/);
  // Joining by Ben's link made them contacts, both "not sorted yet".
  const both = db(env).prepare('SELECT owner_bot, approved_at, circle_id FROM contacts WHERE (owner_bot = ? AND peer_bot = ?) OR (owner_bot = ? AND peer_bot = ?)').all(miaBot.id, ben.botId, ben.botId, miaBot.id);
  assert.equal(both.length, 2);
  for (const c of both) assert.ok(c.approved_at && c.circle_id === null);
  // Opening the link again: she's in.
  assert.match((await view(mia, `/g/${code}`)), /You&#39;re in this group|You're in this group[^]*Open the group/);

  // Not encrypted: Mia can type here. Ben's bot has keys but Mia's doesn't, so nobody needs a sealed copy: he can too.
  assert.match(joined.page, /<textarea id="gmsg" name="text"/);
  const sent = await go(mia, `/app/groups/${gid}/send`, { bot: miaBot.id, text: 'Chapter 3 by Friday?', choices: 'Yes, No' });
  assert.match(sent.page, /class="toast__what">Sent to the group</);
  assert.match(sent.page, /class="bubble out"><div class="meta">You · just now · typed on the web · <b>question<\/b><\/div><div class="text">Chapter 3 by Friday\?<\/div><div class="choices--show"><span class="chip">Yes<\/span><span class="chip">No<\/span>/);
  const benPage = (await view(ben.b, `/app/groups/${gid}`));
  assert.match(benPage, /badge--neutral">Not end-to-end encrypted</);
  assert.match(benPage, /Mia&#39;s bot isn&#39;t end-to-end encrypted, so this group isn&#39;t anymore|Mia's bot isn't end-to-end encrypted, so this group isn't anymore/);
  assert.match(benPage, /class="bubble in"><div class="meta">Mia · just now · typed on the web · <b>question<\/b><\/div><div class="text">Chapter 3 by Friday\?</);
  assert.match(benPage, /<textarea id="gmsg" name="text"/);
  // The overview says so too.
  assert.match(groupsPart((await view(ben.b, '/app'))), /Book club[^]*2 people · active just now · Not end-to-end encrypted/);
});

test('waking and hiding come with Undo; baskets fold away, hide from the overview, and a filter finds friends', async (t0) => {
  const { env, ben, anna } = await trio(t0, { privacyPilot: true });
  const made = await go(ben.b, '/app/groups/new', { bot: ben.botId, name: 'Hikes', [`peer_${anna.botId}`]: '1' });
  const gid = gidFrom(made.location);
  await go(anna.b, `/app/groups/${gid}/join`, { bot: anna.botId });

  // Muting, then Undo puts back what it was.
  const muted = await go(anna.b, `/app/groups/${gid}/wake`, { bot: anna.botId, wake: 'muted' });
  assert.equal(memberOf(env, gid, anna.botId).wake, 'muted');
  assert.match(muted.page, /Nothing wakes it[^]*aria-pressed="true">Muted</);
  assert.match(muted.page, new RegExp(`class="toast__what">Muted<\\/span><form method="post" action="/app/groups/${gid}/wake"><input type="hidden" name="bot" value="${anna.botId}"><input type="hidden" name="wake" value="mentions"><input type="hidden" name="undo" value="1">`));
  const undone = await go(anna.b, `/app/groups/${gid}/wake`, { bot: anna.botId, wake: 'mentions', undo: '1' });
  assert.equal(memberOf(env, gid, anna.botId).wake, 'mentions');
  assert.match(undone.page, /class="toast__what">Wakes your bot for questions and mentions<\/span><\/div>/, 'no undo of an undo');
  const bad = await anna.b(`/app/groups/${gid}/wake`, { method: 'POST', form: { bot: anna.botId, wake: 'loud' } });
  assert.equal(bad.status, 400);

  // Hiding the group from the overview (the row's menu): it's gone from there; Account lists it, to show it again.
  assert.match(groupsPart((await view(anna.b, '/app'))), new RegExp(`Hikes[^]*action="/app/groups/${gid}/hide"[^]*name="on" value="1"[^]*Hide from the overview`));
  const hidden = await go(anna.b, `/app/groups/${gid}/hide`, { bot: anna.botId, on: '1', back: '/app' });
  assert.equal(hidden.location, '/app');
  assert.match(hidden.page, /class="toast__what">Hikes is hidden from the overview<[^]*toast__undo/);
  assert.doesNotMatch(groupsPart(hidden.page), /Hikes/);
  assert.doesNotMatch(hidden.page, /Show hidden|\?hidden=1/, 'no way to peek at it from the overview');
  const account = await view(anna.b, '/app/account');
  assert.match(account, new RegExp(`Hidden from your overview[^]*href="/app/groups/${gid}\\?bot=${anna.botId}">Hikes</a>[^]*Group[^]*action="/app/groups/${gid}/hide"><input type="hidden" name="bot" value="${anna.botId}"><input type="hidden" name="back" value="/app/account"><button class="btn small ghost">Show</button>`));
  // Shown again from Account: back on the overview, and Account has nothing hidden left.
  const back = await go(anna.b, `/app/groups/${gid}/hide`, { bot: anna.botId, back: '/app/account' });
  assert.equal(back.location, '/app/account');
  assert.match(back.page, /class="toast__what">Hikes is back on the overview</);
  assert.doesNotMatch(back.page, /Hidden from your overview/);
  assert.match(groupsPart((await view(anna.b, '/app'))), /Hikes/);
  // Hidden from the group's own page: back to the overview, where it's gone.
  const fromPage = await go(anna.b, `/app/groups/${gid}/hide`, { bot: anna.botId, on: '1' });
  assert.equal(fromPage.location, '/app');
  assert.doesNotMatch(groupsPart(fromPage.page), /Hikes/);
  await go(anna.b, `/app/groups/${gid}/hide`, { bot: anna.botId, back: '/app/account' });

  // Friends by basket on the overview: Ben's two are "not sorted yet"; put Anna in friends.
  env.relay.applyOwnerOps(Number(ben.botId), [{ op: 'move', contact: Number(anna.botId), circle: env.relay.getSettings(Number(ben.botId)).circles.find((c) => c.name === 'friends').id }]);
  const raw = (await ben.b('/app')).text;
  const home = bare(raw);
  assert.match(home, /<div class="bsec" data-key=""><details class="bsec__d" open><summary class="bsec__head">[^]*Not sorted yet<\/span><span class="count">1<\/span>[^]*data-who="tom /);
  assert.match(home, /<div class="bsec" data-key="friends"><details class="bsec__d" open>[^]*basket-word">friends<\/span><span class="count">1<\/span>[^]*data-who="anna [^]*action="\/app\/baskets\/hide"><input type="hidden" name="basket" value="friends"><input type="hidden" name="on" value="1"><button>Hide from the overview/);
  assert.doesNotMatch(home, /data-find/, 'two friends need no filter');
  assert.match(raw, /localStorage/, 'folded baskets are remembered in this browser');
  assert.match(raw, /details\[open\]:not\(\.bsec__d\)/, 'open baskets don\'t stop the page refreshing');

  const gone = await go(ben.b, '/app/baskets/hide', { basket: 'friends', on: '1' });
  assert.match(gone.page, /class="toast__what">friends is hidden from the overview<[^]*toast__undo/);
  assert.doesNotMatch(gone.page, /data-key="friends"|data-who="anna /);
  assert.match(gone.page, /Friends <span class="count">1<\/span>[^]*data-who="tom /);
  assert.doesNotMatch(gone.page, /Show hidden|\?hidden=1/);
  assert.match((await view(ben.b, '/app/account')), /Hidden from your overview[^]*basket-word">friends<[^]*Basket[^]*action="\/app\/baskets\/hide"><input type="hidden" name="basket" value="friends"><input type="hidden" name="back" value="\/app\/account"><button class="btn small ghost">Show</);
  const again = await go(ben.b, '/app/baskets/hide', { basket: 'friends', back: '/app/account' });
  assert.equal(again.location, '/app/account');
  assert.match((await view(ben.b, '/app')), /data-key="friends"[^]*data-who="anna /);
  assert.equal((await ben.b('/app/baskets/hide', { method: 'POST', form: { basket: 'nope', on: '1' } })).status, 404);

  // Six or more friends: a filter to find them (shown by the page's script; without it, everyone is listed).
  const t = Date.now();
  for (const n of ['cleo', 'dora', 'eli', 'finn']) {
    const id = Number(db(env).prepare("INSERT INTO bots (handle, display_name, token_hash, created_at, vendor) VALUES (?, ?, NULL, ?, 'grokbot')").run(`${n}-bot`, n, t).lastInsertRowid);
    db(env).prepare('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at, gen) VALUES (?, ?, ?, ?, ?, ?)').run(Number(ben.botId), id, n[0].toUpperCase() + n.slice(1), t, t, t);
    db(env).prepare('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at, gen) VALUES (?, ?, ?, ?, ?, ?)').run(id, Number(ben.botId), 'Ben', t, t, t);
  }
  const many = (await view(ben.b, '/app'));
  assert.match(many, /Friends <span class="count">6<\/span><\/h2><div class="ffind" data-find hidden><label class="sr" for="ffind-in">Find a friend<\/label><input id="ffind-in" type="search"/);
  assert.match(many, /data-who="cleo [^]*data-who="dora /);
  assert.match(many, /<p class="ffind__none" hidden>Nobody by that name<\/p>/);
});
