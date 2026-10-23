// First-load sequence. Progress follows REAL work (fonts + critical images), eased by GSAP,
// with a floor so it reads as intentional and a ceiling so it never becomes a usability problem.
import { gsap } from 'gsap';
import { ease, prefersReducedMotion } from './env';

let format = (p: number) => String(Math.round(p)).padStart(3, '0');
let progressFn: ((p: number, root: HTMLElement) => void) | null = null;
/** Customize the counter text. p goes 0 → 100. */
export const setLoaderFormat = (fn: (p: number) => string) => { format = fn; };
/** Drive the loader's own visual from progress (here: the big bot's eyes open). */
export const setLoaderProgress = (fn: (p: number, root: HTMLElement) => void) => { progressFn = fn; };
let exit: ((root: HTMLElement) => gsap.core.Timeline) | null = null;
/** Replace the exit choreography (the loader → hero handoff). Return a timeline. */
export const setLoaderExit = (fn: (root: HTMLElement) => gsap.core.Timeline) => { exit = fn; };

const MIN = 0.9; // seconds
const MAX = 1.5; // seconds of progress; the exit adds ~0.9 s, total stays under 2.6 s

function criticalAssets(): Promise<unknown>[] {
  const imgs = [...document.querySelectorAll<HTMLImageElement>('img[data-critical]')];
  return [document.fonts.ready, ...imgs.map((i) => (i.complete ? Promise.resolve() : i.decode().catch(() => {})))];
}

export async function runLoader(): Promise<void> {
  const root = document.getElementById('loader');
  if (!root) return;
  if (prefersReducedMotion()) {
    await Promise.race([Promise.all(criticalAssets()), wait(MAX)]);
    await gsap.to(root, { autoAlpha: 0, duration: 0.3 });
    return finish(root);
  }
  const count = root.querySelector<HTMLElement>('[data-loader-count]');
  const tasks = criticalAssets();
  let done = 0;
  const shown = { v: 0 };
  const target = { v: 0 };
  tasks.forEach((t) => t.then(() => { done++; target.v = (done / tasks.length) * 100; }));
  const start = performance.now();
  let prev = start;

  await new Promise<void>((resolve) => {
    const tick = () => {
      const now = performance.now();
      const elapsed = (now - start) / 1000;
      const dt = Math.min(0.25, (now - prev) / 1000);
      prev = now;
      const timeCap = Math.min(100, (elapsed / MIN) * 100);
      const goal = elapsed > MAX ? 100 : Math.min(target.v, timeCap);
      // Time-based easing: the same duration on a slow device as on a fast one.
      shown.v += (goal - shown.v) * (1 - Math.exp(-dt * 10));
      if (elapsed > MAX + 0.35) shown.v = 100;
      if (goal === 100 && shown.v > 99.5) shown.v = 100;
      if (count) count.textContent = format(shown.v);
      progressFn?.(shown.v / 100, root);
      if (shown.v === 100) { gsap.ticker.remove(tick); resolve(); }
    };
    gsap.ticker.add(tick);
  });

  if (exit) { await exit(root); return finish(root); }
  await gsap.to(root, { autoAlpha: 0, duration: 0.6, ease: ease.soft });
  finish(root);
}

function finish(root: HTMLElement) {
  root.hidden = true;
  document.documentElement.classList.add('is-loaded');
}

const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
