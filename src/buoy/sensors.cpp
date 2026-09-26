#include "sensors.h"

#include <Arduino.h>
#include <math.h>

#include "../common/mesh.h"

#ifndef SIM_SENSORS
#include <Adafruit_BMP280.h>
#include <DallasTemperature.h>
#include <OneWire.h>
#include <TinyGPSPlus.h>
#include <Wire.h>
#endif

namespace sensors {
namespace {

constexpr float kG = 9.80665f;

// Wave statistics for the current period. Gravity is tracked with a slow
// low-pass filter so the vertical component survives any buoy tilt.
struct Waves {
  float g[3] = {0, 0, kG};
  bool seeded = false;
  float sum[3] = {0, 0, 0};
  double sumSq = 0;
  float peak = 0;
  uint32_t n = 0;

  void add(float ax, float ay, float az) {
    if (!seeded) {
      g[0] = ax, g[1] = ay, g[2] = az;
      seeded = true;
    }
    g[0] += 0.02f * (ax - g[0]);
    g[1] += 0.02f * (ay - g[1]);
    g[2] += 0.02f * (az - g[2]);
    float gm = sqrtf(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
    if (gm < 1e-3f) return;
    float vert = (ax * g[0] + ay * g[1] + az * g[2]) / gm - gm;
    sum[0] += ax, sum[1] += ay, sum[2] += az;
    sumSq += vert * vert;
    peak = max(peak, fabsf(vert));
    n++;
  }

  void fill(Record& r) {
    if (n > 0) {
      float mx = sum[0] / n, my = sum[1] / n, mz = sum[2] / n;
      r.acc_rms_mg = min(65535.0, sqrt(sumSq / n) / kG * 1000.0);
      r.acc_peak_mg = min(65535.0f, peak / kG * 1000.0f);
      r.pitch_cdeg = atan2f(-mx, sqrtf(my * my + mz * mz)) * 18000.0f / PI;
      r.roll_cdeg = atan2f(my, mz) * 18000.0f / PI;
    }
    sum[0] = sum[1] = sum[2] = 0;
    sumSq = 0;
    peak = 0;
    n = 0;
  }
};

Waves waves;
uint32_t lastImuAt = 0;

#ifdef SIM_SENSORS

float noise(float amp) { return amp * ((int32_t)(esp_random() % 2001) - 1000) / 1000.0f; }

#else

Adafruit_BMP280 bmp;
OneWire oneWire(PIN_ONEWIRE);
DallasTemperature ds(&oneWire);
TinyGPSPlus gps;
HardwareSerial gpsSerial(2);
bool bmpOk = false, mpuOk = false;

// Days since 1970-01-01 for a proleptic Gregorian date.
int32_t daysFromCivil(int32_t y, uint32_t m, uint32_t d) {
  y -= m <= 2;
  int32_t era = (y >= 0 ? y : y - 399) / 400;
  uint32_t yoe = y - era * 400;
  uint32_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  uint32_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + (int32_t)doe - 719468;
}

// Register-level MPU driver. Many boards sold as MPU6050 carry an MPU6500 or
// similar, which shares these registers but fails the Adafruit chip-id check.
uint8_t mpuAddr = 0;

bool mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool mpuRead(uint8_t reg, uint8_t* buf, size_t n) {
  Wire.beginTransmission(mpuAddr);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)mpuAddr, (int)n) != (int)n) return false;
  for (size_t i = 0; i < n; i++) buf[i] = Wire.read();
  return true;
}

bool mpuBegin() {
  for (uint8_t addr : {0x68, 0x69}) {
    mpuAddr = addr;
    uint8_t id;
    if (!mpuRead(0x75, &id, 1)) continue;  // WHO_AM_I
    Serial.printf("mpu: WHO_AM_I 0x%02x at 0x%02x\n", id, addr);
    mpuWrite(0x6B, 0x80);  // reset
    delay(100);
    mpuWrite(0x6B, 0x01);  // wake, gyro PLL clock
    mpuWrite(0x1A, 0x04);  // DLPF ~20 Hz
    mpuWrite(0x1C, 0x08);  // accel +-4 g
    if (id != 0x68) mpuWrite(0x1D, 0x04);  // MPU6500+: separate accel DLPF
    delay(50);
    return true;
  }
  return false;
}

bool mpuAccel(float& x, float& y, float& z) {
  uint8_t b[6];
  if (!mpuRead(0x3B, b, sizeof(b))) return false;
  constexpr float kScale = kG / 8192.0f;  // LSB/g at +-4 g
  x = (int16_t)(b[0] << 8 | b[1]) * kScale;
  y = (int16_t)(b[2] << 8 | b[3]) * kScale;
  z = (int16_t)(b[4] << 8 | b[5]) * kScale;
  return true;
}

// Counts NMEA sentence starts heard on the given pins/baud.
int gpsListen(int rx, int tx, uint32_t baud) {
  gpsSerial.end();
  gpsSerial.begin(baud, SERIAL_8N1, rx, tx);
  int sentences = 0;
  for (uint32_t t = millis(); millis() - t < 1500;) {
    if (gpsSerial.available()) {
      if (gpsSerial.read() == '$') sentences++;
    } else {
      delay(1);
    }
  }
  return sentences;
}

// A NEO-6M streams NMEA constantly, even without a fix, so silence means a
// wiring problem. Tries swapped TX/RX and other bauds before giving up.
void gpsBegin() {
  const int pins[2][2] = {{PIN_GPS_RX, PIN_GPS_TX}, {PIN_GPS_TX, PIN_GPS_RX}};
  const uint32_t bauds[] = {9600, 38400, 115200};
  for (int p = 0; p < 2; p++) {
    for (uint32_t baud : bauds) {
      if (gpsListen(pins[p][0], pins[p][1], baud) >= 2) {
        Serial.printf("gps: NMEA on RX=GPIO%d at %lu baud%s\n", pins[p][0], (unsigned long)baud,
                      p ? " (TX/RX wires are swapped; working anyway)" : "");
        return;
      }
    }
  }
  Serial.printf("gps: NO DATA on GPIO%d or GPIO%d; check GPS VCC/GND and the TX wire\n", PIN_GPS_RX, PIN_GPS_TX);
  gpsSerial.end();
  gpsSerial.begin(9600, SERIAL_8N1, PIN_GPS_RX, PIN_GPS_TX);
}

void i2cScan() {
  Serial.print("i2c:");
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) Serial.printf(" 0x%02x", addr);
  }
  Serial.println(" (expect 0x68 MPU6050, 0x76 BMP280)");
}

#endif

}  // namespace

void begin() {
#ifdef SIM_SENSORS
  Serial.println("sensors: SIMULATED");
#else
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  i2cScan();

  bmpOk = bmp.begin(0x76) || bmp.begin(0x77);
  if (bmpOk) {
    bmp.setSampling(Adafruit_BMP280::MODE_NORMAL, Adafruit_BMP280::SAMPLING_X2, Adafruit_BMP280::SAMPLING_X16,
                    Adafruit_BMP280::FILTER_X16, Adafruit_BMP280::STANDBY_MS_500);
  }

  mpuOk = mpuBegin();

  ds.begin();
  ds.setWaitForConversion(false);
  ds.requestTemperatures();

  gpsBegin();
  Serial.printf("sensors: bmp280 %s, mpu6050 %s, ds18b20 %d found\n", bmpOk ? "ok" : "MISSING",
                mpuOk ? "ok" : "MISSING", ds.getDeviceCount());
#endif
}

void poll() {
#ifndef SIM_SENSORS
  while (gpsSerial.available()) gps.encode(gpsSerial.read());
#endif
  uint32_t now = millis();
  if (now - lastImuAt < IMU_SAMPLE_MS) return;
  lastImuAt = now;
#ifdef SIM_SENSORS
  float t = now / 1000.0f;
  waves.add(noise(0.3f), noise(0.3f), kG + 1.5f * sinf(t * 2 * PI / 6.0f) + noise(0.2f));
#else
  if (!mpuOk) return;
  float ax, ay, az;
  if (mpuAccel(ax, ay, az)) waves.add(ax, ay, az);
#endif
}

void fill(Record& r) {
  r.uptime_s = millis() / 1000;
  waves.fill(r);
#ifdef SIM_SENSORS
  r.flags = F_SIM | F_BMP_OK | F_IMU_OK | F_WATER_OK | F_GPS_FIX;
  r.water_cC = (18.0f + noise(0.5f)) * 100;
  r.air_cC = (24.0f + noise(1.0f)) * 100;
  r.pressure_pa = 101325 + (int32_t)noise(300);
  // Spread simulated buoys around a point off Tybee Island, GA.
  uint32_t id = selfId();
  r.lat_e7 = 320000000 + (int32_t)(id % 1000) * 1000;
  r.lon_e7 = -807000000 - (int32_t)((id / 1000) % 1000) * 1000;
  r.sats = 8;
#else
  r.flags = 0;
  if (bmpOk) {
    r.air_cC = bmp.readTemperature() * 100;
    r.pressure_pa = bmp.readPressure();
    r.flags |= F_BMP_OK;
  }
  if (mpuOk) r.flags |= F_IMU_OK;

  float water = ds.getTempCByIndex(0);
  ds.requestTemperatures();  // ready long before the next period
  if (water != DEVICE_DISCONNECTED_C && water != 85.0f) {
    r.water_cC = water * 100;
    r.flags |= F_WATER_OK;
  }

  if (gps.location.isValid() && gps.location.age() < 5000) {
    r.lat_e7 = gps.location.lat() * 1e7;
    r.lon_e7 = gps.location.lng() * 1e7;
    r.flags |= F_GPS_FIX;
  }
  if (gps.date.isValid() && gps.time.isValid() && gps.date.year() >= 2024 && gps.time.age() < 5000) {
    int32_t days = daysFromCivil(gps.date.year(), gps.date.month(), gps.date.day());
    uint32_t secs = gps.time.hour() * 3600 + gps.time.minute() * 60 + gps.time.second();
    r.gps_time = days * 86400UL + secs + gps.time.age() / 1000;
    r.flags |= F_GPS_TIME;
  }
  r.sats = gps.satellites.isValid() ? min<uint32_t>(gps.satellites.value(), 255) : 0;
#endif
}

uint32_t gpsChars() {
#ifdef SIM_SENSORS
  return 0;
#else
  return gps.charsProcessed();
#endif
}

}  // namespace sensors
