#!/usr/bin/env python3
"""Laptop side of the buoy mesh: drains the collector ESP32 into SQLite.

    python tools/collector.py COM6 [--db buoy.db]

On connect it tells the collector what the DB already has, so buoys only send
what's new, then acks each batch once committed so buoys can free flash.
"""
import argparse
import sqlite3
import struct
import sys
import time

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


def start_session(ser: serial.Serial, db: sqlite3.Connection) -> None:
    rows = db.execute("SELECT origin, MAX(seq) + 1 FROM readings GROUP BY origin").fetchall()
    for origin, nxt in rows:
        send(ser, f"HAVE {origin} {nxt}")
    send(ser, "START")
    print(f"collector ready; DB has {len(rows)} buoys")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("port", help="collector serial port, e.g. COM6 or /dev/ttyUSB0")
    ap.add_argument("--db", default="buoy.db")
    ap.add_argument("--baud", type=int, default=921600)
    args = ap.parse_args()

    db = sqlite3.connect(args.db)
    db.execute(SCHEMA)
    ser = serial.Serial(args.port, args.baud, timeout=0.2)  # opening resets the ESP32
    print(f"waiting for collector on {args.port}...")

    pending: dict[str, int] = {}  # origin -> next seq to ack after commit
    new_rows = 0
    last_flush = time.monotonic()
    try:
        while True:
            line = ser.readline().decode(errors="replace").strip()
            if line.startswith("READY"):
                start_session(ser, db)  # also covers a collector reboot mid-session
            elif line.startswith("REC "):
                try:
                    raw = bytes.fromhex(line[4:])
                    row = decode(raw, int(time.time()))
                except (ValueError, struct.error):
                    continue  # garbled line
                cur = db.execute(f"INSERT OR IGNORE INTO readings VALUES ({','.join('?' * len(row))})", row)
                new_rows += cur.rowcount
                pending[row[0]] = max(pending.get(row[0], 0), row[1] + 1)
            elif line.startswith("LOG "):
                print("collector:", line[4:])

            if pending and time.monotonic() - last_flush > 0.5:
                db.commit()
                for origin, nxt in pending.items():
                    send(ser, f"ACK {origin} {nxt}")
                counts = ", ".join(f"{o} up to #{n - 1}" for o, n in sorted(pending.items()))
                print(f"{time.strftime('%H:%M:%S')} +{new_rows} new ({counts})")
                pending.clear()
                new_rows = 0
                last_flush = time.monotonic()
    except KeyboardInterrupt:
        pass
    finally:
        db.commit()
        db.close()
        ser.close()


if __name__ == "__main__":
    sys.exit(main())
