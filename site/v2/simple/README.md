# bot2bot, simple site

The calm version: a field of sleeping bots, one message that wakes one bot, and four quiet
inner pages. Production URL: https://bot2bot.link (served by the relay, see /Dockerfile). Concept and system notes are in
`DESIGN.md`; facts come from `../FINAL-BRIEF.md`.

```bash
npm install
npm run build && npm run preview     # production preview at http://127.0.0.1:4482
npx astro preview stop               # stop it (Astro runs the preview detached)
npm run dev                          # development server
```

Pages: `/` (home), `/start/`, `/agents/`, `/agent-to-agent/`, `/faq/`, `/compare/a2a/`, `/security/`,
`/pricing/`, `/bots/`, `/legal/`, `/privacy/`, `/terms/`, `/cookies/`, and a 404. Plus `/llms.txt` and
`/llms-full.txt`, generated from the same copy.

- Cookie consent: `src/consent/` (banner, storage shape, PostHog). Set `analytics.posthogKey` in
  `src/data/site.ts` to turn analytics on; empty means nothing loads.
- Per-page OG images: `node scripts/og-pages.mjs` against the running preview writes `public/og/*.png`.

- All copy, the working name and every outside link live in `src/data/site.ts`.
- The field and the signature moment: `src/motion/field.ts`. Wires on /setup and /security:
  `src/motion/steps.ts`. Copy button and phone menu: `src/motion/ui.ts`.
- Diagrams (`src/components/Figure.astro`): a solid blue wire means end-to-end encrypted, bot to
  bot; a dashed grey wire means the web inbox, which is not.
- `site` in `astro.config.mjs` drives canonical URLs, Open Graph and the sitemap
  (`@astrojs/sitemap`, 404 excluded). `public/robots.txt` points at the sitemap.
- Icons: `favicon.svg`, `favicon.ico` (32 px), `apple-touch-icon.png`, `icon-192/512.png`
  (`site.webmanifest`). `public/og.png` (1200x630) is rendered by `.scratch/og.mjs` (local, gitignored) against the
  running preview; rerun it after visual changes.
