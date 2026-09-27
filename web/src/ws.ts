import { pushMotion } from "./motion";
import { pushAlert, useStore } from "./store";
import type { Alert, NodeInfo } from "./types";

type AlertListener = (a: Alert) => void;
const alertListeners = new Set<AlertListener>();
export const onAlert = (fn: AlertListener) => {
  alertListeners.add(fn);
  return () => alertListeners.delete(fn);
};

export function connect() {
  let retry = 500;
  const open = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 500;
      useStore.setState({ connected: true });
    };
    ws.onclose = () => {
      useStore.setState({ connected: false });
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 5000);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      switch (m.type) {
        case "hello": {
          const nodes: Record<string, NodeInfo> = {};
          for (const n of m.nodes as NodeInfo[]) nodes[n.id] = n;
          useStore.setState({ nodes, collector: m.collector, alerts: m.alerts, readingsTotal: m.readings_total });
          break;
        }
        case "node": {
          const prev = useStore.getState().nodes[m.node.id];
          useStore.setState((s) => ({ nodes: { ...s.nodes, [m.node.id]: m.node } }));
          if (prev?.latest?.seq !== m.node.latest?.seq) window.dispatchEvent(new CustomEvent("reading", { detail: m.node.id }));
          break;
        }
        case "motion":
          pushMotion(m.node, m.rows);
          break;
        case "collector":
          useStore.setState({ collector: m.collector, readingsTotal: m.readings_total });
          break;
        case "alert":
          pushAlert(m.alert);
          alertListeners.forEach((fn) => fn(m.alert));
          break;
      }
    };
  };
  open();
}

// Node summaries carry age_s as of the last push; keep it ticking locally.
export function tickAges() {
  setInterval(() => {
    useStore.setState((s) => {
      const nodes: Record<string, NodeInfo> = {};
      for (const [id, n] of Object.entries(s.nodes)) {
        if (n.age_s == null) {
          nodes[id] = n;
          continue;
        }
        const age = n.age_s + 1;
        // Same rule as the backend's Node.status.
        const status = age < Math.max(3 * n.interval_s, 20) + 10 ? "online" : age < 600 ? "stale" : "offline";
        nodes[id] = { ...n, age_s: age, status };
      }
      return { nodes };
    });
  }, 1000);
}
