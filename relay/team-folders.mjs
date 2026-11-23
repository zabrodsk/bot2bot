// Shared folder metadata. File contents and paths are encrypted by member devices.
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import {
  createFolderStorage,
  folderChunkBytes,
  folderKeepMs,
  folderMaxFileBytes,
  folderQuotaBytes,
} from './folder-storage.mjs';

export function migrateTeamFolders(db) {
  // The pre-release v1 pilot had no users. Drop only its incompatible content tables.
  if (
    db
      .prepare('PRAGMA table_info(team_folder_revisions)')
      .all()
      .some((c) => c.name === 'ciphertext')
  )
    db.exec('DROP TRIGGER IF EXISTS team_folder_end; DROP TABLE team_folder_copies; DROP TABLE team_folder_revisions');
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_folder_members (
      grant_id TEXT PRIMARY KEY, group_id INTEGER NOT NULL, bot_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('read','write')), UNIQUE(group_id,bot_id),
      FOREIGN KEY(group_id,bot_id) REFERENCES group_members(group_id,bot_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS team_folder_denied (
      group_id INTEGER NOT NULL, bot_id INTEGER NOT NULL, PRIMARY KEY(group_id,bot_id),
      FOREIGN KEY(group_id,bot_id) REFERENCES group_members(group_id,bot_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS team_folder_groups (
      group_id INTEGER PRIMARY KEY REFERENCES chat_groups(id) ON DELETE CASCADE, enabled_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS folder_limits (
      group_id INTEGER PRIMARY KEY REFERENCES chat_groups(id) ON DELETE CASCADE,
      max_bytes INTEGER NOT NULL DEFAULT ${folderQuotaBytes}
    );
    CREATE TABLE IF NOT EXISTS folder_uploads (
      id TEXT PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL, grant_id TEXT NOT NULL, device TEXT NOT NULL, size INTEGER NOT NULL,
      chunks INTEGER NOT NULL, expires INTEGER NOT NULL, committed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS folder_upload_group ON folder_uploads(group_id);
    CREATE TABLE IF NOT EXISTS team_folder_revisions (
      group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL, version INTEGER NOT NULL, seq INTEGER NOT NULL,
      author_id INTEGER NOT NULL, author TEXT NOT NULL, author_device TEXT NOT NULL, sign_key TEXT NOT NULL,
      upload_id TEXT UNIQUE REFERENCES folder_uploads(id), created_at INTEGER NOT NULL, request_id TEXT NOT NULL,
      PRIMARY KEY(group_id,file_id,version), UNIQUE(group_id,seq), UNIQUE(group_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS team_folder_copies (
      group_id INTEGER NOT NULL, file_id TEXT NOT NULL, version INTEGER NOT NULL,
      grant_id TEXT NOT NULL REFERENCES team_folder_members(grant_id) ON DELETE CASCADE,
      device TEXT NOT NULL, recipient_key TEXT NOT NULL, envelope TEXT NOT NULL,
      PRIMARY KEY(grant_id,device,group_id,file_id,version),
      FOREIGN KEY(group_id,file_id,version) REFERENCES team_folder_revisions ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS folder_suggestions(
      proposal_id TEXT PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL, base INTEGER NOT NULL, observed INTEGER NOT NULL, logical_edit_id TEXT NOT NULL,
      state TEXT NOT NULL, author_id INTEGER NOT NULL, author TEXT NOT NULL, author_device TEXT NOT NULL, sign_key TEXT NOT NULL,
      created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_version INTEGER, seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS folder_suggestion_parts(
      proposal_id TEXT NOT NULL REFERENCES folder_suggestions ON DELETE CASCADE, part TEXT NOT NULL,
      upload_id TEXT UNIQUE NOT NULL REFERENCES folder_uploads, PRIMARY KEY(proposal_id,part));
    CREATE TABLE IF NOT EXISTS folder_suggestion_copies(
      proposal_id TEXT NOT NULL REFERENCES folder_suggestions ON DELETE CASCADE,
      grant_id TEXT NOT NULL REFERENCES team_folder_members ON DELETE CASCADE, device TEXT NOT NULL, box TEXT NOT NULL,
      envelope TEXT NOT NULL, PRIMARY KEY(proposal_id,grant_id,device));
    CREATE TABLE IF NOT EXISTS folder_rejections(
      proposal_id TEXT PRIMARY KEY REFERENCES folder_suggestions ON DELETE CASCADE, bot_id INTEGER NOT NULL,
      version INTEGER NOT NULL, rejected_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS folder_suggestion_events(
      group_id INTEGER NOT NULL, seq INTEGER NOT NULL, proposal_id TEXT NOT NULL REFERENCES folder_suggestions ON DELETE CASCADE,
      state TEXT NOT NULL, PRIMARY KEY(group_id,seq));
    CREATE TABLE IF NOT EXISTS folder_sequence(group_id INTEGER PRIMARY KEY REFERENCES chat_groups(id) ON DELETE CASCADE, seq INTEGER NOT NULL);
    INSERT OR IGNORE INTO folder_sequence SELECT group_id,max(seq) FROM team_folder_revisions GROUP BY group_id;
    CREATE TABLE IF NOT EXISTS folder_receipts(
      group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE, request_id TEXT NOT NULL, logical_edit_id TEXT,
      grant_id TEXT NOT NULL REFERENCES team_folder_members ON DELETE CASCADE, device TEXT NOT NULL,
      operation TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(group_id,request_id), UNIQUE(group_id,grant_id,logical_edit_id));
    CREATE TRIGGER IF NOT EXISTS folder_suggestion_forget AFTER DELETE ON folder_suggestions BEGIN
      DELETE FROM folder_receipts WHERE group_id=OLD.group_id AND (operation='resolve/'||OLD.proposal_id OR
        (operation='suggest/'||OLD.file_id AND logical_edit_id=OLD.logical_edit_id));
    END;
    CREATE TABLE IF NOT EXISTS folder_garbage (id TEXT PRIMARY KEY, group_id INTEGER NOT NULL, chunks INTEGER NOT NULL, expires INTEGER NOT NULL, size INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS folder_collect AFTER DELETE ON folder_uploads BEGIN
      INSERT OR IGNORE INTO folder_garbage VALUES(OLD.id, OLD.group_id, OLD.chunks, OLD.expires, OLD.size);
    END;
    DROP TRIGGER IF EXISTS team_folder_leave;
    CREATE TRIGGER team_folder_leave AFTER UPDATE OF state ON group_members
      WHEN NEW.state <> 'joined' BEGIN
        DELETE FROM team_folder_denied WHERE group_id=NEW.group_id AND bot_id=NEW.bot_id;
        DELETE FROM team_folder_members WHERE group_id=NEW.group_id AND bot_id=NEW.bot_id;
      END;
    DROP TRIGGER IF EXISTS team_folder_end;
    CREATE TRIGGER team_folder_end AFTER UPDATE OF ended_at ON chat_groups
      WHEN NEW.ended_at IS NOT NULL BEGIN
        DELETE FROM team_folder_denied WHERE group_id=NEW.id;
        DELETE FROM team_folder_members WHERE group_id=NEW.id;
        DELETE FROM team_folder_revisions WHERE group_id=NEW.id;
        DELETE FROM folder_suggestions WHERE group_id=NEW.id;
        DELETE FROM folder_sequence WHERE group_id=NEW.id;
        DELETE FROM folder_receipts WHERE group_id=NEW.id;
        DELETE FROM folder_uploads WHERE group_id=NEW.id;
        DELETE FROM folder_limits WHERE group_id=NEW.id;
        DELETE FROM team_folder_groups WHERE group_id=NEW.id;
      END;
  `);
  if (!db.prepare('PRAGMA table_info(team_folder_members)').all().some((c) => c.name === 'write_epoch'))
    db.exec('ALTER TABLE team_folder_members ADD COLUMN write_epoch TEXT');
  for (const table of ['team_folder_copies', 'folder_suggestion_copies']) {
    if (
      !db
        .prepare('PRAGMA table_info(' + table + ')')
        .all()
        .some((c) => c.name === 'backfill')
    ) {
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN backfill TEXT');
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN available_seq INTEGER');
    }
  }
}

const fileId = /^f_[0-9a-f]{32}$/;
const requestId = /^req_[0-9a-f]{32}$/;
const seal = /^b2b1\.[\w-]{43}\.[\w-]{16}\.[\w-]{1,12000}\.[\w-]{86}$/;
const ALPHA = 'shared folders are in alpha, for Infinite accounts only';
export function createTeamFolders({
  q,
  tx,
  clock,
  HttpError,
  hosted,
  foldersOpen = true,
  dbPath,
  s3,
  fetchImpl,
  publicUrl,
  linkedDevices,
  db,
}) {
  const fail = (status, message, data) => {
    const e = new HttpError(status, message);
    if (data) e.data = data;
    throw e;
  };
  const gated = hosted && !foldersOpen;
  const storage = createFolderStorage({ q, clock, fail, dbPath, s3, fetchImpl, publicUrl });
  // A granted member's bot as it can be sealed to: joined, not ended, private mode with keys. Paused, disconnected
  // or files-off bots still get sealed copies (so they never block a writer); they read once they're back.
  const sealable = `JOIN chat_groups g ON g.id=gm.group_id JOIN bots b ON b.id=gm.bot_id
    WHERE gm.group_id=? AND gm.state='joined' AND g.ended_at IS NULL AND b.vendor NOT IN ('web','service')
    AND b.box_pub IS NOT NULL AND b.sign_pub IS NOT NULL`;
  // A bot that can use the folder right now.
  const active = `${sealable} AND b.disconnected_at IS NULL AND b.removed_at IS NULL AND b.paused_at IS NULL
    AND (SELECT u.files_off FROM users u WHERE u.id=b.user_id)=0
    ${gated ? 'AND (SELECT u.infinite_at FROM users u WHERE u.id=b.user_id) IS NOT NULL' : ''}`;
  // The alpha (FOLDERS_OPEN=0 on the hosted relay): a bot whose owner isn't on Infinite hears that before anything else.
  const infinite = (bot) => !gated || !!q('SELECT infinite_at FROM users WHERE id=?').get(bot.user_id)?.infinite_at;
  const alphaOnly = (bot) => {
    if (!infinite(bot)) fail(403, ALPHA);
  };
  const root = '/v1/team-folders/:group';
  const enabled = (group) => !!q('SELECT 1 FROM team_folder_groups WHERE group_id=?').get(group);
  function autoGrant(group) {
    q(`INSERT INTO team_folder_members(grant_id,group_id,bot_id,role) SELECT lower(hex(randomblob(16))),gm.group_id,gm.bot_id,'write'
      FROM group_members gm JOIN team_folder_groups USING(group_id) ${active}
      AND NOT EXISTS (SELECT 1 FROM team_folder_members m WHERE m.group_id=gm.group_id AND m.bot_id=gm.bot_id)
      AND NOT EXISTS (SELECT 1 FROM team_folder_denied d WHERE d.group_id=gm.group_id AND d.bot_id=gm.bot_id)`).run(group);
  }
  function access(me, group) {
    alphaOnly(me);
    if (!enabled(group)) fail(404, 'this group has no shared folder');
    autoGrant(group);
    const members = q(`SELECT m.grant_id, m.role, m.write_epoch, b.id, b.handle, b.box_pub AS box, b.sign_pub AS sign
      FROM group_members gm JOIN team_folder_members m ON m.group_id=gm.group_id AND m.bot_id=gm.bot_id
      ${sealable} ORDER BY b.id`).all(group);
    const own = members.find((m) => m.id === me.id);
    const live = own && q(`SELECT 1 FROM group_members gm ${active} AND b.id=?`).get(group, me.id);
    if (!live || !q('SELECT 1 FROM bots WHERE id=? AND token_hash=?').get(me.id, me.token_hash))
      fail(403, 'a current folder membership is required');
    const recipients = members.flatMap((m) =>
      linkedDevices
        .active({ id: m.id, box_pub: m.box, sign_pub: m.sign })
        .map((d) => ({ handle: m.handle, device: d.id, box: d.box, sign: d.sign })),
    );
    const device = recipients.find((d) => d.handle === own.handle && d.device === (me.device_id ?? 'primary'));
    if (!device) fail(403, 'device access revoked');
    const roster = createHash('sha256')
      .update(JSON.stringify([members, recipients]))
      .digest('hex');
    return { members, own, roster, recipients, device };
  }
  const blocked = (a, b) =>
    !!q(
      'SELECT 1 FROM contacts WHERE blocked=1 AND ((owner_bot=? AND peer_bot=?) OR (owner_bot=? AND peer_bot=?))',
    ).get(a, b, b, a);
  function rows(group, { own, device }, filter, ...values) {
    return q(`SELECT r.file_id,r.version,coalesce(c.available_seq,r.seq) AS seq,r.author_id,r.author,r.author_device,r.sign_key,r.created_at,c.envelope,c.backfill,
      b.sign_pub AS root_sign,b.box_pub AS root_box,d.manifest AS device_list,r.upload_id,
      coalesce(u.size,0) AS size,coalesce(u.chunks,0) AS chunks
      FROM team_folder_revisions r JOIN team_folder_copies c USING(group_id,file_id,version)
      JOIN bots b ON b.id=r.author_id LEFT JOIN device_rosters d ON d.bot_id=b.id
      LEFT JOIN folder_uploads u ON u.id=r.upload_id
      WHERE r.group_id=? AND c.grant_id=? AND c.device=? AND c.recipient_key=? AND ${filter}
      AND NOT EXISTS(SELECT 1 FROM contacts WHERE blocked=1 AND ((owner_bot=? AND peer_bot=r.author_id)
        OR (peer_bot=? AND owner_bot=r.author_id))) ORDER BY seq`)
      .all(group, own.grant_id, device.device, device.box, ...values, own.id, own.id)
      .map((r) => ({
        ...r,
        deleted: !r.upload_id,
        backfill: JSON.parse(r.backfill),
        device_list: JSON.parse(r.device_list),
      }));
  }
  const latest = (group) => q('SELECT seq FROM folder_sequence WHERE group_id=?').get(group)?.seq ?? 0;
  function nextSeq(group) {
    return q('INSERT INTO folder_sequence VALUES(?,1) ON CONFLICT(group_id) DO UPDATE SET seq=seq+1 RETURNING seq').get(
      group,
    ).seq;
  }
  function head(group, file, a) {
    const version = q('SELECT MAX(version) AS v FROM team_folder_revisions WHERE group_id=? AND file_id=?').get(
      group,
      file,
    ).v;
    const row = version && rows(group, a, 'r.file_id=? AND r.version=?', file, version)[0];
    if (version && !row) fail(403, 'no access to current version');
    return row;
  }
  const parts = ['original', 'current', 'proposed', 'intent'];
  function uploadsFor(body, group, file, a, ids) {
    const keys = Object.keys(body.envelopes ?? {});
    if (
      body.roster !== a.roster ||
      keys.length !== a.recipients.length ||
      !a.recipients.every((d) => Object.hasOwn(body.envelopes, recipientKey(d)))
    )
      fail(409, 'refresh the folder roster');
    if (!keys.every((k) => typeof body.envelopes[k] === 'string' && seal.test(body.envelopes[k])))
      fail(400, 'invalid envelope');
    if (new Set(ids).size !== ids.length) fail(400, 'each part needs its own upload');
    return ids.map((id) => {
      const u = q(
        'SELECT * FROM folder_uploads WHERE id=? AND group_id=? AND file_id=? AND grant_id=? AND device=? AND committed=0 AND expires>?',
      ).get(String(id), group, file, a.own.grant_id, a.device.device, clock());
      if (!u) fail(400, 'upload unavailable');
      return u;
    });
  }
  function operation(group, a, name, body) {
    if (
      !body ||
      typeof body.request_id !== 'string' ||
      !requestId.test(body.request_id) ||
      (body.logical_edit_id != null && !/^edit_[a-f0-9]{32}$/.test(body.logical_edit_id))
    )
      fail(400, 'invalid request_id or logical_edit_id');
    const digest = createHash('sha256')
      .update(
        JSON.stringify(body, (_, v) =>
          v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(
                Object.keys(v)
                  .sort()
                  .map((k) => [k, v[k]]),
              )
            : v,
        ),
      )
      .digest('hex');
    const own = a.own.grant_id,
      device = a.device.device,
      logical = body.logical_edit_id ?? null;
    const done = q('SELECT * FROM folder_receipts WHERE group_id=? AND request_id=?').get(group, body.request_id);
    if (done && (name !== done.operation || done.digest !== digest || done.grant_id !== own || done.device !== device))
      fail(409, 'request_id already used for another request');
    const prior =
      done ??
      q('SELECT * FROM folder_receipts WHERE group_id=? AND grant_id=? AND logical_edit_id=?').get(group, own, logical);
    if (prior && prior.operation !== name && prior.operation.split('/')[1] !== name.split('/')[1])
      fail(409, 'logical edit already used');
    return {
      result: prior && JSON.parse(prior.result),
      record(result) {
        q('INSERT INTO folder_receipts VALUES(?,?,?,?,?,?,?,?)').run(
          group,
          body.request_id,
          logical,
          own,
          device,
          name,
          digest,
          JSON.stringify(result),
        );
        return result;
      },
    };
  }
  function suggestions(group, a, filter, ...args) {
    return q(`SELECT s.proposal_id,s.file_id,s.base,s.observed,s.logical_edit_id,s.state,s.author_id,s.author,s.author_device,s.sign_key,
      s.created_at,s.resolved_at,s.resolved_version,max(s.seq,coalesce(c.available_seq,0)) AS seq,c.envelope,c.backfill,b.sign_pub AS root_sign,b.box_pub AS root_box,d.manifest AS device_list
      FROM folder_suggestions s JOIN folder_suggestion_copies c USING(proposal_id)
      JOIN bots b ON b.id=s.author_id LEFT JOIN device_rosters d ON d.bot_id=b.id
      WHERE s.group_id=? AND c.grant_id=? AND c.device=? AND c.box=? AND ${filter}
      AND NOT EXISTS(SELECT 1 FROM contacts WHERE blocked=1 AND ((owner_bot=? AND peer_bot=s.author_id)
      OR (peer_bot=? AND owner_bot=s.author_id))) ORDER BY s.seq`)
      .all(group, a.own.grant_id, a.device.device, a.device.box, ...args, a.own.id, a.own.id)
      .map((s) => ({ ...s, backfill: JSON.parse(s.backfill), device_list: JSON.parse(s.device_list) }));
  }
  function visibleSuggestion(group, a, id) {
    const s = suggestions(group, a, 's.proposal_id=?', id)[0];
    if (!s) fail(404, 'suggestion unavailable');
    return s;
  }
  function transition(group, s, state, version) {
    const seq = nextSeq(group);
    q('UPDATE folder_suggestions SET state=?,resolved_at=?,resolved_version=?,seq=? WHERE proposal_id=?').run(
      state,
      state === 'pending' ? null : clock(),
      version,
      seq,
      s.proposal_id,
    );
    q('INSERT INTO folder_suggestion_events VALUES(?,?,?,?)').run(group, seq, s.proposal_id, state);
    return { proposal_id: s.proposal_id, file_id: s.file_id, state, seq };
  }
  function quota(group) {
    q('INSERT OR IGNORE INTO folder_limits(group_id) VALUES(?)').run(group);
    return {
      max: q('SELECT max_bytes FROM folder_limits WHERE group_id=?').get(group).max_bytes,
      used: q(`SELECT coalesce(sum(size + 16*chunks),0) AS n FROM
        (SELECT size,chunks FROM folder_uploads WHERE group_id=? UNION ALL
         SELECT size,chunks FROM folder_garbage WHERE group_id=?)`).get(group, group).n,
    };
  }
  function writable(me, group) {
    const a = access(me, group);
    if (a.own.role !== 'write') fail(403, 'write membership required');
    if (a.members.some((m) => blocked(me.id, m.id))) fail(403, 'a team member is blocked');
    return a;
  }
  function sweep(t = clock()) {
    tx(() => {
      q("DELETE FROM folder_suggestions WHERE (state='pending' AND created_at<=?) OR resolved_at<=?").run(
        t - 90 * 86400_000,
        t - folderKeepMs,
      );
      q(`DELETE FROM team_folder_revisions AS r WHERE created_at < ? AND EXISTS
        (SELECT 1 FROM team_folder_revisions h WHERE h.group_id=r.group_id AND h.file_id=r.file_id AND h.version>r.version)`).run(
        t - folderKeepMs,
      );
      q(`DELETE FROM folder_uploads WHERE (committed=0 AND expires < ?) OR
        (committed=1 AND NOT EXISTS(SELECT 1 FROM team_folder_revisions WHERE upload_id=folder_uploads.id) AND NOT EXISTS(SELECT 1 FROM folder_suggestion_parts WHERE upload_id=folder_uploads.id))`).run(
        t - 60_000,
      );
    });
    return storage.collect();
  }
  let cleanupQueued = false;
  db.function('folder_cleanup_later', () => {
    if (!cleanupQueued) {
      cleanupQueued = true;
      queueMicrotask(() => {
        cleanupQueued = false;
        storage.collect().catch(console.error);
      });
    }
    return 0;
  });
  db.exec(`CREATE TEMP TRIGGER folder_cleanup AFTER INSERT ON folder_garbage BEGIN SELECT folder_cleanup_later(); END`);
  // Grant, change or remove one member's access. Only bots that can use the folder right now can be granted.
  function setMember(group, handle, role) {
    if (!Number.isSafeInteger(group) || typeof handle !== 'string' || !['read', 'write', 'remove'].includes(role))
      fail(400, 'provide group number, handle and role (read, write or remove)');
    if (!enabled(group)) fail(400, 'turn the shared folder on for this group first');
    const name = handle.replace(/^@/, '').toLowerCase();
    if (role === 'remove') {
      const member = q("SELECT gm.bot_id FROM group_members gm JOIN bots b ON gm.bot_id=b.id WHERE gm.group_id=? AND gm.state='joined' AND b.handle=?").get(group, name);
      if (!member) fail(404, 'choose a joined member');
      q('INSERT OR IGNORE INTO team_folder_denied VALUES(?,?)').run(group, member.bot_id);
      q('DELETE FROM team_folder_members WHERE group_id=? AND bot_id=?').run(group, member.bot_id);
    } else {
      const bot = q(`SELECT b.id FROM group_members gm ${active} AND b.handle=?`).get(group, name);
      const member = !bot && q(`SELECT b.user_id FROM group_members gm ${sealable} AND b.handle=?`).get(group, name);
      if (member && !infinite(member)) fail(400, `@${name} isn't on an Infinite account; ${ALPHA}`);
      if (!bot) fail(400, 'choose an active joined private-mode bot with files enabled');
      q('DELETE FROM team_folder_denied WHERE group_id=? AND bot_id=?').run(group, bot.id);
      q(
        `INSERT INTO team_folder_members(grant_id,group_id,bot_id,role) VALUES (?,?,?,?)
         ON CONFLICT(group_id,bot_id) DO UPDATE SET role=excluded.role,
         write_epoch=CASE WHEN role='read' AND excluded.role='write' THEN excluded.grant_id ELSE write_epoch END`,
      ).run(randomUUID(), group, bot.id, role);
    }
    return { group, handle: name, role };
  }
  function groupAdmin(me, group, what) {
    alphaOnly(me);
    const mine = q(`SELECT gm.role FROM group_members gm ${active} AND b.id=?`).get(group, me.id);
    if (!mine) fail(403, 'team folder access requires a current membership and an active bot');
    if (mine.role !== 'admin') fail(403, `only group admins can ${what}`);
  }
  const routes = {
    'GET /v1/team-folders': ({ me }) => {
      alphaOnly(me);
      for (const { group_id } of q("SELECT group_id FROM group_members JOIN team_folder_groups USING(group_id) WHERE bot_id=? AND state='joined'").all(me.id)) autoGrant(group_id);
      return {
        groups: q(`SELECT gm.group_id FROM group_members gm JOIN team_folder_members m USING(group_id,bot_id)
        JOIN team_folder_groups enabled USING(group_id) JOIN bots b ON b.id=gm.bot_id JOIN chat_groups g ON g.id=gm.group_id
        WHERE gm.bot_id=? AND gm.state='joined' AND g.ended_at IS NULL AND b.disconnected_at IS NULL
        AND b.removed_at IS NULL AND b.paused_at IS NULL AND (SELECT files_off FROM users WHERE id=b.user_id)=0`)
          .all(me.id)
          .map((r) => r.group_id),
      };
    },
    'POST /admin/team-folder/group': ({ admin, body }) =>
      tx(() => {
        if (!admin) fail(403, 'operator access required');
        const { group, on } = body ?? {};
        if (!Number.isSafeInteger(group) || typeof on !== 'boolean')
          fail(400, 'provide group number and on (true or false)');
        if (!on) q('DELETE FROM team_folder_groups WHERE group_id=?').run(group);
        else {
          if (!q('SELECT 1 FROM chat_groups WHERE id=? AND ended_at IS NULL').get(group)) fail(404, 'group not found');
          q('INSERT OR IGNORE INTO team_folder_groups VALUES (?,?)').run(group, clock());
        }
        if (on) autoGrant(group);
        return { group, on };
      }),
    'POST /admin/team-folder/member': ({ admin, body }) =>
      tx(() => {
        if (!admin) fail(403, 'operator access required');
        return setMember(body?.group, body?.handle, body?.role);
      }),
    // The group's own admins turn the folder on or off and manage access, from their primary bot.
    [`POST ${root}/state`]: ({ me, params, body }) =>
      tx(() => {
        const group = Number(params.group);
        groupAdmin(me, group, 'turn the shared folder on or off');
        if (typeof body?.on !== 'boolean') fail(400, 'provide on (true or false)');
        if (body.on) q('INSERT OR IGNORE INTO team_folder_groups VALUES (?,?)').run(group, clock());
        else q('DELETE FROM team_folder_groups WHERE group_id=?').run(group);
        if (body.on) autoGrant(group);
        return { group, on: body.on, alpha: gated };
      }),
    [`POST ${root}/members`]: ({ me, params, body }) =>
      tx(() => {
        const group = Number(params.group);
        alphaOnly(me);
        if (!enabled(group)) fail(404, 'this group has no shared folder');
        groupAdmin(me, group, 'change who has access to the shared folder');
        return setMember(group, body?.handle, body?.role);
      }),
    [`GET ${root}`]: ({ me, params: { group } }) => {
      const { members, own, roster, recipients } = access(me, group);
      return {
        alpha: gated,
        role: own.role,
        write_epoch: own.write_epoch,
        roster,
        recipients,
        quota: quota(group),
        max_file_bytes: folderMaxFileBytes,
        name: q('SELECT name FROM chat_groups WHERE id=?').get(group).name,
        seq: latest(group),
        members: members.map(({ id, handle, role, sign, box }) => ({
          handle,
          role,
          sign,
          box,
          device_list: linkedDevices.roster(id),
        })),
      };
    },
    [`GET ${root}/changes`]: async ({ me, params: { group }, url, res }) => {
      const since = Number(url.searchParams.get('since') ?? 0),
        wait = Number(url.searchParams.get('wait') ?? 0);
      const end = Date.now() + Math.min(25, wait) * 1000;
      while (true) {
        const a = access(me, group);
        if (!Number.isSafeInteger(since) || since < 0 || !Number.isFinite(wait) || wait < 0)
          fail(400, 'invalid change cursor or wait');
        const seq = latest(group);
        if (seq > since || Date.now() >= end || res.destroyed)
          return {
            changes: rows(group, a, 'coalesce(c.available_seq,r.seq)>?', since).map(publicRow),
            seq,
            suggestion_events: q(`WITH visible AS (
              SELECT s.file_id,s.proposal_id,c.available_seq FROM folder_suggestions s JOIN folder_suggestion_copies c USING(proposal_id)
              WHERE s.group_id=? AND c.grant_id=? AND c.device=? AND c.box=?
              AND NOT EXISTS(SELECT 1 FROM contacts WHERE blocked=1 AND ((owner_bot=? AND peer_bot=s.author_id) OR (peer_bot=? AND owner_bot=s.author_id))))
              SELECT e.seq,v.proposal_id,v.file_id,e.state FROM visible v JOIN folder_suggestion_events e USING(proposal_id)
              WHERE e.seq>? AND e.seq>coalesce(v.available_seq,0)
              UNION ALL SELECT available_seq,proposal_id,file_id,'pending' FROM visible WHERE available_seq>? ORDER BY seq`).all(
              group,
              a.own.grant_id,
              a.device.device,
              a.device.box,
              a.own.id,
              a.own.id,
              since,
              since,
            ),
          };
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, end - Date.now())));
      }
    },
    [`GET ${root}/backfill`]: ({ me, params: { group } }) => {
      const a = access(me, group);
      const members = new Map(a.members.map((m) => [m.handle, m]));
      const targets = a.recipients.filter((d) => d !== a.device && !blocked(me.id, members.get(d.handle).id));
      const missingDevices = (devices) => {
        const others = devices.filter((d) => d.handle !== me.handle).map(({ handle, device }) => ({ handle, device }));
        return { missing: devices.filter((d) => d.handle === me.handle).map((d) => d.device), ...(others.length && { missing_members: others }) };
      };
      if (!targets.length) return { items: [] };
      const items = [];
      for (const r of rows(
        group,
        a,
        'r.upload_id IS NOT NULL AND r.version=(SELECT max(h.version) FROM team_folder_revisions h WHERE h.group_id=r.group_id AND h.file_id=r.file_id)',
      )) {
        const missing = targets.filter(
          (d) => !blocked(members.get(d.handle).id, r.author_id) &&
            !q(
              'SELECT 1 FROM team_folder_copies WHERE group_id=? AND file_id=? AND version=? AND grant_id=? AND device=? AND recipient_key=?',
            ).get(group, r.file_id, r.version, members.get(d.handle).grant_id, d.device, d.box),
        );
        if (missing.length)
          items.push({ file_id: r.file_id, version: r.version, ...missingDevices(missing) });
      }
      for (const s of suggestions(group, a, "s.state='pending'")) {
        const missing = targets.filter(
          (d) => !blocked(members.get(d.handle).id, s.author_id) &&
            !q('SELECT 1 FROM folder_suggestion_copies WHERE proposal_id=? AND grant_id=? AND device=? AND box=?').get(
              s.proposal_id,
              members.get(d.handle).grant_id,
              d.device,
              d.box,
            ),
        );
        if (missing.length)
          items.push({ file_id: s.file_id, proposal_id: s.proposal_id, ...missingDevices(missing) });
      }
      return { items };
    },
    [`POST ${root}/backfill`]: ({ me, params: { group }, body }) =>
      tx(() => {
        const a = access(me, group);
        const target = a.recipients.find(
          (d) => d.handle === (body?.handle ?? me.handle) && d.device === body?.device && d !== a.device,
        );
        const member = target && a.members.find((m) => m.handle === target.handle);
        if (!member || blocked(me.id, member.id)) fail(403, 'choose a current folder device');
        if (body.roster !== a.roster) fail(409, 'refresh the folder roster');
        const { file_id: file, version, proposal_id: id, envelope } = body;
        if (
          !fileId.test(file) ||
          (id !== undefined) === (version !== undefined) ||
          (id !== undefined && !/^p_[a-f0-9]{32}$/.test(id)) ||
          (version !== undefined && (!Number.isSafeInteger(version) || version < 1))
        )
          fail(400, 'invalid backfill target');
        if (id) {
          const s = visibleSuggestion(group, a, id);
          if (blocked(s.author_id, member.id)) fail(403, 'a team member is blocked');
          if (s.file_id !== file || s.state !== 'pending') fail(409, 'suggestion changed');
        } else {
          const r = head(group, file, a);
          if (r && blocked(r.author_id, member.id)) fail(403, 'a team member is blocked');
          if (r?.version !== version || r.deleted) fail(409, 'document changed');
        }
        const manifest = linkedDevices.roster(me.id);
        const kind = id
          ? 'team-suggestion/1/' + group + '/' + file + '/' + id
          : 'team-folder/2/' + group + '/' + file + '/' + version;
        if (typeof envelope !== 'string' || !/^b2b1\.[\w-]{43}\.[\w-]{16}\.[\w-]{1,32000}\.[\w-]{86}$/.test(envelope))
          fail(400, 'invalid backfill envelope');
        const [, eph, nonce, ct, sig] = envelope.split('.');
        const aad = Buffer.from('b2b1|' + a.device.sign + '|' + target.box + '|team-backfill/1/' + kind + '|');
        if (
          !verify(
            null,
            Buffer.concat([aad, ...[eph, nonce, ct].map((s) => Buffer.from(s, 'base64url'))]),
            createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: a.device.sign }, format: 'jwk' }),
            Buffer.from(sig, 'base64url'),
          )
        )
          fail(400, 'invalid backfill signature');
        const other = { ...a, own: member, device: target };
        if (
          id
            ? suggestions(group, other, 's.proposal_id=?', id).length
            : rows(group, other, 'r.file_id=? AND r.version=?', file, version).length
        )
          return { added: false, seq: latest(group) };
        const seq = nextSeq(group),
          proof = JSON.stringify({ device: a.device.device, sign: a.device.sign, device_list: manifest, handle: me.handle, root_sign: a.own.sign });
        if (id)
          q(
            'INSERT INTO folder_suggestion_copies(proposal_id,grant_id,device,box,envelope,backfill,available_seq) VALUES(?,?,?,?,?,?,?)',
          ).run(id, member.grant_id, target.device, target.box, envelope, proof, seq);
        else
          q(
            'INSERT INTO team_folder_copies(group_id,file_id,version,grant_id,device,recipient_key,envelope,backfill,available_seq) VALUES(?,?,?,?,?,?,?,?,?)',
          ).run(group, file, version, member.grant_id, target.device, target.box, envelope, proof, seq);
        return { added: true, seq };
      }),
    [`GET ${root}/files/:file/history`]: ({ me, params: { group, file } }) => ({
      versions: rows(group, access(me, group), 'r.file_id=?', file).reverse().map(publicRow),
    }),
    [`GET ${root}/files/:file/:version`]: ({ me, params: { group, file, version } }) => {
      const [r] = rows(group, access(me, group), 'r.file_id=? AND r.version=?', file, version);
      if (!r) fail(404, 'version unavailable');
      return { ...publicRow(r), urls: storage.urls('GET', group, r.upload_id, r.size, r.chunks) };
    },
    [`POST ${root}/uploads`]: ({ me, params: { group }, body }) =>
      tx(() => {
        const a = writable(me, group),
          { file_id, size, chunks } = body ?? {};
        if (typeof file_id !== 'string' || !fileId.test(file_id) || !Number.isSafeInteger(size) || size < 0)
          fail(400, 'invalid file id or size');
        if (size > folderMaxFileBytes) fail(413, 'choose a file up to 200 MiB');
        if (chunks !== Math.max(1, Math.ceil(size / folderChunkBytes))) fail(400, 'invalid chunk count');
        const { used, max } = quota(group);
        if (used + size + 16 * chunks > max) fail(413, 'shared folder quota reached');
        const id = randomUUID(),
          expires = clock() + 900_000;
        q('INSERT INTO folder_uploads VALUES(?,?,?,?,?,?,?,?,0)').run(
          id,
          group,
          file_id,
          a.own.grant_id,
          a.device.device,
          size,
          chunks,
          expires,
        );
        return {
          upload_id: id,
          chunk_size: folderChunkBytes,
          urls: storage.urls('PUT', group, id, size, chunks),
          expires_at: expires,
        };
      }),
    [`GET ${root}/suggestions`]: ({ me, params: { group }, url }) => {
      const file = url.searchParams.get('file_id');
      return { suggestions: suggestions(group, access(me, group), '(? IS NULL OR s.file_id=?)', file, file).map(publicRow) };
    },
    [`GET ${root}/suggestions/:id`]: ({ me, params: { group, id } }) => {
      const s = visibleSuggestion(group, access(me, group), id);
      const urls = {};
      for (const u of q(
        'SELECT p.part,u.* FROM folder_suggestion_parts p JOIN folder_uploads u ON u.id=p.upload_id WHERE proposal_id=?',
      ).all(id))
        urls[u.part] = storage.urls('GET', group, u.id, u.size, u.chunks);
      return { ...publicRow(s), urls };
    },
    [`POST ${root}/suggestions`]: async ({ me, params: { group }, body }) => {
      function check() {
        const a = writable(me, group),
          receipt = operation(group, a, 'suggest/' + body?.file_id, body);
        if (receipt.result) return { result: receipt.result };
        if (
          !/^p_[a-f0-9]{32}$/.test(body.proposal_id) ||
          !body.logical_edit_id ||
          !fileId.test(body.file_id) ||
          !Number.isSafeInteger(body.base) ||
          body.base < 0 ||
          !Number.isSafeInteger(body.observed) ||
          body.observed < 1 ||
          body.base > body.observed ||
          !body.uploads ||
          Object.keys(body.uploads).length !== parts.length
        )
          fail(400, 'invalid suggestion');
        const current = head(group, body.file_id, a);
        if (!current || current.deleted || body.observed > current.version) fail(409, 'document unavailable');
        if (!rows(group, a, 'r.file_id=? AND r.version=?', body.file_id, body.observed).length)
          fail(403, 'no access to observed version');
        if (q('SELECT 1 FROM folder_suggestions WHERE proposal_id=?').get(body.proposal_id))
          fail(409, 'suggestion ID already used');
        return {
          a,
          receipt,
          uploads: uploadsFor(
            body,
            group,
            body.file_id,
            a,
            parts.map((k) => body.uploads[k]),
          ),
        };
      }
      const pending = check();
      if (pending.result) return pending.result;
      for (const u of pending.uploads) await storage.verify(u);
      return tx(() => {
        const { result, a, receipt, uploads } = check();
        if (result) return result;
        const seq = nextSeq(group),
          id = body.proposal_id;
        q("INSERT INTO folder_suggestions VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,NULL,NULL,?)").run(
          id,
          group,
          body.file_id,
          body.base,
          body.observed,
          body.logical_edit_id,
          me.id,
          me.handle,
          a.device.device,
          a.device.sign,
          clock(),
          seq,
        );
        for (const [i, u] of uploads.entries()) {
          q('INSERT INTO folder_suggestion_parts VALUES(?,?,?)').run(id, parts[i], u.id);
          q('UPDATE folder_uploads SET committed=1 WHERE id=?').run(u.id);
        }
        for (const d of a.recipients) {
          const m = a.members.find((m) => m.handle === d.handle);
          q('INSERT INTO folder_suggestion_copies(proposal_id,grant_id,device,box,envelope) VALUES(?,?,?,?,?)').run(
            id,
            m.grant_id,
            d.device,
            d.box,
            body.envelopes[recipientKey(d)],
          );
        }
        q("INSERT INTO folder_suggestion_events VALUES(?,?,?,'pending')").run(group, seq, id);
        return receipt.record({ proposal_id: id, file_id: body.file_id, state: 'pending', seq });
      });
    },
    [`POST ${root}/suggestions/:id/resolve`]: ({ me, params: { group, id }, body }) =>
      tx(() => {
        const a = writable(me, group),
          s = visibleSuggestion(group, a, id);
        const receipt = operation(group, a, 'resolve/' + id, body);
        if (receipt.result) return receipt.result;
        if (!['reject', 'withdraw', 'reopen'].includes(body.decision)) fail(400, 'choose reject, withdraw or reopen');
        if (body.decision === 'withdraw' && s.author !== me.handle)
          fail(403, 'only the author can withdraw this suggestion');
        const current = head(group, s.file_id, a);
        if (!current || current.deleted || current.version !== body.base) fail(409, 'document changed');
        if (body.decision === 'reopen') {
          const rejection = q('SELECT * FROM folder_rejections WHERE proposal_id=?').get(id);
          if (s.state !== 'rejected' || !rejection) fail(409, 'only a rejected suggestion can reopen');
          if (rejection.bot_id !== me.id) fail(403, 'only the member who rejected this suggestion can reopen it');
          if (current.version !== rejection.version || clock() >= rejection.rejected_at + 600_000)
            fail(409, 'the time or document version for reopening has passed');
          q('DELETE FROM folder_rejections WHERE proposal_id=?').run(id);
          return receipt.record(transition(group, s, 'pending', null));
        }
        if (s.state !== 'pending') fail(409, 'suggestion changed');
        if (body.decision === 'reject')
          q('INSERT INTO folder_rejections VALUES(?,?,?,?)').run(id, me.id, current.version, clock());
        return receipt.record(transition(group, s, body.decision === 'reject' ? 'rejected' : 'withdrawn', null));
      }),
    [`POST ${root}/files/:file`]: async ({ me, params: { group, file }, body }) => {
      function check() {
        const a = writable(me, group);
        if (
          !fileId.test(file) ||
          !Number.isSafeInteger(body?.base) ||
          body.base < 0 ||
          typeof body.request_id !== 'string' ||
          !requestId.test(body.request_id)
        )
          fail(400, 'invalid file, base or request_id');
        const receipt = operation(group, a, 'edit/' + file, body);
        if (receipt.result) return { result: receipt.result };
        const current = head(group, file, a)?.version ?? 0;
        if (body.base === 0 && body.if_seq !== undefined && body.if_seq !== latest(group))
          fail(409, 'refresh the folder before creating a document', { file_id: file, seq: latest(group) });
        if (body.base !== current) fail(409, 'file changed', { file_id: file, current });
        const proposal = body.resolve_proposal && visibleSuggestion(group, a, body.resolve_proposal);
        if (proposal && (proposal.file_id !== file || proposal.state !== 'pending' || body.upload_id === null))
          fail(409, 'suggestion unavailable');
        const [upload] = uploadsFor(body, group, file, a, body.upload_id === null ? [] : [body.upload_id]);
        return { a, upload, receipt, proposal };
      }
      const pending = check();
      if (pending.result) return pending.result;
      if (pending.upload) await storage.verify(pending.upload);
      return tx(() => {
        const { result, a, upload, receipt, proposal } = check();
        if (result) return result;
        const version = body.base + 1,
          seq = nextSeq(group);
        q('INSERT INTO team_folder_revisions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
          group,
          file,
          version,
          seq,
          me.id,
          me.handle,
          a.device.device,
          a.device.sign,
          upload?.id ?? null,
          clock(),
          body.request_id,
        );
        if (upload) q('UPDATE folder_uploads SET committed=1 WHERE id=?').run(upload.id);
        for (const m of a.members)
          for (const d of a.recipients.filter((d) => d.handle === m.handle))
            q(
              'INSERT INTO team_folder_copies(group_id,file_id,version,grant_id,device,recipient_key,envelope) VALUES(?,?,?,?,?,?,?)',
            ).run(group, file, version, m.grant_id, d.device, d.box, body.envelopes[recipientKey(d)]);
        if (proposal) transition(group, proposal, 'accepted', version);
        if (!upload)
          q("DELETE FROM folder_suggestions WHERE group_id=? AND file_id=? AND state='pending'").run(group, file);
        return receipt.record({ file_id: file, version, seq });
      });
    },
  };
  routes[`GET ${root}/`] = routes[`GET ${root}`];
  return { routes, autoGrant, sweep, chunk: storage.serve };
}
const recipientKey = (d) => d.handle + ':' + d.device;
const publicRow = ({ upload_id, author_id, ...row }) => row;
