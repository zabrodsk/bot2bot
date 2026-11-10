// Download a chat attachment without letting its URL reach the relay's private network.
// Resolve once, connect to that checked address, refuse redirects, and cap time and bytes.
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup as dnsLookup } from 'node:dns';
import { isIP } from 'node:net';
import { checkCallbackUrl, isBlockedAddress } from './doorbells.mjs';

export function createChatDownload({ allowLocal = false, lookup = dnsLookup, timeoutMs = 30_000 } = {}) {
  return async function download(rawUrl, maxBytes) {
    const u = checkCallbackUrl(rawUrl, { allowLocal });
    const local = allowLocal && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
    if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) throw new Error('the file address must use HTTPS');
    return new Promise((resolve, reject) => {
      const checkedLookup = (host, opts, cb) => lookup(host, { all: true }, (err, addresses) => {
        if (err || !addresses?.length) return cb(new Error('the file address could not be found'));
        if (addresses.some((a) => isBlockedAddress(a.address))) return cb(new Error('the file address points to a private network'));
        const a = addresses[0];
        return opts?.all ? cb(null, [a]) : cb(null, a.address, a.family);
      });
      const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
      const req = send({
        protocol: u.protocol, hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined,
        path: `${u.pathname}${u.search}`, method: 'GET', agent: false,
        servername: isIP(u.hostname) ? undefined : u.hostname,
        ...(local ? {} : { lookup: checkedLookup }),
        headers: { 'user-agent': 'bot2bot-relay', 'accept-encoding': 'identity' },
      }, (res) => {
        const fail = (message) => { reject(new Error(message)); res.destroy(); };
        if (res.statusCode !== 200) return fail('the file link expired or could not be downloaded. Attach the file again and retry');
        if (Number(res.headers['content-length']) > maxBytes) return fail('the file is bigger than your file size limit');
        const chunks = []; let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) return fail('the file is bigger than your file size limit');
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', () => reject(new Error('the file download was interrupted. Attach the file again and retry')));
        res.on('aborted', () => reject(new Error('the file download was interrupted. Attach the file again and retry')));
      });
      const timer = setTimeout(() => req.destroy(new Error('the file download timed out')), timeoutMs);
      req.on('close', () => clearTimeout(timer));
      // Do not expose signed URLs or network details in tool results.
      req.on('error', () => reject(new Error('the file could not be downloaded. Use a public HTTPS file link or attach the file again')));
      req.end();
    });
  };
}
