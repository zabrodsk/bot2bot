// Pilot governance. No bot-supplied authority flags are accepted here.
// See GOVERNANCE.md for the API and the owner-only, transaction-compatible helpers.
export function migrateGovernance(db) {
  const add = (table, col, def) => {
    if (db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    return true;
  };
  add('contacts', 'circle_id', 'INTEGER');
  if (add('contacts', 'mode_override', "TEXT CHECK(mode_override IN ('handles','asks'))")) {
    db.exec("UPDATE contacts SET mode_override = 'asks' WHERE privacy_on = 1");
  }
  add('contacts', 'purpose', 'TEXT');
  add('contacts', 'notes', 'TEXT');
  add('messages', 'privacy_request_id', 'TEXT');
  // The basket an invite puts the new friend in, picked by whoever made it.
  add('invites', 'basket', 'TEXT');
  // What the inviter told their bot about the new friend, saved on the contact once they're connected.
  add('invites', 'notes', 'TEXT');
  db.exec(`
    CREATE TABLE IF NOT EXISTS governance_flags (name TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS circles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, owner_bot INTEGER NOT NULL, name TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('handles','asks')), is_default INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contact_rules (
      id TEXT PRIMARY KEY, owner_bot INTEGER NOT NULL, peer_bot INTEGER NOT NULL, text TEXT NOT NULL,
      topic TEXT, days TEXT, answer TEXT CHECK(answer IN ('share','decline','ask')),
      source TEXT NOT NULL CHECK(source IN ('owner','learned')), created_at INTEGER NOT NULL,
      removed_at INTEGER, announced_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS learned_rule ON contact_rules(owner_bot, peer_bot, topic, days, answer)
      WHERE source = 'learned' AND removed_at IS NULL;
    CREATE TABLE IF NOT EXISTS owner_decisions (
      id TEXT PRIMARY KEY, owner_bot INTEGER NOT NULL, peer_bot INTEGER NOT NULL, topic TEXT NOT NULL,
      answer TEXT NOT NULL CHECK(answer IN ('share','decline')), weekday TEXT NOT NULL,
      created_at INTEGER NOT NULL, via TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings_proposals (
      id TEXT PRIMARY KEY, owner_bot INTEGER NOT NULL, ops TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('PENDING_OWNER','APPROVED','DECLINED','EXPIRED')),
      created_at INTEGER NOT NULL, decided_at INTEGER, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS privacy_requests (
      id TEXT PRIMARY KEY, owner_bot INTEGER NOT NULL, peer_bot INTEGER NOT NULL, inbound_message_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('PENDING_OWNER','APPROVED','ENQUEUED','DECLINED','EXPIRED','CANCELLED')),
      revision INTEGER NOT NULL, contact_gen INTEGER NOT NULL, question TEXT, expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, decided_at INTEGER, outbound_message_id TEXT, approval_used_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS request_inbound ON privacy_requests(owner_bot, inbound_message_id)
      WHERE inbound_message_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS privacy_candidates (
      request_id TEXT NOT NULL, revision INTEGER NOT NULL, text TEXT NOT NULL, links TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(request_id, revision)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS message_request ON messages(privacy_request_id) WHERE privacy_request_id IS NOT NULL;
    -- Existing key/block/pause/remove paths already bump gen. Cancel in their transaction too.
    CREATE TRIGGER IF NOT EXISTS cancel_governance_gen AFTER UPDATE OF gen ON contacts
      WHEN old.gen != new.gen BEGIN
      UPDATE privacy_requests SET state = 'CANCELLED', decided_at = coalesce(decided_at, new.gen)
        WHERE owner_bot = new.owner_bot AND peer_bot = new.peer_bot AND state IN ('PENDING_OWNER','APPROVED');
    END;
    CREATE TRIGGER IF NOT EXISTS cancel_governance_remove AFTER DELETE ON contacts BEGIN
      UPDATE privacy_requests SET state = 'CANCELLED', decided_at = coalesce(decided_at, old.gen)
        WHERE owner_bot = old.owner_bot AND peer_bot = old.peer_bot AND state IN ('PENDING_OWNER','APPROVED');
    END;
  `);
  // Upgrade Part S databases without recycling deleted circle IDs.
  if (!/AUTOINCREMENT/i.test(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'circles'").get().sql)) {
    db.exec(`BEGIN IMMEDIATE;
      DROP INDEX IF EXISTS circles_name;
      ALTER TABLE circles RENAME TO circles_old;
      CREATE TABLE circles (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_bot INTEGER NOT NULL, name TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('handles','asks')), is_default INTEGER NOT NULL DEFAULT 0,
        position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      INSERT INTO circles SELECT * FROM circles_old;
      DROP TABLE circles_old;
      COMMIT;`);
  }
  add('circles', 'name_key', 'TEXT');
  db.exec('DROP INDEX IF EXISTS circles_name');
  const usedNames = new Set();
  for (const c of db.prepare('SELECT * FROM circles ORDER BY id').all()) {
    let name = c.name, key = name.normalize('NFC').toLocaleLowerCase(), attempt = 0;
    while (usedNames.has(`${c.owner_bot}:${key}`) || /^\p{N}+$/u.test(name)) {
      const suffix = ` basket ${c.id}${attempt ? ` ${attempt}` : ''}`;
      name = `${[...c.name].slice(0, 24 - suffix.length).join('')}${suffix}`;
      key = name.normalize('NFC').toLocaleLowerCase();
      attempt++;
    }
    usedNames.add(`${c.owner_bot}:${key}`);
    db.prepare('UPDATE circles SET name = ?, name_key = ? WHERE id = ?').run(name, key, c.id);
  }
  db.exec('DROP INDEX IF EXISTS circles_name; CREATE UNIQUE INDEX IF NOT EXISTS circles_name_key ON circles(owner_bot, name_key)');
  add('settings_proposals', 'widening', "TEXT NOT NULL DEFAULT '[]'");
  add('contact_rules', 'via', "TEXT NOT NULL DEFAULT 'owner'");
  add('contact_rules', 'owner_seen_at', 'INTEGER');
  add('owner_decisions', 'local_date', 'TEXT');
  add('owner_decisions', 'client_id', 'TEXT');
  add('owner_decisions', 'payload', 'TEXT');
  add('owner_decisions', 'result', 'TEXT');
  // Historical rows use the owner's current timezone, then keep that local date permanently.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) for (const r of db.prepare(`SELECT d.id, d.created_at, u.tz FROM owner_decisions d
    JOIN bots b ON b.id = d.owner_bot LEFT JOIN users u ON u.id = b.user_id WHERE d.local_date IS NULL`).all()) {
    db.prepare('UPDATE owner_decisions SET local_date = ? WHERE id = ?').run(
      new Intl.DateTimeFormat('en-CA', { timeZone: r.tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(r.created_at)), r.id);
  }
  // What a reply waiting for its owner is about, so the owner's answer teaches the bot.
  add('privacy_requests', 'topic', 'TEXT');
  add('privacy_requests', 'decided_via', 'TEXT');
  add('settings_proposals', 'decided_via', 'TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS decision_client ON owner_decisions(owner_bot, client_id) WHERE client_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS decision_learning ON owner_decisions(owner_bot, peer_bot, topic, answer, weekday, created_at);
    CREATE INDEX IF NOT EXISTS proposal_pending ON settings_proposals(owner_bot, state);`);
}

const DAY = 86_400_000;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const TOPIC = /^[\p{L}\p{N}][\p{L}\p{N} '&-]{0,39}$/u;
export function createGovernance({ db, q, tx, clock, token, HttpError, publicUrl, privacyPilot,
  resolveRecipient, enqueue, bumpGen, bumpPair, dropBetween, release, ring, L }) {
  const fail = (message, status = 400) => { throw new HttpError(status, message); };
  const bot = (id) => q('SELECT * FROM bots WHERE id = ?').get(id) || fail('bot not found', 404);
  const emails = new Set((Array.isArray(privacyPilot) ? privacyPilot : []).map((s) => String(s).trim().toLowerCase()));
  function inPilot(userOrBot) {
    if (!userOrBot) return false;
    const row = typeof userOrBot === 'number' ? bot(userOrBot) : userOrBot;
    if ('user_id' in row && !row.user_id) return false;
    if (privacyPilot === true) return true;
    const email = row.email ?? (row.user_id ? q('SELECT email FROM users WHERE id = ?').get(row.user_id)?.email : null);
    return typeof email === 'string' && emails.has(email.toLowerCase());
  }
  const requirePilot = (me) => { if (!inPilot(me)) fail('not found', 404); };
  const requireTx = () => { if (!db.isTransaction) throw new Error('governance helper requires a transaction'); };
  function effectiveMode(c, pilot = inPilot(c?.owner_bot)) {
    if (!c) return 'asks';
    if (!pilot) return c.privacy_on ? 'asks' : 'handles';
    return c.mode_override ?? (c.circle_id ? q('SELECT mode FROM circles WHERE id = ? AND owner_bot = ?').get(c.circle_id, c.owner_bot)?.mode : null) ?? 'asks';
  }
  function ensureCircles(ownerBot, pilot = inPilot(ownerBot)) {
    if (!pilot) return;
    for (const [position, name] of ['family', 'friends', 'work'].entries()) {
      q(`INSERT INTO circles(owner_bot, name, name_key, mode, is_default, position, created_at)
         SELECT ?, ?, ?, 'handles', 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM circles WHERE owner_bot = ? AND is_default = 1 AND position = ?)`)
        .run(ownerBot, name, nameKey(name), position, clock(), ownerBot, position);
    }
  }
  const contacts = (id) => q('SELECT * FROM contacts WHERE owner_bot = ?').all(id);
  // Picking a basket while inviting or accepting: the friend starts there instead of "not sorted yet".
  function basketName(ownerBot, value) {
    if (value == null || value === '' || !inPilot(ownerBot)) return null;
    ensureCircles(ownerBot, true);
    const g = typeof value === 'string' ? q('SELECT name FROM circles WHERE owner_bot = ? AND name_key = ?').get(ownerBot, nameKey(value.trim())) : null;
    if (g) return g.name;
    const names = q('SELECT name FROM circles WHERE owner_bot = ? ORDER BY position, id').all(ownerBot).map((x) => x.name);
    return fail(`basket not found; the baskets are ${names.join(', ')}`, 404);
  }
  function placeInBasket(ownerBot, peerBot, name) {
    requireTx();
    if (!name || !inPilot(ownerBot)) return;
    const g = q('SELECT * FROM circles WHERE owner_bot = ? AND name_key = ?').get(ownerBot, nameKey(name));
    if (!g) return; // removed since the invite was made: the friend starts not sorted yet
    q('UPDATE contacts SET circle_id = ?, privacy_on = ? WHERE owner_bot = ? AND peer_bot = ?').run(g.id, g.mode === 'asks' ? 1 : 0, ownerBot, peerBot);
  }
  const nameKey = (v) => v.normalize('NFC').toLocaleLowerCase();
  const circleName = (v) => { const n = string(v, 24, 'name').normalize('NFC'); if (/^\p{N}+$/u.test(n)) fail('circle name cannot be all digits'); return n; };
  const circle = (id, value) => (typeof value === 'number'
    ? q('SELECT * FROM circles WHERE owner_bot = ? AND id = ?').get(id, value)
    : typeof value === 'string' ? q('SELECT * FROM circles WHERE owner_bot = ? AND name_key = ?').get(id, nameKey(value)) : null) || fail('circle not found', 404);
  // One join computes a whole owner's modes. Batch callers resolve pilot membership once.
  const contactModes = (id, pilot) => q(`SELECT c.*, g.mode AS circle_mode FROM contacts c
    LEFT JOIN circles g ON g.id = c.circle_id AND g.owner_bot = c.owner_bot WHERE c.owner_bot = ?`).all(id)
    .map((c) => ({ ...c, effective_mode: pilot ? c.mode_override ?? c.circle_mode ?? 'asks' : c.privacy_on ? 'asks' : 'handles' }));
  function peer(me, value) {
    const c = typeof value === 'number'
      ? q('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(me.id, value)
      : q(`SELECT c.* FROM contacts c JOIN bots b ON b.id = c.peer_bot WHERE c.owner_bot = ?
           AND (lower(c.alias) = lower(?) OR ('@' || b.handle) = lower(?))`).get(me.id, String(value), String(value));
    return c || fail('contact not found', 404);
  }
  function string(value, max, name, empty = false) {
    if (typeof value !== 'string' || (!empty && !value.trim()) || [...value].length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`${name} must be ${empty ? 'up to' : '1 to'} ${max} characters`);
    return value.trim();
  }
  const mode = (v, nullable = false) => ['handles', 'asks', ...(nullable ? [null] : [])].includes(v) ? v : fail('mode must be handles or asks' + (nullable ? ' or null' : ''));
  const bool = (v) => typeof v === 'boolean' ? v : fail('on must be a boolean');
  const topic = (v) => { if (typeof v !== 'string' || !TOPIC.test(v.trim().toLowerCase())) fail('topic must be a short word or phrase, up to 40 characters'); return v.trim().toLowerCase(); };
  function days(v) {
    if (!Array.isArray(v) || !v.length || v.length > 7 || v.some((d) => !DAYS.includes(d)) || new Set(v).size !== v.length) fail('days must be distinct days from mon to sun');
    return [...v].sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
  }
  function rule(id, value) {
    if (typeof value !== 'string') fail('rule must be a rule ID');
    return q('SELECT * FROM contact_rules WHERE owner_bot = ? AND id = ? AND removed_at IS NULL').get(id, value) || fail('rule not found', 404);
  }
  function expire(t = clock()) {
    q("UPDATE privacy_requests SET state = 'EXPIRED', decided_at = ? WHERE state IN ('PENDING_OWNER','APPROVED') AND expires_at <= ?").run(t, t);
    q(`UPDATE privacy_requests SET state = 'CANCELLED', decided_at = ? WHERE state IN ('PENDING_OWNER','APPROVED')
       AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.owner_bot = privacy_requests.owner_bot AND c.peer_bot = privacy_requests.peer_bot AND c.gen = privacy_requests.contact_gen)`).run(t);
    q("UPDATE settings_proposals SET state = 'EXPIRED', decided_at = ? WHERE state = 'PENDING_OWNER' AND expires_at <= ?").run(t, t);
  }
  function retention(t) {
    expire(t);
    q('DELETE FROM owner_decisions WHERE created_at < ?').run(t - 60 * DAY);
    q("DELETE FROM settings_proposals WHERE state != 'PENDING_OWNER' AND (CASE WHEN state = 'EXPIRED' THEN expires_at ELSE decided_at END) < ?").run(t - 7 * DAY);
    q("UPDATE privacy_requests SET question = NULL WHERE state NOT IN ('PENDING_OWNER','APPROVED') AND decided_at < ?").run(t - 7 * DAY);
    q(`DELETE FROM privacy_candidates WHERE request_id IN
      (SELECT id FROM privacy_requests WHERE state NOT IN ('PENDING_OWNER','APPROVED') AND decided_at < ?)` ).run(t - 7 * DAY);
  }
  // Mutates only the current transaction, including during savepoint classification.
  function applyOp(me, input, authority) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('each op must be an object');
    const op = input.op;
    const id = me.id;
    let widening = false, out = { op };
    const c = ['move', 'rename', 'set_purpose', 'set_notes', 'add_topic', 'remove_topic', 'add_rule', 'block'].includes(op) || (op === 'set_mode' && input.contact != null) ? peer(me, input.contact) : null;
    if (c) out.contact = c.peer_bot;
    if (input.circle != null && op !== 'add_circle') {
      const g = circle(id, input.circle);
      if (input.circle_name != null && input.circle_name !== g.name) fail('this change now affects more people, look at it again', 409);
      out.circle_name = g.name;
    }
    switch (op) {
      case 'move': {
        const group = input.circle === null ? null : circle(id, input.circle);
        out.circle = group?.id ?? null;
        q('UPDATE contacts SET circle_id = ? WHERE owner_bot = ? AND peer_bot = ?').run(out.circle, id, c.peer_bot);
        break;
      }
      case 'set_mode': {
        out.mode = mode(input.mode, !!c);
        if (c) q('UPDATE contacts SET mode_override = ? WHERE owner_bot = ? AND peer_bot = ?').run(out.mode, id, c.peer_bot);
        else { out.circle = circle(id, input.circle).id; q('UPDATE circles SET mode = ? WHERE id = ?').run(out.mode, out.circle); }
        break;
      }
      case 'add_circle': {
        out.name = circleName(input.name); out.mode = mode(input.mode ?? 'handles');
        if (q('SELECT count(*) AS n FROM circles WHERE owner_bot = ?').get(id).n >= 12) fail('at most 12 circles');
        if (q('SELECT 1 FROM circles WHERE owner_bot = ? AND name_key = ?').get(id, nameKey(out.name))) fail('circle name already exists', 409);
        const result = q('INSERT INTO circles(owner_bot, name, name_key, mode, position, created_at) VALUES (?, ?, ?, ?, (SELECT coalesce(max(position), -1) + 1 FROM circles WHERE owner_bot = ?), ?)').run(id, out.name, nameKey(out.name), out.mode, id, clock());
        out.id = Number(result.lastInsertRowid);
        break;
      }
      case 'rename_circle': {
        out.circle = circle(id, input.circle).id; out.name = circleName(input.name);
        if (q('SELECT 1 FROM circles WHERE owner_bot = ? AND name_key = ? AND id != ?').get(id, nameKey(out.name), out.circle)) fail('circle name already exists', 409);
        q('UPDATE circles SET name = ?, name_key = ? WHERE id = ?').run(out.name, nameKey(out.name), out.circle); break;
      }
      case 'delete_circle': {
        const group = circle(id, input.circle); if (group.is_default) fail('default circles cannot be deleted');
        out.circle = group.id;
        q('UPDATE contacts SET circle_id = NULL WHERE owner_bot = ? AND circle_id = ?').run(id, group.id);
        q('DELETE FROM circles WHERE id = ?').run(group.id); break;
      }
      // What the owner calls them: the name their bot uses for this person, changeable any time.
      case 'rename': {
        out.name = String(input.name ?? '').normalize('NFC').trim();
        if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,31}$/u.test(out.name)) fail('a name is 1-32 letters or numbers');
        if (q('SELECT 1 FROM contacts WHERE owner_bot = ? AND lower(alias) = lower(?) AND peer_bot != ?').get(id, out.name, c.peer_bot)) fail(`you already have someone called "${out.name}"`, 409);
        q('UPDATE contacts SET alias = ? WHERE owner_bot = ? AND peer_bot = ?').run(out.name, id, c.peer_bot); break;
      }
      case 'set_purpose': case 'set_notes': {
        const field = op === 'set_purpose' ? 'purpose' : 'notes';
        out[field] = input[field] === null ? null : string(input[field], field === 'purpose' ? 60 : 280, field, true);
        q(`UPDATE contacts SET ${field} = ? WHERE owner_bot = ? AND peer_bot = ?`).run(out[field], id, c.peer_bot); break;
      }
      case 'add_topic': case 'remove_topic': {
        out.topic = topic(input.topic);
        const before = JSON.parse(c.can_ask || '[]');
        const after = op === 'add_topic' ? [...new Set([...before, out.topic])] : before.filter((t) => t !== out.topic);
        if (after.length > 10) fail('at most 10 topics');
        widening = after.some((t) => !before.includes(t));
        q('UPDATE contacts SET can_ask = ? WHERE owner_bot = ? AND peer_bot = ?').run(JSON.stringify(after), id, c.peer_bot); break;
      }
      case 'add_rule': {
        out.text = string(input.text, 200, 'rule text');
        out.topic = input.topic == null ? null : topic(input.topic);
        out.days = input.days == null ? null : days(input.days);
        out.answer = input.answer ?? 'ask'; if (!['share', 'decline', 'ask'].includes(out.answer)) fail('answer must be share, decline or ask');
        out.id = token('rule_', 9);
        q(`INSERT INTO contact_rules(id, owner_bot, peer_bot, text, topic, days, answer, source, created_at, via)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'owner', ?, ?)`).run(out.id, id, c.peer_bot, out.text, out.topic, out.days ? JSON.stringify(out.days) : null, out.answer, clock(), authority); break;
      }
      case 'remove_rule': {
        const r = rule(id, input.rule); out.rule = r.id; out.contact = r.peer_bot; widening = r.source === 'owner' && r.via !== 'bot';
        q('UPDATE contact_rules SET removed_at = ? WHERE id = ?').run(clock(), r.id); break;
      }
      case 'block': {
        out.on = bool(input.on); widening = !out.on && !!c.blocked;
        if (!!c.blocked !== out.on) {
          q('UPDATE contacts SET blocked = ? WHERE owner_bot = ? AND peer_bot = ?').run(out.on ? 1 : 0, id, c.peer_bot);
          bumpPair(id, c.peer_bot); if (out.on) dropBetween(id, c.peer_bot);
        }
        break;
      }
      case 'pause': {
        out.on = bool(input.on); widening = !out.on && !!me.paused_at;
        // Pause applies to all the owner's bots, just like the existing dashboard.
        const owned = me.user_id ? q('SELECT * FROM bots WHERE user_id = ? AND disconnected_at IS NULL').all(me.user_id) : [me];
        widening = !out.on && owned.some((b) => !!b.paused_at);
        for (const b of owned) if (!!b.paused_at !== out.on) {
          bumpGen(b.id); q('UPDATE bots SET paused_at = ? WHERE id = ?').run(out.on ? clock() : null, b.id);
        }
        break;
      }
      case 'quiet_hours': {
        if (!me.user_id) fail('quiet hours need an owner account');
        out.on = bool(input.on); out.start = input.start; out.end = input.end; out.tz = input.tz;
        if (![out.start, out.end].every((n) => Number.isInteger(n) && n >= 0 && n < 1440)) fail('quiet hours start and end must be minutes from midnight');
        try { if (typeof out.tz !== 'string') throw Error(); new Intl.DateTimeFormat('en', { timeZone: out.tz }); } catch { fail('invalid time zone'); }
        q('UPDATE users SET quiet_on = ?, quiet_start = ?, quiet_end = ?, tz = ? WHERE id = ?').run(out.on ? 1 : 0, out.start, out.end, out.tz, me.user_id); break;
      }
      case 'ack_learned': {
        if (!Array.isArray(input.ids) || input.ids.length > 100 || input.ids.some((v) => typeof v !== 'string')) fail('ids must be up to 100 learned rule IDs');
        out.ids = [...new Set(input.ids)];
        for (const rid of out.ids) {
          const r = rule(id, rid); if (r.source !== 'learned') fail('only learned rules can be acknowledged');
          q('UPDATE contact_rules SET announced_at = coalesce(announced_at, ?) WHERE id = ?').run(clock(), rid);
        }
        break;
      }
      default: fail('unknown settings op; use move, rename, set_mode, add_circle, rename_circle, delete_circle, set_purpose, set_notes, add_topic, remove_topic, add_rule, remove_rule, block, pause, quiet_hours or ack_learned');
    }
    return { out, widening };
  }
  function applySettingsInTx(ownerBot, ops, { authority = 'bot', collect = null, pilot = inPilot(ownerBot) } = {}) {
    requireTx();
    let me = bot(ownerBot); if (!pilot) fail('not found', 404); ensureCircles(me.id, pilot); expire();
    if (!['bot', 'owner'].includes(authority)) fail('invalid authority');
    if (!Array.isArray(ops) || !ops.length || ops.length > 100) fail('ops must contain 1 to 100 operations');
    const applied = [], proposed = [], affected = new Map();
    const startingGens = new Map(q('SELECT owner_bot, peer_bot, gen FROM contacts WHERE owner_bot IN (SELECT id FROM bots WHERE user_id = ?)').all(me.user_id).map((c) => [`${c.owner_bot}:${c.peer_bot}`, c.gen]));
    const addAffected = (c) => affected.set(`${c.owner_bot}:${c.peer_bot}`, { owner_bot: c.owner_bot, peer_bot: c.peer_bot, gen: startingGens.get(`${c.owner_bot}:${c.peer_bot}`) ?? c.gen });
    for (const input of ops) {
      me = bot(ownerBot);
      const before = new Map(contactModes(me.id, pilot).map((c) => [c.peer_bot, c]));
      // Resuming covers every bot owned by this person, including their contacts.
      const pausedContacts = input.op === 'pause' && input.on === false
        ? q(`SELECT c.* FROM contacts c JOIN bots b ON b.id = c.owner_bot
            WHERE b.paused_at IS NOT NULL AND b.disconnected_at IS NULL AND b.user_id = ?`).all(me.user_id) : [];
      db.exec('SAVEPOINT governance_op');
      try {
        const result = applyOp(me, input, authority);
        const changed = contactModes(me.id, pilot).filter((c) => before.get(c.peer_bot)?.effective_mode !== c.effective_mode);
        const widened = changed.filter((c) => before.get(c.peer_bot)?.effective_mode === 'asks' && c.effective_mode === 'handles');
        const widening = result.widening || widened.length > 0;
        if (widening) {
          for (const c of widened) addAffected(before.get(c.peer_bot));
          if (result.widening && result.out.contact != null) addAffected(before.get(result.out.contact));
          for (const c of pausedContacts) addAffected(c);
        }
        if (widening && authority === 'bot') {
          db.exec('ROLLBACK TO governance_op'); proposed.push(result.out);
        } else {
          for (const c of changed) {
            q('UPDATE contacts SET privacy_on = ? WHERE owner_bot = ? AND peer_bot = ?').run(c.effective_mode === 'asks' ? 1 : 0, me.id, c.peer_bot);
            bumpPair(me.id, c.peer_bot);
          }
          applied.push(result.out);
        }
        db.exec('RELEASE governance_op');
      } catch (e) { db.exec('ROLLBACK TO governance_op'); db.exec('RELEASE governance_op'); throw e; }
    }
    if (collect) collect.push(...affected.values());
    let proposal = null;
    if (proposed.length) {
      for (const op of proposed) if (op.circle != null) op.circle_name = circle(me.id, op.circle).name;
      const opsJson = JSON.stringify(proposed);
      // Bind to the final safe state of this batch, before any future owner changes.
      const preview = [];
      db.exec('SAVEPOINT governance_preview');
      try { applySettingsInTx(ownerBot, proposed, { authority: 'owner', collect: preview, pilot }); }
      finally { db.exec('ROLLBACK TO governance_preview'); db.exec('RELEASE governance_preview'); }
      const widening = JSON.stringify(preview);
      const existing = q("SELECT id FROM settings_proposals WHERE owner_bot = ? AND ops = ? AND widening = ? AND state = 'PENDING_OWNER'").get(me.id, opsJson, widening);
      const id = existing?.id ?? token('prop_', 9);
      if (!existing) {
        if (q("SELECT count(*) AS n FROM settings_proposals WHERE owner_bot = ? AND state = 'PENDING_OWNER'").get(me.id).n >= 20) fail('at most 20 pending proposals', 409);
        q("INSERT INTO settings_proposals(id, owner_bot, ops, widening, state, created_at, expires_at) VALUES (?, ?, ?, ?, 'PENDING_OWNER', ?, ?)").run(id, me.id, opsJson, widening, clock(), clock() + 7 * DAY);
      }
      proposal = { id, approve_url: `${publicUrl}/app/proposals/${id}` };
    }
    return { applied, proposal };
  }
  function wakeOwner(ownerBot) {
    const me = bot(ownerBot);
    for (const b of me.user_id ? q('SELECT id FROM bots WHERE user_id = ?').all(me.user_id) : [me]) release(b.id);
  }
  function wakeSettings(ownerBot, result) {
    if (result.applied.some((o) => (o.op === 'pause' || o.op === 'block') && !o.on || o.op === 'quiet_hours')) wakeOwner(ownerBot);
  }
  const applySettings = (id, ops, opts) => { const r = tx(() => applySettingsInTx(id, ops, opts)); wakeSettings(id, r); return r; };
  const applyOwnerOpsInTx = (id, ops) => applySettingsInTx(id, ops, { authority: 'owner' });
  const applyOwnerOps = (id, ops) => applySettings(id, ops, { authority: 'owner' });
  function decideProposalInTx(ownerBot, id, decision) {
    requireTx(); requirePilot(bot(ownerBot)); expire();
    const p = q('SELECT * FROM settings_proposals WHERE id = ? AND owner_bot = ?').get(id, ownerBot) || fail('proposal not found', 404);
    if (p.state !== 'PENDING_OWNER') return { id, state: p.state };
    if (!['approve', 'decline'].includes(decision)) fail('decision must be approve or decline');
    if (decision === 'approve') {
      const current = [], allowed = JSON.parse(p.widening);
      db.exec('SAVEPOINT governance_approval');
      try {
        applySettingsInTx(ownerBot, JSON.parse(p.ops), { authority: 'owner', collect: current });
        // Compare generations from before replay, even if earlier replayed ops bump them.
        if (current.some((c) => !allowed.some((a) => a.owner_bot === c.owner_bot && a.peer_bot === c.peer_bot && a.gen === c.gen))) {
          fail('this change now affects more people, look at it again', 409);
        }
        db.exec('RELEASE governance_approval');
      } catch (e) { db.exec('ROLLBACK TO governance_approval'); db.exec('RELEASE governance_approval'); throw e; }
    }
    const state = decision === 'approve' ? 'APPROVED' : 'DECLINED';
    q('UPDATE settings_proposals SET state = ?, decided_at = ? WHERE id = ?').run(state, clock(), id);
    return { id, state };
  }
  const decideProposal = (ownerBot, id, decision) => { const r = tx(() => decideProposalInTx(ownerBot, id, decision)); wakeOwner(ownerBot); return r; };

  function candidate(draft) {
    if (!draft || typeof draft !== 'object' || Array.isArray(draft) || typeof draft.text !== 'string') fail('draft.text is required');
    const text = draft.text.trim(), links = draft.links ?? [];
    if ((!text && !links.length) || text.length > L.textMax || !Array.isArray(links) || links.length > L.linksMax) fail('draft is empty or too long');
    for (const l of links) {
      let u; try { u = new URL(l); } catch { fail('invalid draft link'); }
      if (typeof l !== 'string' || !['https:', 'http:'].includes(u.protocol) || l.length > L.linkMax) fail('invalid draft link');
    }
    return { text, links };
  }
  const latest = (r) => { const c = q('SELECT * FROM privacy_candidates WHERE request_id = ? AND revision = ?').get(r.id, r.revision); return c ? { text: c.text, links: JSON.parse(c.links) } : null; };
  function requestView(r, owner = false) {
    return { ...r, approve_url: `${publicUrl}/app/requests/${r.id}`, ...(owner || r.state === 'APPROVED' ? { draft: latest(r) } : {}) };
  }
  function getRequest(ownerBot, id, { owner = false } = {}) {
    requirePilot(bot(ownerBot)); expire();
    const r = q('SELECT * FROM privacy_requests WHERE owner_bot = ? AND id = ?').get(ownerBot, id) || fail('request not found', 404);
    return requestView(r, owner);
  }
  function openRequests(ownerBot, { owner = false, pilot = inPilot(ownerBot) } = {}) {
    if (!pilot) fail('not found', 404); expire();
    return q("SELECT * FROM privacy_requests WHERE owner_bot = ? AND state IN ('PENDING_OWNER','APPROVED') ORDER BY created_at, id").all(ownerBot).map((r) => requestView(r, owner));
  }
  function proposeReplyInTx(ownerBot, body) {
    requireTx(); const me = bot(ownerBot); requirePilot(me); expire();
    if (!body || (body.inbound_message_id != null && body.to != null)) fail('supply inbound_message_id or to');
    let c, inbound = null;
    if (body.inbound_message_id != null) {
      if (typeof body.inbound_message_id !== 'string') fail('inbound_message_id must be a message ID');
      const m = q("SELECT * FROM messages WHERE id = ? AND to_bot = ? AND kind != 'probe'").get(body.inbound_message_id, ownerBot) || fail('inbound message not found', 404);
      const b = bot(m.from_bot); c = resolveRecipient(me, `@${b.handle}`); inbound = m.id;
    } else c = resolveRecipient(me, body.to);
    const draft = candidate(body.draft);
    const question = body.question == null ? null : string(body.question, 280, 'question', true);
    const about = body.topic == null ? null : topic(body.topic);
    let r = inbound
      ? q('SELECT * FROM privacy_requests WHERE owner_bot = ? AND inbound_message_id = ?').get(ownerBot, inbound)
      : q("SELECT * FROM privacy_requests WHERE owner_bot = ? AND peer_bot = ? AND inbound_message_id IS NULL AND state IN ('PENDING_OWNER','APPROVED','CANCELLED','EXPIRED') ORDER BY created_at DESC, id LIMIT 1").get(ownerBot, c.peer_bot);
    if (r && !['PENDING_OWNER', 'CANCELLED', 'EXPIRED'].includes(r.state)) fail('request is already decided', 409);
    if (r && r.state === 'PENDING_OWNER' && JSON.stringify(latest(r)) === JSON.stringify(draft)) return requestView(r);
    if (!r) {
      const id = token('req_', 9);
      q(`INSERT INTO privacy_requests(id, owner_bot, peer_bot, inbound_message_id, state, revision, contact_gen, question, topic, expires_at, created_at)
        VALUES (?, ?, ?, ?, 'PENDING_OWNER', 1, ?, ?, ?, ?, ?)`).run(id, ownerBot, c.peer_bot, inbound, c.gen, question, about, clock() + DAY, clock());
      r = q('SELECT * FROM privacy_requests WHERE id = ?').get(id);
    } else {
      q("UPDATE privacy_requests SET revision = revision + 1, contact_gen = ?, expires_at = CASE WHEN state IN ('CANCELLED','EXPIRED') THEN ? ELSE expires_at END, state = 'PENDING_OWNER', decided_at = NULL, question = ?, topic = ? WHERE id = ?").run(c.gen, clock() + DAY, question, about, r.id);
      r = q('SELECT * FROM privacy_requests WHERE id = ?').get(r.id);
    }
    q('INSERT INTO privacy_candidates(request_id, revision, text, links, created_at) VALUES (?, ?, ?, ?, ?)').run(r.id, r.revision, draft.text, JSON.stringify(draft.links), clock());
    return requestView(r);
  }
  function decideRequestInTx(ownerBot, id, decision) {
    requireTx(); const me = bot(ownerBot); requirePilot(me); expire();
    let r = q('SELECT * FROM privacy_requests WHERE owner_bot = ? AND id = ?').get(ownerBot, id) || fail('request not found', 404);
    // Check recorded outcomes first, including a lost response from another device.
    if (r.state !== 'PENDING_OWNER') return requestView(r, true);
    if (!decision || !['send', 'edit', 'write', 'decline'].includes(decision.action)) fail('action must be send, edit, write or decline');
    if (!Number.isInteger(decision.revision) || decision.revision !== r.revision) fail('request revision changed; review the current draft', 409);
    const c = resolveRecipient(me, `@${bot(r.peer_bot).handle}`);
    // The owner's answer is a decision like one reported from chat: it becomes one of the bot's past answers.
    // Their own words could say yes or no, so "write my own" teaches nothing.
    if (r.topic && decision.action !== 'write') recordDecisionInTx(ownerBot, { contact: `@${bot(r.peer_bot).handle}`, topic: r.topic, answer: decision.action === 'decline' ? 'decline' : 'share', client_id: `request:${id}` }, 'owner_request');
    if (decision.action === 'decline') {
      q("UPDATE privacy_requests SET state = 'DECLINED', decided_at = ? WHERE id = ?").run(clock(), id);
      return getRequest(ownerBot, id, { owner: true });
    }
    const final = decision.action === 'send' ? latest(r) : candidate(decision.draft);
    if (decision.action !== 'send') {
      q('UPDATE privacy_requests SET revision = revision + 1 WHERE id = ?').run(id);
      r = q('SELECT * FROM privacy_requests WHERE id = ?').get(id);
      q('INSERT INTO privacy_candidates(request_id, revision, text, links, created_at) VALUES (?, ?, ?, ?, ?)').run(id, r.revision, final.text, JSON.stringify(final.links), clock());
    }
    if (me.box_pub && bot(c.peer_bot).box_pub) {
      q("UPDATE privacy_requests SET state = 'APPROVED', decided_at = ? WHERE id = ?").run(clock(), id);
    } else {
      const sent = enqueue(me, { to: `@${bot(c.peer_bot).handle}`, ...final, ...(r.inbound_message_id ? { kind: 'reply', reply_to: r.inbound_message_id } : {}), client_id: `privacy:${id}` }, { actor: 'owner_decision', decisionId: id });
      q("UPDATE privacy_requests SET state = 'ENQUEUED', decided_at = ?, outbound_message_id = ?, approval_used_at = ? WHERE id = ?").run(clock(), sent.id, clock(), id);
      q('UPDATE messages SET privacy_request_id = ? WHERE id = ?').run(id, sent.id);
      q('DELETE FROM privacy_candidates WHERE request_id = ?').run(id);
    }
    return getRequest(ownerBot, id, { owner: true });
  }
  function wakeRequest(r) {
    if (db.isTransaction) throw new Error('wakeRequest must run after commit');
    if (r.state === 'ENQUEUED') release(r.peer_bot);
    if (r.state === 'APPROVED') void ring(bot(r.owner_bot), 'approval');
  }
  const decideRequest = (ownerBot, id, decision) => { const r = tx(() => decideRequestInTx(ownerBot, id, decision)); wakeRequest(r); return r; };
  function checkApproval(me, c, id, body) {
    requireTx();
    const r = typeof id === 'string' ? q('SELECT * FROM privacy_requests WHERE id = ? AND owner_bot = ? AND peer_bot = ?').get(id, me.id, c.peer_bot) : null;
    if (!r || r.state !== 'APPROVED' || r.approval_used_at != null || r.expires_at <= clock() || r.contact_gen !== c.gen) fail('owner_approval_required: approval is missing, expired, changed or already used; use propose_reply', 403);
    if (body.client_id !== `privacy:${id}` || (r.inbound_message_id && (body.kind !== 'reply' || body.reply_to !== r.inbound_message_id))) fail('approval must use its privacy client_id and original reply', 403);
    return r;
  }
  function consumeApproval(r, messageId) {
    requireTx();
    const n = q("UPDATE privacy_requests SET state = 'ENQUEUED', outbound_message_id = ?, approval_used_at = ? WHERE id = ? AND state = 'APPROVED' AND approval_used_at IS NULL").run(messageId, clock(), r.id).changes;
    if (!n) fail('owner approval already used', 409);
    q('UPDATE messages SET privacy_request_id = ? WHERE id = ?').run(r.id, messageId);
    q('DELETE FROM privacy_candidates WHERE request_id = ?').run(r.id);
  }
  function recordDecisionInTx(ownerBot, body, via = 'owner_report') {
    requireTx(); const me = bot(ownerBot); requirePilot(me);
    const c = peer(me, body.contact), t = topic(body.topic);
    if (!['share', 'decline'].includes(body.answer)) fail('answer must be share or decline');
    const always = body.always_days == null ? null : days(body.always_days);
    const user = me.user_id ? q('SELECT * FROM users WHERE id = ?').get(me.user_id) : null;
    const weekday = new Intl.DateTimeFormat('en', { timeZone: user?.tz || 'UTC', weekday: 'short' }).format(new Date(clock())).toLowerCase();
    const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: user?.tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(clock()));
    const clientId = body.client_id == null ? null : string(body.client_id, 64, 'client_id');
    // Owner answers on the requests page use request:<id>; a bot can't take that ID first and block them.
    if (via !== 'owner_request' && clientId?.startsWith('request:')) fail('client_id request:… is reserved');
    const payload = JSON.stringify({ peer: c.peer_bot, topic: t, answer: body.answer, always });
    if (clientId) {
      const previous = q('SELECT * FROM owner_decisions WHERE owner_bot = ? AND client_id = ?').get(me.id, clientId);
      if (previous) { if (previous.payload !== payload) fail('client_id was already used for a different decision', 409); return JSON.parse(previous.result); }
    }
    const id = token('dec_', 9);
    q('INSERT INTO owner_decisions(id, owner_bot, peer_bot, topic, answer, weekday, local_date, created_at, via, client_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, me.id, c.peer_bot, t, body.answer, weekday, localDate, clock(), via, clientId, payload);
    const learned = [];
    // Only an explicit "always" makes a rule. Otherwise the answer is kept as a past answer, and the bot
    // judges from those (settings: past_answers) instead of a fixed count turning into a rule.
    if (always) {
      // One rule per weekday avoids duplicate Wednesday rules.
      for (const d of always) {
        const rid = token('rule_', 9), json = JSON.stringify([d]);
        const answer = body.answer;
        const result = q(`INSERT OR IGNORE INTO contact_rules(id, owner_bot, peer_bot, text, topic, days, answer, source, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'learned', ?)`).run(rid, me.id, c.peer_bot, `${answer === 'share' ? 'Shares' : 'Declines'} ${t} with ${c.alias} on ${d}`, t, json, answer, clock());
        if (result.changes) learned.push(rid);
      }
    }
    const result = { id, learned_rules: learned };
    q('UPDATE owner_decisions SET result = ? WHERE id = ?').run(JSON.stringify(result), id);
    return result;
  }
  const rules = (id, peerId = null) => q(`SELECT * FROM contact_rules WHERE owner_bot = ? AND removed_at IS NULL${peerId == null ? '' : ' AND peer_bot = ?'} ORDER BY created_at, id`).all(id, ...(peerId == null ? [] : [peerId])).map((r) => ({ ...r, days: r.days ? JSON.parse(r.days) : null }));
  // The owner's answers about one person over the last 60 days, per topic and answer, newest first.
  function pastAnswers(ownerBot, peerBot) {
    const out = new Map();
    for (const d of q('SELECT topic, answer, weekday, local_date FROM owner_decisions WHERE owner_bot = ? AND peer_bot = ? AND created_at >= ? ORDER BY created_at DESC, id DESC')
      .all(ownerBot, peerBot, clock() - 60 * DAY)) {
      const k = `${d.topic}\n${d.answer}`;
      const a = out.get(k) ?? out.set(k, { topic: d.topic, answer: d.answer, times: 0, days: [], last: d.local_date }).get(k);
      a.times++; if (!a.days.includes(d.weekday)) a.days.push(d.weekday);
    }
    return [...out.values()].slice(0, 20).map((a) => ({ ...a, days: DAYS.filter((x) => a.days.includes(x)) }));
  }
  function getSettings(ownerBot) {
    const me = bot(ownerBot), pilot = inPilot(me); if (!pilot) fail('not found', 404); ensureCircles(ownerBot, pilot); expire();
    const user = me.user_id ? q('SELECT * FROM users WHERE id = ?').get(me.user_id) : null;
    const circles = q('SELECT * FROM circles WHERE owner_bot = ? ORDER BY position, id').all(ownerBot);
    return {
      circles, contacts: contactModes(ownerBot, pilot).map((c) => ({ peer_bot: c.peer_bot, handle: `@${bot(c.peer_bot).handle}`, alias: c.alias,
        circle: circles.find((g) => g.id === c.circle_id) ?? null, effective_mode: c.effective_mode, mode_override: c.mode_override,
        purpose: c.purpose, notes: c.notes, topics: JSON.parse(c.can_ask || '[]'), rules: rules(ownerBot, c.peer_bot),
        past_answers: pastAnswers(ownerBot, c.peer_bot), blocked: !!c.blocked })),
      quiet_hours: user ? { on: !!user.quiet_on, start: user.quiet_start, end: user.quiet_end, tz: user.tz } : null,
      paused: !!me.paused_at,
      pending_proposals: q("SELECT * FROM settings_proposals WHERE owner_bot = ? AND state = 'PENDING_OWNER' ORDER BY created_at, id").all(ownerBot).map((p) => ({ ...p, ops: JSON.parse(p.ops), approve_url: `${publicUrl}/app/proposals/${p.id}` })),
      new_learned_rules: rules(ownerBot).filter((r) => r.source === 'learned' && r.announced_at == null),
      open_requests: openRequests(ownerBot, { pilot }),
    };
  }
  function exportData(ids) {
    const result = {};
    for (const table of ['circles', 'contact_rules', 'owner_decisions', 'settings_proposals', 'privacy_requests']) {
      result[table] = ids.flatMap((id) => q(`SELECT * FROM ${table} WHERE owner_bot = ?`).all(id));
    }
    result.contacts = ids.flatMap((id) => contacts(id).map(({ owner_bot, peer_bot, circle_id, mode_override, purpose, notes, can_ask }) => ({ owner_bot, peer_bot, circle_id, mode_override, purpose, notes, topics: JSON.parse(can_ask) })));
    result.privacy_candidates = result.privacy_requests.flatMap((r) => q('SELECT * FROM privacy_candidates WHERE request_id = ?').all(r.id));
    return result;
  }
  function deleteDataInTx(ids) {
    requireTx();
    for (const id of ids) {
      q('DELETE FROM privacy_candidates WHERE request_id IN (SELECT id FROM privacy_requests WHERE owner_bot = ? OR peer_bot = ?)').run(id, id);
      for (const table of ['contact_rules', 'owner_decisions', 'privacy_requests']) q(`DELETE FROM ${table} WHERE owner_bot = ? OR peer_bot = ?`).run(id, id);
      q('DELETE FROM circles WHERE owner_bot = ?').run(id);
      // Proposals contain private instructions and references to contacts, so cancel peers' proposals too.
      q("DELETE FROM settings_proposals WHERE owner_bot = ? OR EXISTS (SELECT 1 FROM json_each(ops) WHERE json_extract(value, '$.contact') = ?)").run(id, id);
    }
  }
  // Turning governance on for everyone: people who never had baskets keep how their bot behaved. Their
  // contacts go into friends (the bot handles it), and anyone they protected keeps "asks you first". Once.
  if (privacyPilot === true && !q("SELECT 1 FROM governance_flags WHERE name = 'sorted_existing'").get()) tx(() => {
    for (const b of q('SELECT id FROM bots WHERE user_id IS NOT NULL').all()) {
      if (q('SELECT 1 FROM circles WHERE owner_bot = ?').get(b.id)) continue;
      ensureCircles(b.id, true);
      const friends = q('SELECT id FROM circles WHERE owner_bot = ? AND is_default = 1 AND position = 1').get(b.id).id;
      q("UPDATE contacts SET mode_override = 'asks' WHERE owner_bot = ? AND privacy_on = 1 AND mode_override IS NULL").run(b.id);
      q('UPDATE contacts SET circle_id = ? WHERE owner_bot = ? AND circle_id IS NULL').run(friends, b.id);
    }
    q("INSERT INTO governance_flags(name, at) VALUES ('sorted_existing', ?)").run(clock());
  });
  tx(() => {
    for (const b of q('SELECT * FROM bots WHERE user_id IS NOT NULL').all()) {
      if (!inPilot(b)) continue;
      for (const c of contactModes(b.id, true)) if (!!c.privacy_on !== (c.effective_mode === 'asks')) {
        q('UPDATE contacts SET privacy_on = ? WHERE owner_bot = ? AND peer_bot = ?').run(c.effective_mode === 'asks' ? 1 : 0, b.id, c.peer_bot);
        bumpPair(b.id, c.peer_bot);
      }
    }
  });
  return { inPilot, effectiveMode, ensureCircles, basketName, placeInBasket, expire, retention, getSettings, applySettings, applySettingsInTx,
    applyOwnerOps, applyOwnerOpsInTx, decideProposal, decideProposalInTx, getRequest, openRequests,
    proposeReplyInTx, decideRequest, decideRequestInTx, wakeRequest, wakeOwner, wakeSettings, checkApproval, consumeApproval,
    recordDecisionInTx, exportData, deleteDataInTx };
}
