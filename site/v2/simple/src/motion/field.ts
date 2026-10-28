// The field: the one driver module of this site. A grid of sleeping bots on the bot pitch,
// your bot bottom left, and ONE message clock (a GSAP timeline) that every concept-bearing
// visual reads from: the signal, the trace, the woken bot, its name, and the bots that step
// aside for it. Nothing else on the page moves.
//
//   <div data-field="wake" data-names='["Anna","Tom","Mia"]' data-you="You"><svg/></div>
//   wake: the signal wakes one friend at a time; the first sits above [data-anchor] ("bot.").
//   miss: (404) the signal lands on an empty cell and nobody answers.
import { gsap } from 'gsap';
import { onPage, ease, isMobile, prefersReducedMotion } from '../engine';
import { BOT, COLORS as C } from '../data/bot';

const NS = 'http://www.w3.org/2000/svg';
type Attrs = Record<string, string | number>;
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element) => {
  const n = document.createElementNS(NS, tag) as SVGElementTagNameMap[K];
  for (const k in attrs) n.setAttribute(k, String(attrs[k]));
  parent?.appendChild(n);
  return n;
};

type Cell = { c: number; r: number; x: number; y: number; node?: SVGElement };
type Live = {
  g: SVGGElement; head: SVGRectElement; eyes: SVGRectElement[]; ant: SVGLineElement;
  light: SVGCircleElement; ring: SVGCircleElement; ring2: SVGCircleElement;
};

/** A bot you can animate. Starts asleep (identical to the tile) unless `you`. */
function liveBot(parent: Element, cell: Cell, s: number, you = false): Live {
  const g = el('g', { transform: `translate(${cell.x} ${cell.y + BOT.vc * s}) scale(${s})` }, parent);
  const h = BOT.head, l = BOT.light;
  const ring = el('circle', { cx: 0, cy: l.cy, r: l.r, fill: 'none', stroke: C.signal, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', opacity: 0 }, g);
  const ring2 = el('circle', { cx: 0, cy: l.cy, r: l.r, fill: 'none', stroke: C.signal, 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', opacity: 0 }, g);
  const ant = el('line', { x1: 0, y1: BOT.antenna.y1, x2: 0, y2: BOT.antenna.y2, 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round' }, g);
  const light = el('circle', { cx: 0, cy: l.cy, r: l.r }, g);
  const head = el('rect', { x: h.x, y: h.y, width: h.w, height: h.h, rx: h.rx, 'vector-effect': 'non-scaling-stroke' }, g);
  const eyes = BOT.eyes.map((e) => el('rect', { x: e.x, y: e.y, width: e.w, height: e.h, rx: e.rx }, g));
  gsap.set(eyes, { transformOrigin: '50% 50%', scaleY: you ? 1 : BOT.asleepEye, fill: you ? C.white : C.sleep });
  gsap.set(head, { fill: you ? C.ink : C.ground, stroke: you ? C.ink : C.sleep, strokeWidth: you ? 1.35 : 1.1 });
  gsap.set(ant, { stroke: you ? C.ink : C.sleep, strokeWidth: you ? 1.35 : 1.1 });
  gsap.set(light, { fill: you ? C.signal : C.sleep });
  return { g, head, eyes, ant, light, ring, ring2 };
}

/** Orthogonal route along the gutters, antenna to antenna, with rounded corners. */
function route(from: Cell, to: Cell, pitch: number, s: number, landOnBot: boolean) {
  const lift = (BOT.vc + BOT.top) * s; // centre → top of the light (negative)
  const start: [number, number] = [from.x, from.y + lift - 1];
  const g1 = from.y - pitch / 2;
  const xg = to.x - pitch / 2;
  const g2 = to.y - pitch / 2;
  const end: [number, number] = [to.x, landOnBot ? to.y + lift - 1 : to.y];
  const pts: [number, number][] = [start, [from.x, g1], [xg, g1], [xg, g2], [to.x, g2], end];
  const R = Math.max(1, Math.min(pitch * 0.25, start[1] - g1 - 0.5));
  let d = `M${start[0]} ${start[1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i - 1], [cx, cy] = pts[i], [nx, ny] = pts[i + 1];
    const l1 = Math.hypot(cx - px, cy - py) || 1, l2 = Math.hypot(nx - cx, ny - cy) || 1;
    const a = [cx - ((cx - px) / l1) * R, cy - ((cy - py) / l1) * R];
    const b = [cx + ((nx - cx) / l2) * R, cy + ((ny - cy) / l2) * R];
    const sweep = (cx - px) * (ny - cy) - (cy - py) * (nx - cx) > 0 ? 1 : 0;
    d += ` L${a[0]} ${a[1]} A${R} ${R} 0 0 ${sweep} ${b[0]} ${b[1]}`;
  }
  return `${d} L${end[0]} ${end[1]}`;
}

function build(root: HTMLElement) {
  // Two layers: the sleeping grid, painted once, and a small live layer on top that holds
  // everything that moves. Animating inside one big SVG repainted all the bots every frame.
  const svg = root.querySelector<SVGSVGElement>('.field__svg:not(.field__live)')!;
  const live = root.querySelector<SVGSVGElement>('.field__live')!;
  svg.replaceChildren();
  live.replaceChildren();
  const mode = root.dataset.field === 'miss' ? 'miss' : 'wake';
  const names: string[] = JSON.parse(root.dataset.names || '[]');
  const reduce = prefersReducedMotion();
  const W = root.clientWidth, H = root.clientHeight;
  const mob = isMobile();
  const P = mob ? 26 : 30, s = mob ? 0.7 : 0.8;
  const bw = BOT.head.w * s, bh = (BOT.bottom - BOT.top) * s;
  const cols = Math.max(6, Math.floor((W - bw) / P) + 1);
  const pitch = (W - bw) / (cols - 1); // columns span exactly from the left to the right margin
  const rows = Math.max(5, Math.floor((H - bh) / pitch) + 1);
  const yLast = H - bh / 2; // the bottom row sits on the field's bottom edge
  for (const layer of [svg, live]) {
    layer.setAttribute('viewBox', `0 0 ${W} ${H}`);
    layer.setAttribute('width', String(W));
    layer.setAttribute('height', String(H));
  }

  const defs = el('defs', {}, svg);
  const tile = el('g', { id: 'bot-asleep' }, defs);
  const h = BOT.head;
  el('line', { x1: 0, y1: BOT.antenna.y1, x2: 0, y2: BOT.antenna.y2, stroke: C.sleep, 'stroke-width': 1.1, 'vector-effect': 'non-scaling-stroke', 'stroke-linecap': 'round' }, tile);
  el('circle', { cx: 0, cy: BOT.light.cy, r: BOT.light.r, fill: C.sleep }, tile);
  el('rect', { x: h.x, y: h.y, width: h.w, height: h.h, rx: h.rx, fill: 'none', stroke: C.sleep, 'stroke-width': 1.1, 'vector-effect': 'non-scaling-stroke' }, tile);
  for (const e of BOT.eyes) {
    const eh = e.h * BOT.asleepEye;
    el('rect', { x: e.x, y: BOT.eyeCy - eh / 2, width: e.w, height: eh, rx: eh / 2, fill: C.sleep }, tile);
  }

  const field = el('g', {}, svg);
  const traces = el('g', {}, live);
  const awake = el('g', {}, live);
  const top = el('g', {}, live);
  const cells: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    cells[r] = [];
    for (let c = 0; c < cols; c++) {
      const cell: Cell = { c, r, x: bw / 2 + c * pitch, y: yLast - (rows - 1 - r) * pitch };
      cell.node = el('use', { href: '#bot-asleep', transform: `translate(${cell.x} ${cell.y + BOT.vc * s}) scale(${s})` }, field);
      cells[r][c] = cell;
    }
  }
  const at = (c: number, r: number) => cells[Math.max(0, Math.min(rows - 1, r))][Math.max(0, Math.min(cols - 1, c))];
  const labelFont = mob ? 12 : 13;
  const label = (cell: Cell, text: string) => {
    const t = el('text', {
      x: cell.x + pitch - bw / 2, y: cell.y + 0.5, 'dominant-baseline': 'central',
      'font-family': 'Mona, ui-sans-serif, system-ui, sans-serif', 'font-size': labelFont, 'font-weight': 520,
      fill: C.ink, 'letter-spacing': '-0.01em',
    }, top);
    t.textContent = text;
    return t;
  };
  const neighbours = (cell: Cell) => [1, 2].map((d) => at(cell.c + d, cell.r).node!).filter(Boolean);

  // Your bot: bottom row, first column, standing above the "B" of the headline.
  const youCell = at(0, rows - 1);
  youCell.node!.remove();
  const you = liveBot(top, youCell, s, true);
  neighbours(youCell).forEach((n) => n.remove());
  label(youCell, root.dataset.you || 'You');

  // Targets. The first friend stands above the anchor word ("bot."), so the field reads like
  // the headline under it: Bot, to, bot.
  const rb = root.getBoundingClientRect();
  const anchor = root.closest('[data-field-scope]')?.querySelector('[data-anchor]')?.getBoundingClientRect();
  const colAt = (x: number) => Math.round((x - bw / 2) / pitch);
  const minC = 3, maxC = cols - 3, maxR = rows - 3;
  const clampC = (c: number) => Math.max(minC, Math.min(maxC, c));
  const clampR = (r: number) => Math.max(0, Math.min(maxR, r));
  const spots = mode === 'miss'
    ? [[0.62, 0.3]]
    : mob ? [[-1, 0.18], [0.86, 0.56], [0.42, 0.4]] : [[-1, 0.24], [0.84, 0.6], [0.66, 0.08]];
  const used = new Set<string>();
  const targets = spots.slice(0, mode === 'miss' ? 1 : Math.max(1, names.length)).map(([fx, fy], i) => {
    let c = fx < 0 && anchor ? colAt(anchor.left + anchor.width / 2 - rb.left) : Math.round(fx * (cols - 1));
    let r = Math.round(fy * (rows - 1));
    c = clampC(c); r = clampR(r);
    while (used.has(`${c},${r}`)) r = clampR(r + 2);
    used.add(`${c},${r}`);
    return { cell: at(c, r), name: names[i] || '' };
  });

  const tl = gsap.timeline({ paused: true, repeat: reduce ? 0 : -1, delay: 0 });

  targets.forEach(({ cell, name }, i) => {
    const d = route(youCell, cell, pitch, s, true);
    const trace = el('path', { d, fill: 'none', stroke: C.signal, 'stroke-width': 1.25, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0 }, traces);
    const comet = el('path', { d, fill: 'none', stroke: C.signal, 'stroke-width': 1.75, 'stroke-linecap': 'round', opacity: 0 }, traces);
    const len = trace.getTotalLength();
    const tail = Math.min(46, len * 0.3);
    trace.style.strokeDasharray = `${len} ${len}`;
    comet.style.strokeDasharray = `${tail} ${len + tail}`;
    const halo = el('circle', { r: 6, fill: C.signal, opacity: 0 }, top);
    const dot = el('circle', { r: 2.4, fill: C.signal, opacity: 0 }, top);
    const place = (p: number) => {
      const q = trace.getPointAtLength(len * p);
      dot.setAttribute('cx', String(q.x)); dot.setAttribute('cy', String(q.y));
      halo.setAttribute('cx', String(q.x)); halo.setAttribute('cy', String(q.y));
      trace.style.strokeDashoffset = String(len * (1 - p));
      comet.style.strokeDashoffset = String(tail - len * p);
    };

    let bot: Live | null = null;
    let name$: SVGTextElement | null = null;
    let side: SVGElement[] = [];
    if (mode === 'wake') {
      cell.node!.remove();
      bot = liveBot(awake, cell, s);
      side = neighbours(cell);
      side.forEach((n) => awake.appendChild(n));
      name$ = label(cell, name);
      gsap.set(name$, { opacity: 0 });
    } else {
      // The empty cell: nobody lives here. A dashed outline marks where a bot would be.
      cell.node!.remove();
      el('rect', {
        x: cell.x - bw / 2, y: cell.y + (BOT.vc + h.y) * s, width: bw, height: h.h * s, rx: h.rx * s,
        fill: 'none', stroke: '#aab3c1', 'stroke-width': 1.1, 'stroke-dasharray': '2 1.8',
      }, field);
    }

    if (reduce) {
      // The delivered state, composed as a still: first message only.
      if (i > 0) return;
      gsap.set(trace, { opacity: 0.55, strokeDashoffset: 0 });
      if (bot && name$) {
        gsap.set(bot.light, { fill: C.signal });
        gsap.set(bot.head, { fill: C.white, stroke: C.ink, strokeWidth: 1.35 });
        gsap.set(bot.ant, { stroke: C.ink, strokeWidth: 1.35 });
        gsap.set(bot.eyes, { scaleY: 1, fill: C.ink });
        gsap.set(side, { opacity: 0 });
        gsap.set(name$, { opacity: 1 });
      } else {
        const q = trace.getPointAtLength(len);
        gsap.set(dot, { attr: { cx: q.x, cy: q.y }, opacity: 1 });
      }
      return;
    }

    const m = gsap.timeline();
    const travel = Math.max(1.05, Math.min(1.9, len / 640));
    const proxy = { p: 0 };
    m.addLabel('send', i === 0 ? 0.9 : 0)
      .fromTo(you.ring, { attr: { r: BOT.light.r }, opacity: 0.7 }, { attr: { r: 8.5 }, opacity: 0, duration: 1.1, ease: 'power2.out', immediateRender: false }, 'send')
      .set(trace, { opacity: 0.32 }, 'send+=0.18')
      .set(comet, { opacity: 1 }, 'send+=0.18')
      .fromTo([dot, halo], { opacity: 0 }, { opacity: (k) => (k ? 0.14 : 1), duration: 0.2, ease: ease.open }, 'send+=0.18')
      .fromTo(proxy, { p: 0 }, { p: 1, duration: travel, ease: ease.travel, onUpdate: () => place(proxy.p), onStart: () => place(0) }, 'send+=0.18')
      .addLabel('arrive', `send+=${0.18 + travel}`);

    if (bot && name$) {
      const b = bot;
      m.to([dot, halo], { opacity: 0, duration: 0.22, ease: ease.settle }, 'arrive')
        .to(b.light, { fill: C.signal, duration: 0.25, ease: ease.open }, 'arrive')
        .fromTo(b.ring, { attr: { r: BOT.light.r }, opacity: 0.75 }, { attr: { r: 8.5 }, opacity: 0, duration: 1.2, ease: 'power2.out', immediateRender: false }, 'arrive')
        .to(b.head, { fill: C.white, stroke: C.ink, strokeWidth: 1.35, duration: 0.45, ease: ease.open }, 'arrive+=0.08')
        .to(b.ant, { stroke: C.ink, strokeWidth: 1.35, duration: 0.45, ease: ease.open }, 'arrive+=0.08')
        .to(b.eyes, { scaleY: 1, fill: C.ink, duration: 0.42, ease: ease.open }, 'arrive+=0.14')
        .to(side, { opacity: 0, duration: 0.3, ease: ease.settle }, 'arrive+=0.1')
        .fromTo(name$, { opacity: 0, x: -4 }, { opacity: 1, x: 0, duration: 0.6, ease: ease.open }, 'arrive+=0.26')
        .to([trace, comet], { opacity: 0, duration: 1.3, ease: ease.settle }, 'arrive+=0.7')
        // it reads the message: one blink
        .to(b.eyes, { scaleY: 0.12, duration: 0.08, ease: 'power2.in', yoyo: true, repeat: 1 }, 'arrive+=1.7')
        // it tells its person: the light pulses once more
        .fromTo(b.ring2, { attr: { r: BOT.light.r }, opacity: 0.5 }, { attr: { r: 7 }, opacity: 0, duration: 1.1, ease: 'power2.out', immediateRender: false }, 'arrive+=2.2')
        // and settles back to sleep
        .addLabel('sleep', 'arrive+=3.5')
        .to(name$, { opacity: 0, duration: 0.45, ease: ease.settle }, 'sleep')
        .to(b.eyes, { scaleY: BOT.asleepEye, fill: C.sleep, duration: 1.05, ease: ease.settle }, 'sleep+=0.1')
        .to([b.head], { fill: C.ground, stroke: C.sleep, strokeWidth: 1.1, duration: 1.05, ease: ease.settle }, 'sleep+=0.2')
        .to(b.ant, { stroke: C.sleep, strokeWidth: 1.1, duration: 1.05, ease: ease.settle }, 'sleep+=0.2')
        .to(b.light, { fill: C.sleep, duration: 0.9, ease: ease.settle }, 'sleep+=0.35')
        .to(side, { opacity: 1, duration: 0.7, ease: ease.settle }, 'sleep+=0.4')
        .to({}, { duration: 2.4 }); // rest: the field is quiet again
    } else {
      // Nobody answers: the dot waits at the empty cell, rings twice, gives up.
      const ring = el('circle', { r: 2.4, fill: 'none', stroke: C.signal, 'stroke-width': 1, opacity: 0 }, top);
      const q = trace.getPointAtLength(len);
      ring.setAttribute('cx', String(q.x)); ring.setAttribute('cy', String(q.y));
      m.fromTo(ring, { attr: { r: 2.4 }, opacity: 0.7 }, { attr: { r: 11 }, opacity: 0, duration: 1.2, ease: 'power2.out', immediateRender: false }, 'arrive+=0.1')
        .fromTo(ring, { attr: { r: 2.4 }, opacity: 0.7 }, { attr: { r: 11 }, opacity: 0, duration: 1.2, ease: 'power2.out', immediateRender: false }, 'arrive+=1.3')
        .to([dot, halo, trace, comet], { opacity: 0, duration: 1, ease: ease.settle }, 'arrive+=2.6')
        .to({}, { duration: 2.2 });
    }
    tl.add(m);
  });

  // Your button wakes your bot's light: the action and the picture are the same thing.
  const buttons = [...document.querySelectorAll<HTMLElement>('[data-wake-you]')];
  const nudge = () => {
    if (reduce) return;
    gsap.fromTo(you.ring2, { attr: { r: BOT.light.r }, opacity: 0.8 }, { attr: { r: 8 }, opacity: 0, duration: 0.9, ease: 'power2.out', overwrite: true });
  };
  buttons.forEach((b) => { b.addEventListener('pointerenter', nudge); b.addEventListener('focus', nudge); });

  return {
    tl,
    destroy() {
      tl.kill();
      buttons.forEach((b) => { b.removeEventListener('pointerenter', nudge); b.removeEventListener('focus', nudge); });
    },
  };
}

export function fieldModule() {
  onPage(() => {
    const root = document.querySelector<HTMLElement>('[data-field]');
    if (!root) return;
    let current: ReturnType<typeof build> | null = null;
    let visible = true;
    let lastW = 0, lastH = 0;
    const make = () => {
      current?.destroy();
      lastW = root.clientWidth; lastH = root.clientHeight;
      current = build(root);
      root.classList.add('is-built');
      if (visible) current.tl.play();
    };
    const rebuild = gsap.delayedCall(0.18, make).pause();
    const ro = new ResizeObserver(() => {
      if (Math.abs(root.clientWidth - lastW) < 2 && Math.abs(root.clientHeight - lastH) < 2) return;
      rebuild.restart(true);
    });
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (!current) return;
      if (visible) current.tl.resume(); else current.tl.pause();
    });
    // Build once the display font is in, so the anchor word is measured at its real width.
    let alive = true;
    document.fonts.ready.then(() => {
      if (!alive) return;
      make();
      ro.observe(root);
      io.observe(root);
    });
    return () => {
      alive = false;
      ro.disconnect();
      io.disconnect();
      rebuild.kill();
      current?.destroy();
      current = null;
    };
  });
}
