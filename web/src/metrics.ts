import { useStore } from "./store";
import type { NodeInfo } from "./types";

export type MetricKey = "water_c" | "air_c" | "pressure_hpa" | "wave_rms_g" | "wave_peak_g" | "tilt" | "age";

// range: the fixed color scale. span: the narrowest scale when it tightens to a big fleet's readings.
type Metric = { label: string; short: string; unit: string; digits: number; range: [number, number]; span: number };

export const METRICS: Record<MetricKey, Metric> = {
  water_c: { label: "Water temperature", short: "Water", unit: "°C", digits: 1, range: [5, 30], span: 2 },
  air_c: { label: "Air temperature", short: "Air", unit: "°C", digits: 1, range: [0, 40], span: 3 },
  pressure_hpa: { label: "Pressure", short: "Pressure", unit: "hPa", digits: 1, range: [960, 1030], span: 4 },
  wave_rms_g: { label: "Wave energy (RMS)", short: "Waves", unit: "g", digits: 3, range: [0, 0.2], span: 0.03 },
  wave_peak_g: { label: "Wave peak", short: "Peak", unit: "g", digits: 2, range: [0, 1], span: 0.1 },
  tilt: { label: "Tilt", short: "Tilt", unit: "°", digits: 1, range: [0, 40], span: 5 },
  age: { label: "Last heard", short: "Heard", unit: "", digits: 0, range: [0, 600], span: 600 },
};

export const MAP_METRICS: MetricKey[] = ["water_c", "air_c", "wave_rms_g", "tilt", "pressure_hpa", "age"];

// teal 70 -> teal 40 -> yellow 30 -> orange 40 -> red 50
const STOPS = ["#005d5d", "#08bdba", "#f1c21b", "#ff832b", "#fa4d56"].map((h) => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
]);

export function ramp(x: number): string {
  const t = Math.min(1, Math.max(0, x)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(t));
  const f = t - i;
  const c = STOPS[i].map((v, k) => Math.round(v + (STOPS[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
export const RAMP_CSS = `linear-gradient(90deg, ${["#005d5d", "#08bdba", "#f1c21b", "#ff832b", "#fa4d56"].join(",")})`;

export function metricValue(n: NodeInfo, m: MetricKey): number | null {
  if (m === "age") return n.age_s;
  const v = n.latest?.[m];
  return v == null ? null : v;
}

const rangeCache = new WeakMap<object, Partial<Record<MetricKey, [number, number]>>>();

/** The color scale for a metric. With 10+ buoys reporting it tightens to what they read
 *  (2nd to 98th percentile), so a big fleet shows its gradients instead of one color. */
export function metricRange(m: MetricKey): [number, number] {
  const fixed = METRICS[m].range;
  if (m === "age") return fixed;
  const nodes = useStore.getState().nodes;
  let cache = rangeCache.get(nodes);
  if (!cache) rangeCache.set(nodes, (cache = {}));
  if (cache[m]) return cache[m]!;
  const vals = Object.values(nodes)
    .filter((n) => n.status !== "offline")
    .map((n) => n.latest?.[m])
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  let r = fixed;
  if (vals.length >= 10) {
    let lo = vals[Math.floor(vals.length * 0.02)];
    let hi = vals[Math.ceil(vals.length * 0.98) - 1];
    const grow = Math.max(0, METRICS[m].span - (hi - lo)) / 2;
    lo -= grow;
    hi += grow;
    const step = 10 ** -METRICS[m].digits;
    r = [Math.floor(lo / step) * step, Math.ceil(hi / step) * step];
  }
  cache[m] = r;
  return r;
}

export function valueColor(m: MetricKey, v: number | null | undefined): string {
  if (v == null) return "#8d8d8d";
  const [lo, hi] = metricRange(m);
  return ramp((v - lo) / (hi - lo));
}

export function metricColor(n: NodeInfo, m: MetricKey): string {
  if (n.status === "offline" || n.status === "unknown") return "#8d8d8d";
  return valueColor(m, metricValue(n, m));
}

export function fmt(v: number | null | undefined, digits = 1): string {
  return v == null || Number.isNaN(v) ? "—" : v.toFixed(digits);
}

export function fmtMetric(n: NodeInfo, m: MetricKey): string {
  if (m === "age") return ago(n.age_s);
  return fmt(metricValue(n, m), METRICS[m].digits);
}

export function ago(s: number | null | undefined): string {
  if (s == null) return "never";
  if (s < 2) return "now";
  if (s < 90) return `${Math.round(s)} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function duration(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `${Math.floor(s / 86400)} d ${Math.round((s % 86400) / 3600)} h`;
}

export const STATUS_LABEL: Record<string, string> = {
  online: "Online",
  stale: "Stale",
  offline: "Offline",
  unknown: "Unknown",
};

export const POS_LABEL: Record<string, string> = {
  gps: "GPS fix",
  last_fix: "Last GPS fix",
  pinned: "Pinned",
  default: "No fix · approx.",
};
