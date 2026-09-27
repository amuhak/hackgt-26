"""Tideline backend: serves the web UI, tails the SQLite DB that tools/collector.py
writes, and pushes live readings, motion and alerts to browsers over a WebSocket.
It also mints short-lived xAI tokens, so the browser's voice agent never sees the key.

    python server/app.py                  # read buoy.db; run tools/collector.py yourself
    python server/app.py --serial COM5    # also run the collector on COM5
    python server/app.py --sim-fleet 8    # add 8 fake buoys around campus (demo padding)

Node names and pinned positions live in server/fleet.json; the UI's "Place" mode edits it.
The xAI key goes in .env at the repo root: XAI_API_KEY=...
"""
import argparse
import asyncio
import atexit
import json
import math
import os
import random
import sqlite3
import statistics
import subprocess
import sys
import threading
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import collector  # noqa: E402  (DB schema and record flag bits)

FLEET_PATH = ROOT / "server" / "fleet.json"
DIST = ROOT / "web" / "dist"
XAI_SECRETS_URL = "https://api.x.ai/v1/realtime/client_secrets"

READING_COLS = ["origin", "seq", "gps_time", "uptime_s", "lat", "lon", "water_c", "air_c", "pressure_hpa",
                "wave_rms_g", "wave_peak_g", "pitch", "roll", "sats", "flags", "received_at"]
METRICS = ["water_c", "air_c", "pressure_hpa", "wave_rms_g", "wave_peak_g", "tilt", "pitch", "roll", "sats"]
SPARK_METRICS = ["water_c", "air_c", "pressure_hpa", "wave_rms_g", "wave_peak_g", "tilt"]

DIRECT_LINK_S = 3        # motion heard this recently = buoy is in the collector's direct range
OFFLINE_S = 600
WAVE_PEAK_ALERT_G = 0.5
TILT_ALERT_DEG = 30
CAPSIZE_DEG = 70
IMPACT_G = 1.2
WATER_JUMP_C = 1.5

args = None
fleet = {}
nodes = {}               # id -> Node
alerts = deque(maxlen=100)
clients = set()
state = {"last_r": 0, "last_m": 0, "activity_at": 0.0, "readings_total": 0}
db_lock = threading.Lock()
db = None
collector_proc = None


def load_env():
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() and v.strip() and not k.strip().startswith("#"):
                os.environ.setdefault(k.strip(), v.strip().strip('"'))


def save_fleet():
    FLEET_PATH.write_text(json.dumps(fleet, indent=2) + "\n")


def q(sql, params=()):
    with db_lock:
        return db.execute(sql, params).fetchall()


def to_reading(row) -> dict:
    r = dict(zip(READING_COLS, row))
    if r["pitch"] is not None and r["roll"] is not None:
        p, ro = math.radians(r["pitch"]), math.radians(r["roll"])
        r["tilt"] = round(math.degrees(math.acos(max(-1.0, min(1.0, math.cos(p) * math.cos(ro))))), 2)
    else:
        r["tilt"] = None
    return r


def assign_times(rows):
    """Sample time for each reading (ascending seq): GPS time when the buoy had one, else
    boot time + uptime, with boot time taken from the least-delayed delivery in that boot."""
    start = 0
    boot = None
    for i in range(1, len(rows) + 1):
        if i == len(rows) or rows[i]["uptime_s"] < rows[i - 1]["uptime_s"]:
            seg = rows[start:i]
            boot = min(r["received_at"] - r["uptime_s"] for r in seg)
            for r in seg:
                r["t"] = r["gps_time"] or boot + r["uptime_s"]
            start = i
    return boot


class Node:
    def __init__(self, nid: str, virtual=False):
        self.id = nid
        self.virtual = virtual
        self.latest = None
        self.recent = deque(maxlen=2000 if virtual else 120)
        self.fix = None            # (lat, lon, unix time) of the last real GPS fix
        self.boot = None
        self.last_uptime = None
        self.motion_at = 0.0
        self.attitude = None       # (roll, pitch, yaw) from the last motion sample
        self.status_was = None
        self.throttle = {}         # alert kind -> last time raised
        self.sim_name = None

    @property
    def name(self):
        return fleet.get("nodes", {}).get(self.id, {}).get("name") or self.sim_name or self.id[-4:]

    def stamp(self, r):
        up, rx = r["uptime_s"], r["received_at"]
        if self.boot is None or self.last_uptime is None or up < self.last_uptime:
            self.boot = rx - up
        else:
            self.boot = min(self.boot, rx - up)
        self.last_uptime = up
        r["t"] = r["gps_time"] or self.boot + up

    def add(self, r, live=True):
        prev = self.latest
        if live:
            self.stamp(r)
        self.latest = r
        self.recent.append(r)
        if r["flags"] & collector.F_GPS_FIX and not r["flags"] & collector.F_SIM:
            self.fix = (r["lat"], r["lon"], r["t"])
        if live and not self.virtual:
            reading_alerts(self, prev, r)

    def interval(self):
        ts = [r["t"] for r in list(self.recent)[-20:]]
        diffs = [b - a for a, b in zip(ts, ts[1:]) if b > a]
        return statistics.median(diffs) if diffs else 30.0

    def status(self, now):
        if not self.latest:
            return "unknown"
        age = now - self.latest["received_at"]
        if age < max(3 * self.interval(), 20) + 10:
            return "online"
        return "stale" if age < OFFLINE_S else "offline"

    def position(self):
        cfg = fleet.get("nodes", {}).get(self.id, {})
        if cfg.get("pos"):
            return {"lat": cfg["pos"][0], "lon": cfg["pos"][1], "source": "pinned"}
        if self.fix:
            fresh = self.latest and self.latest["flags"] & collector.F_GPS_FIX
            return {"lat": self.fix[0], "lon": self.fix[1], "source": "gps" if fresh else "last_fix",
                    "fix_t": self.fix[2]}
        return default_position(self.id)

    def to_json(self, now=None):
        now = now or time.time()
        spark = {m: [r.get(m) for r in list(self.recent)[-60:]] for m in SPARK_METRICS}
        spark["t"] = [r["t"] for r in list(self.recent)[-60:]]
        return {
            "id": self.id, "name": self.name, "kind": "buoy", "virtual": self.virtual,
            "sim": bool(self.latest and self.latest["flags"] & collector.F_SIM),
            "status": self.status(now), "direct": now - self.motion_at < DIRECT_LINK_S,
            "age_s": round(now - self.latest["received_at"], 1) if self.latest else None,
            "interval_s": round(self.interval(), 1), "latest": self.latest, "pos": self.position(),
            "attitude": self.attitude, "spark": spark,
        }


def default_position(nid: str):
    """No fix and nothing pinned: park it on a ring around the map center, spread by id."""
    lat0, lon0 = fleet["center"]
    h = int(nid, 16) if all(c in "0123456789abcdef" for c in nid) else hash(nid)
    ang = math.radians(h % 360)
    dist = 90 + (h >> 9) % 120  # meters
    return {"lat": lat0 + dist * math.cos(ang) / 111320,
            "lon": lon0 + dist * math.sin(ang) / (111320 * math.cos(math.radians(lat0))), "source": "default"}


def collector_json(now):
    cfg = fleet.get("collector", {})
    pos = cfg.get("pos") or [fleet["center"][0] - 0.0005, fleet["center"][1] + 0.0003]  # just off center
    return {"id": cfg.get("id"), "name": cfg.get("name", "Base"), "kind": "collector",
            "pos": {"lat": pos[0], "lon": pos[1], "source": "pinned" if cfg.get("pos") else "default"},
            "receiving": now - state["activity_at"] < 15,
            "activity_age_s": round(now - state["activity_at"], 1) if state["activity_at"] else None,
            "serial": args.serial if collector_proc and collector_proc.poll() is None else None}


# ---- alerts ----------------------------------------------------------------

def raise_alert(node, kind, level, title, detail="", every=0.0):
    now = time.time()
    if every and now - node.throttle.get(kind, 0) < every:
        return None
    node.throttle[kind] = now
    a = {"id": f"{node.id}-{kind}-{int(now * 1000)}", "t": now, "level": level, "node": node.id,
         "name": node.name, "kind": kind, "title": title, "detail": detail}
    alerts.append(a)
    pending_events.append({"type": "alert", "alert": a})
    return a


SENSORS = [(collector.F_WATER_OK, "water temperature sensor"), (collector.F_BMP_OK, "air/pressure sensor"),
           (collector.F_IMU_OK, "motion sensor")]


def reading_alerts(n, prev, r):
    nm = f"Buoy {n.name}"
    if r["wave_peak_g"] is not None and r["wave_peak_g"] > WAVE_PEAK_ALERT_G:
        raise_alert(n, "waves", "warning", f"{nm}: rough water",
                    f"Wave peak {r['wave_peak_g']:.2f} g (RMS {r['wave_rms_g']:.2f} g)", every=60)
    if r["tilt"] is not None and r["tilt"] > TILT_ALERT_DEG:
        raise_alert(n, "tilt", "warning", f"{nm} is tilted {r['tilt']:.0f} degrees",
                    f"Pitch {r['pitch']:.1f}, roll {r['roll']:.1f}", every=120)
    if prev is None:
        return
    if prev["water_c"] is not None and r["water_c"] is not None and abs(r["water_c"] - prev["water_c"]) > WATER_JUMP_C:
        raise_alert(n, "water_jump", "warning", f"{nm}: water temperature jumped",
                    f"{prev['water_c']:.1f} to {r['water_c']:.1f} C", every=60)
    for bit, what in SENSORS:
        if prev["flags"] & bit and not r["flags"] & bit:
            raise_alert(n, f"sensor{bit}", "critical", f"{nm}: {what} stopped responding")
        elif r["flags"] & bit and not prev["flags"] & bit:
            raise_alert(n, f"sensor{bit}", "info", f"{nm}: {what} is back")
    if not r["flags"] & collector.F_SIM:
        if r["flags"] & collector.F_GPS_FIX and not prev["flags"] & collector.F_GPS_FIX:
            raise_alert(n, "gps", "info", f"{nm} got a GPS fix", f"{r['sats']} satellites")
        elif prev["flags"] & collector.F_GPS_FIX and not r["flags"] & collector.F_GPS_FIX:
            raise_alert(n, "gps", "info", f"{nm} lost its GPS fix")


def motion_alerts(n, row):
    _, _, ax, ay, az, _, _, _, qw, qx, qy, qz, roll, pitch, _ = row
    if abs(roll) > CAPSIZE_DEG or abs(pitch) > CAPSIZE_DEG:
        raise_alert(n, "capsize", "critical", f"Buoy {n.name} may have capsized",
                    f"Roll {roll:.0f}, pitch {pitch:.0f} degrees", every=60)
    # Acceleration in world frame minus gravity: shakes and knocks.
    wx, wy, wz = rotate((qw, qx, qy, qz), (ax, ay, az))
    lin = math.sqrt(wx * wx + wy * wy + (wz - 1) ** 2)
    if lin > IMPACT_G:
        raise_alert(n, "impact", "warning", f"Buoy {n.name}: impact detected", f"{lin:.1f} g jolt", every=30)


def rotate(qt, v):
    w, x, y, z = qt
    vx, vy, vz = v
    tx, ty, tz = 2 * (y * vz - z * vy), 2 * (z * vx - x * vz), 2 * (x * vy - y * vx)
    return (vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx)


def status_alerts(now):
    for n in nodes.values():
        s = n.status(now)
        if n.status_was in ("online",) and s in ("stale", "offline"):
            raise_alert(n, "offline", "critical", f"Buoy {n.name} went silent",
                        f"Last heard {now - n.latest['received_at']:.0f} s ago")
            pending_nodes.add(n.id)
        elif n.status_was in ("stale", "offline") and s == "online":
            raise_alert(n, "offline", "info", f"Buoy {n.name} is back online")
        n.status_was = s


# ---- DB tailing ------------------------------------------------------------

pending_events = []
pending_nodes = set()


def get_node(nid, virtual=False):
    if nid not in nodes:
        nodes[nid] = Node(nid, virtual)
    return nodes[nid]


def init_from_db():
    for (origin,) in q("SELECT DISTINCT origin FROM readings"):
        rows = [to_reading(r) for r in q(f"SELECT {','.join(c for c in DB_COLS)} FROM readings WHERE origin=? "
                                         "ORDER BY seq DESC LIMIT 120", (origin,))][::-1]
        n = get_node(origin)
        n.boot = assign_times(rows)
        for r in rows:
            n.add(r, live=False)
        n.last_uptime = rows[-1]["uptime_s"]
        fix = q("SELECT lat, lon, gps_time, received_at FROM readings WHERE origin=? AND flags & 8 AND NOT flags & 128 "
                "ORDER BY seq DESC LIMIT 1", (origin,))
        if fix:
            n.fix = (fix[0][0], fix[0][1], fix[0][2] or fix[0][3])
        n.status_was = n.status(time.time())
    state["last_r"] = q("SELECT COALESCE(MAX(rowid), 0) FROM readings")[0][0]
    state["last_m"] = q("SELECT COALESCE(MAX(rowid), 0) FROM motion")[0][0]
    state["readings_total"] = q("SELECT COUNT(*) FROM readings")[0][0]


DB_COLS = ["origin", "seq", "gps_time", "uptime_s", "lat", "lon", "water_temp_c", "air_temp_c", "pressure_hpa",
           "wave_rms_g", "wave_peak_g", "pitch_deg", "roll_deg", "sats", "flags", "received_at"]


def poll_db():
    rows = q(f"SELECT rowid, {','.join(DB_COLS)} FROM readings WHERE rowid > ? ORDER BY rowid LIMIT 5000",
             (state["last_r"],))
    for row in rows:
        state["last_r"] = row[0]
        r = to_reading(row[1:])
        get_node(r["origin"]).add(r)
        pending_nodes.add(r["origin"])
        state["readings_total"] += 1
    mot = q("SELECT rowid, origin, t_ms, ax_g, ay_g, az_g, gx_dps, gy_dps, gz_dps, qw, qx, qy, qz, "
            "roll_deg, pitch_deg, yaw_deg FROM motion WHERE rowid > ? ORDER BY rowid LIMIT 5000", (state["last_m"],))
    by_node = {}
    now = time.time()
    for row in mot:
        state["last_m"] = row[0]
        by_node.setdefault(row[1], []).append(row[1:])
    for origin, rs in by_node.items():
        n = get_node(origin)
        was_direct = now - n.motion_at < DIRECT_LINK_S
        n.motion_at = now
        n.attitude = [round(v, 2) for v in rs[-1][12:15]]
        for r in rs[::4]:
            motion_alerts(n, r)
        pending_events.append({"type": "motion", "node": origin,
                               "rows": [[r[1]] + [round(v, 4) for v in r[2:]] for r in rs]})
        if not was_direct:
            pending_nodes.add(origin)
    if rows or mot:
        state["activity_at"] = now


async def broadcast(msg: dict):
    if not clients:
        return
    text = json.dumps(msg, separators=(",", ":"))
    for ws in list(clients):
        try:
            await ws.send_text(text)
        except Exception:
            clients.discard(ws)


async def tail_loop():
    last_status = 0.0
    direct_seen = {}
    while True:
        try:
            await asyncio.to_thread(poll_db)
        except sqlite3.Error as e:
            print(f"db poll failed: {e}", flush=True)
        now = time.time()
        if now - last_status > 1:
            last_status = now
            status_alerts(now)
            for n in nodes.values():  # direct-link flag flips off when motion stops
                d = now - n.motion_at < DIRECT_LINK_S
                if direct_seen.get(n.id) != d:
                    direct_seen[n.id] = d
                    pending_nodes.add(n.id)
            await broadcast({"type": "collector", "collector": collector_json(now),
                             "readings_total": state["readings_total"]})
        events, pending_events[:] = pending_events[:], []
        ids = set(pending_nodes)
        pending_nodes.clear()
        for nid in ids:
            await broadcast({"type": "node", "node": nodes[nid].to_json(now)})
        for e in events:
            await broadcast(e)
        await asyncio.sleep(0.1)


# ---- simulated fleet (off unless --sim-fleet) ------------------------------

async def sim_loop(count: int):
    rng = random.Random(7)
    lat0, lon0 = fleet["center"]
    sims = []
    for i in range(count):
        nid = f"5a{i:06x}"
        get_node(nid, virtual=True).sim_name = f"S{i + 1}"
        ang, dist = rng.uniform(0, 2 * math.pi), rng.uniform(150, 700)
        pos = (lat0 + dist * math.cos(ang) / 111320, lon0 + dist * math.sin(ang) / (111320 * math.cos(math.radians(lat0))))
        sims.append({"n": get_node(nid, virtual=True), "pos": pos, "seq": 0, "water": rng.uniform(18, 26),
                     "air": rng.uniform(20, 28), "p": rng.uniform(975, 990), "wave": rng.uniform(0.01, 0.12),
                     "up": 0, "phase": rng.uniform(0, 6)})
    while True:
        now = time.time()
        for s in sims:
            s["water"] += rng.gauss(0, 0.03)
            s["air"] += rng.gauss(0, 0.05)
            s["p"] += rng.gauss(0, 0.05)
            s["wave"] = max(0.005, s["wave"] + rng.gauss(0, 0.004))
            s["up"] += 5
            pitch = 4 * math.sin(now / 7 + s["phase"]) + rng.gauss(0, 0.5)
            roll = 3 * math.cos(now / 5 + s["phase"]) + rng.gauss(0, 0.5)
            r = to_reading((s["n"].id, s["seq"], int(now), s["up"], s["pos"][0], s["pos"][1], round(s["water"], 2),
                            round(s["air"], 2), round(s["p"], 2), round(s["wave"], 3), round(s["wave"] * 2.6, 3),
                            round(pitch, 2), round(roll, 2), 9, 0x1F | collector.F_SIM, now))
            s["seq"] += 1
            s["n"].add(r)
            pending_nodes.add(s["n"].id)
        await asyncio.sleep(5)


# ---- HTTP API --------------------------------------------------------------

@asynccontextmanager
async def lifespan(_app):
    tasks = [asyncio.create_task(tail_loop())]
    if args.sim_fleet:
        tasks.append(asyncio.create_task(sim_loop(args.sim_fleet)))
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="Tideline", lifespan=lifespan)


def resolve(ref: str) -> Node:
    """Accepts an id, a name like '#1', or '1' / 'buoy 1' / 'one'."""
    words = {"one": "1", "two": "2", "three": "3", "four": "4", "five": "5", "six": "6", "seven": "7", "eight": "8"}
    s = ref.strip().lower().replace("buoy", "").replace("node", "").replace("number", "").strip()
    s = words.get(s, s)
    for n in nodes.values():
        if s in (n.id, n.name.lower(), n.name.lower().lstrip("#"), n.id[-4:]):
            return n
    raise HTTPException(404, f"no buoy matches '{ref}'. Known: {', '.join(n.name for n in nodes.values())}")


@app.get("/api/config")
def config():
    return {"center": fleet["center"], "voice": os.environ.get("XAI_VOICE", "eve"),
            "voice_model": os.environ.get("XAI_VOICE_MODEL", "grok-voice-latest"),
            "has_voice_key": bool(os.environ.get("XAI_API_KEY"))}


@app.get("/api/nodes")
def list_nodes():
    now = time.time()
    return {"nodes": [n.to_json(now) for n in nodes.values()], "collector": collector_json(now),
            "alerts": list(alerts), "readings_total": state["readings_total"]}


@app.get("/api/nodes/{ref}")
def node_detail(ref: str):
    n = resolve(ref)
    j = n.to_json()
    if not n.virtual:
        first, count = q("SELECT MIN(received_at), COUNT(*) FROM readings WHERE origin=?", (n.id,))[0]
        j["first_seen"], j["records"] = first, count
    else:
        j["first_seen"], j["records"] = n.recent[0]["received_at"] if n.recent else None, len(n.recent)
    return j


def history_rows(n: Node, minutes: float):
    since = time.time() - minutes * 60
    if n.virtual:
        return [r for r in n.recent if r["t"] >= since]
    limit = int(min(60000, max(500, minutes * 60 / max(n.interval(), 1) * 1.5 + 200)))
    rows = [to_reading(r) for r in q(f"SELECT {','.join(DB_COLS)} FROM readings WHERE origin=? "
                                     "ORDER BY seq DESC LIMIT ?", (n.id, limit))][::-1]
    assign_times(rows)
    return [r for r in rows if r["t"] >= since]


@app.get("/api/nodes/{ref}/history")
def history(ref: str, minutes: float = 60, points: int = 600):
    rows = history_rows(resolve(ref), minutes)
    step = max(1, len(rows) // points)
    rows = rows[::step]
    out = {"t": [r["t"] for r in rows]}
    for m in METRICS:
        out[m] = [r.get(m) for r in rows]
    return out


@app.get("/api/summary")
def summary(node: str, metric: str = "water_c", minutes: float = 60):
    """Compact stats for the voice agent: one metric of one buoy over a window."""
    if metric not in METRICS:
        raise HTTPException(400, f"metric must be one of {METRICS}")
    n = resolve(node)
    pts = [(r["t"], r[metric]) for r in history_rows(n, minutes) if r.get(metric) is not None]
    if not pts:
        return {"node": n.name, "metric": metric, "minutes": minutes, "count": 0}
    vals = [v for _, v in pts]
    span_h = (pts[-1][0] - pts[0][0]) / 3600
    return {"node": n.name, "metric": metric, "minutes": minutes, "count": len(vals),
            "first": vals[0], "last": vals[-1], "min": min(vals), "max": max(vals),
            "mean": round(statistics.fmean(vals), 3), "change": round(vals[-1] - vals[0], 3),
            "change_per_hour": round((vals[-1] - vals[0]) / span_h, 3) if span_h > 0.01 else None,
            "covers_minutes": round(span_h * 60, 1)}


@app.get("/api/alerts")
def get_alerts():
    return list(alerts)


class Position(BaseModel):
    lat: float | None = None
    lon: float | None = None


@app.post("/api/nodes/{nid}/position")
async def set_position(nid: str, p: Position):
    pos = [round(p.lat, 7), round(p.lon, 7)] if p.lat is not None and p.lon is not None else None
    if nid == fleet.get("collector", {}).get("id"):
        fleet["collector"]["pos"] = pos
    else:
        fleet.setdefault("nodes", {}).setdefault(nid, {})["pos"] = pos
        if nid in nodes:
            pending_nodes.add(nid)
    save_fleet()
    return {"ok": True, "pos": pos}


@app.post("/api/voice/token")
async def voice_token():
    key = os.environ.get("XAI_API_KEY")
    if not key:
        raise HTTPException(503, "No XAI_API_KEY. Put XAI_API_KEY=... in .env at the repo root and restart.")
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(XAI_SECRETS_URL, headers={"Authorization": f"Bearer {key}"},
                         json={"expires_after": {"seconds": 600}})
    if r.status_code >= 300:
        raise HTTPException(502, f"xAI refused the token request: {r.status_code} {r.text[:300]}")
    return r.json()


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
    try:
        await ws.send_text(json.dumps({"type": "hello", **list_nodes()}, separators=(",", ":")))
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(ws)


def main():
    global args, fleet, db, collector_proc
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=str(ROOT / "buoy.db"))
    ap.add_argument("--serial", help="also run tools/collector.py on this port, e.g. COM5")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--sim-fleet", type=int, default=0, metavar="N", help="add N fake buoys around the map center")
    args = ap.parse_args()
    load_env()
    fleet = json.loads(FLEET_PATH.read_text())

    db = sqlite3.connect(args.db, check_same_thread=False, timeout=5)
    db.execute("PRAGMA journal_mode=WAL")
    db.executescript(collector.SCHEMA)
    init_from_db()
    print(f"loaded {len(nodes)} buoys, {state['readings_total']} readings from {args.db}", flush=True)

    if args.serial:
        collector_proc = subprocess.Popen([sys.executable, "-u", str(ROOT / "tools" / "collector.py"), args.serial,
                                           "--db", args.db])
        atexit.register(collector_proc.terminate)
    if DIST.exists():
        app.mount("/", StaticFiles(directory=DIST, html=True), name="web")
    else:
        print("web/dist not built: run `npm run build` in web/, or use the Vite dev server", flush=True)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
