// Ways to wake a bot that aren't a Grok routine: ChatGPT's MCP Events (OpenAI Dots) and a bot's own
// webhook (Clawdbot). Both post to an address someone else gave us, so every request goes through
// safePost: public HTTPS only, the address we checked is the one we connect to, no redirects.
import { request } from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Loopback, private, link-local, CGNAT, multicast, unspecified, documentation, metadata and ULA ranges.
const blocked = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(net, bits, 'ipv4');
// IPv4-mapped (::ffff:0:0/96) isn't listed: BlockList would then match every plain IPv4 address too.
// Mapped addresses are unwrapped below and checked as IPv4 instead.
const blocked6 = new BlockList();
for (const [net, bits] of [['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked6.addSubnet(net, bits, 'ipv6');
export const isBlockedAddress = (address) => {
  const v = isIP(address);
  if (!v) return true;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) is checked as the IPv4 address it carries.
  const mapped = v === 6 && /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  return v === 4 ? blocked.check(address, 'ipv4') : blocked6.check(address, 'ipv6');
};

export class SafePostError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Checks the shape of an address before we store it. The network check happens again on every request.
export function checkCallbackUrl(raw, { allowLocal = false } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new SafePostError('bad_url', 'the address is not a valid URL'); }
  const local = allowLocal && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.username || u.password) throw new SafePostError('bad_url', 'the address must not contain a username or password');
  if (u.hash) throw new SafePostError('bad_url', 'the address must not contain a #fragment');
  if (!local && u.protocol !== 'https:') throw new SafePostError('bad_url', 'the address must start with https://');
  if (!local && u.port && u.port !== '443') throw new SafePostError('bad_url', 'the address must use the standard HTTPS port');
  if (!local && isIP(u.hostname.replace(/^\[|\]$/g, '')) && isBlockedAddress(u.hostname.replace(/^\[|\]$/g, ''))) throw new SafePostError('blocked', 'the address points to a private network');
  return u;
}

// POST JSON to an outside address. Resolves every address for the name and refuses if any is private,
// then connects to the one it checked (so a second DNS answer can't point somewhere else).
// Returns { status, body } with at most 64 KiB of the response; throws SafePostError for refusals.
export function createSafePost({ allowLocal = false, lookup = dnsLookup, timeoutMs = 10_000, maxResponse = 64 * 1024 } = {}) {
  return function safePost(rawUrl, payload, headers = {}) {
    let u;
    try { u = checkCallbackUrl(rawUrl, { allowLocal }); } catch (e) { return Promise.reject(e); }
    const local = allowLocal && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      const checkedLookup = (host, opts, cb) => {
        lookup(host, { all: true }, (err, list) => {
          if (err) return cb(Object.assign(new SafePostError('never_arrived', 'the address could not be found'), { cause: err }));
          const addrs = (Array.isArray(list) ? list : [{ address: list, family: isIP(list) }]).filter(Boolean);
          if (!addrs.length || addrs.some((a) => isBlockedAddress(a.address))) return cb(new SafePostError('blocked', 'the address points to a private network'));
          const pick = addrs[0];
          if (opts?.all) return cb(null, [pick]);
          return cb(null, pick.address, pick.family);
        });
      };
      const mod = local && u.protocol === 'http:' ? import('node:http').then((m) => m.request) : Promise.resolve(request);
      mod.then((send) => {
        const req = send({
          protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: `${u.pathname}${u.search}`, method: 'POST', servername: isIP(u.hostname) ? undefined : u.hostname,
          ...(local ? {} : { lookup: checkedLookup }),
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'bot2bot-relay', ...headers },
          timeout: timeoutMs,
        }, (res) => {
          const chunks = []; let size = 0;
          res.on('data', (c) => { size += c.length; if (size <= maxResponse) chunks.push(c); else res.destroy(); });
          res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('close', () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        // `timeout` only covers silence; this caps the whole request, so a trickling answer can't hold it open.
        const deadline = setTimeout(() => req.destroy(new SafePostError('timeout', 'the address did not answer in time')), timeoutMs);
        req.on('close', () => clearTimeout(deadline));
        req.on('timeout', () => { req.destroy(new SafePostError('timeout', 'the address did not answer in time')); });
        req.on('error', (e) => {
          if (e instanceof SafePostError) return done(reject, e);
          const code = e?.code;
          done(reject, Object.assign(new SafePostError(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) ? 'never_arrived' : 'unknown', 'the request failed'), { cause: e }));
        });
        req.end(body);
      }, (e) => done(reject, e));
    });
  };
}

// What a wake attempt's HTTP status means for the wake budget, retries and the doorbell itself.
export function outcomeOf(status) {
  if (status >= 200 && status < 300) return 'accepted';
  if (status === 410) return 'gone';
  if (status === 413) return 'too_large';
  if (status === 429) return 'throttled';
  if (status >= 400 && status < 500) return 'refused';
  return 'unknown';
}

// Standard Webhooks (standardwebhooks.com): HMAC-SHA256 over "<id>.<timestamp>.<body>" with the secret's
// bytes (base64 after the whsec_ prefix), sent as "v1,<base64>". Several secrets give several signatures.
export function secretBytes(secret) {
  const s = String(secret || '');
  if (!s.startsWith('whsec_')) return null;
  const raw = s.slice(6);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const b = Buffer.from(raw, 'base64');
  return b.length >= 24 && b.length <= 64 ? b : null;
}
export function signWebhook({ id, timestamp, body, secrets }) {
  return secrets.map((sec) => `v1,${createHmac('sha256', secretBytes(sec)).update(`${id}.${timestamp}.${body}`).digest('base64')}`).join(' ');
}
export function verifyWebhook({ id, timestamp, body, signature, secret }) {
  const want = Buffer.from(signWebhook({ id, timestamp, body, secrets: [secret] }));
  return String(signature || '').split(' ').some((s) => { const got = Buffer.from(s); return got.length === want.length && timingSafeEqual(got, want); });
}
export const newWebhookSecret = () => `whsec_${randomBytes(32).toString('base64')}`;
export const sameText = (a, b) => { const x = Buffer.from(String(a ?? '')), y = Buffer.from(String(b ?? '')); return x.length === y.length && timingSafeEqual(x, y); };
