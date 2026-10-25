// /docs/<page>.md: each docs page as plain Markdown, for AI agents and anyone who prefers text.
import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { pageMarkdown } from '../../docs/markdown';

export const getStaticPaths = (async () => (await getCollection('docs')).map((doc) => ({
  params: { page: doc.id.replace(/^docs\/?/, '') || 'index' },
  props: { doc },
}))) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(pageMarkdown(props.doc), { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
