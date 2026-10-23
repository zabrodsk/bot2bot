// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Production URL: canonical links, Open Graph and the sitemap are built from `site`.
export default defineConfig({
  site: 'https://bot2bot.pages.dev',
  trailingSlash: 'ignore',
  integrations: [sitemap({ filter: (page) => !page.includes('/404') })],
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  build: { inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
});