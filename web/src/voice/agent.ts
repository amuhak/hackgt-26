// Browser voice agent on Grok Voice (xAI realtime) or Gemini Live, switchable.
// The backend mints a short-lived token; audio goes straight between the browser
// and the provider. Tools run here: data tools call our backend, UI tools drive the store.
import { MAP_METRICS, METRICS, POS_LABEL, ago, linkState, type MetricKey } from "../metrics";
import { openChart, showProblem } from "../problem";
import { logVoice, useStore, type VoiceProvider, type VoiceProviderInfo } from "../store";
import type { NodeInfo } from "../types";
import { onAlert } from "../ws";
import { GeminiTransport, GrokTransport, type Handlers, type ToolDef, type Transport } from "./transports";

export const levels = { mic: 0, out: 0 };

const INSTRUCTIONS = `You are Tideline, the voice of a live console for a mesh of floating sensor buoys, demoed at HackGT on the Georgia Tech campus.

Each buoy is a small manta-ray-shaped hull with a water temperature probe, an air temperature and pressure sensor, a 50 Hz motion sensor and GPS. The buoys relay each other's data over an ESP-NOW radio mesh to a base station plugged into this laptop, so data from buoys out of range still arrives. Buoys in direct range of the base also stream live motion.

Buoys are named like "#1" and "#3"; say "buoy one", "buoy three". Those, in get_fleet_status's "buoys" list, are the real deployment.

There may also be a simulated fleet of hundreds of buoys off the Georgia coast (named C1, C2, ...), a demo of how the console scales. It is fake data: never report it as a problem, and leave it out of "is anything wrong" answers. Mention it only when asked about it, the coast, or the whole fleet's size.

How to talk:
- Speak in one or two short sentences. Lead with what matters; don't list every reading unless asked. Round sensibly: temperatures to one decimal, pressure to whole hectopascals, g to two decimals.
- Call tools silently: never say "let me check" or "I'll open that" first. After a UI action, confirm in a few words at most.
- Never guess numbers. Call a tool for any data question.
- Wave RMS is wave energy in g: under 0.02 g is calm, over 0.1 g is rough. Tilt is degrees from level. Yaw is relative, since there's no compass.
- Each buoy's "sensors" field says whether it is real hardware or a test board with simulated readings. Go by that field alone; mention it only when relevant.
- "change_last_minutes" is how much each reading moved recently. Open water barely changes: water temperature moving more than 2 C within 10 minutes (change or range), or pressure changing more than 2 hPa, is a problem worth raising (probe out of the water or handled, hot or cold inflow), even without an alert.
- When asked to show, open, or look at a buoy, call show_buoy. For "go back" or "show everything", call show_map.
- When the user is done ("bye", "thanks, that's all", "stop listening"), call end_session.
- When asked if anything is wrong: call get_recent_alerts and get_fleet_status, and check each buoy's change_last_minutes. If there's a problem, call show_problem for the most serious alert, or show_chart for something you found in the data yourself, then say what happened in one or two sentences. If nothing is wrong, say so. Info-level alerts (back online, GPS fix) are not problems on their own.
- A user message starting with "ALERT:" is from the monitoring system, not the user. Announce it in one calm sentence and offer to show the buoy.`;

const buoyParam = { buoy: { type: "string", description: 'Buoy name or id, e.g. "#1", "1", or "f4e618b4"' } };
const TOOLS: ToolDef[] = [
  { name: "get_fleet_status", description: "Current status and latest readings of every buoy.", parameters: { type: "object", properties: {} } },
  {
    name: "get_buoy_details",
    description: "Everything about one buoy: latest reading, sensor health, GPS, link, record counts.",
    parameters: { type: "object", properties: buoyParam, required: ["buoy"] },
  },
  {
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
  { name: "get_recent_alerts", description: "The most recent alerts from the monitoring system.", parameters: { type: "object", properties: {} } },
  {
    name: "show_buoy",
    description: "Open a buoy's page in the UI: its 3D model, live tilt and all its details.",
    parameters: { type: "object", properties: buoyParam, required: ["buoy"] },
  },
  {
    name: "show_map",
    description: "Go back to the fleet map, zoomed to fit the buoys here, or to the simulated Georgia coast fleet.",
    parameters: { type: "object", properties: { area: { type: "string", enum: ["here", "coast"], description: 'Default "here"' } } },
  },
  {
    name: "set_map_color",
    description: "Choose which metric colors the buoys on the map.",
    parameters: { type: "object", properties: { metric: { type: "string", enum: MAP_METRICS } }, required: ["metric"] },
  },
  {
    name: "set_theme",
    description: "Switch the UI between dark and light mode.",
    parameters: { type: "object", properties: { mode: { type: "string", enum: ["dark", "light"] } }, required: ["mode"] },
  },
  {
    name: "show_problem",
    description: "Open the buoy's history chart for an alert, with the moment it happened boxed in red.",
    parameters: { type: "object", properties: { alert_id: { type: "string", description: "id from get_recent_alerts" } }, required: ["alert_id"] },
  },
  {
    name: "show_chart",
    description: "Open a buoy's history chart for one metric and box a time span on it, e.g. a pressure drop found with get_trend.",
    parameters: {
      type: "object",
      properties: {
        ...buoyParam,
        metric: { type: "string", enum: ["water_c", "air_c", "pressure_hpa", "wave_rms_g", "tilt"] },
        from_minutes_ago: { type: "number", description: "Start of the span to box" },
        to_minutes_ago: { type: "number", description: "End of the span; 0 is now. Omit to box a single moment." },
        label: { type: "string", description: "Two or three words shown on the box" },
      },
      required: ["buoy", "metric", "from_minutes_ago", "label"],
    },
  },
  {
    name: "end_session",
    description: 'End this voice session and turn the microphone off, when the user is done ("bye", "that\'s all", "stop listening").',
    parameters: { type: "object", properties: {} },
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
    link: { direct: "direct to base, live motion", relayed: "relayed through the mesh", none: "none: not heard recently" }[linkState(n) ?? "none"],
    water_c: r?.water_c,
    air_c: r?.air_c,
    pressure_hpa: r?.pressure_hpa,
    wave_rms_g: r?.wave_rms_g,
    wave_peak_g: r?.wave_peak_g,
    tilt_deg: r?.tilt,
    position: `${POS_LABEL[n.pos.source]} ${n.pos.lat.toFixed(5)}, ${n.pos.lon.toFixed(5)}`,
    sensors: n.sim ? "simulated (test board, fake readings)" : "real hardware",
    change_last_minutes: n.change ?? undefined,
  };
}

/** A simulated fleet in a few numbers, so the agent isn't handed hundreds of buoys. */
function fleetBrief(name: string, ns: NodeInfo[]) {
  const stat = (k: "water_c" | "air_c" | "pressure_hpa" | "wave_rms_g") => {
    const v = ns.map((n) => n.latest?.[k]).filter((x): x is number => x != null);
    if (!v.length) return null;
    const r = (x: number) => Math.round(x * 1000) / 1000;
    return { min: r(Math.min(...v)), max: r(Math.max(...v)), mean: r(v.reduce((s, x) => s + x, 0) / v.length) };
  };
  return {
    name,
    simulated: true,
    note: "Fake demo data; never a problem to report.",
    buoys: ns.length,
    online: ns.filter((n) => n.status === "online").length,
    names: `${ns[0]?.name} to ${ns[ns.length - 1]?.name}`,
    water_c: stat("water_c"),
    air_c: stat("air_c"),
    pressure_hpa: stat("pressure_hpa"),
    wave_rms_g: stat("wave_rms_g"),
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
    case "get_fleet_status": {
      const all = Object.values(st.nodes);
      const groups = [...new Set(all.map((n) => n.group).filter((g): g is string => !!g))];
      return {
        buoys: all.filter((n) => !n.group).map(brief),
        simulated_fleets: groups.map((g) => fleetBrief(g, all.filter((n) => n.group === g))),
        base_receiving: st.collector?.receiving ?? false,
      };
    }
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
      return {
        alerts: st.alerts.slice(-15).map((x) => ({ id: x.id, level: x.level, buoy: x.name, title: x.title, detail: x.detail, ago: ago(Date.now() / 1000 - x.t) })),
      };
    case "show_problem": {
      const al = st.alerts.find((x) => x.id === a.alert_id);
      if (!al) return { error: `No alert "${a.alert_id}". Call get_recent_alerts for ids.` };
      return { ok: true, buoy: al.name, ...showProblem(al) };
    }
    case "show_chart": {
      const n = findBuoy(String(a.buoy));
      if (!n) return { error: `No buoy "${a.buoy}"` };
      const now = Date.now() / 1000;
      const from = now - Number(a.from_minutes_ago) * 60;
      const to = a.to_minutes_ago == null ? from : now - Number(a.to_minutes_ago) * 60;
      openChart({ node: n.id, metric: a.metric as MetricKey, from: Math.min(from, to), to: Math.max(from, to), label: String(a.label ?? "") });
      return { ok: true, showing: n.name };
    }
    case "show_buoy": {
      const n = findBuoy(String(a.buoy));
      if (!n) return { error: `No buoy "${a.buoy}"` };
      st.focus(n.id);
      setTimeout(() => useStore.getState().openNode(n.id), 450);
      return { ok: true, showing: n.name };
    }
    case "show_map": {
      st.openNode(null);
      const group = a.area === "coast" ? Object.values(st.nodes).find((n) => n.group)?.group ?? undefined : undefined;
      if (a.area === "coast" && !group) return { error: "No coast fleet is running (start the server with --coast 500)." };
      setTimeout(() => useStore.getState().focus(null, group), 60); // after the page's own zoom-out
      return { ok: true, showing: group ?? "buoys here" };
    }
    case "set_map_color":
      if (!(String(a.metric) in METRICS)) return { error: "unknown metric" };
      st.openNode(null);
      st.setMetric(a.metric as keyof typeof METRICS);
      return { ok: true };
    case "set_theme":
      st.setTheme(a.mode === "light" ? "light" : "dark");
      return { ok: true };
    case "end_session":
      return { ok: true, instruction: "Say a goodbye of a few words. The session closes when you finish speaking." };
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
  private t: Transport | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private playHead = 0;
  private responding = false;
  private pendingAlerts: string[] = [];
  private ending = 0; // failsafe timer once end_session is called
  private spokeSinceEnd = false;
  private unsub: (() => void) | null = null;
  private gen = 0; // bumps on every start/stop, so a stale session can't touch a newer one

  async start() {
    const set = useStore.setState;
    const gen = ++this.gen;
    const provider = useStore.getState().voiceProvider;
    set({ voiceOpen: true, voiceStatus: "connecting", voiceError: null });
    try {
      const cfg = await (await fetch("/api/config")).json();
      const p: VoiceProviderInfo | undefined = cfg.voice_providers?.[provider];
      if (!p?.available) throw new Error(provider === "gemini" ? "No Gemini key: put GEMINI_API_KEY=... in .env and restart the server." : "No xAI key: put XAI_API_KEY=... in .env and restart the server.");
      const tr = await fetch(`/api/voice/token?provider=${provider}`, { method: "POST" });
      const tj = await tr.json();
      if (!tr.ok) throw new Error(tj.detail ?? "token request failed");
      const token = tj.value ?? tj.client_secret?.value;
      if (!token) throw new Error(`unexpected token response: ${JSON.stringify(tj).slice(0, 120)}`);

      const ctx = new AudioContext();
      this.ctx = ctx;
      await ctx.audioWorklet.addModule("/pcm-worklet.js");
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (gen !== this.gen) return this.teardown();
      const mic = ctx.createMediaStreamSource(this.stream);
      const cap = new AudioWorkletNode(ctx, "pcm-capture");
      const mute = ctx.createGain();
      mute.gain.value = 0;
      mic.connect(cap).connect(mute).connect(ctx.destination); // keeps the worklet running
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(ctx.destination);

      const t: Transport = provider === "gemini" ? new GeminiTransport() : new GrokTransport();
      this.t = t;
      await t.open({ model: p.model, voice: p.voice, thinking: p.thinking, instructions: INSTRUCTIONS, tools: TOOLS, token }, this.handlers(gen));
      if (gen !== this.gen) return t.close();
      set({ voiceStatus: "listening" });
      cap.port.onmessage = (e) => {
        levels.mic = e.data.level;
        if (this.t === t) t.audio(b64(e.data.pcm));
      };
      this.unsub = onAlert((a) => {
        if (a.level === "info") return;
        this.pendingAlerts.push(`ALERT: ${a.title}. ${a.detail}`);
        this.flushAlerts();
      });
    } catch (e) {
      if (gen !== this.gen) return;
      set({ voiceStatus: "error", voiceError: e instanceof Error ? e.message : String(e) });
      this.teardown();
    }
  }

  stop() {
    this.gen++;
    clearTimeout(this.ending);
    this.ending = 0;
    this.t?.close();
    this.teardown();
    useStore.setState({ voiceStatus: "off", voiceOpen: false });
  }

  /** Switch provider; restarts the session if one is open. */
  setProvider(p: VoiceProvider) {
    const st = useStore.getState();
    if (st.voiceProvider === p) return;
    st.setVoiceProvider(p);
    if (st.voiceOpen) {
      this.stop();
      logVoice("sys", `Switched to ${p === "gemini" ? "Gemini Live" : "Grok Voice"}`);
      void this.start();
    }
  }

  sendText(text: string) {
    if (!this.t) return;
    logVoice("user", text);
    this.stopPlayback();
    this.t.text(text);
  }

  private handlers(gen: number): Handlers {
    const set = useStore.setState;
    const live = () => gen === this.gen;
    return {
      audio: (d) => {
        if (!live()) return;
        if (this.ending) this.spokeSinceEnd = true;
        this.play(d);
      },
      agentText: (text, key) => live() && logVoice("agent", text, key),
      userText: (text, key) => live() && logVoice("user", text, key),
      userSpeaking: () => {
        if (!live()) return;
        this.stopPlayback();
        set({ voiceStatus: "listening" });
      },
      userStopped: () => live() && set({ voiceStatus: "thinking" }),
      replying: () => {
        if (live()) this.responding = true;
      },
      toolCalls: (calls) => {
        if (!live()) return;
        for (const c of calls) {
          logVoice("tool", `${c.name}(${Object.values(c.args).join(", ")})`);
          if (c.name === "end_session" && !this.ending) this.ending = window.setTimeout(() => this.stop(), 10000);
        }
        Promise.all(calls.map((c) => runTool(c.name, c.args).catch((err) => ({ error: String(err) })))).then((outs) => {
          if (live()) this.t?.toolResults(calls.map((c, i) => ({ id: c.id, name: c.name, output: outs[i] })));
        });
      },
      turnDone: () => {
        if (!live()) return;
        this.responding = false;
        if (this.ending && this.spokeSinceEnd) {
          // The goodbye is out; hang up once it has finished playing.
          const quiet = () => (!live() ? undefined : this.sources.length ? setTimeout(quiet, 100) : this.stop());
          quiet();
          return;
        }
        if (!this.sources.length) set({ voiceStatus: "listening" });
        this.flushAlerts();
      },
      closed: (reason) => {
        if (!live()) return;
        if (reason) set({ voiceStatus: "error", voiceError: reason });
        this.teardown();
      },
      error: (msg) => live() && logVoice("sys", msg),
    };
  }

  private teardown() {
    this.unsub?.();
    this.unsub = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.analyser = null;
    this.sources = [];
    this.t = null;
    this.responding = false;
    this.spokeSinceEnd = false;
    this.pendingAlerts = [];
    levels.mic = levels.out = 0;
  }

  private flushAlerts() {
    if (this.responding || !this.pendingAlerts.length || !this.t) return;
    const text = this.pendingAlerts.splice(0).join("\n");
    logVoice("sys", text);
    this.t.text(text);
    this.responding = true;
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
