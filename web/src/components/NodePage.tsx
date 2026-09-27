import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { ArrowLeft, Close, Radio } from "@carbon/icons-react";
import { useStore } from "../store";
import { METRICS, POS_LABEL, STATUS_LABEL, ago, duration, fmt, type MetricKey } from "../metrics";
import { hasLive, recent } from "../motion";
import { F, type NodeInfo } from "../types";
import { BuoyScene, type Live } from "./BuoyScene";
import { LineChart, LiveChart, Sparkline } from "./charts";

const RANGES = [
  { label: "15 min", m: 15 },
  { label: "1 h", m: 60 },
  { label: "6 h", m: 360 },
  { label: "24 h", m: 1440 },
]; // keep in step with problem.ts
const HIST: MetricKey[] = ["water_c", "air_c", "pressure_hpa", "wave_rms_g", "tilt"];
const XYZ = ["#fa4d56", "#42be65", "#08bdba"];

type History = Record<string, (number | null)[]> & { t: number[] };

export function NodePage({ id }: { id: string }) {
  const n = useStore((s) => s.nodes[id]);
  const theme = useStore((s) => s.theme);
  const [detail, setDetail] = useState<{ records?: number; first_seen?: number }>({});
  const sink = useRef<(l: Live) => void>(() => {});
  const onFrame = useCallback((l: Live) => sink.current(l), []);
  const roll = n?.latest?.roll, pitch = n?.latest?.pitch;
  const fallback = useMemo(() => (roll != null && pitch != null ? { roll, pitch } : null), [roll, pitch]);

  useEffect(() => {
    fetch(`/api/nodes/${id}`)
      .then((r) => (r.ok ? r.json() : {}))
      .then(setDetail)
      .catch(() => {});
  }, [id, n?.latest?.seq]);

  if (!n) return <div className="node-page"><div className="empty">Unknown buoy {id}.</div></div>;

  return (
    <div className="node-page">
      <div className="stage">
        <BuoyScene node={id} theme={theme} fallback={fallback} onFrame={onFrame} />
        <div className="stage-top">
          <div>
            <button className="btn ghost" onClick={() => useStore.getState().openNode(null)}>
              <ArrowLeft size={16} /> Fleet map
            </button>
            <div className="stage-title">Buoy {n.name}</div>
            <div className="stage-sub">
              <span className={`tag ${n.status}`}>{STATUS_LABEL[n.status]}</span>
              {n.direct ? (
                <span className="tag accent">
                  <Radio size={12} /> Direct link · 50 Hz motion
                </span>
              ) : (
                <span className="tag">Relayed via mesh</span>
              )}
              {n.sim && <span className="tag">Simulated sensors</span>}
              <span className="label mono">{n.id}</span>
            </div>
          </div>
        </div>
        <div className="stage-bottom">
          <LiveOverlay id={id} n={n} sink={sink} />
          <div className="stage-legend">
            <div><i style={{ background: "#08bdba" }} />Acceleration, gravity removed</div>
            <div><i style={{ background: "#ff832b" }} />Buoy forward</div>
            <div><i style={{ background: "var(--text)" }} />Buoy up</div>
          </div>
        </div>
      </div>

      <div className="details">
        <Readings n={n} />
        <Health n={n} />
        <HistorySection id={id} n={n} />
        {n.direct ? <MotionSection id={id} /> : null}
        <Position n={n} />
        <Raw n={n} detail={detail} />
      </div>
    </div>
  );
}

function LiveOverlay({ id, n, sink }: { id: string; n: NodeInfo; sink: MutableRefObject<(l: Live) => void> }) {
  const [live, setLive] = useState<Live>({ sample: null, lin: 0 });
  useEffect(() => {
    sink.current = setLive;
  }, [sink]);
  const r = n.latest;
  const liveNow = !!live.sample && hasLive(id);
  const att = live.sample?.e ?? [r?.roll ?? 0, r?.pitch ?? 0, 0];
  return (
    <>
      {!liveNow && (
        <div className="no-live">No live motion: this buoy isn't in direct range of the base. Showing tilt from its last reading.</div>
      )}
      <div className="attitude">
        <Att label="Roll" v={att[0]} />
        <Att label="Pitch" v={att[1]} />
        <Att label="Yaw (rel.)" v={liveNow ? att[2] : null} />
        <div className="att">
          <div className="label">Accel (motion)</div>
          <div className="att-val">
            {liveNow ? live.lin.toFixed(2) : "—"}
            <small> g</small>
          </div>
        </div>
      </div>
    </>
  );
}

function Att({ label, v }: { label: string; v: number | null }) {
  return (
    <div className="att">
      <div className="label">{label}</div>
      <div className="att-val">
        {v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}`}
        <small>°</small>
      </div>
    </div>
  );
}

function Readings({ n }: { n: NodeInfo }) {
  const r = n.latest;
  const tiles: { k: MetricKey; v: number | null | undefined }[] = [
    { k: "water_c", v: r?.water_c },
    { k: "air_c", v: r?.air_c },
    { k: "pressure_hpa", v: r?.pressure_hpa },
    { k: "wave_rms_g", v: r?.wave_rms_g },
    { k: "wave_peak_g", v: r?.wave_peak_g },
    { k: "tilt", v: r?.tilt },
  ];
  return (
    <div className="section">
      <div className="section-head">
        <span className="section-title">Latest reading</span>
        <span className="label">
          #{r?.seq ?? "—"} · {ago(n.age_s)} · every {duration(n.interval_s)}
        </span>
      </div>
      <div className="tiles">
        {tiles.map(({ k, v }) => (
          <div key={k} className="tile">
            <div className="label">{METRICS[k].label}</div>
            <div className="tile-val">
              {fmt(v, METRICS[k].digits)}
              <small>{METRICS[k].unit}</small>
            </div>
            <Sparkline values={n.spark[k] ?? []} color="var(--accent)" width={150} height={22} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Health({ n }: { n: NodeInfo }) {
  const f = n.latest?.flags ?? 0;
  const items: [string, boolean][] = [
    ["Water probe (DS18B20)", !!(f & F.WATER)],
    ["Air/pressure (BMP280)", !!(f & F.BMP)],
    ["Motion (MPU6500)", !!(f & F.IMU)],
    ["GPS fix", !!(f & F.GPS_FIX)],
    ["GPS time", !!(f & F.GPS_TIME)],
  ];
  return (
    <div className="section">
      <div className="section-head">
        <span className="section-title">Sensor health</span>
        <span className="label">{n.latest?.sats ?? 0} satellites</span>
      </div>
      <div className="health">
        {items.map(([label, ok]) => (
          <span key={label} className={`tag ${ok ? "ok" : "bad"}`}>
            {ok ? "●" : "○"} {label}
          </span>
        ))}
      </div>
    </div>
  );
}

function HistorySection({ id, n }: { id: string; n: NodeInfo }) {
  const [range, setRange] = useState(60);
  const [metric, setMetric] = useState<MetricKey>("water_c");
  const [data, setData] = useState<History | null>(null);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const box = useStore((s) => (s.chartFocus?.node === id ? s.chartFocus : null));
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!box) return;
    setMetric(box.metric === "wave_peak_g" ? "wave_rms_g" : HIST.includes(box.metric) ? box.metric : "water_c");
    setRange(box.minutes);
    // Wait for the page to lay out (it may have just opened) before scrolling to the chart.
    const tm = setTimeout(() => el.current?.scrollIntoView({ behavior: "smooth", block: "center" }), 300);
    return () => clearTimeout(tm);
  }, [box?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let dead = false;
    const load = () =>
      fetch(`/api/nodes/${id}/history?minutes=${range}`)
        .then((r) => r.json())
        .then((d) => {
          if (dead) return;
          setData(d);
          setNow(Date.now() / 1000);
        })
        .catch(() => {});
    load();
    const iv = setInterval(load, Math.max(5000, n.interval_s * 1000));
    return () => {
      dead = true;
      clearInterval(iv);
    };
  }, [id, range, n.interval_s]);

  const series =
    metric === "wave_rms_g"
      ? [
          { label: "RMS", color: "#08bdba", values: data?.wave_rms_g ?? [] },
          { label: "Peak", color: "#ff832b", values: data?.wave_peak_g ?? [] },
        ]
      : metric === "tilt"
        ? [
            { label: "Pitch", color: "#08bdba", values: data?.pitch ?? [] },
            { label: "Roll", color: "#ff832b", values: data?.roll ?? [] },
          ]
        : [{ label: METRICS[metric].short, color: "#08bdba", values: data?.[metric] ?? [] }];
  return (
    <div className="section" ref={el}>
      <div className="section-head">
        <span className="section-title">History</span>
        {box && (
          <button className="tag bad box-tag" title="Clear highlight" onClick={() => useStore.setState({ chartFocus: null })}>
            {box.label} <Close size={12} />
          </button>
        )}
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r.m} className={range === r.m ? "on" : ""} onClick={() => setRange(r.m)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: "0 24px 8px" }}>
        <div className="seg">
          {HIST.map((m) => (
            <button key={m} className={metric === m ? "on" : ""} onClick={() => setMetric(m)}>
              {m === "wave_rms_g" ? "Waves" : METRICS[m].short}
            </button>
          ))}
        </div>
      </div>
      <div className="chart-box">
        <LineChart
          t={data?.t ?? []}
          series={series}
          unit={METRICS[metric].unit}
          digits={METRICS[metric].digits}
          height={200}
          tRange={[now - range * 60, now]}
          highlight={box}
        />
      </div>
    </div>
  );
}

function MotionSection({ id }: { id: string }) {
  const src = (which: "a" | "g") => () => {
    const s = recent(id, 8000);
    if (!s.length) return null;
    const t = s.map((x) => x.t / 1000);
    return {
      t,
      series: ["x", "y", "z"].map((ax, i) => ({ label: ax, color: XYZ[i], values: s.map((x) => x[which][i]) })),
      unit: which === "a" ? "g" : "°/s",
      digits: which === "a" ? 2 : 1,
      zeroLine: true,
      timeFmt: (v: number) => `${(v - t[t.length - 1]).toFixed(0)} s`,
    };
  };
  return (
    <div className="section">
      <div className="section-head">
        <span className="section-title">Live motion</span>
        <span className="label">50 Hz, last 8 s, buoy axes (x fwd, y left, z up)</span>
      </div>
      <div className="chart-box">
        <div className="label" style={{ marginBottom: 4 }}>Acceleration</div>
        <LiveChart source={src("a")} height={140} />
        <div className="label" style={{ margin: "12px 0 4px" }}>Rotation rate</div>
        <LiveChart source={src("g")} height={140} />
      </div>
    </div>
  );
}

function Position({ n }: { n: NodeInfo }) {
  const p = n.pos;
  return (
    <div className="section">
      <div className="section-head">
        <span className="section-title">Position</span>
        <span className={`tag ${p.source === "gps" ? "ok" : ""}`}>{POS_LABEL[p.source]}</span>
      </div>
      <div className="kv">
        <div>Latitude</div>
        <div>{p.lat.toFixed(6)}</div>
        <div>Longitude</div>
        <div>{p.lon.toFixed(6)}</div>
        {p.fix_t ? (
          <>
            <div>Fix taken</div>
            <div>{new Date(p.fix_t * 1000).toLocaleString()}</div>
          </>
        ) : null}
        <div>Satellites</div>
        <div>{n.latest?.sats ?? 0}</div>
      </div>
    </div>
  );
}

function Raw({ n, detail }: { n: NodeInfo; detail: { records?: number; first_seen?: number } }) {
  const r = n.latest;
  if (!r) return null;
  const rows: [string, string][] = [
    ["Buoy id", n.id],
    ["Sequence", String(r.seq)],
    ["Records in DB", detail.records != null ? detail.records.toLocaleString() : "—"],
    ["First seen", detail.first_seen ? new Date(detail.first_seen * 1000).toLocaleString() : "—"],
    ["Sampled at", new Date(r.t * 1000).toLocaleString()],
    ["Received at", new Date(r.received_at * 1000).toLocaleString()],
    ["GPS time", r.gps_time ? new Date(r.gps_time * 1000).toISOString() : "none"],
    ["Uptime", duration(r.uptime_s)],
    ["Flags", `0x${r.flags.toString(16).padStart(2, "0")}`],
    ["Pitch / roll", `${fmt(r.pitch, 2)}° / ${fmt(r.roll, 2)}°`],
  ];
  return (
    <div className="section" style={{ borderBottom: 0 }}>
      <div className="section-head">
        <span className="section-title">Record</span>
      </div>
      <div className="kv">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <div>{k}</div>
            <div>{v}</div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
