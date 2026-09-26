# hackgt-26

Mesh of ESP32 sensor buoys. Each buoy logs readings, and the buoys gossip every node's data between themselves. An ESP32 plugged into a laptop can pull the whole fleet's data from any one buoy it reaches.

## Wiring

![Buoy wiring](docs/wiring.svg)

| Sensor pin | ESP32 pin | Notes |
|---|---|---|
| BMP280 VCC / GND | 3V3 / GND | 3.3V only |
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
| NEO-6M RX | GPIO17 (TX2) | |

- WROVER boards use GPIO16/17 for PSRAM. On one of those, wire the GPS to GPIO25/26 and update `PIN_GPS_*` in `include/proto.h`.
- VIN only carries 5V when the board is powered over USB or 5V. If you power the buoy from a 3.3V source, run the GPS from 3V3 instead.
