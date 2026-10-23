// Wires on /setup and /security draw once, in order, like one message passing through them.
// A wire taller than it is wide (phones) draws top to bottom. Reduced motion: CSS shows them complete.
import { gsap } from 'gsap';
import { onPage, ease, prefersReducedMotion } from '../engine';

export function stepsModule() {
  onPage(() => {
    const wires = gsap.utils.toArray<HTMLElement>('[data-rail]');
    if (!wires.length || prefersReducedMotion()) return;
    const vertical = wires[0].offsetHeight > wires[0].offsetWidth;
    gsap.fromTo(wires, { clipPath: vertical ? 'inset(0% 0% 100% 0%)' : 'inset(0% 100% 0% 0%)' }, {
      clipPath: 'inset(0% 0% 0% 0%)', duration: 0.62, ease: ease.travel, stagger: 0.5, delay: 0.5,
    });
  });
}
