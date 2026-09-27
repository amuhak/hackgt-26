import { useEffect, useRef, useState } from "react";
import { Asleep, Close, Light, Microphone } from "@carbon/icons-react";
import { useStore } from "./store";
import { ago } from "./metrics";
import { MapView } from "./components/MapView";
import { Dashboard } from "./components/Dashboard";
import { NodePage } from "./components/NodePage";
import { VoicePanel } from "./components/VoicePanel";
import { agent } from "./voice/agent";

export function App() {
  const theme = useStore((s) => s.theme);
  const selected = useStore((s) => s.selected);
  const voiceOpen = useStore((s) => s.voiceOpen);
  const [faded, setFaded] = useState(false);
  const idle = useRef<number>(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Dashboard fades while the map is being handled, and comes back when it's left alone.
  const onInteract = () => {
    setFaded(true);
    clearTimeout(idle.current);
    idle.current = window.setTimeout(() => setFaded(false), 2500);
  };

  return (
    <div className="shell">
      <Header />
      <div className="main">
        <MapView onInteract={onInteract} />
        {!selected && <Dashboard faded={faded} />}
        {selected && <NodePage key={selected} id={selected} />}
        <Toasts />
        {voiceOpen && <VoicePanel />}
      </div>
    </div>
  );
}

function Header() {
  const theme = useStore((s) => s.theme);
  const selected = useStore((s) => s.selected);
  const node = useStore((s) => (s.selected ? s.nodes[s.selected] : null));
  const collector = useStore((s) => s.collector);
  const connected = useStore((s) => s.connected);
  const voiceOpen = useStore((s) => s.voiceOpen);

  const link = !connected ? ["err", "Backend offline"] : collector?.receiving ? ["live", `Receiving · ${ago(collector.activity_age_s)}`] : ["warn", "Base idle"];
  return (
    <header className="header">
      <button className="brand" onClick={() => useStore.getState().openNode(null)}>
        <svg className="brand-mark" viewBox="0 0 32 32">
          <path d="M3 21c4.3-4 8.7-4 13 0s8.7 4 13 0" stroke="var(--accent)" strokeWidth="3" fill="none" />
          <circle cx="16" cy="11" r="4.5" fill="var(--accent)" />
        </svg>
        <span>
          <b>Tideline</b> <span className="sub">Buoy mesh console</span>
        </span>
      </button>
      <nav className="crumbs">
        {selected ? (
          <>
            <a onClick={() => useStore.getState().openNode(null)}>Fleet</a>
            <span>/</span>
            <span className="here">Buoy {node?.name ?? selected}</span>
          </>
        ) : (
          <span className="here">Fleet</span>
        )}
      </nav>
      <div className="header-spacer" />
      <div className="header-item hide-sm">
        <span className={`dot ${link[0]}`} />
        {link[1]}
        {collector?.serial ? <span className="mono muted">{collector.serial}</span> : null}
      </div>
      <button className={`voice-btn ${voiceOpen ? "on" : ""}`} onClick={() => (voiceOpen ? agent.stop() : agent.start())}>
        <Microphone size={16} />
        {voiceOpen ? "End voice" : "Ask Tideline"}
      </button>
      <button
        className="icon-btn"
        style={{ borderLeft: "1px solid var(--border)" }}
        title={theme === "dark" ? "Light mode" : "Dark mode"}
        onClick={() => useStore.getState().setTheme(theme === "dark" ? "light" : "dark")}
      >
        {theme === "dark" ? <Light size={20} /> : <Asleep size={20} />}
      </button>
    </header>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const open = (id: string) => {
    useStore.getState().focus(id);
    setTimeout(() => useStore.getState().openNode(id), 450);
  };
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`} onClick={() => open(t.node)} style={{ cursor: "pointer" }}>
          <div className="bar" />
          <div>
            <div className="tt">{t.title}</div>
            {t.detail && <div className="td">{t.detail}</div>}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              useStore.getState().dismissToast(t.id);
            }}
          >
            <Close size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
