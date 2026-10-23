// The street a message takes: right-angle runs along the gutters between bots, rounded at the
// corners (the same idea as wireframe 3's "trace on a board"). Sampled densely once, then read
// by distance along the route.

export type Route = {
  length: number;
  /** World x, z at distance d along the route (clamped). */
  at: (d: number, out?: [number, number]) => [number, number];
  /** Dense samples [x, z, d, …] for building the ribbon. */
  samples: Float32Array;
};

export function buildRoute(points: [number, number][], radius = 1.2, step = 0.08): Route {
  // 1. Polyline with quadratic corners.
  const dense: [number, number][] = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i], [cx, cz] = points[i + 1];
    const l1 = Math.hypot(bx - ax, bz - az), l2 = Math.hypot(cx - bx, cz - bz);
    const r = Math.min(radius, l1 * 0.5, l2 * 0.5);
    const p0: [number, number] = [bx - ((bx - ax) / l1) * r, bz - ((bz - az) / l1) * r];
    const p2: [number, number] = [bx + ((cx - bx) / l2) * r, bz + ((cz - bz) / l2) * r];
    dense.push(p0);
    for (let k = 1; k <= 10; k++) {
      const t = k / 10, u = 1 - t;
      dense.push([u * u * p0[0] + 2 * u * t * bx + t * t * p2[0], u * u * p0[1] + 2 * u * t * bz + t * t * p2[1]]);
    }
  }
  dense.push(points[points.length - 1]);

  // 2. Cumulative length, then resample evenly.
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  const length = cum[cum.length - 1];
  const n = Math.ceil(length / step) + 1;
  const samples = new Float32Array(n * 3);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.min(length, i * step);
    while (j < cum.length - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const t = (d - cum[j]) / seg;
    samples[i * 3] = dense[j][0] + (dense[j + 1][0] - dense[j][0]) * t;
    samples[i * 3 + 1] = dense[j][1] + (dense[j + 1][1] - dense[j][1]) * t;
    samples[i * 3 + 2] = d;
  }

  const at = (d: number, out: [number, number] = [0, 0]): [number, number] => {
    const f = Math.max(0, Math.min(length, d)) / step;
    const i = Math.min(n - 2, Math.floor(f));
    const t = Math.min(1, f - i);
    out[0] = samples[i * 3] + (samples[i * 3 + 3] - samples[i * 3]) * t;
    out[1] = samples[i * 3 + 1] + (samples[i * 3 + 4] - samples[i * 3 + 1]) * t;
    return out;
  };
  return { length, at, samples };
}

/** For every grid bot within `reach` of the route: distance along the route at its closest point. */
export function pathDistances(route: Route, key: (x: number, z: number) => number, reach = 0.75) {
  const best = new Map<number, { dist: number; d: number }>();
  const s = route.samples;
  for (let i = 0; i < s.length; i += 3) {
    const x = s[i], z = s[i + 1], d = s[i + 2];
    for (let gx = Math.floor(x - reach); gx <= Math.ceil(x + reach); gx++) {
      for (let gz = Math.floor(z - reach); gz <= Math.ceil(z + reach); gz++) {
        const dist = Math.hypot(gx - x, gz - z);
        if (dist > reach) continue;
        const k = key(gx, gz);
        if (k < 0) continue;
        const prev = best.get(k);
        if (!prev || dist < prev.dist) best.set(k, { dist, d });
      }
    }
  }
  return best;
}
