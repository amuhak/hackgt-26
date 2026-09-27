import { useStore, type ChartFocus } from "./store";
import type { MetricKey } from "./metrics";
import type { Alert } from "./types";

export const RANGES = [15, 60, 360, 1440]; // minutes, the history chart's range buttons

// Which history chart shows each alert kind, and the box label. Sensor bits: 1 air, 2 motion, 4 water.
const KIND: Record<string, [MetricKey, string]> = {
  waves: ["wave_rms_g", "Rough water"],
  impact: ["wave_rms_g", "Impact"],
  tilt: ["tilt", "Tilted"],
  capsize: ["tilt", "Possible capsize"],
  water_jump: ["water_c", "Temperature jump"],
  offline: ["water_c", "No data"],
  sensor1: ["air_c", "Air sensor out"],
  sensor2: ["tilt", "Motion sensor out"],
  sensor4: ["water_c", "Water probe out"],
  gps: ["water_c", "GPS change"],
};

/** Opens a buoy's history chart with [from, to] boxed; picks the smallest range that shows it. */
export function openChart(f: Omit<ChartFocus, "at" | "minutes"> & { minutes?: number }) {
  const now = Date.now() / 1000;
  const minutes = f.minutes ?? RANGES.find((m) => m * 60 >= (now - f.from) * 1.25 + 60) ?? 1440;
  const st = useStore.getState();
  useStore.setState({ chartFocus: { ...f, minutes, at: Date.now() } });
  if (st.selected !== f.node) {
    st.focus(f.node);
    setTimeout(() => useStore.getState().openNode(f.node), 450);
  }
}

/** Opens the chart around an alert. Outages (silent, sensor lost) are boxed until they recovered, or now. */
export function showProblem(a: Alert) {
  const st = useStore.getState();
  const iv = st.nodes[a.node]?.interval_s ?? 30;
  const [metric, label] = KIND[a.kind] ?? ["water_c", a.title];
  let from = a.t - 2 * iv; // raised when the reading arrives, so the cause is just before
  let to = a.t;
  if (a.kind === "offline" || a.kind.startsWith("sensor")) {
    const same = (x: Alert) => x.node === a.node && x.kind === a.kind;
    const start = a.level === "info" ? [...st.alerts].reverse().find((x) => same(x) && x.level !== "info" && x.t < a.t) ?? a : a;
    const end = st.alerts.find((x) => same(x) && x.level === "info" && x.t > start.t);
    from = start.since ?? start.t - iv;
    to = end?.t ?? Date.now() / 1000;
  }
  openChart({ node: a.node, metric, from, to, label });
  return { metric, label };
}
