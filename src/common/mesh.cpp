#include "mesh.h"

#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#if __has_include(<esp_mac.h>)
#include <esp_mac.h>
#endif

namespace mesh {
namespace {

struct Packet {
  uint8_t len;
  uint8_t data[250];
};

// A neighbor is missing records of `origin` from `from` onward; we serve them
// in DATA bursts until caught up or the neighbor goes quiet.
struct Want {
  uint32_t origin;
  uint32_t from;
  uint32_t heardAt;
  bool active;
};

const uint8_t kBroadcast[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};

MeshNode* node = nullptr;
uint32_t self = 0;
QueueHandle_t rxQueue;
volatile bool txBusy = false;
uint32_t txStartedAt = 0;

uint32_t nextSummaryAt = 0;
int summaryPage = -1;  // next page to send this round, -1 = idle
uint32_t lastDataAt = 0;

Want wants[MAX_ORIGINS];
size_t wantCursor = 0;

OriginState scratch[MAX_ORIGINS];  // loop-only scratch for states()

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onRecv(const esp_now_recv_info_t*, const uint8_t* data, int len) {
#else
void onRecv(const uint8_t*, const uint8_t* data, int len) {
#endif
  // Runs in the Wi-Fi task: copy out and handle on the main loop.
  if (len <= 0 || len > 250) return;
  Packet p;
  p.len = len;
  memcpy(p.data, data, len);
  xQueueSend(rxQueue, &p, 0);
}

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 5, 0)
void onSent(const wifi_tx_info_t*, esp_now_send_status_t) { txBusy = false; }
#else
void onSent(const uint8_t*, esp_now_send_status_t) { txBusy = false; }
#endif

bool txReady() {
  // Guard against a lost send callback wedging the radio forever.
  return !txBusy || millis() - txStartedAt > 100;
}

bool send(const void* buf, size_t len) {
  if (!txReady()) return false;
  txBusy = true;
  txStartedAt = millis();
  if (esp_now_send(kBroadcast, static_cast<const uint8_t*>(buf), len) != ESP_OK) {
    txBusy = false;
    return false;
  }
  return true;
}

void fillHeader(MsgHeader& h, MsgType type, uint8_t count) {
  h.magic = MSG_MAGIC;
  h.type = type;
  h.version = MSG_VERSION;
  h.count = count;
  h.sender = self;
}

Want* findWant(uint32_t origin, bool create) {
  Want* freeSlot = nullptr;
  for (auto& w : wants) {
    if (w.active && w.origin == origin) return &w;
    if (!w.active && !freeSlot) freeSlot = &w;
  }
  if (!create || !freeSlot) return nullptr;
  *freeSlot = {origin, 0, 0, false};
  return freeSlot;
}

// Sends one page of our summary. Returns false when the round is finished.
bool sendSummaryPage(int page) {
  size_t n = node->states(scratch, MAX_ORIGINS);
  size_t pages = n == 0 ? 1 : (n + SUMMARY_MAX_ENTRIES - 1) / SUMMARY_MAX_ENTRIES;
  if ((size_t)page >= pages) return false;

  size_t begin = page * SUMMARY_MAX_ENTRIES;
  size_t count = min(n - begin, (size_t)SUMMARY_MAX_ENTRIES);
  SummaryMsg m;
  fillHeader(m.h, MSG_SUMMARY, count);
  m.lo = page == 0 ? 0 : scratch[begin].origin;
  m.hi = (size_t)page == pages - 1 ? UINT32_MAX : scratch[begin + count].origin - 1;
  memcpy(m.e, scratch + begin, count * sizeof(OriginState));
  send(&m, offsetof(SummaryMsg, e) + count * sizeof(OriginState));
  return true;
}

void onSummary(const SummaryMsg& m) {
  for (size_t i = 0; i < m.h.count; i++) node->peerState(m.e[i]);

  // Anything we hold in [lo, hi] that the peer lacks (or doesn't list at all)
  // becomes a want.
  uint32_t now = millis();
  size_t n = node->states(scratch, MAX_ORIGINS);
  for (size_t i = 0; i < n; i++) {
    const OriginState& s = scratch[i];
    if (s.origin < m.lo || s.origin > m.hi || s.first >= s.next) continue;
    uint32_t peerNext = 0;
    for (size_t k = 0; k < m.h.count; k++) {
      if (m.e[k].origin == s.origin) {
        peerNext = m.e[k].next;
        break;
      }
    }
    uint32_t from = max(peerNext, max(s.first, s.acked));
    if (from >= s.next) continue;
    Want* w = findWant(s.origin, true);
    if (!w) continue;
    if (!w->active || from < w->from) w->from = from;
    w->active = true;
    w->heardAt = now;
  }
}

void onData(const DataMsg& m) {
  if (m.h.count == 0) return;
  uint32_t origin = m.r[0].origin;
  uint32_t seq = m.r[0].seq;
  for (size_t i = 1; i < m.h.count; i++) {
    if (m.r[i].origin != origin || m.r[i].seq != seq + i) return;  // malformed
  }
  node->ingest(m.r, m.h.count, m.first);

  // Someone else just served this range to the neighborhood; skip past it.
  Want* w = findWant(origin, false);
  if (w && w->from >= seq && w->from < seq + m.h.count) w->from = seq + m.h.count;
}

void handle(const Packet& p) {
  if (p.len < sizeof(MsgHeader)) return;
  MsgHeader h;
  memcpy(&h, p.data, sizeof(h));
  if (h.magic != MSG_MAGIC || h.version != MSG_VERSION || h.sender == self) return;

  if (h.type == MSG_SUMMARY && h.count <= SUMMARY_MAX_ENTRIES &&
      p.len >= offsetof(SummaryMsg, e) + h.count * sizeof(OriginState)) {
    SummaryMsg m;
    memcpy(&m, p.data, min((size_t)p.len, sizeof(m)));
    onSummary(m);
  } else if (h.type == MSG_DATA && h.count <= DATA_MAX_RECORDS &&
             p.len >= offsetof(DataMsg, r) + h.count * sizeof(Record)) {
    DataMsg m;
    memcpy(&m, p.data, min((size_t)p.len, sizeof(m)));
    onData(m);
  }
}

void serveData() {
  uint32_t now = millis();
  if (now - lastDataAt < DATA_GAP_MS || !txReady()) return;

  for (size_t step = 0; step < MAX_ORIGINS; step++) {
    size_t idx = (wantCursor + step) % MAX_ORIGINS;
    Want& w = wants[idx];
    if (!w.active) continue;
    OriginState s;
    if (now - w.heardAt > WANT_TIMEOUT_MS || !node->state(w.origin, s)) {
      w.active = false;
      continue;
    }
    uint32_t from = max(w.from, max(s.first, s.acked));
    DataMsg m;
    size_t n = from < s.next ? node->read(w.origin, from, m.r, DATA_MAX_RECORDS) : 0;
    if (n == 0) {
      w.active = false;
      continue;
    }
    fillHeader(m.h, MSG_DATA, n);
    m.first = s.first;
    if (send(&m, offsetof(DataMsg, r) + n * sizeof(Record))) {
      w.from = from + n;
      lastDataAt = now;
      wantCursor = idx + 1;  // round-robin across origins
    }
    return;
  }
}

}  // namespace

uint32_t selfId() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  return (uint32_t)mac[2] << 24 | (uint32_t)mac[3] << 16 | (uint32_t)mac[4] << 8 | mac[5];
}

bool begin(MeshNode* n, uint32_t id) {
  node = n;
  self = id;
  rxQueue = xQueueCreate(24, sizeof(Packet));

  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_ps(WIFI_PS_NONE);  // modem sleep would drop broadcasts
#if MESH_LONG_RANGE
  if (esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_LR) != ESP_OK) {
    Serial.println("mesh: failed to enable long-range mode");
  }
#endif
  esp_wifi_set_channel(MESH_CHANNEL, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_max_tx_power(84);  // 21 dBm, the maximum

  if (esp_now_init() != ESP_OK) {
    Serial.println("mesh: esp_now_init failed");
    return false;
  }
  esp_now_register_recv_cb(onRecv);
  esp_now_register_send_cb(onSent);

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, kBroadcast, 6);
  peer.channel = MESH_CHANNEL;
  peer.ifidx = WIFI_IF_STA;
  peer.encrypt = false;
  if (esp_now_add_peer(&peer) != ESP_OK) {
    Serial.println("mesh: failed to add broadcast peer");
    return false;
  }
  nextSummaryAt = millis() + random(1000);
  return true;
}

void loop() {
  Packet p;
  while (xQueueReceive(rxQueue, &p, 0) == pdTRUE) handle(p);

  uint32_t now = millis();
  if ((int32_t)(now - nextSummaryAt) >= 0) {
    nextSummaryAt = now + SUMMARY_INTERVAL_MS + random(1000);
    if (node->advertise()) summaryPage = 0;
  }
  // Summary pages take priority over data.
  if (summaryPage >= 0) {
    if (txReady()) summaryPage = sendSummaryPage(summaryPage) ? summaryPage + 1 : -1;
    return;
  }
  serveData();
}

}  // namespace mesh
