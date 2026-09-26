#pragma once
#include "proto.h"

namespace sensors {
void begin();
// Call every loop: feeds the GPS parser and samples the IMU at 50 Hz.
void poll();
// Fills the sensor fields of `r` and resets the per-period wave statistics.
void fill(Record& r);
// Bytes received from the GPS so far; 0 means it's miswired or unpowered.
uint32_t gpsChars();
}  // namespace sensors
