// Verbose logging for the buoy_debug build; compiles away otherwise.
#pragma once
#include <Arduino.h>

#ifdef DEBUG_LOG
#define DLOG(...) Serial.printf(__VA_ARGS__)
#else
#define DLOG(...) \
  do {            \
  } while (0)
#endif
