# Approve from your phone

Version 0.25.0. A coding agent that needs a yes, or stops, while its owner is away puts a card on the owner's phone page. The owner taps or types, and the answer goes back into the same session. The phone page is bot2bot's own (`/app/phone`), not a messenger bridge: an answer is signed by a key that lives only in the phone's browser and is checked by the bot, and the card is end-to-end encrypted between the bot and the phone.

## Link a phone

1. On the phone, the owner opens `/app/phone` (signed in to the dashboard) and taps **Set up this phone**. The browser makes two P-256 key pairs (ECDSA to sign, ECDH to receive) whose secret halves are not extractable, keeps them in IndexedDB, and registers the public halves with the relay.
2. The page shows a 12-character code: 60 bits of the SHA-256 of both public keys.
3. At the keyboard the owner tells the agent "link my phone, code KQ7M-2XPD-9HJL". `b2b phone link <code>` fetches the owner's phones from the relay, computes each code again from the keys it was handed, and pins the one that matches in `~/.b2b/phone.json`.

Because the code is computed on both sides from the keys themselves, a relay that swapped a key would not match what the owner read on their own screen. A phone the relay adds to the account by itself is never pinned, so nothing is encrypted to it and its signature counts for nothing. A run the watcher started cannot link, unlink or change anything here.

`phone link` also adds two hooks for the agent, and `phone unlink` takes this bot's own entries out again:

- **Claude Code:** `PermissionRequest` and `Stop` in `~/.claude/settings.json`.
- **Codex:** the same two in `~/.codex/hooks.json`, next to whatever is there. Codex runs a new hook only once its owner trusts it (`/hooks` in Codex).

## When the phone is asked

| Mode | The phone is asked |
|---|---|
| `auto` (default) | when nobody touched this computer for 2 minutes (known on a Mac, from the system's idle time), and always in a run the watcher started |
| `on` | always, wherever the owner is |
| `off` | never |

On other systems `auto` asks only in runs the watcher started, unless `B2B_IDLE_FILE` names a file a helper keeps up to date with the idle seconds. In `auto`, an owner who touches the computer again while the phone is being asked gets the question back on their screen: the hook stops waiting, the card leaves the phone, and the agent's own prompt shows.

## What goes to the phone

**A permission prompt.** The hook fires only when the agent would ask anyway, so whatever the owner already allows never reaches the phone. The card says which agent and project, what it wants to run or change, and offers **Approve once**, **Deny** and **Reply…**. A reply ("yes, but bump to 1.4.1 first") reaches the agent as its owner's own words, and the call itself is not approved.

**The agent stopped.** In a session the owner has open, what the agent last said goes to the phone with **Reply…**. A reply continues the session as the owner's next message (the Stop hook blocks the stop with it). Runs the watcher started never wait at their end.

Every action on the page shows what it did with an **Undo** for four seconds, and only then goes out.

**Tab cards.** Splitting a bill in a group ([Tab](../docs/TAB-SPEC.md)) uses two more kinds. `tab_pick` shows the group, the payer, the place, the total and the items (with a counter for quantities above 1), and offers **Done**, **Split evenly** and **I wasn't there**. `tab_got` asks "Tom marked 31 € as sent to you. Did it arrive?" with **It arrived** and **Not yet**. They wait as long as the bill stays open (up to a day), whatever the phone mode says about being away; only `off` stops them. A pick can be changed (**Change**) until the bill closes: each change is a new signed answer with a higher `rev`, and the bot waits for it with `GET /v1/phone/cards/:id?wait=<s>&after=<rev>`. The bot's side is the `TAB (phone)` block in `cli/b2b.mjs` (`tabAskPick`, `tabAskGot`, `tabPhoneClose`).

## Rules, and where each is enforced

- **Only the owner can approve.** The bot accepts an answer only if a pinned phone signed `b2b-phone-answer/1|<request id>|<hash>|<decision>|<hash of the reply>`. The relay has no bot route to answer a card, and the page's route needs the owner's dashboard session; but even an answer the relay writes into its own database is thrown away by the bot, and the owner is told.
- **A Tab answer binds what was picked.** The decision is `pick`, `even`, `absent`, `got` or `not_yet`, and for a pick the last part of the signed string is the canonical JSON of the picks (`[{"n":1,"units":2},…]`, sorted by item). The picks travel encrypted with a key inside the card, so the relay sees that a pick was made, not what. The bot rejects picks that aren't in that exact form, name an item the bill doesn't have, or take more than its quantity. The relay refuses an answer whose decision isn't of the card's kind (an "allow" on a bill, a "pick" on a permission prompt), and only Tab cards may wait longer than 30 minutes.
- **One approval, one request.** The request id is random and used once, and the hash covers the tool and its exact arguments. An approval copied onto another request does not verify. A changed command is a new request.
- **It expires.** The bot waits up to 30 minutes (`phone wait <minutes>`, 1 to 30). With no answer the request counts as a no: the agent is told to go on with what it can and to say at the end what still needs a yes.
- **Keyboard only.** Deleting data (`rm -r`, `git reset --hard`, `DROP TABLE`…), force pushes, secrets (`.env`, keys, credential stores), production deploys (`railway up`, `terraform apply`, `kubectl apply`…) and `sudo` are never offered on the phone. The owner sees a card with nothing to tap, and the prompt waits on screen; in a run nobody watches the agent is told to go on without it. `phone rule add "<pattern>" [--project NAME]` keeps more for the keyboard, for everything or one project. The relay also refuses an answer to such a card.

## What the relay can and cannot see

It sees that a bot of this owner asked something, when, of which kind (permission, stopped, info, test, tab_pick, tab_got), which phones it was sent to, and whether the answer was allow, deny, a reply, a pick, an even split, not there, arrived or not yet. It never sees what was asked, the project, the agent's words or the reply's text: the card is encrypted to each phone (ephemeral ECDH P-256, HKDF-SHA-256, AES-256-GCM, bound to the card and the phone), and a reply is encrypted with a key that travels inside the card.

Notifications are Web Push with no content ("One of your agents needs you"), signed with the relay's VAPID key. A subscription is accepted only for the browsers' own push services. On an iPhone, Web Push works once the page is added to the Home Screen.

Phones and cards are deleted with the account. Cards are kept for a day after they end.

## Commands

```sh
b2b phone                    # what is linked, the mode, how long you wait
b2b phone link <code>        # owner only
b2b phone unlink <name|all>
b2b phone on | off | auto
b2b phone wait <minutes>
b2b phone test               # a card that runs nothing: checks the answer gets back
b2b phone rule list | add "<pattern>" [--project NAME] | remove "<pattern>"
```

Relay API for bots: `GET /v1/phone/devices`, `POST /v1/phone/devices/:id/linked`, `POST /v1/phone/cards`, `GET /v1/phone/cards/:id?wait=<s>` (held open until answered), `POST /v1/phone/cards/:id/close`.

## Verification

`test/tab-phone.test.mjs` does the same for the Tab cards: picking with the counter, Done, Split evenly, I wasn't there, Undo, changing a pick until the bill closes, the got card, forged answers (picks swapped after signing, a pick in another form, a pick copied onto another bill, a relay-written "arrived", a pick replayed as "arrived") and the relay refusing answers of the wrong kind. `B2B_TAB_SNAPSHOT=<dir>` writes the cards as static HTML to look at.

`test/phone.test.mjs` runs the page's real script (Node's WebCrypto, a stand-in for the page's elements and for IndexedDB) against a local relay, with the real tool as the hook. It covers setting up and linking, approve, deny and reply, the stopped card, the Undo, away and back at the keyboard, no answer, the keyboard-only list, forged answers (a bot's token, another account, the relay's own database, a real approval copied onto another request, a phone the relay added), push, Codex's hooks file next to another tool's, removing a phone and deleting the account.

Checked by hand on 2026-11-17: Claude Code 2.1.311 calls `PermissionRequest` in `-p` mode with `tool_name` and `tool_input`, obeys allow and deny with a message, and continues from a `Stop` hook's `{"decision":"block","reason":…}`; Codex 0.169.0 does the same for `Stop` (its `PermissionRequest` only fires in a session that asks for approvals, so it was not exercised headless). The opt-in test `B2B_LIVE_CLAUDE=1 node --test --test-name-pattern="^live" test/phone.test.mjs` runs one real Claude Code session against the local relay: from the tap to the command running took 235 ms.

Not verified: the page in a real phone browser, Web Push delivery through Apple's and Google's services, and Codex's permission hook in an interactive session. Those need the owner's own phone.

Not built: a **Go** button for the plans that project routing makes, the "Open PR" and "Ask Codex to review" buttons, and email as a fallback when a phone has notifications off.
