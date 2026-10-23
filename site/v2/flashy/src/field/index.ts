// Starts the field once (it persists across pages on the shared canvas) and hands each page
// to its scene: the home story, the setup build, or the 404's missing bot.
import { gsap } from 'gsap';
import { addLayer, glRenderer, onPage } from '../engine';
import { Field, S } from './field';
import { homeScene, setupScene, lostScene, calmScene } from './scenes';

let field: Field | null = null;
export const getField = () => field;

export function startField(withLoader: boolean) {
  const r = glRenderer();
  if (!r) return;
  field = new Field(r);
  // The field appears in a ring from your bot: after the loader lands, or right away.
  S.boot = 0;
  if (!withLoader || document.documentElement.classList.contains('is-loaded')) gsap.to(S, { boot: 1, duration: 2.2, ease: 'power2.out', delay: 0.05 });
  addLayer({ resize: (w, h) => field!.resize(w, h), render: (rr, t, dt) => field!.render(rr, t, dt), degrade: () => field!.degrade() });
  onPage(() => {
    const scene = document.querySelector<HTMLElement>('[data-scene]')?.dataset.scene;
    field!.setAnchors([], null);
    if (scene === 'home') return homeScene(field!);
    if (scene === 'setup') return setupScene(field!);
    if (scene === 'lost') return lostScene(field!);
    if (scene === 'security' || scene === 'pricing' || scene === 'bots') return calmScene(field!, scene);
  });
}
