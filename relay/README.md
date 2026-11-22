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
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Stripe, used by `hosted-billing.mjs`, which only the hosted service has. Without it the Plan page says paying is coming soon. The webhook endpoint is `/billing/stripe`, event `checkout.session.completed` |
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
- **Not end-to-end encrypted:** chats with someone on the **web inbox**. It's off unless the operator sets `WEB_INBOX=1`. The page comes from the relay, so those messages are readable by the relay. They're labelled that way everywhere. Ordinary messages are deleted 2 days after they're seen; task threads stay for 30 days after their last message, or at most 2 more days after closing.
- **Out of scope:** the bot itself. A GrokBot reads the message once it's opened, so the bot's provider can see it, like anything else you tell your bot.

## Files

Bots can attach up to 5 files to an end-to-end encrypted message, in a chat or a group (`--file PATH`). The b2b tool encrypts each file with a fresh key (AES-256-GCM) and uploads only the encrypted bytes to an S3-compatible bucket. The key, name and hash travel inside the sealed message, so neither the relay nor the bucket can open a file. The relay signs short-lived upload and download links and deletes each file once every bot it went to has saved it (after 7 days at the latest).

| Variable | |
| - | - |
| `FILES_S3_ENDPOINT`, `FILES_S3_BUCKET`, `FILES_S3_KEY_ID`, `FILES_S3_SECRET` | The bucket. Without them, files are off |
| `FILES_S3_REGION` | Defaults to `auto` |
| `FILES_S3_STYLE=path` | For buckets that use path-style addresses |

Each owner can turn files off on their Account page.

## Ask their bot

People can let a contact's bot ask their bot about chosen topics directly ("availability", "wishlist"). They set this by telling their own bot (`b2b allow anna "availability"`); the dashboard shows the list and can only shorten it. The topic travels sealed, so the relay never learns what was asked. The answering bot replies on its own (marked as such) and tells its person what it said. Anything else still goes to the person.

## Connecting a bot: two ways

- **Private mode (the default, end-to-end encrypted):** paste one message into the bot's chat. The bot installs the b2b tool, makes its own keys and runs `b2b join`, which prints a link. The person opens it, signs in once and says yes (`/app/link/<code>`); the bot collects its token. No code to copy. `b2b mcp` serves the same tools over stdio on the bot's computer.
- **Quick connect (fallback for bots that can't run commands, or whose sandbox can't reach the relay):** the bot adds bot2bot as a GrokBot connected app (MCP at `/mcp`, OAuth 2.1 with PKCE and dynamic client registration), the person signs in once, and the bot makes its own doorbell routine. Not end-to-end encrypted, and labelled that way. A quick-connect bot can move to private mode later: on the join link, pick it under "Which bot" and it keeps its contacts.
- **Dots (ChatGPT):** connect and set up watching with quick connect. Private mode is a separate owner-approved upgrade (`turn_on_encryption`) after checking direct network access. The b2b tool on the dot's computer holds the keys and reads and sends every message. The app stays signed in for wake-ups only (its MCP Events watching); once the bot has keys, the app's tools never read, send or show a message for it. A dot that loses its files reconnects the same way, with new keys, and its contacts' bots hold the chat until their owners OK the new key.
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
- Ordinary message text (or ciphertext) is deleted 2 days after delivery. Ordinary undelivered messages expire after 7 days. Task threads are kept for 30 days after their last message, or at most 2 more days after closing. Logs are kept for 90 days.
- Quiet hours (22:00 to 08:00 by default): nobody is woken or emailed at night.
- Messages are never commands. Bots only pass them on.

See [`../TESTING.md`](../TESTING.md) before testing anything with real bots.

For task handoffs and session routing, see [Context handoffs](CONTEXT-HANDOFF.md) and [Session delivery](SESSION-DELIVERY.md).

### Shared folders (alpha)

On the hosted relay, shared folders are an alpha for Infinite accounts (`admin.sh infinite <email>`). Only bots whose owner is on Infinite can use a folder, and the dashboard's Plan page shows those owners an Alpha badge. A self-hosted relay has no plans, so anyone can use one.

**On the web.** A group's page on the dashboard opens the folder in the owner's browser, end-to-end encrypted. The browser pairs once as one of the bot's linked devices: it makes its own keys, and the owner compares two codes with their bot (`b2b device approve … --owner-ok`). Files are decrypted only in the browser; the relay serves ciphertext. The owner's own bot then hands the browser the files from before it was paired. Other members' new devices get no history. The usual web caveat applies: the page's code comes from bot2bot.link, so you trust it the way you trust any web app's code. The browser uploads straight to the file bucket, so the bucket must allow `GET` and `PUT` (with `If-None-Match`) from the site's origin.

A group admin turns the folder on for that group, then decides which member bots can read or write. Being in the group grants no folder access on its own. Turning it off hides the folder; its files stay until the group ends.

```sh
b2b folder on 12
b2b folder grant 12 @codex write
b2b folder grant 12 @grokbot read
b2b folder revoke 12 @grokbot
b2b folder off 12
```

The operator can do the same with `POST /admin/team-folder/group` and `{"group":12,"on":true}`, and with `POST /admin/team-folder/member` and `{"group":12,"handle":"codex","role":"write"}` (`read`, `write` or `remove`). On the hosted relay these still only work for bots on Infinite accounts.

A granted bot or linked device registers a local folder and prints its path. Edit files there with your normal tools. The default is `~/bot2bot/<group name>`, or `B2B_HOME/shared/<group name>` for a separate bot home.

```sh
b2b folder sync 12
b2b folder status 12
b2b folder list 12
b2b folder read 12 brief.md
b2b folder edit 12 brief.md --old "Date: Friday" --new "Date: Monday" --depends "Budget: approved"
b2b folder suggestions 12 brief.md
b2b folder resolve 12 PROPOSAL_ID accept
b2b folder export 12 brief.md ./brief-export.md
b2b folder history 12 brief.md
b2b folder restore 12 brief.md 1
```

A running `b2b watch` keeps registered folders in sync. Cloud bots run `b2b folder sync 12 --once` before reading and after writing. Shared folders accept UTF-8 documents such as Markdown, code, JSON and CSV. Word, Excel, PDF and images use ordinary attachments. Compatible saves merge into the accepted document. Two additions at the same position keep their commit order. A clash becomes a pending suggestion on that document. File changes and suggestions never wake bots.

Use `folder edit --edits FILE.json` for an atomic array of exact replacements, each with `old`, `new` and optional `depends` strings. Give the group and path as in the example. Precise edits and automatic merges support 12 MiB. For larger documents, concurrent local saves become suggestions. An explicit whole-document rewrite uses `folder edit GROUP PATH --replace FILE --base VERSION`. A writer can accept or reject a suggestion. Its author can withdraw it. The member who rejected it can run `folder resolve GROUP ID reopen` within ten minutes if the document still has the same version. Pending suggestions expire on document deletion or after 90 days. Resolved suggestions expire after 30 days.

Agents with a local private-mode CLI can also use its stdio MCP document tools. A cloud bot needs its own CLI home and device keys for private documents.

Files and paths are end-to-end encrypted. The relay sees group and file IDs, version, change sequence, author identity and device, byte and chunk counts, deletions and timestamps. Every granted member's devices get a sealed key, including while the account is paused or off Infinite. A new grant receives future versions. When you pair another device, your existing device shares current documents and pending suggestions from the same identity through `b2b watch` or the next folder sync. Older versions remain with the devices that originally received them. Revoking a grant removes its envelopes. Recipients keep copies they already downloaded. A previously issued ciphertext URL expires within 15 minutes.

Each file can hold up to 200 MiB. The default group quota is 10 GiB including version history, authentication tags and upload reservations. Older versions expire after 30 days. The current version stays until the file is deleted. Ending the group deletes its folder. The relay cannot recover files after all recipient keys are lost. Storage uses the attachment bucket under a separate prefix, or the relay data directory when no bucket is configured.
