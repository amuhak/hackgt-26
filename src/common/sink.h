// The collector's mesh node. It stores nothing: it advertises how far the
// laptop has got per origin, so buoys push whatever the laptop lacks, and hands
// each new record to `emit`.
#pragma once
#include <Arduino.h>

#include <functional>

#include "mesh.h"

class CollectorSink : public MeshNode {
 public:
  explicit CollectorSink(std::function<void(const Record&)> emit) : emit_(emit) {}

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

  void ingest(const Record* recs, size_t n, uint32_t senderFirst) override {
    if (!started) return;
    OriginState* s = find(recs[0].origin);
    if (!s) s = create(recs[0].origin);
    if (!s) return;
    // Records older than the sender's oldest are gone from it: skip to that.
    if (senderFirst > s->next) s->first = s->next = senderFirst;
    for (size_t i = 0; i < n; i++) {
      if (recs[i].seq < s->next) continue;
      // Any other gap is a lost frame: wait for a resend from our `next`.
      if (recs[i].seq != s->next) return;
      emit_(recs[i]);
      s->first = s->next = recs[i].seq + 1;
    }
  }

  void peerState(const OriginState&) override {}
  bool advertise() override { return started; }
  bool sink() override { return true; }

  // The laptop already has everything below `next`.
  void have(uint32_t origin, uint32_t next) {
    OriginState* s = find(origin);
    if (!s) s = create(origin);
    if (!s) return;
    s->first = s->next = next;
    s->acked = max(s->acked, next);
  }

  // The laptop committed everything below `next`; buoys may delete it.
  void ack(uint32_t origin, uint32_t next) {
    OriginState* s = find(origin);
    if (s) s->acked = max(s->acked, next);
  }

  // The laptop lost a line: go back to what it has committed.
  void rewind() {
    for (size_t i = 0; i < count_; i++) table_[i].first = table_[i].next = table_[i].acked;
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

  std::function<void(const Record&)> emit_;
  OriginState table_[MAX_ORIGINS];  // first == next == what the laptop has
  size_t count_ = 0;
};
