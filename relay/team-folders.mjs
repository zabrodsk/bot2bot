// Pilot folders store small encrypted project documents in the relay database. Attachment
// acknowledgements and the message retention sweep never touch these immutable revisions.
import { createHash, randomUUID } from 'node:crypto';

export function migrateTeamFolders(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_folder_members (
      grant_id TEXT PRIMARY KEY, group_id INTEGER NOT NULL, bot_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('read','write')), UNIQUE(group_id,bot_id),
      FOREIGN KEY(group_id,bot_id) REFERENCES group_members(group_id,bot_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS team_folder_revisions (
      group_id INTEGER NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      file_id TEXT NOT NULL, revision INTEGER NOT NULL, ciphertext BLOB NOT NULL,
      author_id INTEGER NOT NULL REFERENCES bots(id), author TEXT NOT NULL, sign_key TEXT NOT NULL,
      box_key TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(group_id,file_id,revision)
    );
    CREATE TABLE IF NOT EXISTS team_folder_copies (
      group_id INTEGER NOT NULL, file_id TEXT NOT NULL, revision INTEGER NOT NULL,
      grant_id TEXT NOT NULL REFERENCES team_folder_members(grant_id) ON DELETE CASCADE, recipient_key TEXT NOT NULL,
      envelope TEXT NOT NULL, PRIMARY KEY(grant_id,group_id,file_id,revision),
      FOREIGN KEY(group_id,file_id,revision) REFERENCES team_folder_revisions ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS team_folder_leave AFTER UPDATE OF state ON group_members
      WHEN NEW.state <> 'joined' BEGIN
        DELETE FROM team_folder_members WHERE group_id=NEW.group_id AND bot_id=NEW.bot_id;
      END;
    CREATE TRIGGER IF NOT EXISTS team_folder_end AFTER UPDATE OF ended_at ON chat_groups
      WHEN NEW.ended_at IS NOT NULL BEGIN
        DELETE FROM team_folder_members WHERE group_id=NEW.id;
        DELETE FROM team_folder_revisions WHERE group_id=NEW.id;
      END;
  `);
}

const maxBytes = 48 * 1024;
const fileId = /^doc_[0-9a-f]{32}$/;
const seal = /^b2b1\.[\w-]{43}\.[\w-]{16}\.[\w-]{1,1200}\.[\w-]{86}$/;
export function teamFolderRoutes({ q, tx, clock, HttpError }) {
  const fail = (status, message) => {
    throw new HttpError(status, message);
  };
  const active = `JOIN chat_groups g ON g.id=gm.group_id
    JOIN bots b ON b.id=gm.bot_id JOIN users u ON u.id=b.user_id
    WHERE gm.group_id=? AND gm.state='joined' AND g.ended_at IS NULL AND b.disconnected_at IS NULL
    AND b.vendor NOT IN ('web','service') AND b.removed_at IS NULL AND b.paused_at IS NULL AND u.files_off=0 AND b.box_pub IS NOT NULL AND b.sign_pub IS NOT NULL`;
  const root = '/v1/team-folders/:group';
  function access(me, group) {
    const members = q(`SELECT m.grant_id, m.role, b.id, b.handle, b.box_pub AS box, b.sign_pub AS sign
      FROM group_members gm JOIN team_folder_members m ON m.group_id=gm.group_id AND m.bot_id=gm.bot_id
      ${active} ORDER BY b.id`).all(group);
    const own = members.find((m) => m.id === me.id);
    if (!own || me.device_id) fail(403, 'team folder access requires a current membership and its primary bot');
    const roster = createHash('sha256').update(JSON.stringify(members)).digest('hex');
    return { members, own, roster };
  }
  const blocked = (a, b) =>
    !!q(
      'SELECT 1 FROM contacts WHERE blocked=1 AND ((owner_bot=? AND peer_bot=?) OR (owner_bot=? AND peer_bot=?))',
    ).get(a, b, b, a);
  function rows(group, own, filter, values, withData = false) {
    return q(`SELECT r.file_id,r.revision,r.author,r.author_id,r.sign_key,r.box_key,r.created_at,c.envelope
      ${withData ? ',r.ciphertext' : ''} FROM team_folder_revisions r JOIN team_folder_copies c USING(group_id,file_id,revision)
      WHERE r.group_id=? AND c.grant_id=? AND c.recipient_key=? AND ${filter} ORDER BY r.file_id,r.revision DESC`)
      .all(group, own.grant_id, own.box, ...values)
      .filter((r) => !blocked(r.author_id, own.id));
  }
  return {
    'POST /admin/team-folder/member': ({ admin, body }) =>
      tx(() => {
        if (!admin) fail(403, 'operator access required');
        const { group, handle, role } = body ?? {};
        if (!Number.isSafeInteger(group) || typeof handle !== 'string' || !['read', 'write', 'remove'].includes(role))
          fail(400, 'provide group number, handle and role (read, write or remove)');
        const name = handle.replace(/^@/, '').toLowerCase();
        if (role === 'remove') {
          q('DELETE FROM team_folder_members WHERE group_id=? AND bot_id=(SELECT id FROM bots WHERE handle=?)').run(
            group,
            name,
          );
        } else {
          const bot = q(`SELECT b.id FROM group_members gm ${active} AND b.handle=?`).get(group, name);
          if (!bot) fail(400, 'choose an active joined private-mode bot with files enabled');
          q(
            `INSERT INTO team_folder_members VALUES (?,?,?,?) ON CONFLICT(group_id,bot_id) DO UPDATE SET role=excluded.role`,
          ).run(randomUUID(), group, bot.id, role);
        }
        return { group, handle: name, role };
      }),
    [`GET ${root}`]: ({ me, params }) => {
      const { members, own, roster } = access(me, params.group);
      return {
        group: Number(params.group),
        role: own.role,
        roster,
        members: members.map(({ handle, sign, box }) => ({ handle, sign, box })),
        max_bytes: maxBytes,
        files: rows(
          params.group,
          own,
          'r.revision=(SELECT MAX(v.revision) FROM team_folder_revisions v WHERE v.group_id=r.group_id AND v.file_id=r.file_id)',
          [],
        ),
      };
    },
    [`GET ${root}/:file/history`]: ({ me, params }) => {
      const { own } = access(me, params.group);
      return { revisions: rows(params.group, own, 'r.file_id=?', [params.file]) };
    },
    [`GET ${root}/:file/:revision`]: ({ me, params }) => {
      const { own } = access(me, params.group);
      const [r] = rows(params.group, own, 'r.file_id=? AND r.revision=?', [params.file, params.revision], true);
      if (!r) fail(404, 'revision unavailable');
      return { ...r, ciphertext: Buffer.from(r.ciphertext).toString('base64url') };
    },
    [`POST ${root}/:file`]: ({ me, params, body }) =>
      tx(() => {
        const group = Number(params.group),
          id = params.file;
        const { own, members, roster } = access(me, group);
        if (own.role !== 'write') fail(403, 'write membership required');
        const granted = q('SELECT count(*) AS n FROM team_folder_members WHERE group_id=?').get(group).n;
        if (members.length !== granted)
          fail(409, 'a team member is unavailable; resume access or remove their grant before writing');
        if (members.some((m) => blocked(me.id, m.id))) fail(403, 'a team member is blocked');
        if (body?.roster !== roster) fail(409, 'team membership or keys changed; refresh the folder');
        if (!fileId.test(id) || !Number.isSafeInteger(body.base) || body.base < 0)
          fail(400, 'invalid file id or base revision');
        const head =
          q('SELECT MAX(revision) AS n FROM team_folder_revisions WHERE group_id=? AND file_id=?').get(group, id).n ??
          0;
        if (head && !rows(group, own, 'r.file_id=? AND r.revision=?', [id, head]).length)
          fail(403, 'no access to the current revision');
        if (head !== body.base) fail(409, 'stale revision; read the current version before updating');
        const copies = body.envelopes;
        if (
          !copies ||
          typeof copies !== 'object' ||
          Object.keys(copies).length !== members.length ||
          members.some((m) => typeof copies[m.handle] !== 'string' || !seal.test(copies[m.handle]))
        )
          fail(400, 'one sealed envelope per team member is required');
        if (typeof body.ciphertext !== 'string' || !/^[\w-]+$/.test(body.ciphertext)) fail(400, 'invalid ciphertext');
        const blob = Buffer.from(body.ciphertext, 'base64url');
        if (blob.length < 16 || blob.length > maxBytes + 16)
          fail(413, 'file exceeds the pilot size limit or has no authentication tag');
        if (q('SELECT count(*) AS n FROM team_folder_revisions WHERE group_id=?').get(group).n >= 512)
          fail(409, 'team pilot limit of 512 revisions reached');
        const rev = head + 1;
        q('INSERT INTO team_folder_revisions VALUES (?,?,?,?,?,?,?,?,?)').run(
          group,
          id,
          rev,
          blob,
          me.id,
          me.handle,
          me.sign_pub,
          me.box_pub,
          clock(),
        );
        for (const m of members)
          q('INSERT INTO team_folder_copies VALUES (?,?,?,?,?,?)').run(
            group,
            id,
            rev,
            m.grant_id,
            m.box,
            copies[m.handle],
          );
        return { file_id: id, revision: rev };
      }),
  };
}
