# Buoy node wiring

The same wiring is drawn in [wiring.svg](wiring.svg). The ESP32 pin names below match the board silkscreen; where each pin sits physically varies by board.

```
                      ESP32 DevKit
                   +----------------+
   3V3 rail  <-----| 3V3            |
   GND rail  <-----| GND            |
   5V (GPS)  <-----| VIN            |
   I2C SDA   <---->| GPIO21         |
   I2C SCL   <-----| GPIO22         |
   1-Wire    <---->| GPIO4          |
   GPS TX    ----->| GPIO16 (RX2)   |
   GPS RX    <-----| GPIO17 (TX2)   |
                   +----------------+

 BMP280 (3.3V)           MPU6050                  DS18B20 probe             NEO-6M GPS
 VCC -> 3V3              VCC -> 3V3               red    VDD -> 3V3         VCC -> VIN (5V)
 GND -> GND              GND -> GND               black  GND -> GND         GND -> GND
 SCL -> GPIO22           SCL -> GPIO22            yellow DQ  -> GPIO4       TX  -> GPIO16
 SDA -> GPIO21           SDA -> GPIO21                                      RX  -> GPIO17
 SDO -> GND   (0x76)     AD0 -> GND   (0x68)      4.7 kΩ pull-up:
 CSB -> 3V3   (if pin    INT    not connected       3V3 ---[4.7k]---+
               exists)                                              |
                                                    GPIO4 ----------+---- DQ (yellow)
```

| Sensor pin | ESP32 pin | Notes |
|---|---|---|
| BMP280 VCC / GND | 3V3 / GND | 3.3V only, not 5V tolerant |
| BMP280 SCL / SDA | GPIO22 / GPIO21 | shared I2C bus |
| BMP280 SDO | GND | sets I2C addr 0x76 |
| BMP280 CSB | 3V3 | only if the pin is broken out; forces I2C mode |
| MPU6050 VCC / GND | 3V3 / GND | |
| MPU6050 SCL / SDA | GPIO22 / GPIO21 | shared I2C bus |
| MPU6050 AD0 | GND | sets I2C addr 0x68; INT unused |
| DS18B20 VDD (red) / GND (black) | 3V3 / GND | |
| DS18B20 DQ (yellow) | GPIO4 | **4.7 kΩ resistor from DQ to 3V3** |
| NEO-6M VCC / GND | VIN (5V) / GND | module has its own regulator; TX output is 3.3V-safe |
| NEO-6M TX | GPIO16 (RX2) | TX/RX cross over |
| NEO-6M RX | GPIO17 (TX2) | 9600 baud |

- WROVER boards use GPIO16/17 for PSRAM. On one of those, wire the GPS to GPIO25/26 and update `PIN_GPS_*` in `include/proto.h`.
- VIN only carries 5V when the board is powered over USB or 5V. If you power the buoy from a 3.3V source, run the GPS from 3V3 instead.
- Once the firmware is flashed, the boot log runs an I2C scan and should report `0x68 0x76`.
