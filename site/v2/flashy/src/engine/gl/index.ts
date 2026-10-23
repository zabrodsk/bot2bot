// One shared OGL canvas on the GSAP ticker. Layers (the bot field) register with addLayer().
// Disabled under reduced motion, without WebGL, or with Save-Data: the static fallback shows.
import { Renderer } from 'ogl';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { isTouch, prefersReducedMotion } from '../env';

export type Layer = {
  resize: (w: number, h: number, dpr: number) => void;
  render: (renderer: Renderer, time: number, dt: number) => void;
  /** Make the scene cheaper (fewer instances). Return false when there is nothing left to cut. */
  degrade?: () => boolean;
};

let renderer: Renderer | null = null;
const layers: Layer[] = [];
let vw = 0, vh = 0, last = 0;

// Frame-time governor: if frames run long for half a second, make the next cut: resolution
// first (pixel cost), then fewer bots (vertex cost), alternating. Fast devices never see it.
type Cut = number | 'scene';
const CUTS: Cut[] = [1.5, 1.25, 1, 'scene', 0.8, 'scene', 0.65];
let cut = 0, ema = 0.016, slow = 0, warm = 0;
function govern(dt: number) {
  if (!renderer || cut >= CUTS.length) return;
  if ((warm += dt) < 0.6) return; // ignore warm-up (shader compile, first layout)
  ema += (dt - ema) * 0.15;
  slow = ema > 0.024 ? slow + dt : 0;
  if (slow < 0.5) return;
  while (cut < CUTS.length) {
    const c = CUTS[cut++];
    if (c === 'scene') { if (layers.some((l) => l.degrade?.())) break; continue; }
    if (c < renderer.dpr) { renderer.dpr = c; resize(); break; }
  }
  slow = 0; ema = 0.016; warm = 0;
}

// The head script decides once, before first paint, whether this device gets the field
// (real GPU, motion allowed, no Save-Data). Everything else follows that decision.
let wanted: boolean | null = null;
let failed = false;
export function glWanted() {
  if (wanted === null) wanted = document.documentElement.classList.contains('gl-on');
  return wanted && !failed;
}

/** Skip drawing while the canvas is fully covered (calm pages scroll content over it). */
let paused = false;
export const setGLPaused = (p: boolean) => { paused = p; };

export function glSupported() {
  if (!glWanted()) return false;
  if (prefersReducedMotion()) return false;
  if ((navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData) return false;
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch { return false; }
}

export function initGL() {
  if (renderer) return true;
  if (!glSupported()) { fail(); return false; }
  // DPR caps: the bots are drawn as distance fields, so they stay crisp well below native.
  const dpr = Math.min(devicePixelRatio, isTouch() ? 1.5 : 1.75);
  try {
    // Opaque canvas cleared to the page ground. The glow passes add light (premultiplied colour
    // with zero alpha); on a transparent canvas WebKit's compositor turns that into garbage colours.
    renderer = new Renderer({ dpr, alpha: false, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
  } catch { fail(); return false; }
  if (!renderer.gl) { renderer = null; fail(); return false; }
  const gl = renderer.gl;
  gl.clearColor(11 / 255, 15 / 255, 24 / 255, 1); // --night
  gl.canvas.classList.add('gl-canvas');
  gl.canvas.setAttribute('aria-hidden', 'true');
  gl.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); }, false);
  (document.getElementById('gl') || document.body).appendChild(gl.canvas);
  document.documentElement.classList.add('gl-on');
  resize();
  addEventListener('resize', resize);
  gsap.ticker.add(render);
  return true;
}

export const glRenderer = () => renderer;

export function addLayer(layer: Layer) {
  layers.push(layer);
  if (renderer) layer.resize(vw, vh, renderer.dpr);
  return () => { const i = layers.indexOf(layer); if (i > -1) layers.splice(i, 1); };
}

function fail() {
  failed = true;
  document.documentElement.classList.remove('gl-on');
  try { sessionStorage.setItem('b2b-gl', '0'); } catch {}
  // The layout depends on GL (pinned story vs drawn frames): re-measure after the switch.
  requestAnimationFrame(() => ScrollTrigger.refresh());
}

function resize() {
  if (!renderer) return;
  // Phones change innerHeight when the URL bar moves: size to the large viewport to avoid jumps.
  vw = innerWidth;
  vh = Math.max(innerHeight, document.documentElement.clientHeight);
  renderer.setSize(vw, vh);
  layers.forEach((l) => l.resize(vw, vh, renderer!.dpr));
}

function render(time: number) {
  if (!renderer || document.hidden || paused) { last = 0; return; }
  const dt = Math.min(0.1, last ? time - last : 0.016);
  last = time;
  govern(dt);
  const gl = renderer.gl;
  gl.clear(gl.COLOR_BUFFER_BIT);
  layers.forEach((l) => l.render(renderer!, time, dt));
}
