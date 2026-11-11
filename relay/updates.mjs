// Waiting on an update: something can't happen until a bot runs a newer bot2bot tool (it can't open files yet, it's
// too old to read a group, a contact's rename needs it). Each place that refuses for that reason says so here, once:
// need(bot, version, { waiter, what }). Nothing waits in line: whoever was refused can still send everything else.
//
// - The bot is rung at once (reason "update"), at most once an hour. Its tool updates itself whenever it runs.
// - If its channel's newest tool is still too old, the relay offers it the newest one for this update (tools 0.22.13+).
// - Its next request says which tool it runs. Once that's new enough, each bot that was waiting is rung, and its next
//   inbox says it can go ahead (an okayed draft shows up there to send again anyway).
// - Still not updated after a couple of hours (no doorbell, or it can't update by itself): its owner gets one email
//   saying who's waiting and what to tell the bot.
export function migrateUpdates(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_needs (
      bot_id INTEGER NOT NULL REFERENCES bots(id), waiter_bot INTEGER NOT NULL DEFAULT 0, what TEXT NOT NULL,
      version TEXT NOT NULL, created_at INTEGER NOT NULL, met_at INTEGER, emailed_at INTEGER,
      PRIMARY KEY (bot_id, waiter_bot, what)
    );
    CREATE INDEX IF NOT EXISTS tool_needs_waiter ON tool_needs (waiter_bot, met_at);
  `);
  if (!db.prepare('PRAGMA table_info(bots)').all().some((c) => c.name === 'update_rang_at')) db.exec('ALTER TABLE bots ADD COLUMN update_rang_at INTEGER');
}

export const UPDATE_LIMITS = {
  updateRingGapMs: 3_600_000,         // a bot that needs an update is rung for it at most once an hour
  updateEmailAfterMs: 2 * 3_600_000,  // its owner hears if it still hasn't updated after this
  toolNeedTtlMs: 7 * 86_400_000,      // what was waiting is forgotten after a week, like an unread message
};

export function createUpdates({ q, clock, L, newerVersion, ring, mailer, updateEmail, publicUrl = '', productName = 'bot2bot', siteDir = '', log = () => {} }) {
  const below = (have, want) => !have || newerVersion(want, have);
  const bot = (id) => q('SELECT * FROM bots WHERE id = ?').get(id);

  // Something for this bot waits on its tool being at least `version`. Returns true when it isn't yet.
  function need(botId, version, { waiter = 0, what }) {
    const b = bot(botId);
    if (!b || b.disconnected_at || b.removed_at || !below(b.tool_version, version)) return false;
    const was = q('SELECT version FROM tool_needs WHERE bot_id = ? AND waiter_bot = ? AND what = ?').get(b.id, waiter || 0, what);
    if (!was) q('INSERT INTO tool_needs (bot_id, waiter_bot, what, version, created_at) VALUES (?, ?, ?, ?, ?)').run(b.id, waiter || 0, what, version, clock());
    else q('UPDATE tool_needs SET version = ?, met_at = NULL WHERE bot_id = ? AND waiter_bot = ? AND what = ?')
      .run(newerVersion(version, was.version) ? version : was.version, b.id, waiter || 0, what);
    if (!b.update_rang_at || clock() - b.update_rang_at >= L.updateRingGapMs) {
      q('UPDATE bots SET update_rang_at = ? WHERE id = ?').run(clock(), b.id);
      log(b.id, 'update_needed', { version, what });
      void ring(b, 'update');
    }
    return true;
  }

  // The newest tool version something waits on for this bot (null when nothing does).
  function wanted(b) {
    let top = null;
    for (const r of q('SELECT version FROM tool_needs WHERE bot_id = ? AND met_at IS NULL').all(b.id)) if (below(b.tool_version, r.version) && (!top || newerVersion(r.version, top))) top = r.version;
    return top;
  }

  // A bot said which tool it runs: whatever that's enough for goes ahead, and the bots that waited are rung.
  function seen(b, version) {
    const rows = q('SELECT * FROM tool_needs WHERE bot_id = ? AND met_at IS NULL').all(b.id).filter((r) => !below(version, r.version));
    if (!rows.length) return;
    for (const r of rows) {
      if (r.waiter_bot) q('UPDATE tool_needs SET met_at = ? WHERE bot_id = ? AND waiter_bot = ? AND what = ?').run(clock(), r.bot_id, r.waiter_bot, r.what);
      else q('DELETE FROM tool_needs WHERE bot_id = ? AND waiter_bot = 0 AND what = ?').run(r.bot_id, r.what);
    }
    log(b.id, 'update_done', { version });
    for (const id of new Set(rows.map((r) => r.waiter_bot).filter(Boolean))) {
      const w = bot(id);
      if (w && w.id !== b.id) void ring(w, 'ready');
    }
  }

  // For a waiting bot's inbox (tools that ask): the bots that updated since, each said once.
  function readyFor(me) {
    const rows = q(`SELECT n.what, b.handle, c.alias FROM tool_needs n JOIN bots b ON b.id = n.bot_id
                    LEFT JOIN contacts c ON c.owner_bot = n.waiter_bot AND c.peer_bot = n.bot_id
                    WHERE n.waiter_bot = ? AND n.met_at IS NOT NULL ORDER BY n.met_at LIMIT 20`).all(me.id);
    q('DELETE FROM tool_needs WHERE waiter_bot = ? AND met_at IS NOT NULL').run(me.id);
    return rows.map((r) => ({ to: `@${r.handle}`, name: r.alias ?? `@${r.handle}`, what: r.what }));
  }

  // Once a minute: forget what's a week old, then email the owner of a bot that still hasn't updated.
  let checkedAt = 0;
  async function nudge(t) {
    if (t - checkedAt < 60_000) return;
    checkedAt = t;
    q('DELETE FROM tool_needs WHERE created_at <= ?').run(t - L.toolNeedTtlMs);
    const due = q(`SELECT DISTINCT b.id, b.handle, b.tool_version, u.id AS user_id, u.email, u.lang, u.nudged_at FROM tool_needs n
                   JOIN bots b ON b.id = n.bot_id JOIN users u ON u.id = b.user_id
                   WHERE n.met_at IS NULL AND n.emailed_at IS NULL AND n.waiter_bot != 0 AND n.created_at <= ?
                     AND b.disconnected_at IS NULL AND b.removed_at IS NULL AND b.vendor != 'web'
                     AND u.email_verified_at IS NOT NULL AND (u.nudged_at IS NULL OR u.nudged_at <= ?)`).all(t - L.updateEmailAfterMs, t - L.nudgeGapMs);
    const mailed = new Set();
    for (const b of due) {
      if (mailed.has(b.user_id) || !wanted(b)) continue;
      mailed.add(b.user_id);
      const names = [...new Set(q(`SELECT coalesce(nullif(trim(c.alias), ''), nullif(trim(wu.name), ''), w.display_name, '@' || w.handle) AS who FROM tool_needs n
                   JOIN bots w ON w.id = n.waiter_bot LEFT JOIN users wu ON wu.id = w.user_id LEFT JOIN contacts c ON c.owner_bot = n.bot_id AND c.peer_bot = n.waiter_bot
                   WHERE n.bot_id = ? AND n.met_at IS NULL AND n.waiter_bot != 0 AND w.user_id IS NOT ? ORDER BY n.created_at`).all(b.id, b.user_id).map((r) => r.who))];
      // Marked first, so a slow send is never sent twice.
      q('UPDATE tool_needs SET emailed_at = ? WHERE bot_id = ? AND met_at IS NULL').run(t, b.id);
      q('UPDATE users SET nudged_at = ? WHERE id = ?').run(t, b.user_id);
      try {
        await mailer({ to: b.email, ...updateEmail({ product: productName, handle: b.handle, who: names.slice(0, 3), botUrl: `${publicUrl}/app/bots/${b.id}`, home: publicUrl, logo: siteDir ? `${publicUrl}/icon-192.png` : '', art: publicUrl ? `${publicUrl}/stickers/robot-thinking.png` : '', lang: b.lang }) });
        log(b.id, 'update_notified', {});
      } catch {
        q('UPDATE users SET nudged_at = ? WHERE id = ?').run(b.nudged_at, b.user_id);
        log(b.id, 'update_notify_failed');
      }
    }
  }

  return { need, wanted, seen, readyFor, nudge };
}
