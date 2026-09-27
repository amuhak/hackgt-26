import { Radio } from "@carbon/icons-react";
import { useStore } from "../store";
import { MAP_METRICS, METRICS, RAMP_CSS, STATUS_LABEL, ago, fmt, fmtMetric, metricColor, metricRange, metricValue, valueColor, type MetricKey } from "../metrics";
import type { NodeInfo } from "../types";
import { Sparkline } from "./charts";
import { showProblem } from "../problem";

export function Dashboard({ faded }: { faded: boolean }) {
  const nodes = useStore((s) => s.nodes);
  const metric = useStore((s) => s.metric);
  const hovered = useStore((s) => s.hovered);
  const alerts = useStore((s) => s.alerts);
  const total = useStore((s) => s.readingsTotal);
  const all = Object.values(nodes);
  const list = all.filter((n) => !n.group).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const groups = new Map<string, NodeInfo[]>();
  for (const n of all) if (n.group) groups.set(n.group, [...(groups.get(n.group) ?? []), n]);
  const online = all.filter((n) => n.status === "online");
  const live = all.filter((n) => n.status !== "offline" && n.latest);

  const water = live.map((n) => n.latest!.water_c).filter((v): v is number => v != null);
  const waves = live
    .filter((n) => n.latest!.wave_peak_g != null)
    .sort((a, b) => b.latest!.wave_peak_g! - a.latest!.wave_peak_g!);
  const range = metricRange(metric);
  const perMin = all.reduce((s, n) => s + (n.status === "online" ? 60 / Math.max(n.interval_s, 1) : 0), 0);

  return (
    <div className={`dash ${faded ? "faded" : ""}`}>
      <div className="panel dash-left">
        <div className="panel-head">
          <span className="panel-title">Fleet overview</span>
          <span className="label mono">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        </div>
        <div className="kpis">
          <div className="kpi">
            <div className="label">Buoys online</div>
            <div className="kpi-val">
              {online.length}
              <small>/ {all.length}</small>
            </div>
            <div className="kpi-sub">{all.filter((n) => n.direct).length} in direct range of base</div>
          </div>
          <div className="kpi">
            <div className="label">Water temperature</div>
            <div className="kpi-val">
              {water.length ? fmt(water.reduce((a, b) => a + b, 0) / water.length) : "—"}
              <small>°C avg</small>
            </div>
            <div className="kpi-sub">{water.length > 1 ? `${fmt(Math.min(...water))} to ${fmt(Math.max(...water))} °C` : " "}</div>
          </div>
          <div className="kpi">
            <div className="label">Highest wave peak</div>
            <div className="kpi-val">
              {waves.length ? fmt(waves[0].latest!.wave_peak_g, 2) : "—"}
              <small>g</small>
            </div>
            <div className="kpi-sub">{waves.length ? `Buoy ${waves[0].name}` : " "}</div>
          </div>
          <div className="kpi">
            <div className="label">Readings stored</div>
            <div className="kpi-val">{total >= 10000 ? `${(total / 1000).toFixed(total >= 100000 ? 0 : 1)}k` : total}</div>
            <div className="kpi-sub">{Math.round(perMin)} per min incoming</div>
          </div>
        </div>
        <div className="node-list">
          {list.length === 0 && (
            <div className="empty">
              No buoys yet. Start the collector (<span className="mono">python server/app.py --serial COM5</span>) and readings will appear here.
            </div>
          )}
          {list.map((n) => (
            <NodeRow key={n.id} n={n} metric={metric} hot={hovered === n.id} />
          ))}
          {[...groups].map(([name, members]) => (
            <GroupRow key={name} name={name} members={members} metric={metric} />
          ))}
        </div>
      </div>

      <div className="dash-right">
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Color by</span>
          </div>
          <div className="metric-list">
            {MAP_METRICS.map((m) => (
              <button key={m} className={`metric-opt ${metric === m ? "on" : ""}`} onClick={() => useStore.getState().setMetric(m)}>
                {METRICS[m].label}
                <span className="label">{METRICS[m].unit}</span>
              </button>
            ))}
          </div>
          <div className="legend">
            <div className="label">{METRICS[metric].label}</div>
            <div className="legend-bar" style={{ background: RAMP_CSS }} />
            <div className="legend-scale mono">
              {metric === "age" ? (
                <>
                  <span>now</span>
                  <span>10 min</span>
                </>
              ) : (
                <>
                  <span>{fmt(range[0], METRICS[metric].digits)}</span>
                  <span>{fmt(range[1], METRICS[metric].digits)} {METRICS[metric].unit}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <span className="panel-title">Alerts</span>
            <span className="label">{alerts.length}</span>
          </div>
          <div className="alert-feed">
            {alerts.length === 0 && <div className="empty">All quiet.</div>}
            {[...alerts].reverse().slice(0, 12).map((a) => (
              <div key={a.id} className={`alert-item ${a.level}`} onClick={() => showProblem(a)}>
                <div className="bar" />
                <div>
                  <div className="at">{a.title}</div>
                  <div className="ad">
                    {a.detail ? `${a.detail} · ` : ""}
                    {ago(Date.now() / 1000 - a.t)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A simulated fleet as one row: its spread for the chosen metric; click to fly there. */
function GroupRow({ name, members, metric }: { name: string; members: NodeInfo[]; metric: MetricKey }) {
  const vals = members.map((n) => metricValue(n, metric)).filter((v): v is number => v != null);
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const online = members.filter((n) => n.status === "online").length;
  const d = METRICS[metric].digits;
  return (
    <button className="node-row group-row" style={{ ["--c" as string]: valueColor(metric, mean) }} onClick={() => useStore.getState().focus(null, name)}>
      <div className="swatch" />
      <div style={{ minWidth: 0 }}>
        <div className="nm">{name}</div>
        <div className="meta">
          <span>{members.length} buoys</span>
          <span>{online} online</span>
          <span>sim</span>
        </div>
      </div>
      <div className="val">
        {metric === "age" ? `${Math.round(mean ?? 0)} s` : fmt(mean, d)}
        <div className="label">avg {METRICS[metric].unit}</div>
      </div>
      <div className="group-span mono">{vals.length ? `${fmt(Math.min(...vals), d)} – ${fmt(Math.max(...vals), d)}` : ""}</div>
    </button>
  );
}

function NodeRow({ n, metric, hot }: { n: NodeInfo; metric: MetricKey; hot: boolean }) {
  const c = metricColor(n, metric);
  const spark = metric === "age" ? n.spark.water_c : n.spark[metric];
  return (
    <button
      className={`node-row ${hot ? "hot" : ""}`}
      style={{ ["--c" as string]: c }}
      onMouseEnter={() => useStore.getState().setHovered(n.id)}
      onMouseLeave={() => useStore.getState().setHovered(null)}
      onClick={() => {
        useStore.getState().focus(n.id);
        setTimeout(() => useStore.getState().openNode(n.id), 450);
      }}
    >
      <div className="swatch" />
      <div style={{ minWidth: 0 }}>
        <div className="nm">
          {n.name}
          {n.direct && <Radio size={14} style={{ color: "var(--accent)" }} />}
        </div>
        <div className="meta">
          <span className={`tag ${n.status}`}>{STATUS_LABEL[n.status]}</span>
          <span>{ago(n.age_s)}</span>
          {n.sim && <span>sim</span>}
        </div>
      </div>
      <div className="val">
        {fmtMetric(n, metric)}
        <div className="label">{METRICS[metric].unit}</div>
      </div>
      <Sparkline values={spark ?? []} color={c} />
    </button>
  );
}
