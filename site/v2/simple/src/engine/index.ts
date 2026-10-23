// Engine core (engine.md, trimmed for a quiet site): page lifecycle on one GSAP clock.
//   boot(setup)          once, first load: setup → page init
//   leave() → cleanup()  before the route swaps (leave runs in parallel with the fetch)
//   enter()              after the new page is in the DOM: init → open the lids
// Project code hooks in with onPage(fn): fn runs inside a gsap.context, so its tweens are
// reverted on navigation. Return a cleanup for listeners and observers.
import { gsap } from 'gsap';
import { playEnter, playLeave } from './transition';
import { prefersReducedMotion } from './env';

export { ease, isTouch, isMobile, prefersReducedMotion } from './env';

export type PageFn = (page: { path: string }) => void | (() => void);
const pageFns = new Set<PageFn>();
const cleanups: (() => void)[] = [];
let ctx: gsap.Context | null = null;
let ready = false;
let booted = false;

export function onPage(fn: PageFn) {
  pageFns.add(fn);
  if (ready) runPageFn(fn);
  return () => { pageFns.delete(fn); };
}

function runPageFn(fn: PageFn) {
  ctx?.add(() => {
    const c = fn({ path: location.pathname });
    if (typeof c === 'function') cleanups.push(c);
  });
}

export function syncFlags() {
  const h = document.documentElement.classList;
  h.add('js', 'is-booted');
  h.toggle('motion', !prefersReducedMotion());
}

function initPage() {
  syncFlags();
  ctx = gsap.context(() => {});
  ready = true;
  pageFns.forEach(runPageFn);
}

export function boot(setup?: () => void) {
  if (booted) return;
  booted = true;
  syncFlags();
  setup?.();
  initPage();
}

export async function leave() {
  await playLeave();
}

export function cleanup() {
  if (!ready) return;
  ready = false;
  cleanups.splice(0).forEach((c) => c());
  ctx?.revert();
  ctx = null;
}

export async function enter({ transition = true } = {}) {
  if (!booted) return;
  cleanup();
  initPage();
  if (transition) await playEnter();
}
