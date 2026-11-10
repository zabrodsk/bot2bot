import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChatDownload } from '../chat-download.mjs';
import { listen } from './helpers.mjs';

test('chat downloads reject private addresses, credentials, non-HTTPS URLs and DNS rebinding', async () => {
  const download = createChatDownload();
  for (const url of ['http://files.example/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://169.254.169.254/latest/meta-data', 'https://user:pass@files.example/a', 'https://files.example:8443/a', 'file:///etc/passwd']) await assert.rejects(download(url, 100));
  for (const address of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '::1', '::ffff:127.0.0.1']) {
    const dns = createChatDownload({ lookup: (_host, _opts, cb) => cb(null, [{ address, family: address.includes(':') ? 6 : 4 }]) });
    await assert.rejects(dns('https://files.example/a', 100), /could not be downloaded/);
  }
});

test('chat downloads refuse redirects, cap chunked bodies and time out a stalled source', async (t) => {
  let followed = false;
  const { s, url } = await listen((req, res) => {
    if (req.url === '/redirect') return res.writeHead(302, { location: `${url}/target` }).end();
    if (req.url === '/target') { followed = true; return res.end('secret'); }
    if (req.url === '/stall') return;
    res.writeHead(200); res.write('12345'); res.end('67890');
  });
  t.after(() => { s.closeAllConnections(); s.close(); });
  const download = createChatDownload({ allowLocal: true, timeoutMs: 150 });
  await assert.rejects(download(`${url}/redirect`, 100), /link expired/);
  assert.equal(followed, false);
  await assert.rejects(download(`${url}/chunked`, 5), /bigger than your file size limit/);
  await assert.rejects(download(`${url}/stall`, 100), /could not be downloaded/);
});
