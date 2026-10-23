// The field: thousands of instanced bot heads on one OGL canvas, plus the lit route and the
// signal comets. Everything visual reads the shared state `S`, which the page scenes tween.
import { Camera, Geometry, Mesh, Program, Transform, Mat4, Vec3, type Renderer } from 'ogl';
import { botVertex, botFragment, routeVertex, routeFragment, cometVertex, cometFragment } from './shaders';
import { buildRoute, pathDistances, type Route } from './route';
import { isTouch } from '../engine/env';

export const YOU: [number, number] = [0, 0];
export const ANNA: [number, number] = [21, -46];
const WAYPOINTS: [number, number][] = [
  [0, 0], [0, -0.5], [0.5, -0.5], [0.5, -14.5], [9.5, -14.5], [9.5, -31.5],
  [20.5, -31.5], [20.5, -45.5], [21, -45.5], [21, -46],
];

const hex = (h: string): [number, number, number] => {
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export type Pose = { p: [number, number, number]; t: [number, number, number]; fov: number; shift: number };

/** The single shared state. Scenes tween these numbers; the renderer only reads them. */
export const S = {
  px: 0, py: 3, pz: 12, tx: 0, ty: 0.6, tz: -30, fov: 38, shift: 0,
  follow: 0, // 0..1: blend toward the chase camera that rides behind the signal
  sig: 0, // 0..1 along the route (outbound)
  rep: 0, // 0..1 along the route (the answer, inbound)
  pathAmt: 0,
  annaWake: 0,
  waveX: ANNA[0], waveZ: ANNA[1], waveR: 0, waveAmt: 0, waveTail: 10,
  dream: 0.0035,
  alive: 0,
  quiet: 0,
  hush: 0, // 0..1: dim everyone except the highlighted bots
  pairAmt: 0,
  houseAmt: 0,
  missingAmt: 0,
  boot: 1,
  youAmt: 1,
  youWake: 1,
  youLight: 1,
  pairWhich: 0,
  sigGlow: 0, repGlow: 0,
};

type Anchor = { el: HTMLElement; pos: [number, number, number] };

export class Field {
  camera: Camera;
  scene = new Transform();
  route: Route;
  bots: Mesh;
  ribbon: Mesh;
  comets: { mesh: Mesh; pos: Float32Array; geo: Geometry }[] = [];
  uniforms: Record<string, { value: any }>;
  mobile: boolean;
  half: number;
  far: number;
  vw = 1; vh = 1;
  anchors: Anchor[] = [];
  // Uniform arrays must be plain arrays for OGL to match "uPokes[0]".
  private pokes: number[] = new Array(48).fill(0);
  private ripples: number[] = new Array(16).fill(0);
  private pokeI = 0; private rippleI = 0;
  private mouse = { x: 0, z: 0, amt: 0, tAmt: 0, nx: 0, ny: 0, sx: 0, sy: 0, lastX: 1e9, lastZ: 1e9, lastT: 0 };
  private pairs: number[][] = [[1e4, 1e4, 1e4, 1e4], [1e4, 1e4, 1e4, 1e4]];
  private pv = new Mat4();
  private inv = new Mat4();
  private time = 0;

  constructor(private renderer: Renderer) {
    const gl = renderer.gl;
    this.mobile = matchMedia('(max-width: 767px)').matches || isTouch();
    this.half = this.mobile ? 34 : 74;
    this.far = this.mobile ? -76 : -100;
    this.camera = new Camera(gl, { fov: 38, near: 0.1, far: 400 });
    this.route = buildRoute(WAYPOINTS);

    const geometry = this.buildGrid(this.half, this.far);

    const C = {
      ground: hex('#0b0f18'), body: hex('#0d121c'), bodyAwake: hex('#151d2e'), sleep: hex('#2e384c'),
      awake: hex('#eef2f8'), blue: hex('#3352e0'), blueHot: hex('#8fa6ff'),
    };
    this.uniforms = {
      uTime: { value: 0 }, uScale: { value: 0.027 }, uViewH: { value: 900 }, uBoot: { value: 1 },
      uYou: { value: YOU }, uYouAmt: { value: 1 }, uYouWake: { value: 1 }, uYouLight: { value: 1 },
      uAnna: { value: ANNA }, uAnnaWake: { value: 0 },
      uSigD: { value: 0 }, uRepD: { value: 0 }, uRouteLen: { value: this.route.length }, uPathAmt: { value: 0 },
      uWave: { value: [ANNA[0], ANNA[1], 0] }, uWaveAmt: { value: 0 }, uWaveTail: { value: 10 },
      uDream: { value: S.dream }, uAlive: { value: 0 }, uQuiet: { value: 0 }, uHush: { value: 0 },
      uPair: { value: [1e4, 1e4, 1e4, 1e4] }, uPairAmt: { value: 0 },
      uHouse: { value: new Array(12).fill(1e4) }, uHouseAmt: { value: 0 },
      uMissing: { value: [1e4, 1e4, 0] },
      uPokes: { value: this.pokes }, uRipples: { value: this.ripples },
      uMouse: { value: [0, 0, 0] },
      uFog: { value: [22, 88] },
      uField: { value: [this.half, this.far] },
      uGround: { value: C.ground }, uBody: { value: C.body }, uBodyAwake: { value: C.bodyAwake },
      uSleep: { value: C.sleep }, uAwake: { value: C.awake }, uBlue: { value: C.blue }, uBlueHot: { value: C.blueHot },
      uAmt: { value: 0 },
    };
    for (let i = 0; i < 12; i++) this.pokes[i * 4 + 2] = -100;
    for (let i = 0; i < 4; i++) this.ripples[i * 4 + 2] = -100;

    const program = new Program(gl, {
      vertex: botVertex, fragment: botFragment, uniforms: this.uniforms,
      transparent: true, depthTest: false, depthWrite: false, cullFace: false,
    });
    this.bots = new Mesh(gl, { geometry, program, frustumCulled: false });

    // The lit street: a ribbon on the ground along the route.
    const s = this.route.samples;
    const m = s.length / 3;
    const rp = new Float32Array(m * 2 * 3);
    const ri = new Float32Array(m * 2 * 2);
    const width = 0.3;
    for (let i = 0; i < m; i++) {
      const a = Math.max(0, i - 1), b = Math.min(m - 1, i + 1);
      let dx = s[b * 3] - s[a * 3], dz = s[b * 3 + 1] - s[a * 3 + 1];
      const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const nx = -dz, nz = dx;
      for (let k = 0; k < 2; k++) {
        const side = k ? 1 : -1;
        const j = i * 2 + k;
        rp[j * 3] = s[i * 3] + nx * width * side;
        rp[j * 3 + 1] = 0.01;
        rp[j * 3 + 2] = s[i * 3 + 1] + nz * width * side;
        ri[j * 2] = s[i * 3 + 2]; ri[j * 2 + 1] = side;
      }
    }
    const ribbonGeo = new Geometry(gl, { position: { size: 3, data: rp }, aInfo: { size: 2, data: ri } });
    const ribbonProgram = new Program(gl, {
      vertex: routeVertex, fragment: routeFragment, uniforms: this.uniforms,
      transparent: true, depthTest: false, depthWrite: false, cullFace: false,
    });
    ribbonProgram.setBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.ribbon = new Mesh(gl, { geometry: ribbonGeo, program: ribbonProgram, mode: gl.TRIANGLE_STRIP, frustumCulled: false });

    // Comets: the signal out and the answer back, each a head and a fading tail of points.
    for (let c = 0; c < 2; c++) {
      const count = 26;
      const pos = new Float32Array(count * 3);
      const size = new Float32Array(count);
      const glow = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const f = i / (count - 1);
        size[i] = i === 0 ? 1.5 : 0.9 * (1 - f) + 0.12;
        glow[i] = i === 0 ? 1.4 : 0.85 * Math.pow(1 - f, 1.6);
      }
      const geo = new Geometry(gl, { position: { size: 3, data: pos }, aSize: { size: 1, data: size }, aGlow: { size: 1, data: glow } });
      const u = { ...this.uniforms, uAmt: { value: 0 } };
      const prog = new Program(gl, { vertex: cometVertex, fragment: cometFragment, uniforms: u, transparent: true, depthTest: false, depthWrite: false });
      prog.setBlendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const mesh = new Mesh(gl, { geometry: geo, program: prog, mode: gl.POINTS, frustumCulled: false });
      this.comets.push({ mesh, pos, geo });
    }

    this.ribbon.setParent(this.scene);
    this.bots.setParent(this.scene);
    this.comets.forEach((c) => c.mesh.setParent(this.scene));
    this.bindPointer();
  }

  private level = 0;

  // Grid, back to front so alpha blending needs no sort.
  private buildGrid(half: number, far: number) {
    const gl = this.renderer.gl;
    const cols = half * 2 + 1;
    const zNear = 14;
    const rows = zNear - far + 1;
    const n = cols * rows;
    const key = (x: number, z: number) => {
      if (x < -half || x > half || z > zNear || z < far) return -1;
      return (z - far) * cols + (x + half);
    };
    const paths = pathDistances(this.route, key);
    const aPos = new Float32Array(n * 2);
    const aData = new Float32Array(n * 2);
    for (let r = 0; r < rows; r++) {
      const z = far + r;
      for (let c = 0; c < cols; c++) {
        const x = c - half;
        const i = r * cols + c;
        aPos[i * 2] = x; aPos[i * 2 + 1] = z;
        const h = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
        aData[i * 2] = h - Math.floor(h);
        aData[i * 2 + 1] = paths.get(i)?.d ?? -1;
      }
    }
    // Quad in bot units: head 16 × 13 centred at 0, antenna and light above, margin for the halo.
    const quad = new Float32Array([-12, -10, 12, -10, 12, 22, -12, 22]);
    return new Geometry(gl, {
      position: { size: 2, data: quad },
      index: { data: new Uint16Array([0, 1, 2, 0, 2, 3]) },
      aPos: { instanced: 1, size: 2, data: aPos },
      aData: { instanced: 1, size: 2, data: aData },
    });
  }

  /** Fewer, nearer bots for slow devices (called by the frame-time governor). */
  degrade() {
    const levels = this.mobile ? [[24, -60]] : [[46, -66], [30, -56]];
    if (this.level >= levels.length) return false;
    const [half, far] = levels[this.level++];
    const old = this.bots.geometry;
    this.bots.geometry = this.buildGrid(half, far);
    old.remove();
    this.half = half; this.far = far;
    this.uniforms.uField.value = [half, far];
    return true;
  }

  resize(w: number, h: number) {
    this.vw = w; this.vh = h;
    this.camera.perspective({ aspect: w / h });
    this.uniforms.uViewH.value = h * this.renderer.dpr;
  }

  // Camera from the shared state, with the chase camera and a little pointer parallax mixed in.
  private placeCamera() {
    const f = S.follow;
    let px = S.px, py = S.py, pz = S.pz, tx = S.tx, ty = S.ty, tz = S.tz;
    if (f > 0.0001) {
      const [sx, sz] = this.route.at(S.sig * this.route.length);
      const back = this.mobile ? 9.5 : 8;
      const cx = sx - 2.2, cy = this.mobile ? 7.5 : 5.2, cz = sz + back;
      const lx = sx + 1.2, ly = 0, lz = sz - 6;
      px += (cx - px) * f; py += (cy - py) * f; pz += (cz - pz) * f;
      tx += (lx - tx) * f; ty += (ly - ty) * f; tz += (lz - tz) * f;
    }
    const m = this.mouse;
    m.sx += (m.nx - m.sx) * 0.04; m.sy += (m.ny - m.sy) * 0.04;
    const par = 1 - f;
    this.camera.fov = S.fov;
    this.camera.perspective({ fov: S.fov, aspect: this.vw / this.vh });
    // Lens shift (like a view camera's rise/fall): moves the horizon without tilting the field.
    this.camera.projectionMatrix[9] = S.shift;
    this.camera.position.set(px + m.sx * 0.45 * par, py + m.sy * 0.22 * par, pz);
    this.camera.lookAt([tx + m.sx * 0.25 * par, ty, tz]);
    this.camera.updateMatrixWorld();
    this.pv.multiply(this.camera.projectionMatrix, this.camera.viewMatrix);
    // Fog follows the camera's height, so the low vista dissolves at the horizon and the
    // aerial shots still see the whole field.
    const h = Math.max(0, this.camera.position.y);
    const fog = this.uniforms.uFog.value as number[];
    fog[0] = Math.max(22, h * 1.3); fog[1] = Math.max(88, h * 3.3);
  }

  /** Place the camera from the current state without drawing (for measuring before a frame). */
  prime() { this.placeCamera(); }

  /** World → CSS pixels. Returns null when behind the camera. */
  project(x: number, y: number, z: number, out: { x: number; y: number } = { x: 0, y: 0 }) {
    const e = this.pv;
    const w = e[3] * x + e[7] * y + e[11] * z + e[15];
    if (w <= 0.01) return null;
    out.x = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * this.vw;
    out.y = (1 - ((e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5 + 0.5)) * this.vh;
    return out;
  }

  /** CSS pixels → the point on the ground (y = 0) under them, for a given camera state. */
  ground(sx: number, sy: number): [number, number] | null {
    this.inv.inverse(this.pv);
    const nx = (sx / this.vw) * 2 - 1, ny = 1 - (sy / this.vh) * 2;
    const a = new Vec3(nx, ny, -1).applyMatrix4(this.inv);
    const b = new Vec3(nx, ny, 1).applyMatrix4(this.inv);
    const dy = b.y - a.y;
    if (Math.abs(dy) < 1e-6) return null;
    const t = -a.y / dy;
    if (t < 0) return null;
    return [a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t];
  }

  /** Nearest grid bot under a screen point, for a pose (used to place fact highlights). */
  botAt(sx: number, sy: number, pose: Pose): [number, number] {
    const keep = { px: S.px, py: S.py, pz: S.pz, tx: S.tx, ty: S.ty, tz: S.tz, fov: S.fov, shift: S.shift, follow: S.follow };
    Object.assign(S, { px: pose.p[0], py: pose.p[1], pz: pose.p[2], tx: pose.t[0], ty: pose.t[1], tz: pose.t[2], fov: pose.fov, shift: pose.shift, follow: 0 });
    const m = this.mouse; const ms = [m.sx, m.sy]; m.sx = m.sy = 0;
    this.placeCamera();
    const g = this.ground(sx, sy) ?? [0, 0];
    Object.assign(S, keep); m.sx = ms[0]; m.sy = ms[1];
    this.placeCamera();
    return [Math.round(g[0]), Math.round(g[1])];
  }

  setPairs(pairs: number[][]) { this.pairs = pairs; }
  setMissing(x: number, z: number) { this.uniforms.uMissing.value = [x, z, 0]; }
  setHouse(list: [number, number][]) {
    const a = this.uniforms.uHouse.value as number[];
    a.fill(1e4);
    list.slice(0, 6).forEach(([x, z], i) => { a[i * 2] = x; a[i * 2 + 1] = z; });
  }

  setAnchors(list: Anchor[], _timer?: HTMLElement | null) {
    this.anchors = list;
  }

  private bindPointer() {
    const m = this.mouse;
    const interactive = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('a, button, input, label, [data-no-ring]');
    addEventListener('pointermove', (e) => {
      if (e.pointerType !== 'mouse') return;
      m.nx = (e.clientX / this.vw) * 2 - 1;
      m.ny = 1 - (e.clientY / this.vh) * 2;
      const g = this.ground(e.clientX, e.clientY);
      if (!g) return;
      m.x = g[0]; m.z = g[1]; m.tAmt = 1; m.lastT = this.time;
      if (Math.hypot(g[0] - m.lastX, g[1] - m.lastZ) > 0.5) {
        m.lastX = g[0]; m.lastZ = g[1];
        this.poke(g[0], g[1], 1);
      }
    }, { passive: true });
    document.addEventListener('pointerleave', () => { m.tAmt = 0; });
    let down: { x: number; y: number; t: number; type: string } | null = null;
    addEventListener('pointerdown', (e) => { down = interactive(e.target) ? null : { x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType }; }, { passive: true });
    addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 450;
      down = null;
      if (moved > 12 || !quick) return;
      const g = this.ground(e.clientX, e.clientY);
      if (g) this.ring(g[0], g[1]);
    }, { passive: true });
  }

  poke(x: number, z: number, strength: number) {
    const i = this.pokeI++ % 12;
    this.pokes[i * 4] = x; this.pokes[i * 4 + 1] = z; this.pokes[i * 4 + 2] = this.time; this.pokes[i * 4 + 3] = strength;
  }

  ring(x: number, z: number) {
    const i = this.rippleI++ % 4;
    this.ripples[i * 4] = x; this.ripples[i * 4 + 1] = z; this.ripples[i * 4 + 2] = this.time; this.ripples[i * 4 + 3] = 1;
  }

  render(renderer: Renderer, time: number, dt: number) {
    this.time = time;
    const u = this.uniforms;
    const L = this.route.length;
    const m = this.mouse;
    if (time - m.lastT > 1.6) m.tAmt = 0;
    m.amt += (m.tAmt - m.amt) * Math.min(1, dt * 4);

    u.uTime.value = time;
    u.uBoot.value = S.boot;
    u.uYouAmt.value = S.youAmt;
    u.uYouWake.value = S.youWake;
    u.uYouLight.value = S.youLight;
    u.uPair.value = this.pairs[Math.max(0, Math.min(this.pairs.length - 1, Math.round(S.pairWhich)))];
    u.uAnnaWake.value = S.annaWake;
    u.uSigD.value = S.sig * L;
    u.uRepD.value = S.rep * L;
    u.uPathAmt.value = S.pathAmt;
    u.uWave.value = [S.waveX, S.waveZ, S.waveR];
    u.uWaveAmt.value = S.waveAmt;
    u.uWaveTail.value = S.waveTail;
    u.uDream.value = S.dream;
    u.uAlive.value = S.alive;
    u.uQuiet.value = S.quiet;
    u.uHush.value = S.hush;
    u.uPairAmt.value = S.pairAmt;
    u.uHouseAmt.value = S.houseAmt;
    const mv = u.uMissing.value as number[];
    u.uMissing.value = [mv[0], mv[1], S.missingAmt];
    u.uMouse.value = [m.x, m.z, m.amt];

    this.placeCamera();

    // Comets: head at the signal, tail behind it along the street.
    const tmp: [number, number] = [0, 0];
    const runs = [
      { d: S.sig * L, dir: -1, amt: S.sigGlow },
      { d: L - S.rep * L, dir: 1, amt: S.repGlow },
    ];
    runs.forEach((r, c) => {
      const comet = this.comets[c];
      const prog = comet.mesh.program;
      prog.uniforms.uAmt.value = r.amt;
      comet.mesh.visible = r.amt > 0.001;
      if (!comet.mesh.visible) return;
      for (let i = 0; i < 26; i++) {
        this.route.at(r.d + r.dir * i * 0.32, tmp);
        comet.pos[i * 3] = tmp[0];
        comet.pos[i * 3 + 1] = 0.22 + (i === 0 ? 0.05 : 0);
        comet.pos[i * 3 + 2] = tmp[1];
      }
      comet.geo.attributes.position.needsUpdate = true;
    });

    // DOM anchors follow their bots.
    const pt = { x: 0, y: 0 };
    for (const a of this.anchors) {
      const q = this.project(a.pos[0], a.pos[1], a.pos[2], pt);
      if (!q || q.x < -200 || q.x > this.vw + 200 || q.y < -200 || q.y > this.vh + 200) {
        if (a.el.style.visibility !== 'hidden') a.el.style.visibility = 'hidden';
        continue;
      }
      if (a.el.style.visibility) a.el.style.visibility = '';
      a.el.style.translate = `${q.x.toFixed(1)}px ${q.y.toFixed(1)}px`;
    }

    renderer.render({ scene: this.scene, camera: this.camera, sort: false, frustumCull: false, clear: false });
  }
}
