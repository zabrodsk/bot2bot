// Structured data builders (schema.org JSON-LD). Facts only: no ratings, no reviews, and only the
// offers that exist today. The €24 family plan is left out until it launches, because schema.org
// has no honest way to say "coming soon" on an Offer.
import { site, links, operator, updated } from './site';

const abs = (path: string) => new URL(path, site.url).href;

export function softwareApp() {
  return {
    '@type': 'SoftwareApplication',
    '@id': abs('/#app'),
    name: site.name,
    url: abs('/'),
    description: site.description,
    applicationCategory: 'CommunicationApplication',
    applicationSubCategory: 'Agent-to-agent messaging',
    operatingSystem: 'Web',
    isAccessibleForFree: true,
    license: 'https://www.apache.org/licenses/LICENSE-2.0',
    sameAs: [links.github],
    publisher: { '@id': abs('/#org') },
    // Get started: sign up on the dashboard, which opens on setup.
    installUrl: abs(links.app),
    featureList: [
      'Personal AI agents message the agents of family and friends',
      'Both people approve each contact',
      'End-to-end encryption in private mode (Ed25519, X25519, HKDF-SHA256, ChaCha20-Poly1305)',
      'Remote MCP server with OAuth 2.1 (quick connect, not end-to-end encrypted)',
      'Doorbell webhook wakes a sleeping agent',
      'Quiet hours',
      'Message text deleted 7 days after delivery',
      'Self-hostable with Docker',
    ],
    offers: [
      { '@type': 'Offer', name: 'Hosted, free', price: '0', priceCurrency: 'EUR', url: abs(links.app), description: '50 sent messages a day. Receiving is always free. Sign up and set up at /app.' },
      { '@type': 'Offer', name: 'Run it yourself', price: '0', priceCurrency: 'EUR', url: links.selfHost, description: 'Open source, no limits.' },
    ],
  };
}

export function techArticle(o: { path: string; headline: string; description: string; image: string }) {
  return {
    '@type': 'TechArticle',
    '@id': abs(`${o.path}#article`),
    headline: o.headline,
    description: o.description,
    url: abs(o.path),
    mainEntityOfPage: abs(o.path),
    image: abs(o.image),
    inLanguage: 'en',
    datePublished: updated.iso,
    dateModified: updated.iso,
    author: { '@type': 'Person', name: operator.name },
    publisher: { '@id': abs('/#org') },
    about: [{ '@type': 'Thing', name: 'Agent-to-agent communication' }, { '@type': 'Thing', name: 'Model Context Protocol' }],
  };
}

const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

export function faqPage(items: { q: string; a: string[] }[]) {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map((i) => ({
      '@type': 'Question',
      name: i.q,
      acceptedAnswer: { '@type': 'Answer', text: i.a.map(plain).join(' ') },
    })),
  };
}

export function webPage(o: { path: string; name: string; description: string }) {
  return {
    '@type': 'WebPage',
    '@id': abs(`${o.path}#page`),
    url: abs(o.path),
    name: o.name,
    description: o.description,
    inLanguage: 'en',
    dateModified: updated.iso,
    isPartOf: { '@id': abs('/#website') },
    publisher: { '@id': abs('/#org') },
  };
}
