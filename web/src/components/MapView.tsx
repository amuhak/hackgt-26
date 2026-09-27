import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Add, CenterToFit, Location, Subtract } from "@carbon/icons-react";
import { useStore } from "../store";
import { METRICS, POS_LABEL, STATUS_LABEL, ago, fmt, metricColor } from "../metrics";
import type { NodeInfo } from "../types";
import { Sparkline } from "./charts";

const STYLES = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
};

type Props = { onInteract: () => void };

export function MapView({ onInteract }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef(new Map<string, { m: maplibregl.Marker; el: HTMLDivElement }>());
  const [ready, setReady] = useState(false);
  const [, setTick] = useState(0); // re-render hover card on map move
  const [failed, setFailed] = useState(false);
  const fitted = useRef(false);

  const nodes = useStore((s) => s.nodes);
  const collector = useStore((s) => s.collector);
  const theme = useStore((s) => s.theme);
  const metric = useStore((s) => s.metric);
  const hovered = useStore((s) => s.hovered);
  const placing = useStore((s) => s.placing);
  const focusRequest = useStore((s) => s.focusRequest);
  const selected = useStore((s) => s.selected);

  // ---- map lifecycle ----
  useEffect(() => {
    const map = new maplibregl.Map({
      container: el.current!,
      style: STYLES[useStore.getState().theme],
      center: [-84.39735, 33.77541],
      zoom: 16,
      pitch: 30,
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    (window as unknown as { __map: maplibregl.Map }).__map = map; // handy from the console
    map.on("load", () => setReady(true));
    map.on("error", (e: maplibregl.ErrorEvent) => {
      if (!map.isStyleLoaded() && String(e.error?.message ?? "").match(/fetch|style|network/i)) setFailed(true);
    });
    map.on("move", () => setTick((t) => t + 1));
    const touched = (e: { originalEvent?: unknown }) => e.originalEvent && onInteract();
    map.on("movestart", touched);
    map.on("move", touched);
    map.getCanvasContainer().addEventListener("pointerdown", onInteract);
    return () => map.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const styleUrl = useRef(STYLES[useStore.getState().theme]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || styleUrl.current === STYLES[theme]) return;
    styleUrl.current = STYLES[theme];
    map.setStyle(STYLES[theme]);
  }, [theme, ready]);

  // ---- collector -> direct-range links ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !collector) return;
    const features = Object.values(nodes)
      .filter((n) => n.direct)
      .map((n) => ({
        type: "Feature" as const,
        properties: {},
        geometry: { type: "LineString" as const, coordinates: [[collector.pos.lon, collector.pos.lat], [n.pos.lon, n.pos.lat]] },
      }));
    const data = { type: "FeatureCollection" as const, features };
    const apply = () => {
      const src = map.getSource("links") as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
        return;
      }
      map.addSource("links", { type: "geojson", data });
      map.addLayer({ id: "links-glow", type: "line", source: "links", paint: { "line-color": "#08bdba", "line-width": 6, "line-opacity": 0.15, "line-blur": 4 } });
      map.addLayer({ id: "links", type: "line", source: "links", paint: { "line-color": "#08bdba", "line-width": 1.5, "line-dasharray": [2, 2] } });
    };
    // Adding layers while a style is still loading can stall it, so wait for style.load.
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
    return () => {
      map.off("style.load", apply);
    };
  }, [nodes, collector, ready, theme]);

  // ---- markers ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const all: (NodeInfo | { id: string; kind: "collector"; pos: NodeInfo["pos"] })[] = [...Object.values(nodes)];
    if (collector) all.push({ id: "__base", kind: "collector", pos: collector.pos });
    const seen = new Set<string>();
    for (const n of all) {
      seen.add(n.id);
      let entry = markers.current.get(n.id);
      if (!entry) {
        const div = document.createElement("div");
        div.className = "mk";
        if (n.kind === "collector") {
          div.innerHTML = `<div class="mk-base"><svg width="12" height="12" viewBox="0 0 32 32" fill="currentColor"><path d="M16 4a12 12 0 0 0-8.5 20.5l1.4-1.4a10 10 0 1 1 14.2 0l1.4 1.4A12 12 0 0 0 16 4Zm0 5a7 7 0 0 0-5 11.9l1.5-1.4a5 5 0 1 1 7 0l1.5 1.4A7 7 0 0 0 16 9Zm0 5a2 2 0 1 0 2 2 2 2 0 0 0-2-2Z"/></svg></div><div class="mk-label">BASE</div>`;
        } else {
          div.innerHTML = `<div class="mk-halo"></div><div class="mk-ring"></div><div class="mk-dot"></div><div class="mk-label"></div>`;
          div.addEventListener("mouseenter", () => useStore.getState().setHovered(n.id));
          div.addEventListener("mouseleave", () => useStore.getState().setHovered(null));
          div.addEventListener("click", (e) => {
            e.stopPropagation();
            if (useStore.getState().placing) return;
            open(n.id);
          });
        }
        const m = new maplibregl.Marker({ element: div, anchor: "center" }).setLngLat([n.pos.lon, n.pos.lat]).addTo(map);
        m.on("dragend", () => {
          const ll = m.getLngLat();
          const id = n.kind === "collector" ? useStore.getState().collector?.id : n.id;
          if (id) fetch(`/api/nodes/${id}/position`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat: ll.lat, lon: ll.lng }) });
        });
        entry = { m, el: div };
        markers.current.set(n.id, entry);
      }
      if (!entry.m.isDraggable()) entry.m.setLngLat([n.pos.lon, n.pos.lat]);
      entry.m.setDraggable(placing);
      if (n.kind === "collector") {
        entry.el.querySelector(".mk-base")!.classList.toggle("rx", !!collector?.receiving);
        continue;
      }
      const node = n as NodeInfo;
      entry.el.style.setProperty("--c", metricColor(node, metric));
      entry.el.classList.toggle("approx", node.pos.source === "default");
      entry.el.classList.toggle("dead", node.status === "offline");
      entry.el.classList.toggle("direct", node.direct);
      entry.el.classList.toggle("hot", hovered === node.id);
      entry.el.querySelector(".mk-label")!.textContent = node.name;
    }
    for (const [id, e] of markers.current) {
      if (!seen.has(id)) {
        e.m.remove();
        markers.current.delete(id);
      }
    }
  }, [nodes, collector, metric, hovered, placing]);

  // Pulse a marker when its buoy reports.
  useEffect(() => {
    const onReading = (e: Event) => {
      const ring = markers.current.get((e as CustomEvent).detail)?.el.querySelector(".mk-ring");
      if (!ring) return;
      ring.classList.remove("go");
      void (ring as HTMLElement).offsetWidth;
      ring.classList.add("go");
    };
    window.addEventListener("reading", onReading);
    return () => window.removeEventListener("reading", onReading);
  }, []);

  // ---- camera ----
  const fitAll = (animate = true) => {
    const map = mapRef.current;
    const pts = Object.values(useStore.getState().nodes).map((n) => [n.pos.lon, n.pos.lat] as [number, number]);
    const c = useStore.getState().collector;
    if (c) pts.push([c.pos.lon, c.pos.lat]);
    if (!map || !pts.length) return;
    const b = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    const wide = window.innerWidth > 900;
    map.fitBounds(b, {
      padding: wide ? { left: 440, right: 320, top: 80, bottom: 80 } : { left: 40, right: 40, top: 40, bottom: 300 },
      maxZoom: 17.5,
      pitch: 30,
      duration: animate ? 1200 : 0,
    });
  };

  useEffect(() => {
    if (ready && !fitted.current && Object.keys(nodes).length) {
      fitted.current = true;
      fitAll(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, nodes]);

  const open = (id: string) => {
    const n = useStore.getState().nodes[id];
    const map = mapRef.current;
    if (n && map) map.flyTo({ center: [n.pos.lon, n.pos.lat], zoom: 18.5, pitch: 55, duration: 900 });
    setTimeout(() => useStore.getState().openNode(id), 450);
  };

  useEffect(() => {
    if (!focusRequest) return;
    if (focusRequest.id) {
      const n = useStore.getState().nodes[focusRequest.id];
      if (n) mapRef.current?.flyTo({ center: [n.pos.lon, n.pos.lat], zoom: 18, pitch: 45, duration: 1000 });
    } else fitAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest]);

  // Back from a node page: zoom out to the fleet again.
  const wasSelected = useRef(selected);
  useEffect(() => {
    if (wasSelected.current && !selected) fitAll();
    wasSelected.current = selected;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const hn = hovered ? nodes[hovered] : null;
  let card = null;
  if (hn && mapRef.current && !placing) {
    const p = mapRef.current.project([hn.pos.lon, hn.pos.lat]);
    const w = el.current?.clientWidth ?? 0;
    const left = p.x + 300 > w ? p.x - 300 : p.x + 20;
    card = <HoverCard n={hn} style={{ left, top: Math.max(8, p.y - 60) }} />;
  }

  return (
    <>
      {failed && <div className="map-fallback" />}
      <div ref={el} className="map" />
      {card}
      <div className="map-tools">
        <button className="icon-btn" title="Zoom in" onClick={() => mapRef.current?.zoomIn()}><Add size={20} /></button>
        <button className="icon-btn" title="Zoom out" onClick={() => mapRef.current?.zoomOut()}><Subtract size={20} /></button>
        <button className="icon-btn" title="Fit fleet" onClick={() => fitAll()}><CenterToFit size={20} /></button>
        <button className={`icon-btn ${placing ? "on" : ""}`} title="Place buoys (drag to set position)" onClick={() => useStore.getState().setPlacing(!placing)}>
          <Location size={20} />
        </button>
      </div>
      {placing && <PlaceBar />}
    </>
  );
}

function HoverCard({ n, style }: { n: NodeInfo; style: React.CSSProperties }) {
  const metric = useStore((s) => s.metric);
  const r = n.latest;
  const c = metricColor(n, metric);
  const sparkKey = metric === "age" || metric === "pressure_hpa" ? "water_c" : metric;
  return (
    <div className="hover-card" style={{ ...style, ["--c" as string]: c }}>
      <div className="hc-head">
        <div>
          <div className="hc-name">Buoy {n.name}</div>
          <div className="label mono">{n.id}</div>
        </div>
        <span className={`tag ${n.status}`}>{STATUS_LABEL[n.status]}</span>
      </div>
      <div className="hc-grid">
        <Cell label="Water" v={fmt(r?.water_c)} u="°C" />
        <Cell label="Air" v={fmt(r?.air_c)} u="°C" />
        <Cell label="Waves RMS" v={fmt(r?.wave_rms_g, 3)} u="g" />
        <Cell label="Tilt" v={fmt(r?.tilt)} u="°" />
      </div>
      <div style={{ padding: "8px 16px 4px" }}>
        <div className="label">{METRICS[sparkKey as keyof typeof METRICS]?.label ?? "Water temperature"}, last {n.spark.t?.length ?? 0} readings</div>
        <Sparkline values={n.spark[sparkKey] ?? []} color={c} width={248} height={34} />
      </div>
      <div className="hc-foot">
        {ago(n.age_s)} · {n.direct ? "direct link" : "via mesh"} · {POS_LABEL[n.pos.source]}
        {n.sim ? " · simulated sensors" : ""}
      </div>
    </div>
  );
}

function Cell({ label, v, u }: { label: string; v: string; u: string }) {
  return (
    <div className="hc-cell">
      <div className="label">{label}</div>
      <div className="hc-val">
        {v} <span className="muted" style={{ fontSize: 12 }}>{u}</span>
      </div>
    </div>
  );
}

function PlaceBar() {
  const nodes = useStore((s) => s.nodes);
  const pinned = Object.values(nodes).filter((n) => n.pos.source === "pinned");
  const unpin = (id: string) =>
    fetch(`/api/nodes/${id}/position`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  return (
    <div className="place-bar">
      <span>Drag buoys or the base to where they are. Saved to server/fleet.json.</span>
      {pinned.map((n) => (
        <button key={n.id} className="btn small" onClick={() => unpin(n.id)}>Unpin {n.name}</button>
      ))}
      <button className="btn small" onClick={() => useStore.getState().setPlacing(false)}>Done</button>
    </div>
  );
}
