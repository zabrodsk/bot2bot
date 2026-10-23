export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isTouch = () => matchMedia('(hover: none), (pointer: coarse)').matches;
export const isMobile = () => matchMedia('(max-width: 767px)').matches;

// Shared easing vocabulary. The motion verb here is "wake": things open fast and settle slowly.
export const ease = {
  out: 'expo.out', // open: reveals, lights, eyes
  inOut: 'expo.inOut', // the blink (page transitions), camera moves between poses
  soft: 'power3.out', // small UI
  shut: 'power3.in', // closing lids
} as const;
