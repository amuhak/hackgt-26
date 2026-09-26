// Collector: an ESP32 on the laptop's USB port. It joins the mesh as a node
// that stores nothing: it advertises the laptop's progress per origin, so buoys
// push whatever the laptop lacks, and streams the records up the serial port.
//
// Serial protocol (921600 baud, newline-terminated):
//   -> laptop  READY <self hex>               until START is received
//   -> laptop  REC <84 hex chars>             one raw Record
//   -> laptop  LOG <text>
//   <- laptop  HAVE <origin hex> <next>       laptop already has seq < next
//   <- laptop  START                          begin advertising
//   <- laptop  ACK <origin hex> <next>        committed to the DB; buoys may prune
#include <Arduino.h>

#include "../common/mesh.h"

class SerialSink : public MeshNode {
 public:
  bool started = false;

  size_t states(OriginState* out, size_t max) override {
    size_t n = min(max, count_);
    memcpy(out, table_, n * sizeof(OriginState));
    return n;
  }

  bool state(uint32_t origin, OriginState& out) override {
    OriginState* s = find(origin);
    if (!s) return false;
    out = *s;
    return true;
  }

  size_t read(uint32_t, uint32_t, Record*, size_t) override { return 0; }  // never serves

  void ingest(const Record* recs, size_t n, uint32_t) override {
    if (!started) return;
    OriginState* s = find(recs[0].origin);
    if (!s) {
      s = create(recs[0].origin);
      if (!s) return;
      Serial.printf("LOG first data from %08lx\n", (unsigned long)recs[0].origin);
    }
    // Buoys send in ascending order; gaps (data evicted everywhere) are skipped.
    for (size_t i = 0; i < n; i++) {
      if (recs[i].seq < s->next) continue;
      Serial.print("REC ");
      const uint8_t* b = reinterpret_cast<const uint8_t*>(&recs[i]);
      for (size_t k = 0; k < sizeof(Record); k++) Serial.printf("%02x", b[k]);
      Serial.print('\n');
      s->next = recs[i].seq + 1;
      s->first = s->next;
    }
  }

  void peerState(const OriginState&) override {}
  bool advertise() override { return started; }

  void have(uint32_t origin, uint32_t next) {
    OriginState* s = find(origin);
    if (!s) s = create(origin);
    if (!s) return;
    s->first = s->next = next;
    s->acked = max(s->acked, next);
  }

  void ack(uint32_t origin, uint32_t next) {
    OriginState* s = find(origin);
    if (s) s->acked = max(s->acked, next);
  }

 private:
  OriginState* find(uint32_t origin) {
    for (size_t i = 0; i < count_; i++) {
      if (table_[i].origin == origin) return &table_[i];
    }
    return nullptr;
  }

  OriginState* create(uint32_t origin) {
    if (count_ >= MAX_ORIGINS) return nullptr;
    size_t i = count_;
    while (i > 0 && table_[i - 1].origin > origin) {
      table_[i] = table_[i - 1];
      i--;
    }
    table_[i] = {origin, 0, 0, 0};
    count_++;
    return &table_[i];
  }

  OriginState table_[MAX_ORIGINS];  // first == next == what the laptop has
  size_t count_ = 0;
};

static SerialSink sink;
static uint32_t selfId;
static char line[64];
static size_t lineLen = 0;
static uint32_t lastReadyAt = 0;

static void handleLine(char* s) {
  char cmd[8];
  char originHex[12];
  unsigned long next;
  if (sscanf(s, "%7s %11s %lu", cmd, originHex, &next) == 3) {
    uint32_t origin = strtoul(originHex, nullptr, 16);
    if (!strcmp(cmd, "HAVE")) sink.have(origin, next);
    else if (!strcmp(cmd, "ACK")) sink.ack(origin, next);
  } else if (!strcmp(s, "START")) {
    sink.started = true;
    Serial.println("LOG started");
  }
}

void setup() {
  Serial.setTxBufferSize(8192);
  Serial.setRxBufferSize(4096);
  Serial.begin(921600);
  selfId = mesh::selfId();
  if (!mesh::begin(&sink, selfId)) Serial.println("LOG mesh init FAILED");
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
    Serial.printf("READY %08lx\n", (unsigned long)selfId);
  }
  mesh::loop();
}
