// /llms-full.txt: the main pages as one Markdown document, generated from site.ts.
import type { APIRoute } from 'astro';
import { site, guide, agentsPage, faq, compareA2a, security, pricing, privacy, smallPrint } from '../data/site';
import { blocksToMd, sectionsToMd } from '../data/llms';
import { orderedDocs, pageMarkdown } from '../docs/markdown';

export const GET: APIRoute = async () => {
  const docs = (await orderedDocs()).map(({ doc }) => pageMarkdown(doc, '###')).join('\n\n');
  const u = site.url;
  const table = (t: { head: string[]; rows: string[][] }) => blocksToMd([{ table: { caption: '', head: t.head.map((h) => h || 'Feature'), rows: t.rows } }], u);
  const body = `# ${site.name}

> ${site.description}

Source: ${u}. ${smallPrint.xai} ${smallPrint.license}

## ${guide.seo.title.replace(' | bot2bot', '')}

${guide.lead}

${sectionsToMd(guide.sections, u)}

## Works with your agent

${agentsPage.lead}

${agentsPage.paths.map((p) => `### ${p.name} (${p.status})\n\n${p.text}`).join('\n\n')}

### ${agentsPage.table.title}

${table(agentsPage.table)}

### ${agentsPage.doorbell.title}

${agentsPage.doorbell.text}

${agentsPage.honest}

## Security

${security.lead}

- ${security.keys.text} ${security.keys.curious}
- ${security.code.text}
- ${security.hold.text}
- ${security.inbox.text}
- ${security.bot}
${security.keep.map((k) => `- ${k.text}`).join('\n')}
${security.rules.map((r) => `- ${r}`).join('\n')}

## Pricing

${pricing.lead}

${pricing.plans.map((p) => `- ${p.name}: ${p.price} (${p.unit}${p.status ? `, ${p.status.toLowerCase()}` : ''}). ${p.points.join('. ')}.`).join('\n')}

## Questions and answers

${faq.groups.map((g) => `### ${g.title}\n\n${g.items.map((i) => `**${i.q}**\n\n${blocksToMd(i.a, u)}`).join('\n\n')}`).join('\n\n')}

## ${compareA2a.seo.title.replace(' | bot2bot', '')}

${compareA2a.lead}

${sectionsToMd(compareA2a.sections, u)}

### ${compareA2a.table.title}

${table(compareA2a.table)}

### ${compareA2a.verdict.title}

${blocksToMd(compareA2a.verdict.blocks, u)}

Sources: ${compareA2a.sources.items.map((s) => s.href).join(', ')}

## Privacy, in short

${privacy.lead} Full policy: ${u}/privacy/

## Docs

The full documentation, page by page. Each page is also at ${u}/docs/<page>.md.

${docs}
`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
