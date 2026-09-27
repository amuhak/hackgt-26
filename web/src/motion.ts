// Live 50 Hz IMU samples per buoy, kept outside React. Frames arrive ~3/s with
// 16 samples each, so playback runs slightly behind the newest sample and
// interpolates, which turns the bursts into smooth motion.

export type Sample = {
  t: number; // buoy clock, ms
  a: [number, number, number]; // g, buoy axes (x fwd, y left, z up)
  g: [number, number, number]; // deg/s
  q: [number, number, number, number]; // w x y z, buoy -> world
  e: [number, number, number]; // roll pitch yaw, deg
};

type Buf = { s: Sample[]; offset: number | null; arrivedAt: number };

const KEEP = 1500; // 30 s
const DELAY_MS = 140;
const bufs = new Map<string, Buf>();

export function pushMotion(node: string, rows: number[][]) {
  let b = bufs.get(node);
  if (!b) {
    b = { s: [], offset: null, arrivedAt: 0 };
    bufs.set(node, b);
  }
  const now = performance.now();
  for (const r of rows) {
    const last = b.s[b.s.length - 1];
    if (last && r[0] < last.t - 2000) {
      b.s = []; // buoy rebooted: its clock restarted
      b.offset = null;
    } else if (last && r[0] <= last.t) continue;
    b.s.push({ t: r[0], a: [r[1], r[2], r[3]], g: [r[4], r[5], r[6]], q: [r[7], r[8], r[9], r[10]], e: [r[11], r[12], r[13]] });
  }
  if (b.s.length > KEEP) b.s.splice(0, b.s.length - KEEP);
  const newest = b.s[b.s.length - 1];
  if (!newest) return;
  // offset maps buoy ms to performance.now(); take the least-delayed arrival, drift slowly.
  const cand = now - newest.t;
  if (b.offset == null || cand < b.offset || now - b.arrivedAt > 2000) b.offset = cand;
  else b.offset += (cand - b.offset) * 0.02;
  b.arrivedAt = now;
}

export function hasLive(node: string): boolean {
  const b = bufs.get(node);
  return !!b && performance.now() - b.arrivedAt < 3000;
}

export function recent(node: string, ms: number): Sample[] {
  const b = bufs.get(node);
  if (!b || !b.s.length) return [];
  const end = b.s[b.s.length - 1].t;
  let i = b.s.length - 1;
  while (i > 0 && b.s[i - 1].t >= end - ms) i--;
  return b.s.slice(i);
}

function slerp(a: Sample["q"], b: Sample["q"], f: number): Sample["q"] {
  let [bw, bx, by, bz] = b;
  let dot = a[0] * bw + a[1] * bx + a[2] * by + a[3] * bz;
  if (dot < 0) {
    [bw, bx, by, bz] = [-bw, -bx, -by, -bz];
    dot = -dot;
  }
  const q: Sample["q"] = [a[0] + (bw - a[0]) * f, a[1] + (bx - a[1]) * f, a[2] + (by - a[2]) * f, a[3] + (bz - a[3]) * f];
  const n = Math.hypot(...q) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

const lerp3 = (a: number[], b: number[], f: number) =>
  [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f] as [number, number, number];

/** The interpolated sample to show right now, or null without live data. */
export function current(node: string): Sample | null {
  const b = bufs.get(node);
  if (!b || !b.s.length || b.offset == null) return null;
  const playT = performance.now() - b.offset - DELAY_MS;
  const s = b.s;
  if (playT >= s[s.length - 1].t) return s[s.length - 1];
  if (playT <= s[0].t) return s[0];
  let lo = 0;
  let hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= playT) lo = mid;
    else hi = mid;
  }
  const A = s[lo];
  const B = s[hi];
  const f = (playT - A.t) / (B.t - A.t || 1);
  return { t: playT, a: lerp3(A.a, B.a, f), g: lerp3(A.g, B.g, f), q: slerp(A.q, B.q, f), e: lerp3(A.e, B.e, f) };
}

/** Rotates a buoy-frame vector into the world frame (z up). */
export function toWorld(q: Sample["q"], v: [number, number, number]): [number, number, number] {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}

/** Quaternion (w x y z) from roll/pitch/yaw in degrees, ZYX order (matches the collector). */
export function fromEuler(rollDeg: number, pitchDeg: number, yawDeg = 0): Sample["q"] {
  const [r, p, y] = [rollDeg, pitchDeg, yawDeg].map((d) => (d * Math.PI) / 360);
  const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  return [
    cr * cp * cy + sr * sp * sy,
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
  ];
}
