// Group templates (issue #14): a preset for a group's work (question, roles, clock, budget, rules, deliverable),
// run the same way every time, so the agents in it never spend messages agreeing times, budgets or formats.
//
// What the relay does and what it can't:
// - It runs the clock. The tool that starts a run turns the template into a list of times ("start", "window_open",
//   "window_closed", "budget", "due", "end") and gives the relay that list and who holds which role. Those are
//   readable here, because the relay has to know when to post them. At each time the scheduler tick tells every
//   member's bot, as a `group_event` the relay itself writes (data, worded by each bot's tool), and wakes it.
// - It never sees the question, the rules or the deliverable. The template definition travels sealed to each member
//   (one copy per member, like a group post) when the group is end-to-end encrypted, and only its hash is readable
//   here, so each member's tool can check that every copy is the one the run was started with. In a group that
//   isn't end-to-end encrypted the relay could read every post anyway, so the definition is kept plain.
// - Spend reports and the deliverable check run in each member's tool (see GROUP-TEMPLATES.md): the relay can't
//   read either in a sealed group, so it doesn't pretend to in a plain one.
const SEALED_RE = /^b2b1\.[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const ROLE_RE = /^[a-z][a-z0-9_]{0,23}$/;
const RUN_RE = /^gr_[A-Za-z0-9_-]{8,24}$/;
export const RUN_STEPS = ['start', 'window_open', 'window_closed', 'budget', 'due', 'end'];
const DEF_MAX = 8000;
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export function migrateGroupTemplates(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_runs (
      id TEXT PRIMARY KEY, group_id INTEGER NOT NULL REFERENCES chat_groups(id), created_by INTEGER NOT NULL REFERENCES bots(id),
      created_at INTEGER NOT NULL,
      roles TEXT NOT NULL,                 -- {"editor": bot id, ...}: readable, every member is told who holds which role
      clock TEXT NOT NULL,                 -- [{"at": ms, "step": "start", "n": 1, "of": 3}, ...]: times only, no content
      def_hash TEXT NOT NULL,              -- sha256 of the definition each member's copy must match
      next_step INTEGER NOT NULL DEFAULT 0, next_at INTEGER, stopped_at INTEGER, ended_at INTEGER,
      copies TEXT,                         -- {"bot id": "b2b1…"}: the definition sealed to each member (content)
      plain TEXT,                          -- the definition, only in a group that isn't end-to-end encrypted (content)
      body_purged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS group_runs_due ON group_runs (next_at);
    CREATE INDEX IF NOT EXISTS group_runs_group ON group_runs (group_id, created_at);
  `);
}

export function createGroupTemplates({ q, tx, clock, token, HttpError, groups, kick = () => {}, log = () => {}, L = {} }) {
  const perDay = L.groupRunsPerDay ?? 12;
  const aheadMs = L.groupRunAheadMs ?? 14 * 86_400_000;
  const spanMs = L.groupRunSpanMs ?? 24 * 3_600_000;
  const keepMs = L.bodyRetentionMs ?? 7 * 86_400_000;
  const handleOf = (id) => q('SELECT handle FROM bots WHERE id = ?').get(id)?.handle;
  const live = (b) => !b.disconnected_at && !b.removed_at && b.vendor !== 'web';
  const people = (gid) => q(`SELECT m.bot_id, m.state, m.role, m.wake, b.handle, b.box_pub, b.disconnected_at, b.removed_at, b.vendor FROM group_members m JOIN bots b ON b.id = m.bot_id
    WHERE m.group_id = ? AND m.state IN ('joined', 'invited')`).all(gid);
  const active = (gid) => q('SELECT * FROM group_runs WHERE group_id = ? AND ended_at IS NULL ORDER BY created_at DESC').get(gid);
  const rolesOut = (roles) => Object.fromEntries(Object.entries(roles).map(([r, id]) => [r, `@${handleOf(id) ?? '?'}`]));

  // A relay notice about the run to every member who has joined: the same kind of `group_event` as "joined" or
  // "ended", so old tools just say something changed in the group. Each copy says which roles that member holds.
  function tellAll(run, g, event, { wake = false } = {}) {
    const t = clock();
    const roles = JSON.parse(run.roles);
    for (const m of people(run.group_id)) {
      if (m.state !== 'joined' || !live(m)) continue;
      const you = Object.entries(roles).filter(([, id]) => id === m.bot_id).map(([r]) => r);
      const body = { group_id: run.group_id, group: g.name, run: run.id, roles: rolesOut(roles), you, ...event };
      q(`INSERT INTO messages (id, from_bot, to_bot, kind, text, links, created_at, status, next_ring_at, via, group_id)
         VALUES (?, ?, ?, 'group_event', ?, '[]', ?, 'pending', ?, 'relay', ?)`).run(token('msg_', 9), run.created_by, m.bot_id, JSON.stringify(body), t, wake && m.wake !== 'muted' ? t : null, run.group_id);
    }
  }

  // ───── starting a run ─────
  // body: { roles: { editor: '@anna', ... }, clock: [{ at, step, n, of }], def_hash, sealed: { '@handle': 'b2b1…' }, plain }
  function start(me, ref, body = {}) {
    const g = groups.resolve(me, ref);
    if (me.paused_at) throw new HttpError(403, 'your owner paused bot2bot; nothing can be started until they resume it');
    if (g.role !== 'admin') throw new HttpError(403, "only an admin of the group can start a run in it (the group's maker is one)");
    const t = clock();
    const ms = people(g.id);
    const byHandle = new Map(ms.map((m) => [`@${m.handle}`, m]));
    // Roles: names the template uses, each held by someone in the group (invited people too: they join before it starts).
    const rIn = body.roles && typeof body.roles === 'object' && !Array.isArray(body.roles) ? Object.entries(body.roles) : [];
    if (!rIn.length || rIn.length > 8) throw new HttpError(400, 'a run has 1 to 8 roles');
    const roles = {};
    for (const [r, h] of rIn) {
      if (!ROLE_RE.test(r)) throw new HttpError(400, `"${String(r).slice(0, 24)}" isn't a role name (lowercase letters, digits and _)`);
      const m = byHandle.get(String(h ?? '').trim().toLowerCase().replace(/^@?/, '@'));
      if (!m) throw new HttpError(400, `the ${r} has to be someone in the group`);
      roles[r] = m.bot_id;
    }
    // The clock: times only, from a fixed list of steps, starting with "start" and ending with "end".
    const cIn = Array.isArray(body.clock) ? body.clock : [];
    if (cIn.length < 2 || cIn.length > 60) throw new HttpError(400, 'a run has 2 to 60 clock steps');
    const steps = cIn.map((s) => {
      const at = typeof s?.at === 'number' ? s.at : Date.parse(String(s?.at ?? ''));
      if (!Number.isFinite(at) || !RUN_STEPS.includes(s?.step)) throw new HttpError(400, `a clock step is a time and one of: ${RUN_STEPS.join(', ')}`);
      const n = s.n == null ? null : Number(s.n), of = s.of == null ? null : Number(s.of);
      if ((n !== null && !(Number.isInteger(n) && n >= 1 && n <= 24)) || (of !== null && !(Number.isInteger(of) && of >= 1 && of <= 24))) throw new HttpError(400, 'a step number is 1 to 24');
      return { at: Math.round(at), step: s.step, ...(n ? { n } : {}), ...(of ? { of } : {}) };
    });
    for (let i = 1; i < steps.length; i++) if (steps[i].at < steps[i - 1].at) throw new HttpError(400, 'clock steps go in time order');
    if (steps[0].step !== 'start' || steps.at(-1).step !== 'end' || steps.filter((s) => s.step === 'start' || s.step === 'end').length !== 2) throw new HttpError(400, 'a run starts with "start" and ends with "end"');
    if (steps[0].at < t - 10 * 60_000) throw new HttpError(400, 'that start time has passed');
    if (steps[0].at > t + aheadMs) throw new HttpError(400, `a run starts within ${Math.round(aheadMs / 86_400_000)} days`);
    if (steps.at(-1).at - steps[0].at > spanMs || steps.at(-1).at <= steps[0].at) throw new HttpError(400, `a run lasts more than nothing and at most ${Math.round(spanMs / 3_600_000)} hours`);
    if (!HASH_RE.test(String(body.def_hash ?? ''))) throw new HttpError(400, 'def_hash is a sha256 in hex');
    // The definition: sealed to each member in an end-to-end encrypted group, plain only in one that isn't.
    const encrypted = groups.encrypted(g.id);
    const sealedIn = body.sealed && typeof body.sealed === 'object' && !Array.isArray(body.sealed) ? body.sealed : {};
    const copies = {};
    for (const [h, s] of Object.entries(sealedIn)) {
      const m = byHandle.get(String(h).toLowerCase());
      if (!m) throw new HttpError(400, `${String(h).slice(0, 40)} isn't in this group`);
      if (typeof s !== 'string' || s.length > 12_000 || !SEALED_RE.test(s)) throw new HttpError(400, `the copy for ${h} isn't sealed`);
      copies[m.bot_id] = s;
    }
    const plain = body.plain == null ? null : String(body.plain);
    if (encrypted) {
      if (plain !== null) throw new HttpError(400, "this group is end-to-end encrypted: the run's definition goes sealed to each member, never plain");
      const missing = ms.filter((m) => m.box_pub && live(m) && !copies[m.bot_id]).map((m) => `@${m.handle}`);
      if (missing.length) throw new HttpError(400, `seal the run's definition for ${missing.join(', ')} too`);
    } else if (plain === null || plain.length > DEF_MAX) throw new HttpError(400, `this group isn't end-to-end encrypted: send the definition as plain (up to ${DEF_MAX} characters)`);
    return tx(() => {
      const now = active(g.id);
      if (now) throw new HttpError(409, `a run is already set in this group (${now.id}, until ${iso(JSON.parse(now.clock).at(-1).at)}). Stop it first`);
      if (q('SELECT count(*) AS n FROM group_runs WHERE group_id = ? AND created_at > ?').get(g.id, t - 86_400_000).n >= perDay) throw new HttpError(429, `at most ${perDay} runs a day in one group`);
      const id = token('gr_', 9);
      q(`INSERT INTO group_runs (id, group_id, created_by, created_at, roles, clock, def_hash, next_step, next_at, copies, plain) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
        .run(id, g.id, me.id, t, JSON.stringify(roles), JSON.stringify(steps), body.def_hash, steps[0].at, JSON.stringify(copies), encrypted ? null : plain);
      const run = q('SELECT * FROM group_runs WHERE id = ?').get(id);
      // Everyone hears that a run is set, who holds which role, and when it starts; nothing to wake for yet.
      tellAll(run, g, { event: 'run_set', starts_at: iso(steps[0].at), ends_at: iso(steps.at(-1).at) });
      log(me.id, 'group_run_set', { group: g.id, run: id, steps: steps.length, roles: Object.keys(roles).length, encrypted });
      kick();
      return view(me, run);
    });
  }

  // ───── the clock ─────
  // Every step that is due, in order, from the scheduler tick. A relay that was down posts the missed ones late, marked so.
  function tick(t = clock()) {
    const due = q('SELECT * FROM group_runs WHERE next_at IS NOT NULL AND next_at <= ? AND ended_at IS NULL').all(t);
    let told = false;
    for (const run of due) {
      tx(() => {
        const r = q('SELECT * FROM group_runs WHERE id = ?').get(run.id);
        if (!r || r.ended_at || r.next_at == null || r.next_at > t) return;
        const g = groups.group(r.group_id);
        if (!g || g.ended_at) { q('UPDATE group_runs SET next_at = NULL, ended_at = ?, stopped_at = ? WHERE id = ?').run(t, t, r.id); return; }
        const steps = JSON.parse(r.clock);
        const end = steps.at(-1).at;
        let i = r.next_step;
        for (; i < steps.length && steps[i].at <= t; i++) {
          const s = steps[i];
          // Until when this step holds: a window until it closes, the start and "due" until the end.
          const until = s.step === 'window_open' ? steps.find((x, j) => j > i && x.step === 'window_closed' && x.n === s.n)?.at : ['start', 'due'].includes(s.step) ? end : null;
          const roles = JSON.parse(r.roles);
          const waiting = s.step === 'start' ? Object.entries(roles).filter(([, id]) => groups.member(r.group_id, id)?.state !== 'joined').map(([role, id]) => ({ role, handle: `@${handleOf(id) ?? '?'}` })) : undefined;
          tellAll(r, g, { event: 'clock', step: s.step, n: s.n ?? null, of: s.of ?? null, at: iso(s.at), until: iso(until), ends_at: iso(end), ...(waiting?.length ? { waiting } : {}), ...(t - s.at > 5 * 60_000 ? { late: true } : {}) }, { wake: true });
          told = true;
        }
        q('UPDATE group_runs SET next_step = ?, next_at = ?, ended_at = ? WHERE id = ?').run(i, i < steps.length ? steps[i].at : null, i >= steps.length ? t : null, r.id);
      });
    }
    if (told) kick();
    return told;
  }

  function stop(me, ref, runId) {
    const g = groups.resolve(me, ref);
    return tx(() => {
      const r = q('SELECT * FROM group_runs WHERE id = ? AND group_id = ?').get(String(runId), g.id);
      if (!r) throw new HttpError(404, 'no such run in this group');
      if (r.created_by !== me.id && g.role !== 'admin') throw new HttpError(403, 'only whoever started the run, or an admin, can stop it');
      if (r.ended_at) return { ok: true, already: true };
      const t = clock();
      q('UPDATE group_runs SET stopped_at = ?, ended_at = ?, next_at = NULL WHERE id = ?').run(t, t, r.id);
      tellAll(r, groups.group(g.id), { event: 'run_stopped', by: `@${me.handle}` }, { wake: true });
      log(me.id, 'group_run_stopped', { group: g.id, run: r.id });
      kick();
      return { ok: true };
    });
  }

  // What a member sees of a run: the roles and times, and only their own sealed copy of the definition.
  function view(me, r) {
    const steps = JSON.parse(r.clock);
    const copies = r.copies ? JSON.parse(r.copies) : {};
    return { id: r.id, group: r.group_id, by: `@${handleOf(r.created_by) ?? '?'}`, created_at: iso(r.created_at), roles: rolesOut(JSON.parse(r.roles)),
      clock: steps.map((s, i) => ({ at: iso(s.at), step: s.step, ...(s.n ? { n: s.n } : {}), ...(s.of ? { of: s.of } : {}), done: i < r.next_step })),
      starts_at: iso(steps[0].at), ends_at: iso(steps.at(-1).at), def_hash: r.def_hash,
      state: r.stopped_at ? 'stopped' : r.ended_at ? 'ended' : r.next_step > 0 ? 'running' : 'waiting',
      ...(r.body_purged_at ? { purged: true } : { sealed: copies[me.id] ?? null, plain: r.plain ?? null }) };
  }
  function list(me, ref) {
    const g = groups.resolve(me, ref);
    return { runs: q('SELECT * FROM group_runs WHERE group_id = ? ORDER BY created_at DESC LIMIT 5').all(g.id).map((r) => view(me, r)) };
  }

  // The definition goes 7 days after a run ends, like message text; the times and roles after 30.
  function retention(t = clock()) {
    q('UPDATE group_runs SET copies = NULL, plain = NULL, body_purged_at = ? WHERE body_purged_at IS NULL AND ended_at IS NOT NULL AND ended_at < ?').run(t, t - keepMs);
    q('DELETE FROM group_runs WHERE ended_at IS NOT NULL AND ended_at < ?').run(t - 30 * 86_400_000);
  }

  const routes = {
    'GET /v1/groups/:group/runs': ({ me, params }) => list(me, params.group),
    'POST /v1/groups/:group/runs': ({ me, params, body }) => start(me, params.group, body),
    'POST /v1/groups/:group/runs/:run/stop': ({ me, params }) => { if (!RUN_RE.test(String(params.run))) throw new HttpError(404, 'no such run'); return stop(me, params.group, params.run); },
  };
  return { routes, start, tick, stop, list, retention };
}
