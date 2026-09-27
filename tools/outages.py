"""Why a buoy dropped out: lists each silence in buoy.db and what the buoy was doing.

    python tools/outages.py            # buoy #1 (f4e618b4), last 24 h
    python tools/outages.py f4e5f71c --hours 3

For each gap in arrivals it reports whether the buoy
  - kept sampling and the readings arrived late  -> the radio link dropped (range, antenna, power sag on TX)
  - rebooted (uptime went back to ~0)             -> reset reason is in its serial log; power-on/brownout = power
  - made no readings at all for that time         -> it was frozen or off
"""
import argparse
import sqlite3
import time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("origin", nargs="?", default="f4e618b4")
ap.add_argument("--db", default=str(Path(__file__).resolve().parent.parent / "buoy.db"))
ap.add_argument("--hours", type=float, default=24, help="look back this far from the buoy's last reading")
ap.add_argument("--gap", type=float, help="seconds without arrivals that count as an outage (default: 3 sample periods)")
a = ap.parse_args()

db = sqlite3.connect(a.db)
last = db.execute("SELECT MAX(received_at) FROM readings WHERE origin=?", (a.origin,)).fetchone()[0] or 0
rows = db.execute("SELECT seq, uptime_s, received_at FROM readings WHERE origin=? AND received_at > ? ORDER BY seq",
                  (a.origin, last - a.hours * 3600)).fetchall()
if not rows:
    raise SystemExit(f"no readings from {a.origin} in the last {a.hours:g} h")
fmt = lambda t: time.strftime("%H:%M:%S", time.localtime(t))

# Sample time of each reading: boot time (earliest received_at - uptime in that boot) + uptime.
boots, start = [], 0
for i in range(1, len(rows) + 1):
    if i == len(rows) or rows[i][1] < rows[i - 1][1]:
        seg = rows[start:i]
        boots.append((min(r[2] - r[1] for r in seg), seg))
        start = i
sample = {}
for boot, seg in boots:
    for seq, up, rx in seg:
        sample[seq] = boot + up

print(f"{a.origin}: {len(rows)} readings, seq {rows[0][0]}..{rows[-1][0]}, {len(boots)} boot(s)")
for boot, seg in boots:
    print(f"  boot at {fmt(boot)}: seq {seg[0][0]}..{seg[-1][0]}, sampled until {fmt(boot + seg[-1][1])} (uptime {seg[-1][1]} s)")

steps = sorted(b[1] - a_[1] for a_, b in zip(rows, rows[1:]) if b[1] > a_[1])
period = steps[len(steps) // 2] if steps else 30
gap = a.gap or max(10, 3 * period)
print(f"sample period {period} s; outages = no arrivals for {gap:g} s+")
by_rx = sorted(rows, key=lambda r: r[2])
out = 0
for prev, cur in zip(by_rx, by_rx[1:]):
    silent = cur[2] - prev[2]
    if silent < gap:
        continue
    out += 1
    late = [r for r in rows if prev[2] < sample[r[0]] < cur[2]]  # sampled during the silence
    rebooted = any(b[0] > prev[2] - 5 and b[0] < cur[2] for b in boots)
    if late:
        why = f"buoy kept sampling ({len(late)} readings made meanwhile, delivered afterwards) -> link dropped"
    elif rebooted:
        why = "buoy rebooted -> check its reset reason (power-on/brownout = power)"
    else:
        why = "no readings made meanwhile -> buoy frozen or off"
    print(f"silent {fmt(prev[2])} -> {fmt(cur[2])} ({silent:.0f} s): {why}")
print(f"{out} outage(s)" if out else "no outages")
