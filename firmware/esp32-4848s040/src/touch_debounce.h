#pragma once

#include <stdint.h>

namespace ccmeter {

// The GT911 reports a new point only every ~10 ms, and a read before that
// reports "no touch" for a finger that is still down. Polling faster than the
// report rate therefore splits one swipe into several short touches. A touch
// counts as released only after no report for kTouchReleaseMs.
constexpr uint32_t kTouchReleaseMs = 80;

class TouchDebounce {
 public:
  // raw: what the controller said this poll. Returns the debounced state;
  // x/y hold the last reported point while down.
  bool update(bool raw, int16_t rawX, int16_t rawY, uint32_t nowMs, int16_t& x, int16_t& y) {
    if (raw) {
      down_ = true;
      lastSeenMs_ = nowMs;
      x_ = rawX;
      y_ = rawY;
    } else if (down_ && nowMs - lastSeenMs_ >= kTouchReleaseMs) {
      down_ = false;
    }
    x = x_;
    y = y_;
    return down_;
  }

 private:
  bool down_ = false;
  uint32_t lastSeenMs_ = 0;
  int16_t x_ = 0;
  int16_t y_ = 0;
};

}  // namespace ccmeter
