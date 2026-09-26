// Collector: an ESP32 on the laptop's USB port, bridging the mesh to serial.
//
// Serial protocol (921600 baud, newline-terminated):
//   -> laptop  READY <self hex>               until START is received
//   -> laptop  REC <84 hex chars> <crc32 hex> one raw Record, CRC-32 (zlib) of its bytes
//   -> laptop  LOG <text>
//   <- laptop  HAVE <origin hex> <next>       laptop already has seq < next
//   <- laptop  START                          begin advertising
//   <- laptop  ACK <origin hex> <next>        committed to the DB; buoys may prune
//   <- laptop  REWIND                         a REC line was lost: resend from the last ACKs
#include <Arduino.h>

#include "../common/mesh.h"
#include "../common/sink.h"

static uint32_t crc32(const uint8_t* p, size_t n) {
  uint32_t c = 0xFFFFFFFF;
  while (n--) {
    c ^= *p++;
    for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c;
}

static void emit(const Record& r) {
  Serial.print("REC ");
  const uint8_t* b = reinterpret_cast<const uint8_t*>(&r);
  for (size_t k = 0; k < sizeof(Record); k++) Serial.printf("%02x", b[k]);
  Serial.printf(" %08lx\n", (unsigned long)crc32(b, sizeof(Record)));
}

static CollectorSink sink(emit);
static Mesh* mesh;
static uint32_t id;
static char line[64];
static size_t lineLen = 0;
static uint32_t lastReadyAt = 0;
static uint32_t lastStatAt = 0;

static void handleLine(char* s) {
  char cmd[8];
  char originHex[12];
  unsigned long next;
  if (sscanf(s, "%7s %11s %lu", cmd, originHex, &next) == 3) {
    uint32_t origin = strtoul(originHex, nullptr, 16);
    if (!strcmp(cmd, "HAVE")) sink.have(origin, next);
    else if (!strcmp(cmd, "ACK")) sink.ack(origin, next);
  } else if (!strcmp(s, "REWIND")) {
    sink.rewind();
    Serial.println("LOG rewound to last ACKs");
  } else if (!strcmp(s, "START")) {
    sink.started = true;
    Serial.println("LOG started");
  }
}

void setup() {
  Serial.setTxBufferSize(8192);
  Serial.setRxBufferSize(4096);
  Serial.begin(921600);
  id = selfId();
  if (!espnow::begin()) Serial.println("LOG mesh init FAILED");
  mesh = new Mesh(&sink, id, espnow::radio());
}

void loop() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (lineLen > 0) {
        line[lineLen] = 0;
        handleLine(line);
        lineLen = 0;
      }
    } else if (lineLen < sizeof(line) - 1) {
      line[lineLen++] = c;
    }
  }

  if (!sink.started && millis() - lastReadyAt >= 1000) {
    lastReadyAt = millis();
    Serial.printf("READY %08lx\n", (unsigned long)id);
  }
  espnow::poll(*mesh);
  mesh->loop(millis());

  if (millis() - lastStatAt >= 60000) {
    lastStatAt = millis();
    const espnow::Stats& rs = espnow::stats();
    Serial.printf("LOG STAT up=%lu heap=%u minheap=%u rx=%lu rxdrop=%lu tx=%lu txfail=%lu nack=%lu heard=%lu\n",
                  millis() / 1000, ESP.getFreeHeap(), ESP.getMinFreeHeap(), (unsigned long)rs.rxFrames,
                  (unsigned long)rs.rxDropped, (unsigned long)rs.txFrames, (unsigned long)rs.txFailed,
                  (unsigned long)mesh->counters.nacksSent, (unsigned long)mesh->counters.dataHeard);
  }
}
