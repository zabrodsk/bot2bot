// Page transition: a blink. Two ground-coloured lids close to a seam, the page swaps behind
// them, then they open. Same gesture as a bot's eyes. Reduced motion: no lids at all.
import { gsap } from 'gsap';
import { ease, prefersReducedMotion } from './env';

const parts = () => {
  const root = document.getElementById('lids');
  if (!root) return null;
  return {
    root,
    lids: root.querySelectorAll<HTMLElement>('.lid'),
    top: root.querySelector<HTMLElement>('.lid--t')!,
    bottom: root.querySelector<HTMLElement>('.lid--b')!,
    seam: root.querySelector<HTMLElement>('.lid__seam')!,
  };
};

export function playLeave(): Promise<unknown> {
  const p = parts();
  if (!p || prefersReducedMotion()) return Promise.resolve();
  gsap.killTweensOf([p.top, p.bottom, p.seam]);
  return gsap.timeline()
    .set(p.root, { autoAlpha: 1 })
    .set(p.top, { transformOrigin: '50% 0%' })
    .set(p.bottom, { transformOrigin: '50% 100%' })
    .fromTo(p.lids, { scaleY: 0 }, { scaleY: 1, duration: 0.34, ease: ease.close })
    .to(p.seam, { opacity: 1, duration: 0.12 }, '-=0.08')
    .then();
}

export function playEnter(): Promise<unknown> {
  const p = parts();
  if (!p || prefersReducedMotion()) return Promise.resolve();
  if (gsap.getProperty(p.root, 'visibility') === 'hidden') return Promise.resolve();
  return gsap.timeline()
    .to(p.seam, { opacity: 0, duration: 0.16 })
    .to(p.lids, { scaleY: 0, duration: 0.6, ease: ease.open }, 0.04)
    .set(p.root, { autoAlpha: 0 })
    .then();
}
