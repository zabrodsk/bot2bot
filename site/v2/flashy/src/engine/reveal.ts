// Declarative motion through data attributes. Authoring happens in markup:
//   data-split="lines|words"   text opens like an eye: each line opens from its centre line
//   data-reveal="open|up|fade"  block reveal ("open" is the same eye-open on a block)
//   data-intro                  play with the page intro instead of on scroll
//   data-delay="0.2"            extra delay (seconds)
// Every effect is skipped under reduced motion; CSS keeps content visible without JS.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { SplitText } from 'gsap/SplitText';
import { ease, prefersReducedMotion } from './env';

gsap.registerPlugin(ScrollTrigger, SplitText);

const SHUT = 'inset(50% -4% 50% -4%)';
const OPEN = 'inset(-25% -4% -25% -4%)';

// autoSplit re-splits after font load / resize. A text that already revealed must stay revealed,
// so the state lives outside onSplit.
function splitTween(el: HTMLElement, isIntro: boolean) {
  const type = el.dataset.split === 'words' ? 'words' : 'lines';
  const delay = parseFloat(el.dataset.delay || '0');
  const s = { tween: undefined as gsap.core.Tween | undefined, done: false, requested: false };
  SplitText.create(el, {
    type: type === 'lines' ? 'lines' : 'lines,words',
    autoSplit: true,
    linesClass: 'split-line',
    onSplit(self) {
      gsap.set(el, { visibility: 'visible' });
      if (s.done) return;
      const targets = type === 'lines' ? self.lines : self.words;
      s.tween = gsap.fromTo(targets, { clipPath: SHUT, scaleY: 0.82 }, {
        clipPath: OPEN,
        scaleY: 1,
        duration: 1.1,
        stagger: type === 'lines' ? 0.07 : 0.04,
        ease: ease.out,
        delay,
        paused: isIntro && !s.requested,
        onComplete: () => { s.done = true; gsap.set(targets, { clearProps: 'clipPath,transform' }); },
        scrollTrigger: isIntro ? undefined : { trigger: el, start: 'top 88%', once: true },
      });
      return s.tween;
    },
  });
  return () => { s.requested = true; s.tween?.play(); };
}

function blockTween(el: HTMLElement, paused: boolean) {
  const kind = el.dataset.reveal || 'open';
  const delay = parseFloat(el.dataset.delay || '0');
  // Opacity, never visibility: links inside a block that hasn't revealed yet must stay focusable.
  const from: gsap.TweenVars =
    kind === 'fade' ? { opacity: 0 }
    : kind === 'up' ? { y: 32, opacity: 0 }
    : { clipPath: SHUT, opacity: 1 };
  const to: gsap.TweenVars = kind === 'open' ? { clipPath: OPEN } : {};
  gsap.set(el, { visibility: 'visible' });
  return gsap.fromTo(el, from, {
    ...to,
    y: 0,
    opacity: 1,
    duration: kind === 'fade' ? 0.9 : 1.1,
    ease: ease.out,
    delay,
    paused,
    onComplete: () => { gsap.set(el, { clipPath: 'none' }); }, // inline: the CSS start state must not come back
    scrollTrigger: paused ? undefined : { trigger: el, start: 'top 90%', once: true },
  });
}

/** Wire every reveal inside `root`. Returns the intro timeline (paused) for the page entrance. */
export function initReveals(root: ParentNode = document) {
  const intro = gsap.timeline({ paused: true });
  if (prefersReducedMotion()) return intro;
  root.querySelectorAll<HTMLElement>('[data-split]').forEach((el) => {
    const isIntro = el.hasAttribute('data-intro');
    const play = splitTween(el, isIntro);
    if (isIntro) intro.add(play, 0);
  });
  root.querySelectorAll<HTMLElement>('[data-reveal]').forEach((el) => {
    const isIntro = el.hasAttribute('data-intro');
    const t = blockTween(el, isIntro);
    if (isIntro) intro.add(() => { t.play(); }, 0);
  });
  return intro;
}
