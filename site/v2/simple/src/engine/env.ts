export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isTouch = () => matchMedia('(hover: none), (pointer: coarse)').matches;
export const isMobile = () => matchMedia('(max-width: 699px)').matches;

// The site's motion vocabulary: things open fast, settle slowly, and travel evenly.
export const ease = {
  open: 'expo.out', // eyes opening, labels arriving, lids opening
  settle: 'sine.inOut', // eyes closing, lights fading, traces dimming
  travel: 'power2.inOut', // a message moving along the grid
  close: 'power2.in', // lids closing
} as const;
