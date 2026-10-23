// The driver. Each page builds ONE paused timeline whose time unit is scroll pixels, scrubbed by
// a single ScrollTrigger. Camera, signal, ring, field states, captions and bubbles all live on it,
// so every visual always agrees with every other.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { S, YOU, ANNA, type Field, type Pose } from './field';
import { setGLPaused } from '../engine';

gsap.registerPlugin(ScrollTrigger);

const SHUT = 'inset(50% -6% 50% -6%)';
const OPEN = 'inset(-30% -6% -30% -6%)';

const base = { ...S };
const pose = (p: [number, number, number], t: [number, number, number], fov: number, shift = 0): Pose => ({ p, t, fov, shift });
const camTo = (q: Pose) => ({ px: q.p[0], py: q.p[1], pz: q.p[2], tx: q.t[0], ty: q.t[1], tz: q.t[2], fov: q.fov, shift: q.shift });

function poses() {
  const tall = innerWidth / innerHeight < 0.85;
  const [ax, az] = ANNA;
  return tall
    ? {
        hero: pose([0, 4.3, 12.5], [0, 0.2, -30], 60),
        send: pose([0.9, 4.2, 4.8], [0.1, 0.1, 0.6], 54),
        arrive: pose([ax - 1.4, 3.6, az + 8.5], [ax, 0.2, az - 1.5], 54),
        wave: pose([ax, 66, az + 26], [ax, 0, az + 5], 58),
        reply: pose([10.5, 66, 8], [10.5, 0, -22], 58),
        home: pose([-0.6, 4.2, 5.2], [0.3, 0.1, 0.6], 54),
        facts: pose([0.4, 8.5, 12.5], [0.9, 0, 4.2], 56),
        finale: pose([0, 5.5, 14], [0, 0.2, -34], 60),
        lost: pose([0, 4.3, 12.5], [0, 0.2, -30], 60),
        lock: pose([10.5, 125, 30.7], [10.5, 0, 19.8], 58),
        calm: pose([0, 4.6, 13], [0, 0.2, -30], 60),
        calmRest: pose([0, 9, 15], [0, 0, -30], 60),
        setup: pose([0.4, 5.6, 9.5], [0.4, 0, 3.6], 56),
        setupEnd: pose([14, 9, 2], [18, 0, -22], 58),
      }
    : {
        hero: pose([0, 2.7, 10], [0, 0.55, -30], 38),
        send: pose([2.6, 3.1, 4.4], [-0.7, 0.2, -0.5], 36),
        arrive: pose([ax - 3, 2.6, az + 6.4], [ax + 0.8, 0.3, az - 0.4], 38),
        wave: pose([ax - 4, 52, az + 30], [ax - 1, 0, az + 6], 42),
        reply: pose([10.5, 44, 9], [10.5, 0, -23], 42),
        home: pose([-2.4, 3.0, 4.6], [0.9, 0.2, -0.4], 36),
        facts: pose([-10.5, 6.4, 12], [-1, 0, -1.4], 40),
        finale: pose([0, 3.3, 12], [0, 0.45, -34], 40),
        lost: pose([0, 2.4, 9.5], [0, 0.6, -30], 38),
        lock: pose([-9.5, 85, -4], [-9.5, 0, -24], 42),
        calm: pose([0, 2.6, 10], [0, 0.6, -30], 38),
        calmRest: pose([0, 5.5, 12], [0, 0, -30], 38),
        setup: pose([-6.5, 4.6, 10.5], [-2.4, 0, -1.5], 38),
        setupEnd: pose([16, 7, 2], [24, 0, -24], 40),
      };
}

type Built = { tl: gsap.core.Timeline; st: ScrollTrigger };

/** Wraps a builder: one timeline scrubbed over the whole page, rebuilt on resize. */
function driven(_field: Field, build: (tl: gsap.core.Timeline, P: ReturnType<typeof poses>) => void, after?: () => void) {
  let built: Built | null = null;
  const make = () => {
    built?.st.kill();
    built?.tl.kill();
    const boot = S.boot;
    Object.assign(S, base, { boot });
    const P = poses();
    const tl = gsap.timeline({ paused: true, defaults: { ease: 'none' } });
    build(tl, P);
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    tl.set({}, {}, max); // timeline duration = scrollable height: time is scroll position
    const st = ScrollTrigger.create({ start: 0, end: () => max, scrub: 0.7, animation: tl });
    built = { tl, st };
    after?.();
  };
  make();
  let w = innerWidth, h = innerHeight, id = 0;
  const onResize = () => {
    if (innerWidth === w && Math.abs(innerHeight - h) < 140) return; // ignore phone URL bar
    w = innerWidth; h = innerHeight;
    clearTimeout(id);
    id = window.setTimeout(() => { make(); ScrollTrigger.refresh(); }, 180);
  };
  addEventListener('resize', onResize);
  return () => {
    removeEventListener('resize', onResize);
    clearTimeout(id);
    built?.st.kill();
    built?.tl.kill();
    built = null;
  };
}

const top = (el: Element) => el.getBoundingClientRect().top + scrollY;

// Eye-open in a scrubbed timeline (the scroll can play it backwards too).
function open(tl: gsap.core.Timeline, el: Element | null, at: number, dur: number) {
  if (!el) return;
  tl.fromTo(el, { autoAlpha: 0, clipPath: SHUT, scaleY: 0.85 }, { autoAlpha: 1, clipPath: OPEN, scaleY: 1, duration: dur, ease: 'expo.out', immediateRender: true }, at);
}
function shut(tl: gsap.core.Timeline, el: Element | null, at: number, dur: number) {
  if (!el) return;
  tl.to(el, { clipPath: SHUT, scaleY: 0.85, autoAlpha: 0, duration: dur, ease: 'power3.in' }, at);
}

// ─── Home: the story ──────────────────────────────────────────────────────────────────────────

export function homeScene(field: Field) {
  const story = document.querySelector<HTMLElement>('[data-story]');
  if (!story) return;
  const q = <T extends Element = HTMLElement>(s: string) => document.querySelector<T>(s);
  const anchors = [...document.querySelectorAll<HTMLElement>('[data-anchor]')];
  const posOf: Record<string, [number, number, number]> = {
    you: [YOU[0], 0.66, YOU[1]],
    anna: [ANNA[0], 0.66, ANNA[1]],
  };
  const place = () => field.setAnchors(anchors.map((el) => ({ el, pos: posOf[el.dataset.anchor!] ?? [0, -50, 0] })), null);
  place();

  const facts = [...document.querySelectorAll<HTMLElement>('[data-fact]')];
  const finale = q('[data-finale]');

  const cleanup = driven(field, (tl, P) => {
    const vh = innerHeight;
    const s0 = top(story);
    const len = story.offsetHeight - vh;
    const at = (f: number) => s0 + f * len;
    const span = (a: number, b: number) => (b - a) * len;

    Object.assign(S, camTo(P.hero), { youAmt: 1, youWake: 1, youLight: 1 });

    // Hero → close on your bot. The headline lifts and dims as the camera moves in.
    tl.to(q('[data-hint]'), { autoAlpha: 0, duration: vh * 0.25 }, 0);
    tl.fromTo(q('.hero__inner'), { autoAlpha: 1, y: 0 }, { autoAlpha: 0, y: -vh * 0.12, duration: vh * 0.6, ease: 'power1.in', immediateRender: false }, vh * 0.1);
    tl.to(q('[data-anchor="you"] [data-tag]'), { autoAlpha: 0, duration: vh * 0.2 }, s0 - vh * 0.35);
    tl.to(S, { ...camTo(P.send), duration: s0 + span(0, 0.05), ease: 'power2.inOut' }, 0);

    // 1. You tell your bot.
    const beats = [...story.querySelectorAll<HTMLElement>('[data-beat]')];
    open(tl, beats[0], at(0.0), span(0, 0.05));
    open(tl, q('[data-bubble="send"]'), at(0.04), span(0, 0.05));
    tl.to(q('[data-bubble="send"]'), { scale: 0.3, autoAlpha: 0, duration: span(0, 0.035), ease: 'power3.in' }, at(0.16));
    shut(tl, beats[0], at(0.15), span(0, 0.03));

    // 2. The signal runs the streets to Anna's bot. The camera rides behind it.
    tl.to(S, { pathAmt: 1, sigGlow: 1, duration: span(0, 0.02) }, at(0.175));
    tl.to(S, { follow: 1, duration: span(0, 0.07), ease: 'power2.inOut' }, at(0.17));
    tl.to(S, { sig: 1, duration: span(0.19, 0.45), ease: 'power1.inOut' }, at(0.19));
    open(tl, beats[1], at(0.2), span(0, 0.05));
    tl.to(S, { ...camTo(P.arrive), duration: span(0, 0.06) }, at(0.36));
    tl.to(S, { follow: 0, duration: span(0, 0.06), ease: 'power2.inOut' }, at(0.42));
    tl.to(S, { sigGlow: 0, duration: span(0, 0.02) }, at(0.445));
    shut(tl, beats[1], at(0.45), span(0, 0.03));

    // 3. Anna's bot wakes, and the ring rolls out across the field.
    tl.to(S, { annaWake: 1, duration: span(0, 0.025), ease: 'expo.out' }, at(0.465));
    open(tl, q('[data-anchor="anna"] [data-tag]'), at(0.47), span(0, 0.03));
    open(tl, beats[2], at(0.49), span(0, 0.05));
    tl.set(S, { waveAmt: 1 }, at(0.5));
    tl.to(S, { waveR: field.mobile ? 70 : 120, duration: span(0.5, 0.74), ease: 'power1.in' }, at(0.5));
    tl.to(S, { ...camTo(P.wave), duration: span(0.49, 0.66), ease: 'power2.inOut' }, at(0.49));
    tl.to(q('[data-anchor="anna"] [data-tag]'), { autoAlpha: 0, duration: span(0, 0.02) }, at(0.525));
    shut(tl, beats[2], at(0.69), span(0, 0.03));

    // 4. The answer comes back.
    tl.to(S, { ...camTo(P.reply), duration: span(0.68, 0.76), ease: 'power2.inOut' }, at(0.68));
    tl.to(S, { waveAmt: 0, duration: span(0, 0.04) }, at(0.73));
    open(tl, beats[3], at(0.73), span(0, 0.05));
    tl.to(S, { repGlow: 1, duration: span(0, 0.015) }, at(0.745));
    tl.to(S, { rep: 1, duration: span(0.75, 0.88), ease: 'power1.inOut' }, at(0.75));
    tl.to(S, { repGlow: 0, duration: span(0, 0.02) }, at(0.875));
    tl.to(S, { ...camTo(P.home), duration: span(0.84, 0.93), ease: 'power2.inOut' }, at(0.84));
    open(tl, q('[data-bubble="reply"]'), at(0.9), span(0, 0.05));

    // Facts: each statement gets its own state of the field.
    tl.to(q('[data-bubble="reply"]'), { autoAlpha: 0, duration: vh * 0.2 }, at(1) + vh * 0.05);
    shut(tl, beats[3], at(1) - vh * 0.1, vh * 0.15);
    tl.to(q('.story__scrim'), { autoAlpha: 0, duration: vh * 0.15 }, at(1) - vh * 0.05);
    tl.to(S, { pathAmt: 0, annaWake: 0, duration: vh * 0.3 }, at(1) - vh * 0.1);

    // The facts. Each statement gets one state of the field:
    //   lock: from high above, the crowd steps back; only your bot, Anna's bot and the street stay lit.
    //   yes:  two bots that both said yes.     ask: Tom's bot asks yours one question.
    const A: [number, number] = [YOU[0], YOU[1]], B: [number, number] = [YOU[0] + 3, YOU[1] - 1];
    const C: [number, number] = field.mobile ? [YOU[0] + 1, YOU[1] - 4] : [YOU[0] - 4, YOU[1] - 2];
    field.setPairs([[A[0], A[1], B[0], B[1]], [A[0], A[1], C[0], C[1]], [YOU[0], YOU[1], ANNA[0], ANNA[1]]]);
    posOf.lockYou = [YOU[0], 0.66, YOU[1]];
    posOf.lockAnna = [ANNA[0], 0.66, ANNA[1]];
    posOf.yesA = [A[0], 0.66, A[1]];
    posOf.yesB = [B[0], 0.66, B[1]];
    posOf.ask = [C[0], 0.66, C[1]];
    posOf.askYou = [A[0], 0.66, A[1]];
    place();
    const tagOf = (k: string) => q(`[data-anchor="${k}"] [data-tag]`);

    facts.forEach((row) => {
      const key = row.dataset.fact;
      const c = top(row) + row.offsetHeight / 2 - vh / 2;
      const inA = c - vh * 0.45, inB = c - vh * 0.12, outA = c + vh * 0.18, outB = c + vh * 0.48;
      const set = (to: Record<string, number>, from: Record<string, number>, tags: string[] = [], hold = true) => {
        tl.fromTo(S, from, { ...to, duration: inB - inA, immediateRender: false }, inA);
        if (hold) tl.to(S, { ...from, duration: outB - outA }, outA);
        tags.forEach((k) => {
          const t = tagOf(k);
          if (!t) return;
          tl.fromTo(t, { autoAlpha: 0 }, { autoAlpha: 1, duration: (inB - inA) * 0.35, immediateRender: false }, inA + (inB - inA) * 0.7);
          tl.to(t, { autoAlpha: 0, duration: (outB - outA) * 0.5 }, outA);
        });
      };
      if (key === 'lock') {
        tl.set(S, { pairWhich: 2 }, inA - 1);
        tl.to(S, { ...camTo(P.lock), duration: inB - inA + vh * 0.1, ease: 'power2.inOut' }, inA - vh * 0.1);
        set({ pairAmt: 1, hush: 1, pathAmt: 1, annaWake: 1, dream: 0 }, { pairAmt: 0, hush: 0, pathAmt: 0, annaWake: 0, dream: base.dream }, ['lockYou', 'lockAnna']);
        tl.to(S, { ...camTo(P.facts), duration: outB - outA + vh * 0.1, ease: 'power2.inOut' }, outA);
      }
      if (key === 'yes') { tl.set(S, { pairWhich: 0 }, inA - 1); set({ pairAmt: 1, dream: 0.0006 }, { pairAmt: 0, dream: base.dream }, ['yesA', 'yesB']); }
      if (key === 'ask') { tl.set(S, { pairWhich: 1 }, inA - 1); set({ pairAmt: 1, dream: 0.0006 }, { pairAmt: 0, dream: base.dream }, ['ask', 'askYou']); }
    });

    // The "also" strip: quiet hours. The whole field goes dark for a moment.
    const also = q('[data-also]');
    if (also) {
      const c = top(also) + also.offsetHeight / 2 - vh / 2;
      tl.fromTo(S, { quiet: 0 }, { quiet: 1, duration: vh * 0.3, immediateRender: false }, c - vh * 0.4);
      tl.to(S, { quiet: 0, duration: vh * 0.3 }, c + vh * 0.25);
    }

    // Finale: back to the wide view, and the whole field comes alive.
    if (finale) {
      const f0 = top(finale) - vh;
      tl.to(S, { ...camTo(P.finale), duration: vh * 0.9, ease: 'power2.inOut' }, f0 + vh * 0.1);
      tl.to(S, { alive: 1, duration: vh * 0.6 }, f0 + vh * 0.45);
    }
  });
  return cleanup;
}

// ─── Setup: your bot gets built as you read ───────────────────────────────────────────────────

export function setupScene(field: Field) {
  const steps = [...document.querySelectorAll<HTMLElement>('[data-step]')];
  if (!steps.length) return;
  const anchors = [...document.querySelectorAll<HTMLElement>('[data-anchor]')];
  const friend: [number, number] = field.mobile ? [YOU[0] + 1, YOU[1] - 3] : [YOU[0] + 3, YOU[1] - 2];
  field.setAnchors(anchors.map((el) => ({ el, pos: el.dataset.anchor === 'friend' ? [friend[0], 0.66, friend[1]] : [YOU[0], 0.66, YOU[1]] })), null);
  field.setPairs([[friend[0], friend[1], 1e4, 1e4], [friend[0], friend[1], 1e4, 1e4]]);
  const tag = (s: string) => document.querySelector(s);
  const plans = document.querySelector<HTMLElement>('[data-plans]');
  return driven(field, (tl, P) => {
    const vh = innerHeight;
    Object.assign(S, camTo(P.setup), { youAmt: 0, youWake: 0, youLight: 0, waveX: YOU[0], waveZ: YOU[1], waveTail: 2.6, pathAmt: 0, dream: 0.002 });
    steps.forEach((row, i) => {
      const c = top(row) + row.offsetHeight / 2 - vh * 0.55;
      const a = c - vh * 0.3, d = vh * 0.25;
      // 1. You: a tag over a sleeping bot. 2. It becomes yours (still asleep).
      // 3. The doorbell rings once: it wakes, light on. 4. A friend's bot wakes too.
      if (i === 0) tl.fromTo(tag('[data-tag="you"]'), { autoAlpha: 0 }, { autoAlpha: 1, duration: d * 0.5, immediateRender: true }, a);
      if (i === 1) {
        tl.to(S, { youAmt: 1, duration: d, ease: 'power2.out' }, a);
        tl.to(tag('[data-tag="you"]'), { autoAlpha: 0, duration: d * 0.3 }, a);
        tl.fromTo(tag('[data-tag="yours"]'), { autoAlpha: 0 }, { autoAlpha: 1, duration: d * 0.5, immediateRender: true }, a + d * 0.3);
      }
      if (i === 2) {
        tl.set(S, { waveAmt: 0.8 }, a);
        tl.fromTo(S, { waveR: 0 }, { waveR: 9, duration: d * 1.4, ease: 'power1.out', immediateRender: false }, a);
        tl.to(S, { waveAmt: 0, duration: d * 0.4 }, a + d * 1.2);
        tl.to(S, { youWake: 1, youLight: 1, duration: d * 0.5, ease: 'expo.out' }, a + d * 0.2);
      }
      if (i === 3) {
        tl.to(S, { pairAmt: 1, duration: d, ease: 'power2.out' }, a);
        tl.fromTo(tag('[data-anchor="friend"] [data-tag]'), { autoAlpha: 0 }, { autoAlpha: 1, duration: d * 0.6, immediateRender: true }, a + d * 0.3);
      }
    });
    // Plans: pull back and let the field rest behind the prices.
    if (plans) {
      const p0 = top(plans) - vh * 0.9;
      tl.to(S, { ...camTo(P.setupEnd), duration: vh * 0.8, ease: 'power2.inOut' }, p0);
      tl.to([tag('[data-tag="yours"]'), tag('[data-anchor="friend"] [data-tag]')], { autoAlpha: 0, duration: vh * 0.3 }, p0);
    }
  });
}

// ─── 404: one bot is missing ──────────────────────────────────────────────────────────────────

export function lostScene(field: Field) {
  const anchors = [...document.querySelectorAll<HTMLElement>('[data-anchor]')];
  const P = poses();
  Object.assign(S, base, camTo(P.lost), { youAmt: 0, youWake: 0, youLight: 0, boot: S.boot });
  const tall = innerWidth / innerHeight < 0.85;
  const m = field.botAt(innerWidth * (tall ? 0.5 : 0.66), innerHeight * (tall ? 0.74 : 0.68), P.lost);
  field.setMissing(m[0], m[1]);
  S.missingAmt = 1;
  field.setAnchors(anchors.map((el) => ({ el, pos: [m[0], 0.62, m[1]] })), null);
  return () => { S.missingAmt = 0; };
}

// ─── Calm pages (security, pricing, bots): one picture in the hero, then rest ─────────────────

export function calmScene(field: Field, kind: 'security' | 'pricing' | 'bots') {
  const anchors = [...document.querySelectorAll<HTMLElement>('[data-anchor]')];
  const hero = document.querySelector<HTMLElement>('.calm-hero');
  const tall = innerWidth / innerHeight < 0.85;
  // Highlights sit where the hero has room: lower right on wide screens, low centre on phones.
  const spot = (fx: number, fy: number) => field.botAt(innerWidth * fx, innerHeight * fy, poses().calm);
  const pos: Record<string, [number, number, number]> = {};
  const extra: Record<string, number> = {};
  if (kind === 'security') {
    const a = tall ? spot(0.3, 0.8) : spot(0.6, 0.78);
    const b = tall ? spot(0.72, 0.7) : spot(0.84, 0.64);
    field.setPairs([[a[0], a[1], b[0], b[1]]]);
    pos.a = [a[0], 0.66, a[1]]; pos.b = [b[0], 0.66, b[1]];
    Object.assign(extra, { pairWhich: 0, pairAmt: 1, hush: 0.92 });
  }
  if (kind === 'pricing') {
    const h = tall ? spot(0.5, 0.78) : spot(0.74, 0.72);
    field.setHouse([[0, 0], [1, 0], [-1, 0], [0, -1], [1, -1], [-1, 1]].map(([x, z]) => [h[0] + x, h[1] + z] as [number, number]));
    pos.house = [h[0], 0.66, h[1] - 1];
    Object.assign(extra, { houseAmt: 1, hush: 0.6 });
  }
  let ring: gsap.core.Timeline | null = null;
  if (kind === 'bots') {
    const y = tall ? spot(0.5, 0.8) : spot(0.72, 0.74);
    pos.you = [y[0], 0.66, y[1]];
    // Your bot sleeps; every few seconds the doorbell rings, it wakes, and dozes off again.
    Object.assign(extra, { waveX: y[0], waveZ: y[1], waveTail: 2.6, houseAmt: 0, pairWhich: 0 });
    field.setPairs([[y[0], y[1], 1e4, 1e4]]);
    ring = gsap.timeline({ repeat: -1, repeatDelay: 1.4, delay: 1.2 })
      .set(S, { waveR: 0, waveAmt: 0.8 })
      .to(S, { waveR: 10, duration: 1.6, ease: 'power1.out' })
      .to(S, { pairAmt: 1, duration: 0.3, ease: 'expo.out' }, 0.1)
      .to(S, { waveAmt: 0, duration: 0.5 }, 1.2)
      .to(S, { pairAmt: 0, duration: 1.2, ease: 'power2.inOut' }, 2.6);
  }
  field.setAnchors(anchors.map((el) => ({ el, pos: pos[el.dataset.anchor!] ?? [0, -50, 0] })), null);
  const tags = anchors.map((el) => el.querySelector('[data-tag]')).filter(Boolean) as Element[];

  const kill = driven(field, (tl, P) => {
    const vh = innerHeight;
    Object.assign(S, camTo(P.calm), { youAmt: 0, youWake: 0, youLight: 0, dream: 0.002 }, extra);
    gsap.set(tags, { autoAlpha: 1 });
    tl.fromTo(tags, { autoAlpha: 1 }, { autoAlpha: 0, duration: vh * 0.25, immediateRender: false }, vh * 0.15);
    tl.to(S, { ...camTo(P.calmRest), duration: vh * 0.9, ease: 'power2.inOut' }, 0);
  });
  // The field is fully under the reading sheet after the hero: stop drawing it there.
  const st = hero ? ScrollTrigger.create({ trigger: hero, start: 'top top', end: 'bottom top', onToggle: (self) => setGLPaused(!self.isActive) }) : null;
  return () => { kill(); st?.kill(); ring?.kill(); setGLPaused(false); Object.assign(S, { hush: 0, pairAmt: 0, houseAmt: 0, waveAmt: 0 }); };
}
