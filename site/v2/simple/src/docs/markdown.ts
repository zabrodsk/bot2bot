// Plain Markdown views of the docs, for AI agents: /docs/<page>.md, the docs part of /llms.txt and
// /llms-full.txt. Built from the same MDX as the pages, with Starlight's components turned into
// ordinary Markdown (callouts become quotes, tabs become labelled sections, cards become lists).
import { getCollection, type CollectionEntry } from 'astro:content';
import { sidebar } from './sidebar.mjs';
import { site } from '../data/site';

type Doc = CollectionEntry<'docs'>;
const base = site.url;

/** docs/quickstart -> /docs/quickstart.md, docs -> /docs/index.md */
export const mdPath = (id: string) => `/docs/${id.replace(/^docs\/?/, '') || 'index'}.md`;
export const htmlPath = (id: string) => `/docs/${id.replace(/^docs\/?/, '')}${id === 'docs' ? '' : '/'}`;

const attrs = (s: string) => Object.fromEntries([...s.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const dedent = (s: string) => {
  const lines = s.replace(/^\n+|\s+$/g, '').split('\n');
  const n = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(n)).join('\n');
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// In-docs links point at the Markdown views; other site paths become absolute.
const absolute = (s: string) => s.replace(/\]\((\/[^)\s]*)\)/g, (_m, p: string) => {
  const d = p.match(/^\/docs\/?([^#]*?)\/?(#.*)?$/);
  if (d) return `](${base}${mdPath(d[1] ? `docs/${d[1]}` : 'docs')}${d[2] ?? ''})`;
  return `](${base}${p})`;
});

export function mdxToMarkdown(mdx: string): string {
  let s = mdx.replace(/^import .*\n/gm, '');
  // Indentation of the opening tag is kept, so blocks inside list items stay inside them.
  s = s.replace(/^( *)<Aside([^>]*)>\n?([\s\S]*?)<\/Aside>/gm, (_m, ind: string, a: string, inner: string) => {
    const { type = 'note', title } = attrs(a);
    const label = title ? `${cap(type)}: ${title}` : cap(type);
    return dedent(inner).split('\n').map((l, i) => `${ind}> ${i ? l : `**${label}.** ${l}`}`.trimEnd()).join('\n');
  });
  s = s.replace(/^( *)<TabItem([^>]*)>\n?([\s\S]*?)<\/TabItem>/gm, (_m, ind: string, a: string, inner: string) =>
    `${ind}**${attrs(a).label}:**\n\n${dedent(inner).split('\n').map((l) => (l ? ind + l : l)).join('\n')}\n`);
  // Cards only sit in card grids, so they become a plain top-level list.
  s = s.replace(/^( *)<Card(\s[^>]*)>\n?([\s\S]*?)<\/Card>/gm, (_m, _ind: string, a: string, inner: string) => `- **${attrs(a).title}.** ${dedent(inner).replace(/\n+/g, ' ')}`);
  s = s.replace(/^( *)<LinkCard([^>]*)\/>/gm, (_m, _ind: string, a: string) => { const { title, description, href } = attrs(a); return `- [${title}](${href}): ${description}`; });
  s = s.replace(/<Badge([^>]*)\/>/g, (_m, a: string) => `(${attrs(a).text})`);
  s = s.replace(/^ *<\/?(Steps|Tabs|CardGrid)[^>]*>\n?/gm, '');
  return absolute(s).replace(/\n{3,}/g, '\n\n').trim();
}

/** The docs pages in sidebar order, with their group. */
export async function orderedDocs() {
  const all = new Map((await getCollection('docs')).map((d) => [d.id, d]));
  return sidebar.flatMap((g: { label: string; items: { slug: string }[] }) =>
    g.items.map((i) => ({ group: g.label, doc: all.get(i.slug) })).filter((x): x is { group: string; doc: Doc } => !!x.doc));
}

export function pageMarkdown(doc: Doc, heading = '#') {
  const sub = heading + '#';
  const body = mdxToMarkdown(doc.body ?? '').replace(/^(#{2,6}) /gm, (_m, h: string) => `${'#'.repeat(Math.min(6, h.length + sub.length - 2))} `);
  return `${heading} ${doc.data.title}

> ${doc.data.description}

Page: ${base}${htmlPath(doc.id)} · Markdown: ${base}${mdPath(doc.id)}

${body}`;
}
