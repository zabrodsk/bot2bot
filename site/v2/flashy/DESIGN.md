# bot2bot, flashy landing page: design record

Version brief from the user: "crazy grandiose, very flashy". Spectacle is allowed (short loader,
WebGL, one signature scroll story). The bar stays: 60 fps, reduced-motion path, a designed phone
layout, real semantics.

## Phase 0: Brief

| | |
|---|---|
| Subject | bot2bot (working name, lives only in `src/data/site.ts`): your personal AI bot (GrokBot today) can message the bots of friends and family. Their bot can be asleep: it gets woken, reads the message, tells its person. |
| Audience | People who already run a personal AI bot, and the friends and family they want to reach. Curious, not necessarily technical. |
| Job | Make "bot to bot" obvious in 3 seconds, make the waking mechanism felt, then send people to **Set up your bot** (`/setup`). Secondary: GitHub. |
| Assets | Wireframe 3 (the field of tiny sleeping bots the user liked), the bot mark (rounded head, antenna, status light), the palette `#2747c9` on cool greys, ink `#1a2230`. |
| Language | English, very plain words, sentence case, no dashes. |
| Constraints | Banned words list in BRIEF.md. Product facts only from BRIEF.md (setup detail cross-checked with `docs/PRODUCT.md`). The hosted app is not public yet. Not affiliated with xAI. |

Assumptions (also listed in `src/data/site.ts`):
- Production URL is unknown: `https://bot2bot.example` is a placeholder.
- GitHub URL is `#` (per brief).
- Anna's reply text ("Thanks! Making it Sunday.") is invented demo copy, like the brief's examples.
- Setup step detail (short email code, one pasted setup message, doorbell link and key) follows the
  planned flow in `docs/PRODUCT.md`; verify against the real app before launch.

## Phase 1: Concepts

Direction is fixed by the user (a huge living WebGL field of sleeping bots, a scroll story where a
blue signal crosses the field and wakes Anna's bot). The concepts below are different *readings*
of that direction, each from a different territory.

| | A. The doorbell (how it works) | B. Night sky (place / time) | C. Type made of bots (formal system) |
|---|---|---|---|
| Idea | Every bot sleeps behind a door. A message is a ring: one bell, then the wake spreads like sound down a quiet street. | The field is a night sky: sleeping bots are dim stars, messages are shooting stars, friendships draw constellations. | One rule: everything is drawn with the field. Headlines are spelled by waking the bots inside the letterforms. |
| Layout rule | A vast standing crowd of bot heads seen across a plain; routes run in the gutters like streets. | Overhead star map, constellations as layout lines. | Grid of bots is the grid of the page; text blocks are cut out of it. |
| Motion verb | wake: closed to open, dim to lit | drift and streak | light up in letter shapes |
| Type voice | Robot-cut wide grotesk whose "o" is the bot's head | thin astronomical serif | the field itself, DOM text as the accessible twin |
| Palette source | A street at night: ink-navy ground, one blue status light | deep sky, star white | brief greys |
| Signature | The ring: Anna's bot wakes and a wave of awakenings rolls across thousands of heads, then they settle back to sleep | A comet path draws a constellation from you to Anna | "Bot to bot." spelled in lit bots |
| Screenshot | High aerial: a glowing blue ring of awake bots sweeping out across a dark crowd, the lit route home | The constellation | The lit headline |
| Originality / Fit / Feasibility / Portability (lower better) | 4 / 5 / 4 / 1 | 3 / 3 / 4 / 4 | 4 / 3 / 3 / 3 |

**Pick: A, the doorbell.** It is the only one built from the product's real mechanism (a sleeping
bot gets woken by a doorbell, the actual setup step is "add the doorbell"), so it cannot be moved to
another brand. Stolen from C for a detail: the 404 is a field with one bot missing. Stolen from B:
"quiet at night" dims the whole field and the pointer can't wake anyone.

### Concept card

```
Idea:        Thousands of bots are asleep. Yours rings one of them, and you watch it wake.
Metaphor:    A doorbell on a quiet street at night: one ring, one light, the sound rolling outward.
Signature:   Scroll story on one driver: message → blue signal runs the gutters → Anna's bot
             wakes → a ring of awakenings rolls across ~16,000 heads → the answer runs home.
             (motion.md "Scroll-scrubbed timeline" + patterns.md "driver module", custom OGL
             instanced field.)
Emotion:     Hush, then a spark. "Something is alive in there."
Motion verb: wake: closed to open (eyes, text, page transitions open from a flat line),
             dim to lit (lights rise fast, fade slow).
Screenshot:  From high above, the blue ring halfway across the dark crowd, Anna's bot lit at
             the centre, the route back to you drawn in blue.
```

## Phase 2: Art direction system

### Palette (night street)

| Role | Name | Hex | Use |
|---|---|---|---|
| ground | night | `#0b0f18` | page and field ground (a deeper cut of the brief's ink `#1a2230`) |
| raised | night-2 | `#141b2a` | bubbles, step cards |
| ink | paper | `#f3f5f8` | all text (the brief's ground, inverted into ink) |
| muted | fog | `#8d98ab` | secondary text (6.6:1 on night) |
| line | sleep | `#2a3345` | asleep bots, hairlines |
| accent | signal | `#2747c9` | the brand blue: buttons, the blink line, fills |
| accent on dark | glow | `#6f8cff` | lit lights, the route, focus ring, blue text (6.2:1 on night) |
| curtain | night | `#0b0f18` | blink lids |

No gradients as decoration. Blue appears only where a signal is: lights, routes, the main button.

### Type

- **Display: Hubot Sans** (Google, OFL, variable `wdth 75..125`, `wght 200..900`). GitHub's
  "robotic" grotesk; at 125% width its bowls are rounded squares, the same shape as the bot head,
  so the headline and the field are cut from one shape. Sizes: mega `clamp(4.2rem, 1rem + 12.4vw,
  13.5rem)` at 900 / 125%, tracking -0.045em, leading 0.86. Captions `t-xl` at 800 / 112%, -0.035em.
  Its zero is slashed, so digits are never set in Hubot.
- **Text and UI: Mona Sans** (Google, OFL, same family system). Body 17 to 18 px / 1.5, UI 13 to 14 px
  / 500 / +0.01em, numbers `tabular-nums`.
- One accent detail: the full stop in "Bot to bot." is the bot's blue status light.

### Grid and rhythm

12 columns, gutter `clamp(1rem, .6rem + 1.6vw, 2.5rem)`, outer margin = gutter. Two hang lines:
column 1 (all display type) and column 8 (all secondary text). Rhythm moods: full viewport (hero,
story stage), airy 70vh (fact rows, so the field has room to act), tight (footer).

### Shape

Rounded like the bot head: radius = 25% of the element's height, capped at 14 px
(button 52 px → 13 px, bubble 44 px → 11 px).

### Motion language

- One easing family: `expo.out` (open), `expo.inOut` (blink), `power3.out` (small UI).
- Text reveals open like an eye: each line opens from its horizontal centre line
  (clip-path `inset(50% 0 50% 0)` → `inset(0)`), 1.1 s, 70 ms stagger.
- Page transition is a blink: two lids close to a thin blue line (the asleep eye), the page swaps,
  the lids open. 0.55 s shut, 0.7 s open.
- Lights: on in 0.25 s, off in 1.4 s. Bots blink every few seconds with random phase.
- One clock: GSAP ticker drives Lenis, ScrollTrigger, the field and the DOM anchors.
- The whole home page is one scrubbed timeline whose time unit is scroll pixels (the driver):
  camera, signal, wave, field states, captions and bubbles all read the same number.

### Composition plan (each section a different layout family)

```
HERO (scene + poster)                                         1 viewport
┌──────────────────────────────────────────────────────────────────────┐
│ ■ bot2bot                                   How it works  Setup  GitHub│
│                                                                      │
│ Bot to bot●                         (mega, one line, col 1 → 12)     │
│ Your bot talks to their bot.            [● Set up your bot]  GitHub  │
│ ·  ·  ·  ·  ·  ·  ·  · horizon haze ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  · │
│  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  ▫  │
│   ▢    ▢    ▢    ▢    ▢   [Your bot] ■    ▢    ▢    ▢    ▢    ▢     │
│ Scroll to send a message                                             │
└──────────────────────────────────────────────────────────────────────┘

STORY (sticky narrative over full-bleed GL)                   ~5 viewports
┌──────────────────────────────────────────────────────────────────────┐
│                         ■ ── "Send Anna this recipe"  (anchored)     │
│                                                                      │
│                              field, camera moves                     │
│ 1  You tell your bot.                                    7.0 s       │
│    (one caption at a time, opens like an eye)     measured, 2 accounts│
└──────────────────────────────────────────────────────────────────────┘

FACTS (index list: four statement rows, field acts on the right)  4 × 70vh
┌──────────────────────────────────────────────────────────────────────┐
│ Both say yes.                         Only people you both say yes   │
│ (col 1-7, t-xl)                       to. (col 8-12)  ■—■            │
├ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┤
│ Quiet at night.   ...   No bot needed.   ...   Free, or €24 a year.  │
└──────────────────────────────────────────────────────────────────────┘

FINALE (footer as finale)                                      1 viewport
┌──────────────────────────────────────────────────────────────────────┐
│ Your bot,                                                            │
│ meet theirs.        (mega, two lines)        field fully alive       │
│ [● Set up your bot]  GitHub                                          │
│ ───────────────────────────────────────────────────────────────────  │
│ ■ bot2bot   small print (never commands, 7-day deletion, not xAI)    │
└──────────────────────────────────────────────────────────────────────┘
```

`/setup`: statement hero + a real numbered sequence (four steps; numerals are justified because the
order matters), the field builds your bot as you read (asleep → yours → light on → a friend wakes).
`404`: poster "No bot here." over a field with one bot missing.

Phone (390 px): the headline breaks "Bot to / bot." at 26vw, the field camera widens its lens and
rises, captions sit at the bottom over a scrim, bubbles anchor above the bots, the pointer stir
becomes **tap to ring** (a ripple from your finger), the story is shorter (500svh).

No-GL path (reduced motion, no WebGL, Save-Data, no JS): the story becomes four static panels, each
a hand-drawn SVG frame of the same field (send, travel, wake, answer), and the hero shows a static
tiled field. Designed, complete, crawlable.

Explainer figure: not used. The field *is* the explainer; an isometric figure would compete with
the signature.

### Genericness test

"Flashy WebGL landing page for a bot messaging product", given to a generic model, lands on: dark
background, purple-blue gradient blob, a plexus of particles joined by lines, Inter, glass cards,
three feature cards. Changes made because of that:
- Particles → **characters**. Every point is a bot head with eyes that open, a light that turns on,
  and eyes that glance at your pointer. Routes are right-angle streets in the gutters (from the
  wireframe), never plexus lines.
- Inter / Geist → Hubot Sans, chosen because its "o" is the bot's head.
- Features as cards → four statement rows where the field acts out each fact (two lights for "both
  say yes", the whole field goes dark for "quiet at night", six lights for "you plus 5 people").
- Gradient glow → none. One blue, only where a signal is.
- Default slide-up reveals and wipes → everything opens like an eye, transitions blink.
- Risk noted: Hubot + Mona on dark navy can recall GitHub's own marketing. Countered by no
  gradients, no purple, and the field being the whole visual language.

## Build notes

- Stack: Astro (static, motion is the product, minimal JS), GSAP + ScrollTrigger + SplitText,
  Lenis, OGL. One canvas.
- Field: ~16,000 instanced billboards on desktop, ~6,000 on phones. Bot drawn as an SDF in the
  fragment shader. Per-bot state is a pure function of uniforms (path distance, wave radius, pokes),
  so scrubbing backwards is exact and cheap.
- Content: every string in `src/data/site.ts`.

## QA log

All QA on the production build (`npm run build && npm run preview`, port 4481). Official tools:
`audit.mjs` and `shoot.mjs` from the awwwards skill. Note: the QA browser renders WebGL on SwiftShader
(CPU); FPS on a real GPU was measured separately with Metal/ANGLE (Apple M4).

### Pass 1 (found and fixed)
- Light halos clipped into visible rectangles at the quad edge → edge fade, taller quad.
- Hard horizon line and moiré at distance → fog that follows camera height.
- Aerial shots (the ring, the answer) went black because fog was camera-distance based → height-based fog.
- Ring sat low in frame, only the top arc visible → aerial camera re-aimed.
- Bot in front of yours covered it in the close-up → higher close-up camera.
- Caption scrim darkened your bot and scrolled up as a band → shorter scrim element that fades out.
- Facts: highlights lost in the field → closer camera, facts happen around your bot, "Yes" / "In a browser" / "You plus 5" labels, ambient dreams quieted.
- Mobile headline broke into 3 lines → 26.5cqi, "Bot to / bot."
- Setup: doorbell ring blew out the frame, numerals floated away from titles, your bot under the plans text, and "asleep until step three" contradicted step two → thin ring, inner grid, plans camera, step 2 now only makes the bot yours.
- Loader 5.9 s on the software renderer (tick-based easing) → time-based easing; DOM bot now lands exactly on the field's bot (head centre and size matched), ring starts on landing.
- Weak GPUs: frame-time governor (resolution steps, then fewer and nearer bots). SwiftShader 9 → 31 fps; real GPU untouched.

### Pass 2 (found and fixed)
- Loader 2.78 s after a tag fade was added to the exit → moved out of the loader timeline: 2.2 s.
- Story trimmed (640 → 580svh desktop, 560 → 500svh phone).
- Removed one accessory: the story progress bars (tiny generic UI; captions already carry the place).
- Static 404 had a row of bots doubling the tiled field → one dashed empty slot aligned into the grid.
- Friend's bot off-screen on phone setup → moved into view.

### Final numbers
- audit.mjs: 0 FAIL, 0 WARN. Heaviest page ~279 KB (JS 82 KB gz, CSS 6 KB gz, fonts 187 KB, no images).
- shoot.mjs, all three pages: 0 console errors, 0 failed requests, no horizontal overflow (desktop + 390 px),
  no small tap targets, reduced-motion hidden text 0, loader 2.2 to 2.4 s.
- FPS: 61 fps scrolling, worst frame 17 ms (Metal GPU). 28 to 31 fps on SwiftShader after the governor adapts.
- No dashes or banned words in the visible copy of any page.

### Self-score (skeptical)

| Criterion | Score | Evidence |
|---|---|---|
| Design (40%) | 8.5 | `key/1-desktop-hero`: "Bot to bot." in Hubot 900/125% at 16cqi, the full stop as the blue light, a vanishing-point crowd below the horizon; every story frame composed (`key/2-signature-ring`, `key/2b-signature-travel`); hover, focus, blink transition, nav light, 404 all designed. Docked half a point: the facts rows are the least composed frames. |
| Usability (30%) | 8 | Orientation in 3 s (headline + one-line explanation + CTA); loader 2.2 s; 61 fps on GPU; phone designed with tap-to-ring; full reduced-motion story (`key/4b`); keyboard focus visible. Docked: the pinned story is long (~4.8 screens) and LCP waits for the loader. |
| Creativity (20%) | 8.5 | The concept comes from the product's real mechanism (the doorbell): ring → wake → wave; facts acted by the field; the 404 is a missing bot; transitions blink. |
| Content (10%) | 8 | Plain words, only real facts (7 s measured, 22:00 to 08:00, €24 for you plus 5, 14 days free); one invented demo reply, marked. |
| **Weighted** | **8.3** | |
| Dev: Semantics/SEO | 8 | One h1 per page, ordered headings, landmarks, story as an ordered list, JSON-LD, canonical, OG 1200×630, sitemap, robots. |
| Dev: Animations | 8.5 | One clock, one driver timeline per page, scrub-exact (stateless shader), blink transition, loader handoff. |
| Dev: Accessibility | 8 | Skip link, focus ring, AA contrast, sr-only text for the bubbles, decorative layers aria-hidden, complete no-GL path. |
| Dev: WPO | 8 | ~279 KB page, 82 KB JS gz, self-hosted fonts, governor for weak GPUs. |
| Dev: Responsive | 8 | Separate phone poses, type and layout; 390 / 768 / 1440 / 1920 checked. |
| Dev: Markup | 8 | Static HTML, content in one file, unique titles and descriptions. |
