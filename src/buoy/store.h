// Flash store for every origin's records (our own plus those gossiped to us).
// Layout: /o/<origin hex>/<seq/256>.bin holds records at offset (seq%256)*42,
// and /o/<origin hex>/meta holds {first, next, acked}.
#pragma once
#include <Print.h>
#include "../common/mesh.h"

class Store : public MeshNode {
 public:
  bool begin(uint32_t selfId);
  // Assigns origin/seq to one of our own readings and stores it.
  bool appendOwn(Record& r);
  void printStatus(Print& out);

  size_t states(OriginState* out, size_t max) override;
  bool state(uint32_t origin, OriginState& out) override;
  size_t read(uint32_t origin, uint32_t seq, Record* out, size_t max) override;
  void ingest(const Record* recs, size_t n, uint32_t senderFirst) override;
  void peerState(const OriginState& s) override;

 private:
  OriginState* find(uint32_t origin);
  OriginState* create(uint32_t origin, uint32_t start);
  void load(uint32_t origin, const char* dir);
  bool write(OriginState& s, const Record* r, size_t n);
  void prune(OriginState& s);
  void restartAt(OriginState& s, uint32_t seq);
  void deleteSegments(const OriginState& s, uint32_t fromSeg, uint32_t toSeg);
  void ensureSpace();
  void saveMeta(const OriginState& s);

  OriginState table_[MAX_ORIGINS];  // sorted by origin
  size_t count_ = 0;
  uint32_t self_ = 0;
};
