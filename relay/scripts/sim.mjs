#!/usr/bin/env node
// Local simulator: a private relay on this computer plus pretend people and pretend bots.
// Use it to try the product and to test changes. It never contacts GrokBot or anyone's real bot.
//
//   node scripts/sim.mjs            then type commands at the prompt (type "help")
//
// Each pretend bot runs the real CLI with its own config folder. Its "doorbell routine" is a
// small local server that does what the real routine instruction says: read the inbox, tell its
// owner (printed here) and acknowledge.
import http from 'node:http';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRelay } from '../server.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'cli', 'b2b.mjs');
const PORT = Number(process.env.SIM_PORT || 8899);
const RELAY = `http://127.0.0.1:${PORT}`;
const BOT_PEOPLE = (process.env.SIM_PEOPLE || 'ben,anna,tom').split(',').map((s) => s.trim()).filter(Boolean);
// People without an AI bot use the web inbox, which is off by default now. SIM_WEB=gran turns it on for them.
const WEB_PEOPLE = (process.env.SIM_WEB ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const PEOPLE = [...BOT_PEOPLE, ...WEB_PEOPLE];

const c = { dim: (s) => `\x1b[2m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m` };
const cap = (s) => s[0].toUpperCase() + s.slice(1);

const relay = createRelay({
  dbPath: join(mkdtempSync(join(tmpdir(), 'b2b-sim-')), 'sim.db'),
  adminToken: randomBytes(24).toString('hex'),
  publicUrl: RELAY,
  allowLocalWebhooks: true,
  devLogin: true,
  webInbox: WEB_PEOPLE.length > 0,
  banner: 'Simulator: pretend people and pretend bots on this computer only.',
  mailer: async (m) => { if (!/login code/.test(m.subject)) say(`${c.yellow('email')} to ${m.to}: "${m.subject}"`); },
});
const server = http.createServer(relay.handle).listen(PORT, '127.0.0.1');
await new Promise((ok, fail) => { server.once('listening', ok); server.once('error', fail); });
setInterval(() => { relay.tick().catch((e) => console.error('tick', e)); }, 500).unref();

// A tiny browser for one pretend person: keeps their session cookie.
function browser() {
  let cookie = '';
  return async (path, form) => {
    const headers = { origin: RELAY };
    if (cookie) headers.cookie = cookie;
    let body;
    if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    const r = await fetch(RELAY + path, { method: form ? 'POST' : 'GET', headers, body, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return r.text();
  };
}

const bots = {};
let rl;
async function makePerson(name) {
  const web = browser();
  const email = `${name}@sim.local`;
  const sent = await web('/login', { email });
  const code = sent.match(/your code is <b>(\d{6})<\/b>/)[1];
  await web('/login/verify', { email, code });
  // Everyone picks a picture first; pretend people each get a different sticker or robot.
  await web('/app/picture', { avatar: ['sticker:robot-wink', 'sticker:fox', 'sticker:robot-party', 'sticker:cat', 'classic'][PEOPLE.indexOf(name) % 5] });
  if (WEB_PEOPLE.includes(name)) {
    await web('/app/web-inbox', {});
    const botId = (await web('/app')).match(/name="bot" value="(\d+)"/)?.[1] ?? relay.db.prepare('SELECT id FROM bots WHERE user_id = (SELECT id FROM users WHERE email = ?)').get(email).id;
    bots[name] = { name, web, botId: String(botId), email, webOnly: true, cli: async () => `${cap(name)} has no bot. Type "login ${name}" and use the web inbox.` };
    return;
  }
  await web('/app/bots', { handle: name });
  const joinCode = (await web('/app')).match(/join with code ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  const home = mkdtempSync(join(tmpdir(), `b2b-sim-${name}-`));
  const cli = async (...args) => {
    try { return (await run(process.execPath, [CLI, ...args], { env: { ...process.env, B2B_HOME: home } })).stdout; }
    catch (e) { return (e.stderr || e.stdout || String(e)).trim(); }
  };
  await cli('enroll', RELAY, joinCode);
  const botId = (await web('/app')).match(/\/app\/bots\/(\d+)/)[1];
  // The pretend doorbell routine.
  const hook = http.createServer(async (req, res) => {
    res.writeHead(200).end('{}');
    // Reads the inbox as records (b2b inbox --json), never by searching the text another bot wrote.
    for (let i = 0; i < 5; i++) {
      const out = await cli('inbox', '--json', '--via', 'doorbell');
      let records;
      try { records = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { break; }
      const items = records.filter((r) => r.type === 'message' || r.type === 'probe');
      for (const m of items.filter((r) => r.type === 'message')) {
        const kind = m.kind === 'ask' ? 'asks' : m.kind === 'reply' ? 'replies' : 'says';
        const links = m.untrusted.links;
        say(`${c.green(`${cap(name)}'s bot`)} wakes up and tells ${cap(name)}: ${c.bold(`${m.from.name} ${kind}`)} ${JSON.stringify(m.untrusted.text)}${links.length ? ` ${c.cyan(links.join(' '))}` : ''}`);
      }
      for (const m of items) await cli('ack', m.receipt);
      if (records.at(-1)?.empty !== false) break;
    }
  });
  await new Promise((ok) => hook.listen(0, '127.0.0.1', ok));
  await web(`/app/bots/${botId}/doorbell`, { url: `http://127.0.0.1:${hook.address().port}/automations/webhook/sim-${name}`, key: `sim-key-${name}-000` });
  // Ring the pretend bot once, like the dashboard's doorbell test, so it shows as ready.
  await web(`/app/bots/${botId}/test`, {});
  bots[name] = { name, web, cli, botId, email };
}

function say(line) { process.stdout.write(`\r\x1b[K${line}\n`); rl?.prompt(true); }

for (const p of PEOPLE) await makePerson(p);
// Everyone starts connected to everyone, as if they had accepted each other's invite links.
if (process.env.SIM_PAIR !== '0') for (let i = 0; i < PEOPLE.length; i++) for (let j = i + 1; j < PEOPLE.length; j++) {
  const a = bots[PEOPLE[i]]; const b = bots[PEOPLE[j]];
  const link = (await a.web('/app/invites', { bot: a.botId })).match(/\/i\/([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  await b.web(`/i/${link}`, { bot: b.botId, alias: cap(a.name) });
}

const HELP = `
${c.bold('Talk as a person')} (their bot does it):
  ${c.cyan('ben send anna "Pasta tonight?" --link https://example.com/r')}
  ${c.cyan('anna reply ben "Yes!"')}       ${c.cyan('tom send ben "Friday?" --ask')}
  ${c.cyan('ben status <msg-id>')}  ${c.cyan('ben contacts')}  ${c.cyan('ben whoami')}   (any CLI command works)
  ${c.cyan('ben code anna')}  safety code; ${c.cyan('anna code ben')} shows the same digits
${c.bold('Owner switches')}:
  ${c.cyan('pause anna')}  ${c.cyan('resume anna')}  ${c.cyan('block anna ben')}  ${c.cyan('unblock anna ben')}
${c.bold('Look at the dashboard')}: ${c.cyan('login anna')} prints a sign-in link for your browser.
  ${c.cyan('quit')}
`;

console.log(`\n${c.yellow(c.bold('Simulator running'))} at ${RELAY}. Nothing here reaches a real bot.`);
console.log(`Pretend people: ${BOT_PEOPLE.map(cap).join(', ')}${WEB_PEOPLE.length ? `, and ${WEB_PEOPLE.map(cap).join(', ')} (no bot, web inbox)` : ''}. ${process.env.SIM_PAIR === '0' ? 'Nobody is connected yet.' : 'Everyone is connected to everyone.'}`);
console.log(HELP);

rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.dim('sim> ') });
rl.prompt();
rl.on('line', async (line) => {
  const args = (line.match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ''));
  const [who, ...rest] = args;
  try {
    if (!who) { /* empty */ }
    else if (who === 'help') console.log(HELP);
    else if (who === 'quit' || who === 'exit') { server.close(); process.exit(0); }
    else if (['pause', 'resume'].includes(who) && bots[rest[0]]) {
      await bots[rest[0]].web('/app/pause', { on: who === 'pause' ? '1' : '0' });
      console.log(`${cap(rest[0])} ${who === 'pause' ? 'paused everything' : 'resumed'}.`);
    } else if (['block', 'unblock'].includes(who) && bots[rest[0]] && bots[rest[1]]) {
      const me = bots[rest[0]];
      const peer = relay.db.prepare('SELECT id FROM bots WHERE handle = ?').get(rest[1]).id;
      await me.web('/app/contacts/block', { bot: me.botId, peer: String(peer), ...(who === 'unblock' ? { unblock: '1' } : {}) });
      console.log(`${cap(rest[0])} ${who}ed ${cap(rest[1])}.`);
    } else if (who === 'login' && bots[rest[0]]) {
      await fetch(`${RELAY}/login`, { method: 'POST', headers: { origin: RELAY, 'content-type': 'application/x-www-form-urlencoded' }, body: `email=${encodeURIComponent(bots[rest[0]].email)}` });
      const row = relay.db.prepare('SELECT id FROM login_codes WHERE email = ? ORDER BY id DESC').get(bots[rest[0]].email);
      // The simulator mints a fresh link directly, since there is no real mailbox.
      const t = `l_sim${randomBytes(12).toString('hex')}`;
      const { createHash } = await import('node:crypto');
      relay.db.prepare('UPDATE login_codes SET link_hash = ?, browser_hash = NULL WHERE id = ?').run(createHash('sha256').update(t).digest('hex'), row.id);
      console.log(`Open in your browser: ${c.cyan(`${RELAY}/login/link?t=${t}`)}`);
    } else if (bots[who]) {
      const out = await bots[who].cli(...rest);
      console.log(out.trim().split('\n').map((l) => `  ${c.dim(l)}`).join('\n'));
    } else console.log(`Unknown. People: ${PEOPLE.join(', ')}. Type "help".`);
  } catch (e) { console.log(`Error: ${e.message}`); }
  rl.prompt();
});
