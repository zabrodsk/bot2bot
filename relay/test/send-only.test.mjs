// Send only (bot2bot.link/send): an ordinary chat (ChatGPT, Claude…) hands a brief to one of its owner's own bots.
// It signs in with OAuth for the /send resource, gets two tools, only reaches its owner's own bots, and nothing
// can be sent back to it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup, login, cliHome, owner, listen, waitFor, REDIRECT, ADMIN } from './helpers.mjs';
import { SEND_TOOLS, SEND_INSTRUCTIONS } from '../connector.mjs';

// A chat app signing in for /send, the way ChatGPT and Claude do (RFC 8707 resource on every step).
async function connectSender(env, b, name) {
  const resource = `${env.url}/send`;
  const meta = await (await fetch(`${env.url}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: name, redirect_uris: [REDIRECT] }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 's1', resource };
  const consent = await b(`/oauth/authorize?${new URLSearchParams(params)}`);
  const ok = await b('/oauth/authorize', { method: 'POST', form: { ...params, decision: 'allow' } });
  const code = new URL(ok.location).searchParams.get('code');
  const tokens = await (await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier, resource }) })).json();
  let id = 0;
  const rpc = async (method, p = {}, path = '/send') => {
    const r = await fetch(`${env.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: p }) });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  };
  const tool = async (n, args = {}) => (await rpc('tools/call', { name: n, arguments: args })).body.result;
  return { consent, tokens, rpc, tool };
}

// Both the attachment source and the blob store are local. No real chat account or bot is used.
async function chatFiles(t, limits = {}) {
  const blobs = new Map(), sources = new Map([['plan.pdf', Buffer.from('%PDF-1.4\nA real attachment, not a link.')], ['photo.png', Buffer.from([137, 80, 78, 71, 0, 255, 18])]]);
  const counts = { downloads: 0, uploads: 0 };
  const { s, url } = await listen(async (req, res) => {
    const path = new URL(req.url, url).pathname;
    if (path.startsWith('/source/')) {
      counts.downloads++;
      const data = sources.get(path.slice(8));
      if (!data) return res.writeHead(404).end();
      return res.writeHead(200, { 'content-length': data.length }).end(data);
    }
    if (req.method === 'PUT') {
      counts.uploads++;
      const parts = []; for await (const c of req) parts.push(c);
      blobs.set(path, Buffer.concat(parts)); return res.writeHead(200).end();
    }
    if (req.method === 'GET') return blobs.has(path) ? res.writeHead(200).end(blobs.get(path)) : res.writeHead(404).end();
    if (req.method === 'DELETE') { blobs.delete(path); return res.writeHead(204).end(); }
    res.writeHead(405).end();
  });
  t.after(() => s.close());
  const env = await setup(t, { keySecret: 'local-chat-file-test-secret', files: { s3: { endpoint: url, bucket: 'chat-files', region: 'auto', keyId: 'test-key', secret: 'test-secret', style: 'path' }, alpha: true }, limits });
  const p = await owner(env, t, 'mia@example.com', 'mia');
  p.routine.status = 503;
  env.relay.db.prepare("UPDATE bots SET platform = 'codex' WHERE id = ?").run(Number(p.botId));
  const gpt = await connectSender(env, p.b, 'ChatGPT');
  const previous = process.env.B2B_FILES;
  process.env.B2B_FILES = mkdtempSync(join(tmpdir(), 'b2b-chat-files-'));
  t.after(() => { if (previous == null) delete process.env.B2B_FILES; else process.env.B2B_FILES = previous; });
  const file = (name, id = name) => ({ download_url: `${url}/source/${name}`, file_id: `file_${id}`, file_name: name, mime_type: name.endsWith('.pdf') ? 'application/pdf' : 'image/png' });
  return { env, p, gpt, file, blobs, sources, counts };
}

test('chat attachments: ChatGPT passes real files, retries send once, and Codex saves the original bytes without an E2E claim', async (t) => {
  const { env, p, gpt, file, blobs, sources, counts } = await chatFiles(t);
  const descriptor = (await gpt.rpc('tools/list')).body.result.tools.find((x) => x.name === 'send_to_bot');
  assert.deepEqual(descriptor._meta['openai/fileParams'], ['files']);
  assert.deepEqual(descriptor.inputSchema.properties.files.items.required, ['download_url', 'file_id']);
  assert.deepEqual(Object.keys(descriptor.inputSchema.properties.files.items.properties).sort(), ['download_url', 'file_id', 'file_name', 'mime_type']);
  const args = { to: 'codex', text: 'Use the attached source files.', files: [file('plan.pdf'), file('photo.png')] };
  const sent = await Promise.all([gpt.tool('send_to_bot', args), gpt.tool('send_to_bot', args)]);
  for (const r of sent) assert.equal(r.isError, false, r.content[0].text);
  assert.match(sent[0].content[0].text, /with 2 files/);
  assert.equal(counts.downloads, 2); assert.equal(counts.uploads, 2);
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'note'").get().n, 1);
  const rows = env.relay.db.prepare('SELECT * FROM files').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((f) => f.chat_meta.startsWith('enc:v1:')), 'file metadata encrypted at rest when the relay has its key secret');
  for (const blob of blobs.values()) assert.ok(!blob.includes(sources.get('plan.pdf')), 'blob storage contains ciphertext');
  assert.match((await gpt.tool('send_to_bot', args)).content[0].text, /Already sent/);
  assert.equal(counts.downloads, 2, 'a lost response does not download or charge again');
  const records = (await p.cli('inbox', '--json')).trim().split('\n').map((s) => JSON.parse(s));
  const m = records.find((r) => r.type === 'message');
  assert.equal(m.evidence.encrypted, false); assert.equal(m.evidence.own_bot, true);
  assert.equal(m.untrusted.files.length, 2);
  for (const f of m.untrusted.files) assert.deepEqual(readFileSync(f.saved), sources.get(f.name));
  await waitFor(() => blobs.size === 0);
  assert.ok(env.relay.db.prepare('SELECT * FROM files').all().every((f) => f.deleted_at && f.chat_meta === null), 'bytes and metadata deleted after delivery');
});

test('chat attachments: file-only sends work and a different file is not swallowed by text deduplication', async (t) => {
  const { env, p, gpt, file } = await chatFiles(t);
  for (const name of ['plan.pdf', 'photo.png']) {
    const r = await gpt.tool('send_to_bot', { to: 'mia', files: [file(name)] });
    assert.equal(r.isError, false, r.content[0].text);
  }
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'note'").get().n, 2);
  assert.match(await p.cli('inbox'), /file: "plan\.pdf"[^]*file: "photo\.png"/);
});

test('chat attachments: refuse disabled files, old receivers, malformed inputs and other owners before downloading', async (t) => {
  const { env, p, gpt, file, counts } = await chatFiles(t);
  const args = { to: 'mia', files: [file('plan.pdf')] };
  const check = async (a, pattern) => {
    const r = await gpt.tool('send_to_bot', a);
    assert.equal(r.isError, true); assert.match(r.content[0].text, pattern);
    assert.equal(counts.downloads, 0);
  };
  await check({ ...args, files: ['/mnt/data/plan.pdf'] }, /Attach the file again/);
  await check({ ...args, files: Array(6).fill(file('plan.pdf')) }, /at most 5/);
  const other = await owner(env, t, 'other@example.com', 'someone-else');
  other.routine.status = 503;
  await check({ ...args, to: 'someone-else' }, /None of your owner's bots/);
  env.relay.db.prepare("UPDATE bots SET tool_version = '0.22.9' WHERE id = ?").run(Number(p.botId));
  await check(args, /needs bot2bot 0\.22\.10/);
  env.relay.db.prepare("UPDATE bots SET tool_version = '0.22.10', box_pub = NULL WHERE id = ?").run(Number(p.botId));
  await check(args, /doesn't use end-to-end encryption/);
  await p.b('/app/account/files', { method: 'POST', form: {} });
  await check(args, /turned off sending files/);
  assert.equal(env.relay.db.prepare('SELECT count(*) AS n FROM files').get().n, 0);
});

test('chat attachments: only the receiver can download, and disconnecting during a download prevents delivery', async (t) => {
  const { env, p, gpt, file, blobs, sources } = await chatFiles(t);
  const other = await owner(env, t, 'other@example.com', 'other');
  other.routine.status = 503;
  assert.equal((await gpt.tool('send_to_bot', { to: 'mia', files: [file('plan.pdf')] })).isError, false);
  const id = env.relay.db.prepare('SELECT id FROM files').get().id;
  assert.equal((await other.api('GET', `/v1/files/${id}`)).status, 404);
  assert.equal((await p.api('GET', `/v1/files/${id}`)).status, 200);
  await p.cli('contacts'); // the raw API call above sent no tool version; the real receiving CLI advertises it
  // Turn the chat off while the source request is being served, before it can enqueue a message.
  const get = sources.get.bind(sources);
  sources.get = (name) => {
    env.relay.db.prepare("UPDATE bots SET disconnected_at = ? WHERE platform = 'sender'").run(env.now());
    return get(name);
  };
  const r = await gpt.tool('send_to_bot', { to: 'mia', files: [file('photo.png')] });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /chat was disconnected/);
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'note'").get().n, 1);
  assert.equal(blobs.size, 1, 'only the earlier authorized attachment remains');
});

test('chat attachments: a failed later attachment sends nothing and removes earlier uploaded bytes', async (t) => {
  const { env, gpt, file, blobs } = await chatFiles(t);
  const r = await gpt.tool('send_to_bot', { to: 'codex', text: 'Both files', files: [file('plan.pdf'), file('missing.pdf')] });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /Attach the file again/);
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'note'").get().n, 0);
  await waitFor(() => blobs.size === 0);
  assert.ok(env.relay.db.prepare('SELECT * FROM files').all().every((f) => f.chat_meta === null && f.deleted_at));
});

test('chat attachments: size and daily limits apply, and undelivered files expire after seven days', async (t) => {
  const { env, gpt, file, blobs, sources } = await chatFiles(t, { fileMaxPaid: 40, filesPerDayPaid: 1 });
  sources.set('big.pdf', Buffer.alloc(41));
  const big = await gpt.tool('send_to_bot', { to: 'mia', files: [file('big.pdf')] });
  assert.equal(big.isError, true); assert.match(big.content[0].text, /bigger than your file size limit/);
  assert.equal((await gpt.tool('send_to_bot', { to: 'mia', files: [file('plan.pdf')] })).isError, false);
  const over = await gpt.tool('send_to_bot', { to: 'mia', files: [file('photo.png')] });
  assert.equal(over.isError, true); assert.match(over.content[0].text, /0 files left today/);
  env.advance(7 * 86_400_000 + 1_000); env.relay.retention();
  await waitFor(() => blobs.size === 0);
  assert.equal(env.relay.db.prepare('SELECT chat_meta FROM files').get().chat_meta, null);
});

test('chat files from any app: Claude writes a file out or passes a public link, and only sees what it can use', async (t) => {
  const { env, p, gpt, file, sources, counts } = await chatFiles(t);
  const claude = await connectSender(env, p.b, 'Claude');
  const tools = (await claude.rpc('tools/list')).body.result.tools;
  const send = tools.find((x) => x.name === 'send_to_bot');
  assert.equal(send.inputSchema.properties.files, undefined, 'no upload input where the app has no uploads');
  assert.equal(send._meta?.['openai/fileParams'], undefined);
  assert.deepEqual(Object.keys(send.inputSchema.properties.documents.items.properties).sort(), ['name', 'text', 'url']);
  assert.match(send.description, /can't pass on files your owner uploaded/);
  const mine = (await gpt.rpc('tools/list')).body.result.tools.find((x) => x.name === 'send_to_bot');
  assert.ok(mine.inputSchema.properties.files && mine.inputSchema.properties.documents, 'ChatGPT keeps real uploads and gets documents too');

  const report = '# Findings\n\nŽluťoučký kůň: UTF-8 survives.\n';
  const csv = 'name,score\nanna,3\n';
  const r = await claude.tool('send_to_bot', { to: 'codex', text: 'Two files from our chat.', want: 'keep them for later', documents: [
    { name: 'findings.md', text: report }, { name: 'scores.csv', text: csv }, { name: 'plan.pdf', url: file('plan.pdf').download_url }] });
  assert.equal(r.isError, false, r.content[0].text);
  assert.match(r.content[0].text, /with 3 files/);
  assert.equal(counts.downloads, 1, 'written-out files need no download; the link is fetched once');
  const records = (await p.cli('inbox', '--json')).trim().split('\n').map((x) => JSON.parse(x));
  const m = records.find((x) => x.type === 'message');
  assert.equal(m.evidence.encrypted, false);
  const got = Object.fromEntries(m.untrusted.files.map((f) => [f.name, readFileSync(f.saved)]));
  assert.equal(got['findings.md'].toString('utf8'), report);
  assert.equal(got['scores.csv'].toString('utf8'), csv);
  assert.deepEqual(got['plan.pdf'], sources.get('plan.pdf'));
  // Sending the same again is caught as a retry, not charged twice.
  assert.match((await claude.tool('send_to_bot', { to: 'codex', text: 'Two files from our chat.', want: 'keep them for later', documents: [
    { name: 'findings.md', text: report }, { name: 'scores.csv', text: csv }, { name: 'plan.pdf', url: file('plan.pdf').download_url }] })).content[0].text, /Already sent/);
});

test('chat files from any app: Claude sends a file to Claude Code and another to Codex, each by its name', async (t) => {
  const { env, p } = await chatFiles(t);
  // A second bot for the same person, a Claude Code on another computer.
  await p.b('/app/bots', { method: 'POST', form: { handle: 'mia-cc' } });
  const cc = cliHome();
  await cc.cli('enroll', env.url, (await p.b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]);
  env.relay.db.prepare("UPDATE bots SET platform = 'claude_code' WHERE handle = 'mia-cc'").run();
  await cc.cli('contacts');
  const claude = await connectSender(env, p.b, 'Claude');
  assert.match((await claude.tool('list_my_bots')).content[0].text, /@mia · Codex[^]*@mia-cc · Claude Code/);
  for (const [to, name, text] of [['claude code', 'plan.md', '# Plan\n\nShip it.\n'], ['codex', 'fix.py', 'print("fixed")\n']]) {
    const r = await claude.tool('send_to_bot', { to, title: `For ${to}`, documents: [{ name, text }] });
    assert.equal(r.isError, false, r.content[0].text);
  }
  const saved = async (cli) => (await cli('inbox', '--json')).trim().split('\n').map((x) => JSON.parse(x)).filter((x) => x.type === 'message').flatMap((m) => m.untrusted.files.map((f) => [f.name, readFileSync(f.saved, 'utf8')]));
  assert.deepEqual(await saved(cc.cli), [['plan.md', '# Plan\n\nShip it.\n']]);
  assert.deepEqual(await saved(p.cli), [['fix.py', 'print("fixed")\n']]);
});

test('chat files from any app: bad documents and limits are refused before anything is fetched or stored', async (t) => {
  const { env, p, file, counts } = await chatFiles(t, { chatDocMax: 50, fileMaxPaid: 30 });
  const claude = await connectSender(env, p.b, 'Claude');
  const check = async (documents, pattern) => {
    const r = await claude.tool('send_to_bot', { to: 'mia', documents });
    assert.equal(r.isError, true); assert.match(r.content[0].text, pattern);
  };
  await check([{ name: 'a.md' }], /either its whole text or a public HTTPS url/);
  await check([{ name: 'a.md', text: 'x', url: file('plan.pdf').download_url }], /not both/);
  await check([{ text: 'no name' }], /needs a name/);
  await check([{ name: 'a.md', text: '' }], /a\.md is empty/);
  await check([{ name: 'long.md', text: 'x'.repeat(51) }], /up to 50\. Split it/);
  await check([{ name: 'a.md', url: '/mnt/data/a.md' }], /public https:\/\/ address/);
  await check(Array(6).fill({ name: 'a.md', text: 'x' }), /at most 5 files/);
  assert.equal(counts.downloads, 0);
  await check([{ name: 'big.md', text: 'y'.repeat(31) }], /bigger than your file size limit/);
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM messages WHERE kind = 'note'").get().n, 0);
  // A send with too much in it is refused whole, with a reason the chat can act on.
  const big = await claude.rpc('tools/call', { name: 'send_to_bot', arguments: { to: 'mia', text: 'z'.repeat(400_001) } });
  assert.equal(big.status, 413);
});

test('send only: a chat signs in for /send, lists its owner\'s bots and hands one a long brief', async (t0) => {
  const env = await setup(t0);
  // No token: the client is pointed at the /send resource's own metadata. A browser gets the page that explains it.
  const anon = await fetch(`${env.url}/send`, { method: 'POST', body: '{}' });
  assert.equal(anon.status, 401);
  assert.match(anon.headers.get('www-authenticate'), /resource_metadata=".*\/\.well-known\/oauth-protected-resource\/send"/);
  assert.equal((await (await fetch(`${env.url}/.well-known/oauth-protected-resource/send`)).json()).resource, `${env.url}/send`);
  const page = await fetch(`${env.url}/send`, { headers: { accept: 'text/html' }, redirect: 'manual' });
  assert.equal(page.headers.get('location'), '/connect/send');
  assert.match(await (await fetch(`${env.url}/connect/send`)).text(), /Which chat app\?[^]*href="\/connect\/send\/chatgpt"[^]*ChatGPT[^]*href="\/connect\/send\/claude"/);
  assert.match(await (await fetch(`${env.url}/connect/send/claude/steps`)).text(), new RegExp(`Connect Claude[^]*${env.url}/send`));

  // Dušan has a Codex bot (no doorbell, so its inbox is read here).
  const b = await login(env, 'dusan@example.com');
  await b('/app/bots', { method: 'POST', form: { handle: 'dusan' } });
  const { cli } = cliHome();
  await cli('enroll', env.url, (await b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]);
  env.relay.db.prepare("UPDATE bots SET platform = 'codex' WHERE handle = 'dusan'").run();
  assert.match((await b('/app')).text, /href="\/connect\/send"/);
  // The setup: pick the chat app, name it, then that app's steps and nothing else. It waits for the sign-in.
  assert.match((await b('/connect/send')).text, /Which chat app\?[^]*href="\/connect\/send\/chatgpt"/);
  assert.match((await b('/connect/send/chatgpt')).text, /What should your bots call it\?[^]*name="name" value="ChatGPT"/);
  const named = await b('/connect/send/chatgpt', { method: 'POST', form: { name: 'ChatGPT' } });
  assert.equal(named.location, '/connect/send/chatgpt/steps');
  const setupPage = (await b(named.location)).text;
  assert.match(setupPage, /Connect ChatGPT[^]*Open ChatGPT Plugins[^]*Server URL[^]*Waiting for you to connect/);
  assert.doesNotMatch(setupPage, /Gemini|Claude|Grok|Perplexity|Le Chat/);
  assert.equal((await b('/app/status')).json().senders, 0);

  const gpt = await connectSender(env, b, 'ChatGPT');
  assert.match(gpt.consent.text, /Let ChatGPT send to your bots\?[^]*can't read your messages[^]*Not end-to-end encrypted/);
  assert.doesNotMatch(gpt.consent.text, /Which bot/);
  assert.ok(gpt.tokens.access_token);
  // Its token only opens /send, and /send only has the two tools.
  assert.equal((await gpt.rpc('ping', {}, '/mcp')).status, 401);
  const init = await gpt.rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.equal(init.body.result.instructions, SEND_INSTRUCTIONS);
  assert.deepEqual((await gpt.rpc('tools/list')).body.result.tools.map((t) => t.name), SEND_TOOLS.map((t) => t.name));
  assert.equal((await gpt.rpc('tools/call', { name: 'check_inbox', arguments: {} })).body.error.code, -32602);

  assert.match((await gpt.tool('list_my_bots')).content[0].text, /@dusan · Codex/);
  const brief = `Goal: ship onboarding.\n${'Details line. '.repeat(1500)}`; // ~21,000 characters, past the usual 8,000
  const sent = await gpt.tool('send_to_bot', { to: 'my codex', title: 'Brief: onboarding', text: brief, want: 'start on this' });
  assert.equal(sent.isError, false, sent.content[0].text);
  assert.match(sent.content[0].text, /Sent to @dusan \(Codex\)[^]*shows it to your owner before acting/);

  // Codex gets all of it, marked as its owner's own bot, with what Dušan wants.
  const inbox = await cli('inbox');
  assert.match(inbox, /from "dusan-chatgpt" \(@dusan-chatgpt\).*another of your owner's own bots/);
  assert.match(inbox, /\| # Brief: onboarding\n\|\s*\n\| Goal: ship onboarding\./);
  assert.match(inbox, /start on this/);
  assert.equal((inbox.match(/Details line\./g) || []).length, 1500);
  // Nothing goes back to the chat: it can't get messages.
  await assert.rejects(cli('send', 'dusan-chatgpt', 'thanks'), /only sends to your owner's bots/);

  // Too long, or a bot that isn't there: the chat is told what to do instead.
  const long = await gpt.tool('send_to_bot', { to: 'codex', text: 'x'.repeat(40_001) });
  assert.equal(long.isError, true);
  assert.match(long.content[0].text, /Send it in parts/);
  const nobody = await gpt.tool('send_to_bot', { to: 'grok', text: 'hi' });
  assert.match(nobody.content[0].text, /None of your owner's bots is called "grok"[^]*@dusan \(Codex\)/);

  // The dashboard shows it as a send-only chat; connecting again brings back the same one.
  const home = (await b('/app')).text;
  // Chat apps have their own section: ChatGPT connected, the others one tap away. Your bots doesn't count it.
  assert.match(home, /id="bots-h">Your bots <span class="count">1<\/span>/);
  assert.match(home, /id="chats-h">Chat apps <span class="count">1<\/span>[^]*Connect a chat app[^]*href="\/app\/bots\/\d+"[^]*ChatGPT[^]*Sends to your bots[^]*href="\/connect\/send\/claude"[^]*Not connected[^]*href="\/connect\/send\/gemini"/);
  const botsList = home.slice(home.indexOf('id="bots-h"'), home.indexOf('id="chats-h"'));
  assert.doesNotMatch(botsList, /dusan-chatgpt/);
  // The page now says it's ready, with the first thing to say; the sign-in left a confirmation.
  assert.equal((await b('/app/status')).json().senders, 1);
  assert.match(home, /class="toast"[^>]*>[^]*ChatGPT can send to your bots now/);
  assert.match((await b('/connect/send/chatgpt/done')).text, /ChatGPT is connected[^]*send it to my Codex with bot2bot[^]*Connect another chat app/);
  assert.match((await b('/connect/send')).text, /ChatGPT<\/span><span class="line__sub">Connected as ChatGPT/);
  // An old link for one app goes to its own setup.
  assert.equal((await b('/connect/send?app=gemini')).location, '/connect/send/gemini');
  const senderId = env.relay.db.prepare("SELECT id FROM bots WHERE handle = 'dusan-chatgpt'").get().id;
  assert.match((await b(`/app/bots/${senderId}`)).text, /ChatGPT[^]*Chat app · @dusan-chatgpt[^]*Sends to your bots[^]*Disconnect this bot/);
  await connectSender(env, b, 'ChatGPT');
  assert.equal(env.relay.db.prepare("SELECT count(*) AS n FROM bots WHERE platform = 'sender'").get().n, 1);
  // The full connected-app sign-in never offers it as a bot to use.
  const meta = await (await fetch(`${env.url}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Grok Bot', redirect_uris: [REDIRECT] }) })).json();
  const full = await b(`/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256' })}`);
  assert.doesNotMatch(full.text, /dusan-chatgpt/);

  // Disconnecting it ends its access.
  await b(`/app/bots/${senderId}/disconnect`, { method: 'POST' });
  assert.equal((await gpt.rpc('ping')).status, 401);
});

test('send only: it reaches only its owner\'s own bots, never their friends', async (t0) => {
  const env = await setup(t0);
  const b = await login(env, 'mia@example.com');
  const claude = await connectSender(env, b, 'claude.ai');
  // No bots yet: the chat is told to connect one first.
  assert.match((await claude.tool('list_my_bots')).content[0].text, /no bots on bot2bot yet/);
  // A friend's bot (a contact of Mia's bot, not her own) is never on the list and can't be sent to.
  const handle = env.relay.db.prepare("SELECT handle FROM bots WHERE platform = 'sender'").get().handle;
  assert.equal(handle, 'mia-claude');
  const ben = await login(env, 'ben@example.com');
  await ben('/app/bots', { method: 'POST', form: { handle: 'ben' } });
  const { cli } = cliHome();
  await cli('enroll', env.url, (await ben('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]);
  assert.match((await claude.tool('send_to_bot', { to: 'ben', text: 'hi' })).content[0].text, /no bots on bot2bot yet/);
});

test('send only: one ChatGPT, two bot2bot accounts: the second sign-in switches account first', async (t0) => {
  const env = await setup(t0);
  // Work and home: one bot each.
  const join = async (b, handle) => { await b('/app/bots', { method: 'POST', form: { handle } }); await cliHome().cli('enroll', env.url, (await b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]); };
  const work = await login(env, 'tom@work.example');
  await join(work, 'tom-work');
  const home = await login(env, 'tom@home.example');
  await join(home, 'tom-home');
  const first = await connectSender(env, work, 'ChatGPT');
  // ChatGPT's second app opens the sign-in in the same browser, still signed in to work. The consent page says so.
  const meta = await (await fetch(`${env.url}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [REDIRECT] }) })).json();
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', state: 's2', scope: '', resource: `${env.url}/send` };
  const consent = await work(`/oauth/authorize?${new URLSearchParams(params)}`);
  assert.match(consent.text, /Signed in as tom@work\.example\.[^]*Use another account/);
  // Use another account: signed out, then straight to sign-in, which comes back to this consent.
  const next = consent.text.match(/name="next" value="([^"]+)"/)[1].replace(/&amp;/g, '&');
  const out = await work('/logout', { method: 'POST', form: { next } });
  assert.equal(out.location, `/login?next=${encodeURIComponent(`/oauth/authorize?${new URLSearchParams(params)}`)}`);
  assert.match((await work('/app')).location, /^\/login/);
  // Home signs in and connects: each account gets its own ChatGPT sender, and each only reaches its own bots.
  const second = await connectSender(env, home, 'ChatGPT');
  const senders = env.relay.db.prepare("SELECT handle FROM bots WHERE platform = 'sender' ORDER BY id").all().map((r) => r.handle);
  assert.equal(senders.length, 2);
  assert.match((await first.tool('list_my_bots')).content[0].text, /@tom-work/);
  assert.doesNotMatch((await first.tool('list_my_bots')).content[0].text, /@tom-home/);
  assert.match((await second.tool('list_my_bots')).content[0].text, /@tom-home/);
  assert.doesNotMatch((await second.tool('list_my_bots')).content[0].text, /@tom-work/);
  // ChatGPT's multi-account: a profile tool tells the two apart, with an id that stays the same.
  const tool = (await first.rpc('tools/list')).body.result.tools.find((t) => t._meta?.['openai/profile'] === true);
  assert.equal(tool.name, 'get_profile');
  const p1 = (await first.tool('get_profile')).structuredContent;
  const p2 = (await second.tool('get_profile')).structuredContent;
  assert.equal(p1.email, 'tom@work.example');
  assert.equal(p2.email, 'tom@home.example');
  assert.notEqual(p1.id, p2.id);
  assert.match(p1.id, /^acct_[0-9a-f]{20}$/);
  assert.deepEqual(Object.keys(p1).filter((k) => !Object.keys(tool.outputSchema.properties).includes(k)), []);
  // A plain log out still goes home.
  assert.equal((await home('/logout', { method: 'POST' })).location, '/');
});

test('send only: Grok, Perplexity and Le Chat each get their own sender, logo and steps', async (t0) => {
  const env = await setup(t0);
  const b = await login(env, 'mia@example.com');
  assert.match((await b('/connect/send')).text, /href="\/connect\/send\/perplexity"[^]*href="\/connect\/send\/lechat"/);
  const page = (await b('/connect/send/grok/steps')).text;
  assert.match(page, /Connect Grok[^]*grok\.com\/connectors[^]*pick Send only/);
  assert.doesNotMatch(page, /Perplexity|Le Chat|ChatGPT/);
  for (const name of ['Grok', 'Perplexity', 'Le Chat']) await connectSender(env, b, name);
  const rows = env.relay.db.prepare("SELECT handle, display_name FROM bots WHERE platform = 'sender' ORDER BY id").all();
  assert.deepEqual(rows.map((r) => r.display_name), ['Grok', 'Perplexity', 'Le Chat']);
  assert.deepEqual(rows.map((r) => r.handle), ['mia-grok', 'mia-perplexity', 'mia-le-chat']);
});

test('send only: a chat that sends no resource (Gemini) picks Send only, and Google keeps one refresh token', async (t0) => {
  const env = await setup(t0);
  const b = await login(env, 'mia@example.com');
  const GOOGLE = 'https://oauth-redirect.googleusercontent.com/r/gemini-test';
  const meta = await (await fetch(`${env.url}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Gemini', redirect_uris: [GOOGLE] }) })).json();
  const verifier = randomBytes(32).toString('base64url');
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: GOOGLE, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state: 'g' };
  // No resource: the full sign-in, where Send only is one of the choices.
  assert.match((await b(`/oauth/authorize?${new URLSearchParams(params)}`)).text, /<option value="send">Send only: it hands things to my bots/);
  const ok = await b('/oauth/authorize', { method: 'POST', form: { ...params, bot: 'send', decision: 'allow' } });
  const swap = (form) => fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }).then((r) => r.json());
  const tokens = await swap({ grant_type: 'authorization_code', code: new URL(ok.location).searchParams.get('code'), redirect_uri: GOOGLE, client_id: reg.client_id, code_verifier: verifier });
  const call = (path, token, method = 'tools/list') => fetch(`${env.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: {} }) });
  assert.equal(env.relay.db.prepare("SELECT handle FROM bots WHERE platform = 'sender'").get().handle, 'mia-gemini');
  assert.deepEqual((await (await call('/send', tokens.access_token)).json()).result.tools.map((t) => t.name), SEND_TOOLS.map((t) => t.name));
  // The full connector never takes a send-only chat's token.
  assert.equal((await call('/mcp', tokens.access_token, 'ping')).status, 401);
  // Refreshing gives a new access token and the same refresh token, still good next time.
  const r1 = await swap({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id });
  assert.equal(r1.refresh_token, tokens.refresh_token);
  assert.notEqual(r1.access_token, tokens.access_token);
  const r2 = await swap({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id });
  assert.ok(r2.access_token);
  assert.equal((await call('/send', r2.access_token, 'ping')).status, 200);
});

test('send only: a name picked in the setup names the sender, so one Gemini can be work and one home', async (t0) => {
  const env = await setup(t0);
  const b = await login(env, 'mia@example.com');
  assert.equal((await b('/connect/send/gemini', { method: 'POST', form: { name: '  ' } })).status, 400);
  assert.equal((await b('/connect/send/gemini', { method: 'POST', form: { name: 'Gemini work' } })).location, '/connect/send/gemini/steps');
  assert.match((await b('/connect/send/gemini/steps')).text, /Connect Gemini[^]*select Custom[^]*gemini\.google\.com\/apps/);
  const GOOGLE = 'https://oauth-redirect.googleusercontent.com/r/gemini-test';
  const meta = await (await fetch(`${env.url}/.well-known/oauth-authorization-server`)).json();
  const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Gemini', redirect_uris: [GOOGLE] }) })).json();
  const params = { response_type: 'code', client_id: reg.client_id, redirect_uri: GOOGLE, code_challenge: 'c'.repeat(43), code_challenge_method: 'S256', state: 'g' };
  // Gemini sends no resource, so it gets the full sign-in, with Send only already picked.
  assert.match((await b(`/oauth/authorize?${new URLSearchParams(params)}`)).text, /<option value="send" selected>Send only/);
  await b('/oauth/authorize', { method: 'POST', form: { ...params, bot: 'send', decision: 'allow' } });
  const row = env.relay.db.prepare("SELECT handle, display_name, chat_app FROM bots WHERE platform = 'sender'").get();
  assert.deepEqual({ ...row }, { handle: 'mia-gemini-work', display_name: 'Gemini work', chat_app: 'Gemini' });
  assert.match((await b('/connect/send/gemini/done')).text, /Gemini work is connected/);
  // A second Gemini, under its own name, is a second sender.
  await b('/connect/send/gemini', { method: 'POST', form: { name: 'Gemini home' } });
  await b('/oauth/authorize', { method: 'POST', form: { ...params, bot: 'send', decision: 'allow' } });
  assert.deepEqual(env.relay.db.prepare("SELECT display_name FROM bots WHERE platform = 'sender' ORDER BY id").all().map((r) => r.display_name), ['Gemini work', 'Gemini home']);
});

test('directory checks: domain proofs as plain text, and a reviewer signs in with their own code', async (t0) => {
  const env = await setup(t0, { domainProofs: { 'openai-apps-challenge': 'tok-123', 'mcp-registry-auth': 'v=MCPv1; k=ed25519; p=abc' }, reviewLogin: { email: 'review@example.com', code: '424242' } });
  const proof = await fetch(`${env.url}/.well-known/openai-apps-challenge`);
  assert.equal(proof.status, 200);
  assert.match(proof.headers.get('content-type'), /^text\/plain/);
  assert.equal(await proof.text(), 'tok-123');
  assert.equal(await (await fetch(`${env.url}/.well-known/mcp-registry-auth`)).text(), 'v=MCPv1; k=ed25519; p=abc');
  assert.equal((await fetch(`${env.url}/.well-known/google-connected-apps`)).status, 404);
  // The reviewer asks for a code as usual, then their own code works; for anyone else it doesn't.
  const { browser } = await import('./helpers.mjs');
  const rv = browser(env.url);
  await rv('/login', { method: 'POST', form: { email: 'review@example.com' } });
  const inn = await rv('/login/verify', { method: 'POST', form: { email: 'review@example.com', code: '424242' } });
  assert.ok([302, 303].includes(inn.status) && !/login/.test(inn.location), 'signed in');
  const other = browser(env.url);
  await other('/login', { method: 'POST', form: { email: 'tom@example.com' } });
  assert.equal((await other('/login/verify', { method: 'POST', form: { email: 'tom@example.com', code: '424242' } })).status, 400);
});

test('send only: a T3 Code inbox waits until its owner asks, with T3 Code\'s name and logo', async (t0) => {
  const env = await setup(t0);
  const b = await login(env, 'dusan@example.com');
  await b('/app/bots', { method: 'POST', form: { handle: 't3code' } });
  const { cli } = cliHome();
  await cli('enroll', env.url, (await b('/app')).text.match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1]);
  // The operator moves it to T3 Code; only names a bot may join as are taken.
  const admin = (body) => fetch(`${env.url}/admin/platform`, { method: 'POST', headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await fetch(`${env.url}/admin/platform`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await admin({ handle: 't3code', platform: 'sender' })).status, 400);
  assert.equal((await admin({ handle: 'nobody', platform: 't3code' })).status, 404);
  assert.deepEqual(await (await admin({ handle: '@t3code', platform: 'T3-Code' })).json(), { handle: 't3code', platform: 't3code' });

  // The dashboard shows T3 Code with its mark, connected, with no watcher or doorbell step.
  const home = (await b('/app')).text;
  const at = home.indexOf('data-origin="t3code"');
  assert.ok(at >= 0);
  const line = home.slice(home.lastIndexOf('<li>', at), home.indexOf('</li>', at));
  assert.match(line, /T3 Code[^]*Connected|Connected[^]*T3 Code/);
  assert.match(line, /viewBox="15\.5309 18\.28/);
  assert.doesNotMatch(line, /Watcher off|Doorbell off/);
  assert.doesNotMatch(await cli('whoami'), /watch --install|NEXT STEP/);

  // "Send it to my T3 Code" finds it, and the brief waits in its inbox until asked for.
  const gpt = await connectSender(env, b, 'ChatGPT');
  assert.match((await gpt.tool('list_my_bots')).content[0].text, /@t3code · T3 Code/);
  const sent = await gpt.tool('send_to_bot', { to: 'my T3 code', title: 'Brief: dark mode', text: 'Add a dark mode toggle.', want: 'start on this' });
  assert.equal(sent.isError, false, sent.content[0].text);
  assert.match(sent.content[0].text, /Sent to @t3code \(T3 Code\)/);
  // A day later it's still waiting, and nobody is emailed about it.
  env.advance(25 * 3_600_000);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(env.mail.filter((m) => /@t3code/.test(m.subject)).length, 0);
  assert.match(await cli('inbox'), /\| # Brief: dark mode[^]*Add a dark mode toggle\./);

  // A bot can also say it's T3 Code when it joins.
  const keys = { sign: 'a'.repeat(43), box: 'b'.repeat(43) };
  const r = await fetch(`${env.url}/v1/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys, agent: 't3code' }) });
  assert.notEqual(r.status, 400, await r.clone().text());
});
