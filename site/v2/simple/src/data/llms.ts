// Plain-text views of the site for language models (/llms.txt and /llms-full.txt), built from the
// same copy as the pages so they can't drift apart.
import type { Block, Section } from './site';

const absLinks = (s: string, base: string) => s.replace(/\]\((\/[^)]*)\)/g, (_m, p) => `](${base}${p})`);

export function blocksToMd(blocks: Block[], base: string): string {
  return blocks.map((b) => {
    if (typeof b === 'string') return absLinks(b, base);
    if ('list' in b) return b.list.map((li, i) => `${b.ordered ? `${i + 1}.` : '-'} ${absLinks(li, base)}`).join('\n');
    if ('table' in b) {
      const row = (r: string[]) => `| ${r.map((c) => absLinks(c, base)).join(' | ')} |`;
      return [row(b.table.head), row(b.table.head.map(() => '---')), ...b.table.rows.map(row)].join('\n');
    }
    return absLinks(b.note, base);
  }).join('\n\n');
}

export function sectionsToMd(sections: Section[], base: string, level = '###') {
  return sections.map((s) => `${level} ${s.title}\n\n${blocksToMd(s.blocks, base)}`).join('\n\n');
}
