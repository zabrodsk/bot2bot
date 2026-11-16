// The relay stores only an ephemeral browser public key and an encrypted snapshot.
// A bot shares history only after its owner copies the public-key fingerprint into the command.
import { createPublicKey, createHash } from 'node:crypto';
import { historyPage } from './group-browser-page.mjs';

export const GROUP_VIEW_TTL = 15 * 60_000;
export const GROUP_VIEW_BYTES = 48 * 1024;
const ID = /^ghv_[A-Za-z0-9_-]{24}$/;
const bytes = (s, min, max) => typeof s === 'string' && /^[A-Za-z0-9_-]+$/.test(s) && s.length <= Math.ceil(max * 4 / 3) && Buffer.from(s, 'base64url').length >= min && Buffer.from(s, 'base64url').length <= max && Buffer.from(s, 'base64url').toString('base64url') === s;

export function migrateGroupBrowserHistory(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS group_browser_views (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), bot_id INTEGER NOT NULL REFERENCES bots(id),
    group_id INTEGER NOT NULL REFERENCES chat_groups(id), public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, signature_key TEXT NOT NULL,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, envelope TEXT
  ); CREATE INDEX IF NOT EXISTS group_browser_views_expiry ON group_browser_views(expires_at);`);
}

export function createGroupBrowserHistory({ q, tx, clock, token, groups, HttpError }) {
  const sweep = () => q('DELETE FROM group_browser_views WHERE expires_at <= ?').run(clock());
  function seat(userId, botId, groupId) {
    const b = q('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(Number(botId), userId);
    if (!b || b.removed_at || b.disconnected_at || b.paused_at || !b.box_pub || !b.sign_pub) throw new HttpError(403, 'Choose your connected private-mode bot.');
    const g = groups.resolve(b, String(groupId));
    if (groups.member(g.id, b.id)?.state !== 'joined') throw new HttpError(403, 'Your owner must join this group first.');
    return { b, g };
  }
  const metadata = (r) => ({ id: r.id, bot: r.bot_id, group: r.group_id, public_key: r.public_key, fingerprint: r.fingerprint, signature_key: r.signature_key, expires_at: r.expires_at,
    aad: `b2b-group-view/1|${r.id}|${r.bot_id}|${r.group_id}|${r.fingerprint}|${r.expires_at}` });
  function lookup(id, userId, botId) {
    sweep();
    const r = typeof id === 'string' && ID.test(id) && q('SELECT * FROM group_browser_views WHERE id = ?').get(id);
    if (!r || r.user_id !== userId || (botId != null && r.bot_id !== Number(botId))) throw new HttpError(404, 'This browser request expired or is not yours.');
    const { b } = seat(userId, r.bot_id, r.group_id);
    if (b.sign_pub !== r.signature_key) throw new HttpError(409, 'Your bot changed keys. Open a new browser view.');
    return r;
  }
  function create(userId, botId, groupId, publicKey) {
    const { b, g } = seat(userId, botId, groupId);
    let key, der;
    try {
      if (!bytes(publicKey, 250, 400)) throw new Error();
      key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
      const d = key.asymmetricKeyDetails;
      if (key.asymmetricKeyType !== 'rsa' || d.modulusLength !== 2048 || d.publicExponent !== 65537n) throw new Error();
      der = key.export({ format: 'der', type: 'spki' });
      if (der.toString('base64url') !== publicKey) throw new Error();
    } catch { throw new HttpError(400, 'The browser must supply an RSA-OAEP 2048-bit public key.'); }
    return tx(() => {
      sweep();
      if (q('SELECT count(*) AS n FROM group_browser_views WHERE user_id = ?').get(userId).n >= 3) throw new HttpError(429, 'Close a previous history view or wait 15 minutes.');
      const r = { id: token('ghv_', 18), user_id: userId, bot_id: b.id, group_id: g.id, public_key: publicKey,
        fingerprint: createHash('sha256').update(der).update(`b2b-group-view/1|${b.sign_pub}`).digest('hex'), signature_key: b.sign_pub, created_at: clock(), expires_at: clock() + GROUP_VIEW_TTL };
      q('INSERT INTO group_browser_views (id,user_id,bot_id,group_id,public_key,fingerprint,signature_key,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(r.id, r.user_id, r.bot_id, r.group_id, r.public_key, r.fingerprint, r.signature_key, r.created_at, r.expires_at);
      return metadata(r);
    });
  }
  function read(userId, id) { const r = lookup(id, userId); return { ...metadata(r), envelope: r.envelope ? JSON.parse(r.envelope) : null }; }
  function cancel(userId, id) { const r = lookup(id, userId); q('DELETE FROM group_browser_views WHERE id = ?').run(r.id); return { deleted: true }; }
  function forBot(me, id) {
    const r = lookup(id, me.user_id, me.id);
    if (r.envelope) throw new HttpError(409, 'This browser request was already filled.');
    return { ...metadata(r), name: groups.group(r.group_id).name, messages: groups.browserHistory(me, r.group_id) };
  }
  function upload(me, id, body) {
    return tx(() => {
      const r = lookup(id, me.user_id, me.id);
      if (r.envelope) throw new HttpError(409, 'This browser request was already filled.');
      if (!body || Array.isArray(body) || Object.keys(body).some((k) => !['key', 'iv', 'ciphertext', 'signature'].includes(k)) || !bytes(body.signature, 64, 64) || !bytes(body.key, 256, 256) || !bytes(body.iv, 12, 12) || !bytes(body.ciphertext, 16, GROUP_VIEW_BYTES + 16)) throw new HttpError(400, 'Expected a bounded encrypted browser snapshot.');
      q('UPDATE group_browser_views SET envelope = ? WHERE id = ?').run(JSON.stringify({ key: body.key, iv: body.iv, ciphertext: body.ciphertext, signature: body.signature }), r.id);
      return { ready: true, expires_at: r.expires_at };
    });
  }
  return { create, read, cancel, seat, sweep, page: historyPage, routes: {
    'GET /v1/group-browser/:id': ({ me, params }) => forBot(me, params.id),
    'POST /v1/group-browser/:id': ({ me, params, body }) => upload(me, params.id, body),
  } };
}
