// Draws the README illustration in a light and a dark version, as animated SVG.
// GitHub shows SVG through <img>, so this is plain SVG + CSS: no scripts, no web fonts.
// Run: node .github/readme/make.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// bot2bot's colours: ink, signal blue, green for "matches".
const THEMES = {
  light: { card: '#f6f7f9', edge: '#e3e6eb', ink: '#1a2230', mute: '#69738a', wire: '#c3c9d4', bot: '#ffffff', blue: '#2747c9', ok: '#1f8f4e', chip: '#ffffff' },
  dark: { card: '#111722', edge: '#232c3b', ink: '#e6e9ef', mute: '#8b94a7', wire: '#3a4558', bot: '#1b2230', blue: '#7f97ff', ok: '#4cc283', chip: '#1b2230' },
};
const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif`;
const MONO = `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`;

// A bot face: rounded head, two eyes, an antenna. Centred on (x, y).
const bot = (x, y) => `
  <line class="stalk" x1="${x}" y1="${y - 38}" x2="${x}" y2="${y - 56}"/>
  <circle class="blue" cx="${x}" cy="${y - 61}" r="5.5"/>
  <rect class="head" x="${x - 48}" y="${y - 38}" width="96" height="76" rx="24"/>
  <circle class="eye" cx="${x - 18}" cy="${y - 2}" r="6.5"/><circle class="eye" cx="${x + 18}" cy="${y - 2}" r="6.5"/>`;

// The safety number chip under each bot. Both show the same number, which is the point.
const chip = (x, y) => `
  <g class="match anim">
    <rect x="${x - 122}" y="${y}" width="244" height="34" rx="17" class="chip"/>
    <circle cx="${x - 100}" cy="${y + 17}" r="8" class="okfill"/>
    <path d="M${x - 104} ${y + 17} l3 3 l5.5 -6" fill="none" class="tick"/>
    <text x="${x - 84}" y="${y + 22}" class="mono ink" font-size="14">31823 65671 64139 66409</text>
  </g>`;

function hero(c) {
  const W = 960, H = 350, Y = 152;
  const css = `
  .card { fill: ${c.card}; stroke: ${c.edge}; }
  .sans { font-family: ${SANS}; } .mono { font-family: ${MONO}; }
  .ink { fill: ${c.ink}; } .mute { fill: ${c.mute}; } .blue { fill: ${c.blue}; }
  .head { fill: ${c.bot}; stroke: ${c.ink}; stroke-width: 2.5; }
  .eye { fill: ${c.ink}; } .stalk { stroke: ${c.ink}; stroke-width: 2.5; stroke-linecap: round; }
  .wire { fill: none; stroke: ${c.wire}; stroke-width: 2; stroke-dasharray: 2 7; stroke-linecap: round; }
  .chip { fill: ${c.chip}; stroke: ${c.edge}; } .okfill { fill: ${c.ok}; } .tick { stroke: ${c.card}; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .relay { fill: ${c.bot}; stroke: ${c.ink}; stroke-width: 2.5; }

  /* One 10 s loop. */
  .anim { animation-duration: 10s; animation-iteration-count: infinite; animation-timing-function: cubic-bezier(.65,0,.35,1); }
  /* 0 to 1.2: the two safety numbers appear and match */
  .match { animation-name: match; } @keyframes match { 0% { opacity: 0; } 10%, 92% { opacity: 1; } 100% { opacity: 0; } }
  /* 1.5 to 3.0 to the relay, it waits there, 4.5 to 6.0 on to Anna's bot */
  .env { animation-name: env; }
  @keyframes env {
    0%, 13% { transform: translate(250px, ${Y}px) scale(.4); opacity: 0; }
    16% { transform: translate(250px, ${Y}px) scale(1); opacity: 1; }
    30%, 45% { transform: translate(480px, ${Y - 62}px) scale(1); opacity: 1; }
    60%, 62% { transform: translate(710px, ${Y}px) scale(1); opacity: 1; }
    66%, 100% { transform: translate(710px, ${Y}px) scale(.4); opacity: 0; }
  }
  /* While the message sits in the relay, the relay only shows scrambled bytes */
  .bytes { animation-name: bytes; opacity: 0; } @keyframes bytes { 0%, 28% { opacity: 0; } 32%, 46% { opacity: 1; } 50%, 100% { opacity: 0; } }
  .label { animation-name: label; } @keyframes label { 0%, 28% { opacity: 1; } 32%, 46% { opacity: 0; } 50%, 100% { opacity: 1; } }
  /* 6.2: Anna's bot opens it */
  .bubble { animation-name: bubble; opacity: 0; transform-box: fill-box; transform-origin: bottom center; }
  @keyframes bubble { 0%, 62% { opacity: 0; transform: translateY(6px); } 67%, 92% { opacity: 1; transform: none; } 97%, 100% { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) {
    .anim { animation: none; } .match, .bubble, .label { opacity: 1; } .env, .bytes { opacity: 0; }
  }`;
  const body = `
  <rect class="card" x="1" y="1" width="${W - 2}" height="${H - 2}" rx="22"/>
  <path class="wire" d="M${250 + 40} ${Y} H${480 - 70} M${480 + 70} ${Y} H${710 - 40}"/>

  ${bot(170, Y)}
  <text x="170" y="${Y + 72}" text-anchor="middle" class="sans ink" font-size="16" font-weight="600">Tom’s Grok Bot</text>
  ${chip(170, Y + 92)}

  ${bot(790, Y)}
  <text x="790" y="${Y + 72}" text-anchor="middle" class="sans ink" font-size="16" font-weight="600">Anna’s Grok Bot</text>
  ${chip(790, Y + 92)}

  <rect class="relay" x="410" y="${Y - 36}" width="140" height="72" rx="16"/>
  <text x="480" y="${Y + 6}" text-anchor="middle" class="sans mute label anim" font-size="14">your relay</text>
  <g class="bytes anim">
    <text x="480" y="${Y - 6}" text-anchor="middle" class="mono mute" font-size="13">9fQ3·kx0Z·a7Lp</text>
    <text x="480" y="${Y + 16}" text-anchor="middle" class="mono mute" font-size="13">Wm2r·Tq8e·b1Yc</text></g>
  <text x="480" y="${Y + 72}" text-anchor="middle" class="sans mute" font-size="14">sees scrambled bytes only</text>
  <text x="480" y="${Y + 114}" text-anchor="middle" class="sans mute" font-size="14">same safety number on both sides</text>

  <g class="env anim">
    <rect x="-19" y="-13" width="38" height="26" rx="5" fill="${c.bot}" stroke="${c.ink}" stroke-width="2"/>
    <path d="M-19 -12 L0 3 L19 -12" fill="none" stroke="${c.ink}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="17" cy="-13" r="9.5" class="blue"/>
    <path d="M13.6 -14 v-2.6 a3.4 3.4 0 0 1 6.8 0 v2.6" fill="none" stroke="${c.card}" stroke-width="1.8"/>
    <rect x="12.4" y="-14.2" width="9.2" height="7" rx="1.6" fill="${c.card}"/>
  </g>

  <g class="bubble anim">
    <rect x="690" y="${Y - 128}" width="200" height="44" rx="14" fill="${c.bot}" stroke="${c.edge}"/>
    <path d="M770 ${Y - 84} l10 12 l10 -12" fill="${c.bot}" stroke="${c.edge}"/><rect x="771" y="${Y - 86}" width="18" height="4" fill="${c.bot}"/>
    <text x="790" y="${Y - 100}" text-anchor="middle" class="sans ink" font-size="15">Dinner on Thursday?</text>
  </g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">Two Grok Bots talk through a relay that can’t read them</title>
<desc id="d">Tom’s Grok Bot and Anna’s Grok Bot show the same safety number. Tom’s bot sends a sealed message. Your relay only sees scrambled bytes. Anna’s bot opens it: Dinner on Thursday?</desc>
<style>${css}</style>${body}
</svg>
`;
}

for (const [mode, c] of Object.entries(THEMES)) writeFileSync(join(here, `hero-${mode}.svg`), hero(c));
