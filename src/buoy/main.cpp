// Buoy: samples sensors, stores readings, and gossips everyone's data.
#include <Arduino.h>

#include "../common/mesh.h"
#include "sensors.h"
#include "store.h"

static Store store;
static Mesh* mesh;
static uint32_t lastSampleAt = 0;
static uint32_t lastStatusAt = 0;
static uint32_t loopCount = 0, loopMaxMs = 0, loopStartedAt = 0;
static char line[32];
static size_t lineLen = 0;
#ifdef SIM_SENSORS
static uint32_t backfillLeft = 0, backfillTotal = 0, backfillStartedAt = 0;
#endif

// One machine-readable line for soak tests: uptime, heap (leaks), radio counters.
static void printStat() {
  const espnow::Stats& rs = espnow::stats();
  const Mesh::Counters& mc = mesh->counters;
  Serial.printf(
      "STAT up=%lu heap=%u minheap=%u rx=%lu rxdrop=%lu tx=%lu txfail=%lu data=%lu nack=%lu heard=%lu readusmax=%lu "
      "loops=%lu loopmaxms=%lu\n",
      millis() / 1000, ESP.getFreeHeap(), ESP.getMinFreeHeap(), (unsigned long)rs.rxFrames,
      (unsigned long)rs.rxDropped, (unsigned long)rs.txFrames, (unsigned long)rs.txFailed, (unsigned long)mc.dataSent,
      (unsigned long)mc.nacksSent, (unsigned long)mc.dataHeard, (unsigned long)mc.readUsMax, (unsigned long)loopCount,
      (unsigned long)loopMaxMs);
  loopCount = loopMaxMs = 0;  // per-window
  mesh->counters.readUsMax = 0;
  store.printStatus(Serial);
}

// Serial commands: STAT, and on simulated buoys BACKFILL <n> to generate load.
static void handleLine(const char* s) {
  if (!strcmp(s, "STAT")) printStat();
#ifdef SIM_SENSORS
  unsigned long n;
  if (sscanf(s, "BACKFILL %lu", &n) == 1) {
    backfillLeft = backfillTotal = n;
    backfillStartedAt = millis();
  }
#endif
}

static void pollSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineLen) {
        line[lineLen] = 0;
        handleLine(line);
        lineLen = 0;
      }
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = c;
    }
  }
}

#ifdef SIM_SENSORS
// Appends a slice of synthetic records per loop so the mesh keeps running.
static void backfillStep() {
  if (!backfillLeft) return;
  Record batch[64] = {};
  size_t n = min<uint32_t>(backfillLeft, 64);
  for (size_t i = 0; i < n; i++) {
    batch[i].uptime_s = millis() / 1000;
    batch[i].flags = F_SIM;
  }
  if (!store.appendOwn(batch, n)) {
    Serial.println("BACKFILL failed");
    backfillLeft = 0;
    return;
  }
  backfillLeft -= n;
  if (!backfillLeft) {
    Serial.printf("BACKFILL done n=%lu ms=%lu next=%lu\n", (unsigned long)backfillTotal,
                  millis() - backfillStartedAt, (unsigned long)(batch[n - 1].seq + 1));
  }
}
#endif

static void logRecord(const Record& r) {
  Serial.printf(
      "sample #%lu: water %.2fC air %.2fC %.1fhPa | waves rms %umg peak %umg pitch %.1f roll %.1f | "
      "gps %s %.6f,%.6f sats %u t=%lu (%lu bytes rx) | flags 0x%02x\n",
      (unsigned long)r.seq, r.water_cC / 100.0, r.air_cC / 100.0, r.pressure_pa / 100.0, r.acc_rms_mg,
      r.acc_peak_mg, r.pitch_cdeg / 100.0, r.roll_cdeg / 100.0, (r.flags & F_GPS_FIX) ? "fix" : "nofix",
      r.lat_e7 / 1e7, r.lon_e7 / 1e7, r.sats, (unsigned long)r.gps_time, (unsigned long)sensors::gpsChars(), r.flags);
}

void setup() {
  Serial.begin(115200);
  delay(200);
  uint32_t id = selfId();
  Serial.printf("\nbuoy %08lx booting\n", (unsigned long)id);

  store.begin(id);
  sensors::begin();
  if (!espnow::begin()) Serial.println("mesh: DISABLED");
  mesh = new Mesh(&store, id, espnow::radio());
  store.printStatus(Serial);
  lastSampleAt = millis();
}

void loop() {
  uint32_t loopNow = millis();
  if (loopStartedAt) loopMaxMs = max(loopMaxMs, loopNow - loopStartedAt);
  loopStartedAt = loopNow;
  loopCount++;
  pollSerial();
#ifdef SIM_SENSORS
  backfillStep();
#endif
  sensors::poll();
  espnow::poll(*mesh);
  mesh->loop(millis());

  uint32_t now = millis();
  if (now - lastSampleAt >= SAMPLE_PERIOD_MS) {
    lastSampleAt = now;
    Record r = {};
    sensors::fill(r);
    if (store.appendOwn(&r)) logRecord(r);
    else Serial.println("store: append FAILED");
  }
  if (now - lastStatusAt >= 60000) {
    lastStatusAt = now;
    printStat();
  }
}
