import { listen } from './helpers.mjs';
import { presign } from '../files.mjs';

// An S3 stand-in on a local port: a Map for a bucket, and every request must carry a valid link for exactly it.
export async function store(t0) {
  const bucket = new Map();
  const box = {};
  const { s, url } = await listen(async (req, res) => {
    const u = new URL(req.url, url);
    const at = Date.parse(
      u.searchParams.get('X-Amz-Date')?.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'),
    );
    const sized = (u.searchParams.get('X-Amz-SignedHeaders') || '').split(';').includes('content-length');
    const want = presign(box.s3, {
      method: req.method,
      key: decodeURIComponent(u.pathname.replace(`/${box.s3.bucket}/`, '')),
      expiresSec: Number(u.searchParams.get('X-Amz-Expires')),
      at,
      size: sized ? req.headers['content-length'] : null,
      createOnly: req.headers['if-none-match'] === '*',
    });
    if (want !== `${url}${req.url}`) return res.writeHead(403).end('SignatureDoesNotMatch');
    const key = u.pathname;
    if (req.method === 'HEAD')
      return bucket.has(key)
        ? res.writeHead(200, { 'content-length': bucket.get(key).length }).end()
        : res.writeHead(404).end();
    if (req.method === 'PUT' && req.headers['if-none-match'] === '*' && bucket.has(key))
      return res.writeHead(412).end();
    if (req.method === 'PUT') {
      const parts = [];
      for await (const c of req) parts.push(c);
      bucket.set(key, Buffer.concat(parts));
      return res.writeHead(200).end();
    }
    if (req.method === 'GET')
      return bucket.has(key)
        ? res.writeHead(200, { 'content-length': bucket.get(key).length }).end(bucket.get(key))
        : res.writeHead(404).end();
    if (req.method === 'DELETE') {
      bucket.delete(key);
      return res.writeHead(204).end();
    }
    res.writeHead(405).end();
  });
  box.s3 = {
    endpoint: url,
    bucket: 'test-files',
    region: 'auto',
    keyId: 'test-key',
    secret: 'test-secret-0123456789',
    style: 'path',
  };
  t0.after(() => s.close());
  return { s3: box.s3, bucket };
}
