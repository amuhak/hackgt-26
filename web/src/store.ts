import { create } from "zustand";
import type { MetricKey } from "./metrics";
import type { Alert, Collector, NodeInfo } from "./types";

export type VoiceLine = { id: string; role: "user" | "agent" | "tool" | "sys"; text: string };
export type VoiceStatus = "off" | "connecting" | "listening" | "thinking" | "speaking" | "error";

type Theme = "dark" | "light";

/** A history chart to open on a buoy page, with a box drawn around [from, to]. */
export type ChartFocus = { node: string; metric: MetricKey; minutes: number; from: number; to: number; label: string; at: number };

type State = {
  nodes: Record<string, NodeInfo>;
  collector: Collector | null;
  alerts: Alert[];
  toasts: Alert[];
  readingsTotal: number;
  connected: boolean;
  theme: Theme;
  metric: MetricKey;
  selected: string | null;
  hovered: string | null;
  placing: boolean;
  focusRequest: { id: string | null; at: number } | null; // map fly-to / fit requests
  chartFocus: ChartFocus | null;
  voiceOpen: boolean;
  voiceStatus: VoiceStatus;
  voiceError: string | null;
  voiceLog: VoiceLine[];

  setTheme: (t: Theme) => void;
  setMetric: (m: MetricKey) => void;
  openNode: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  setPlacing: (p: boolean) => void;
  focus: (id: string | null) => void;
  dismissToast: (id: string) => void;
};

function initialTheme(): Theme {
  try {
    const t = localStorage.getItem("theme");
    if (t === "dark" || t === "light") return t;
  } catch {
    /* storage blocked */
  }
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function selectedFromHash(): string | null {
  const m = location.hash.match(/^#\/node\/([\w-]+)/);
  return m ? m[1] : null;
}

export const useStore = create<State>((set) => ({
  nodes: {},
  collector: null,
  alerts: [],
  toasts: [],
  readingsTotal: 0,
  connected: false,
  theme: initialTheme(),
  metric: "water_c",
  selected: selectedFromHash(),
  hovered: null,
  placing: false,
  focusRequest: null,
  chartFocus: null,
  voiceOpen: false,
  voiceStatus: "off",
  voiceError: null,
  voiceLog: [],

  setTheme: (theme) => {
    try {
      localStorage.setItem("theme", theme);
    } catch {
      /* storage blocked */
    }
    set({ theme });
  },
  setMetric: (metric) => set({ metric }),
  openNode: (id) => {
    const hash = id ? `#/node/${id}` : "#/";
    if (location.hash !== hash) history.pushState(null, "", hash);
    set((s) => ({ selected: id, hovered: null, chartFocus: s.chartFocus?.node === id ? s.chartFocus : null }));
  },
  setHovered: (hovered) => set({ hovered }),
  setPlacing: (placing) => set({ placing }),
  focus: (id) => set({ focusRequest: { id, at: Date.now() } }),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

window.addEventListener("popstate", () =>
  useStore.setState((s) => {
    const selected = selectedFromHash();
    return { selected, chartFocus: s.chartFocus?.node === selected ? s.chartFocus : null };
  }),
);

export function pushAlert(a: Alert) {
  useStore.setState((s) => ({ alerts: [...s.alerts, a].slice(-100), toasts: [...s.toasts, a].slice(-4) }));
  setTimeout(() => useStore.getState().dismissToast(a.id), a.level === "critical" ? 12000 : 7000);
}

export function logVoice(role: VoiceLine["role"], text: string, id?: string) {
  useStore.setState((s) => {
    const key = id ?? `${role}-${Date.now()}-${Math.random()}`;
    const i = s.voiceLog.findIndex((l) => l.id === key);
    if (i >= 0) {
      const log = s.voiceLog.slice();
      log[i] = { ...log[i], text };
      return { voiceLog: log };
    }
    return { voiceLog: [...s.voiceLog, { id: key, role, text }].slice(-60) };
  });
}
