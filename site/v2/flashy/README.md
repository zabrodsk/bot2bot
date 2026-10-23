# bot2bot, flashy landing page

A field of ~16,000 sleeping bots in WebGL. Scroll, and your bot sends Anna a recipe: a blue signal runs
the streets between the bots, Anna's bot wakes, a ring of awakenings rolls across the field, and the
answer runs home. Design record: `DESIGN.md`.

## Run

```bash
npm install
npm run build
npm run preview          # production preview on http://127.0.0.1:4481/
npx astro preview stop   # stop it
```

Pages: `/` (home), `/setup/` (how setup works), any unknown URL shows the designed 404.

## Where things live

| What | Where |
|---|---|
| Every visible string, the product name, placeholder URLs | `src/data/site.ts` |
| Colors, type, radius | `src/styles/tokens.css` |
| The field (instanced bots, route, comets) and its shaders | `src/field/field.ts`, `src/field/shaders.ts` |
| The story: one scroll-scrubbed timeline per page | `src/field/scenes.ts` |
| Loader, blink page transition, frame behaviour | `src/motion/setup.ts` |
| Motion engine (scroll, reveals, lifecycle, GL canvas + frame-time governor) | `src/engine/` |
| Drawn frames of the story for reduced motion / no WebGL | `src/components/StoryScene.astro` |

## Before launch

- Set the production URL in `astro.config.mjs` (`site`), `src/data/site.ts` (`url`) and `public/robots.txt`.
- Replace `github: '#'` in `src/data/site.ts`.
- Anna's reply in the story is demo copy. Setup step details follow `docs/PRODUCT.md`; check them against the app.
- Regenerate `public/og.png` if the hero changes.
