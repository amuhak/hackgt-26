import { useEffect, useRef } from "react";

export function Sparkline({ values, color, width = 84, height = 24 }: { values: (number | null)[]; color: string; width?: number; height?: number }) {
  const v = values.filter((x): x is number => x != null);
  if (v.length < 2) return <svg width={width} height={height} />;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const span = hi - lo || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - ((x - lo) / span) * (height - 4)).toFixed(1)}`);
  const last = pts[pts.length - 1].split(",");
  return (
    <svg width={width} height={height} className="spark">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="2" fill={color} />
    </svg>
  );
}

export type Series = { label: string; color: string; values: (number | null)[] };

type ChartOpts = {
  t: number[];
  series: Series[];
  unit?: string;
  digits?: number;
  timeFmt?: (t: number) => string;
  zeroLine?: boolean;
};

function cssVar(el: Element, name: string) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Carbon-style line chart on a canvas: dashed grid, mono axis labels, last-value legend. */
export function drawChart(canvas: HTMLCanvasElement, o: ChartOpts) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const c = canvas.getContext("2d")!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, w, h);
  const grid = cssVar(canvas, "--border");
  const text = cssVar(canvas, "--text-3");
  const padL = 48, padR = 8, padT = 22, padB = 20;
  const pw = w - padL - padR, ph = h - padT - padB;

  let lo = Infinity, hi = -Infinity;
  for (const s of o.series) for (const v of s.values) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!isFinite(lo) || o.t.length < 2) {
    c.fillStyle = text;
    c.font = "12px 'IBM Plex Sans'";
    c.fillText("No data in this window", padL, padT + ph / 2);
    return;
  }
  if (o.zeroLine) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi - lo < 1e-9) { hi += 0.5; lo -= 0.5; }
  const padY = (hi - lo) * 0.08;
  lo -= padY; hi += padY;
  const t0 = o.t[0], t1 = o.t[o.t.length - 1];
  const X = (t: number) => padL + ((t - t0) / (t1 - t0 || 1)) * pw;
  const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * ph;

  c.font = "11px 'IBM Plex Mono'";
  c.lineWidth = 1;
  c.strokeStyle = grid;
  c.fillStyle = text;
  c.setLineDash([2, 3]);
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((hi - lo) * i) / 4;
    const y = Math.round(Y(v)) + 0.5;
    c.beginPath(); c.moveTo(padL, y); c.lineTo(w - padR, y); c.stroke();
    c.textAlign = "right";
    c.fillText(v.toFixed(o.digits ?? 1), padL - 6, y + 4);
  }
  c.setLineDash([]);
  c.textAlign = "left";
  const tf = o.timeFmt ?? ((t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  c.fillText(tf(t0), padL, h - 5);
  c.textAlign = "right";
  c.fillText(tf(t1), w - padR, h - 5);

  for (const s of o.series) {
    c.strokeStyle = s.color;
    c.lineWidth = 1.5;
    c.beginPath();
    let pen = false;
    for (let i = 0; i < o.t.length; i++) {
      const v = s.values[i];
      if (v == null) { pen = false; continue; }
      const x = X(o.t[i]), y = Y(v);
      if (pen) c.lineTo(x, y); else c.moveTo(x, y);
      pen = true;
    }
    c.stroke();
  }
  // Legend with last values, top-left.
  c.textAlign = "left";
  let lx = padL;
  c.font = "12px 'IBM Plex Sans'";
  for (const s of o.series) {
    const last = [...s.values].reverse().find((v) => v != null);
    const label = `${s.label} ${last != null ? last.toFixed(o.digits ?? 1) : "—"}${o.unit ? " " + o.unit : ""}`;
    c.fillStyle = s.color;
    c.fillRect(lx, 7, 8, 8);
    c.fillStyle = text;
    c.fillText(label, lx + 12, 15);
    lx += c.measureText(label).width + 26;
  }
}

export function LineChart(props: ChartOpts & { height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const draw = () => drawChart(el, props);
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return <canvas ref={ref} style={{ width: "100%", height: props.height ?? 180, display: "block" }} />;
}

/** Redraws every animation frame from a data source (live motion). */
export function LiveChart({ source, height = 150 }: { source: () => ChartOpts | null; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const src = useRef(source);
  src.current = source;
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < 33 || !ref.current) return; // 30 fps is plenty
      last = now;
      const o = src.current();
      if (o) drawChart(ref.current, o);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} style={{ width: "100%", height, display: "block" }} />;
}
