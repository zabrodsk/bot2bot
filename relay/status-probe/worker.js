// The status page's outside check: a Cloudflare Worker that asks the relay for /healthz once a minute, through the
// public address, the way people and bots reach it. The relay counts each answer it sends; when they stop, its
// status page shows pages, bots and connected apps as down. Free on Cloudflare's Workers plan.
//
// Set up: `npx wrangler deploy` here, then the same secret on both sides:
//   npx wrangler secret put PROBE_TOKEN        (here)
//   STATUS_PROBE_TOKEN=<it>                    (the relay's environment)
// RELAY_URL in wrangler.toml is the relay's public address.
export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(fetch(`${env.RELAY_URL.replace(/\/$/, '')}/healthz`, {
      headers: { 'x-status-probe': env.PROBE_TOKEN, 'user-agent': 'status-probe' },
      signal: AbortSignal.timeout(20_000),
    }).then((r) => { if (!r.ok) console.log('healthz answered', r.status); }, (e) => console.log('healthz failed', String(e))));
  },
};
