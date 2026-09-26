// Buoy: samples sensors, stores readings, and gossips everyone's data.
#include <Arduino.h>

#include "../common/mesh.h"
#include "sensors.h"
#include "store.h"

#ifdef DEBUG_LOG
#define STAT_EVERY_MS 10000UL
#else
#define STAT_EVERY_MS 60000UL
#endif

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
      "writeusmax=%lu loops=%lu loopmaxms=%lu\n",
      millis() / 1000, ESP.getFreeHeap(), ESP.getMinFreeHeap(), (unsigned long)rs.rxFrames,
      (unsigned long)rs.rxDropped, (unsigned long)rs.txFrames, (unsigned long)rs.txFailed, (unsigned long)mc.dataSent,
      (unsigned long)mc.nacksSent, (unsigned long)mc.dataHeard, (unsigned long)mc.readUsMax, (unsigned long)store.writeUsMax, (unsigned long)loopCount,
      (unsigned long)loopMaxMs);
  loopCount = loopMaxMs = 0;  // per-window
  mesh->counters.readUsMax = 0;
  store.writeUsMax = 0;
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

static const char* resetReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power-on";
    case ESP_RST_EXT: return "reset pin";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "CRASH (panic)";
    case ESP_RST_INT_WDT: return "CRASH (interrupt watchdog)";
    case ESP_RST_TASK_WDT: return "CRASH (task watchdog)";
    case ESP_RST_WDT: return "CRASH (watchdog)";
    case ESP_RST_BROWNOUT: return "BROWNOUT (supply voltage sagged)";
    case ESP_RST_DEEPSLEEP: return "deep sleep wake";
    default: return "unknown";
  }
}

void setup() {
#ifdef DEBUG_LOG
  Serial.setTxBufferSize(16384);  // bursts of frame logs shouldn't stall the loop
#endif
  Serial.begin(115200);
  delay(200);
  uint32_t id = selfId();
  Serial.printf("\nbuoy %08lx booting (reset reason: %s)\n", (unsigned long)id, resetReason());
#ifdef DEBUG_LOG
  Serial.printf("debug build: chip rev %d, %lu MHz, flash %lu KB, heap %u, sdk %s\n", ESP.getChipRevision(),
                (unsigned long)ESP.getCpuFreqMHz(), (unsigned long)(ESP.getFlashChipSize() / 1024),
                ESP.getFreeHeap(), ESP.getSdkVersion());
  Serial.printf("pins: I2C SDA=%d SCL=%d, 1-Wire=%d, GPS RX=%d TX=%d\n", PIN_I2C_SDA, PIN_I2C_SCL, PIN_ONEWIRE,
                PIN_GPS_RX, PIN_GPS_TX);
#endif

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
  static MotionMsg motion;
  size_t motionN;
  if (sensors::takeMotion(motion, motionN) && mesh->sinkNearby(millis())) mesh->sendMotion(motion, motionN);
  espnow::poll(*mesh);
  mesh->loop(millis());

  uint32_t now = millis();
  if (now - lastSampleAt >= SAMPLE_PERIOD_MS) {
    lastSampleAt = now;
    Record r = {};
    sensors::fill(r);
    if (store.appendOwn(&r)) {
      mesh->push(r);
      logRecord(r);
    } else {
      Serial.println("store: append FAILED");
    }
  }
  if (now - lastStatusAt >= STAT_EVERY_MS) {
    lastStatusAt = now;
    printStat();
  }
#ifdef DEBUG_LOG
  static uint32_t lastTickAt = 0;
  if (now - lastTickAt >= 1000) {
    lastTickAt = now;
    sensors::debugTick();
  }
  uint32_t took = millis() - loopNow;
  if (took > 100) Serial.printf("dbg slow loop: %lu ms\n", (unsigned long)took);
#endif
}
