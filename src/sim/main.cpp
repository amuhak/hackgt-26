// On-device mesh simulation: several buoys and a collector run the real Mesh,
// Store and CollectorSink code over a simulated lossy radio with virtual time.
// Needs only one ESP32. Flash with `pio run -e meshsim -t upload` and watch
// the serial monitor for PASS/FAIL lines. Wipes the board's filesystem.
#include <Arduino.h>
#include <LittleFS.h>

#include <map>
#include <new>
#include <set>
#include <vector>

#include "../buoy/store.h"
#include "../common/mesh.h"
#include "../common/sink.h"

namespace {

constexpr int kBuoys = 4;  // D joins late
constexpr int kCol = kBuoys;  // index of the collector
constexpr int kNodes = kBuoys + 1;
constexpr uint32_t kTick = 2;           // ms of virtual time per step
constexpr uint32_t kAirtime = 4;        // ms a frame occupies the radio
constexpr uint32_t kGenEvery = 1000;    // buoys sample every virtual second
constexpr uint32_t kLossPct = 20;

const uint32_t kIds[kNodes] = {0xA0000001, 0xB0000002, 0xC0000003, 0xD0000004, 0xC011EC70};
const char* kNames[kNodes] = {"A", "B", "C", "D", "collector"};

uint32_t simNow = 0;
bool link[kNodes][kNodes] = {};
bool alive[kNodes] = {};
bool generating = false;

struct Frame {
  int from;
  uint32_t at;
  std::vector<uint8_t> bytes;
};
std::vector<Frame> air;

class SimRadio : public Radio {
 public:
  int idx = 0;
  uint32_t busyUntil = 0;
  bool ready() override { return simNow >= busyUntil; }
  bool send(const void* d, size_t len) override {
    if (!ready()) return false;
    busyUntil = simNow + kAirtime;
    auto p = static_cast<const uint8_t*>(d);
    air.push_back({idx, simNow + kAirtime, std::vector<uint8_t>(p, p + len)});
    return true;
  }
};

Store stores[kBuoys];
std::map<uint32_t, std::set<uint32_t>> got;  // what the "laptop" received
std::map<uint32_t, uint32_t> emitted;        // emit count, to detect duplicates
std::map<uint32_t, uint32_t> maxLatencyS;    // sampled -> reached the laptop, for records since latencyFrom
uint32_t latencyFrom = UINT32_MAX;
CollectorSink sink([](const Record& r) {
  got[r.origin].insert(r.seq);
  emitted[r.origin]++;
  if (r.uptime_s >= latencyFrom) {
    maxLatencyS[r.origin] = max(maxLatencyS[r.origin], simNow / 1000 - r.uptime_s);
  }
});
SimRadio radios[kNodes];
Mesh* meshes[kNodes];

int passes = 0, fails = 0;

void check(bool ok, const char* fmt, ...) {
  char buf[160];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(buf, sizeof(buf), fmt, ap);
  va_end(ap);
  Serial.printf("%s: %s\n", ok ? "PASS" : "FAIL", buf);
  (ok ? passes : fails)++;
}

void connect(int a, int b, bool on) { link[a][b] = link[b][a] = on; }
void disconnectAll() { memset(link, 0, sizeof(link)); }
void connectOneWay(int from, int to) { link[from][to] = true; }

void deliver() {
  for (size_t i = 0; i < air.size();) {
    Frame& f = air[i];
    if (f.at > simNow) {
      i++;
      continue;
    }
    for (int j = 0; j < kNodes; j++) {
      if (j == f.from || !alive[j] || !link[f.from][j]) continue;
      if (esp_random() % 100 < kLossPct) continue;
      meshes[j]->receive(f.bytes.data(), f.bytes.size(), simNow);
    }
    air.erase(air.begin() + i);
  }
}

void run(uint32_t ms) {
  static uint32_t nextGen = 0, nextAck = 0;
  uint32_t end = simNow + ms;
  while (simNow < end) {
    simNow += kTick;
    deliver();
    for (int i = 0; i < kNodes; i++) {
      if (alive[i]) meshes[i]->loop(simNow);
    }
    if (generating && simNow >= nextGen) {
      nextGen = simNow + kGenEvery;
      for (int i = 0; i < kBuoys; i++) {
        if (!alive[i]) continue;
        Record r = {};
        r.uptime_s = simNow / 1000;
        stores[i].appendOwn(&r);
      }
    }
    // The laptop commits and acks every 500 ms, like tools/collector.py.
    if (sink.started && simNow >= nextAck) {
      nextAck = simNow + 500;
      for (auto& kv : got) sink.ack(kv.first, *kv.second.rbegin() + 1);
    }
    if (simNow % 1000 == 0) yield();
  }
}

uint32_t ownNext(int i) {
  OriginState s;
  return stores[i].state(kIds[i], s) ? s.next : 0;
}

void printAll() {
  for (int i = 0; i < kBuoys; i++) {
    Serial.printf("-- buoy %s%s\n", kNames[i], alive[i] ? "" : " (off)");
    stores[i].printStatus(Serial);
  }
}

// Every live buoy holds every origin's full history.
void checkReplicated() {
  for (int i = 0; i < kBuoys; i++) {
    if (!alive[i]) continue;
    for (int o = 0; o < kBuoys; o++) {
      if (!alive[o]) continue;
      OriginState s;
      bool has = stores[i].state(kIds[o], s);
      check(has && s.first == 0 && s.next == ownNext(o), "%s holds %s's records [0,%lu) (has [%lu,%lu))",
            kNames[i], kNames[o], (unsigned long)ownNext(o), (unsigned long)(has ? s.first : 0),
            (unsigned long)(has ? s.next : 0));
    }
  }
}

void checkCollected() {
  for (int o = 0; o < kBuoys; o++) {
    if (ownNext(o) == 0) continue;
    auto& seqs = got[kIds[o]];
    uint32_t want = ownNext(o);
    bool complete = seqs.size() == want && (want == 0 || *seqs.rbegin() == want - 1);
    check(complete, "laptop has all %lu of %s's records (got %u)", (unsigned long)want, kNames[o],
          (unsigned)seqs.size());
    check(emitted[kIds[o]] == seqs.size(), "no duplicate records from %s (%lu emitted)", kNames[o],
          (unsigned long)emitted[kIds[o]]);
  }
}

// A late joiner caught up on everything not yet delivered, and vice versa.
void checkLateJoiner(int d) {
  for (int o = 0; o < kBuoys; o++) {
    if (o == d || !alive[o]) continue;
    OriginState s;
    bool has = stores[d].state(kIds[o], s);
    check(has && s.next == ownNext(o), "%s caught up on %s's records to %lu (has [%lu,%lu))", kNames[d], kNames[o],
          (unsigned long)ownNext(o), (unsigned long)(has ? s.first : 0), (unsigned long)(has ? s.next : 0));
    has = stores[o].state(kIds[d], s);
    check(has && s.first == 0 && s.next == ownNext(d), "%s holds all of %s's records [0,%lu)", kNames[o], kNames[d],
          (unsigned long)ownNext(d));
  }
}

// Acks reached the live buoys and they deleted what the laptop has.
void checkPruned() {
  for (int i = 0; i < kBuoys; i++) {
    if (!alive[i]) continue;
    for (int o = 0; o < kBuoys; o++) {
      OriginState s;
      if (!stores[i].state(kIds[o], s)) continue;
      check(s.acked == ownNext(o) && s.first == s.next, "%s pruned %s's data (acked %lu, holds [%lu,%lu))",
            kNames[i], kNames[o], (unsigned long)s.acked, (unsigned long)s.first, (unsigned long)s.next);
    }
  }
}

void checkReload(int i, const char* root) {
  OriginState before[MAX_ORIGINS], after[MAX_ORIGINS];
  size_t nb = stores[i].states(before, MAX_ORIGINS);
  Store fresh;
  fresh.begin(kIds[i], root);
  size_t na = fresh.states(after, MAX_ORIGINS);
  bool same = na == nb;
  for (size_t k = 0; same && k < na; k++) {
    // acked is only persisted when it prunes, so compare what's held.
    same = before[k].origin == after[k].origin && before[k].first == after[k].first &&
           before[k].next == after[k].next;
  }
  check(same, "%s's store reloads from flash identically (%u origins)", kNames[i], (unsigned)na);
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== mesh simulation ===");
  LittleFS.begin(true);
  LittleFS.format();

  char roots[kBuoys][8];
  for (int i = 0; i < kBuoys; i++) {
    snprintf(roots[i], sizeof(roots[i]), "/s%d", i);
    stores[i].begin(kIds[i], roots[i]);
  }
  for (int i = 0; i < kNodes; i++) {
    radios[i].idx = i;
    alive[i] = true;
    meshes[i] = new Mesh(i == kCol ? static_cast<MeshNode*>(&sink) : &stores[i], kIds[i], &radios[i]);
  }
  alive[kCol] = false;
  alive[3] = false;
  uint32_t t0 = millis();

  Serial.println("phase 1: line A-B-C, 300 s of sampling, 20% frame loss");
  connect(0, 1, true);
  connect(1, 2, true);
  generating = true;
  run(300000);
  generating = false;
  run(60000);
  printAll();
  checkReplicated();

  Serial.println("phase 2: A powered off; collector reaches only C; B, C keep sampling");
  alive[0] = false;
  alive[kCol] = true;
  connect(2, kCol, true);
  sink.started = true;
  generating = true;
  run(60000);
  generating = false;
  run(60000);
  printAll();
  checkCollected();
  checkPruned();

  Serial.println("phase 3: collector leaves; D joins next to B after pruning; B, C, D sample");
  alive[kCol] = false;
  alive[3] = true;
  connect(3, 1, true);
  generating = true;
  run(60000);
  generating = false;
  run(60000);
  printAll();
  checkLateJoiner(3);

  Serial.println("phase 4: collector returns, reaching only D");
  connect(2, kCol, false);
  connect(3, kCol, true);
  alive[kCol] = true;
  run(90000);
  printAll();
  checkCollected();
  checkPruned();

  Serial.println("phase 5: reload stores from flash");
  checkReload(1, roots[1]);
  checkReload(2, roots[2]);
  checkReload(3, roots[3]);

  // Seen on hardware: the collector skipped records that a neighbor still
  // held, because that neighbor was still booting when the gap showed up.
  Serial.println("phase 6: C's flash is wiped; the collector first hears only C, B (holding C's old records) boots 10 s late");
  alive[kCol] = false;
  alive[3] = false;
  generating = true;
  run(20000);
  generating = false;
  run(20000);
  uint32_t cNext = ownNext(2);
  stores[2].~Store();
  new (&stores[2]) Store();
  stores[2].begin(kIds[2], "/s2w");
  run(12000);
  check(ownNext(2) == cNext, "wiped C resumed its seq from B (%lu, want %lu)", (unsigned long)ownNext(2),
        (unsigned long)cNext);
  alive[1] = false;
  connect(3, kCol, false);
  connect(2, kCol, true);
  delete meshes[kCol];  // collector boots fresh
  meshes[kCol] = new Mesh(&sink, kIds[kCol], &radios[kCol]);
  alive[kCol] = true;
  generating = true;
  run(10000);
  alive[1] = true;
  connect(1, kCol, true);
  run(20000);
  generating = false;
  run(60000);
  printAll();
  checkCollected();

  // Multi-hop while the origins are live: A's records have to cross B, C and
  // D, and the laptop's acks have to travel back the same way.
  Serial.println("phase 7: live chain A-B-C-D-collector, only D hears the collector, all four sample");
  disconnectAll();
  for (int i = 0; i < kNodes; i++) alive[i] = true;
  connect(0, 1, true);
  connect(1, 2, true);
  connect(2, 3, true);
  connect(3, kCol, true);
  latencyFrom = simNow / 1000;
  generating = true;
  run(120000);
  generating = false;
  run(90000);
  printAll();
  checkCollected();
  checkPruned();
  for (int o = 0; o < kBuoys; o++) {
    Serial.printf("latency %s -> laptop over %d hops: max %lus\n", kNames[o], kBuoys - o,
                  (unsigned long)maxLatencyS[kIds[o]]);
  }
  check(maxLatencyS[kIds[0]] > 0 && maxLatencyS[kIds[0]] <= 90, "A's live records crossed 4 hops within 90 s (max %lus)",
        (unsigned long)maxLatencyS[kIds[0]]);

  // A hears the collector and serves it directly, but those frames never
  // arrive; B overhears them and must not assume the collector got them.
  Serial.println("phase 8: one-way link, A hears the collector but not vice versa; B relays");
  disconnectAll();
  alive[2] = alive[3] = false;
  connect(0, 1, true);
  connect(1, kCol, true);
  connectOneWay(kCol, 0);
  latencyFrom = simNow / 1000;
  maxLatencyS.clear();
  generating = true;
  run(120000);
  generating = false;
  run(90000);
  printAll();
  checkCollected();
  Serial.printf("latency A -> laptop via B: max %lus\n", (unsigned long)maxLatencyS[kIds[0]]);
  check(maxLatencyS[kIds[0]] > 0 && maxLatencyS[kIds[0]] <= 90, "A's records got through B within 90 s (max %lus)",
        (unsigned long)maxLatencyS[kIds[0]]);
  LittleFS.format();  // don't leave test data behind for the buoy firmware

  Serial.printf("SIM DONE pass=%d fail=%d (virtual %lus in %lus real)\n", passes, fails,
                (unsigned long)(simNow / 1000), (unsigned long)((millis() - t0) / 1000));
}

void loop() { delay(1000); }
