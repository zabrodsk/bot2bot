import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, owner, login, browser, connectApp } from './helpers.mjs';
import { inviteAddress, friendInviteEmail } from '../invite-email.mjs';

const reviewForm = async (person, draft) => {
  const page = await person.b(new URL(draft.review_at).pathname);
  assert.equal(page.status, 200);
  return { bot: person.botId, code: draft.code, confirm: 'send', review: page.text.match(/name="review" value="([a-f0-9]+)"/)[1] };
};
const invitationMail = (env) => env.mail.filter((m) => /invites you to/.test(m.subject));

test('email invite is a draft; only its owner can review and send it once', async (t) => {
  const env = await setup(t);
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  const ben = await owner(env, t, 'ben@example.com', 'ben');
  const created = await anna.api('POST', '/v1/invites', { alias: 'ben@example.com' });
  assert.equal(created.status, 200);
  const draft = created.json;
  assert.equal(draft.email_status, 'draft');
  assert.equal(invitationMail(env).length, 0);
  assert.equal((await browser(env.url)(new URL(draft.review_at).pathname)).status, 303);
  assert.equal((await ben.b(new URL(draft.review_at).pathname)).status, 404);
  const form = await reviewForm(anna, draft);
  assert.equal((await ben.b('/app/invites/email', { method: 'POST', form })).status, 404);
  assert.equal((await anna.b('/app/invites/email', { method: 'POST', form: { ...form, confirm: '' } })).status, 400);
  assert.equal((await anna.b('/app/invites/email', { method: 'POST', form: { ...form, review: 'stale' } })).status, 400);
  assert.equal(invitationMail(env).length, 0);
  const sent = await anna.b('/app/invites/email', { method: 'POST', form });
  assert.equal(sent.status, 303);
  assert.equal(invitationMail(env).length, 1);
  assert.equal(invitationMail(env)[0].to, 'ben@example.com');
  assert.ok(invitationMail(env)[0].text.includes(draft.link));
  assert.equal((await anna.b('/app/invites/email', { method: 'POST', form })).status, 303);
  assert.equal(invitationMail(env).length, 1, 'double submit never sends twice');
  assert.match((await anna.b(sent.location)).text, /Invite email sent/);
  const accepted = await ben.b(`/i/${draft.code}`, { method: 'POST', form: { bot: ben.botId, alias: 'Anna' } });
  assert.equal(accepted.status, 200);
  const contacts = env.relay.db.prepare('SELECT approved_at FROM contacts WHERE owner_bot IN (?, ?)').all(anna.botId, ben.botId);
  assert.equal(contacts.length, 2);
  assert.ok(contacts.every((c) => c.approved_at), 'sending and accepting are each owner approvals');
});

test('email invites reject wrong recipients and bad addresses; expired drafts cannot send', async (t) => {
  const env = await setup(t);
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  const other = await owner(env, t, 'other@example.com', 'other');
  for (const address of ['not-an-email', 'ben@example.com\nBcc: thief@example.com', 'a@bad..example.com', '@example.com']) {
    assert.equal((await anna.api('POST', '/v1/invites', { alias: 'Ben', email: address })).status, 400);
  }
  const draft = (await anna.api('POST', '/v1/invites', { alias: 'Ben', email: 'BEN@example.com' })).json;
  assert.equal(draft.email, 'ben@example.com');
  assert.equal((await other.api('POST', '/v1/invites/accept', { code: draft.code, alias: 'Anna' })).status, 403);
  const form = await reviewForm(anna, draft);
  await anna.b('/app/invites/cancel', { method: 'POST', form: { bot: anna.botId, code: draft.code } });
  assert.equal((await anna.b('/app/invites/email', { method: 'POST', form })).status, 404);
  assert.equal(invitationMail(env).length, 0);
});

test('concurrent submissions and uncertain delivery never automatically resend an invite', async (t) => {
  let attempts = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const env = await setup(t, { mailer: async (m) => { if (/invites you to/.test(m.subject)) { attempts++; await pending; throw new Error('provider timeout'); } } });
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  const draft = (await anna.api('POST', '/v1/invites', { alias: 'ben@example.com' })).json;
  const form = await reviewForm(anna, draft);
  const first = anna.b('/app/invites/email', { method: 'POST', form });
  // A separate request reaches the server while the mailer is pending.
  let second;
  for (let n = 0; n < 50 && !attempts; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  try { second = await anna.b('/app/invites/email', { method: 'POST', form }); }
  finally { release(); }
  assert.equal(second.status, 409);
  assert.equal((await first).status, 502);
  assert.equal((await anna.b('/app/invites/email', { method: 'POST', form })).status, 409);
  assert.equal(attempts, 1);
});

test('MCP can prepare an email invite without sending; templates escape untrusted names', async (t) => {
  const env = await setup(t);
  const b = await login(env, 'mcp@example.com');
  const app = await connectApp(env, b, 'mcp-bot');
  const result = await app.tool('invite', { name: 'long.recipient.name.more.than.thirty.two@example.com' });
  assert.match(JSON.stringify(result), /Email invite drafted[^]*Nothing sent[^]*\/app\/invites\//);
  assert.equal(invitationMail(env).length, 0);
  const mail = friendInviteEmail({ name: '<script>\r\nBcc: x', url: 'https://example.com/i/CODE-CODE', home: 'https://example.com' });
  assert.doesNotMatch(mail.subject, /[\r\n]/);
  assert.doesNotMatch(mail.html, /<script>/);
  assert.match(mail.html, /&lt;script&gt;/);
  assert.equal(inviteAddress(' BEN@example.com '), 'ben@example.com');
});

test('one owner confirmation accepts the email contact and group together, or rolls back both', async (t) => {
  const env = await setup(t);
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  const ben = await owner(env, t, 'ben@example.com', 'ben');
  const made = await anna.api('POST', '/v1/groups', { name: 'API review' });
  assert.equal(made.status, 200);
  const gid = env.relay.db.prepare("SELECT id FROM chat_groups WHERE name = 'API review'").get().id;
  const draft = (await anna.api('POST', '/v1/invites', { alias: 'ben@example.com', group: String(gid) })).json;
  const form = await reviewForm(anna, draft);
  assert.equal((await anna.b('/app/invites/email', { method: 'POST', form })).status, 303);
  assert.match(invitationMail(env)[0].text, /Accepting also joins the group "API review"/);
  assert.match((await ben.b(`/i/${draft.code}`)).text, /Connect and join group/);
  assert.equal((await ben.api('POST', '/v1/invites/accept', { code: draft.code, alias: 'Anna' })).status, 403, 'bot cannot consent to a group');
  // Revoking the group's link also invalidates the combined invite. No half-created contact.
  const old = env.relay.db.prepare('SELECT group_code FROM invites WHERE plain_code = ?').get(draft.code).group_code;
  env.relay.db.prepare('UPDATE group_links SET revoked_at = ? WHERE plain_code = ?').run(env.now(), old);
  const rejected = await ben.b(`/i/${draft.code}`, { method: 'POST', form: { bot: ben.botId, alias: 'Anna' } });
  assert.equal(rejected.status, 410);
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM contacts WHERE owner_bot = ?').get(ben.botId).n, 0);
  assert.equal(env.relay.db.prepare('SELECT used_at FROM invites WHERE plain_code = ?').get(draft.code).used_at, null);
  env.relay.db.prepare('UPDATE group_links SET revoked_at = NULL WHERE plain_code = ?').run(old);
  assert.equal((await ben.b(`/i/${draft.code}`, { method: 'POST', form: { bot: ben.botId, alias: 'Anna' } })).status, 200);
  assert.equal(env.relay.db.prepare('SELECT state FROM group_members WHERE group_id = ? AND bot_id = ?').get(gid, ben.botId).state, 'joined');
});

test('a quick-connect invitee sees the group encryption change before joining', async (t) => {
  const env = await setup(t);
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  const ben = await login(env, 'ben@example.com');
  await connectApp(env, ben, 'ben-quick');
  await anna.api('POST', '/v1/groups', { name: 'Review' });
  const draft = (await anna.api('POST', '/v1/invites', { alias: 'ben@example.com', group: 'Review' })).json;
  const page = await ben(`/i/${draft.code}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Not end-to-end encrypted/);
  assert.match(page.text, /Joining with a Quick connect bot makes new group messages readable by bot2bot/);
  assert.match(page.text, /Connect and join group/);
});

test('cancel and Undo preserve the recipient; purged drafts cannot be revived', async (t) => {
  const env = await setup(t);
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  const other = await owner(env, t, 'wrong@example.com', 'wrong');
  const draft = (await anna.api('POST', '/v1/invites', { alias: 'ben@example.com' })).json;
  const form = { bot: anna.botId, code: draft.code };
  await anna.b('/app/invites/cancel', { method: 'POST', form });
  env.relay.retention();
  assert.equal((await anna.b('/app/invites/cancel', { method: 'POST', form: { ...form, undo: '1' } })).status, 303);
  assert.equal((await other.api('POST', '/v1/invites/accept', { code: draft.code, alias: 'Anna' })).status, 403);
  await anna.b('/app/invites/cancel', { method: 'POST', form });
  env.advance(86_400_001);
  env.relay.retention();
  assert.equal((await anna.b('/app/invites/cancel', { method: 'POST', form: { ...form, undo: '1' } })).status, 404);
});

test('the default no-install prompt preserves the invitation through ChatGPT setup', async (t) => {
  const env = await setup(t);
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  const draft = (await anna.api('POST', '/v1/invites', { alias: 'ben@example.com' })).json;
  const page = await browser(env.url)(`/i/${draft.code}`);
  assert.match(page.text, /Quick connect is not end-to-end encrypted/);
  assert.ok(page.text.includes(`/connect/chatgpt?invite=${draft.code} and stop`));
  const guide = await browser(env.url)(`/connect/chatgpt?invite=${draft.code}`);
  assert.ok(guide.text.includes(`/i/${draft.code}`));
});

test('the daily email cap counts owner-confirmed sends even after invite cancellation', async (t) => {
  const env = await setup(t);
  const anna = await owner(env, t, 'anna@example.com', 'anna');
  for (let n = 0; n < 10; n++) {
    const draft = (await anna.api('POST', '/v1/invites', { alias: `friend${n}@example.com` })).json;
    const form = await reviewForm(anna, draft);
    assert.equal((await anna.b('/app/invites/email', { method: 'POST', form })).status, 303);
    await anna.b('/app/invites/cancel', { method: 'POST', form: { bot: anna.botId, code: draft.code } });
  }
  const draft = (await anna.api('POST', '/v1/invites', { alias: 'next@example.com' })).json;
  const form = await reviewForm(anna, draft);
  assert.equal((await anna.b('/app/invites/email', { method: 'POST', form })).status, 429);
  assert.equal(invitationMail(env).length, 10);
  env.advance(86_400_001);
  assert.equal((await anna.b('/app/invites/email', { method: 'POST', form })).status, 303);
  assert.equal(invitationMail(env).length, 11);
});
