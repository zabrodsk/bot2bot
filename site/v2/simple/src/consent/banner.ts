// Arc UI Cookie consent, ported from React + Motion to vanilla TS on the GSAP clock. MIT, see
// components/arc/LICENSE.md. Markup and styles: components/arc/CookieConsent.astro.
//
// One surface springs its position, width, height and corner between two faces: the bar and the
// preferences panel. After a choice it fades away; the footer's "Cookie settings" brings it back
// (no floating reopen button). Growing uses a slightly bouncy spring and shrinking a flat one. The springs are
// physical (stiffness and damping), so a retarget mid-flight keeps its velocity, like Arc's.
import { gsap } from 'gsap';
import { consent as copy } from '../data/site';
import { readConsent, writeConsent, type ConsentAction, type ConsentValue } from './store';

type Mode = 'bar' | 'panel';
type Side = 'left' | 'right' | 'center';
const MODES: Mode[] = ['bar', 'panel'];
const BAR_MAX = 400, PANEL_MAX = 420, STACK_BELOW = 560; // a compact card: the message stacks above the buttons
const RADIUS: Record<Mode, number> = { bar: 20, panel: 20 };
const ALIGN: Side = 'left'; // bottom-left, on the page margin, so the hero's Get started stays clear

/** Arc's duration springs restated as stiffness and damping. */
const physical = (visualDuration: number, bounce: number) => {
  const root = (2 * Math.PI) / (visualDuration * 1.2);
  return { k: root * root, c: 2 * (1 - bounce) * root };
};
const GROW = physical(0.46, 0.14), SHRINK = physical(0.38, 0), ENTER = physical(0.5, 0);
type Cfg = ReturnType<typeof physical>;

class Spring {
  v = 0; t: number; cfg: Cfg = SHRINK;
  constructor(public x: number) { this.t = x; }
  to(t: number, cfg: Cfg) { this.t = t; this.cfg = cfg; }
  jump(x: number) { this.x = this.t = x; this.v = 0; }
  step(dt: number) {
    const a = -this.cfg.k * (this.x - this.t) - this.cfg.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
  }
  get still() { return Math.abs(this.x - this.t) < 0.02 && Math.abs(this.v) < 0.05; }
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const optional = copy.categories.filter((c) => !c.required);

let mounted = false;

export function mountConsent() {
  if (mounted) return;
  const root = document.getElementById('cc');
  const surface = root?.querySelector<HTMLElement>('[data-cc-surface]');
  if (!root || !surface) return;
  mounted = true;

  const faces = Object.fromEntries(MODES.map((m) => [m, root.querySelector<HTMLElement>(`[data-face="${m}"]`)!])) as Record<Mode, HTMLElement>;
  const barInner = root.querySelector<HTMLElement>('.cc__bar-inner')!;
  const switches = [...root.querySelectorAll<HTMLButtonElement>('[role="switch"][data-category]')];
  const count = root.querySelector<HTMLElement>('#cc-count')!;

  // ---------- State ----------
  let decided: ConsentValue | null = readConsent()?.value ?? null;
  let draft: ConsentValue = {};
  let mode: Mode | null = null;
  let opener: HTMLElement | null = null; // the "Cookie settings" button that reopened it, for focus
  let layerW = root.clientWidth;
  const heights: Record<Mode, number> = { bar: 0, panel: 0 };

  const baseline = (from: ConsentValue | null): ConsentValue =>
    Object.fromEntries(copy.categories.map((c) => [c.id, c.required ? true : from?.[c.id] ?? false]));

  // ---------- Geometry: springs on the GSAP ticker ----------
  const s = { x: new Spring(0), w: new Spring(0), h: new Spring(0), r: new Spring(RADIUS.bar), y: new Spring(0), k: new Spring(1) };
  const all = Object.values(s);
  let placed = false, running = false;

  const render = () => {
    surface.style.width = `${s.w.x}px`;
    surface.style.height = `${s.h.x}px`;
    surface.style.borderRadius = `${Math.max(0, s.r.x)}px`;
    surface.style.transform = `translate3d(${s.x.x}px, ${s.y.x}px, 0) scale(${s.k.x})`;
  };
  const tick = (_time: number, deltaMs: number) => {
    const dt = Math.min(deltaMs / 1000, 0.05);
    const steps = Math.max(1, Math.ceil(dt * 240));
    for (let i = 0; i < steps; i++) all.forEach((sp) => sp.step(dt / steps));
    if (all.every((sp) => sp.still)) {
      all.forEach((sp) => sp.jump(sp.t));
      gsap.ticker.remove(tick);
      running = false;
    }
    render();
  };
  const run = () => {
    if (running) return;
    running = true;
    gsap.ticker.add(tick);
  };

  const widths = (): Record<Mode, number> => ({ bar: Math.min(layerW, BAR_MAX), panel: Math.min(layerW, PANEL_MAX) });
  const sideOf = (_m: Mode): Side => ALIGN;
  const place = (w: number, side: Side) => (side === 'left' ? 0 : side === 'right' ? layerW - w : (layerW - w) / 2);

  // Each face gets an explicit width and is pinned to the side its surface sits on.
  const layoutFaces = () => {
    const w = widths();
    MODES.forEach((m) => {
      const face = faces[m], side = sideOf(m);
      face.dataset.side = side;
      face.style.width = `${w[m]}px`;
      face.style.marginLeft = side === 'center' ? `${-w[m] / 2}px` : '';
    });
    barInner.toggleAttribute('data-stack', w.bar < STACK_BELOW);
  };

  const layout = () => {
    if (!mode || !layerW) return;
    const w = widths()[mode], h = heights[mode];
    if (!h) return;
    const next = { x: place(w, sideOf(mode)), w, h, r: RADIUS[mode] };
    if (!placed || reduced()) {
      s.x.jump(next.x); s.w.jump(next.w); s.h.jump(next.h); s.r.jump(next.r);
      placed = true;
      render();
      if (!all.every((sp) => sp.still)) run();
      return;
    }
    const cfg = next.w * next.h >= s.w.t * s.h.t ? GROW : SHRINK;
    s.x.to(next.x, cfg); s.w.to(next.w, cfg); s.h.to(next.h, cfg); s.r.to(next.r, cfg);
    run();
  };

  const faceObserver = new ResizeObserver((entries) => {
    for (const e of entries) {
      const m = (e.target as HTMLElement).dataset.face as Mode;
      const h = (e.target as HTMLElement).offsetHeight;
      if (heights[m] === h) continue;
      heights[m] = h;
      if (m === mode) layout();
    }
  });
  MODES.forEach((m) => faceObserver.observe(faces[m]));
  new ResizeObserver(() => {
    if (root.clientWidth === layerW) return;
    layerW = root.clientWidth;
    layoutFaces();
    layout();
  }).observe(root);


  // ---------- Modes ----------
  const setMode = (next: Mode, focus: boolean) => {
    const prev = mode;
    mode = next;
    root.dataset.mode = next;
    MODES.forEach((m) => {
      faces[m].dataset.state = m === next ? 'shown' : 'hidden';
      faces[m].inert = m !== next;
    });
    layoutFaces();
    if (!prev) {
      // The surface enters rising 24 px and scaling from 0.98.
      if (!reduced()) { s.y.jump(24); s.k.jump(0.98); s.y.to(0, ENTER); s.k.to(1, ENTER); }
      root.classList.add('is-in');
    }
    layout();
    if (focus) requestAnimationFrame(() => faces[next].querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true }));
  };

  const syncSwitches = () => {
    switches.forEach((sw) => sw.setAttribute('aria-checked', String(!!draft[sw.dataset.category!])));
    count.textContent = copy.count(optional.filter((c) => draft[c.id]).length, optional.length);
  };

  const openPanel = (focus = true) => {
    draft = baseline(decided);
    syncSwitches();
    setMode('panel', focus);
  };
  // A decided visitor's surface fades away entirely; it enters fresh the next time it's opened.
  const hide = () => {
    mode = null;
    delete root.dataset.mode;
    MODES.forEach((m) => { faces[m].dataset.state = 'hidden'; faces[m].inert = true; });
    root.classList.remove('is-in');
    placed = false;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    opener = null;
  };
  const closePanel = (focus = true) => (decided ? hide() : setMode('bar', focus));
  const choose = (action: Exclude<ConsentAction, 'reset'>) => {
    const next = action === 'save'
      ? { ...draft }
      : Object.fromEntries(copy.categories.map((c) => [c.id, c.required ? true : action === 'accept-all']));
    decided = next;
    writeConsent(next, action);
    hide();
  };

  // ---------- Events (bound once; the element persists across navigations) ----------
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const sw = target.closest<HTMLButtonElement>('[role="switch"]');
    if (sw) {
      draft[sw.dataset.category!] = !draft[sw.dataset.category!];
      syncSwitches();
      return;
    }
    const act = target.closest<HTMLElement>('[data-cc]')?.dataset.cc;
    if (act === 'customize') openPanel(true);
    else if (act === 'close') closePanel(true);
    else if (act === 'reject') choose('reject-all');
    else if (act === 'accept') choose('accept-all');
    else if (act === 'save') choose('save');
  });
  faces.panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    closePanel(true);
  });
  // "Cookie settings" buttons anywhere on the page (footer, /cookies/) reopen the preferences.
  document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-cookie-settings]');
    if (!btn) return;
    e.preventDefault();
    opener = btn;
    openPanel(true);
  });

  // ---------- Start: a decided visitor never sees the bar ----------
  layoutFaces();
  MODES.forEach((m) => { heights[m] = faces[m].offsetHeight; });
  if (!decided) setMode('bar', false);
}
