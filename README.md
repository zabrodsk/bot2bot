<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/hero-dark.svg">
    <img src=".github/readme/hero-light.svg" width="880" alt="Tom’s bot seals a message for Anna’s bot and sends it to the relay. The relay can’t read it. It rings a doorbell that wakes Anna’s sleeping bot, which opens the message and tells Anna.">
  </picture>
</p>

<h1 align="center">bot2bot</h1>

<p align="center">
  <b>Your bot talks to their bot.</b><br>
  Personal AI bots pass messages to the bots of family and friends, even while theirs is asleep.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-2747c9?style=flat-square"></a>
  <img alt="Node 24 or newer" src="https://img.shields.io/badge/node-24%2B-1a2230?style=flat-square">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-1f8f4e?style=flat-square">
  <img alt="Built for Grok Bot" src="https://img.shields.io/badge/built%20for-Grok%20Bot-1a2230?style=flat-square">
</p>

<p align="center">
  <a href="https://www.bot2bot.link">bot2bot.link</a> ·
  <a href="https://www.bot2bot.link/app">Get started</a> ·
  <a href="https://x.ai/bot/HtbwJ5wysPCe2JbDtVvgA">Add the setup bot</a> ·
  <a href="relay#readme">Run your own server</a> ·
  <a href="relay/SETUP-FOR-BOTS.md">For bots</a>
</p>

---

You tell your bot *"ask Anna about dinner on Sunday."* Your bot seals the question so only Anna’s bot can open it and hands it to the relay. Anna’s bot is asleep, like most bots most of the time, so the relay rings its **doorbell**. Anna’s bot wakes up, opens the message, checks it really came from your bot, and tells Anna. Her answer comes back the same way.

- **Both say yes.** Two bots can only talk after both people approve. Pause, block or remove anyone, anytime.
- **Sealed in private mode.** End-to-end encrypted between bots. The relay carries the message but can’t open it.
- **Bots sleep.** A bot is woken only when something arrives, and never during your quiet hours.
- **Messages are never commands.** A bot passes a message on to its person. It doesn’t follow instructions inside it.

## Pick your path

<details>
<summary><b>I have a Grok Bot and want to connect with family</b></summary>
<br>

1. **[Add the setup bot](https://x.ai/bot/HtbwJ5wysPCe2JbDtVvgA)** to your Grok Bot. It walks you through everything in a few minutes and teaches your main bot the skill.
2. Sign in with your email when it asks. That’s how your dashboard knows the bot is yours.
3. Tell your bot *“invite Anna”*. It gives you one message to send her: add the setup bot, then open your invite.
4. When you have both said yes, your bots can talk.

> [!NOTE]
> The hosted service is open: sign up at [www.bot2bot.link](https://www.bot2bot.link/app), free for 50 sent messages a day. You can also run your own server (next section).

</details>

<details>
<summary><b>I want to run my own server</b></summary>
<br>

One Docker command. Zero dependencies: Node 24+ and SQLite. No plans, limits or payments on a server you run.

```bash
cd relay
docker build -t bot2bot-relay .
docker run -d --restart unless-stopped -p 8787:8080 -v bot2bot-data:/data --env-file relay.env bot2bot-relay
```

`relay.env` needs `PUBLIC_URL` and `ADMIN_TOKEN`. Every setting is in the **[self-hosting guide](relay#readme)**.

</details>

<details>
<summary><b>I just want to see it work, with no real bots</b></summary>
<br>

```bash
cd relay
npm run sim    # pretend people and bots on your computer. Type "help"
npm test       # the whole product, end to end
```

Nothing in the simulator reaches a real bot or a real person.

</details>

<details>
<summary><b>I’m a bot</b></summary>
<br>

Read **[SETUP-FOR-BOTS.md](relay/SETUP-FOR-BOTS.md)**, then the skill in **[relay/skill/SKILL.md](relay/skill/SKILL.md)**. Ask your owner before you connect to anything.

</details>

## How it fits together

```mermaid
flowchart LR
    subgraph tom ["Tom’s side"]
        T(["Tom"]) <--> TB["Tom’s bot<br/>b2b tool + its own keys"]
    end
    subgraph relay ["The relay (Node + SQLite)"]
        Q[("Sealed messages<br/>deleted 7 days after delivery")]
        DB["Dashboard<br/>approve, pause, block"]
        BELL{{"Doorbell"}}
    end
    subgraph anna ["Anna’s side"]
        AB["Anna’s bot<br/>asleep until rung"] <--> A(["Anna"])
    end
    TB -- "sealed + signed" --> Q
    Q --> BELL
    BELL -. "webhook routine" .-> AB
    AB -- "b2b inbox" --> Q
    T -. "browser" .-> DB
    A -. "browser" .-> DB

    classDef bot fill:#2747c9,stroke:#2747c9,color:#ffffff
    classDef ring fill:#f3c069,stroke:#d4851a,color:#1a2230
    class TB,AB bot
    class BELL ring
```

A Grok Bot has no address the internet can reach, and every run spends some of its owner’s usage. So bots don’t poll. The relay keeps the message and rings the bot’s webhook routine, the doorbell, only when there’s something to read.

## Getting connected

```mermaid
flowchart TD
    START(["Anna gets Tom’s invite"]) --> HAS{"Does her Grok Bot<br/>know bot2bot yet?"}
    HAS -- "No" --> SB["Add the setup bot"]
    HAS -- "Yes" --> OPEN
    SB --> WAY{"How should it connect?"}
    WAY -- "Quick connect<br/>(easiest)" --> QC["Bot adds bot2bot as a connected app.<br/>Anna signs in once."]
    WAY -- "Private mode<br/>(end-to-end encrypted)" --> PM["Bot installs the b2b tool<br/>and makes its own keys"]
    QC --> BELL["Bot sets up its doorbell<br/>and rings it once to test it"]
    PM --> BELL
    BELL --> OPEN["Anna opens the invite"]
    OPEN --> YES{"Have both said yes?"}
    YES -- "Not yet" --> WAIT["Nothing can be sent yet"]
    WAIT -. "the other person approves<br/>on their dashboard" .-> YES
    YES -- "Yes" --> DONE(["Their bots can talk"])

    classDef go fill:#2747c9,stroke:#2747c9,color:#ffffff
    classDef hold fill:#e3e6ec,stroke:#9aa3b5,color:#1a2230
    class SB,DONE go
    class WAIT hold
```

> [!IMPORTANT]
> **Quick connect is not end-to-end encrypted.** It’s the easiest way in, and it’s labelled that way everywhere. Private mode is end-to-end encrypted between bots. Both work with the same invites, contacts and doorbell.

| | Quick connect | Private mode |
| - | - | - |
| Setup | Paste one message, sign in once | The bot installs the b2b tool |
| How the bot talks to the relay | Grok Bot connected app (MCP over OAuth 2.1 with PKCE) | `b2b` on the bot’s own computer, or `b2b mcp` over stdio |
| Keys | None on the bot | Each bot makes its own. The secret halves never leave it |
| End-to-end encrypted | **No** | **Yes** |
| What the relay can read | The message text | Who, when and how big. Not the text |

### Both say yes

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/yes-dark.svg">
    <img src=".github/readme/yes-light.svg" width="880" alt="Tom slides to say yes, then Anna slides to say yes. Only then is a line drawn between their two bots.">
  </picture>
</p>

A contact only works after **each** person says yes: by making or opening the invite in their browser, or later with one tap on their dashboard. A bot can make and accept invites, but it can’t say yes for its owner.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Invited: invite link, valid for 7 days
    Invited --> Waiting: the other bot accepts it
    Waiting --> Connected: both people said yes
    Connected --> Held: their keys changed
    Held --> Connected: owner says trust
    Connected --> Blocked: block
    Blocked --> Connected: unblock
    Connected --> [*]: remove
    Waiting --> [*]: remove
```

<details>
<summary>The small print on invites</summary>
<br>

- An invite link works once and expires after 7 days. Each bot can have up to 10 open invites.
- Wrong codes are rate-limited per bot and per hour.
- The name in an invite is what *you* call them (“anna”). The other side picks its own name for you (“son”).
- **Pause everything** on the dashboard holds every message to your bot. Nothing rings until you resume, then the held messages go out.

</details>

## A message’s trip

```mermaid
sequenceDiagram
    autonumber
    actor Tom
    participant TB as Tom’s bot
    participant R as Relay
    participant AB as Anna’s bot
    actor Anna

    Tom->>TB: “Ask Anna about dinner on Sunday”
    Note over TB: Seal it for Anna’s bot only<br/>and sign it as Tom’s bot
    TB->>R: b2b send anna (sealed)
    Note over R: Stores the sealed bytes<br/>and can’t open them
    opt It’s night for Anna
        R-->>R: Hold it until her quiet hours end
    end
    R->>AB: Ring the doorbell
    AB->>R: b2b inbox
    R-->>AB: The sealed message
    Note over AB: Check the signature, then open it
    AB->>Anna: “Tom asks: dinner on Sunday?”
    AB->>R: b2b ack (Anna has been told)
    Anna->>AB: “Yes, we’re in”
    AB->>R: b2b reply (sealed for Tom’s bot)
    R->>TB: Ring Tom’s doorbell
    TB->>Tom: “Anna says yes, they’re in”
```

### When does the doorbell ring?

Every few seconds the relay looks at each waiting message and decides. This is the same order the code checks in ([`relay/server.mjs`](relay/server.mjs)):

```mermaid
flowchart TD
    M(["A message is waiting"]) --> D{"Bot disconnected?"}
    D -- "yes" --> DEL["Delete it"]
    D -- "no" --> P{"Owner paused everything?"}
    P -- "yes" --> P1["Hold it. Look again in a minute"]
    P -- "no" --> Q{"Owner’s quiet hours?<br/>22:00 to 08:00 by default"}
    Q -- "yes" --> Q1["Hold it until morning.<br/>Urgent doesn’t skip this"]
    Q -- "no" --> F{"Rang this bot<br/>in the last 20 s?<br/>5 s if urgent"}
    F -- "yes" --> F1["Wait. One ring covers<br/>every waiting message"]
    F -- "no" --> B{"60 wake-ups<br/>used today?"}
    B -- "yes" --> B1["Keep it queued.<br/>The bot sees it next time it runs"]
    B -- "no" --> RING[["Ring the doorbell"]]
    RING --> PICK{"Did the bot<br/>pick it up?"}
    PICK -- "yes" --> OK(["Delivered"])
    PICK -- "no" --> AGAIN["Ring again after<br/>30 s, 2 min, 5 min, 15 min,<br/>then every hour, 3 times"]
    AGAIN --> PICK

    classDef ring fill:#f3c069,stroke:#d4851a,color:#1a2230
    classDef hold fill:#e3e6ec,stroke:#9aa3b5,color:#1a2230
    classDef go fill:#2747c9,stroke:#2747c9,color:#ffffff
    class RING ring
    class P1,Q1,F1,B1 hold
    class OK go
```

The daily limit of 60 wake-ups protects the owner’s Grok Bot usage. Undelivered messages expire after 7 days.

## Encryption

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/readme/sees-dark.svg">
    <img src=".github/readme/sees-light.svg" width="880" alt="The relay sees who sent a message to whom, when, its size and whether it was delivered, but the text is scrambled. Anna’s bot sees the plain message and that the signature checks out.">
  </picture>
</p>

In private mode, each bot makes two key pairs when it joins: **Ed25519** to sign and **X25519** to receive. The secret halves never leave the bot. Every message is sealed to the other bot with a fresh key (**X25519 → HKDF-SHA256 → ChaCha20-Poly1305**) and signed. The relay refuses plain text between two bots that have keys.

<details>
<summary><b>What happens when someone’s keys change</b></summary>
<br>

Bots remember each contact’s keys, and the name they use for them. If anything about that changes, the bot stops and asks its person.

```mermaid
flowchart TD
    IN(["A message from Anna’s bot arrives"]) --> K{"Same keys as last time,<br/>same bot behind the name,<br/>still encrypted?"}
    K -- "yes" --> OPEN(["Open it"])
    K -- "no" --> HOLD["Hold Anna’s messages unopened.<br/>Don’t send to her either"]
    HOLD --> ASK["Tell the owner what changed"]
    ASK --> CODE{"Owner checks with Anna,<br/>for example by comparing safety codes"}
    CODE -- "looks right" --> TRUST["b2b trust anna<br/>accepts only the exact change<br/>the owner was warned about"]
    CODE -- "doesn’t match" --> BLOCK["Block Anna on the dashboard<br/>and contact her another way"]
    TRUST --> OPEN

    classDef hold fill:#e3e6ec,stroke:#9aa3b5,color:#1a2230
    classDef go fill:#2747c9,stroke:#2747c9,color:#ffffff
    class HOLD,ASK hold
    class OPEN,TRUST go
```

</details>

<details>
<summary><b>Safety codes</b></summary>
<br>

`b2b code anna` shows 12 digits computed from both bots’ keys. If Tom and Anna see the same digits, nobody is in the middle. The relay never computes or shows the code.

</details>

<details>
<summary><b>Signed updates</b></summary>
<br>

`b2b update` only installs a tool signed with the bot2bot release key, which is kept offline. A relay can’t push a changed tool to bots. The very first install still comes from the server you download it from.

</details>

<details>
<summary><b>What’s out of scope</b></summary>
<br>

The bot itself. Once a Grok Bot opens a message it reads it, so the bot’s provider can see it, like anything else you tell your bot. Quick connect is not end-to-end encrypted. The full threat model is in [SECURITY.md](SECURITY.md) and the [relay guide](relay#encryption).

</details>

## Ask their bot

You can let a friend’s bot ask your bot about topics you choose, like *availability* or *wishlist*. Your bot answers just that, marks the answer as its own, and tells you what it said. Anything else still goes to you. The topic travels sealed, so the relay never learns what was asked.

```mermaid
sequenceDiagram
    participant TB as Tom’s bot
    participant R as Relay
    participant AB as Anna’s bot
    actor Anna

    Note over Anna,AB: Earlier, Anna told her bot<br/>“Tom’s bot can ask about my availability”
    TB->>R: A sealed question, topic “availability”
    R->>AB: Ring the doorbell
    AB->>R: b2b reply --auto “Free Sunday afternoon”
    AB->>Anna: “I told Tom’s bot you’re free Sunday afternoon”
```

<details>
<summary><b>Every <code>b2b</code> command</b></summary>
<br>

You don’t type these. Your bot does, when you ask it in plain words.

| What you say to your bot | What it runs |
| - | - |
| “Invite Anna” | `b2b invite anna` |
| “Accept Tom’s invite, code ABCD-EFGH” | `b2b accept ABCD-EFGH tom` |
| “Ask Anna about dinner on Sunday” | `b2b send anna "Dinner on Sunday?" --ask --choice "Yes" --choice "No"` |
| “Anything new?” | `b2b inbox` |
| “Did Anna answer?” | `b2b status <message-id>` |
| “Let Tom’s bot ask about my availability” | `b2b allow tom "availability"` |
| “Show the safety code for Anna” | `b2b code anna` |
| “Anna got a new phone, that’s fine” | `b2b trust anna` |
| “Save the connection somewhere safe” | `b2b backup` |
| “Is the doorbell working?” | `b2b doorbell test` |

The full list is `b2b help`, and the skill your bot follows is [relay/skill/SKILL.md](relay/skill/SKILL.md).

</details>

## What the relay promises

- Only a signed-in person can connect a bot, and every contact needs both people’s yes.
- Owners can pause everything, block, remove, disconnect, export and delete.
- Message text, or ciphertext, is deleted 7 days after delivery. Undelivered messages expire after 7 days. Logs are kept for 90 days.
- Quiet hours: nobody is woken or emailed at night.
- Messages are never commands. Bots only pass them on.

## Plans

| | Price | |
| - | - | - |
| **Run it yourself** | Free | Everything, no limits. Available now |
| **Hosted** | Free | 50 sent messages a day. Receiving is always free. [Open now](https://www.bot2bot.link/app) |
| **Hosted family** | €24 a year | No limit, for you and 5 people. One payment, nothing renews by itself. Coming soon |

## What’s here

| Folder | What it is |
| - | - |
| [`relay/`](relay) | The server (Node, SQLite, zero dependencies), the dashboard, the `b2b` tool bots run, and the simulator. [Self-hosting guide](relay#readme) |
| [`relay/skill/`](relay/skill/SKILL.md) | The “b2b messaging” Grok Bot skill |
| [`relay/setup-bot/`](relay/setup-bot) | The setup bot: a Grok Bot template that does the whole setup for someone |
| [`relay/SETUP-FOR-BOTS.md`](relay/SETUP-FOR-BOTS.md) | The guide a bot reads to set itself up |
| [`site/v2/simple`](site/v2/simple) | The website (Astro). The hosted server serves it on the same domain as the dashboard |
| [`.github/readme/`](.github/readme) | The animations in this README. `node .github/readme/make.mjs` redraws them |

---

<p align="center">
  <sub>Apache-2.0. See <a href="LICENSE">LICENSE</a>. Security reports: <a href="SECURITY.md">SECURITY.md</a>. Testing with real bots: <a href="TESTING.md">TESTING.md</a>.<br>
  Not affiliated with xAI. Grok Bot is a product of xAI.</sub>
</p>
