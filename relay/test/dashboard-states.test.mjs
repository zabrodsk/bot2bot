import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { existsSync } from 'node:fs';
import { setup, login, browser } from './helpers.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const bare = (s) => s.replace(/<(style|script)[^>]*>[^]*?<\/\1>/g, '');
async function person(env, email, handle, vendor = 'connector') {
  const b = await login(env, email);
  const user = env.relay.db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const token = `test-${handle}-token-1234567890`;
  const id = Number(env.relay.db.prepare('INSERT INTO bots (handle, display_name, token_hash, user_id, vendor, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(handle, user.name, sha(token), user.id, vendor, env.now()).lastInsertRowid);
  return { b, user, id, token };
}
async function invite(a) {
  const made = await a.b('/app/invites', { method: 'POST', form: { bot: a.id } });
  assert.equal(made.status, 200);
  return made.text.match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[0];
}
async function accept(a, path, alias = 'Tom') {
  return a.b(path, { method: 'POST', form: { bot: a.id, alias } });
}
function message(env, from, to, id, extra = {}) {
  const row = { id, from_bot: from.id, to_bot: to.id, kind: 'tell', text: id, created_at: env.now(), status: 'pending', next_ring_at: env.now() + 86_400_000, ...extra };
  const keys = Object.keys(row);
  env.relay.db.prepare(`INSERT INTO messages (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
}

// Inspect what the app passes to end(), since node:http itself would also hide HEAD bodies.
test('HEAD pages match GET headers and status without sending a body or changing page state', async (t) => {
  const env = await setup(t, { hosted: true, privacyPilot: true, webInbox: true });
  const handle = env.relay.handle;
  env.relay.handle = (req, res) => {
    if (req.method === 'HEAD') {
      const end = res.end.bind(res);
      res.end = (body, ...args) => { assert.equal(body, undefined, req.url); return end(body, ...args); };
    }
    return handle(req, res);
  };
  // The feedback board is hosted only (hosted-board.mjs), so the open-source copy has no /feedback pages.
  const board = existsSync(new URL('../hosted-board.mjs', import.meta.url)) ? ['/feedback', '/feedback/roadmap', '/feedback/updates'] : [];
  for (const path of ['/login', ...board, '/app/activity?bot=1', '/avatars/classic.svg', '/status.json', '/g/AAAA-BBBB', '/i/AAAA-BBBB']) {
    const get = await fetch(env.url + path, { redirect: 'manual' });
    await get.text();
    const head = await fetch(env.url + path, { method: 'HEAD', redirect: 'manual' });
    assert.equal(head.status, get.status, path);
    for (const h of ['location', 'content-type', 'cache-control', 'x-frame-options', 'referrer-policy', 'content-security-policy']) assert.equal(head.headers.get(h), get.headers.get(h), `${path} ${h}`);
    assert.equal(await head.text(), '');
  }
  assert.equal(env.mail.length, 0);
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM login_codes').get().n, 0);

  const tom = await person(env, 'tom@example.com', 'tom', 'web');
  const anna = await person(env, 'anna@example.com', 'anna');
  message(env, anna, tom, 'msg_unseen');
  // A HEAD must leave this toast for the next visible page.
  await tom.b('/app/account/theme', { method: 'POST', form: { theme: 'dark' } });
  env.relay.db.prepare('UPDATE users SET created_at = ? WHERE id = ?').run(env.now() - 4 * 86_400_000, tom.user.id);
  await tom.b('/login', { method: 'POST', form: { email: tom.user.email } });
  const loginLink = env.mail.at(-1).text.match(/(\/login\/link\?t=[\w-]+)/)[1];
  const mailCount = env.mail.length;
  const tables = ['users', 'bots', 'messages', 'login_codes', 'sessions', 'invites', 'promo_invites', 'promo_nudges', 'circles', 'privacy_requests', 'settings_proposals', 'active_days']
    .filter((name) => env.relay.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)); // promo_* are hosted only
  const snapshot = () => tables.map((table) => [table, env.relay.db.prepare(`SELECT * FROM ${table}`).all()]);
  const before = snapshot();
  const gifts = existsSync(new URL('../hosted-invites.mjs', import.meta.url)) ? ['/app/gifts'] : []; // hosted only
  for (const path of ['/app', '/app/inbox', ...gifts, '/app/account', '/app/feedback', '/app/status', '/login', loginLink, '/logout']) {
    const head = await tom.b(path, { method: 'HEAD' });
    assert.equal(head.status, path === '/logout' ? 404 : 200, path);
    assert.equal(head.text, '');
  }
  assert.deepEqual(snapshot(), before, 'no login, receipt, prompt, gift, activity or session writes');
  assert.equal(env.mail.length, mailCount, 'HEAD sends no login codes');
  const account = await tom.b('/app/account');
  assert.match(account.text, /Appearance saved/);
  assert.equal(env.relay.db.prepare('SELECT status FROM messages WHERE id = ?').get('msg_unseen').status, 'pending');
  await tom.b('/app/inbox');
  assert.equal(env.relay.db.prepare('SELECT status FROM messages WHERE id = ?').get('msg_unseen').status, 'delivered', 'GET still marks seen');

  // People/settings renders used to create default baskets even when only asking for headers.
  const beforePeople = snapshot();
  assert.equal((await anna.b('/app/people', { method: 'HEAD' })).status, 200);
  assert.equal((await anna.b('/app/requests', { method: 'HEAD' })).status, 200);
  assert.deepEqual(snapshot(), beforePeople);
});

test('dashboard sign-in keeps the query through code login and still rejects an external next URL', async (t) => {
  const env = await setup(t);
  const b = browser(env.url);
  const target = '/app/people?bot=23&view=waiting';
  const gate = await b(target);
  assert.equal(gate.location, `/login?next=${encodeURIComponent(target)}`);
  assert.match((await b(gate.location)).text, /name="next" value="\/app\/people\?bot=23&amp;view=waiting"/);
  await b('/login', { method: 'POST', form: { email: 'next@example.com', next: target } });
  const code = env.mail.at(-1).text.match(/code is (\d{6})/)[1];
  const done = await b('/login/verify', { method: 'POST', form: { email: 'next@example.com', code, next: target } });
  assert.equal(done.location, target);
  const landed = await b(done.location);
  assert.ok(!landed.location || !landed.location.startsWith('/login'), 'signed in, the page opens without another sign-in');
  const unsafe = await b('/app/picture?next=%2F%2Fevil.example');
  assert.match(unsafe.text, /name="next" value="\/app"/);
});

test('contact links distinguish missing, expired, used and already connected without naming who used one', async (t) => {
  const env = await setup(t, { privacyPilot: true });
  const tom = await person(env, 'tom@example.com', 'tom');
  const anna = await person(env, 'anna@example.com', 'anna');
  const outsider = browser(env.url);
  const missing = await outsider('/i/AAAA-BBBB');
  assert.equal(missing.status, 404);
  assert.match(bare(missing.text), /This invite was not found[^]*Ask your friend for a new link\./);
  const expiredPath = await invite(tom);
  env.relay.db.prepare('UPDATE invites SET expires_at = ? WHERE code_hash = ?').run(env.now(), sha(expiredPath.slice(3)));
  const expired = await outsider(expiredPath);
  assert.equal(expired.status, 410);
  assert.match(bare(expired.text), /This invite has expired[^]*Ask your friend for a new link\./);
  const usedPath = await invite(tom);
  assert.equal((await accept(anna, usedPath)).status, 200);
  const used = await outsider(usedPath);
  assert.equal(used.status, 410);
  assert.match(bare(used.text), /This invite was already used[^]*Ask your friend for a new link\./);
  assert.doesNotMatch(bare(used.text), /Anna|anna@example|@anna/);
  const again = await anna.b(usedPath);
  assert.equal(again.status, 200);
  assert.match(bare(again.text), /already connected[^]*href="\/app\/people"[^]*Open your people page/);
  const newPath = await invite(tom);
  const count = env.relay.db.prepare('SELECT count(*) AS n FROM contacts').get().n;
  for (const r of [await anna.b(newPath), await accept(anna, newPath)]) {
    assert.equal(r.status, 200);
    assert.match(bare(r.text), /already connected[^]*Open your people page/);
  }
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM contacts').get().n, count);
  assert.equal(env.relay.db.prepare('SELECT used_at FROM invites WHERE code_hash = ?').get(sha(newPath.slice(3))).used_at, null);
  const cz = browser(env.url, { 'accept-language': 'cs' });
  assert.match((await cz('/i/AAAA-BBBB')).text, /Tahle pozvánka tu není/);
  assert.match((await cz(expiredPath)).text, /Platnost pozvánky vypršela/);
  assert.match((await cz(usedPath)).text, /Tahle pozvánka už byla použita/);
});

test('group links hide joined member details until the visitor joins', async (t) => {
  const env = await setup(t, { privacyPilot: true });
  const tom = await person(env, 'tom@example.com', 'tom');
  const anna = await person(env, 'anna@example.com', 'anna');
  const zoe = await person(env, 'zoe@example.com', 'zoe');
  const made = await tom.b('/app/groups/new', { method: 'POST', form: { bot: tom.id, name: 'Book club' } });
  assert.equal(made.status, 303);
  const groupPage = await tom.b(made.location);
  const path = groupPage.text.match(/\/g\/[A-Z0-9]{4}-[A-Z0-9]{4}/)[0];
  assert.equal((await anna.b(path, { method: 'POST', form: { bot: anna.id } })).status, 303);
  for (const b of [browser(env.url), zoe.b]) {
    const page = await b(path);
    assert.equal(page.status, 200);
    const html = bare(page.text);
    assert.match(html, /Book club[^]*Tom invited you to their group chat/);
    assert.doesNotMatch(html, /Anna|@anna|anna@example/);
  }
  const joined = await anna.b(path);
  assert.match(bare(joined.text), /Anna[^]*Open the group/);
});

test('activity uses the API delivery reasons without claiming a read or a task run', async (t) => {
  const env = await setup(t);
  const tom = await person(env, 'tom@example.com', 'tom');
  const anna = await person(env, 'anna@example.com', 'anna');
  const db = env.relay.db;
  const cases = [
    ['queued', 'Queued', {}],
    ['picked_up', 'Picked up', { status: 'claimed', lease_until: env.now() + 86_400_000 }],
    ['passed_on', 'Passed on', { status: 'delivered' }],
    ['not_delivered', 'Not delivered', { status: 'dropped' }],
    ['key_check', 'Check keys', { note: 'key_check' }],
    ['held', 'Paused', {}, { paused_at: env.now() }],
    ['quiet_hours', 'Quiet hours', {}, {}, { quiet_on: 1, quiet_start: 0, quiet_end: 1439, tz: 'Pacific/Honolulu' }],
    ['in_web_inbox', 'In web inbox', {}, { vendor: 'web' }],
    ['seen', 'Received', { status: 'delivered' }, { vendor: 'web' }],
    ['doorbell_off', 'Doorbell off', { first_rung_at: env.now() }, { last_ring_status: 503 }],
    ['stalled', 'Delivery stalled', { first_rung_at: env.now(), next_ring_at: null }],
    ['not_answering', 'No pickup yet', { first_rung_at: env.now(), ring_count: 20 }],
    ['rung', 'Doorbell rung', { first_rung_at: env.now(), ring_count: 1 }],
  ];
  for (const [state, label, fields, bot = {}, user = {}] of cases) {
    db.prepare('DELETE FROM messages').run();
    db.prepare("UPDATE bots SET vendor = 'connector', paused_at = NULL, last_ring_status = NULL WHERE id = ?").run(anna.id);
    db.prepare('UPDATE users SET quiet_on = 0 WHERE id = ?').run(anna.user.id);
    for (const [k, v] of Object.entries(bot)) db.prepare(`UPDATE bots SET ${k} = ? WHERE id = ?`).run(v, anna.id);
    // Use a local hour away from midnight so the fixture works whenever the suite runs.
    if (state === 'quiet_hours') user.tz = new Date(env.now()).getUTCHours() === 9 ? 'UTC' : 'Pacific/Honolulu';
    for (const [k, v] of Object.entries(user)) db.prepare(`UPDATE users SET ${k} = ? WHERE id = ?`).run(v, anna.user.id);
    const id = `msg_${state}`;
    message(env, tom, anna, id, fields);
    const api = await fetch(`${env.url}/v1/messages/${id}`, { headers: { authorization: `Bearer ${tom.token}` } });
    assert.equal(api.status, 200, state);
    assert.equal((await api.json()).status, state);
    const page = bare((await tom.b('/app/activity')).text);
    assert.match(page, new RegExp(`${id} · ${label}<`));
    assert.doesNotMatch(page, / · (Waiting|Read|Task ran)</);
  }
  // Replied takes priority once a real reply exists and is visible to the sender.
  db.prepare('DELETE FROM messages').run();
  const path = await invite(tom);
  await accept(anna, path);
  message(env, tom, anna, 'msg_question', { kind: 'ask', status: 'delivered', replied_at: env.now() });
  message(env, anna, tom, 'msg_answer', { reply_to: 'msg_question', status: 'delivered' });
  assert.equal((await (await fetch(`${env.url}/v1/messages/msg_question`, { headers: { authorization: `Bearer ${tom.token}` } })).json()).status, 'replied');
  assert.match(bare((await tom.b('/app/activity')).text), /msg_question · Replied</);
  db.prepare("UPDATE users SET lang = 'cs' WHERE id = ?").run(tom.user.id);
  assert.match(bare((await tom.b('/app/activity')).text), /msg_question · Odpovězeno</);
});

test('only the apex and old Railway host redirect page visits to the canonical host', async (t) => {
  const env = await setup(t, { redirectHosts: ['bot2bot.link', 'old.up.railway.app'] });
  const visit = (host) => new Promise((resolve, reject) => {
    request(env.url + '/login?next=%2Fapp', { headers: { host, accept: 'text/html' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res));
    }).on('error', reject).end();
  });
  for (const host of ['bot2bot.link', 'old.up.railway.app']) {
    const r = await visit(host);
    assert.equal(r.statusCode, 301);
    assert.equal(r.headers.location, env.url + '/login?next=%2Fapp');
  }
  assert.equal((await visit('www.bot2bot.link')).statusCode, 200);
});
