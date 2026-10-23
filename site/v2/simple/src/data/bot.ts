// The bot, in its own units (head 16 wide). Shared by the static SVGs (Bot.astro) and the
// live field (motion/field.ts), so every bot on the site is the same drawing.
export const BOT = {
  head: { x: -8, y: -6, w: 16, h: 12.5, rx: 4 },
  eyes: [{ x: -4.4 }, { x: 1.8 }].map((e) => ({ ...e, y: -1.6, w: 2.6, h: 3.4, rx: 1.1 })),
  eyeCy: 0.1, // eye centre: eyes close around this line
  asleepEye: 0.24, // eye height when asleep, as a fraction of open
  antenna: { y1: -6, y2: -8.8 },
  light: { cy: -10.4, r: 1.7 },
  top: -12.1, // top of the light
  bottom: 6.5, // bottom of the head
  vc: 2.8, // shift that puts the visual centre (top to bottom) on y = 0
} as const;

export const COLORS = {
  ground: '#f3f5f8',
  sleep: '#c3cad5',
  ink: '#1a2230',
  signal: '#2747c9',
  white: '#ffffff',
} as const;

export type BotState = 'asleep' | 'awake' | 'lit' | 'you';

/** Paint for each state: [head fill, head stroke, eye fill, antenna, light]. */
export const PAINT: Record<BotState, [string, string, string, string, string]> = {
  asleep: [COLORS.ground, COLORS.sleep, COLORS.sleep, COLORS.sleep, COLORS.sleep],
  awake: [COLORS.white, COLORS.ink, COLORS.ink, COLORS.ink, COLORS.sleep],
  lit: [COLORS.white, COLORS.ink, COLORS.ink, COLORS.ink, COLORS.signal],
  you: [COLORS.ink, COLORS.ink, COLORS.white, COLORS.ink, COLORS.signal],
};
