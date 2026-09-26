#include "store.h"

#include <Arduino.h>
#include <LittleFS.h>
#include <sys/stat.h>

namespace {

struct Meta {
  uint32_t first, next, acked;
};

// LittleFS.exists() logs a spurious error for missing files on Arduino 2.x.
bool fileExists(const String& path) {
  struct stat st;
  return stat(("/littlefs" + path).c_str(), &st) == 0;
}

const char* baseName(const char* path) {
  const char* slash = strrchr(path, '/');
  return slash ? slash + 1 : path;
}

}  // namespace

String Store::dirPath(uint32_t origin) {
  char buf[16];
  snprintf(buf, sizeof(buf), "/%08lx", (unsigned long)origin);
  return root_ + buf;
}

String Store::segPath(uint32_t origin, uint32_t seg) {
  char buf[16];
  snprintf(buf, sizeof(buf), "/%lu.bin", (unsigned long)seg);
  return dirPath(origin) + buf;
}

String Store::metaPath(uint32_t origin) { return dirPath(origin) + "/meta"; }

bool Store::begin(uint32_t selfId, const char* root) {
  self_ = selfId;
  root_ = root;
  count_ = 0;
  if (!LittleFS.begin(true)) {
    Serial.println("store: LittleFS mount failed");
    return false;
  }
  if (!fileExists(root_)) LittleFS.mkdir(root_);

  File dir = LittleFS.open(root_);
  for (File d = dir.openNextFile(); d; d = dir.openNextFile()) {
    if (!d.isDirectory()) continue;
    String path = d.path();
    uint32_t origin = strtoul(baseName(path.c_str()), nullptr, 16);
    d.close();
    load(origin, path.c_str());
  }
  if (!find(self_)) create(self_, 0);
  return true;
}

// Rebuilds one origin's state from its segment files and meta.
void Store::load(uint32_t origin, const char* dir) {
  uint32_t minSeg = UINT32_MAX, maxSeg = 0;
  size_t maxSegSize = 0;
  File d = LittleFS.open(dir);
  for (File f = d.openNextFile(); f; f = d.openNextFile()) {
    const char* name = baseName(f.name());
    if (!strstr(name, ".bin")) continue;
    uint32_t seg = strtoul(name, nullptr, 10);
    minSeg = min(minSeg, seg);
    if (seg >= maxSeg) {
      maxSeg = seg;
      maxSegSize = f.size();
    }
  }

  Meta meta = {0, 0, 0};
  File mf = fileExists(metaPath(origin)) ? LittleFS.open(metaPath(origin), "r") : File();
  if (mf) {
    mf.read(reinterpret_cast<uint8_t*>(&meta), sizeof(meta));
    mf.close();
  }

  OriginState* s = create(origin, 0);
  if (!s) return;
  s->acked = meta.acked;
  if (minSeg == UINT32_MAX) {
    s->first = s->next = max(meta.next, meta.acked);
  } else {
    // A torn write at power loss leaves a partial record; it gets overwritten.
    s->next = maxSeg * SEGMENT_RECORDS + maxSegSize / sizeof(Record);
    s->first = max(meta.first, minSeg * SEGMENT_RECORDS);
    if (s->first > s->next) s->first = s->next;
  }
}

OriginState* Store::find(uint32_t origin) {
  for (size_t i = 0; i < count_; i++) {
    if (table_[i].origin == origin) return &table_[i];
  }
  return nullptr;
}

OriginState* Store::create(uint32_t origin, uint32_t start) {
  if (count_ >= MAX_ORIGINS) return nullptr;
  size_t i = count_;
  while (i > 0 && table_[i - 1].origin > origin) {
    table_[i] = table_[i - 1];
    i--;
  }
  table_[i] = {origin, start, start, 0};
  count_++;
  String dir = dirPath(origin);
  if (!fileExists(dir)) LittleFS.mkdir(dir);
  return &table_[i];
}

void Store::saveMeta(const OriginState& s) {
  File f = LittleFS.open(metaPath(s.origin), "w");
  if (!f) return;
  Meta meta = {s.first, s.next, s.acked};
  f.write(reinterpret_cast<const uint8_t*>(&meta), sizeof(meta));
  f.close();
}

void Store::deleteSegments(const OriginState& s, uint32_t fromSeg, uint32_t toSeg) {
  for (uint32_t seg = fromSeg; seg < toSeg; seg++) LittleFS.remove(segPath(s.origin, seg));
}

// Drops everything held for this origin and continues from `seq`.
void Store::restartAt(OriginState& s, uint32_t seq) {
  if (s.first < s.next) {
    deleteSegments(s, s.first / SEGMENT_RECORDS, (s.next - 1) / SEGMENT_RECORDS + 1);
  }
  s.first = s.next = seq;
  saveMeta(s);
}

// Deletes segments the laptop already has (entirely below `acked`).
void Store::prune(OriginState& s) {
  if (s.acked >= s.next) {
    restartAt(s, s.acked);
    return;
  }
  bool changed = false;
  while (s.first < s.next && (s.first / SEGMENT_RECORDS + 1) * SEGMENT_RECORDS <= s.acked) {
    uint32_t seg = s.first / SEGMENT_RECORDS;
    LittleFS.remove(segPath(s.origin, seg));
    s.first = (seg + 1) * SEGMENT_RECORDS;
    changed = true;
  }
  if (changed) saveMeta(s);
}

// When flash is nearly full, evict the oldest segment of the origin holding
// the most records.
void Store::ensureSpace() {
  while (LittleFS.totalBytes() - LittleFS.usedBytes() < FS_RESERVE_BYTES) {
    OriginState* victim = nullptr;
    for (size_t i = 0; i < count_; i++) {
      OriginState& s = table_[i];
      if (s.first < s.next && (!victim || s.next - s.first > victim->next - victim->first)) victim = &s;
    }
    if (!victim) return;
    uint32_t seg = victim->first / SEGMENT_RECORDS;
    LittleFS.remove(segPath(victim->origin, seg));
    victim->first = min((seg + 1) * SEGMENT_RECORDS, victim->next);
    saveMeta(*victim);
    Serial.printf("store: flash full, evicted %08lx segment %lu\n", (unsigned long)victim->origin,
                  (unsigned long)seg);
  }
}

// Appends records r[0..n) which must start at s.next and be consecutive.
bool Store::write(OriginState& s, const Record* r, size_t n) {
  while (n > 0) {
    uint32_t seg = s.next / SEGMENT_RECORDS;
    size_t off = (s.next % SEGMENT_RECORDS) * sizeof(Record);
    size_t batch = min(n, (size_t)(SEGMENT_RECORDS - s.next % SEGMENT_RECORDS));
    String path = segPath(s.origin, seg);

    bool exists = fileExists(path);
    if (!exists) ensureSpace();
    File f = LittleFS.open(path, exists ? "r+" : "w");
    if (!f) return false;
    if (f.size() < off) {
      // Records before `first` in this segment are never read; pad them.
      f.seek(f.size());
      uint8_t zeros[64] = {};
      for (size_t left = off - f.size(); left > 0;) {
        size_t chunk = min(left, sizeof(zeros));
        f.write(zeros, chunk);
        left -= chunk;
      }
    }
    f.seek(off);
    size_t wrote = f.write(reinterpret_cast<const uint8_t*>(r), batch * sizeof(Record));
    f.close();
    if (wrote != batch * sizeof(Record)) return false;

    s.next += batch;
    r += batch;
    n -= batch;
  }
  return true;
}

bool Store::appendOwn(Record& r) {
  OriginState* s = find(self_);
  if (!s) return false;
  r.origin = self_;
  r.seq = s->next;
  return write(*s, &r, 1);
}

size_t Store::states(OriginState* out, size_t max) {
  size_t n = min(max, count_);
  memcpy(out, table_, n * sizeof(OriginState));
  return n;
}

bool Store::state(uint32_t origin, OriginState& out) {
  OriginState* s = find(origin);
  if (!s) return false;
  out = *s;
  return true;
}

size_t Store::read(uint32_t origin, uint32_t seq, Record* out, size_t max) {
  OriginState* s = find(origin);
  if (!s || seq < s->first || seq >= s->next) return 0;
  size_t n = min(max, (size_t)(s->next - seq));
  n = min(n, (size_t)(SEGMENT_RECORDS - seq % SEGMENT_RECORDS));

  File f = LittleFS.open(segPath(origin, seq / SEGMENT_RECORDS), "r");
  if (!f) return 0;
  f.seek((seq % SEGMENT_RECORDS) * sizeof(Record));
  size_t got = f.read(reinterpret_cast<uint8_t*>(out), n * sizeof(Record)) / sizeof(Record);
  f.close();
  for (size_t i = 0; i < got; i++) {
    if (out[i].origin != origin || out[i].seq != seq + i) return i;  // corrupt/padding
  }
  return got;
}

void Store::ingest(const Record* recs, size_t n, uint32_t senderFirst) {
  uint32_t origin = recs[0].origin;
  if (origin == self_) return;  // we are the source of truth for our own data
  OriginState* s = find(origin);
  if (!s) s = create(origin, 0);
  if (!s) return;

  size_t i = 0;
  while (i < n && (recs[i].seq < s->next || recs[i].seq < s->acked)) i++;
  if (i == n) return;
  // Records older than the sender's oldest are gone from it: skip to that.
  if (senderFirst > s->next) restartAt(*s, senderFirst);
  // Any other gap is a lost frame: wait for a resend from our advertised `next`.
  if (recs[i].seq != s->next) return;
  write(*s, recs + i, n - i);
}

void Store::peerState(const OriginState& e) {
  OriginState* s = find(e.origin);
  if (!s) return;
  if (e.origin == self_ && e.next > s->next) {
    // Our flash was wiped but the mesh remembers us: never reuse a seq.
    Serial.printf("store: resuming own seq at %lu\n", (unsigned long)e.next);
    restartAt(*s, e.next);
  }
  if (e.acked > s->acked) {
    s->acked = e.acked;
    prune(*s);
  }
}

void Store::printStatus(Print& out) {
  out.printf("store: %u origins, %lu/%lu KB used\n", (unsigned)count_,
             (unsigned long)(LittleFS.usedBytes() / 1024), (unsigned long)(LittleFS.totalBytes() / 1024));
  for (size_t i = 0; i < count_; i++) {
    const OriginState& s = table_[i];
    out.printf("  %08lx%s holds [%lu, %lu) acked %lu\n", (unsigned long)s.origin, s.origin == self_ ? "*" : " ",
               (unsigned long)s.first, (unsigned long)s.next, (unsigned long)s.acked);
  }
}
