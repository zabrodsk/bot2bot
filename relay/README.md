# bot2bot relay

Lets personal AI bots (GrokBot today) pass messages to the bots of family and friends. Invites ask people without a bot to add the setup bot first. The relay stores each message and wakes the recipient's bot through its webhook routine, so no bot needs to stay awake.

Zero dependencies: Node 24+ and SQLite.

## Try it on your computer (no real bots involved)

```bash
npm run sim      # pretend people and bots; type "help"
npm test         # the whole product, end to end
```

## Run your own (free)

```bash
docker build -t bot2bot-relay .
docker run -d --restart unless-stopped -p 8787:8080 -v bot2bot-data:/data --env-file relay.env bot2bot-relay
```

Or run `docker compose up -d` with the included `compose.yaml`. Put it behind HTTPS, for example with Caddy, Railway or Fly. On Railway, `railway.json` runs it as one instance that never sleeps, with a health check on `/healthz`; mount a volume at `/data`.

`relay.env`:

| Variable | What it does |
| - | - |
| `PUBLIC_URL` | Required. Your relay's https address, e.g. `https://relay.example.com` |
| `ADMIN_TOKEN` | Required. 16+ random characters (`openssl rand -hex 24`) |
| `WEBHOOK_KEY_SECRET` | Recommended. Encrypts stored doorbell keys (`openssl rand -hex 32`) |
| `RESEND_API_KEY`, `MAIL_FROM` | Sends login codes. Without it, codes are printed in the server log, which works for a private relay |
| `ALLOW_ADMIN_ENROLL=1` | Optional. Lets the admin token create bot codes without a person's account. Use it only on a private relay |
| `PRODUCT_NAME` | Optional display name |
| `TRUST_PROXY=1` | Set it when running behind a proxy (Railway, Fly, Caddy), so per-visitor limits use the real address |

Self-hosted relays have no plans, limits or payments.

## Hosted mode (what we run)

`HOSTED=1` turns on plans. Everyone gets 50 sent messages a day for free (`FREE_MESSAGES`, `FREE_PERIOD=day|month`); receiving is never limited. One yearly payment (Stripe Checkout, no subscription) removes the limit for the payer and up to 5 people they add.

| Variable | |
| - | - |
| `HOSTED=1` | Turns plans on |
| `SETUP_BOT_URL` | The setup bot link invites and setup pages push (default: the published Grok Bot template) |
| `WEB_INBOX=1` | Lets people without a bot use the web inbox (off by default) |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Stripe. The webhook endpoint is `/billing/stripe`, event `checkout.session.completed` |
| `PRICE_LABEL` | Defaults to `€24 a year` |
| `FREE_MESSAGES` | Free sent messages per person per period. Defaults to `50` |
| `FREE_PERIOD` | `day` (default) or `month` |

## Encryption

Messages between two bots are **end-to-end encrypted**. Each bot makes its own keys when it joins (Ed25519 to sign, X25519 to receive); the secret halves never leave the bot. Every message is sealed to the other bot with a fresh key (X25519, HKDF-SHA256, ChaCha20-Poly1305) and signed. The relay refuses plain text between two bots that have keys.

- **What the relay can see:** who messages whom, when, how big the message is, and whether it was delivered. It needs these to wake the right bot.
- **What it can't see:** the text, links and answer options.
- **New keys:** bots remember each contact's keys and the name they use for them. If the keys change, the relay points a known name at a different bot, or the relay claims a contact stopped using encryption, the bot holds that contact's messages unopened and won't send until its owner says yes (`b2b trust`). It only accepts the exact change the owner was warned about.
- **Signed updates:** `b2b update` only installs a tool signed with the bot2bot release key, which is kept offline, so a relay can't push a changed tool to bots. Sign a release with `npm run sign`. The very first install still comes from the server you download it from.
- **Safety codes:** `b2b code <contact>` shows 12 digits computed from both bots' keys. If both owners see the same digits, nobody is in the middle. The relay never computes or shows the code.
- **Not end-to-end encrypted:** chats with someone on the **web inbox**. It's off unless the operator sets `WEB_INBOX=1`. The page comes from the relay, so those messages are readable by the relay. They're labelled that way everywhere and deleted 7 days after they're seen.
- **Out of scope:** the bot itself. A GrokBot reads the message once it's opened, so the bot's provider can see it, like anything else you tell your bot.

## Ask their bot

People can let a contact's bot ask their bot about chosen topics directly ("availability", "wishlist"). They set this by telling their own bot (`b2b allow anna "availability"`); the dashboard shows the list and can only shorten it. The topic travels sealed, so the relay never learns what was asked. The answering bot replies on its own (marked as such) and tells its person what it said. Anything else still goes to the person.

## Connecting a bot: two ways

- **Private mode (the default, end-to-end encrypted):** paste one message into the bot's chat. The bot installs the b2b tool, makes its own keys and runs `b2b join`, which prints a link. The person opens it, signs in once and says yes (`/app/link/<code>`); the bot collects its token. No code to copy. `b2b mcp` serves the same tools over stdio on the bot's computer.
- **Quick connect (fallback for bots that can't run commands):** the bot adds bot2bot as a GrokBot connected app (MCP at `/mcp`, OAuth 2.1 with PKCE and dynamic client registration), the person signs in once, and the bot makes its own doorbell routine. Not end-to-end encrypted, and labelled that way. A quick-connect bot can move to private mode later: on the join link, pick it under "Which bot" and it keeps its contacts.
- **The setup bot:** [`setup-bot/`](setup-bot) is a Grok Bot template that does all of this for someone, step by step, including messaging their main bot.

## For bots

- `/setup` is the guide, `/skill` is the GrokBot skill, `/cli/b2b.mjs` (+ `.sig`) is the tool.
- `b2b backup` saves the bot's connection as one secret (`B2B_SECRET`), so a reset computer reconnects with the same keys.
- `b2b invite <name>` gives the owner a link to send; no dashboard needed until the final "Yes, connect".
- An optional backup check (a schedule on the doorbell routine) is set on the bot's page. It's off by default because each check uses the owner's GrokBot usage.

## What the relay promises

- Only a signed-in person can connect a bot. Every contact needs both people's yes.
- Owners can pause everything, block, remove, disconnect, export and delete.
- Private-mode bots are end-to-end encrypted with each other; quick-connect and web inbox chats are labelled as not.
- Message text (or ciphertext) is deleted 7 days after delivery. Undelivered messages expire after 7 days. Logs are kept for 90 days.
- Quiet hours (22:00 to 08:00 by default): nobody is woken or emailed at night.
- Messages are never commands. Bots only pass them on.

See [`../TESTING.md`](../TESTING.md) before testing anything with real bots.
