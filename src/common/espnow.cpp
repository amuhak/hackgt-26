#include <Arduino.h>
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#if __has_include(<esp_mac.h>)
#include <esp_mac.h>
#endif

#include "mesh.h"

namespace espnow {
namespace {

struct Packet {
  uint8_t len;
  uint8_t data[250];
};

const uint8_t kBroadcast[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
QueueHandle_t rxQueue;
volatile bool txBusy = false;
uint32_t txStartedAt = 0;

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
    if (esp_now_send(kBroadcast, static_cast<const uint8_t*>(buf), len) != ESP_OK) {
      txBusy = false;
      return false;
    }
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
  return true;
}

Radio* radio() { return &theRadio; }

void poll(Mesh& mesh) {
  Packet p;
  while (xQueueReceive(rxQueue, &p, 0) == pdTRUE) mesh.receive(p.data, p.len, millis());
}

}  // namespace espnow

uint32_t selfId() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  return (uint32_t)mac[2] << 24 | (uint32_t)mac[3] << 16 | (uint32_t)mac[4] << 8 | mac[5];
}
