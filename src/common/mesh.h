// ESP-NOW gossip mesh. Every node periodically broadcasts a SUMMARY of which
// records it holds per origin; any node holding records a neighbor lacks
// broadcasts them as DATA. Records therefore spread to every node, and the
// laptop-side collector can pull the whole fleet's data from any one buoy.
#pragma once
#include "proto.h"

// Implemented by the buoy's flash store and by the collector's sink.
class MeshNode {
 public:
  virtual ~MeshNode() {}
  // All known origins, sorted by origin id.
  virtual size_t states(OriginState* out, size_t max) = 0;
  virtual bool state(uint32_t origin, OriginState& out) = 0;
  // Consecutive records of `origin` starting at `seq`; returns how many.
  virtual size_t read(uint32_t origin, uint32_t seq, Record* out, size_t max) = 0;
  // Records heard on the radio. `senderFirst` = oldest seq the sender will send.
  virtual void ingest(const Record* recs, size_t n, uint32_t senderFirst) = 0;
  // One entry of a neighbor's summary.
  virtual void peerState(const OriginState& s) = 0;
  // False keeps this node silent (collector before the laptop is attached).
  virtual bool advertise() { return true; }
};

// Broadcast transport. ESP-NOW on hardware, simulated in the mesh test.
class Radio {
 public:
  virtual ~Radio() {}
  virtual bool ready() = 0;  // previous frame finished sending
  virtual bool send(const void* data, size_t len) = 0;
};

class Mesh {
 public:
  Mesh(MeshNode* node, uint32_t selfId, Radio* radio);
  void receive(const uint8_t* data, size_t len, uint32_t now);
  void loop(uint32_t now);  // call often

 private:
  // A neighbor is missing records of `origin` from `from` onward; we serve
  // them in DATA bursts until caught up or the neighbor goes quiet.
  struct Want {
    uint32_t origin;
    uint32_t from;
    uint32_t heardAt;
    bool active;
  };

  void fillHeader(MsgHeader& h, MsgType type, uint8_t count);
  Want* findWant(uint32_t origin, bool create);
  bool sendSummaryPage(int page);
  void sendNack(uint32_t origin);
  void onSummary(const SummaryMsg& m, uint32_t now);
  void onData(const DataMsg& m, uint32_t now);
  void serveData(uint32_t now);

  MeshNode* node_;
  uint32_t self_;
  Radio* radio_;
  uint32_t nextSummaryAt_ = 0;
  int summaryPage_ = -1;  // next page to send this round, -1 = idle
  uint32_t lastDataAt_ = 0;
  Want wants_[MAX_ORIGINS] = {};
  size_t wantCursor_ = 0;
  bool nackPending_ = false;
  uint32_t nackOrigin_ = 0;
  uint32_t lastNackAt_ = 0;
  OriginState scratch_[MAX_ORIGINS];
};

// The ESP-NOW radio. Received frames are queued from the Wi-Fi task and
// handed to the mesh by poll() on the main loop.
namespace espnow {
bool begin();
Radio* radio();
void poll(Mesh& mesh);
}  // namespace espnow

// Low 4 bytes of the Wi-Fi MAC; valid before Wi-Fi starts.
uint32_t selfId();
