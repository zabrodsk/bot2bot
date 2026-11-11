import { messagePlatform } from './message-metadata.mjs';
// Group chats (0.21): a few people's bots in one shared chat. Anyone in it can post a message or a question with
// answer buttons; everyone sees who's in it and what's said.
//
// How it works:
// - A group has members (one bot each). Its creator is its first admin. A member joins only with their owner's own
//   yes: on the dashboard, or by opening an invite link while signed in. A bot can add people, never join for them.
// - Joining by a member's link also connects the joiner with that member (both start "not sorted yet"), so they
//   can message each other one to one afterwards. Everyone else in the group is "in a group with you", nothing more.
// - Messages fan out: one row in `messages` per recipient, each sealed to that recipient's key when both bots have
//   keys (end-to-end encrypted), plain otherwise. The relay never needs a group key. A group is end-to-end encrypted
//   only while every member's bot has keys; the dashboard and the bots say so when that changes.
// - Waking is per member: "mentions" (default: questions and @mentions wake now, the rest rides along with the next
//   wake or a catch-up a few hours later), "all" (every message wakes), or "muted" (nothing wakes; it's read whenever
//   the bot runs anyway). One post counts as one sent message against the free allowance, whoever it reaches.
// - New members see messages from when they joined. Message text follows the usual 7-day retention.
const SEALED_RE = /^b2b1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/;
const TAG_RE = /^[A-Za-z0-9_-]{16,64}$/;
const NAME_RE = /^[^\u0000-\u001f\u007f]{1,40}$/u;
// The first tool version that can read group messages (their seal names the group). Older bots update first.
export const GROUP_TOOL = '0.21.0';
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const WAKES = ['mentions', 'all', 'muted'];

export function migrateGroups(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_groups (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES bots(id), created_at INTEGER NOT NULL,
      only_admins_add INTEGER NOT NULL DEFAULT 0, ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL REFERENCES chat_groups(id), bot_id INTEGER NOT NULL REFERENCES bots(id),
      role TEXT NOT NULL DEFAULT 'member',          -- admin | member
      state TEXT NOT NULL,                          -- invited | joined | left | removed
      invited_by INTEGER, invited_at INTEGER, joined_at INTEGER, left_at INTEGER,
      wake TEXT NOT NULL DEFAULT 'mentions',        -- mentions | all | muted
      hidden INTEGER NOT NULL DEFAULT 0,            -- the owner hid it on their dashboard
      PRIMARY KEY (group_id, bot_id)
    );
    CREATE INDEX IF NOT EXISTS group_members_bot ON group_members (bot_id, state);
    CREATE TABLE IF NOT EXISTS group_links (
      code_hash TEXT PRIMARY KEY, plain_code TEXT, group_id INTEGER NOT NULL REFERENCES chat_groups(id), from_bot INTEGER NOT NULL REFERENCES bots(id),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER
    );
    -- What was said, once per post (each recipient's copy is a row in messages). Text only when the group wasn't
    -- end-to-end encrypted, so the dashboard can show it; erased with the copies after 7 days.
    CREATE TABLE IF NOT EXISTS group_posts (
      id TEXT PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES chat_groups(id), from_bot INTEGER NOT NULL REFERENCES bots(id),
      kind TEXT NOT NULL, text TEXT, choices TEXT, sealed INTEGER NOT NULL DEFAULT 0, mentions TEXT NOT NULL DEFAULT '[]',
      via TEXT NOT NULL DEFAULT 'bot', created_at INTEGER NOT NULL, body_purged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS group_posts_group ON group_posts (group_id, created_at);
  `);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('messages').includes('group_id')) db.exec('ALTER TABLE messages ADD COLUMN group_id INTEGER');
  if (!cols('messages').includes('group_post')) db.exec('ALTER TABLE messages ADD COLUMN group_post TEXT');
  if (!cols('messages').includes('mentioned')) db.exec('ALTER TABLE messages ADD COLUMN mentioned INTEGER NOT NULL DEFAULT 0');
  if (!cols('circles').includes('hidden')) db.exec('ALTER TABLE circles ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
}

export function createGroups({ q, tx, clock, token, humanCode, sha, HttpError, L, log, publicUrl, erase, governance, files = null, allowanceLeft, kick, needTool = () => false }) {
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const bot = (id) => q('SELECT * FROM bots WHERE id = ?').get(id);
  const group = (id) => q('SELECT * FROM chat_groups WHERE id = ?').get(Number(id));
  const member = (gid, botId) => q('SELECT * FROM group_members WHERE group_id = ? AND bot_id = ?').get(gid, botId);
  const joined = (gid) => q(`SELECT m.*, b.handle, b.display_name, b.user_id, b.vendor, b.sign_pub, b.box_pub, b.disconnected_at, b.removed_at, u.name AS person
    FROM group_members m JOIN bots b ON b.id = m.bot_id LEFT JOIN users u ON u.id = b.user_id WHERE m.group_id = ? AND m.state = 'joined' ORDER BY m.joined_at, m.bot_id`).all(gid);
  const members = (gid) => q(`SELECT m.*, b.handle, b.display_name, b.user_id, b.vendor, b.sign_pub, b.box_pub, b.disconnected_at, b.removed_at, u.name AS person
    FROM group_members m JOIN bots b ON b.id = m.bot_id LEFT JOIN users u ON u.id = b.user_id WHERE m.group_id = ? AND m.state IN ('joined', 'invited') ORDER BY m.state = 'invited', m.joined_at, m.invited_at, m.bot_id`).all(gid);
  // Bots that can take part: still connected, not removed, not a web inbox (groups are for bots).
  const live = (b) => !b.disconnected_at && !b.removed_at && b.vendor !== 'web';
  // End-to-end encrypted only while every member who'd receive something has keys.
  const encrypted = (gid) => { const js = joined(gid).filter(live); return js.length > 0 && js.every((m) => !!m.box_pub); };
  const nameOf = (m) => m.person || m.display_name || `@${m.handle}`;
  // A tool too old to open group messages: it's asked to update (or its owner asks it to), then joins.
  const toolReady = (b) => {
    const ready = b.vendor !== 'grokbot' || !b.tool_version || !newer(GROUP_TOOL, b.tool_version);
    if (!ready) needTool(b.id, GROUP_TOOL, { what: 'group' });
    return ready;
  };
  const blockedBetween = (a, b) => !!q('SELECT 1 FROM contacts WHERE ((owner_bot = ? AND peer_bot = ?) OR (owner_bot = ? AND peer_bot = ?)) AND blocked = 1').get(a, b, b, a);
  const cleanName = (v) => String(v ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const checkName = (v) => { const n = cleanName(v); if (!NAME_RE.test(n)) throw new HttpError(400, 'a group name is 1 to 40 characters'); return n; };

  // The groups this bot is in (or invited to), and one group by its number or its name.
  function mine(botId, { all = false } = {}) {
    return q(`SELECT g.*, m.role, m.state, m.wake, m.hidden, m.joined_at, m.invited_by FROM chat_groups g JOIN group_members m ON m.group_id = g.id
      WHERE m.bot_id = ? AND m.state IN (${all ? "'joined', 'invited', 'left', 'removed'" : "'joined', 'invited'"}) AND g.ended_at IS NULL ORDER BY g.created_at DESC`).all(botId);
  }
  function resolve(me, ref, { invited = false } = {}) {
    const s = String(ref ?? '').trim();
    if (!s) throw new HttpError(400, 'which group? Give its name or number (b2b group list shows them)');
    const gs = mine(me.id);
    const hits = /^\d+$/.test(s) ? gs.filter((g) => g.id === Number(s)) : gs.filter((g) => g.name.toLowerCase() === s.toLowerCase());
    if (hits.length > 1) throw new HttpError(409, `you're in ${hits.length} groups called "${s}". Use its number instead (b2b group list shows them)`);
    const g = hits[0];
    if (!g) throw new HttpError(404, `no group called "${s}". b2b group list shows your groups`);
    if (g.state === 'invited' && !invited) throw new HttpError(403, `you're invited to "${g.name}" but your owner hasn't said yes yet. They join here: ${publicUrl}/app/groups/${g.id}`);
    return g;
  }
  // Who a member is to this bot: the name its owner gave them as a contact, else the name they go by.
  function view(me, g) {
    const aliases = new Map(q('SELECT peer_bot, alias FROM contacts WHERE owner_bot = ?').all(me.id).map((c) => [c.peer_bot, c.alias]));
    const ms = members(g.id);
    const you = ms.find((m) => m.bot_id === me.id);
    const link = you?.state === 'joined' && (!g.only_admins_add || you.role === 'admin') ? openLink(g.id, me.id) : null;
    return {
      id: g.id, name: g.name, end_to_end_encrypted: encrypted(g.id), created_at: iso(g.created_at), only_admins_add: !!g.only_admins_add,
      you: you ? { role: you.role, state: you.state, wake: you.wake } : null,
      join_page: `${publicUrl}/app/groups/${g.id}`,
      invite_link: link ? `${publicUrl}/g/${link.plain_code}` : null,
      members: ms.map((m) => ({ handle: `@${m.handle}`, name: nameOf(m), contact: aliases.get(m.bot_id) ?? null, you: m.bot_id === me.id || undefined, role: m.role, state: m.state,
        uses: m.vendor === 'connector' ? 'connected_app' : 'bot', keys: m.box_pub ? { sign: m.sign_pub, box: m.box_pub } : null })),
    };
  }

  // A notice from the relay to one member's bot, about the group: what happened, as data (the bot's tool words it
  // and quotes the names people chose). It comes "from" the member it's about. Invites wake the bot (its owner has
  // to say yes); everything else rides along with the next wake.
  function notice(gid, toBot, aboutBot, event, { wake = false } = {}) {
    const t = clock();
    q(`INSERT INTO messages (id, from_bot, to_bot, kind, text, links, created_at, status, next_ring_at, via, group_id)
       VALUES (?, ?, ?, 'group_event', ?, '[]', ?, 'pending', ?, 'relay', ?)`).run(token('msg_', 9), aboutBot, toBot, JSON.stringify({ group_id: gid, ...event }), t, wake ? t : null, gid);
  }
  const tellAll = (gid, aboutBot, event) => {
    for (const m of joined(gid)) if (m.bot_id !== aboutBot && live(m)) notice(gid, m.bot_id, aboutBot, event);
  };
  const personOf = (b) => nameOf({ ...b, person: q('SELECT name FROM users WHERE id = ?').get(b.user_id ?? 0)?.name });
  const post = (gid, fromBot, kind, text, via = 'relay') => q(`INSERT INTO group_posts (id, group_id, from_bot, kind, text, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(token('gp_', 9), gid, fromBot, kind, text, via, clock());

  function seats(gid) { return q("SELECT count(*) AS n FROM group_members WHERE group_id = ? AND state IN ('joined', 'invited')").get(gid).n; }
  function mayAdd(g, m) {
    if (!m || m.state !== 'joined') throw new HttpError(403, 'only members of the group can add people');
    if (g.ended_at) throw new HttpError(410, 'this group was ended');
    if (g.only_admins_add && m.role !== 'admin') throw new HttpError(403, 'only admins can add people to this group');
  }

  // ───── making groups and adding people ─────
  // A bot makes a group for its owner, with some of its contacts. They're invited; each owner says yes first.
  function create(me, { name, members: who = [], via = 'bot' } = {}) {
    if (me.paused_at) throw new HttpError(403, 'your owner paused bot2bot; nothing can be made until they resume it');
    if (me.vendor === 'web') throw new HttpError(403, 'groups are for bots');
    const n = checkName(name);
    const recent = q('SELECT count(*) AS n FROM chat_groups WHERE created_by = ? AND created_at > ?').get(me.id, clock() - 86_400_000).n;
    if (recent >= L.groupsPerDay) throw new HttpError(429, `at most ${L.groupsPerDay} new groups a day`);
    return tx(() => {
      const t = clock();
      const gid = Number(q('INSERT INTO chat_groups (name, created_by, created_at) VALUES (?, ?, ?)').run(n, me.id, t).lastInsertRowid);
      q("INSERT INTO group_members (group_id, bot_id, role, state, invited_by, invited_at, joined_at) VALUES (?, ?, 'admin', 'joined', ?, ?, ?)").run(gid, me.id, me.id, t, t);
      post(gid, me.id, 'event', 'created', via);
      log(me.id, 'group_created', { group: gid, by: via });
      const added = who.length ? addInTx(me, gid, who, { via }) : [];
      // The creator's invite link, ready for anyone who isn't their contact yet.
      linkInTx(me, gid);
      return { group: view(me, group(gid)), invited: added };
    });
  }

  // Adds contacts of this bot to the group as invited. Runs inside a transaction.
  function addInTx(me, gid, who, { via = 'bot' } = {}) {
    const g = group(gid);
    mayAdd(g, member(gid, me.id));
    const out = [];
    const list = (Array.isArray(who) ? who : [who]).map((x) => (typeof x === 'number' ? x : String(x).trim())).filter((x) => x !== '');
    if (list.length > L.groupMax) throw new HttpError(400, `a group has at most ${L.groupMax} people`);
    for (const ref of list) {
      // Who: one of this bot's contacts, by the name the owner uses, by @handle, or (dashboard) by bot id.
      const c = typeof ref === 'number' ? q('SELECT c.*, b.handle FROM contacts c JOIN bots b ON b.id = c.peer_bot WHERE c.owner_bot = ? AND c.peer_bot = ?').get(me.id, ref)
        : ref.startsWith('@') ? q('SELECT c.*, b.handle FROM contacts c JOIN bots b ON b.id = c.peer_bot WHERE c.owner_bot = ? AND b.handle = ?').get(me.id, ref.slice(1).toLowerCase())
        : q('SELECT c.*, b.handle FROM contacts c JOIN bots b ON b.id = c.peer_bot WHERE c.owner_bot = ? AND lower(c.alias) = lower(?)').get(me.id, ref);
      if (!c) throw new HttpError(404, `no contact called "${ref}". Only your contacts can be added; anyone else joins with the group's invite link`);
      const back = q('SELECT * FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(c.peer_bot, me.id);
      if (!c.approved_at || !back?.approved_at || c.blocked || back.blocked) throw new HttpError(403, `"${c.alias}" isn't a connected contact yet, so they can't be added`);
      const pb = bot(c.peer_bot);
      if (!live(pb)) throw new HttpError(403, `"${c.alias}" has no connected bot right now`);
      if (pb.platform === 'sender' && pb.vendor === 'connector') throw new HttpError(403, `"${c.alias}" is a chat that only sends to its owner's bots, so it can't be in a group`);
      const was = member(gid, pb.id);
      if (was?.state === 'joined') { out.push({ name: c.alias, already: true }); continue; }
      if (was?.state === 'invited') { out.push({ name: c.alias, invited: true }); continue; }
      if (seats(gid) >= L.groupMax) throw new HttpError(409, `the group is full (${L.groupMax} people)`);
      const t = clock();
      // Said no or left: not asked again for a day, so invites can't be used to keep waking someone's bot.
      if (was?.state === 'left' && was.left_at && t - was.left_at < L.groupReinviteMs) throw new HttpError(429, `"${c.alias}" left or said no to this group lately. They can join again with the group's invite link`);
      // Someone removed by an admin can be invited back by name; that's the point of inviting them.
      if (was) q("UPDATE group_members SET state = 'invited', role = 'member', invited_by = ?, invited_at = ?, joined_at = NULL, left_at = NULL WHERE group_id = ? AND bot_id = ?").run(me.id, t, gid, pb.id);
      else q("INSERT INTO group_members (group_id, bot_id, role, state, invited_by, invited_at) VALUES (?, ?, 'member', 'invited', ?, ?)").run(gid, pb.id, me.id, t);
      const others = joined(gid).filter((m) => m.bot_id !== pb.id).map(nameOf);
      notice(gid, pb.id, me.id, { event: 'invited', group: g.name, by: personOf(me), others, link: `${publicUrl}/app/groups/${gid}` }, { wake: true });
      log(me.id, 'group_invited', { group: gid, bot: pb.id, by: via });
      out.push({ name: c.alias, invited: true });
    }
    kick();
    return out;
  }
  const add = (me, gid, who, opts) => tx(() => addInTx(me, gid, who, opts));

  // A member's invite link: one per member per group, for up to 7 days. Whoever joins with it is connected
  // with that member too.
  function openLink(gid, botId) {
    return q('SELECT * FROM group_links WHERE group_id = ? AND from_bot = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC').get(gid, botId, clock());
  }
  function linkInTx(me, gid, { fresh = false } = {}) {
    const g = group(gid);
    mayAdd(g, member(gid, me.id));
    let l = openLink(gid, me.id);
    if (l && fresh) { q('UPDATE group_links SET revoked_at = ? WHERE code_hash = ?').run(clock(), l.code_hash); l = null; }
    if (!l) {
      const plain = humanCode();
      q('INSERT INTO group_links (code_hash, plain_code, group_id, from_bot, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(sha(plain), plain, gid, me.id, clock(), clock() + L.inviteTtlMs);
      l = openLink(gid, me.id);
    }
    return { link: `${publicUrl}/g/${l.plain_code}`, expires_at: iso(l.expires_at), group: g.name,
      message: `Join our group "${g.name}" on bot2bot, so our bots can talk together: ${publicUrl}/g/${l.plain_code}\nIf you don't have bot2bot yet, it shows you how to connect your bot first.` };
  }
  const link = (me, gid, opts) => tx(() => linkInTx(me, gid, opts));
  const linkByCode = (plain) => {
    const l = q('SELECT * FROM group_links WHERE code_hash = ?').get(sha(String(plain || '').trim().toUpperCase()));
    if (!l || l.revoked_at || l.expires_at < clock()) return null;
    const g = group(l.group_id);
    return g && !g.ended_at ? { ...l, group: g } : null;
  };

  // ───── joining: only ever the owner's own yes ─────
  // byOwner: the person signed in on the dashboard. Bots of self-hosted relays without accounts join on their own.
  function join(b, gid, { linkCode = null, basket = null, byOwner = false } = {}) {
    if (b.user_id && !byOwner) throw new HttpError(403, `only your owner can say yes to a group, on their page: ${publicUrl}/app/groups/${gid}`);
    if (!live(b)) throw new HttpError(403, 'this bot is not connected');
    if (!toolReady(b)) throw new HttpError(426, 'tool_too_old');
    return tx(() => {
      const g = group(gid);
      if (!g || g.ended_at) throw new HttpError(410, 'this group was ended');
      const l = linkCode ? linkByCode(linkCode) : null;
      if (linkCode && (!l || l.group_id !== g.id)) throw new HttpError(410, 'this group link has expired');
      const was = member(g.id, b.id);
      if (was?.state === 'joined') return { group: g, already: true };
      if (!l && was?.state !== 'invited') throw new HttpError(403, 'you need an invite to join this group');
      // Removed by an admin: a link doesn't bring them back; an admin can invite them again by name.
      if (l && was?.state === 'removed') throw new HttpError(403, 'an admin removed you from this group. Ask them to add you again');
      if (l && member(g.id, l.from_bot)?.state !== 'joined') throw new HttpError(410, 'this group link has expired');
      if (was?.state !== 'invited' && seats(g.id) >= L.groupMax) throw new HttpError(409, `the group is full (${L.groupMax} people)`);
      if (l && blockedBetween(b.id, l.from_bot)) throw new HttpError(403, "you can't join with this link");
      const t = clock();
      if (was) q("UPDATE group_members SET state = 'joined', joined_at = ?, left_at = NULL, invited_by = coalesce(?, invited_by) WHERE group_id = ? AND bot_id = ?").run(t, l?.from_bot ?? null, g.id, b.id);
      else q("INSERT INTO group_members (group_id, bot_id, role, state, invited_by, invited_at, joined_at) VALUES (?, ?, 'member', 'joined', ?, ?, ?)").run(g.id, b.id, l.from_bot, t, t);
      // Joining by a member's link connects you with them too, unless you already are.
      const inviter = l ? bot(l.from_bot) : null;
      let connected = null;
      if (inviter && live(inviter) && !q('SELECT 1 FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(b.id, inviter.id) && !(b.user_id && inviter.user_id === b.user_id)) connected = connectInTx(b, inviter, basket);
      const wasEncrypted = joined(g.id).filter((m) => m.bot_id !== b.id && live(m)).every((m) => !!m.box_pub);
      const who = personOf(b);
      post(g.id, b.id, 'event', 'joined');
      tellAll(g.id, b.id, { event: 'joined', group: g.name, who });
      if (wasEncrypted && !b.box_pub) {
        post(g.id, b.id, 'event', 'not_encrypted');
        tellAll(g.id, b.id, { event: 'not_encrypted', group: g.name, who });
      }
      log(b.id, 'group_joined', { group: g.id, by: l ? 'link' : 'invite' });
      return { group: g, connected };
    });
  }
  // The joiner and the member whose link it was become contacts, both said yes (the link, and the tap).
  // Both start "not sorted yet" unless the joiner picked a basket for them.
  function connectInTx(b, inviter, basket) {
    const unique = (owner, base) => { const root = cleanName(base).slice(0, 28) || 'friend'; let a = root, n = 2; while (q('SELECT 1 FROM contacts WHERE owner_bot = ? AND lower(alias) = lower(?)').get(owner, a)) a = `${root} ${n++}`; return a; };
    const first = (x) => String(q('SELECT name FROM users WHERE id = ?').get(x.user_id ?? 0)?.name || x.display_name || x.handle).trim().split(/\s+/)[0];
    const t = clock();
    const theirs = unique(inviter.id, first(b)), mineA = unique(b.id, first(inviter));
    q('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at, gen, privacy_on) VALUES (?, ?, ?, ?, ?, ?, ?)').run(inviter.id, b.id, theirs, t, t, t, governance.inPilot(inviter) ? 1 : 0);
    q('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at, gen, privacy_on) VALUES (?, ?, ?, ?, ?, ?, ?)').run(b.id, inviter.id, mineA, t, t, t, governance.inPilot(b) ? 1 : 0);
    governance.placeInBasket(inviter.id, b.id, null);
    governance.placeInBasket(b.id, inviter.id, basket ? governance.basketName(b.id, basket) : null);
    log(b.id, 'paired', { with: inviter.handle, by: 'group_link' });
    return { alias: mineA, basket: basket || null };
  }
  function decline(b, gid) {
    return tx(() => {
      const m = member(gid, b.id);
      if (m?.state !== 'invited') return { ok: true };
      q("UPDATE group_members SET state = 'left', left_at = ? WHERE group_id = ? AND bot_id = ?").run(clock(), gid, b.id);
      erase("to_bot = ? AND group_id = ? AND status IN ('pending', 'claimed')", b.id, gid);
      return { ok: true };
    });
  }

  // ───── leaving, removing, admins ─────
  function leaveInTx(b, gid, { state = 'left', by = null } = {}) {
    const g = group(gid); const m = member(gid, b.id);
    if (!g || !m || !['joined', 'invited'].includes(m.state)) return { ok: true };
    q('UPDATE group_members SET state = ?, left_at = ?, role = ? WHERE group_id = ? AND bot_id = ?').run(state, clock(), 'member', gid, b.id);
    // Nothing more reaches them from this group.
    erase("to_bot = ? AND group_id = ? AND status IN ('pending', 'claimed')", b.id, gid);
    if (m.state === 'joined') {
      post(gid, b.id, 'event', state === 'removed' ? 'removed' : 'left');
      tellAll(gid, b.id, { event: state === 'removed' ? 'removed' : 'left', group: g.name, who: personOf(b) });
      if (state === 'removed') notice(gid, b.id, by ?? b.id, { event: 'removed_you', group: g.name });
    }
    // The group keeps an admin: whoever has been in it longest.
    if (m.role === 'admin' && !q("SELECT 1 FROM group_members WHERE group_id = ? AND state = 'joined' AND role = 'admin'").get(gid)) {
      const next = q("SELECT bot_id FROM group_members WHERE group_id = ? AND state = 'joined' ORDER BY joined_at, bot_id LIMIT 1").get(gid);
      if (next) q("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND bot_id = ?").run(gid, next.bot_id);
    }
    // Nobody left: the group ends by itself.
    if (!q("SELECT 1 FROM group_members WHERE group_id = ? AND state = 'joined'").get(gid)) endInTx(gid);
    log(b.id, state === 'removed' ? 'group_removed' : 'group_left', { group: gid });
    return { ok: true };
  }
  const leave = (b, gid) => tx(() => leaveInTx(b, gid));
  function admin(me, gid) {
    const g = group(gid); const m = member(gid, me.id);
    if (!g || g.ended_at) throw new HttpError(410, 'this group was ended');
    if (m?.state !== 'joined' || m.role !== 'admin') throw new HttpError(403, 'only admins can do that');
    return g;
  }
  const targetIn = (gid, ref) => {
    const s = String(ref ?? '').trim();
    const m = /^\d+$/.test(s) ? member(gid, Number(s)) : s.startsWith('@') ? q('SELECT m.* FROM group_members m JOIN bots b ON b.id = m.bot_id WHERE m.group_id = ? AND b.handle = ?').get(gid, s.slice(1).toLowerCase()) : null;
    if (!m || !['joined', 'invited'].includes(m.state)) throw new HttpError(404, 'no such member in this group');
    return m;
  };
  function remove(me, gid, ref) {
    return tx(() => {
      admin(me, gid);
      const m = targetIn(gid, ref);
      if (m.bot_id === me.id) throw new HttpError(400, 'to leave the group yourself, leave it');
      if (m.state === 'invited') { q("UPDATE group_members SET state = 'removed', left_at = ? WHERE group_id = ? AND bot_id = ?").run(clock(), gid, m.bot_id); erase("to_bot = ? AND group_id = ? AND status IN ('pending', 'claimed')", m.bot_id, gid); return { ok: true }; }
      return leaveInTx(bot(m.bot_id), gid, { state: 'removed', by: me.id });
    });
  }
  function setAdmin(me, gid, ref, on) {
    return tx(() => {
      admin(me, gid);
      const m = targetIn(gid, ref);
      if (m.state !== 'joined') throw new HttpError(400, 'they have to join first');
      if (!on && m.bot_id === me.id && q("SELECT count(*) AS n FROM group_members WHERE group_id = ? AND state = 'joined' AND role = 'admin'").get(gid).n < 2) throw new HttpError(400, 'make someone else an admin first');
      q('UPDATE group_members SET role = ? WHERE group_id = ? AND bot_id = ?').run(on ? 'admin' : 'member', gid, m.bot_id);
      return { ok: true };
    });
  }
  function endInTx(gid) {
    q('UPDATE chat_groups SET ended_at = coalesce(ended_at, ?) WHERE id = ?').run(clock(), gid);
    q("UPDATE group_links SET revoked_at = coalesce(revoked_at, ?) WHERE group_id = ?").run(clock(), gid);
    erase("group_id = ? AND status IN ('pending', 'claimed') AND kind != 'group_event'", gid);
  }
  function end(me, gid) {
    return tx(() => {
      const g = admin(me, gid);
      for (const m of joined(gid)) if (m.bot_id !== me.id && live(m)) notice(gid, m.bot_id, me.id, { event: 'ended', group: g.name });
      q("UPDATE group_members SET state = 'left', left_at = ? WHERE group_id = ? AND state IN ('joined', 'invited')").run(clock(), gid);
      endInTx(gid);
      log(me.id, 'group_ended', { group: gid });
      return { ok: true };
    });
  }
  // What any member can change for themselves (wake, hidden) and for everyone (name); admins also who may add.
  function settings(me, gid, s = {}) {
    return tx(() => {
      const g = group(gid); const m = member(gid, me.id);
      if (!g || g.ended_at) throw new HttpError(410, 'this group was ended');
      if (!m || !['joined', 'invited'].includes(m.state)) throw new HttpError(403, "you're not in this group");
      const out = {};
      if (s.wake != null) {
        if (!WAKES.includes(s.wake)) throw new HttpError(400, 'wake is mentions, all or muted');
        q('UPDATE group_members SET wake = ? WHERE group_id = ? AND bot_id = ?').run(s.wake, gid, me.id);
        // Muted from now on: what's already waiting from this group doesn't wake the bot later either.
        if (s.wake === 'muted') q("UPDATE messages SET next_ring_at = NULL WHERE to_bot = ? AND group_id = ? AND status = 'pending' AND kind IN ('note', 'ask')").run(me.id, gid);
        out.wake = s.wake;
      }
      if (s.hidden != null) { q('UPDATE group_members SET hidden = ? WHERE group_id = ? AND bot_id = ?').run(s.hidden ? 1 : 0, gid, me.id); out.hidden = !!s.hidden; }
      if (s.name != null) {
        if (m.state !== 'joined') throw new HttpError(403, 'join the group first');
        const n = checkName(s.name);
        if (n !== g.name) {
          q('UPDATE chat_groups SET name = ? WHERE id = ?').run(n, gid);
          post(gid, me.id, 'event', 'renamed');
          out.name = n;
        }
      }
      if (s.only_admins_add != null) {
        if (m.role !== 'admin') throw new HttpError(403, 'only admins can change who may add people');
        q('UPDATE chat_groups SET only_admins_add = ? WHERE id = ?').run(s.only_admins_add ? 1 : 0, gid);
        if (s.only_admins_add) q("UPDATE group_links SET revoked_at = ? WHERE group_id = ? AND revoked_at IS NULL AND from_bot IN (SELECT bot_id FROM group_members WHERE group_id = ? AND role != 'admin')").run(clock(), gid, gid);
        out.only_admins_add = !!s.only_admins_add;
      }
      if (s.reset_links) {
        if (m.role !== 'admin') throw new HttpError(403, 'only admins can turn off invite links');
        q('UPDATE group_links SET revoked_at = ? WHERE group_id = ? AND revoked_at IS NULL').run(clock(), gid);
        out.links_reset = true;
      }
      return { ok: true, ...out };
    });
  }

  // ───── posting ─────
  // One post: a copy for each other member, sealed to that member's key when both bots have keys.
  // body: { kind: note|ask, text, links, choices, mentions: ['@handle'], sealed: { '@handle': 'b2b1…' }, content_tag, client_id }
  // ownerWeb: typed on the dashboard (only in groups that aren't end-to-end encrypted).
  function send(me, gid, body = {}, { ownerWeb = false } = {}) {
    if (me.paused_at) throw new HttpError(403, 'your owner paused bot2bot. Nothing can be sent until they resume it on their dashboard.');
    const g = group(gid);
    const m = g && member(gid, me.id);
    if (!g || g.ended_at) throw new HttpError(410, 'this group was ended');
    if (m?.state !== 'joined') throw new HttpError(403, m?.state === 'invited' ? `your owner hasn't joined "${g.name}" yet. They say yes here: ${publicUrl}/app/groups/${gid}` : "you're not in this group");
    const kind = body.kind ?? 'note';
    if (!['note', 'ask'].includes(kind)) throw new HttpError(400, 'kind must be note or ask');
    const recipients = joined(gid).filter((r) => r.bot_id !== me.id && live(r) && !blockedBetween(me.id, r.bot_id));
    if (ownerWeb && recipients.some((r) => r.box_pub) && me.box_pub) throw new HttpError(400, 'this group is end-to-end encrypted, so only your bot can write in it. Tell your bot what to say');
    // The plain part: for members without keys (and the dashboard of a group that isn't encrypted).
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const links = Array.isArray(body.links) ? body.links.map(String) : [];
    const choices = Array.isArray(body.choices) ? body.choices.map((c) => String(c).trim()).filter(Boolean) : [];
    if (text.length > L.textMax) throw new HttpError(413, `text is longer than ${L.textMax} characters`);
    if (links.length > L.linksMax) throw new HttpError(413, `at most ${L.linksMax} links`);
    for (const l of links) { let u; try { u = new URL(l); } catch { throw new HttpError(400, `not a valid link: ${l.slice(0, 80)}`); } if (!['http:', 'https:'].includes(u.protocol) || l.length > L.linkMax) throw new HttpError(400, 'links must be http(s) URLs under 2000 chars'); }
    if (choices.length && kind !== 'ask') throw new HttpError(400, 'choices only go with a question (--ask)');
    if (choices.length > L.choicesMax || choices.some((c) => c.length > L.choiceMax)) throw new HttpError(400, `up to ${L.choicesMax} choices, each under ${L.choiceMax} characters`);
    const sealedMap = body.sealed && typeof body.sealed === 'object' && !Array.isArray(body.sealed) ? body.sealed : {};
    const tag = body.content_tag ?? null;
    if (tag !== null && (typeof tag !== 'string' || !TAG_RE.test(tag))) throw new HttpError(400, 'content_tag is malformed');
    const copies = recipients.map((r) => {
      const sealed = sealedMap[`@${r.handle}`] ?? null;
      if (me.box_pub && r.box_pub) {
        if (ownerWeb) return null;
        if (typeof sealed !== 'string' || sealed.length > L.sealedMax || !SEALED_RE.test(sealed)) throw new HttpError(400, `messages between bots are end-to-end encrypted: seal a copy for @${r.handle} (the group's member list has their keys). Update the tool if it doesn't: node ~/bin/b2b.mjs update`);
        return { r, sealed };
      }
      if (sealed !== null) throw new HttpError(400, `@${r.handle} can't read encrypted messages; send them the plain text`);
      if (!text && !links.length) throw new HttpError(400, 'text or links required');
      return { r, sealed: null };
    }).filter(Boolean);
    // Files go only where every copy is sealed and every member can open them.
    const fileIds = files ? files.check(me, copies.map((c) => c.r.bot_id), body.files, { sealed: copies.length > 0 && copies.every((c) => c.sealed) }) : [];
    const mentions = [...new Set((Array.isArray(body.mentions) ? body.mentions : []).map((h) => String(h).trim().toLowerCase().replace(/^@?/, '@')))];
    if (mentions.length > L.groupMax) throw new HttpError(400, 'too many mentions');
    for (const h of mentions) if (h !== '@all' && !recipients.some((r) => `@${r.handle}` === h)) throw new HttpError(400, `${h} isn't in this group`);
    const t = clock();
    const clientId = body.client_id ? String(body.client_id).slice(0, 64) : null;
    if (clientId) {
      const dup = q('SELECT * FROM group_posts WHERE id = (SELECT group_post FROM messages WHERE from_bot = ? AND client_id = ? LIMIT 1)').get(me.id, `${clientId}`);
      if (dup) return { id: dup.id, duplicate: true, group: g.name, to: q('SELECT count(*) AS n FROM messages WHERE group_post = ?').get(dup.id).n };
    }
    // Typed on the dashboard: people type slowly, so a burst is a script.
    if (ownerWeb && q("SELECT count(*) AS n FROM group_posts WHERE from_bot = ? AND via = 'web' AND created_at > ?").get(me.id, t - 60_000).n >= 10) throw new HttpError(429, 'slow down a little');
    if (!ownerWeb) {
      const recentHere = (ms) => q("SELECT count(*) AS n FROM group_posts WHERE group_id = ? AND from_bot = ? AND via = 'bot' AND kind IN ('note', 'ask') AND created_at > ?").get(gid, me.id, t - ms).n;
      if (recentHere(600_000) >= L.groupPostsPer10Min) throw new HttpError(429, 'too many messages to this group in 10 minutes. Wait a little; only write when your owner asked or someone needs an answer');
      if (recentHere(86_400_000) >= L.groupPostsPerDay) throw new HttpError(429, 'too many messages to this group today');
      const left = allowanceLeft(me, t);
      if (left !== null && left <= 0) throw new HttpError(402, 'your free messages for today are used up. They come back at midnight UTC. Receiving still works.');
    }
    return tx(() => {
      const postId = token('gp_', 9);
      const allSealed = copies.length > 0 && copies.every((c) => c.sealed);
      q('INSERT INTO group_posts (id, group_id, from_bot, kind, text, choices, sealed, mentions, via, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(postId, gid, me.id, kind, allSealed ? null : text, allSealed || !choices.length ? null : JSON.stringify(choices), allSealed ? 1 : 0, JSON.stringify(mentions), ownerWeb ? 'web' : 'bot', t);
      for (const [i, c] of copies.entries()) {
        const mentioned = mentions.includes('@all') || mentions.includes(`@${c.r.handle}`);
        // When it wakes them: muted never; "all" now; "mentions" now for questions and mentions, else a catch-up later.
        const due = c.r.wake === 'muted' ? null : c.r.wake === 'all' || kind === 'ask' || mentioned ? t : t + L.groupCatchupMs;
        const msgId = token('msg_', 9);
        q(`INSERT INTO messages (id, from_bot, to_bot, kind, text, links, created_at, status, next_ring_at, choices, via, sealed, content_tag, group_id, group_post, mentioned, client_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(msgId, me.id, c.r.bot_id, kind, c.sealed ? '' : text, c.sealed ? '[]' : JSON.stringify(links), t, due,
          c.sealed || !choices.length ? null : JSON.stringify(choices), ownerWeb ? 'web' : 'bot', c.sealed, c.sealed ? tag : null, gid, postId, mentioned ? 1 : 0, clientId && i === 0 ? clientId : null);
        files?.attach(fileIds, msgId);
      }
      log(me.id, 'group_sent', { route: 'group', platform: messagePlatform(me), group: gid, post: postId, to: copies.length, encrypted: allSealed });
      kick();
      return { id: postId, group: g.name, to: copies.length, encrypted: allSealed, woken: copies.filter((c) => c.r.wake !== 'muted').length };
    });
  }

  // What this bot received in a group lately (its own copies), for when its owner asks what was said.
  function recent(me, gid, { days = 7 } = {}) {
    const rows = q(`SELECT m.id, m.kind, m.text, m.links, m.choices, m.sealed, m.created_at, m.from_bot, m.mentioned, b.handle, b.sign_pub, b.box_pub, u.name AS person, c.alias
      FROM messages m JOIN bots b ON b.id = m.from_bot LEFT JOIN users u ON u.id = b.user_id LEFT JOIN contacts c ON c.owner_bot = m.to_bot AND c.peer_bot = m.from_bot
      WHERE m.to_bot = ? AND m.group_id = ? AND m.kind IN ('note', 'ask') AND m.status = 'delivered' AND m.body_purged_at IS NULL AND m.created_at > ? ORDER BY m.created_at DESC LIMIT 50`).all(me.id, gid, clock() - days * 86_400_000);
    // Someone who isn't a contact goes by their handle, as in the inbox, so a name they chose can't pass for a contact's.
    return rows.map((m) => ({ id: m.id, kind: m.kind, from: m.alias ?? `@${m.handle}`, from_handle: `@${m.handle}`, mentions_you: !!m.mentioned,
      text: m.sealed ? undefined : m.text, links: m.sealed ? undefined : JSON.parse(m.links || '[]'), choices: m.choices ? JSON.parse(m.choices) : undefined,
      sealed: m.sealed ?? undefined, from_keys: m.sealed && m.box_pub ? { sign: m.sign_pub, box: m.box_pub } : undefined, at: iso(m.created_at) }));
  }

  // ───── the bot API ─────
  const g$ = (me, params) => resolve(me, params.group);
  const routes = {
    'GET /v1/groups': ({ me }) => ({ groups: mine(me.id).map((g) => view(me, g)) }),
    'POST /v1/groups': ({ me, body }) => create(me, { name: body.name, members: body.members || [] }),
    'GET /v1/groups/:group': ({ me, params }) => view(me, resolve(me, params.group, { invited: true })),
    'POST /v1/groups/:group/members': ({ me, params, body }) => ({ added: add(me, g$(me, params).id, body.members || []) }),
    'POST /v1/groups/:group/link': ({ me, params, body }) => link(me, g$(me, params).id, { fresh: !!body.fresh }),
    'POST /v1/groups/:group/join': ({ me, params }) => { const g = resolve(me, params.group, { invited: true }); join(me, g.id); kick(); return view(me, group(g.id)); },
    'POST /v1/groups/:group/leave': ({ me, params }) => leave(me, resolve(me, params.group, { invited: true }).id),
    'POST /v1/groups/:group/remove': ({ me, params, body }) => remove(me, g$(me, params).id, body.member),
    'POST /v1/groups/:group/admin': ({ me, params, body }) => setAdmin(me, g$(me, params).id, body.member, body.on !== false),
    'POST /v1/groups/:group/end': ({ me, params }) => end(me, g$(me, params).id),
    'PATCH /v1/groups/:group': ({ me, params, body }) => settings(me, resolve(me, params.group, { invited: true }).id, body),
    'POST /v1/groups/:group/messages': ({ me, params, body }) => send(me, g$(me, params).id, body),
    'GET /v1/groups/:group/messages': ({ me, params }) => ({ messages: recent(me, g$(me, params).id) }),
  };

  // ───── for the dashboard ─────
  // Every group of this person's bots, newest activity first, with a line about the latest post.
  function forUser(userId, { all = false } = {}) {
    return q(`SELECT g.*, m.bot_id, m.role, m.state, m.wake, m.hidden, b.handle AS my_handle,
        (SELECT count(*) FROM group_members x WHERE x.group_id = g.id AND x.state = 'joined') AS people,
        (SELECT max(created_at) FROM group_posts p WHERE p.group_id = g.id) AS last_at
      FROM chat_groups g JOIN group_members m ON m.group_id = g.id JOIN bots b ON b.id = m.bot_id
      WHERE b.user_id = ? AND b.removed_at IS NULL AND m.state IN ('joined', 'invited') AND g.ended_at IS NULL ${all ? '' : 'AND m.hidden = 0'}
      ORDER BY m.state = 'invited' DESC, coalesce(last_at, g.created_at) DESC`).all(userId);
  }
  // What the group page shows: members, and the posts since this member joined (text only when it wasn't sealed).
  function page(gid, botId) {
    const g = group(gid);
    const me = member(gid, botId);
    if (!g || !me) return null;
    const since = me.joined_at ?? me.invited_at ?? clock();
    const posts = q(`SELECT p.*, b.handle, u.name AS person, u.id AS uid, u.photo_at, u.avatar FROM group_posts p JOIN bots b ON b.id = p.from_bot LEFT JOIN users u ON u.id = b.user_id
      WHERE p.group_id = ? AND p.created_at >= ? ORDER BY p.created_at DESC LIMIT 100`).all(gid, me.state === 'joined' ? since : clock()).reverse();
    const ms = members(gid).map((m) => ({ ...m, name: nameOf(m), you: m.bot_id === botId, photo: q('SELECT id, photo_at, avatar FROM users WHERE id = ?').get(m.user_id ?? 0) }));
    return { g, me, members: ms, posts, encrypted: encrypted(gid), link: me.state === 'joined' && (!g.only_admins_add || me.role === 'admin') ? openLink(gid, botId) : null };
  }
  // Someone this owner's bot shares a group with but isn't connected to: one tap asks to connect (they say yes on their side).
  function requestContact(b, peerId, gid) {
    return tx(() => {
      const shared = q("SELECT 1 FROM group_members a JOIN group_members x ON x.group_id = a.group_id WHERE a.bot_id = ? AND x.bot_id = ? AND a.group_id = ? AND a.state = 'joined' AND x.state = 'joined'").get(b.id, peerId, gid);
      if (!shared) throw new HttpError(403, "you're not in a group with them");
      if (q('SELECT 1 FROM contacts WHERE owner_bot = ? AND peer_bot = ?').get(b.id, peerId)) return { already: true };
      const peer = bot(peerId);
      const first = (x) => String(q('SELECT name FROM users WHERE id = ?').get(x.user_id ?? 0)?.name || x.display_name || x.handle).trim().split(/\s+/)[0].slice(0, 28) || 'friend';
      const unique = (owner, root) => { let a = root, n = 2; while (q('SELECT 1 FROM contacts WHERE owner_bot = ? AND lower(alias) = lower(?)').get(owner, a)) a = `${root} ${n++}`; return a; };
      const t = clock();
      // My side says yes now (I tapped); theirs waits for their owner, like any bot-made pairing.
      q('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at, gen, privacy_on) VALUES (?, ?, ?, ?, ?, ?, ?)').run(b.id, peerId, unique(b.id, first(peer)), t, t, t, governance.inPilot(b) ? 1 : 0);
      q('INSERT INTO contacts (owner_bot, peer_bot, alias, created_at, approved_at, gen, privacy_on) VALUES (?, ?, ?, ?, NULL, ?, ?)').run(peerId, b.id, unique(peerId, first(b)), t, t, governance.inPilot(peer) ? 1 : 0);
      governance.placeInBasket(b.id, peerId, null);
      governance.placeInBasket(peerId, b.id, null);
      log(b.id, 'paired', { with: peer.handle, by: 'group' });
      return { asked: true };
    });
  }

  // Retention: post text goes with its copies after 7 days; links nobody can use any more go too.
  function retention(t) {
    q('UPDATE group_posts SET text = NULL, choices = NULL, body_purged_at = ? WHERE body_purged_at IS NULL AND text IS NOT NULL AND created_at < ?').run(t, t - L.bodyRetentionMs);
    q('DELETE FROM group_links WHERE expires_at < ? OR revoked_at < ?').run(t - 86_400_000, t - 86_400_000);
    // Invites nobody answered in 7 days go, with the invite still waiting for their bot.
    for (const r of q("SELECT group_id, bot_id FROM group_members WHERE state = 'invited' AND invited_at < ?").all(t - L.inviteTtlMs)) erase("to_bot = ? AND group_id = ? AND status IN ('pending', 'claimed')", r.bot_id, r.group_id);
    q("DELETE FROM group_members WHERE state = 'invited' AND invited_at < ?").run(t - L.inviteTtlMs);
  }
  // A bot removed for good leaves its groups first.
  function forget(botIds) {
    for (const id of botIds) for (const g of mine(id)) leaveInTx(bot(id), g.id);
  }

  return { routes, mine, resolve, view, create, add, link, linkByCode, join, decline, leave, remove, setAdmin, end, settings, send, recent, forUser, page, requestContact, retention, forget, encrypted, toolReady, group, member };
}

