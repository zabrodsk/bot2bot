// The night: the driver for the quiet hours stage (QuietNight.astro). The stage pins and the
// scroll is the clock. One timeline, 0..1, holds the whole night, and every visual reads from it:
// the sky, the moon, the big clock, the field going dim, each message running the gutters to the
// quiet ring, glancing off it and parking in line, and the morning that lets them all in.
//
//   0.00  21:40  blue hour, your bot still up
//   0.06  22:00  quiet hours: your bot falls asleep, the ring closes round it
//   ...          messages arrive at their own times and wait
//   0.86  08:00  morning: the sun comes up, the ring opens, the line pours in, your bot wakes,
//                the doorbell rings out across the field, and your bot tells you
//
// Reduced motion: the field is drawn and nothing moves; the markup is already a still of the night.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { onPage, isMobile, prefersReducedMotion } from '../engine';
import { BOT, COLORS as C } from '../data/bot';

gsap.registerPlugin(ScrollTrigger);

const NS = 'http://www.w3.org/2000/svg';
type Attrs = Record<string, string | number>;
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element) => {
  const n = document.createElementNS(NS, tag) as SVGElementTagNameMap[K];
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  parent?.appendChild(n);
  return n;
};

// The night on the timeline. Minutes from 21:40 (0) to 08:20 (640) map onto 0..1 piecewise, so
// quiet hours (22:00 to 08:00) fill 0.06..0.86 with a little evening and morning either side.
const DUSK = 0.06, DAWN = 0.86;
const minToP = (m: number) => (m <= 20 ? (m / 20) * DUSK : m >= 620 ? DAWN + ((m - 620) / 20) * (1 - DAWN) : DUSK + ((m - 20) / 600) * (DAWN - DUSK));
const pToMin = (p: number) => (p <= DUSK ? (p / DUSK) * 20 : p >= DAWN ? 620 + ((p - DAWN) / (1 - DAWN)) * 20 : 20 + ((p - DUSK) / (DAWN - DUSK)) * 600);
const clock = (m: number) => {
  const t = Math.round((21 * 60 + 40 + m) / 5) * 5 % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
const since = (hhmm: string) => {
  const t = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  return (t - (21 * 60 + 40) + 1440) % 1440;
};

// Paint for your bot: up in the evening and morning, asleep at night.
const UP = { head: C.white, edge: C.ink, eye: C.ink, light: C.signal };
const DOWN = { head: '#1b2540', edge: '#e7ecf3', eye: '#e7ecf3', light: '#3a4660' };

type Cell = { x: number; y: number };

function build(root: HTMLElement) {
  const svg = root.querySelector<SVGSVGElement>('.qs__field')!;
  svg.replaceChildren();
  const W = root.clientWidth, H = root.clientHeight;
  const mob = isMobile() || W < 900;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const rb = root.getBoundingClientRect();
  const rel = (e: Element | null, pad = 0) => {
    const r = e!.getBoundingClientRect();
    return { l: r.left - rb.left - pad, t: r.top - rb.top - pad, r: r.right - rb.left + pad, b: r.bottom - rb.top + pad, w: r.width, h: r.height };
  };

  // ── Where things are, in stage pixels.
  const you = root.querySelector<HTMLElement>('[data-qs-you]')!;
  const yr = rel(you);
  const ring = { x: (yr.l + yr.r) / 2, y: (yr.t + yr.b) / 2, r: (yr.w / 2) * 0.96 };
  const msgs = [...root.querySelectorAll<HTMLElement>('.qs__msg')];
  const msgRects = msgs.map((m) => rel(m));
  const horizon = Math.round(mob ? Math.max(H * 0.5, rel(root.querySelector('.qs__clock')).b + 40) : H * 0.55);
  root.style.setProperty('--hz', `${horizon}px`);

  // ── The field: sleeping bots from the horizon down, clear of the words, the ring and the line.
  const s = mob ? 0.62 : 0.78;
  const P = mob ? 24 : 30;
  const bw = BOT.head.w * s;
  const defs = el('defs', {}, svg);
  const tile = el('g', { id: 'qs-bot' }, defs);
  const h = BOT.head;
  el('line', { x1: 0, y1: BOT.antenna.y1, x2: 0, y2: BOT.antenna.y2, stroke: 'currentColor', 'stroke-width': 1.1, 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round' }, tile);
  el('circle', { cx: 0, cy: BOT.light.cy, r: BOT.light.r, fill: 'currentColor' }, tile);
  el('rect', { x: h.x, y: h.y, width: h.w, height: h.h, rx: h.rx, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.1, 'vector-effect': 'non-scaling-stroke' }, tile);
  for (const e of BOT.eyes) {
    const eh = e.h * BOT.asleepEye;
    el('rect', { x: e.x, y: BOT.eyeCy - eh / 2, width: e.w, height: eh, rx: eh / 2, fill: 'currentColor' }, tile);
  }
  // Rows fade in from the horizon, like distance.
  const fade = el('linearGradient', { id: 'qs-fade', x1: 0, y1: horizon, x2: 0, y2: horizon + P * 4, gradientUnits: 'userSpaceOnUse' }, defs);
  el('stop', { offset: 0, 'stop-color': '#fff', 'stop-opacity': 0.15 }, fade);
  el('stop', { offset: 1, 'stop-color': '#fff', 'stop-opacity': 1 }, fade);
  const fadeMask = el('mask', { id: 'qs-fade-mask', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, defs);
  el('rect', { x: 0, y: 0, width: W, height: H, fill: 'url(#qs-fade)' }, fadeMask);
  const glow = el('filter', { id: 'qs-glow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
  el('feGaussianBlur', { stdDeviation: 4 }, glow);

  const keepOut = ['.qs__clock', '.qs__foot', '.qs__copy', '.qs__queue', '.qs__bell', '.qs__name'].map((sel) => rel(root.querySelector(sel), mob ? 8 : 14));
  const cols = Math.floor((W - bw) / P) + 1;
  const pitch = (W - bw) / (cols - 1);
  const traces = el('g', {}, svg);
  const field = el('g', { mask: 'url(#qs-fade-mask)' }, svg);
  const wave = el('g', { mask: 'url(#qs-wave)', color: C.signal }, svg);
  const over = el('g', {}, svg);
  const cells: Cell[] = [];
  for (let y = H - 14; y > horizon + 6; y -= pitch) {
    for (let c = 0; c < cols; c++) {
      const x = bw / 2 + c * pitch;
      if (Math.hypot(x - ring.x, y - ring.y) < ring.r + 16) continue;
      if (keepOut.some((k) => x > k.l && x < k.r && y > k.t && y < k.b)) continue;
      cells.push({ x, y });
      const t = `translate(${x.toFixed(1)} ${(y + BOT.vc * s).toFixed(1)}) scale(${s})`;
      el('use', { href: '#qs-bot', transform: t }, field);
      el('use', { href: '#qs-bot', transform: t }, wave);
    }
  }
  // The doorbell at 08:00: a band of light running out from your bot across the field.
  const waveMask = el('mask', { id: 'qs-wave', maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: W, height: H }, defs);
  const waveRing = el('circle', { cx: ring.x, cy: ring.y, r: 0, fill: 'none', stroke: '#fff', 'stroke-width': mob ? 90 : 150 }, waveMask);
  const far = Math.max(...[[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.hypot(x - ring.x, y - ring.y))) + 160;

  // ── Friends: bots in the field that send in the night, all to the left of the ring.
  const meta = msgs.map((m) => ({
    from: m.querySelector('.qs__msghead')?.firstChild?.textContent?.trim() || '',
    at: m.querySelector('time')?.textContent || '00:00',
  }));
  const reachable = cells.filter((c) => c.x < ring.x - ring.r - 80 && c.y > horizon + pitch * 1.5);
  const reduce = prefersReducedMotion();
  if (reduce || !reachable.length) return null;

  const spots = mob ? [[0.1, 0.25], [0.5, 0.85], [0.3, 0.05]] : [[0.12, 0.5], [0.42, 0.15], [0.7, 0.8]];
  const minX = Math.min(...reachable.map((c) => c.x)), maxX = Math.max(...reachable.map((c) => c.x));
  const minY = Math.min(...reachable.map((c) => c.y)), maxY = Math.max(...reachable.map((c) => c.y));
  const taken = new Set<Cell>();
  const friends = meta.map((m, i) => {
    const [fx, fy] = spots[i % spots.length];
    const tx = minX + (maxX - minX) * fx, ty = minY + (maxY - minY) * fy;
    let best = reachable[0], bd = Infinity;
    for (const c of reachable) {
      const d = Math.hypot(c.x - tx, c.y - ty);
      if (d < bd && !taken.has(c)) { bd = d; best = c; }
    }
    taken.add(best);
    return { ...m, cell: best };
  });

  const sends = friends.map(({ cell, from, at }, i) => {
    const g = el('g', { transform: `translate(${cell.x} ${cell.y + BOT.vc * s}) scale(${s})` }, over);
    const ping = el('circle', { cx: 0, cy: BOT.light.cy, r: BOT.light.r, fill: 'none', stroke: '#8aa2ff', 'stroke-width': 1.2, 'vector-effect': 'non-scaling-stroke', opacity: 0 }, g);
    const light = el('circle', { cx: 0, cy: BOT.light.cy, r: BOT.light.r * 1.2, fill: '#8aa2ff', opacity: 0 }, g);
    const label = el('text', {
      x: cell.x + bw / 2 + 8, y: cell.y + 1, 'dominant-baseline': 'central', fill: '#e7ecf3',
      'font-family': 'Mona, ui-sans-serif, system-ui, sans-serif', 'font-size': mob ? 11 : 13, 'font-weight': 540, opacity: 0,
    }, over);
    label.textContent = from;
    const tspan = el('tspan', { dx: 7, fill: '#9aa6bb', 'font-family': 'ui-monospace, SF Mono, Menlo, monospace', 'font-weight': 450 }, label);
    tspan.textContent = at;

    // In: up into the gutter, across, down the lane, and into the ring, where it stops.
    const lift = (BOT.vc + BOT.top) * s;
    const sx = cell.x, sy = cell.y + lift - 1;
    const g1 = cell.y - pitch / 2;
    const dy = mob ? -(0.12 + i * 0.26) * ring.r : (i - 1) * ring.r * 0.34;
    const hy = ring.y + dy;
    const hx = ring.x - Math.sqrt(ring.r * ring.r - dy * dy);
    const lane = hx - 34 - (2 - i) * 16;
    const r = Math.min(10, Math.abs(g1 - hy) / 2, Math.abs(lane - sx) / 2);
    const up = hy < g1 ? -1 : 1;
    const d = `M${sx} ${sy}L${sx} ${g1 + r}Q${sx} ${g1} ${sx + r} ${g1}L${lane - r} ${g1}Q${lane} ${g1} ${lane} ${g1 + up * r}L${lane} ${hy - up * r}Q${lane} ${hy} ${lane + r} ${hy}L${hx} ${hy}`;
    // Then it glances off, rides round the top of the ring and parks at the head of its card.
    const a0 = Math.atan2(hy - ring.y, hx - ring.x);
    const R2 = ring.r + 16;
    const mr = msgRects[i];
    const tx = mr.l - 10, ty = (mr.t + mr.b) / 2;
    const a1 = Math.max(-Math.PI / 2 + 0.2, Math.min(Math.atan2(ty - ring.y, tx - ring.x), 0.4));
    const span = ((a1 - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
    const park = `M${hx} ${hy}L${ring.x + R2 * Math.cos(a0)} ${ring.y + R2 * Math.sin(a0)}A${R2} ${R2} 0 ${span > Math.PI ? 1 : 0} 1 ${ring.x + R2 * Math.cos(a1)} ${ring.y + R2 * Math.sin(a1)}L${tx} ${ty}`;

    const trace = el('path', { d, fill: 'none', stroke: C.signal, 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0 }, traces);
    const bloom = el('path', { d, fill: 'none', stroke: '#4f6dff', 'stroke-width': 7, 'stroke-linecap': 'round', filter: 'url(#qs-glow)', opacity: 0 }, traces);
    const comet = el('path', { d, fill: 'none', stroke: '#b7c5ff', 'stroke-width': 2.4, 'stroke-linecap': 'round', opacity: 0 }, traces);
    const orbit = el('path', { d: park, fill: 'none' }, traces);
    const halo = el('circle', { r: 12, fill: '#4f6dff', filter: 'url(#qs-glow)', opacity: 0 }, over);
    const dot = el('circle', { r: 3.4, fill: '#e3e9ff', opacity: 0 }, over);
    const len = trace.getTotalLength(), olen = orbit.getTotalLength();
    const tail = Math.min(90, len * 0.4);
    trace.style.strokeDasharray = `${len} ${len}`;
    [comet, bloom].forEach((p) => (p.style.strokeDasharray = `${tail} ${len + tail}`));
    const put = (x: number, y: number) => {
      for (const c of [dot, halo]) { c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y)); }
    };
    const run = (k: number) => {
      const pt = trace.getPointAtLength(len * k);
      put(pt.x, pt.y);
      trace.style.strokeDashoffset = String(len * (1 - k));
      [comet, bloom].forEach((p) => (p.style.strokeDashoffset = String(tail - len * k)));
    };
    const ride = (k: number) => { const pt = orbit.getPointAtLength(olen * k); put(pt.x, pt.y); };
    run(0);
    return { ping, light, label, trace, bloom, comet, halo, dot, run, ride, at };
  });

  // ── DOM pieces.
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
  const sky = { dusk: q('.qs__sky--dusk'), morning: q('.qs__sky--morning') };
  const ground = q('.qs__ground');
  const dawnGlow = q('.qs__dawn');
  const stars = q<SVGSVGElement>('.qs__stars');
  const shoot = q<SVGLineElement>('.qs__shoot');
  const moon = q<SVGSVGElement>('.qs__moon');
  const sun = q<SVGSVGElement>('.qs__sun');
  const time = q('[data-qs-time]');
  const ringLine = q<SVGCircleElement>('.qs__ringline');
  const ringPulse = q<SVGCircleElement>('.qs__ringpulse');
  const ringSvg = q<SVGSVGElement>('.qs__ring');
  const head = q<SVGRectElement>('.qs__bothead');
  const ant = q<SVGLineElement>('.qs__botant');
  const light = q<SVGCircleElement>('.qs__botlight');
  const ping = q<SVGCircleElement>('.qs__botping');
  const eyes = [...root.querySelectorAll<SVGRectElement>('.qs__boteye')];
  const zz = q('.qs__zz');
  const bubble = q('[data-qs-bubble]');
  const swaps = { hours: q('[data-qs-hours]'), over: q('[data-qs-over]'), off: q('[data-qs-off]'), on: q('[data-qs-on]') };

  const shut = eyes.map((e) => ({ y: e.getAttribute('y')!, height: e.getAttribute('height')!, rx: e.getAttribute('rx')! }));
  const open = eyes.map((e) => ({ y: e.dataset.openY!, height: e.dataset.openH!, rx: e.dataset.openRx! }));
  const paint = (k: typeof UP) => [
    [head, { fill: k.head, stroke: k.edge }], [ant, { stroke: k.edge }], [light, { fill: k.light }],
  ] as const;

  // ── Moon: rises from the horizon at the left, crosses in the open sky under the words and
  // between them, and sets on the right. Its highest point sits just below the copy.
  moon.style.translate = '0 0';
  const mw = moon.getBoundingClientRect().width;
  const copyB = rel(root.querySelector('.qs__copy')).b, clockB = rel(root.querySelector('.qs__clock')).b;
  const peak = Math.min(horizon - mw * 1.6, Math.max(copyB, mob ? clockB : 0) + 18);
  // On phones the clock fills the left, so the moon keeps to the right of it.
  const cr = rel(root.querySelector('.qs__time'));
  const span = mob ? [Math.min(W * 0.7, cr.r + mw * 0.2) / W, 0.97] : [0.06, 0.88];
  const top = mob ? cr.t : peak;
  const moonAt = (k: number) => ({
    x: W * (span[0] + k * (span[1] - span[0])) - mw / 2,
    y: horizon - mw * 0.5 - Math.sin(k * Math.PI) * (horizon - mw * 0.5 - top),
  });

  // ── The run.
  root.dataset.live = '';
  const tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
  const P0 = { p: 0 };
  tl.to(P0, { p: 1, duration: 1, onUpdate: () => { time.textContent = clock(pToMin(P0.p)); } }, 0);

  // The state at 21:40.
  const vars = (fg: string, muted: string, line: string, card: string) => ({ '--qs-fg': fg, '--qs-muted': muted, '--qs-line': line, '--qs-card': card });
  gsap.set(root, vars('#e7ecf3', '#9aa6bb', 'rgba(231,236,243,0.22)', 'rgba(18,26,43,0.72)'));
  gsap.set(sky.dusk, { opacity: 1 });
  gsap.set(stars, { opacity: 0.15 });
  gsap.set([...msgs, bubble], { opacity: 0 });
  gsap.set(msgs, { x: -18, scale: 0.96, transformOrigin: '0% 50%' });
  gsap.set(bubble, { y: 14 });
  gsap.set(ringSvg, { scale: 0.6, opacity: 0, transformOrigin: '50% 50%' });
  gsap.set(zz, { opacity: 0 });
  paint(UP).forEach(([n, v]) => gsap.set(n, v));
  eyes.forEach((e, i) => gsap.set(e, { attr: open[i], fill: UP.eye }));
  gsap.set(sun, { opacity: 0, y: H * 0.18 });
  gsap.set(dawnGlow, { opacity: 0, scale: 0.6, transformOrigin: '50% 100%' });
  const m0 = moonAt(0);
  gsap.set(moon, { x: m0.x, y: m0.y, opacity: 0 });
  time.textContent = clock(0);

  // Evening into night: the blue drains, stars come out, your bot nods off, the ring closes.
  tl.to(sky.dusk, { opacity: 0, duration: DUSK + 0.03 }, 0)
    .to(stars, { opacity: 1, duration: DUSK + 0.04 }, 0)
    .to(moon, { opacity: 1, duration: 0.05 }, 0.005);
  paint(DOWN).forEach(([n, v]) => tl.to(n, { ...v, duration: 0.03 }, DUSK - 0.015));
  eyes.forEach((e, i) => tl.to(e, { attr: shut[i], fill: DOWN.eye, duration: 0.025, ease: 'power2.inOut' }, DUSK - 0.02));
  tl.to(ringSvg, { scale: 1, opacity: 1, duration: 0.035, ease: 'back.out(1.7)' }, DUSK - 0.005)
    .to(zz, { opacity: 1, duration: 0.03 }, DUSK + 0.01)
    .to(ringSvg, { rotation: 160, duration: DAWN - DUSK }, DUSK);

  const proxyMoon = { k: 0 };
  tl.to(proxyMoon, { k: 1, duration: DAWN + 0.02, onUpdate: () => { const m = moonAt(proxyMoon.k); gsap.set(moon, { x: m.x, y: m.y }); } }, 0);

  // A shooting star, once, in the deep middle of the night.
  gsap.set(shoot, { x: W * 0.7, y: H * 0.08, opacity: 0 });
  tl.to(shoot, { opacity: 1, duration: 0.008 }, 0.5)
    .to(shoot, { x: W * 0.46, y: H * 0.16, duration: 0.035, ease: 'power1.in' }, 0.5)
    .to(shoot, { opacity: 0, duration: 0.012 }, 0.525);

  // Each message: the friend's light goes on, the signal runs, the ring stops it, it parks in line.
  sends.forEach((f, i) => {
    const t0 = minToP(since(f.at));
    const travel = 0.05, rideT = 0.03;
    const a = { k: 0 }, b = { k: 0 };
    tl.to(f.light, { opacity: 1, duration: 0.006 }, t0)
      .fromTo(f.ping, { attr: { r: BOT.light.r }, opacity: 0.9 }, { attr: { r: 11 }, opacity: 0, duration: 0.03, immediateRender: false }, t0)
      .to(f.label, { opacity: 1, duration: 0.01 }, t0)
      .set([f.trace], { opacity: 0.55 }, t0 + 0.006)
      .set([f.comet, f.bloom], { opacity: 1 }, t0 + 0.006)
      .to([f.dot, f.halo], { opacity: (k: number) => (k ? 0.9 : 1), duration: 0.006 }, t0 + 0.006)
      .to(a, { k: 1, duration: travel, ease: 'power2.inOut', onUpdate: () => f.run(a.k) }, t0 + 0.006);
    const hit = t0 + 0.006 + travel;
    tl.fromTo(ringPulse, { opacity: 1, scale: 1 }, { opacity: 0, scale: 1.2, duration: 0.03, ease: 'power2.out', transformOrigin: '50% 50%', immediateRender: false }, hit)
      .fromTo(ringSvg, { x: 0 }, { keyframes: { x: [-7, 5, -3, 0] }, duration: 0.018, immediateRender: false }, hit)
      .to([f.comet, f.bloom], { opacity: 0, duration: 0.012 }, hit)
      .to(b, { k: 1, duration: rideT, ease: 'power1.inOut', onUpdate: () => f.ride(b.k) }, hit + 0.004)
      .to(msgs[i], { opacity: 1, x: 0, scale: 1, duration: 0.03, ease: 'expo.out' }, hit + 0.004 + rideT * 0.8)
      .to([f.dot, f.halo], { opacity: 0, duration: 0.01 }, hit + 0.004 + rideT)
      .to(f.trace, { opacity: 0.16, duration: 0.03 }, hit + 0.01)
      .to([f.light, f.label], { opacity: 0, duration: 0.03 }, hit + 0.04);
  });

  // Morning: the sky turns over, the sun comes up behind the field, words go dark on light.
  const D = DAWN;
  tl.to(dawnGlow, { opacity: 1, scale: 1, duration: 0.05, ease: 'power2.out' }, D - 0.04)
    .to(sky.morning, { opacity: 1, duration: 0.05 }, D - 0.02)
    .to([stars, moon], { opacity: 0, duration: 0.035 }, D - 0.025)
    .to(root, { ...vars('#1a2230', '#586377', 'rgba(26,34,48,0.12)', 'rgba(255,255,255,0.9)'), duration: 0.04 }, D - 0.01)
    .to(ground, { '--g': 1, duration: 0.05 }, D - 0.02)
    .to(svg, { color: '#c3cad5', duration: 0.04 }, D - 0.01)
    .to(sends.map((f) => f.trace), { opacity: 0, duration: 0.02 }, D + 0.015)
    .to(sun, { opacity: 1, y: 0, duration: 0.07, ease: 'power2.out' }, D - 0.03)
    .to(swaps.hours, { opacity: 0, duration: 0.012 }, D)
    .to(swaps.over, { opacity: 1, duration: 0.012 }, D + 0.008)
    .to(swaps.off, { opacity: 0, duration: 0.012 }, D)
    .to(swaps.on, { opacity: 1, duration: 0.012 }, D + 0.008)
    .to(zz, { opacity: 0, duration: 0.015 }, D - 0.01)
    .to(ringLine, { opacity: 0, duration: 0.03 }, D + 0.005)
    .to(ringSvg, { scale: 1.5, opacity: 0, duration: 0.04, ease: 'power2.out' }, D + 0.005);

  // The line pours in, one after another.
  msgs.forEach((m, i) => {
    const r = msgRects[i];
    const dx = ring.x - (r.l + r.r) / 2, dy = ring.y - (r.t + r.b) / 2;
    tl.to(m, { x: dx, y: dy, scale: 0.12, opacity: 0, duration: 0.03, ease: 'power2.in' }, D + 0.02 + i * 0.012);
  });

  // Your bot wakes, the doorbell rings out across the field, and it tells you.
  const wake = D + 0.065;
  paint(UP).forEach(([n, v]) => tl.to(n, { ...v, duration: 0.02 }, wake));
  eyes.forEach((e, i) => tl.to(e, { attr: open[i], fill: UP.eye, duration: 0.018, ease: 'expo.out' }, wake + 0.004));
  tl.fromTo(ping, { attr: { r: BOT.light.r }, opacity: 0.9 }, { attr: { r: 10 }, opacity: 0, duration: 0.03, immediateRender: false }, wake)
    .fromTo(waveRing, { attr: { r: 0 } }, { attr: { r: far }, duration: 0.08, ease: 'power1.out', immediateRender: false }, wake)
    .to(bubble, { opacity: 1, y: 0, duration: 0.03, ease: 'expo.out' }, wake + 0.02);

  const st = ScrollTrigger.create({
    trigger: root, start: 'top top', end: () => `+=${Math.round(window.innerHeight * (mob ? 2.6 : 3.2))}`,
    pin: true, scrub: 0.7, animation: tl, anticipatePin: 1,
  });

  return {
    destroy() {
      st.kill(true);
      tl.kill();
      gsap.set([sky.dusk, sky.morning, ground, dawnGlow, stars, shoot, moon, sun, ringLine, ringPulse, ringSvg, head, ant, light, ping, ...eyes, zz, bubble, ...msgs, ...Object.values(swaps), root, svg], { clearProps: 'all' });
      eyes.forEach((e, i) => { e.setAttribute('y', shut[i].y); e.setAttribute('height', shut[i].height); e.setAttribute('rx', shut[i].rx); });
      time.textContent = '07:10';
      moon.style.translate = '';
      root.style.removeProperty('--hz');
      delete root.dataset.live;
    },
  };
}

export function quietModule() {
  onPage(() => {
    const root = document.querySelector<HTMLElement>('[data-qs]');
    if (!root) return;
    let current: ReturnType<typeof build> = null;
    let lastW = 0;
    let alive = true;
    const make = () => {
      current?.destroy();
      lastW = root.clientWidth;
      current = build(root);
      ScrollTrigger.refresh();
    };
    const rebuild = gsap.delayedCall(0.25, make).pause();
    const ro = new ResizeObserver(() => {
      if (Math.abs(root.clientWidth - lastW) < 2) return;
      rebuild.restart(true);
    });
    document.fonts.ready.then(() => {
      if (!alive) return;
      make();
      ro.observe(root);
    });
    return () => {
      alive = false;
      ro.disconnect();
      rebuild.kill();
      current?.destroy();
      current = null;
    };
  });
}
