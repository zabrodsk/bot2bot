#!/usr/bin/env node
// bot2bot-lite relay. It pairs bots and holds sealed messages until the other bot picks them up.
// It never sees a key that could open a message. Zero dependencies, Node 20 or newer.
//
// Storage is one JSON file, rewritten after every change. That is fine for a few hundred bots.
// Run one relay process per data file.

import { createServer } from 'node:http';
import { createHash, createPublicKey, verify, randomUUID, randomInt } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LIMITS = {
  body: 64 * 1024, // bytes per request
  sealed: 24 * 1024, // characters per sealed message
  inbox: 200, // messages waiting per bot
  batch: 50, // messages per inbox fetch
  contacts: 100, // contacts per bot
  openCodes: 3, // unused pairing codes per bot
  perMinute: 120, // signed requests per bot per minute
  skew: 60_000, // how far a request timestamp may be from the relay clock (ms)
  codeTtl: 10 * 60_000, // pairing codes last 10 minutes
  messageTtl: 7 * 24 * 3600_000, // unread messages are dropped after 7 days
  bots: 10_000, // bots per relay
};

const ID = /^[A-Za-z0-9_-]{43}$/; // a bot id is its raw ed25519 public key, base64url
const NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'; // no 0/O, 1/I/L or U, easy to read aloud

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const keyFromId = (id) => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: id }, format: 'jwk' });
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

export function createRelay({ dataFile = null, limits = {} } = {}) {
  const L = { ...LIMITS, ...limits };
  const db = { bots: {}, contacts: {}, codes: {}, inbox: {} };
  if (dataFile && existsSync(dataFile)) Object.assign(db, JSON.parse(readFileSync(dataFile, 'utf8')));
  const seen = new Map(); // request signature -> timestamp, so a captured request can't be sent twice
  const hits = new Map(); // bot id -> { minute, n }

  function save() {
    if (!dataFile) return;
    writeFileSync(dataFile + '.tmp', JSON.stringify(db));
    renameSync(dataFile + '.tmp', dataFile);
  }

  function sweep() {
    const now = Date.now();
    for (const [code, c] of Object.entries(db.codes)) if (c.exp < now) delete db.codes[code];
    for (const [id, list] of Object.entries(db.inbox)) db.inbox[id] = list.filter((m) => now - m.at < L.messageTtl);
    for (const [sig, ts] of seen) if (Math.abs(now - ts) > 2 * L.skew) seen.delete(sig);
    for (const [key, h] of hits) if (h.minute < Math.floor(now / 60_000)) hits.delete(key);
    save();
  }
  const timer = setInterval(sweep, 60_000);
  timer.unref();

  function tooFast(key) {
    const minute = Math.floor(Date.now() / 60_000);
    const h = hits.get(key);
    if (h && h.minute === minute) return ++h.n > L.perMinute;
    hits.set(key, { minute, n: 1 });
    return false;
  }

  // Every request is signed: ed25519 over method, path, timestamp, nonce and the body's sha256.
  function authenticate(req, path, raw) {
    const id = String(req.headers['x-bot'] || '');
    const ts = Number(req.headers['x-ts']);
    const nonce = String(req.headers['x-nonce'] || '');
    const sig = String(req.headers['x-sig'] || '');
    if (!ID.test(id) || !sig || !nonce || nonce.length > 64) fail(401, 'missing or malformed signature headers');
    if (!Number.isSafeInteger(ts) || Math.abs(Date.now() - ts) > L.skew) fail(401, 'stale request, check your clock');
    const signed = `${req.method}\n${path}\n${ts}\n${nonce}\n${sha256(raw)}`;
    let ok = false;
    try { ok = verify(null, Buffer.from(signed), keyFromId(id), Buffer.from(sig, 'base64url')); } catch {}
    if (!ok) fail(401, 'bad signature');
    if (seen.has(sig)) fail(401, 'replayed request');
    seen.set(sig, ts);
    if (tooFast(id)) fail(429, 'too many requests, slow down');
    return id;
  }

  const card = (id) => ({ id, name: db.bots[id].name, box: db.bots[id].box, boxSig: db.bots[id].boxSig });
  const contactsOf = (id) => (db.contacts[id] ||= []);

  const routes = {
    'POST /v1/register'(me, { name, box, boxSig }) {
      if (typeof name !== 'string' || !NAME.test(name)) fail(400, 'name: 1-32 of a-z 0-9 _ -, starting with a letter or digit');
      if (typeof box !== 'string' || !ID.test(box) || typeof boxSig !== 'string' || boxSig.length > 100) fail(400, 'bad keys');
      if (!db.bots[me] && Object.keys(db.bots).length >= L.bots) fail(503, 'this relay is full');
      db.bots[me] = { name, box, boxSig, at: db.bots[me]?.at || Date.now() };
      return { ok: true };
    },
    'POST /v1/pair'(me) {
      if (Object.values(db.codes).filter((c) => c.from === me && c.exp > Date.now()).length >= L.openCodes) {
        fail(429, 'you already have open pairing codes, wait for them to expire');
      }
      let code;
      do code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
      while (db.codes[code]);
      db.codes[code] = { from: me, exp: Date.now() + L.codeTtl };
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expires: db.codes[code].exp };
    },
    'POST /v1/pair/redeem'(me, { code }) {
      const key = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const c = db.codes[key];
      if (!c || c.exp < Date.now() || !db.bots[c.from]) fail(404, 'unknown or expired code');
      if (c.from === me) fail(400, 'that is your own code, give it to the other bot');
      const [mine, theirs] = [contactsOf(me), contactsOf(c.from)];
      if (!mine.includes(c.from) && (mine.length >= L.contacts || theirs.length >= L.contacts)) fail(409, 'too many contacts');
      delete db.codes[key];
      if (!mine.includes(c.from)) mine.push(c.from);
      if (!theirs.includes(me)) theirs.push(me);
      return { contact: card(c.from) };
    },
    'GET /v1/contacts'(me) {
      return { contacts: contactsOf(me).filter((id) => db.bots[id]).map(card) };
    },
    'POST /v1/send'(me, { to, sealed }) {
      if (!contactsOf(me).includes(to)) fail(403, 'you can only send to paired contacts');
      if (typeof sealed !== 'string' || sealed.length > L.sealed) fail(413, 'message too big');
      const inbox = (db.inbox[to] ||= []);
      if (inbox.length >= L.inbox) fail(429, 'their inbox is full, try later');
      const message = { id: randomUUID(), from: me, at: Date.now(), sealed };
      inbox.push(message);
      return { id: message.id };
    },
    'GET /v1/inbox'(me) {
      const inbox = db.inbox[me] || [];
      return { messages: inbox.slice(0, L.batch), more: inbox.length > L.batch };
    },
    'POST /v1/ack'(me, { ids }) {
      const done = new Set(Array.isArray(ids) ? ids : []);
      db.inbox[me] = (db.inbox[me] || []).filter((m) => !done.has(m.id));
      return { ok: true };
    },
  };

  const server = createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const path = new URL(req.url, 'http://relay').pathname;
      if (req.method === 'GET' && (path === '/' || path === '/healthz')) return reply(200, { ok: true, name: 'bot2bot-lite relay' });
      const route = Object.hasOwn(routes, `${req.method} ${path}`) && routes[`${req.method} ${path}`];
      if (!route) fail(404, 'not found');
      const raw = await readBody(req, L.body);
      const me = authenticate(req, path, raw);
      if (path !== '/v1/register' && !db.bots[me]) fail(401, 'register first (lite.mjs init)');
      let body = {};
      if (raw.length) try { body = JSON.parse(raw); } catch { fail(400, 'body must be JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'body must be a JSON object');
      const out = route(me, body);
      if (req.method === 'POST') save();
      reply(200, out);
    } catch (err) {
      if (!err.status) console.error(err);
      reply(err.status || 500, { error: err.status ? err.message : 'relay error' });
    }
  });
  server.on('close', () => clearInterval(timer));
  return server;
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= max) return chunks.push(chunk);
      req.removeAllListeners('data');
      req.resume();
      reject(Object.assign(new Error('request too big'), { status: 413 }));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const dataFile = process.env.DATA_FILE || 'relay-data.json';
  createRelay({ dataFile }).listen(port, () => console.log(`bot2bot-lite relay on port ${port}, data in ${dataFile}`));
}
