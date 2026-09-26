#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#if __has_include(<esp_mac.h>)
#include <esp_mac.h>
#endif

#include "dlog.h"
#include "mesh.h"

namespace espnow {
namespace {

struct Packet {
  uint8_t len;
  int8_t rssi;  // 0 = unknown
  uint8_t data[250];
};

const uint8_t kBroadcast[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
QueueHandle_t rxQueue;
volatile bool txBusy = false;
uint32_t txStartedAt = 0;
Stats counters = {};
volatile int8_t lastRssi = 0;

#ifdef DEBUG_LOG
// The ESP-NOW receive callback doesn't report RSSI; sniff it from the same
// frame in promiscuous mode, which runs just before it in the Wi-Fi task.
void onPromisc(void* buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_MGMT) return;
  auto* p = static_cast<const wifi_promiscuous_pkt_t*>(buf);
  const uint8_t* f = p->payload;
  // Action frame, vendor-specific category, Espressif OUI.
  if (p->rx_ctrl.sig_len < 28 || f[0] != 0xd0 || f[24] != 127 || f[25] != 0x18 || f[26] != 0xfe || f[27] != 0x34) {
    return;
  }
  lastRssi = p->rx_ctrl.rssi;
}

void logFrame(const char* dir, const uint8_t* d, size_t len, int rssi) {
  MsgHeader h;
  if (len < sizeof(h)) {
    Serial.printf("%s short frame, %u bytes\n", dir, (unsigned)len);
    return;
  }
  memcpy(&h, d, sizeof(h));
  if (h.magic != MSG_MAGIC || h.version != MSG_VERSION) {
    Serial.printf("%s foreign frame, %u bytes, magic 0x%02x version %u\n", dir, (unsigned)len, h.magic, h.version);
    return;
  }
  const char* type = h.type == MSG_DATA ? "DATA" : h.type == MSG_SINK_SUMMARY ? "SINK-SUMMARY" : "SUMMARY";
  Serial.printf("%s %s from %08lx, %u bytes", dir, type, (unsigned long)h.sender, (unsigned)len);
  if (rssi) Serial.printf(", rssi %d dBm", rssi);
  if (h.type == MSG_DATA && h.count > 0 && len >= offsetof(DataMsg, r) + h.count * sizeof(Record)) {
    DataMsg m;
    memcpy(&m, d, min(len, sizeof(m)));
    Serial.printf(": %08lx seq %lu..%lu (sender first %lu)", (unsigned long)m.r[0].origin, (unsigned long)m.r[0].seq,
                  (unsigned long)(m.r[0].seq + h.count - 1), (unsigned long)m.first);
  } else if (h.type != MSG_DATA && h.count <= SUMMARY_MAX_ENTRIES &&
             len >= offsetof(SummaryMsg, e) + h.count * sizeof(OriginState)) {
    SummaryMsg m;
    memcpy(&m, d, min(len, sizeof(m)));
    Serial.print(":");
    for (size_t i = 0; i < h.count; i++) {
      const OriginState& e = m.e[i];
      Serial.printf(" %08lx[%lu,%lu) acked %lu", (unsigned long)e.origin, (unsigned long)e.first,
                    (unsigned long)e.next, (unsigned long)e.acked);
    }
  }
  Serial.println();
}
#endif

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onRecv(const esp_now_recv_info_t*, const uint8_t* data, int len) {
#else
void onRecv(const uint8_t*, const uint8_t* data, int len) {
#endif
  // Runs in the Wi-Fi task: copy out and handle on the main loop.
  if (len <= 0 || len > 250) return;
  Packet p;
  p.len = len;
  p.rssi = lastRssi;
  memcpy(p.data, data, len);
  if (xQueueSend(rxQueue, &p, 0) == pdTRUE) counters.rxFrames++;
  else counters.rxDropped++;
}

#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 5, 0)
void onSent(const wifi_tx_info_t*, esp_now_send_status_t st) {
#else
void onSent(const uint8_t*, esp_now_send_status_t st) {
#endif
  if (st != ESP_NOW_SEND_SUCCESS) counters.txFailed++;  // logged via STAT; this runs in the Wi-Fi task
  txBusy = false;
}

class EspNowRadio : public Radio {
 public:
  bool ready() override {
    // Guard against a lost send callback wedging the radio forever.
    return !txBusy || millis() - txStartedAt > 100;
  }

  bool send(const void* buf, size_t len) override {
    if (!ready()) return false;
    txBusy = true;
    txStartedAt = millis();
    esp_err_t err = esp_now_send(kBroadcast, static_cast<const uint8_t*>(buf), len);
    if (err != ESP_OK) {
      txBusy = false;
      counters.txFailed++;
      DLOG("tx FAILED: %s\n", esp_err_to_name(err));
      return false;
    }
    counters.txFrames++;
#ifdef DEBUG_LOG
    logFrame("tx", static_cast<const uint8_t*>(buf), len, 0);
#endif
    return true;
  }
};

EspNowRadio theRadio;

}  // namespace

bool begin() {
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
#ifdef DEBUG_LOG
  wifi_promiscuous_filter_t filter = {WIFI_PROMIS_FILTER_MASK_MGMT};
  esp_wifi_set_promiscuous_filter(&filter);
  esp_wifi_set_promiscuous_rx_cb(onPromisc);
  if (esp_wifi_set_promiscuous(true) != ESP_OK) Serial.println("mesh: no RSSI (promiscuous mode failed)");
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  Serial.printf("mesh: ESP-NOW up, channel %d, %s, mac %02x:%02x:%02x:%02x:%02x:%02x\n", MESH_CHANNEL,
                MESH_LONG_RANGE ? "long-range PHY" : "standard PHY", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
#endif
  return true;
}

Radio* radio() { return &theRadio; }

const Stats& stats() { return counters; }

void poll(Mesh& mesh) {
  Packet p;
  while (xQueueReceive(rxQueue, &p, 0) == pdTRUE) {
#ifdef DEBUG_LOG
    logFrame("rx", p.data, p.len, p.rssi);
#endif
    mesh.receive(p.data, p.len, millis());
  }
}

}  // namespace espnow

uint32_t selfId() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  return (uint32_t)mac[2] << 24 | (uint32_t)mac[3] << 16 | (uint32_t)mac[4] << 8 | mac[5];
}
