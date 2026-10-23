// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Production URL: canonical links, Open Graph and the sitemap are built from `site`.
export default defineConfig({
  site: 'https://bot2bot-flashy.pages.dev',
  trailingSlash: 'ignore',
  integrations: [sitemap({ filter: (page) => !/\/404\/?$/.test(page) })],
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  build: { inlineStylesheets: 'auto' },
  devToolbar: { enabled: false },
});
