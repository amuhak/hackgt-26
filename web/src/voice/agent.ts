// Browser voice agent on xAI's realtime API (grok-voice). The backend mints a
// short-lived token; audio goes straight between the browser and xAI. Tools run
// here: data tools call our backend, UI tools drive the store.
import { MAP_METRICS, METRICS, POS_LABEL, ago } from "../metrics";
import { logVoice, useStore } from "../store";
import type { NodeInfo } from "../types";
import { onAlert } from "../ws";

export const levels = { mic: 0, out: 0 };

const INSTRUCTIONS = `You are Tideline, the voice of a live console for a mesh of floating sensor buoys, demoed at HackGT on the Georgia Tech campus.

Each buoy is a small manta-ray-shaped hull with a water temperature probe, an air temperature and pressure sensor, a 50 Hz motion sensor and GPS. The buoys relay each other's data over an ESP-NOW radio mesh to a base station plugged into this laptop, so data from buoys out of range still arrives. Buoys in direct range of the base also stream live motion.

Buoys are named like "#1" and "#3"; say "buoy one", "buoy three".

How to talk:
- Speak in one or two short sentences. Round sensibly: temperatures to one decimal, pressure to whole hectopascals.
- Never guess numbers. Call a tool for any data question.
- Wave RMS is wave energy in g: under 0.02 g is calm, over 0.1 g is rough. Tilt is degrees from level. Yaw is relative, since there's no compass.
- If data comes from simulated sensors, say so when relevant.
- When asked to show, open, or look at a buoy, call show_buoy. For "go back" or "show everything", call show_map.
- A user message starting with "ALERT:" is from the monitoring system, not the user. Announce it in one calm sentence and offer to show the buoy.`;

const buoyParam = { buoy: { type: "string", description: 'Buoy name or id, e.g. "#1", "1", or "f4e618b4"' } };
const TOOLS = [
  { type: "function", name: "get_fleet_status", description: "Current status and latest readings of every buoy.", parameters: { type: "object", properties: {} } },
  {
    type: "function",
    name: "get_buoy_details",
    description: "Everything about one buoy: latest reading, sensor health, GPS, link, record counts.",
    parameters: { type: "object", properties: buoyParam, required: ["buoy"] },
  },
  {
    type: "function",
    name: "get_trend",
    description: "Min, max, mean, first, last and change per hour of one metric for one buoy over a time window.",
    parameters: {
      type: "object",
      properties: {
        ...buoyParam,
        metric: { type: "string", enum: ["water_c", "air_c", "pressure_hpa", "wave_rms_g", "wave_peak_g", "tilt", "pitch", "roll"] },
        minutes: { type: "number", description: "Window length in minutes, default 60" },
      },
      required: ["buoy", "metric"],
    },
  },
  { type: "function", name: "get_recent_alerts", description: "The most recent alerts from the monitoring system.", parameters: { type: "object", properties: {} } },
  {
    type: "function",
    name: "show_buoy",
    description: "Open a buoy's page in the UI: its 3D model, live tilt and all its details.",
    parameters: { type: "object", properties: buoyParam, required: ["buoy"] },
  },
  { type: "function", name: "show_map", description: "Go back to the fleet map, zoomed to fit every buoy.", parameters: { type: "object", properties: {} } },
  {
    type: "function",
    name: "set_map_color",
    description: "Choose which metric colors the buoys on the map.",
    parameters: { type: "object", properties: { metric: { type: "string", enum: MAP_METRICS } }, required: ["metric"] },
  },
  {
    type: "function",
    name: "set_theme",
    description: "Switch the UI between dark and light mode.",
    parameters: { type: "object", properties: { mode: { type: "string", enum: ["dark", "light"] } }, required: ["mode"] },
  },
];

function findBuoy(ref: string): NodeInfo | null {
  const words: Record<string, string> = { one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8" };
  let s = String(ref).toLowerCase().replace(/buoy|node|number/g, "").trim();
  s = words[s] ?? s;
  return (
    Object.values(useStore.getState().nodes).find((n) =>
      [n.id, n.name.toLowerCase(), n.name.toLowerCase().replace("#", ""), n.id.slice(-4)].includes(s),
    ) ?? null
  );
}

function brief(n: NodeInfo) {
  const r = n.latest;
  return {
    name: n.name,
    id: n.id,
    status: n.status,
    last_heard: ago(n.age_s),
    link: n.direct ? "direct to base, live motion" : "relayed through the mesh",
    water_c: r?.water_c,
    air_c: r?.air_c,
    pressure_hpa: r?.pressure_hpa,
    wave_rms_g: r?.wave_rms_g,
    wave_peak_g: r?.wave_peak_g,
    tilt_deg: r?.tilt,
    position: `${POS_LABEL[n.pos.source]} ${n.pos.lat.toFixed(5)}, ${n.pos.lon.toFixed(5)}`,
    simulated_sensors: n.sim,
  };
}

async function api(path: string) {
  const r = await fetch(path);
  const j = await r.json();
  return r.ok ? j : { error: j.detail ?? r.statusText };
}

async function runTool(name: string, a: Record<string, unknown>): Promise<unknown> {
  const st = useStore.getState();
  switch (name) {
    case "get_fleet_status":
      return { buoys: Object.values(st.nodes).map(brief), base_receiving: st.collector?.receiving ?? false };
    case "get_buoy_details": {
      const n = findBuoy(String(a.buoy));
      if (!n) return { error: `No buoy "${a.buoy}". Known: ${Object.values(st.nodes).map((x) => x.name).join(", ")}` };
      const d = await api(`/api/nodes/${n.id}`);
      const f = n.latest?.flags ?? 0;
      return {
        ...brief(n),
        sats: n.latest?.sats,
        sample_interval_s: n.interval_s,
        sensors_ok: { water: !!(f & 4), air_pressure: !!(f & 1), motion: !!(f & 2), gps_fix: !!(f & 8) },
        records_in_db: d.records,
        uptime_s: n.latest?.uptime_s,
        live_attitude_deg: n.attitude ? { roll: n.attitude[0], pitch: n.attitude[1] } : null,
      };
    }
    case "get_trend": {
      const n = findBuoy(String(a.buoy));
      if (!n) return { error: `No buoy "${a.buoy}"` };
      return api(`/api/summary?node=${n.id}&metric=${a.metric}&minutes=${Number(a.minutes) || 60}`);
    }
    case "get_recent_alerts":
      return { alerts: st.alerts.slice(-10).map((x) => ({ title: x.title, detail: x.detail, ago: ago(Date.now() / 1000 - x.t) })) };
    case "show_buoy": {
      const n = findBuoy(String(a.buoy));
      if (!n) return { error: `No buoy "${a.buoy}"` };
      st.focus(n.id);
      setTimeout(() => useStore.getState().openNode(n.id), 450);
      return { ok: true, showing: n.name };
    }
    case "show_map":
      st.openNode(null);
      st.focus(null);
      return { ok: true };
    case "set_map_color":
      if (!(String(a.metric) in METRICS)) return { error: "unknown metric" };
      st.openNode(null);
      st.setMetric(a.metric as keyof typeof METRICS);
      return { ok: true };
    case "set_theme":
      st.setTheme(a.mode === "light" ? "light" : "dark");
      return { ok: true };
  }
  return { error: `unknown tool ${name}` };
}

function b64(buf: ArrayBuffer) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

class VoiceAgent {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private playHead = 0;
  private responding = false;
  private needResponse = false;
  private pendingAlerts: string[] = [];
  private stopping = false;
  private unsub: (() => void) | null = null;

  async start() {
    const set = useStore.setState;
    set({ voiceOpen: true, voiceStatus: "connecting", voiceError: null });
    this.stopping = false;
    try {
      const cfg = await (await fetch("/api/config")).json();
      const tr = await fetch("/api/voice/token", { method: "POST" });
      const tj = await tr.json();
      if (!tr.ok) throw new Error(tj.detail ?? "token request failed");
      const token = tj.value ?? tj.client_secret?.value ?? tj.secret ?? tj.token;
      if (!token) throw new Error(`unexpected token response: ${JSON.stringify(tj).slice(0, 120)}`);

      this.ctx = new AudioContext();
      await this.ctx.audioWorklet.addModule("/pcm-worklet.js");
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const mic = this.ctx.createMediaStreamSource(this.stream);
      const cap = new AudioWorkletNode(this.ctx, "pcm-capture");
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      mic.connect(cap).connect(mute).connect(this.ctx.destination); // keeps the worklet running
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.ctx.destination);

      const ws = new WebSocket(`wss://api.x.ai/v1/realtime?model=${encodeURIComponent(cfg.voice_model)}`, [`xai-client-secret.${token}`]);
      this.ws = ws;
      ws.onopen = () => {
        this.send({
          type: "session.update",
          session: {
            voice: cfg.voice,
            instructions: INSTRUCTIONS,
            turn_detection: { type: "server_vad" },
            audio: { input: { format: { type: "audio/pcm", rate: 24000 } }, output: { format: { type: "audio/pcm", rate: 24000 } } },
            tools: TOOLS,
          },
        });
        set({ voiceStatus: "listening" });
      };
      ws.onmessage = (ev) => typeof ev.data === "string" && this.onEvent(JSON.parse(ev.data));
      ws.onclose = (ev) => {
        if (!this.stopping) set({ voiceStatus: "error", voiceError: `Voice connection closed (${ev.code}${ev.reason ? ": " + ev.reason : ""})` });
        this.teardown();
      };
      cap.port.onmessage = (e) => {
        levels.mic = e.data.level;
        if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: "input_audio_buffer.append", audio: b64(e.data.pcm) });
      };
      this.unsub = onAlert((a) => {
        if (a.level === "info") return;
        this.pendingAlerts.push(`ALERT: ${a.title}. ${a.detail}`);
        this.flushAlerts();
      });
    } catch (e) {
      set({ voiceStatus: "error", voiceError: e instanceof Error ? e.message : String(e) });
      this.teardown();
    }
  }

  stop() {
    this.stopping = true;
    this.ws?.close();
    this.teardown();
    useStore.setState({ voiceStatus: "off", voiceOpen: false });
  }

  sendText(text: string) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    logVoice("user", text);
    this.stopPlayback();
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.send({ type: "response.create" });
  }

  private teardown() {
    this.unsub?.();
    this.unsub = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.sources = [];
    this.ws = null;
    this.responding = false;
    levels.mic = levels.out = 0;
  }

  private send(m: unknown) {
    this.ws?.send(JSON.stringify(m));
  }

  private flushAlerts() {
    if (this.responding || !this.pendingAlerts.length || this.ws?.readyState !== WebSocket.OPEN) return;
    const text = this.pendingAlerts.splice(0).join("\n");
    logVoice("sys", text);
    this.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
    this.send({ type: "response.create" });
    this.responding = true;
  }

  private onEvent(e: Record<string, any>) {
    const set = useStore.setState;
    switch (e.type) {
      case "input_audio_buffer.speech_started":
        this.stopPlayback();
        set({ voiceStatus: "listening" });
        break;
      case "input_audio_buffer.speech_stopped":
        set({ voiceStatus: "thinking" });
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (e.transcript) logVoice("user", e.transcript, `u-${e.item_id}`);
        break;
      case "response.created":
        this.responding = true;
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
        this.play(e.delta);
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        const id = `a-${e.response_id ?? e.item_id}`;
        const prev = useStore.getState().voiceLog.find((l) => l.id === id)?.text ?? "";
        logVoice("agent", prev + e.delta, id);
        break;
      }
      case "response.function_call_arguments.done": {
        let a: Record<string, unknown> = {};
        try {
          a = JSON.parse(e.arguments || "{}");
        } catch {
          /* leave empty */
        }
        logVoice("tool", `${e.name}(${Object.values(a).join(", ")})`);
        this.needResponse = true;
        runTool(e.name, a)
          .catch((err) => ({ error: String(err) }))
          .then((out) => {
            this.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: e.call_id, output: JSON.stringify(out) } });
            if (!this.responding && this.needResponse) {
              this.needResponse = false;
              this.send({ type: "response.create" });
            }
          });
        break;
      }
      case "response.done":
        this.responding = false;
        if (this.needResponse) {
          // Tool outputs are in; let the model continue. (If a tool is still running,
          // its .then sends this instead.)
          setTimeout(() => {
            if (this.needResponse && !this.responding) {
              this.needResponse = false;
              this.send({ type: "response.create" });
            }
          }, 50);
        } else if (!this.sources.length) set({ voiceStatus: "listening" });
        this.flushAlerts();
        break;
      case "error":
        logVoice("sys", e.error?.message ?? JSON.stringify(e).slice(0, 200));
        break;
    }
  }

  private play(b64data: string) {
    const ctx = this.ctx;
    if (!ctx || !this.analyser) return;
    const bin = atob(b64data);
    const n = bin.length >> 1;
    if (!n) return;
    const buf = ctx.createBuffer(1, n, 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      ch[i] = (v >= 0x8000 ? v - 0x10000 : v) / 32768;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.analyser);
    const at = Math.max(ctx.currentTime + 0.03, this.playHead);
    src.start(at);
    this.playHead = at + buf.duration;
    this.sources.push(src);
    useStore.setState({ voiceStatus: "speaking" });
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
      if (!this.sources.length && !this.responding) useStore.setState({ voiceStatus: "listening" });
    };
  }

  private stopPlayback() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    this.playHead = 0;
  }

  outLevel(): number {
    if (!this.analyser) return 0;
    const d = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(d);
    let sq = 0;
    for (const v of d) sq += ((v - 128) / 128) ** 2;
    return Math.sqrt(sq / d.length);
  }
}

export const agent = new VoiceAgent();
