import { useEffect, useRef, useState } from "react";
import { Close, Microphone, SendAlt } from "@carbon/icons-react";
import { useStore } from "../store";
import { agent, levels } from "../voice/agent";

const STATUS: Record<string, string> = {
  off: "Off",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
  error: "Voice unavailable",
};

export function VoicePanel() {
  const status = useStore((s) => s.voiceStatus);
  const error = useStore((s) => s.voiceError);
  const log = useStore((s) => s.voiceLog);
  const [text, setText] = useState("");
  const bars = useRef<HTMLDivElement>(null);
  const logEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = bars.current;
      if (!el) return;
      const lv = Math.max(levels.mic * 4, agent.outLevel() * 3);
      const t = performance.now() / 180;
      Array.from(el.children).forEach((c, i) => {
        const wob = 0.55 + 0.45 * Math.sin(t + i * 1.3);
        (c as HTMLElement).style.height = `${Math.min(32, 3 + lv * 90 * wob)}px`;
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    logEl.current?.scrollTo({ top: logEl.current.scrollHeight });
  }, [log]);

  const submit = () => {
    if (!text.trim()) return;
    agent.sendText(text.trim());
    setText("");
  };

  return (
    <div className="voice">
      <div className="voice-top">
        <Microphone size={20} style={{ color: "var(--accent)" }} />
        <div className="voice-state">
          <div className="vs">Tideline voice</div>
          <div className="label">{STATUS[status]}</div>
        </div>
        <div className="voice-viz" ref={bars}>
          {Array.from({ length: 7 }, (_, i) => (
            <span key={i} />
          ))}
        </div>
        <button className="icon-btn" style={{ width: 40, height: 40 }} title="End voice session" onClick={() => agent.stop()}>
          <Close size={20} />
        </button>
      </div>
      {error && <div className="voice-err">{error}</div>}
      <div className="voice-log" ref={logEl}>
        {log.length === 0 && !error && (
          <div className="empty">Try: "How's buoy one doing?" · "Which buoy has the roughest water?" · "Show me buoy three" · "How has the water temperature changed in the last hour?"</div>
        )}
        {log.map((l) => (
          <div key={l.id} className={`vl ${l.role}`}>
            <div className="who">{l.role === "agent" ? "Tideline" : l.role === "user" ? "You" : l.role === "tool" ? "Tool" : "System"}</div>
            <div className="txt">{l.text}</div>
          </div>
        ))}
      </div>
      <div className="voice-input">
        <input
          placeholder="Or type a question"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="icon-btn" style={{ width: 44, height: 44 }} title="Send" onClick={submit}>
          <SendAlt size={18} />
        </button>
      </div>
    </div>
  );
}
