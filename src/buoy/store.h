// Flash store for every origin's records (our own plus those gossiped to us).
// Layout: <root>/<origin hex>/<seq/256>.bin holds records at offset (seq%256)*42,
// and <root>/<origin hex>/meta holds {first, next, acked}.
#pragma once
#include <Print.h>
#include "../common/mesh.h"

class Store : public MeshNode {
 public:
  // `root` lets several stores share one filesystem (mesh simulation).
  bool begin(uint32_t selfId, const char* root = "/o");
  // Assigns origin/seq to our own readings and stores them.
  bool appendOwn(Record* r, size_t n = 1);
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
  String dirPath(uint32_t origin);
  String segPath(uint32_t origin, uint32_t seg);
  String metaPath(uint32_t origin);
  bool write(OriginState& s, const Record* r, size_t n);
  void prune(OriginState& s);
  void restartAt(OriginState& s, uint32_t seq);
  void deleteSegments(const OriginState& s, uint32_t fromSeg, uint32_t toSeg);
  void ensureSpace();
  void saveMeta(const OriginState& s);

  OriginState table_[MAX_ORIGINS];  // sorted by origin
  size_t count_ = 0;
  uint32_t self_ = 0;
  String root_;
};
