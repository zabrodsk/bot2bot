// Private-mode files: a bot attaches files to an end-to-end encrypted message. The bot encrypts each file with a
// fresh key and uploads only the encrypted bytes to an S3-compatible bucket (on bot2bot.link, a Railway bucket in
// Amsterdam). The key, name and hash travel inside the sealed message, so neither the relay nor the bucket can open
// a file. The relay only signs short-lived upload and download links, checks who may fetch what, and deletes
// each file once every bot it went to says it saved it (after 7 days at the latest).
// Chat handoffs are separate: the relay downloads the original and encrypts the stored blob. Their
// metadata is server-readable until delivery/expiry, so these transfers are not end-to-end encrypted.
// Off unless the bucket is configured (FILES_S3_*). Then it's on for everyone (or only the emails on FILES_ALPHA), and
// each owner can turn it off on their Settings page; files only flow between owners who have it on.
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { createChatDownload } from './chat-download.mjs';

export const FILE_ID_RE = /^fil_[A-Za-z0-9_-]{16,40}$/;
const MB = 1024 * 1024;
export const FILE_LIMITS = {
  fileMaxFree: 10 * MB,      // one file on the free plan (what the owner picked, before encryption)
  filesPerDayFree: 10,       // files a person's bots can send in a UTC day on the free plan
  fileMaxPaid: 50 * MB,
  filesPerDayPaid: 100,
  filesPerMessage: 5,
  fileOverhead: 64,          // encryption adds a few bytes to each file
  fileTtlMs: 7 * 86_400_000, // a file is deleted once every bot it went to saved it, or at the latest 7 days after it was uploaded
  fileLinkMs: 15 * 60_000,   // upload and download links work this long
  fileMinTool: '0.22.0',     // the first tool that can open files
  chatFileMinTool: '0.22.10', // plain chat handoffs carry their file metadata separately from sealed messages
  fileMaxPromo: 20 * MB,     // a limited-time deal: one file on the free plan until filePromoUntil (FILES_PROMO_UNTIL)
  filePromoUntil: 0,
};

export function migrateFiles(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY, bot_id INTEGER NOT NULL REFERENCES bots(id), user_id INTEGER,
      size INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS files_user_day ON files (user_id, created_at);
    CREATE INDEX IF NOT EXISTS files_expiry ON files (deleted_at, expires_at);
    CREATE TABLE IF NOT EXISTS file_links (
      file_id TEXT NOT NULL REFERENCES files(id), message_id TEXT NOT NULL, PRIMARY KEY (file_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS file_links_message ON file_links (message_id);
  `);
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'files_on')) db.exec('ALTER TABLE users ADD COLUMN files_on INTEGER NOT NULL DEFAULT 0');
  // Files are on unless the owner turned them off (files_on was the alpha's opt-in, no longer read).
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'files_off')) db.exec('ALTER TABLE users ADD COLUMN files_off INTEGER NOT NULL DEFAULT 0');
  // When the bot a message went to said it saved the file.
  if (!db.prepare('PRAGMA table_info(file_links)').all().some((c) => c.name === 'received_at')) db.exec('ALTER TABLE file_links ADD COLUMN received_at INTEGER');
  // Chat files pass through the relay, unlike private-mode files. Only chats have server-readable metadata.
  if (!db.prepare('PRAGMA table_info(files)').all().some((c) => c.name === 'chat_meta')) db.exec('ALTER TABLE files ADD COLUMN chat_meta TEXT');
}

// A presigned S3 link (AWS Signature Version 4, query string): anyone holding it can do this one thing to this
// one object until it expires. An upload link also fixes the size, so only that many bytes go in.
const enc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (k, v) => createHmac('sha256', k).update(v).digest();
export function presign({ endpoint, bucket, region = 'auto', keyId, secret, style = 'virtual-host' }, { method, key, expiresSec, at = Date.now(), size = null }) {
  const u = new URL(endpoint);
  const host = style === 'path' ? u.host : `${bucket}.${u.host}`;
  const path = style === 'path' ? `/${bucket}/${key.split('/').map(enc3986).join('/')}` : `/${key.split('/').map(enc3986).join('/')}`;
  const amzDate = new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`;
  const headers = [...(size != null ? [['content-length', String(size)]] : []), ['host', host]];
  const signed = headers.map(([k]) => k).join(';');
  const query = Object.entries({ 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${keyId}/${scope}`, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(expiresSec), 'X-Amz-SignedHeaders': signed })
    .sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${enc3986(k)}=${enc3986(v)}`).join('&');
  const canonical = [method, path, query, headers.map(([k, v]) => `${k}:${v}\n`).join(''), signed, 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const sig = createHmac('sha256', hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), 's3'), 'aws4_request')).update(toSign).digest('hex');
  return `${u.protocol}//${host}${path}?${query}&X-Amz-Signature=${sig}`;
}

export function createFiles({ q, clock, L, HttpError, log, hosted, coverage, newerVersion, s3 = {}, alpha = [], promoUntil: promoEnd = 0, fetchImpl = fetch, sealKey = (s) => s, openKey = (s) => s, allowLocal = false, needTool = () => false }) {
  const configured = !!(s3.endpoint && s3.bucket && s3.keyId && s3.secret);
  const emails = new Set((Array.isArray(alpha) ? alpha : []).map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const userOf = (userOrBot) => {
    if (!userOrBot) return null;
    if ('email' in userOrBot) return userOrBot;
    return userOrBot.user_id ? q('SELECT * FROM users WHERE id = ?').get(userOrBot.user_id) : null;
  };
  // Who has files: everyone (FILES_ALPHA unset or 1) or the listed emails.
  const inAlpha = (userOrBot) => {
    const u = userOf(userOrBot);
    return configured && !!u && (alpha === true || emails.has(String(u.email).toLowerCase()));
  };
  const isOn = (userOrBot) => { const u = userOf(userOrBot); return inAlpha(u) && !u.files_off; };
  // The free plan has a small allowance; paid plans (and self-hosted relays) a bigger one.
  function plan(user, t = clock()) {
    const state = hosted ? coverage(user, t).state : 'self_hosted';
    const free = state === 'free';
    // The limited-time deal lifts the free plan's file size until it ends.
    const ends = promoEnd || L.filePromoUntil;
    const promoUntil = free && ends > t ? ends : null;
    const maxBytes = free ? (promoUntil ? Math.max(L.fileMaxFree, L.fileMaxPromo) : L.fileMaxFree) : L.fileMaxPaid;
    const perDay = free ? L.filesPerDayFree : L.filesPerDayPaid;
    const d = new Date(t);
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const used = user ? q('SELECT count(*) AS n FROM files WHERE user_id = ? AND created_at >= ?').get(user.id, start).n : 0;
    return { free, maxBytes, usualBytes: free ? L.fileMaxFree : L.fileMaxPaid, promoUntil, perDay, used, left: Math.max(0, perDay - used) };
  }
  const METHOD = { put: 'PUT', get: 'GET', del: 'DELETE' };
  const link = (op, id, size = null) => {
    const at = clock();
    return { url: presign(s3, { method: METHOD[op], key: `files/${id}`, expiresSec: Math.round(L.fileLinkMs / 1000), at, size }), expires_at: new Date(at + L.fileLinkMs).toISOString() };
  };
  const notOn = () => new HttpError(403, 'your owner turned off sending files. They can turn it back on in their bot2bot Settings');
  const isChat = (b) => b?.platform === 'sender' && b.vendor === 'connector';
  const downloadChat = createChatDownload({ allowLocal });

  function checkChat(me, recipient, count) {
    if (!isChat(me) || !me.user_id || recipient.user_id !== me.user_id) throw new HttpError(403, 'chat files only go to your own bots');
    if (!isOn(me)) throw notOn();
    if (me.paused_at) throw new HttpError(403, 'your owner paused bot2bot');
    const why = whyNot(recipient.id, me.id);
    if (why) throw new HttpError(403, why);
    if (needTool(recipient.id, L.chatFileMinTool, { waiter: me.id, what: 'chat_files' })) throw new HttpError(400, `@${recipient.handle} needs bot2bot ${L.chatFileMinTool} or newer to save files from chats. bot2bot just asked it to update. If it doesn't, ask it to run: node ~/bin/b2b.mjs update`);
    const p = plan(userOf(me));
    if (count > p.left) throw new HttpError(429, `you have ${p.left} files left today. The allowance resets at midnight UTC`);
    return p;
  }

  // Unlike private-mode files, the original reaches this process. Encrypt the stored blob, retain
  // the metadata only until delivery/expiry, and never describe the chat path as end-to-end encrypted.
  async function uploadChat(me, recipient, refs) {
    checkChat(me, recipient, refs.length);
    const out = [];
    try {
      for (const ref of refs) {
        const p = checkChat(me, recipient, refs.length - out.length);
        // A file the chat wrote out arrives as bytes already; the rest are fetched from the chat app's (or a public) link.
        const plain = ref.plain ?? await downloadChat(ref.download_url, p.maxBytes);
        if (plain.length > p.maxBytes) throw new HttpError(413, 'the file is bigger than your file size limit');
        const key = randomBytes(32), iv = randomBytes(12);
        const c = createCipheriv('aes-256-gcm', key, iv);
        const blob = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
        const r = routes['POST /v1/files']({ me, body: { size: blob.length } });
        const meta = { id: r.id, name: (ref.file_name || 'attachment').split(/[\\/]/).pop().slice(0, 200), size: plain.length,
          key: key.toString('base64url'), iv: iv.toString('base64url'), sha256: createHash('sha256').update(plain).digest('hex') };
        out.push(meta);
        const res = await fetchImpl(r.upload_url, { method: 'PUT', body: blob, headers: { 'content-type': 'application/octet-stream' }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new HttpError(502, 'the attachment could not be stored. Try again');
        q('UPDATE files SET chat_meta = ? WHERE id = ?').run(sealKey(JSON.stringify(meta)), r.id);
      }
      return out;
    } catch (e) {
      await discardChat(out.map((f) => f.id));
      throw e;
    }
  }

  async function discardChat(ids) {
    for (const id of ids) q('UPDATE files SET expires_at = ?, chat_meta = NULL WHERE id = ? AND NOT EXISTS (SELECT 1 FROM file_links WHERE file_id = files.id)').run(clock(), id);
    await sweep();
  }
  function chatFor(messageId) {
    const list = q(`SELECT f.chat_meta FROM files f JOIN file_links l ON l.file_id = f.id JOIN messages m ON m.id = l.message_id
      WHERE l.message_id = ? AND m.sealed IS NULL AND m.body_purged_at IS NULL AND m.status != 'dropped' AND f.chat_meta IS NOT NULL AND f.deleted_at IS NULL AND f.expires_at > ?`)
      .all(messageId, clock()).map((f) => JSON.parse(openKey(f.chat_meta)));
    return list.length ? list : undefined;
  }

  // Before a message goes out: the files must be this bot's own, still kept, and every recipient must be able to open them.
  function check(me, recipientBots, ids, { sealed }) {
    if (ids == null) return [];
    if (!Array.isArray(ids) || !ids.length) throw new HttpError(400, 'files must be a list of file ids');
    if (!isOn(me)) throw notOn();
    if (!sealed && !isChat(me)) throw new HttpError(400, 'files only go in end-to-end encrypted messages');
    const list = [...new Set(ids.map(String))];
    if (list.length > L.filesPerMessage) throw new HttpError(413, `at most ${L.filesPerMessage} files in one message`);
    for (const id of list) {
      const f = FILE_ID_RE.test(id) ? q('SELECT * FROM files WHERE id = ?').get(id) : null;
      if (!f || f.bot_id !== me.id || f.deleted_at || f.expires_at <= clock()) throw new HttpError(400, `${id.slice(0, 48)} isn't a file this bot uploaded (or it expired)`);
      if (!sealed && !f.chat_meta) throw new HttpError(400, 'this is not a chat attachment');
    }
    for (const r of recipientBots) {
      const why = whyNot(r, me.id); if (why) throw new HttpError(403, why);
      if (!sealed) checkChat(me, q('SELECT * FROM bots WHERE id = ?').get(r), 0);
    }
    return list;
  }
  // Why this bot can't get files (null when it can). With `waiter`, the bot that was refused: when it's only the tool
  // that's too old, the bot is asked to update, and the waiter hears once it has.
  function whyNot(botId, waiter = null) {
    const b = q('SELECT handle, tool_version, box_pub, user_id FROM bots WHERE id = ?').get(botId);
    if (!b?.box_pub) return `@${b?.handle ?? 'them'} can't get files: their bot doesn't use end-to-end encryption`;
    if (!isOn(b)) return `@${b.handle} can't get files: their owner turned files off`;
    if (!b.tool_version || newerVersion(L.fileMinTool, b.tool_version)) {
      if (!waiter || !needTool(botId, L.fileMinTool, { waiter, what: 'files' })) return `@${b.handle}'s bot needs a newer bot2bot tool before it can open files. It updates itself the next time it checks messages`;
      return `@${b.handle}'s bot needs a newer bot2bot tool before it can open files. bot2bot just asked it to update, and your bot hears as soon as it has. Everything without a file still goes through now`;
    }
    return null;
  }
  // A file is done once no one it went to still needs it: each bot saved it, or can't fetch it any more (the message
  // was withdrawn or its text deleted). Done files are deleted at once instead of after 7 days.
  const UNDONE = `SELECT 1 FROM file_links l JOIN messages m ON m.id = l.message_id
    WHERE l.file_id = files.id AND l.received_at IS NULL AND m.body_purged_at IS NULL AND m.status != 'dropped'`;
  const settle = (t, id = null) => q(`UPDATE files SET expires_at = ? WHERE deleted_at IS NULL AND expires_at > ?${id ? ' AND id = ?' : ''}
    AND EXISTS (SELECT 1 FROM file_links l WHERE l.file_id = files.id) AND NOT EXISTS (${UNDONE})`).run(t, t, ...(id ? [id] : [])).changes;
  const attach = (ids, messageId) => { for (const id of ids) q('INSERT OR IGNORE INTO file_links (file_id, message_id) VALUES (?, ?)').run(id, messageId); };

  const routes = {
    // An upload link for one encrypted file of this many bytes.
    'POST /v1/files': ({ me, body }) => {
      const user = userOf(me);
      if (!isOn(user)) throw notOn();
      if (me.paused_at) throw new HttpError(403, 'your owner paused bot2bot. Nothing can be sent until they resume it on their dashboard.');
      const size = Number(body?.size);
      const p = plan(user);
      if (!Number.isInteger(size) || size < 1) throw new HttpError(400, 'size is the encrypted file\'s length in bytes');
      if (size > p.maxBytes + L.fileOverhead) throw new HttpError(413, `files can be up to ${Math.round(p.maxBytes / MB)} MB${p.free ? ' on the free plan. A paid plan is coming soon' : ''}`);
      if (p.left <= 0) throw new HttpError(429, `your ${p.perDay} files for today are used up. They come back at midnight UTC${p.free ? '. A paid plan is coming soon' : ''}`);
      const t = clock();
      const id = `fil_${randomBytes(15).toString('base64url')}`;
      q('INSERT INTO files (id, bot_id, user_id, size, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, me.id, user?.id ?? null, size, t, t + L.fileTtlMs);
      log(me.id, 'file_upload', { file: id, size });
      const up = link('put', id, size);
      return { id, size, upload_url: up.url, upload_expires_at: up.expires_at, deleted_at: new Date(t + L.fileTtlMs).toISOString(), left_today: p.left - 1 };
    },
    // A download link, for the bot that uploaded it or one that received it in a message that's still kept.
    'GET /v1/files/:id': ({ me, params }) => {
      const f = FILE_ID_RE.test(params.id) ? q('SELECT * FROM files WHERE id = ?').get(params.id) : null;
      const mine = f && f.bot_id === me.id;
      const sent = (live) => q(`SELECT 1 FROM file_links l JOIN messages m ON m.id = l.message_id
        WHERE l.file_id = ? AND m.to_bot = ?${live ? " AND m.body_purged_at IS NULL AND m.status != 'dropped'" : ''}`).get(f.id, me.id);
      if (!f || (!mine && !sent(false))) throw new HttpError(404, 'no such file');
      if (f.deleted_at || f.expires_at <= clock()) throw new HttpError(410, 'this file was deleted (files go once they arrive, or after 7 days)');
      if (!mine && !sent(true)) throw new HttpError(404, 'no such file');
      const down = link('get', f.id);
      return { id: f.id, size: f.size, download_url: down.url, download_expires_at: down.expires_at };
    },
    // The bot it was sent to saved it (downloaded, decrypted and checked). Once every bot it went to has, it's deleted.
    'POST /v1/files/:id/received': ({ me, params }) => {
      const f = FILE_ID_RE.test(params.id) ? q('SELECT id FROM files WHERE id = ?').get(params.id) : null;
      const t = clock();
      const n = f ? q('UPDATE file_links SET received_at = ? WHERE file_id = ? AND received_at IS NULL AND message_id IN (SELECT id FROM messages WHERE to_bot = ?)').run(t, f.id, me.id).changes : 0;
      if (!f || (!n && !q('SELECT 1 FROM file_links l JOIN messages m ON m.id = l.message_id WHERE l.file_id = ? AND m.to_bot = ?').get(f.id, me.id))) throw new HttpError(404, 'no such file');
      const done = settle(t, f.id) > 0;
      if (done) sweep(t).catch(() => {});
      return { id: f.id, received: true, deleted: done };
    },
  };

  // Deletes expired files from the bucket (a few at a time, again at the next sweep if the bucket can't be reached).
  let busy = false;
  async function sweep(t = clock()) {
    if (!configured || busy) return 0;
    busy = true;
    let n = 0;
    try {
      settle(t);
      // Even when the bucket is unavailable, an expired chat file must lose its decryption metadata.
      q('UPDATE files SET chat_meta = NULL WHERE expires_at <= ? AND chat_meta IS NOT NULL').run(t);
      for (const f of q('SELECT id FROM files WHERE deleted_at IS NULL AND expires_at <= ? ORDER BY expires_at LIMIT 50').all(t)) {
        const del = link('del', f.id);
        const r = await fetchImpl(del.url, { method: 'DELETE', signal: AbortSignal.timeout(10_000) }).catch(() => null);
        if (!r || !(r.ok || r.status === 404)) break;
        q('UPDATE files SET deleted_at = ?, chat_meta = NULL WHERE id = ?').run(t, f.id);
        n++;
      }
    } finally { busy = false; }
    if (n) log(null, 'files_deleted', { count: n });
    // A month later, even the record that a file existed goes.
    q('DELETE FROM file_links WHERE file_id IN (SELECT id FROM files WHERE deleted_at < ?)').run(t - 30 * 86_400_000);
    q('DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(t - 30 * 86_400_000);
    return n;
  }
  // Deleting an account (or a bot) deletes its files at the next sweep.
  const forgetBots = (ids) => { for (const id of ids) q('UPDATE files SET expires_at = min(expires_at, ?) WHERE bot_id = ? AND deleted_at IS NULL').run(clock(), id); };
  // The owner's Settings page.
  function setOn(user, on) {
    if (!inAlpha(user)) throw new HttpError(404, 'Page not found');
    q('UPDATE users SET files_off = ? WHERE id = ?').run(on ? 0 : 1, user.id);
  }
  // What the bot hears with its inbox: on or off, and how much it may send today.
  function statusFor(me) {
    if (!isOn(me)) return null;
    const p = plan(userOf(me));
    return { on: true, max_mb: Math.round(p.maxBytes / MB), per_day: p.perDay, left_today: p.left, free_plan: p.free, ...(p.promoUntil ? { deal_until: new Date(p.promoUntil).toISOString() } : {}) };
  }
  return { configured, inAlpha, isOn, whyNot, plan, check, attach, routes, sweep, forgetBots, setOn, statusFor, uploadChat, discardChat, chatFor, MB };
}
