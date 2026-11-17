// Scheduled-job senders have keys, but no inbox or agent. The group join is the owner's existing yes.
export function migrateScheduledJobs(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS job_senders (
    bot_id INTEGER NOT NULL REFERENCES bots(id), group_id INTEGER NOT NULL REFERENCES chat_groups(id),
    created_at INTEGER NOT NULL, PRIMARY KEY (bot_id, group_id)
  );`);
}

export function createScheduledJobs({ q, tx, clock, groups, erase, HttpError }) {
  function ownGroup(me, ref) {
    if (me.removed_at || me.disconnected_at) throw new HttpError(403, 'this service identity is disconnected');
    const g = groups.resolve(me, String(ref));
    const creator = q('SELECT user_id FROM bots WHERE id = ?').get(g.created_by);
    if (!me.user_id || creator?.user_id !== me.user_id) throw new HttpError(403, 'job senders post only to groups created by their own owner');
    if (!me.box_pub || !me.sign_pub || !groups.encrypted(g.id)) throw new HttpError(403, 'job logs must stay end-to-end encrypted; every joined member needs keys');
    return g;
  }
  function setup(me, body) {
    if (!['grokbot', 'service'].includes(me.vendor)) throw new HttpError(403, 'use a separate enrolled private-mode identity for jobs');
    if (me.paused_at) throw new HttpError(403, 'your owner paused bot2bot');
    return tx(() => {
      const g = ownGroup(me, body.group);
      if (groups.member(g.id, me.id)?.state !== 'joined') throw new HttpError(403, 'your owner must join the group first');
      if (me.vendor === 'service') {
        if (!q('SELECT 1 FROM job_senders WHERE bot_id = ? AND group_id = ?').get(me.id, g.id)) throw new HttpError(403, 'service setup cannot add a destination');
        return { group: g.id, handle: `@${me.handle}`, service_sender: true };
      }
      // Conversion cannot silently turn an existing conversational bot's other groups into job destinations.
      if (groups.mine(me.id).some((x) => x.id !== g.id)) throw new HttpError(403, 'use an identity that belongs only to this jobs group');
      q('DELETE FROM job_senders WHERE bot_id = ?').run(me.id);
      q('INSERT INTO job_senders (bot_id, group_id, created_at) VALUES (?, ?, ?)').run(me.id, g.id, clock());
      q("UPDATE bots SET vendor = 'service', platform = 'jobs', webhook_url = NULL, webhook_key = NULL, doorbell_kind = NULL, doorbell_gen = doorbell_gen + 1 WHERE id = ?").run(me.id);
      q("UPDATE group_members SET wake = 'muted' WHERE bot_id = ?").run(me.id);
      q('UPDATE group_links SET revoked_at = ? WHERE from_bot = ?').run(clock(), me.id);
      q('UPDATE oauth_tokens SET revoked_at = ? WHERE bot_id = ? AND revoked_at IS NULL').run(clock(), me.id);
      erase('to_bot = ?', me.id);
      return { group: g.id, handle: `@${me.handle}`, service_sender: true };
    });
  }
  // This whitelist runs before all bot HTTP dispatch, including the connected-app endpoints.
  // Member keys are a delivery manifest, not message history. No content-reading endpoint is allowed.
  function authorize(me, method, path) {
    if (me?.vendor !== 'service') return;
    if (method === 'POST' && path === '/v1/jobs/setup') return; // Idempotent confirmation, never a new destination.
    const match = path.match(/^\/v1\/groups\/(\d+)(\/messages)?$/);
    if (match && q('SELECT 1 FROM job_senders WHERE bot_id = ? AND group_id = ?').get(me.id, Number(match[1]))
      && ((method === 'GET' && !match[2]) || (method === 'POST' && match[2]))) {
      ownGroup(me, match[1]);
      return;
    }
    throw new HttpError(403, 'a service sender can only fetch its own group delivery keys and post sealed messages there; it cannot read, join, invite, send direct messages or set a doorbell');
  }
  return { authorize, routes: { 'POST /v1/jobs/setup': ({ me, body }) => setup(me, body) } };
}
