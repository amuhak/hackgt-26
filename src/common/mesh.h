// ESP-NOW gossip mesh. Every node periodically broadcasts a SUMMARY of which
// records it holds per origin; any node holding records a neighbor lacks
// broadcasts them as DATA. Records therefore spread to every node, and the
// laptop-side collector can pull the whole fleet's data from any one buoy.
#pragma once
#include "proto.h"

// Implemented by the buoy's flash store and by the collector's serial sink.
class MeshNode {
 public:
  virtual ~MeshNode() {}
  // All known origins, sorted by origin id.
  virtual size_t states(OriginState* out, size_t max) = 0;
  virtual bool state(uint32_t origin, OriginState& out) = 0;
  // Consecutive records of `origin` starting at `seq`; returns how many.
  virtual size_t read(uint32_t origin, uint32_t seq, Record* out, size_t max) = 0;
  // Records heard on the radio. `senderFirst` = sender's lowest held seq.
  virtual void ingest(const Record* recs, size_t n, uint32_t senderFirst) = 0;
  // One entry of a neighbor's summary.
  virtual void peerState(const OriginState& s) = 0;
  // False keeps this node silent (collector before the laptop is attached).
  virtual bool advertise() { return true; }
};

namespace mesh {
bool begin(MeshNode* node, uint32_t selfId);
void loop();  // call often from the Arduino loop
uint32_t selfId();  // low 4 bytes of the Wi-Fi MAC; valid before begin()
}  // namespace mesh
