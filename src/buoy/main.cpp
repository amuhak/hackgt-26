// Buoy: samples sensors, stores readings, and gossips everyone's data.
#include <Arduino.h>

#include "../common/mesh.h"
#include "sensors.h"
#include "store.h"

static Store store;
static Mesh* mesh;
static uint32_t lastSampleAt = 0;
static uint32_t lastStatusAt = 0;

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
  sensors::poll();
  espnow::poll(*mesh);
  mesh->loop(millis());

  uint32_t now = millis();
  if (now - lastSampleAt >= SAMPLE_PERIOD_MS) {
    lastSampleAt = now;
    Record r = {};
    sensors::fill(r);
    if (store.appendOwn(r)) logRecord(r);
    else Serial.println("store: append FAILED");
  }
  if (now - lastStatusAt >= 60000) {
    lastStatusAt = now;
    store.printStatus(Serial);
  }
}
