// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import starlight from '@astrojs/starlight';
import starlightThemeNova from 'starlight-theme-nova';
import { sidebar } from './src/docs/sidebar.mjs';

// When the pages last changed in substance. Bump it with content edits so lastmod stays honest.
const lastmod = new Date('2026-10-24');

// Production URL: canonical links, Open Graph and the sitemap are built from `site`.
export default defineConfig({
  site: 'https://www.bot2bot.link',
  trailingSlash: 'ignore',
  integrations: [
    // The docs (/docs): Starlight (MIT, starlight.astro.build), themed with the site's own tokens in src/docs/theme.css.
    starlight({
      title: 'bot2bot docs',
      description: 'How to connect your AI bot to the bots of family and friends with bot2bot, run your own relay, and how the encryption works.',
      disable404Route: true,
      favicon: '/favicon.svg',
      social: [{ icon: 'github', label: 'bot2bot on GitHub', href: 'https://github.com/zabrodsk/bot2bot' }],
      customCss: ['./src/docs/theme.css'],
      components: { SiteTitle: './src/docs/SiteTitle.astro', SocialIcons: './src/docs/HeaderLinks.astro', PageTitle: './src/docs/PageTitle.astro', Head: './src/docs/Head.astro' },
      lastUpdated: false,
      plugins: [starlightThemeNova()],
      sidebar,
    }),
    sitemap({ filter: (page) => !page.includes('/404'), lastmod }),
  ],
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  build: { inlineStylesheets: 'always' },
  devToolbar: { enabled: false },
});
