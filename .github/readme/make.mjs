// Draws the README illustrations: one light and one dark version of each, as animated SVG.
// GitHub shows SVG through <img>, so everything here is plain SVG + CSS: no scripts, no web fonts.
// Run: node .github/readme/make.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The site's colours: ink, signal blue, and the doorbell's warm amber. Asleep is grey.
const THEMES = {
  light: {
    card: '#f6f7f9', edge: '#e3e6eb', ink: '#1a2230', mute: '#69738a', wire: '#c3c9d4',
    bot: '#ffffff', sleep: '#e3e6ec', blue: '#2747c9', amber: '#d4851a', ok: '#1f8f4e',
    term: '#1a2230', termInk: '#e9ecf2', termMute: '#8790a4', bubble: '#ffffff',
  },
  dark: {
    card: '#111722', edge: '#232c3b', ink: '#e6e9ef', mute: '#8b94a7', wire: '#3a4558',
    bot: '#1b2230', sleep: '#202836', blue: '#7f97ff', amber: '#f0b04a', ok: '#4cc283',
    term: '#090d14', termInk: '#e9ecf2', termMute: '#7d869a', bubble: '#1b2230',
  },
};

const SANS = `-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif`;
const MONO = `ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`;

const base = (c) => `
  .card { fill: ${c.card}; stroke: ${c.edge}; }
  .sans { font-family: ${SANS}; }
  .mono { font-family: ${MONO}; }
  .ink { fill: ${c.ink}; } .mute { fill: ${c.mute}; } .blue { fill: ${c.blue}; } .amber { fill: ${c.amber}; } .ok { fill: ${c.ok}; }
  .head { fill: ${c.bot}; stroke: ${c.ink}; stroke-width: 2.5; }
  .eye { fill: ${c.ink}; }
  .lid { fill: none; stroke: ${c.ink}; stroke-width: 2.5; stroke-linecap: round; }
  .stalk { stroke: ${c.ink}; stroke-width: 2.5; stroke-linecap: round; }
  .wire { fill: none; stroke: ${c.wire}; stroke-width: 2; stroke-dasharray: 2 7; stroke-linecap: round; }
  .fill-in { transform-box: fill-box; transform-origin: center; }
`;

// A bot face: rounded head, two eyes, an antenna. Centred on (x, y).
const bot = ({ x, y, cls = '', eyes = 'open', id = '' }) => `
  <g ${id ? `id="${id}"` : ''} class="${cls}">
    <line class="stalk" x1="${x}" y1="${y - 38}" x2="${x}" y2="${y - 56}"/>
    <circle class="tip" cx="${x}" cy="${y - 61}" r="5.5"/>
    <rect class="head" x="${x - 48}" y="${y - 38}" width="96" height="76" rx="24"/>
    ${eyes === 'open' || eyes === 'both' ? `<g class="open"><circle class="eye" cx="${x - 18}" cy="${y - 2}" r="6.5"/><circle class="eye" cx="${x + 18}" cy="${y - 2}" r="6.5"/></g>` : ''}
    ${eyes === 'shut' || eyes === 'both' ? `<g class="shut"><path class="lid" d="M${x - 26} ${y - 3} q8 7 16 0"/><path class="lid" d="M${x + 10} ${y - 3} q8 7 16 0"/></g>` : ''}
  </g>`;

// A sealed envelope with a lock badge, drawn around (0, 0).
const envelope = (c) => `
  <rect x="-19" y="-13" width="38" height="26" rx="5" fill="${c.bot}" stroke="${c.ink}" stroke-width="2"/>
  <path d="M-19 -12 L0 3 L19 -12" fill="none" stroke="${c.ink}" stroke-width="2" stroke-linejoin="round"/>
  <g class="lock anim">
    <circle cx="17" cy="-13" r="9.5" fill="${c.blue}"/>
    <path class="shackle" d="M13.6 -14 v-2.6 a3.4 3.4 0 0 1 6.8 0 v2.6" fill="none" stroke="${c.card}" stroke-width="1.8"/>
    <rect x="12.4" y="-14.2" width="9.2" height="7" rx="1.6" fill="${c.card}"/>
  </g>`;

const svg = ({ w, h, title, desc, css, body }) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="t d">
<title id="t">${title}</title>
<desc id="d">${desc}</desc>
<style>${css}</style>
<rect class="card" x="1" y="1" width="${w - 2}" height="${h - 2}" rx="26" stroke-width="1.5"/>
${body}
</svg>
`;

// ───── 1. Hero: Tom's bot sends a sealed message; the relay rings Anna's sleeping bot awake ─────
// One 12 s loop. Times in the comments are seconds into the loop.
function hero(c) {
  const T = '12s';
  const css = base(c) + `
  .anim { animation-duration: ${T}; animation-iteration-count: infinite; animation-timing-function: cubic-bezier(.65,0,.35,1); }
  /* 0 to 1.6: the command types itself */
  .typing { animation-name: type; animation-timing-function: steps(33, end); }
  @keyframes type { 0% { transform: translateX(0); } 13.3%, 95% { transform: translateX(268px); } 100% { transform: translateX(0); } }
  .cursor { animation: blink 1s steps(1) infinite; } @keyframes blink { 50% { opacity: 0; } }
  /* 1.6: sealed, 1.9 to 3.4: to the relay, 6.2 to 7.6: on to Anna's bot */
  .env { animation-name: env; }
  @keyframes env {
    0%, 13% { transform: translate(236px, 200px) scale(.4); opacity: 0; }
    15.8% { transform: translate(236px, 200px) scale(1); opacity: 1; }
    28.3%, 51.7% { transform: translate(480px, 200px) scale(1); opacity: 1; }
    63.3%, 90% { transform: translate(712px, 200px) scale(1); opacity: 1; }
    95%, 100% { transform: translate(712px, 200px) scale(1); opacity: 0; }
  }
  /* 7.6: the lock opens on Anna's bot, nowhere else */
  .lock { animation-name: unlock; transform-box: fill-box; transform-origin: center; }
  @keyframes unlock { 0%, 63.3% { transform: none; opacity: 1; } 67% { transform: translate(4px, -14px) rotate(18deg); opacity: 0; } 99.9% { opacity: 0; } 100% { transform: none; opacity: 1; } }
  /* 3.4 to 4.0: the relay holds it */
  .relay-glow { animation-name: hold; opacity: 0; }
  @keyframes hold { 0%, 27% { opacity: 0; } 30%, 36% { opacity: 1; } 42%, 100% { opacity: 0; } }
  /* 4.0 to 4.8: a signal runs to the doorbell */
  .signal { stroke: ${c.amber}; stroke-width: 3; fill: none; stroke-linecap: round; stroke-dasharray: 12 100; stroke-dashoffset: 12; animation-name: signal; opacity: 0; }
  @keyframes signal { 0%, 33% { stroke-dashoffset: 12; opacity: 0; } 33.4% { opacity: 1; } 40% { stroke-dashoffset: -88; opacity: 1; } 41%, 100% { stroke-dashoffset: -88; opacity: 0; } }
  /* 4.8 to 6.0: the bell swings and the ring spreads */
  .bell { animation-name: swing; transform-box: fill-box; transform-origin: 50% 8%; }
  @keyframes swing { 0%, 40% { transform: rotate(0); } 42% { transform: rotate(16deg); } 44% { transform: rotate(-14deg); } 46% { transform: rotate(10deg); } 48% { transform: rotate(-6deg); } 50%, 100% { transform: rotate(0); } }
  .bell-body { fill: ${c.wire}; animation-name: bellc; } @keyframes bellc { 0%, 39% { fill: ${c.wire}; } 41%, 56% { fill: ${c.amber}; } 62%, 100% { fill: ${c.wire}; } }
  .ring { fill: none; stroke: ${c.amber}; stroke-width: 2; opacity: 0; animation-name: ring; transform-box: fill-box; transform-origin: center; }
  .ring.r2 { animation-delay: .35s; }
  @keyframes ring { 0%, 40% { transform: scale(.55); opacity: 0; } 41% { opacity: .9; } 52% { transform: scale(1.25); opacity: 0; } 100% { opacity: 0; } }
  /* 5.6 to 6.2: Anna's bot wakes; 11.4: back to sleep */
  #anna .head { animation-name: wakehead; } @keyframes wakehead { 0%, 46% { fill: ${c.sleep}; } 50%, 94% { fill: ${c.bot}; } 100% { fill: ${c.sleep}; } }
  #anna .tip { animation-name: waketip; } @keyframes waketip { 0%, 40% { fill: ${c.wire}; } 42%, 94% { fill: ${c.amber}; } 100% { fill: ${c.wire}; } }
  #anna .open { animation-name: opens; } @keyframes opens { 0%, 47% { opacity: 0; } 49%, 94% { opacity: 1; } 96%, 100% { opacity: 0; } }
  #anna .shut { animation-name: shuts; } @keyframes shuts { 0%, 47% { opacity: 1; } 49%, 94% { opacity: 0; } 96%, 100% { opacity: 1; } }
  #tom .tip { fill: ${c.blue}; }
  .z { animation-name: zz; } .z2 { animation-delay: .5s; } .z3 { animation-delay: 1s; }
  @keyframes zz { 0%, 38% { opacity: .9; transform: translateY(0); } 44% { opacity: 0; transform: translateY(-12px); } 96% { opacity: 0; transform: translateY(6px); } 100% { opacity: .9; transform: translateY(0); } }
  .st-asleep { animation-name: shuts; } .st-awake { animation-name: opens; }
  /* 8.0 to 10.6: Anna's bot tells her */
  .bubble { animation-name: bubble; transform-box: fill-box; transform-origin: 92% 100%; }
  @keyframes bubble { 0%, 66% { opacity: 0; transform: scale(.85) translateY(6px); } 69%, 90% { opacity: 1; transform: none; } 94%, 100% { opacity: 0; transform: none; } }
  /* The log under the scene */
  .log { opacity: 0; }
  .l2 { animation-name: log2; } .l3 { animation-name: log3; } .l4 { animation-name: log4; }
  @keyframes log2 { 0%, 15.8% { opacity: 0; transform: translateY(4px); } 18%, 94% { opacity: 1; transform: none; } 97%, 100% { opacity: 0; } }
  @keyframes log3 { 0%, 40% { opacity: 0; transform: translateY(4px); } 42%, 94% { opacity: 1; transform: none; } 97%, 100% { opacity: 0; } }
  @keyframes log4 { 0%, 66.7% { opacity: 0; transform: translateY(4px); } 69%, 94% { opacity: 1; transform: none; } 97%, 100% { opacity: 0; } }
  .l1 { animation-name: log1; } @keyframes log1 { 0%, 94% { opacity: 1; } 97%, 99% { opacity: 0; } 100% { opacity: 1; } }
  .term { fill: ${c.term}; } .t-ink { fill: ${c.termInk}; } .t-mute { fill: ${c.termMute}; }
  .t-blue { fill: ${c.blue === '#2747c9' ? '#9fb2ff' : c.blue}; } .t-amber { fill: ${c.amber === '#d4851a' ? '#f3b860' : c.amber}; } .t-ok { fill: ${c.ok === '#1f8f4e' ? '#6fd39b' : c.ok}; }

  /* Still frame for reduced motion: the message waits, sealed, at the relay. */
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; }
    .env { transform: translate(480px, 200px); opacity: 1; }
    .typing { transform: translateX(268px); }
    .log, .l2 { opacity: 1; } .l3, .l4, .bubble, .st-awake, #anna .open { opacity: 0; }
    #anna .head { fill: ${c.sleep}; } #anna .tip { fill: ${c.wire}; }
  }
  `;
  const body = `
  <!-- wires -->
  <path class="wire" d="M222 200 H414"/>
  <path class="wire" d="M546 200 H738"/>
  <path class="wire" d="M480 158 C 530 70, 690 52, 768 92" />
  <path class="signal anim" pathLength="100" d="M480 158 C 530 70, 690 52, 768 92" />

  <!-- Tom's bot, awake -->
  ${bot({ x: 170, y: 200, id: 'tom' })}
  <text class="sans ink" x="170" y="276" text-anchor="middle" font-size="16" font-weight="600">Tom’s bot</text>
  <text class="mono mute" x="170" y="296" text-anchor="middle" font-size="12">awake</text>

  <!-- The relay: holds the message, can't open it -->
  <g>
    <rect x="404" y="148" width="152" height="104" rx="30" fill="${c.amber}" opacity=".16" class="relay-glow anim"/>
    <rect x="416" y="160" width="128" height="80" rx="20" fill="${c.bot}" stroke="${c.ink}" stroke-width="2.5"/>
    ${[184, 200, 216].map((y, i) => `<circle cx="438" cy="${y}" r="3.2" fill="${i === 1 ? c.amber : c.wire}"/><line x1="450" y1="${y}" x2="${522 - i * 14}" y2="${y}" stroke="${c.wire}" stroke-width="3" stroke-linecap="round"/>`).join('')}
  </g>
  <text class="sans ink" x="480" y="276" text-anchor="middle" font-size="16" font-weight="600">The relay</text>
  <text class="mono mute" x="480" y="296" text-anchor="middle" font-size="12">carries it, can’t read it</text>

  <!-- The doorbell -->
  <g class="bell anim">
    <line x1="790" y1="64" x2="790" y2="74" stroke="${c.wire}" stroke-width="2"/>
    <path class="bell-body anim" d="M776 100 c0 -16 5 -25 14 -26 c9 1 14 10 14 26 l5 6 h-38 z"/>
    <circle cx="790" cy="110" r="3.6" class="bell-body anim"/>
  </g>
  <text class="mono mute" x="822" y="96" font-size="12">doorbell</text>

  <!-- Anna's bot, asleep until the doorbell rings -->
  <circle class="ring anim" cx="790" cy="190" r="74"/>
  <circle class="ring r2 anim" cx="790" cy="190" r="74"/>
  ${bot({ x: 790, y: 200, id: 'anna', cls: 'anna', eyes: 'both' }).replace(/class="(head|tip|open|shut)"/g, 'class="$1 anim"')}
  <g class="mono" fill="${c.mute}">
    <text class="z anim" x="848" y="160" font-size="14">z</text>
    <text class="z z2 anim" x="862" y="140" font-size="18">z</text>
    <text class="z z3 anim" x="880" y="118" font-size="22">z</text>
  </g>
  <text class="sans ink" x="790" y="276" text-anchor="middle" font-size="16" font-weight="600">Anna’s bot</text>
  <text class="mono mute st-asleep anim" x="790" y="296" text-anchor="middle" font-size="12">asleep</text>
  <text class="mono amber st-awake anim" x="790" y="296" text-anchor="middle" font-size="12" opacity="0">woken by the doorbell</text>

  <!-- What Anna's bot tells her -->
  <g class="bubble anim">
    <rect x="522" y="104" width="216" height="42" rx="15" fill="${c.bubble}" stroke="${c.edge}" stroke-width="1.5"/>
    <path d="M716 145 l18 16 l-2 -16 z" fill="${c.bubble}"/>
    <path d="M716 146 l18 15 l-2 -15" fill="none" stroke="${c.edge}" stroke-width="1.5"/>
    <text class="sans ink" x="630" y="130" text-anchor="middle" font-size="14">Tom asks: dinner on Sunday?</text>
  </g>

  <!-- The message itself -->
  <g class="env anim">${envelope(c)}</g>

  <!-- A log of what happened -->
  <rect class="term" x="32" y="322" width="896" height="106" rx="16"/>
  <g class="mono" font-size="13.5">
    <g class="log l1 anim">
      <text class="t-mute" x="56" y="350">tom’s bot $</text>
      <text class="t-ink" x="154" y="350">b2b send anna "Dinner on Sunday?"</text>
      <g class="typing anim"><rect x="152" y="335" width="290" height="22" class="term"/><rect class="cursor t-ink" x="153" y="338" width="8" height="16"/></g>
    </g>
    <text class="log l2 anim" x="56" y="372"><tspan class="t-blue">sealed</tspan><tspan class="t-mute"> for anna’s bot only, signed by tom’s bot, sent to the relay</tspan></text>
    <text class="log l3 anim" x="56" y="394"><tspan class="t-amber">doorbell</tspan><tspan class="t-mute"> the relay rings anna’s bot: one sealed message waiting</tspan></text>
    <text class="log l4 anim" x="56" y="416"><tspan class="t-ok">opened</tspan><tspan class="t-mute"> on anna’s bot, signature checked, passed on to anna</tspan></text>
  </g>`;
  return svg({ w: 960, h: 452, css, body,
    title: 'Tom’s bot sends a sealed message to Anna’s sleeping bot',
    desc: 'Tom’s bot seals a message for Anna’s bot and sends it to the relay. The relay cannot read it. It rings a doorbell that wakes Anna’s bot, which opens the message and tells Anna.' });
}

// ───── 2. What the relay sees, and what Anna's bot sees ─────
function sees(c) {
  const T = '6s';
  const noise = [
    'Xq9vT2c0kLmB4wZ7hN1pR8sYfE3jAu6dGo',
    'm3KbV8yQ0tWc5LnZ2rHx9fJp7gAs1EdUo4',
    'Z0pNc7RhqY2vK9wLm4Tb8xFs1GjE6dAu3o',
    'f8LwQ2nK5yVb0tRc9mZh3pXs7JgA1EdU6o',
  ];
  const css = base(c) + `
  .panel { fill: ${c.bot}; stroke: ${c.edge}; stroke-width: 1.5; }
  .row { stroke: ${c.edge}; stroke-width: 1.5; }
  .n { opacity: 0; animation: n ${T} infinite steps(1); }
  ${noise.map((_, i) => `.n${i} { animation-delay: ${(-i * 1.5).toFixed(1)}s; }`).join(' ')}
  @keyframes n { 0% { opacity: 1; } 25%, 100% { opacity: 0; } }
  .reveal { animation: reveal ${T} infinite cubic-bezier(.65,0,.35,1); }
  @keyframes reveal { 0%, 10% { transform: scaleX(1); } 40%, 85% { transform: scaleX(0); } 100% { transform: scaleX(1); } }
  .cover { transform-box: fill-box; transform-origin: 100% 50%; }
  .key { animation: key ${T} infinite cubic-bezier(.65,0,.35,1); transform-box: fill-box; transform-origin: center; }
  @keyframes key { 0%, 8% { transform: translateX(-14px); opacity: 0; } 14%, 40% { transform: none; opacity: 1; } 48%, 100% { transform: translateX(10px); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } .n0 { opacity: 1; } .cover { transform: scaleX(0); } .key { opacity: 0; } }
  `;
  const rows = [['From', 'tom’s bot'], ['To', 'anna’s bot'], ['When', 'Sun 19:42'], ['Size', '412 bytes'], ['Delivered', 'yes']];
  const body = `
  <!-- Left: the relay -->
  <text class="sans ink" x="40" y="54" font-size="17" font-weight="600">What the relay sees</text>
  <text class="sans mute" x="40" y="76" font-size="13.5">Enough to wake the right bot. Not the words.</text>
  <rect class="panel" x="40" y="96" width="420" height="230" rx="18"/>
  ${rows.map(([k, v], i) => `
    <text class="sans mute" x="62" y="${130 + i * 30}" font-size="13.5">${k}</text>
    <text class="mono ink" x="170" y="${130 + i * 30}" font-size="13.5">${v}</text>
    <line class="row" x1="62" x2="438" y1="${140 + i * 30}" y2="${140 + i * 30}"/>`).join('')}
  <text class="sans mute" x="62" y="${130 + rows.length * 30 + 4}" font-size="13.5">Text</text>
  <g class="mono" font-size="13.5" fill="${c.mute}">
    ${noise.map((s, i) => `<text class="n n${i}" x="170" y="${134 + rows.length * 30}">${s.slice(0, 30)}</text>`).join('')}
  </g>

  <!-- Middle: the key only Anna's bot has -->
  <g class="key">
    <circle cx="500" cy="210" r="10" fill="none" stroke="${c.blue}" stroke-width="3"/>
    <path d="M510 210 h22 m-7 0 v8 m-8 -8 v6" fill="none" stroke="${c.blue}" stroke-width="3" stroke-linecap="round"/>
  </g>

  <!-- Right: Anna's bot -->
  <text class="sans ink" x="560" y="54" font-size="17" font-weight="600">What Anna’s bot sees</text>
  <text class="sans mute" x="560" y="76" font-size="13.5">Only her bot has the key that opens it.</text>
  <rect class="panel" x="560" y="96" width="360" height="230" rx="18"/>
  <text class="sans mute" x="582" y="130" font-size="13.5">From Tom’s bot</text>
  <text class="sans ink" x="582" y="168" font-size="20" font-weight="500">Dinner on Sunday?</text>
  <text class="sans ink" x="582" y="196" font-size="20" font-weight="500">Gran is coming too.</text>
  <g font-size="13.5" class="sans">
    <rect x="582" y="222" width="120" height="34" rx="17" fill="none" stroke="${c.edge}" stroke-width="1.5"/>
    <text class="ink" x="642" y="244" text-anchor="middle">Yes, we’re in</text>
    <rect x="712" y="222" width="110" height="34" rx="17" fill="none" stroke="${c.edge}" stroke-width="1.5"/>
    <text class="ink" x="767" y="244" text-anchor="middle">Can’t make it</text>
  </g>
  <circle cx="590" cy="292" r="7" fill="${c.ok}"/>
  <path d="M586.5 292 l2.5 2.5 l4.5 -5" fill="none" stroke="${c.bot}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  <text class="sans mute" x="604" y="297" font-size="13.5">Signature checked: it really came from Tom’s bot</text>
  <rect class="cover reveal" x="574" y="146" width="336" height="118" rx="10" fill="${c.bot}"/>
  `;
  return svg({ w: 960, h: 360, css, body,
    title: 'What the relay sees, and what the receiving bot sees',
    desc: 'The relay sees who sent a message to whom, when, its size and whether it was delivered. The text is scrambled. Only the receiving bot can open it and check who sent it.' });
}

// ───── 3. Both say yes: two slides, then the bots are connected ─────
function yes(c) {
  const T = '8s';
  const css = base(c) + `
  .track { fill: ${c.bot}; stroke: ${c.edge}; stroke-width: 1.5; }
  .grip { fill: ${c.ink}; }
  .done { fill: ${c.ink}; }
  .on-grip { fill: ${c.bot}; }
  .anim { animation-duration: ${T}; animation-iteration-count: infinite; animation-timing-function: cubic-bezier(.65,0,.35,1); }
  .g1 { animation-name: g1; } .g2 { animation-name: g2; }
  @keyframes g1 { 0%, 6% { transform: none; } 22%, 92% { transform: translateX(232px); } 100% { transform: none; } }
  @keyframes g2 { 0%, 34% { transform: none; } 50%, 92% { transform: translateX(232px); } 100% { transform: none; } }
  .f1 { animation-name: f1; transform-box: fill-box; transform-origin: 0 50%; } .f2 { animation-name: f2; transform-box: fill-box; transform-origin: 0 50%; }
  @keyframes f1 { 0%, 21% { transform: scaleX(0); opacity: 0; } 24%, 92% { transform: scaleX(1); opacity: 1; } 96%, 100% { transform: scaleX(0); opacity: 0; } }
  @keyframes f2 { 0%, 49% { transform: scaleX(0); opacity: 0; } 52%, 92% { transform: scaleX(1); opacity: 1; } 96%, 100% { transform: scaleX(0); opacity: 0; } }
  .s1 { animation-name: s1; } .s2 { animation-name: s2; }
  @keyframes s1 { 0%, 10% { opacity: 1; } 16%, 94% { opacity: 0; } 100% { opacity: 1; } }
  @keyframes s2 { 0%, 38% { opacity: 1; } 44%, 94% { opacity: 0; } 100% { opacity: 1; } }
  .link { stroke: ${c.blue}; stroke-width: 3; fill: none; stroke-linecap: round; stroke-dasharray: 100; stroke-dashoffset: 100; animation-name: link; }
  @keyframes link { 0%, 54% { stroke-dashoffset: 100; } 66%, 92% { stroke-dashoffset: 0; } 97%, 100% { stroke-dashoffset: 100; } }
  .wait { animation-name: wait; } @keyframes wait { 0%, 54% { opacity: 1; } 58%, 94% { opacity: 0; } 100% { opacity: 1; } }
  .conn { animation-name: conn; opacity: 0; } @keyframes conn { 0%, 62% { opacity: 0; } 68%, 92% { opacity: 1; } 96%, 100% { opacity: 0; } }
  .tipb { fill: ${c.wire}; animation-name: tipb; } @keyframes tipb { 0%, 62% { fill: ${c.wire}; } 66%, 92% { fill: ${c.blue}; } 96%, 100% { fill: ${c.wire}; } }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; }
    .g1, .g2 { transform: translateX(232px); } .f1, .f2 { transform: none; opacity: 1; } .s1, .s2, .wait { opacity: 0; }
    .link { stroke-dashoffset: 0; } .conn { opacity: 1; } .tipb { fill: ${c.blue}; }
  }
  `;
  const slide = (y, who, n) => `
    <text class="sans mute" x="44" y="${y - 12}" font-size="13.5">${who}</text>
    <rect class="track" x="40" y="${y}" width="296" height="56" rx="28"/>
    <text class="sans mute s${n} anim" x="208" y="${y + 33}" text-anchor="middle" font-size="14">Slide to say yes</text>
    <rect class="done f${n} anim" x="44" y="${y + 4}" width="288" height="48" rx="24"/>
    <text class="sans f${n} anim" x="188" y="${y + 33}" text-anchor="middle" font-size="14" font-weight="600" fill="${c.bot}">Yes, connect</text>
    <g class="g${n} anim">
      <rect class="grip" x="44" y="${y + 4}" width="48" height="48" rx="24"/>
      <path d="M62 ${y + 28} h12 m-5 -5 l5 5 l-5 5" fill="none" stroke="${c.bot}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    </g>`;
  const mini = (x, label) => `
    <line class="stalk" x1="${x}" y1="96" x2="${x}" y2="84"/><circle class="tipb anim" cx="${x}" cy="80" r="4.5"/>
    <rect class="head" x="${x - 34}" y="96" width="68" height="54" rx="18"/>
    <circle class="eye" cx="${x - 12}" cy="122" r="4.8"/><circle class="eye" cx="${x + 12}" cy="122" r="4.8"/>
    <text class="sans ink" x="${x}" y="178" text-anchor="middle" font-size="14" font-weight="600">${label}</text>`;
  const body = `
  ${slide(60, 'Tom', 1)}
  ${slide(158, 'Anna', 2)}
  <path class="wire" d="M582 123 H822"/>
  <path class="link anim" pathLength="100" d="M582 123 H822"/>
  ${mini(540, 'Tom’s bot')}
  ${mini(864, 'Anna’s bot')}
  <text class="mono mute wait anim" x="702" y="206" text-anchor="middle" font-size="12.5">waiting for both of them</text>
  <text class="mono blue conn anim" x="702" y="206" text-anchor="middle" font-size="12.5">connected: the bots can talk</text>
  `;
  return svg({ w: 960, h: 246, css, body,
    title: 'Both people say yes before their bots can talk',
    desc: 'Tom slides to say yes, then Anna slides to say yes. Only then is a line drawn between their two bots: connected.' });
}

for (const [name, draw] of Object.entries({ hero, sees, yes })) {
  for (const [mode, c] of Object.entries(THEMES)) writeFileSync(join(here, `${name}-${mode}.svg`), draw(c));
}
console.log('wrote', Object.keys(THEMES).length * 3, 'SVGs to', here);
