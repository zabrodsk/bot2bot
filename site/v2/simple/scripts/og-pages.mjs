// Per-page Open Graph images (1200x630) for the long-form pages, in the og.png style:
// ground, ink type in Hubot, and one blue wire from your bot to a friend's awake bot.
// Run against the production preview: npm run build && npm run preview, then
//   node scripts/og-pages.mjs
import { chromium } from 'playwright';
const S = process.env.SITE || 'http://127.0.0.1:4482';
const cards = [
  { file: 'agent-to-agent', title: ['Agent to agent,', 'for people.'], sub: 'How personal AI agents message each other safely.' },
  { file: 'agents', title: ['Works with', 'Grok Bot.'], sub: 'Private mode by default, end-to-end encrypted.' },
  { file: 'faq', title: ['Questions', 'and answers.'], sub: 'Agent-to-agent messaging, explained plainly.' },
  { file: 'compare-a2a', title: ['A2A and', 'bot2bot.'], sub: 'An open agent protocol and a relay for personal agents.' },
];
const bot = (x, y, s, kind) => {
  const you = kind === 'you';
  const line = '#1a2230';
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <line x1="0" y1="-6" x2="0" y2="-8.9" stroke="${line}" stroke-width="1.3" stroke-linecap="round"/>
    <circle cx="0" cy="-10.6" r="2" fill="#2747c9"/>
    <rect x="-8.5" y="-6.2" width="17" height="13" rx="4.2" fill="${you ? line : '#fff'}" stroke="${line}" stroke-width="${you ? 0 : 1.3}"/>
    <rect x="-4.7" y="-1.9" width="2.8" height="3.6" rx="1.2" fill="${you ? '#fff' : line}"/>
    <rect x="1.9" y="-1.9" width="2.8" height="3.6" rx="1.2" fill="${you ? '#fff' : line}"/></g>`;
};
const html = (c) => `<!doctype html><html><head><style>
@font-face{font-family:Hubot;src:url(${S}/fonts/hubot-display.woff2);font-weight:400 640}
@font-face{font-family:Mona;src:url(${S}/fonts/mona-text.woff2);font-weight:400 600}
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#f3f5f8;color:#1a2230;font-family:Mona;position:relative;overflow:hidden;-webkit-font-smoothing:antialiased}
.brand{position:absolute;left:64px;top:52px;display:flex;align-items:center;gap:12px;font:600 26px Hubot;letter-spacing:-0.025em}
h1{position:absolute;left:58px;bottom:150px;font:440 112px/0.92 Hubot;letter-spacing:-0.05em;white-space:nowrap}
p{position:absolute;left:64px;bottom:72px;font-size:26px;color:#586377;max-width:760px}
.url{position:absolute;right:64px;bottom:76px;font-size:20px;color:#586377;display:flex;align-items:center;gap:10px}
.url i{width:8px;height:8px;border-radius:50%;background:#2747c9}
svg.fig{position:absolute;right:64px;top:56px}
</style></head><body>
<div class="brand"><svg width="26" height="27" viewBox="-9.5 -13.2 19 20">${bot(0, 0, 1, 'you').replace('stroke-width="1.3" stroke-linecap','stroke-width="1.6" stroke-linecap')}</svg>bot2bot</div>
<svg class="fig" width="360" height="90" viewBox="0 0 360 90">
  <line x1="62" y1="58" x2="298" y2="58" stroke="#2747c9" stroke-width="2.5"/>
  ${bot(34, 58, 2.6, 'you')}${bot(326, 58, 2.6, 'lit')}
</svg>
<h1>${c.title[0]}<br>${c.title[1]}</h1>
<p>${c.sub}</p>
<div class="url"><i></i>bot2bot.link</div>
</body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(`${S}/robots.txt`); // same origin, so the site's fonts load without CORS
for (const c of cards) {
  await page.setContent(html(c), { waitUntil: 'networkidle' });
  await page.evaluate(async () => { await document.fonts.load('440 112px Hubot'); await document.fonts.load('400 26px Mona'); await document.fonts.ready; });
  await page.screenshot({ path: `public/og/${c.file}.png` });
  console.log('wrote public/og/' + c.file + '.png');
}
await browser.close();
