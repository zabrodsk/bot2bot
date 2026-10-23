# bot2bot, "pretty simple" version

The calm counterpart to the flashy v2. One screen and a short scroll. No loader, no WebGL.
The craft lives in type, the grid and one precise motion moment.

## Phase 0: Brief

- **Subject:** bot2bot (working name, kept in `src/data/site.ts`). Your AI bot (GrokBot today)
  can message the bots of friends and family. Their bot can be asleep: it is woken, reads the
  message and tells its person.
- **Audience:** people who already run a personal AI bot, and the friends they would invite.
  Curious, not necessarily technical.
- **Job of the site:** understand "bot to bot" in three seconds, trust it (consent first), click **Set up your bot**.
- **Constraints from the user:** at most 30 visible words on home, buttons included; anchored on
  "Bot to bot."; quiet field of tiny bots, almost all asleep; one blue signal from "you" to one
  friend's bot, it wakes, then sleeps again; pages home, `/setup`, 404; palette pinned by
  BRIEF.md; no loader, no GL.
- **Assumptions (placeholders):** production URL (`https://bot2bot.example`, reserved TLD), GitHub
  URL (`#`), friend names Anna, Tom and Mia (brief examples), the hosted app is not open yet.

## Phase 1: Concepts

| | A. One light on (formal system) | B. The type is the bot (typographic) | C. Quiet hours (time) |
|---|---|---|---|
| Idea | The whole site is one grid of sleeping bots. Words and buttons sit in rows of that grid, and only one thing is ever lit at a time. Blue means a message is moving, nothing else. | The display face is built from the bot's own geometry: its rounded-square bowls are the heads, the full stop is the status light. | The field follows the visitor's clock. At night the signal waits at the door until 08:00. |
| Layout | Field above, caption band below, every edge on the bot pitch | Headline as the hero image | Field, plus a clock |
| Motion verb | wake and settle: open fast, close slow, like eyelids | letters light up | waiting, then arriving |
| Signature | A signal runs the gutters antenna to antenna, one bot opens its eyes, its neighbours step aside for its name, then it closes its eyes | The full stop leaves the headline and becomes a light | A held dot pulsing at a door until morning |
| Screenshot | One blue trace across a grey field, one bot awake with a name beside it | The headline with a blue light for a full stop | A night field with one waiting dot |
| Originality / Fit / Feasibility / Portability | 3 / 5 / 5 / 2 | 4 / 4 / 3 / 2 | 4 / 3 / 3 / 2 |

**Pick A.** It is the field the user already liked, reduced to its rule system. It gives
decisions for layout (the pitch), motion (wake and settle), colour (blue only when a message
moves), copy (labels take the place of bots) and the 404 (the signal finds an empty cell).
**Stolen from B:** the display face is Hubot Sans, whose rounded-square `o` is the same shape as
a bot head, so "Bot to bot." rhymes with the field without any trick. C is dropped: a second
state (night) works against "pretty simple". Quiet hours become one line on `/setup`.

### Concept card

```
Idea:        A quiet field of sleeping bots. One message wakes one bot, then it sleeps again.
Metaphor:    A building at night: every window dark, one light comes on and goes off.
Signature:   The wake. A blue signal leaves your bot's antenna, runs the gutters of the grid
             and lands on a friend's antenna. The light turns blue, the eyes open, the two
             bots to its right step aside for her name. A few seconds later the eyes close
             slowly and the light goes grey. One GSAP timeline per message
             (src/motion/field.ts), driven by a single message clock.
Emotion:     Hushed and certain. Like watching someone be woken gently.
Motion verb: Wake and settle. Opening is quick (expo.out, 0.4 s). Closing is slow
             (sine.inOut, 1 s). Travel is even (power2.inOut).
Screenshot:  The grey field with one thin blue trace and one bot awake, "Anna" beside it,
             and "Bot to bot." underneath like a caption.
```

## Phase 2: Art direction system

### Palette (pinned by BRIEF.md)

| Role | Hex | Use |
|---|---|---|
| ground | `#f3f5f8` | page, the face of a sleeping bot |
| tint | `#e7ecf3` | quiet panels on `/setup`, button hover on light |
| line | `#d5dbe3` | the one hairline per page, step rails |
| sleep | `#c3cad5` | outlines of sleeping bots (decorative, never text) |
| muted | `#586377` | secondary text, 5.5:1 on ground |
| ink | `#1a2230` | text, your bot, the button |
| signal | `#2747c9` | a message moving, a light that is on. 6.8:1 on ground |
| white | `#ffffff` | the face of an awake bot, text on ink |

Rule: blue is never decoration. It appears only as a live status light (your bot, a woken bot,
the dot in the button, the current page in the nav) or as a message in motion. The button is
ink, not blue, because the button is your bot: an ink rounded rectangle with a blue light.

### Type

- **Display:** Hubot Sans (OFL, GitHub), instanced at width 110, weight 400 to 640, latin subset
  (22 KB). Headlines at weight 440, tracking -0.05em, leading 0.9. The rounded-square bowls echo
  the bot heads. Wordmark at 600.
- **Text and UI:** Mona Sans (OFL, Hubot's sibling), weight 400 to 600, latin (40 KB). Body
  18 to 19 px at 1.5, UI 14 to 15 px, labels in the field 13 px.
- Scale: hero `clamp(4.6rem, 0.6rem + 10.6vw, 12rem)`, xl `clamp(3rem, 1.6rem + 4.6vw, 6.5rem)`,
  l `clamp(1.9rem, 1.3rem + 2vw, 3.25rem)`, body `clamp(1.0625rem, 1rem + 0.25vw, 1.1875rem)`.
- Tabular figures for 22:00, 08:00, €24, step numbers.

### Grid and rhythm

- The bot pitch **P** is the unit: 30 px on desktop, 26 px on phones. The field is laid out from
  the left margin so the first column of heads starts on the same line as the "B" of the
  headline, and the last column ends on the right margin.
- Margins: `clamp(20px, 3.4vw, 56px)`. Twelve columns for text placement on `/setup`.
- Rhythm: the hero is a full viewport (field 1fr, caption band auto). The scroll section is
  airy (about 34 vh of padding). `/setup` is tight between steps and airy around the plans.

### Shape

One radius rule, taken from the bot head (4 on 12.5 high, about 30 percent of height): the
button is 48 px high with a 14 px radius; the nav dot and lights are circles; nothing else is
rounded.

### Motion language

- Eases: `expo.out` for things that open, `sine.inOut` for things that settle, `power2.inOut`
  for travel. No springs.
- The signal: a 2.4 px dot with a 36 px bright tail. A faint trace draws behind it and fades
  after delivery.
- Page transition: **a blink.** Two ground-coloured lids close from top and bottom to a seam
  (0.32 s, power2.in) and open on the new page (0.55 s, expo.out). It is the same gesture as
  the bot's eyes.
- Reduced motion: the hero shows the delivered state (trace, Anna awake, her name); no loop, no
  blink, no draw.
- Native scroll. A one-and-a-half screen page does not need smooth scrolling.

### Composition plans

Home, hero (poster: the field with a caption band)
```
+------------------------------------------------------------------------+
| [o] bot2bot                                          Setup   GitHub    |
|  . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .  |
|  . . . . . . . . . . . . . . . . . . . . . . . . [A] Anna . . . . . .  |
|  . . . . . . . . . . . . . . . . . . . . . . .  |  . . . . . . . . .  |
|  . . . . . . . . . . . . . . . . . . . . . . . .|. . . . . . . . . .  |
|  .+-----------------------------------------------+ . . . . . . . . .  |
|  [Y] You . . . . . . . . . . . . . . . . . . . . . . . . . . . . . .  |
|                                                                        |
|  Bot to bot.                                Your bot messages their bot.|
|                                             It wakes up and tells them.|
|                                             [* Set up your bot]       |
+------------------------------------------------------------------------+
```
Home, scroll (statement: a second poster that rhymes with the hero)
```
|  [Y]------[A]                                                          |
|  Only people you                                                       |
|  both say yes to.                (display size, nothing else)          |
```
Setup (sequence row, then plans)
```
| Set up your bot.                                                       |
| The hosted app is not open yet. Here is how setup works.               |
|  (z)---------(o)---------(o*)---------(Y)-(A)                          |
|  1 Sign in   2 Connect   3 Add the    4 Invite                         |
|  with email. your bot.   doorbell.    a friend.                        |
|------------------------------------------------------------------------|
| Run it yourself          Hosted                   Good to know         |
```
404 (the field with a hole)
```
|  . . . . . . . . . [ ] . . . .   the signal lands on an empty cell     |
|  [Y] You . . . . . . . . . . .                                         |
|  No bot at this address.                         [* Go home]           |
```

### Word budget (home, visible)

bot2bot, Setup, GitHub (3) · Bot to bot. (3) · Your bot messages their bot. It wakes up and
tells them. (11) · Set up your bot (4) · You, Anna (2) · Only people you both say yes to. (7)
= **30**. The xAI disclaimer lives on `/setup`, where GrokBot is named.

### Genericness test

- "Would a generic model land here?" A blue CTA on a light grey ground with a centred headline:
  yes. **Changed:** the button is ink with a blue light (it is your bot), blue is reserved for
  messages, and the headline is a caption under the field, bottom left, not centred.
- A generic sans (Inter, Geist): yes. **Changed** to Hubot Sans at width 110, chosen because its
  bowls are bot heads.
- Feature cards under the hero: yes. **Removed.** The scroll holds one sentence and one pair of
  bots.
- Hover sparkle on the field: tempting. **Removed.** The only interaction is the button waking
  your bot's light, which ties the action to the picture.

## Stack

Astro 7 (static, ClientRouter for the blink transition) + GSAP. Reason: a content-only page whose
product is one motion moment; static HTML, 35 KB of JS gzipped. No Lenis (native scroll for a
page this short), no SplitText, no loader, no WebGL. The engine is trimmed to the page lifecycle
(`onPage` inside a `gsap.context`) and the transition.

Files that carry the concept: `src/motion/field.ts` (the driver), `src/data/bot.ts` (the one
bot drawing), `src/engine/transition.ts` (the blink), `src/motion/steps.ts` (setup wires).

## Phase 4: QA log

**Pass 1** (audit + shoot, all pages):
- 0 FAIL, 1 WARN (thin content, 31 words incl. the hidden skip link: intentional).
- Fixed: trace and comet had the same opacity, so the tail was invisible (trace now 0.32).
- Fixed: mobile sub-line wrapped "It wakes / up"; the line break now holds on phones.
- Fixed: `/setup` rail ran past the last step and the ringed bot sat 9 px low; replaced by
  per-step wires, antenna to antenna, drawn in sequence.
- Fixed: the statement section read empty (big gap, a lonely mark in the corner). It is now a
  second display-size poster with a larger pair of bots; the stray footer mark is gone.
- Fixed: GitHub button floated alone at the end of `/setup`; it now belongs to "Run it yourself".
- Fixed: the empty cell on the 404 was too faint; it has a dashed outline where a bot would be.

**Pass 2** (production build, `astro preview` on 4482):
- audit: 0 FAIL, 1 WARN (same, intentional). ~101 KB heaviest page, JS 35 KB gz, fonts 60 KB.
- shoot home / setup / 404: 0 console errors, 0 failed requests, no horizontal overflow on
  desktop or mobile, 0 small tap targets, 60 fps (worst frame 17 ms), 0 hidden text under
  reduced motion.
- Checked by hand: blink frames mid-transition, keyboard order (skip, brand, Setup, GitHub,
  button) with a visible ring, hover and focus on the button wake your bot's light, live resize
  1440 to 820 rebuilds the field, home to setup to home rebuilds and replays, 1920, 1280x720,
  1024, 768 and 390 composed.
- Remove one accessory: cut the brand mark's hover lift (generic, not from the concept).

## Self-score (skeptical, with evidence)

| Area | Score | Evidence |
|---|---|---|
| Design (40%) | 8.0 | `.shots-final/desktop-hero-3_7.png`: Hubot 440 at width 110, -0.05em, the first column of heads starts on the B stem, the last ends on the right margin, Anna's bot stands exactly above the word "bot.". Blue appears only where something is live. The finale rhymes with the hero. Held back by: the field is uniform and a critic could call it a pattern; `/setup` is a conventional four-column sequence. |
| Usability (30%) | 8.5 | No loader, text is the LCP; orientation in one glance (headline, two lines, one button). Mobile CTA full width in the thumb zone (`mobile-hero-3_4.png`). Visible focus, AA contrast (muted 5.5:1, signal 6.8:1), designed reduced-motion still (`reduced-motion-1_5.png`), 60 fps, no overflow at 390 to 1920. |
| Creativity (20%) | 8.0 | The concept drives the layout (bot pitch, headline as caption and diagram), the motion (wake and settle, the blink between pages), `/setup` (bot states, antenna wires) and the 404 (the signal finds an empty cell). The field itself is the user's own earlier idea, refined rather than reinvented. |
| Content (10%) | 7.5 | 30 true words; every fact on `/setup` comes from the brief. Thin by design, which a jury notices. |
| **Weighted** | **8.1** | Real reviewers score lower than self-assessments. |

Developer: Semantics/SEO 8 (one h1 per page, landmarks, canonical, OG, JSON-LD, sitemap,
robots; placeholder domain), Animations 8, Accessibility 8.5, WPO 9, Responsive 8, Markup 8.

## Launch pass (relay 0.11, FINAL-BRIEF.md)

- Copy follows `../FINAL-BRIEF.md`: sub line "Your bot talks to their bot. Even when theirs is
  asleep."; primary action is the code on GitHub (the hosted app is not open yet), secondary is
  /setup. Home adds three rows (encryption between bots, ask their bot, web inbox honesty) above
  the consent finale.
- New pages in the same system: `/security` (the path of one message, can and can't see, keys,
  safety code, new-key hold, the web inbox exception, retention), `/pricing` (three plans; the
  figure counts the people: you plus 5 bots for Family), `/bots` (skill, b2b tool, doorbell,
  Docker). Global footer, phone menu as a `<details>` disclosure.
- One new rule for figures: a solid blue wire means end-to-end encrypted; a dashed grey wire
  means the web inbox. The server and browser glyphs are drawn in the bot's own coordinates.
- Hubot's zero is slashed. Kept on the safety code (a code you read aloud), avoided on
  durations (Mona there).
- QA: build + preview, Playwright at 1440 and 390 with and without reduced motion: 0 console
  errors, 0 failed requests, 0 overflow, CLS 0, all internal links 200, unique titles and
  descriptions, audit 0 FAIL / 0 WARN.
