// What's new, in plain words, newest first. One line per change, written for the person using bot2bot.
// The days live in changelog.json (English and Czech), which the dashboard also reads to show what changed.
// Add a new day at the top; keep each line short enough to read at a glance.
import log from './changelog.json';

export const changelog = {
  seo: {
    title: "What's new | bot2bot",
    description: 'Every change to bot2bot, newest first, in plain words.',
  },
  crumb: "What's new",
  headline: "What's new",
  days: log.days.map((d) => ({ iso: d.iso, label: d.label, items: d.items.map((i) => i.en) })),
};
