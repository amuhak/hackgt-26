// Shared record format, radio messages and tunables for buoys and the collector.
#pragma once
#include <stdint.h>
#include <stddef.h>

// ---- Tunables -------------------------------------------------------------
#ifndef SAMPLE_PERIOD_MS
#define SAMPLE_PERIOD_MS     30000UL  // one record per buoy per period
#endif
#define IMU_SAMPLE_MS        20UL     // 50 Hz wave sampling
#define SUMMARY_INTERVAL_MS  5000UL   // + up to 1 s jitter
#define DATA_GAP_MS          15UL     // min spacing between DATA frames we send
#define WANT_TIMEOUT_MS      15000UL  // stop serving a neighbor we stopped hearing from
#ifndef GAP_HOLD_MS
#define GAP_HOLD_MS          30000UL  // how long a gap must look unfillable before we skip it
#endif
#define NACK_MIN_MS          100UL    // min spacing of gap NACKs we send
#define MESH_CHANNEL         1
#define MESH_LONG_RANGE      1        // ESP32-only LR PHY: ~2x range, all nodes must match
#define MAX_ORIGINS          64
#define SEGMENT_RECORDS      256
#define FS_RESERVE_BYTES     (64 * 1024)

// Which MPU axis points up when the buoy floats level; the firmware rotates
// readings so tilt is measured from level. The MPU on the buoy board stands
// on edge with +X up.
#define MPU_UP_PZ 0  // chip lying flat, facing up
#define MPU_UP_PX 1
#define MPU_UP_NX 2
#define MPU_UP_PY 3
#define MPU_UP_NY 4
#define MPU_UP_NZ 5
#ifndef MPU_UP
#define MPU_UP MPU_UP_PX
#endif

// ---- Pins (see docs/wiring.svg) ------------------------------------------
#define PIN_I2C_SDA   21
#define PIN_I2C_SCL   22
#define PIN_ONEWIRE   4
#define PIN_GPS_RX    16  // ESP32 RX2 <- GPS TX
#define PIN_GPS_TX    17  // ESP32 TX2 -> GPS RX

// ---- Record: one sample from one buoy, 42 bytes ---------------------------
// Keep in sync with RECORD_FMT in tools/collector.py.
enum RecordFlags : uint8_t {
  F_BMP_OK   = 1 << 0,
  F_IMU_OK   = 1 << 1,
  F_WATER_OK = 1 << 2,
  F_GPS_FIX  = 1 << 3,
  F_GPS_TIME = 1 << 4,
  F_SIM      = 1 << 7,
};

struct __attribute__((packed)) Record {
  uint32_t origin;       // low 4 bytes of the buoy's MAC
  uint32_t seq;          // per-origin, strictly increasing
  uint32_t gps_time;     // unix seconds, 0 if no GPS time
  uint32_t uptime_s;
  int32_t  lat_e7;       // degrees * 1e7
  int32_t  lon_e7;
  int16_t  water_cC;     // DS18B20, centi-degC
  int16_t  air_cC;       // BMP280, centi-degC
  uint32_t pressure_pa;  // BMP280
  uint16_t acc_rms_mg;   // vertical accel RMS over the period (gravity removed)
  uint16_t acc_peak_mg;  // vertical accel peak |a|
  int16_t  pitch_cdeg;   // mean tilt over the period
  int16_t  roll_cdeg;
  uint8_t  sats;
  uint8_t  flags;        // RecordFlags
};
static_assert(sizeof(Record) == 42, "Record layout changed");

// What a node holds for one origin: records [first, next), and the laptop has
// confirmed everything below `acked`.
struct __attribute__((packed)) OriginState {
  uint32_t origin;
  uint32_t first;
  uint32_t next;
  uint32_t acked;
};

// ---- Radio messages (ESP-NOW broadcast, max 250 bytes) ---------------------
#define MSG_MAGIC    0xB7
#define MSG_VERSION  1
// MSG_SINK_SUMMARY: a collector's summary (same layout); buoys serve it first.
// MSG_MOTION: live IMU samples for a collector in direct range; never stored or relayed.
enum MsgType : uint8_t { MSG_SUMMARY = 1, MSG_DATA = 2, MSG_SINK_SUMMARY = 3, MSG_MOTION = 4 };

struct __attribute__((packed)) MsgHeader {
  uint8_t  magic;
  uint8_t  type;
  uint8_t  version;
  uint8_t  count;   // entries / records that follow
  uint32_t sender;
};

#define SUMMARY_MAX_ENTRIES 14
// Entries are sorted by origin. The page covers origin ids [lo, hi]: an origin
// in that range that isn't listed is one the sender holds nothing for.
// A one-entry page with lo == hi doubles as a NACK: "resend from my next".
struct __attribute__((packed)) SummaryMsg {
  MsgHeader   h;
  uint32_t    lo;
  uint32_t    hi;
  OriginState e[SUMMARY_MAX_ENTRIES];
};

#define DATA_MAX_RECORDS 5
// Consecutive records of one origin. `first` is the oldest seq the sender will
// ever send (held and not yet acked), so a receiver waiting on something older
// knows this sender can't supply it.
struct __attribute__((packed)) DataMsg {
  MsgHeader h;
  uint32_t  first;
  Record    r[DATA_MAX_RECORDS];
};

// One 50 Hz IMU sample in buoy axes (z up), raw: accel 8192 LSB/g (+-4 g),
// gyro 65.5 LSB/(deg/s) (+-500 deg/s, boot-time bias removed).
struct __attribute__((packed)) MotionSample {
  int16_t ax, ay, az;
  int16_t gx, gy, gz;
};

#define MOTION_SAMPLES 16
#define ACCEL_LSB_PER_G 8192.0f
#define GYRO_LSB_PER_DPS 65.5f
// `count` consecutive samples, `period_ms` apart, the first taken at `t0_ms`
// on the sender's clock (sample index * period, so gaps show up).
struct __attribute__((packed)) MotionMsg {
  MsgHeader    h;
  uint32_t     t0_ms;
  uint16_t     period_ms;
  MotionSample s[MOTION_SAMPLES];
};

static_assert(sizeof(SummaryMsg) <= 250, "SummaryMsg too big for ESP-NOW");
static_assert(sizeof(MotionMsg) <= 250, "MotionMsg too big for ESP-NOW");
static_assert(sizeof(DataMsg) <= 250, "DataMsg too big for ESP-NOW");
