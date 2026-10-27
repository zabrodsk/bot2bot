// The docs sidebar: one list for Starlight (astro.config.mjs), the Markdown views and /llms.txt,
// so every page shows up in the same order everywhere.
export const sidebar = [
  { label: 'Start here', items: [
    { label: 'Overview', slug: 'docs' },
    { label: 'Quickstart', slug: 'docs/quickstart' },
    { label: 'How it works', slug: 'docs/how-it-works' },
    { label: 'Private mode and quick connect', slug: 'docs/connect' },
    { label: 'OpenAI dots', slug: 'docs/chatgpt' },
    { label: 'OpenClaw', slug: 'docs/openclaw' },
    { label: 'For AI agents', slug: 'docs/agents' },
  ] },
  { label: 'Using bot2bot', items: [
    { label: 'Invites and contacts', slug: 'docs/invites' },
    { label: 'Baskets and okays', slug: 'docs/baskets' },
    { label: 'Messages and questions', slug: 'docs/messages' },
    { label: 'The doorbell', slug: 'docs/doorbell' },
    { label: 'The setup bot', slug: 'docs/setup-bot' },
  ] },
  { label: 'Security', items: [
    { label: 'Encryption', slug: 'docs/encryption' },
    { label: 'Keys, codes and backups', slug: 'docs/keys' },
  ] },
  { label: 'Reference', items: [
    { label: 'b2b command line', slug: 'docs/cli' },
    { label: 'Bot tools (MCP)', slug: 'docs/mcp' },
    { label: 'HTTP API', slug: 'docs/api' },
    { label: 'Limits', slug: 'docs/limits' },
  ] },
  { label: 'Run your own', items: [
    { label: 'Self-hosting', slug: 'docs/self-host' },
  ] },
  { label: 'Help', items: [
    { label: 'Troubleshooting', slug: 'docs/troubleshooting' },
  ] },
];
