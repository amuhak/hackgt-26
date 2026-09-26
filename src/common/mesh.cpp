#include "mesh.h"

#include <Arduino.h>

Mesh::Mesh(MeshNode* node, uint32_t selfId, Radio* radio) : node_(node), self_(selfId), radio_(radio) {
  nextSummaryAt_ = random(1000);
}

void Mesh::fillHeader(MsgHeader& h, MsgType type, uint8_t count) {
  h.magic = MSG_MAGIC;
  h.type = type;
  h.version = MSG_VERSION;
  h.count = count;
  h.sender = self_;
}

void Mesh::noteAvail(uint32_t origin, uint32_t from) {
  for (size_t i = 0; i < availCount_; i++) {
    if (avail_[i].origin == origin) {
      avail_[i].cur = min(avail_[i].cur, from);
      return;
    }
  }
  if (availCount_ < MAX_ORIGINS) avail_[availCount_++] = {origin, from, UINT32_MAX};
}

uint32_t Mesh::availFrom(uint32_t origin) {
  for (size_t i = 0; i < availCount_; i++) {
    if (avail_[i].origin == origin) return min(avail_[i].cur, avail_[i].prev);
  }
  return UINT32_MAX;
}

Mesh::Want* Mesh::findWant(uint32_t origin, bool create) {
  Want* freeSlot = nullptr;
  for (auto& w : wants_) {
    if (w.active && w.origin == origin) return &w;
    if (!w.active && !freeSlot) freeSlot = &w;
  }
  if (!create || !freeSlot) return nullptr;
  *freeSlot = {origin, 0, 0, false};
  return freeSlot;
}

// Sends one page of our summary. Returns false when the round is finished.
bool Mesh::sendSummaryPage(int page) {
  size_t n = node_->states(scratch_, MAX_ORIGINS);
  size_t pages = n == 0 ? 1 : (n + SUMMARY_MAX_ENTRIES - 1) / SUMMARY_MAX_ENTRIES;
  if ((size_t)page >= pages) return false;

  size_t begin = page * SUMMARY_MAX_ENTRIES;
  size_t count = min(n - begin, (size_t)SUMMARY_MAX_ENTRIES);
  SummaryMsg m;
  fillHeader(m.h, MSG_SUMMARY, count);
  m.lo = page == 0 ? 0 : scratch_[begin].origin;
  m.hi = (size_t)page == pages - 1 ? UINT32_MAX : scratch_[begin + count].origin - 1;
  memcpy(m.e, scratch_ + begin, count * sizeof(OriginState));
  radio_->send(&m, offsetof(SummaryMsg, e) + count * sizeof(OriginState));
  return true;
}

// Our summary for a single origin, so neighbors rewind to our `next` now
// rather than at our next full summary.
void Mesh::sendNack(uint32_t origin) {
  SummaryMsg m;
  fillHeader(m.h, MSG_SUMMARY, 1);
  m.lo = m.hi = origin;
  if (!node_->state(origin, m.e[0])) return;
  if (radio_->send(&m, offsetof(SummaryMsg, e) + sizeof(OriginState))) counters.nacksSent++;
}

void Mesh::onSummary(const SummaryMsg& m, uint32_t now) {
  for (size_t i = 0; i < m.h.count; i++) {
    const OriginState& e = m.e[i];
    node_->peerState(e);
    uint32_t sendable = max(e.first, e.acked);
    if (sendable < e.next) noteAvail(e.origin, sendable);
  }

  // Anything we hold in [lo, hi] that the peer lacks (or doesn't list at all)
  // becomes a want.
  size_t n = node_->states(scratch_, MAX_ORIGINS);
  for (size_t i = 0; i < n; i++) {
    const OriginState& s = scratch_[i];
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

void Mesh::onData(const DataMsg& m, uint32_t now) {
  if (m.h.count == 0) return;
  uint32_t origin = m.r[0].origin;
  uint32_t seq = m.r[0].seq;
  for (size_t i = 1; i < m.h.count; i++) {
    if (m.r[i].origin != origin || m.r[i].seq != seq + i) return;  // malformed
  }
  counters.dataHeard++;
  // Skip a gap only if no neighbor we've heard lately can fill it, not just
  // this sender (which may have evicted records others still hold).
  noteAvail(origin, m.first);
  node_->ingest(m.r, m.h.count, min(m.first, availFrom(origin)));

  // Still behind this frame means we missed one before it: ask for a resend.
  OriginState s;
  if (node_->advertise() && node_->state(origin, s) && s.next < seq && now - lastNackAt_ >= NACK_MIN_MS) {
    nackPending_ = true;
    nackOrigin_ = origin;
  }

  // Someone else just served this range to the neighborhood; skip past it.
  Want* w = findWant(origin, false);
  if (w && w->from >= seq && w->from < seq + m.h.count) w->from = seq + m.h.count;
}

void Mesh::receive(const uint8_t* data, size_t len, uint32_t now) {
  if (len < sizeof(MsgHeader)) return;
  MsgHeader h;
  memcpy(&h, data, sizeof(h));
  if (h.magic != MSG_MAGIC || h.version != MSG_VERSION || h.sender == self_) return;

  if (h.type == MSG_SUMMARY && h.count <= SUMMARY_MAX_ENTRIES &&
      len >= offsetof(SummaryMsg, e) + h.count * sizeof(OriginState)) {
    SummaryMsg m;
    memcpy(&m, data, min(len, sizeof(m)));
    onSummary(m, now);
  } else if (h.type == MSG_DATA && h.count <= DATA_MAX_RECORDS &&
             len >= offsetof(DataMsg, r) + h.count * sizeof(Record)) {
    DataMsg m;
    memcpy(&m, data, min(len, sizeof(m)));
    onData(m, now);
  }
}

void Mesh::serveData(uint32_t now) {
  if (now - lastDataAt_ < DATA_GAP_MS || !radio_->ready()) return;

  for (size_t step = 0; step < MAX_ORIGINS; step++) {
    size_t idx = (wantCursor_ + step) % MAX_ORIGINS;
    Want& w = wants_[idx];
    if (!w.active) continue;
    OriginState s;
    if (now - w.heardAt > WANT_TIMEOUT_MS || !node_->state(w.origin, s)) {
      w.active = false;
      continue;
    }
    uint32_t from = max(w.from, max(s.first, s.acked));
    DataMsg m;
    uint32_t t0 = micros();
    size_t n = from < s.next ? node_->read(w.origin, from, m.r, DATA_MAX_RECORDS) : 0;
    counters.readUsMax = max(counters.readUsMax, (uint32_t)(micros() - t0));
    if (n == 0) {
      w.active = false;
      continue;
    }
    fillHeader(m.h, MSG_DATA, n);
    m.first = max(s.first, s.acked);  // oldest we'll ever send
    if (radio_->send(&m, offsetof(DataMsg, r) + n * sizeof(Record))) {
      counters.dataSent++;
      w.from = from + n;
      lastDataAt_ = now;
      wantCursor_ = idx + 1;  // round-robin across origins
    }
    return;
  }
}

void Mesh::loop(uint32_t now) {
  if (now - availRotatedAt_ >= 2 * SUMMARY_INTERVAL_MS) {
    availRotatedAt_ = now;
    for (size_t i = 0; i < availCount_; i++) {
      avail_[i].prev = avail_[i].cur;
      avail_[i].cur = UINT32_MAX;
    }
  }
  if ((int32_t)(now - nextSummaryAt_) >= 0) {
    nextSummaryAt_ = now + SUMMARY_INTERVAL_MS + random(1000);
    if (node_->advertise()) summaryPage_ = 0;
  }
  // NACKs and summary pages take priority over data.
  if (nackPending_) {
    if (radio_->ready()) {
      sendNack(nackOrigin_);
      nackPending_ = false;
      lastNackAt_ = now;
    }
    return;
  }
  if (summaryPage_ >= 0) {
    if (radio_->ready()) summaryPage_ = sendSummaryPage(summaryPage_) ? summaryPage_ + 1 : -1;
    return;
  }
  serveData(now);
}
