// The attachment sweep owns files/. Folder uploads have separate keys and retention.
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { presign } from './files.mjs';

export const folderChunkBytes = 4 * 1024 ** 2;
export const folderMaxFileBytes = 200 * 1024 ** 2;
export const folderQuotaBytes = 10 * 1024 ** 3;
export const folderKeepMs = 30 * 86400_000;
const sizeOf = (size, i) => Math.min(folderChunkBytes, size - i * folderChunkBytes) + 16;

export function createFolderStorage({ q, clock, fail, dbPath, s3, fetchImpl, publicUrl }) {
  const bucket = s3?.endpoint && s3.bucket && s3.keyId && s3.secret;
  let dataDir;
  const disk = (key) =>
    join((dataDir ??= dbPath === ':memory:' ? mkdtempSync(join(tmpdir(), 'b2b-folder-')) : dirname(dbPath)), key);
  q('CREATE TABLE IF NOT EXISTS folder_secret (id INTEGER PRIMARY KEY, secret BLOB NOT NULL)').run();
  q('INSERT OR IGNORE INTO folder_secret VALUES(1,?)').run(randomBytes(32));
  const secret = q('SELECT secret FROM folder_secret WHERE id=1').get().secret;
  const keyOf = (group, id, i) => `folders/${Number(group)}/${id}/${i}`;
  const mac = (method, key, expires, size) =>
    createHmac('sha256', secret).update([method, key, expires, size].join('|')).digest('hex');
  function urls(method, group, id, size, chunks) {
    return Array.from({ length: chunks }, (_, i) => {
      const key = keyOf(group, id, i),
        bytes = sizeOf(size, i),
        expires = clock() + 900_000;
      if (bucket)
        return presign(s3, {
          method,
          key,
          at: clock(),
          expiresSec: 900,
          size: method === 'PUT' ? bytes : null,
          createOnly: method === 'PUT',
        });
      return `${publicUrl}/folder-chunks/${key}?expires=${expires}&size=${bytes}&sig=${mac(method, key, expires, bytes)}`;
    });
  }
  async function serve(req, res, url) {
    const m = /^\/folder-chunks\/(folders\/(\d+)\/([a-f0-9-]{36})\/(\d+))$/.exec(url.pathname);
    if (!m || bucket || !['GET', 'PUT'].includes(req.method)) fail(404, 'chunk unavailable');
    const [, key, group, id, i] = m,
      expires = Number(url.searchParams.get('expires')),
      size = Number(url.searchParams.get('size'));
    const sig = Buffer.from(url.searchParams.get('sig') ?? '');
    if (
      expires <= clock() ||
      sig.length !== 64 ||
      !timingSafeEqual(sig, Buffer.from(mac(req.method, key, expires, size)))
    )
      fail(403, 'invalid or expired chunk link');
    const lookup = () => q('SELECT * FROM folder_uploads WHERE id=? AND group_id=?').get(id, group);
    const u = lookup();
    if (!u || Number(i) >= u.chunks || size !== sizeOf(u.size, Number(i))) fail(404, 'chunk unavailable');
    const path = disk(key);
    if (req.method === 'GET') {
      if (!u.committed || statSync(path, { throwIfNoEntry: false })?.size !== size) fail(404, 'chunk unavailable');
      const content = readFileSync(path);
      res
        .writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': content.length,
          'cache-control': 'no-store',
        })
        .end(content);
      return;
    }
    if (u.committed || u.expires <= clock() || Number(req.headers['content-length']) !== size)
      fail(400, 'invalid chunk upload');
    const parts = [];
    let length = 0;
    for await (const part of req) {
      length += part.length;
      if (length > size) fail(413, 'chunk too large');
      parts.push(part);
    }
    if (length !== size || !lookup() || u.expires <= clock()) fail(400, 'incomplete or expired upload');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = path + '.' + randomUUID();
    try {
      writeFileSync(tmp, Buffer.concat(parts), { mode: 0o600, flag: 'wx' });
      linkSync(tmp, path);
    } catch (e) {
      if (e.code === 'EEXIST') fail(412, 'chunk already uploaded');
      throw e;
    } finally {
      rmSync(tmp, { force: true });
    }
    res.writeHead(204).end();
  }
  async function verify(u) {
    for (let i = 0; i < u.chunks; i++) {
      const key = keyOf(u.group_id, u.id, i);
      let bytes;
      if (bucket) {
        const r = await fetchImpl(presign(s3, { method: 'HEAD', key, expiresSec: 60, at: clock() }), {
          method: 'HEAD',
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok && r.headers.has('content-length')) bytes = Number(r.headers.get('content-length'));
      } else bytes = statSync(disk(key), { throwIfNoEntry: false })?.size;
      if (bytes !== sizeOf(u.size, i)) fail(409, 'upload is missing a complete chunk');
    }
  }
  let busy = false;
  async function collect() {
    if (busy) return;
    busy = true;
    try {
      for (const u of q('SELECT * FROM folder_garbage').all()) {
        if (bucket) {
          for (let i = 0; i < u.chunks; i++) {
            const url = presign(s3, { method: 'DELETE', key: keyOf(u.group_id, u.id, i), at: clock(), expiresSec: 60 });
            const r = await fetchImpl(url, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
            if (!r.ok && r.status !== 404) throw new Error('folder object cleanup failed');
          }
          // Repeat after outstanding signed PUTs expire, in case one recreated a deleted key.
          if (clock() < u.expires + 60_000) continue;
        } else rmSync(dirname(disk(keyOf(u.group_id, u.id, 0))), { recursive: true, force: true });
        q('DELETE FROM folder_garbage WHERE id=?').run(u.id);
      }
    } finally {
      busy = false;
    }
  }
  return { serve, verify, urls, collect };
}
