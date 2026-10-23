// Global motion for this site, registered once before the first page initializes.
import { gsap } from 'gsap';
import { setTransition, setLoaderFormat, setLoaderExit, setLoaderProgress, ease, onScroll, initGL, glWanted, stopScroll, startScroll, prefersReducedMotion } from '../engine';
import { startField, getField } from '../field';
import { S, YOU } from '../field/field';

export function setupMotion() {
  // WebGL starts after the first paint, so the text (the LCP) never waits for shader compiles.
  // The loader, when there is one, runs at least 0.9 s, which covers this easily.
  const loader = document.getElementById('loader');
  if (glWanted()) {
    const go = () => { if (initGL()) startField(!!loader); };
    requestAnimationFrame(() => setTimeout(go, 0));
  }

  setupMenu();
  setupCopy();
  // Keyboard: a block that receives focus before its scroll reveal shows at once.
  document.addEventListener('focusin', (e) => {
    const r = (e.target as HTMLElement).closest?.('[data-reveal]');
    if (r && getComputedStyle(r).opacity !== '1') gsap.set(r, { opacity: 1, y: 0, clipPath: 'none' });
  });

  // The frame steps aside while you read down, and comes back when you scroll up.
  let last = 0;
  onScroll(({ y }) => {
    if (Math.abs(y - last) < 6) return;
    if (!document.documentElement.classList.contains('menu-open')) document.documentElement.classList.toggle('frame-away', y > 160 && y > last);
    last = y;
  });
  document.addEventListener('astro:after-swap', () => { document.documentElement.classList.remove('frame-away'); last = 0; });

  // Page transition: a blink. Two lids close to a thin blue line (an asleep eye), the page
  // swaps behind them, then the lids open on the new page.
  setTransition({
    leave: (c) => {
      const lids = c.querySelectorAll('.lid');
      const line = c.querySelector('.lid-line');
      return gsap.timeline()
        .set(c, { autoAlpha: 1 })
        .fromTo(lids, { scaleY: 0 }, { scaleY: 1, duration: 0.5, ease: ease.shut })
        .fromTo(line, { scaleX: 0, autoAlpha: 1 }, { scaleX: 1, duration: 0.45, ease: ease.out }, '-=0.12');
    },
    enter: (c) => {
      const lids = c.querySelectorAll('.lid');
      const line = c.querySelector('.lid-line');
      return gsap.timeline()
        .to(line, { autoAlpha: 0, duration: 0.18 })
        .to(lids, { scaleY: 0, duration: 0.8, ease: ease.out }, '-=0.08')
        .set(c, { autoAlpha: 0 });
    },
  });

  // Loader: one big bot. Its eyes open with real progress; then it flies to its spot in the
  // field, and the field appears in a ring around it.
  setLoaderFormat((p) => String(Math.round(p)).padStart(2, '0'));
  setLoaderProgress((p, root) => {
    const eyes = root.querySelectorAll<SVGElement>('.bot__eye');
    gsap.set(eyes, { scaleY: 0.34 + 0.66 * p * p, transformOrigin: '50% 50%' });
    root.classList.toggle('is-lit', p > 0.97);
  });
  setLoaderExit((root) => {
    const bot = root.querySelector<HTMLElement>('.loader__bot')!;
    const field = getField();
    const r = bot.getBoundingClientRect();
    // Head centre of the loader bot: the SVG viewBox is 22 × 23 and the head centre sits at
    // (11, 14.5); the head is 13 units tall.
    const from = { x: r.left + r.width / 2, y: r.top + r.height * (14.5 / 23) };
    const headPx = r.height * (13 / 23);
    let to = { x: innerWidth / 2, y: innerHeight / 2, s: 0.2 };
    const home = document.querySelector('[data-scene="home"]');
    let landed = false;
    if (field && home) {
      field.prime(); // place the camera for this page before measuring
      const half = (13 * 0.027 * 1.16) / 2; // the field's head: 13 bot units × uScale × "you" scale
      const q = field.project(YOU[0], 0.2, YOU[1]);
      const a = field.project(YOU[0], 0.2 + half, YOU[1]);
      const b = field.project(YOU[0], 0.2 - half, YOU[1]);
      if (q && a && b) { to = { x: q.x, y: q.y, s: Math.abs(b.y - a.y) / headPx }; landed = true; }
    }
    gsap.set(bot, { transformOrigin: `50% ${(14.5 / 23) * 100}%` });
    const tl = gsap.timeline();
    tl.to(root.querySelector('.loader__count'), { autoAlpha: 0, duration: 0.25 }, 0);
    tl.to(bot, { x: to.x - from.x, y: to.y - from.y, scale: to.s, duration: 0.75, ease: ease.inOut }, 0.03);
    tl.to(root.querySelector('.loader__ground'), { autoAlpha: 0, duration: 0.5, ease: ease.soft }, 0.3);
    // On landing, the field's own bot takes over and the field appears in a ring around it.
    // (These run on after the loader has gone, so they don't count against its budget.)
    const tag = document.querySelector('[data-anchor="you"] .tag.is-shown');
    if (tag) gsap.set(tag, { autoAlpha: 0 });
    tl.add(() => {
      if (field) gsap.to(S, { boot: 1, duration: 2.4, ease: 'power2.out' });
      if (tag) gsap.to(tag, { autoAlpha: 1, duration: 0.4, delay: 0.1 });
    }, landed ? 0.76 : 0.4);
    tl.to(bot, { autoAlpha: 0, duration: 0.1 }, landed ? 0.78 : 0.6);
    return tl;
  });
}

// Phone menu: a disclosure that opens like an eye. Escape or the button closes it, focus
// returns to the button, and the page behind is inert while it is open.
function setupMenu() {
  const h = document.documentElement;
  const els = () => ({ btn: document.querySelector<HTMLButtonElement>('[data-menu-btn]'), menu: document.querySelector<HTMLElement>('[data-menu]') });
  const behind = () => [document.getElementById('main'), document.querySelector('.foot')].filter(Boolean) as HTMLElement[];
  const set = (open: boolean, focusBack = true) => {
    const { btn, menu } = els();
    if (!btn || !menu) return;
    btn.setAttribute('aria-expanded', String(open));
    btn.querySelector('.menu-btn__label')!.textContent = open ? 'Close' : 'Menu';
    h.classList.toggle('menu-open', open);
    behind().forEach((el) => { el.inert = open; });
    if (open) {
      h.classList.remove('frame-away');
      stopScroll();
      menu.hidden = false;
      const k = prefersReducedMotion() ? 0 : 1;
      gsap.fromTo(menu, { clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)', duration: 0.6 * k, ease: ease.out });
      gsap.fromTo(menu.querySelectorAll('li'), { autoAlpha: 0, y: 18 * k }, { autoAlpha: 1, y: 0, duration: 0.6 * k, stagger: 0.04 * k, ease: ease.out, delay: 0.08 * k });
      requestAnimationFrame(() => menu.querySelector<HTMLElement>('a')?.focus({ preventScroll: true }));
    } else {
      startScroll();
      gsap.killTweensOf(menu);
      gsap.to(menu, { clipPath: 'inset(0 0 100% 0)', duration: prefersReducedMotion() ? 0 : 0.35, ease: ease.shut, onComplete: () => { menu.hidden = true; } });
      if (focusBack) btn.focus({ preventScroll: true });
    }
  };
  document.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-menu-btn]')) { set(!h.classList.contains('menu-open')); return; }
    if (h.classList.contains('menu-open') && t.closest('[data-menu] a')) set(false, false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && h.classList.contains('menu-open')) set(false); });
  matchMedia('(min-width: 900px)').addEventListener('change', (m) => { if (m.matches && h.classList.contains('menu-open')) set(false, false); });
  document.addEventListener('astro:after-swap', () => { h.classList.remove('menu-open'); startScroll(); });
}

// "Copy" buttons for commands.
function setupCopy() {
  document.addEventListener('click', async (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-copy]');
    if (!btn) return;
    const label = btn.querySelector('[data-copy-label]');
    try {
      await navigator.clipboard.writeText(btn.dataset.copy || '');
      if (label) label.textContent = 'Copied';
    } catch {
      if (label) label.textContent = 'Select and copy';
    }
    setTimeout(() => { if (label) label.textContent = 'Copy'; }, 1800);
  });
}
