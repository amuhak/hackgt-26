# hackgt-26

Mesh of ESP32 sensor buoys. Each buoy logs readings, and the buoys gossip every node's data between themselves. An ESP32 plugged into a laptop can pull the whole fleet's data from any one buoy it reaches.

## Wiring

Text version with pin table: [docs/wiring.md](docs/wiring.md)

![Buoy wiring](docs/wiring.svg)

## Firmware

Requires PlatformIO (`pip install platformio pyserial`).

| Env | Flash to | Purpose |
|---|---|---|
| `buoy` | each buoy | real sensors |
| `buoy_sim` | spare ESP32s | fake readings, to test the mesh without wiring. `BACKFILL <n>` over serial queues n extra records, for load tests. |
| `collector` | the ESP32 on the laptop | bridges the mesh to USB serial |
| `meshsim` | any one ESP32 | runs virtual buoys + collector over a lossy fake radio and prints PASS/FAIL. Wipes the board's flash. |

```
pio run -e buoy -t upload --upload-port COM5
pio device monitor -p COM5            # boot log, I2C scan, one sample every 30 s; type STAT for counters
```

Collect data into SQLite (`readings` table, one row per buoy sample):

```
pio run -e collector -t upload --upload-port COM6
python tools/collector.py COM6 --db buoy.db
```

## How the mesh works

- Every 30 s, each buoy stores a record in flash. A record holds water temperature, air temperature, pressure, GPS position and time, and wave statistics: vertical-accel RMS and peak, plus tilt, from 50 Hz IMU sampling.
- Every ~5 s, each node broadcasts a summary of which records it holds per buoy over ESP-NOW. Neighbors send each other whatever is missing, so every buoy ends up with a copy of every buoy's data.
- A receiver only accepts the next record in sequence. When it spots a gap, it immediately sends a NACK saying "resend from N".
- The collector advertises what the laptop's DB already has, so buoys only send new records. Once the DB commits, the collector's ack spreads through the mesh and buoys delete the delivered data.

Tunables (sample period, channel, long-range mode) and pins are in `include/proto.h`.

- Long-range mode (`MESH_LONG_RANGE`) roughly doubles range, but every node must run the same setting.
- The mesh only runs between ESP32s.
- Flash holds about 45k records. That is roughly 1.5 days of undelivered data for 10 buoys; after that the oldest records are evicted.
