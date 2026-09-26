#include "mesh.h"

#include <Arduino.h>

#include "dlog.h"

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

Mesh::Avail* Mesh::noteAvail(uint32_t origin, uint32_t from) {
  for (size_t i = 0; i < availCount_; i++) {
    if (avail_[i].origin == origin) {
      avail_[i].cur = min(avail_[i].cur, from);
      return &avail_[i];
    }
  }
  if (availCount_ == MAX_ORIGINS) return nullptr;
  avail_[availCount_] = {origin, from, UINT32_MAX, UINT32_MAX, 0};
  return &avail_[availCount_++];
}

uint32_t Mesh::availFrom(uint32_t origin) {
  for (size_t i = 0; i < availCount_; i++) {
    if (avail_[i].origin == origin) return min(avail_[i].cur, avail_[i].prev);
  }
  return UINT32_MAX;
}

// Records [lo, hi) just went out to the neighborhood: nobody waiting at a
// seq inside that range needs them again.
void Mesh::skipServed(Want& w, uint32_t lo, uint32_t hi) {
  if (w.from >= lo && w.from < hi) w.from = hi;
  if (w.sinkFrom >= lo && w.sinkFrom < hi) w.sinkFrom = hi;
}

Mesh::Want* Mesh::findWant(uint32_t origin, bool create) {
  Want* freeSlot = nullptr;
  for (auto& w : wants_) {
    bool used = w.active || w.sinkActive;
    if (used && w.origin == origin) return &w;
    if (!used && !freeSlot) freeSlot = &w;
  }
  if (!create || !freeSlot) return nullptr;
  *freeSlot = {origin, 0, 0, 0, 0, false, false};
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
  fillHeader(m.h, node_->sink() ? MSG_SINK_SUMMARY : MSG_SUMMARY, count);
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
  fillHeader(m.h, node_->sink() ? MSG_SINK_SUMMARY : MSG_SUMMARY, 1);
  m.lo = m.hi = origin;
  if (!node_->state(origin, m.e[0])) return;
  if (radio_->send(&m, offsetof(SummaryMsg, e) + sizeof(OriginState))) counters.nacksSent++;
}

void Mesh::onSummary(const SummaryMsg& m, uint32_t now, bool fromSink) {
  if (fromSink) {
    sinkSeen_ = true;
    lastSinkAt_ = now;
  }
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
    if (fromSink) {
      w->sinkFrom = from;  // the collector's position is exact
      w->sinkActive = true;
      w->sinkHeardAt = now;
    } else {
      if (!w->active || from < w->from) w->from = from;
      w->active = true;
      w->heardAt = now;
    }
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
  // Also hold off for GAP_HOLD_MS: a neighbor that still has the records may
  // just not have spoken yet (e.g. it is still booting).
  Avail* a = noteAvail(origin, m.first);
  uint32_t floor = min(m.first, availFrom(origin));
  OriginState s = {};
  node_->state(origin, s);
  bool holding = false;
  if (floor > s.next && a) {
    if (a->gapNext != s.next) {
      a->gapNext = s.next;
      a->gapSince = now;
      DLOG("mesh: %08lx gap at %lu, oldest anyone offers is %lu; holding %lus before skipping\n",
           (unsigned long)origin, (unsigned long)s.next, (unsigned long)floor, GAP_HOLD_MS / 1000);
    }
    holding = now - a->gapSince < GAP_HOLD_MS;
    if (holding) floor = 0;
    else DLOG("mesh: %08lx skipping %lu..%lu (no neighbor has them)\n", (unsigned long)origin,
              (unsigned long)s.next, (unsigned long)(floor - 1));
  }
  node_->ingest(m.r, m.h.count, floor);

  // Still behind this frame means we missed one before it: ask for a resend
  // (unless nobody we hear has it).
  if (!holding && node_->advertise() && node_->state(origin, s) && s.next < seq && now - lastNackAt_ >= NACK_MIN_MS) {
    nackPending_ = true;
    nackOrigin_ = origin;
  }

  // Someone else just served this range to the neighborhood; skip past it.
  Want* w = findWant(origin, false);
  if (w) skipServed(*w, seq, seq + m.h.count);
}

void Mesh::receive(const uint8_t* data, size_t len, uint32_t now) {
  if (len < sizeof(MsgHeader)) return;
  MsgHeader h;
  memcpy(&h, data, sizeof(h));
  if (h.magic != MSG_MAGIC || h.version != MSG_VERSION || h.sender == self_) return;

  if ((h.type == MSG_SUMMARY || h.type == MSG_SINK_SUMMARY) && h.count <= SUMMARY_MAX_ENTRIES &&
      len >= offsetof(SummaryMsg, e) + h.count * sizeof(OriginState)) {
    SummaryMsg m;
    memcpy(&m, data, min(len, sizeof(m)));
    onSummary(m, now, h.type == MSG_SINK_SUMMARY);
  } else if (h.type == MSG_DATA && h.count <= DATA_MAX_RECORDS &&
             len >= offsetof(DataMsg, r) + h.count * sizeof(Record)) {
    DataMsg m;
    memcpy(&m, data, min(len, sizeof(m)));
    onData(m, now);
  } else if (h.type == MSG_MOTION && h.count <= MOTION_SAMPLES &&
             len >= offsetof(MotionMsg, s) + h.count * sizeof(MotionSample)) {
    MotionMsg m;
    memcpy(&m, data, min(len, sizeof(m)));
    node_->motion(m, h.count);
  }
}

void Mesh::serveData(uint32_t now) {
  if (now - lastDataAt_ < DATA_GAP_MS || !radio_->ready()) return;

  for (size_t step = 0; step < MAX_ORIGINS; step++) {
    size_t idx = (wantCursor_ + step) % MAX_ORIGINS;
    Want& w = wants_[idx];
    if (!w.active && !w.sinkActive) continue;
    OriginState s;
    if (!node_->state(w.origin, s)) {
      w.active = w.sinkActive = false;
      continue;
    }
    if (now - w.heardAt > WANT_TIMEOUT_MS) w.active = false;
    if (now - w.sinkHeardAt > WANT_TIMEOUT_MS) w.sinkActive = false;
    uint32_t floor = max(s.first, s.acked);  // oldest we'll ever send
    bool forSink = w.sinkActive && max(w.sinkFrom, floor) < s.next;
    if (!forSink) w.sinkActive = false;
    if (!forSink && !w.active) continue;
    uint32_t from = max(forSink ? w.sinkFrom : w.from, floor);
    DataMsg m;
    uint32_t t0 = micros();
    size_t n = from < s.next ? node_->read(w.origin, from, m.r, DATA_MAX_RECORDS) : 0;
    counters.readUsMax = max(counters.readUsMax, (uint32_t)(micros() - t0));
    if (n == 0) {
      if (forSink) w.sinkActive = false;
      else w.active = false;
      continue;
    }
    fillHeader(m.h, MSG_DATA, n);
    m.first = floor;
    if (radio_->send(&m, offsetof(DataMsg, r) + n * sizeof(Record))) {
      counters.dataSent++;
      if (forSink) w.sinkFrom = from + n;
      else w.from = from + n;
      skipServed(w, from, from + n);
      lastDataAt_ = now;
      wantCursor_ = idx + 1;  // round-robin across origins
    }
    return;
  }
}

void Mesh::push(const Record& r) {
  push_ = r;
  pushPending_ = true;
}

void Mesh::sendMotion(const MotionMsg& m, size_t n) {
  motion_ = m;
  fillHeader(motion_.h, MSG_MOTION, n);
  motionN_ = n;
  motionPending_ = true;
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
  // A fresh record, then NACKs and summary pages, take priority over data.
  if (pushPending_) {
    OriginState s;
    if (!node_->state(push_.origin, s)) {
      pushPending_ = false;
    } else if (radio_->ready()) {
      DataMsg m;
      fillHeader(m.h, MSG_DATA, 1);
      m.first = max(s.first, s.acked);
      m.r[0] = push_;
      if (radio_->send(&m, offsetof(DataMsg, r) + sizeof(Record))) counters.dataSent++;
      pushPending_ = false;
    }
    return;
  }
  if (motionPending_) {
    if (radio_->ready()) {
      radio_->send(&motion_, offsetof(MotionMsg, s) + motionN_ * sizeof(MotionSample));
      motionPending_ = false;
    }
    return;
  }
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
