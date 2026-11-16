// Quick-connect task history is plaintext. Private-mode threads stay inside the encrypted body and on the bot's computer.
import { handoffInfo, THREAD_ID_RE } from './handoff.mjs';

const DAY = 86_400_000;
export function migrateTaskThreads(db) {
  const cols = db.prepare('PRAGMA table_info(messages)').all();
  if (!cols.some((c) => c.name === 'thread_id')) db.exec('ALTER TABLE messages ADD COLUMN thread_id TEXT');
  if (!cols.some((c) => c.name === 'handoff_id')) db.exec('ALTER TABLE messages ADD COLUMN handoff_id TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS task_threads (
    id TEXT PRIMARY KEY, bot_a INTEGER NOT NULL REFERENCES bots(id), bot_b INTEGER NOT NULL REFERENCES bots(id),
    state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL, closed_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS messages_task_thread ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS task_threads_expiry ON task_threads(expires_at);`);
}

export function createTaskThreads({ q, tx, clock, HttpError, resolveRecipient, bodyRetentionMs }) {
  const valid = (id) => {
    if (typeof id !== 'string' || !THREAD_ID_RE.test(id)) throw new HttpError(400, 'thread must be a thread id (t_ followed by 8 to 40 letters or digits)');
    return id;
  };
  const pair = (a, b) => [Math.min(a, b), Math.max(a, b)];
  function prepare(me, peer, body, { sealed, text, orig }) {
    if (sealed !== null) {
      if (body.thread != null) throw new HttpError(400, 'private-mode thread metadata belongs inside the encrypted message');
      return { id: null, handoff: null };
    }
    const handoff = handoffInfo(text);
    const explicit = body.thread == null ? null : valid(body.thread);
    if (explicit && handoff?.thread && explicit !== handoff.thread) throw new HttpError(400, 'thread does not match the handoff package');
    const id = explicit ?? handoff?.thread ?? orig?.thread_id ?? null;
    if (orig?.thread_id && id !== orig.thread_id) throw new HttpError(400, 'a reply must stay in the original message thread');
    if (!id) return { id: null, handoff };
    valid(id);
    const row = q('SELECT * FROM task_threads WHERE id = ?').get(id);
    const [a, b] = pair(me.id, peer.peer_bot);
    if (row && (row.bot_a !== a || row.bot_b !== b)) throw new HttpError(409, 'thread id is already in use; create a new thread');
    return { id, handoff, row, a, b };
  }
  // Called only for a new message, after permission, idempotency and quota checks, inside enqueue's transaction.
  function record(thread, t) {
    if (!thread.id) return;
    if (thread.row?.closed_at != null || thread.row?.expires_at <= t) throw new HttpError(409, 'thread is closed or expired; create a new thread');
    const state = thread.handoff?.ask === 'result' ? 'answered' : thread.handoff?.id ? 'handed_off' : thread.row?.state ?? 'open';
    q(`INSERT INTO task_threads (id, bot_a, bot_b, state, created_at, updated_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, expires_at = excluded.expires_at`)
      .run(thread.id, thread.a, thread.b, state, t, t, t + 30 * DAY);
  }
  function accessible(me, id) {
    valid(id);
    const row = q('SELECT * FROM task_threads WHERE id = ?').get(id);
    if (!row || (row.bot_a !== me.id && row.bot_b !== me.id)) throw new HttpError(404, 'thread not found');
    const peerId = row.bot_a === me.id ? row.bot_b : row.bot_a;
    const peer = q('SELECT handle FROM bots WHERE id = ?').get(peerId);
    resolveRecipient(me, `@${peer?.handle}`);
    if (me.paused_at) throw new HttpError(403, 'your owner paused bot2bot');
    return row;
  }
  const meta = (r) => ({ id: r.id, state: r.expires_at <= clock() ? 'expired' : r.state, encrypted: false,
    created_at: new Date(r.created_at).toISOString(), updated_at: new Date(r.updated_at).toISOString(),
    closed_at: r.closed_at == null ? null : new Date(r.closed_at).toISOString(), expires_at: new Date(r.expires_at).toISOString(),
    retention: 'Plaintext history stays for 30 days after the last new message. Closing shortens this to at most 7 more days.' });
  function history(me, id, url) {
    const row = accessible(me, id), thread = meta(row);
    if (row.expires_at <= clock()) return { thread, messages: [], latest_package: null, more: false, next_after: null };
    const limit = Math.min(100, Math.max(1, Number(url?.searchParams.get('limit')) || 50));
    // Both directions must still be authorized. Held or dropped text cannot become visible through a history lookup.
    const base = `FROM messages m JOIN bots b ON b.id = m.from_bot WHERE m.thread_id = ?
      AND ((m.from_bot = ? AND m.to_bot = ?) OR (m.from_bot = ? AND m.to_bot = ?))
      AND m.sealed IS NULL AND m.group_id IS NULL AND m.body_purged_at IS NULL AND m.status != 'dropped'
      AND coalesce(m.note, '') != 'key_check' AND (m.from_bot = ? OR b.paused_at IS NULL OR m.status = 'delivered')`;
    const args = [id, row.bot_a, row.bot_b, row.bot_b, row.bot_a, me.id];
    const select = `SELECT m.rowid AS seq, m.id, m.kind, m.text, m.links, m.reply_to, m.created_at, m.handoff_id, b.handle ${base}`;
    const render = (m) => m ? { id: m.id, from: `@${m.handle}`, kind: m.kind, text: m.text, links: JSON.parse(m.links || '[]'), reply_to: m.reply_to,
      thread: id, at: new Date(m.created_at).toISOString(), handoff: handoffInfo(m.text) } : null;
    const brief = url?.searchParams.get('brief') === '1';
    const latest = brief ? q(`${select} AND m.handoff_id IS NOT NULL ORDER BY m.rowid DESC LIMIT 1`).get(...args) : null;
    const after = url?.searchParams.get('after');
    let seq = latest?.seq ?? 0;
    if (after) {
      const cursor = q(`SELECT m.rowid AS seq ${base} AND m.id = ?`).get(...args, after);
      if (!cursor) throw new HttpError(400, 'after must be a visible message in this thread');
      seq = Math.max(seq, cursor.seq);
    }
    const rows = q(`${select} AND m.rowid > ? ORDER BY m.rowid LIMIT ?`).all(...args, seq, limit + 1);
    const more = rows.length > limit;
    const messages = rows.slice(0, limit).map(render);
    return { thread, messages, latest_package: render(latest), more, next_after: more ? messages.at(-1).id : null };
  }
  function close(me, id) {
    return tx(() => {
      const row = accessible(me, id);
      if (row.closed_at == null) q("UPDATE task_threads SET state = 'closed', closed_at = ?, expires_at = min(expires_at, ?) WHERE id = ?")
        .run(clock(), clock() + bodyRetentionMs, id);
      return { thread: meta(q('SELECT * FROM task_threads WHERE id = ?').get(id)) };
    });
  }
  return { prepare, record, history, close };
}
