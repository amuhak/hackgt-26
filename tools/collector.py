#!/usr/bin/env python3
"""Laptop side of the buoy mesh: drains the collector ESP32 into SQLite.

    python tools/collector.py COM6 [--db buoy.db]

On connect it tells the collector what the DB already has, so buoys only send
what's new, then acks each batch once committed so buoys can free flash.

Only records contiguous with what the DB has are stored and acked. A corrupt
line or a jump in seq sends REWIND, and the collector resends from the last
ACKs. A jump that persists after a rewind is real (the mesh evicted those
records) and is accepted.
"""
import argparse
import sqlite3
import struct
import sys
import time
import zlib

import serial

# Mirrors struct Record in include/proto.h (42 bytes, little-endian, packed).
RECORD_FMT = "<IIIIiihhIHHhhBB"
assert struct.calcsize(RECORD_FMT) == 42

F_BMP_OK, F_IMU_OK, F_WATER_OK, F_GPS_FIX, F_GPS_TIME, F_SIM = 1, 2, 4, 8, 16, 128

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
  origin        TEXT    NOT NULL,  -- buoy id (low 4 bytes of MAC, hex)
  seq           INTEGER NOT NULL,
  gps_time      INTEGER,           -- unix seconds from GPS, NULL without a GPS time
  uptime_s      INTEGER,
  lat           REAL,
  lon           REAL,
  water_temp_c  REAL,
  air_temp_c    REAL,
  pressure_hpa  REAL,
  wave_rms_g    REAL,              -- vertical accel RMS over the sample period
  wave_peak_g   REAL,
  pitch_deg     REAL,
  roll_deg      REAL,
  sats          INTEGER,
  flags         INTEGER,
  received_at   INTEGER NOT NULL,  -- laptop unix time
  PRIMARY KEY (origin, seq)
)
"""


def decode(raw: bytes, now: int) -> tuple:
    (origin, seq, gps_time, uptime, lat, lon, water, air, pressure,
     rms, peak, pitch, roll, sats, flags) = struct.unpack(RECORD_FMT, raw)
    fix = flags & F_GPS_FIX
    return (
        f"{origin:08x}", seq,
        gps_time if flags & F_GPS_TIME else None, uptime,
        lat / 1e7 if fix else None, lon / 1e7 if fix else None,
        water / 100 if flags & F_WATER_OK else None,
        air / 100 if flags & F_BMP_OK else None,
        pressure / 100 if flags & F_BMP_OK else None,
        rms / 1000 if flags & F_IMU_OK else None,
        peak / 1000 if flags & F_IMU_OK else None,
        pitch / 100 if flags & F_IMU_OK else None,
        roll / 100 if flags & F_IMU_OK else None,
        sats, flags, now,
    )


def send(ser: serial.Serial, line: str) -> None:
    ser.write((line + "\n").encode())


REWIND_TIMEOUT_S = 5  # resend REWIND if the collector never confirms it


def start_session(ser: serial.Serial, db: sqlite3.Connection) -> dict:
    """Returns origin -> next expected seq."""
    rows = db.execute("SELECT origin, MAX(seq) + 1 FROM readings GROUP BY origin").fetchall()
    for origin, nxt in rows:
        send(ser, f"HAVE {origin} {nxt}")
    send(ser, "START")
    log(f"collector ready; DB has {len(rows)} buoys")
    return dict(rows)


def parse_rec(line: str):
    """The raw record from a REC line, or None if it's garbled."""
    parts = line.split()
    try:
        raw = bytes.fromhex(parts[1])
        if len(raw) != 42 or len(parts) != 3 or zlib.crc32(raw) != int(parts[2], 16):
            return None
    except (ValueError, IndexError):
        return None
    return raw


def log(msg: str) -> None:
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def run_session(ser: serial.Serial, db: sqlite3.Connection) -> None:
    """Drains one serial connection until it errors out."""
    # Opening the port usually resets the ESP32, which then says READY. If it
    # didn't reset, it's already running, so announce ourselves right away too.
    time.sleep(1.5)
    expect = start_session(ser, db)  # origin -> next seq we'll store
    started = time.monotonic()
    pending = set()  # origins to ack after commit
    jump_ok = {}  # origin -> gap start we already rewound for
    rewind_sent = None  # REWIND awaiting the collector's confirmation
    new_rows = 0
    last_flush = time.monotonic()

    def rewind(why: str) -> None:
        nonlocal rewind_sent
        send(ser, "REWIND")
        rewind_sent = time.monotonic()
        log(f"rewind: {why}")

    while True:
        line = ser.readline().decode(errors="replace").strip()
        if rewind_sent and time.monotonic() - rewind_sent > REWIND_TIMEOUT_S:
            rewind("no confirmation")
        if line.startswith("READY") and time.monotonic() - started > 3:
            expect = start_session(ser, db)  # collector rebooted
            started = time.monotonic()
        elif line.startswith("LOG rewound"):
            rewind_sent = None  # REC lines from here on follow the rewind
        elif line.startswith("REC "):
            if rewind_sent:
                continue  # sent before the collector rewound
            raw = parse_rec(line)
            if raw is None:
                rewind("corrupt line")
                continue
            row = decode(raw, int(time.time()))
            origin, seq = row[0], row[1]
            e = expect.get(origin, 0)
            if seq > e:
                if jump_ok.get(origin) != e:
                    jump_ok[origin] = e
                    rewind(f"{origin} jumped {e} -> {seq}")
                    continue
                log(f"{origin}: records {e}..{seq - 1} no longer exist in the mesh; skipping")
            cur = db.execute(f"INSERT OR IGNORE INTO readings VALUES ({','.join('?' * len(row))})", row)
            new_rows += cur.rowcount
            if seq >= e:
                expect[origin] = seq + 1
                pending.add(origin)
        elif line.startswith("LOG "):
            log("collector: " + line[4:])

        if pending and time.monotonic() - last_flush > 0.5:
            db.commit()
            for origin in pending:
                send(ser, f"ACK {origin} {expect[origin]}")
            counts = ", ".join(f"{o} up to #{expect[o] - 1}" for o in sorted(pending))
            log(f"+{new_rows} new ({counts})")
            pending.clear()
            new_rows = 0
            last_flush = time.monotonic()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", help="collector serial port, e.g. COM6 or /dev/ttyUSB0")
    ap.add_argument("--db", default="buoy.db")
    ap.add_argument("--baud", type=int, default=921600)
    args = ap.parse_args()

    db = sqlite3.connect(args.db)
    db.execute(SCHEMA)
    log(f"waiting for collector on {args.port}...")
    try:
        while True:  # survive unplug/replug of the collector
            try:
                with serial.Serial(args.port, args.baud, timeout=0.2) as ser:
                    run_session(ser, db)
            except serial.SerialException as e:
                db.commit()
                log(f"serial error ({e}); retrying")
                time.sleep(2)
    except KeyboardInterrupt:
        pass
    finally:
        db.commit()
        db.close()


if __name__ == "__main__":
    sys.exit(main())
