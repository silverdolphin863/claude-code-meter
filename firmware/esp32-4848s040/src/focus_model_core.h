#pragma once

#include <stdint.h>

namespace ccmeter {

enum class FocusPhase : uint8_t { Focus = 0, ShortBreak = 1, LongBreak = 2 };

constexpr uint32_t kFocusMs = 25UL * 60UL * 1000UL;
constexpr uint32_t kShortBreakMs = 5UL * 60UL * 1000UL;
constexpr uint32_t kLongBreakMs = 15UL * 60UL * 1000UL;
constexpr uint8_t kFocusBlocksPerCycle = 4;
constexpr int32_t kUnknownDay = -1;

uint32_t focusPhaseDurationMs(FocusPhase phase);
const char* focusPhaseName(FocusPhase phase);
// Local calendar day number. Returns kUnknownDay when the clock is unknown.
int32_t focusDayKey(uint64_t epochMs, bool offsetKnown, int32_t utcOffsetMinutes);

struct FocusTick {
  bool secondChanged = false;  // the displayed whole second changed
  bool finished = false;       // the phase reached zero on this tick
  uint8_t countdownSecond = 0; // 1..10 when a final-countdown second began
};

// Saved across reboots. A running timer comes back paused.
struct FocusSaved {
  int32_t dayKey = kUnknownDay;
  uint32_t todayFocusMs = 0;
  uint16_t todayBlocks = 0;
  uint8_t phase = 0;
  uint8_t cycleDone = 0;
  uint32_t remainingMs = kFocusMs;
};

class FocusTimer {
 public:
  FocusTimer();

  void start(uint32_t nowMs);
  void pause(uint32_t nowMs);
  void toggle(uint32_t nowMs);
  // Back to the full duration of the current phase, paused.
  void reset(uint32_t nowMs);
  // Ends the current phase now. A skipped focus block moves the cycle on
  // but is not counted as a finished block.
  void skip(uint32_t nowMs);
  FocusTick tick(uint32_t nowMs);
  // Applies the local day. A change from a known day clears today's totals.
  void setDay(int32_t dayKey);

  FocusPhase phase() const { return phase_; }
  bool running() const { return running_; }
  bool atFullDuration() const { return remainingMs_ == focusPhaseDurationMs(phase_); }
  uint32_t remainingMs() const { return remainingMs_; }
  uint32_t totalMs() const { return focusPhaseDurationMs(phase_); }
  uint32_t displaySeconds() const { return (remainingMs_ + 999) / 1000; }
  uint8_t cycleDone() const { return cycleDone_; }
  uint8_t blockNumber() const;  // 1..4 for the current or next focus block
  uint32_t todayFocusMs() const { return todayFocusMs_; }
  uint16_t todayBlocks() const { return todayBlocks_; }
  int32_t dayKey() const { return dayKey_; }

  FocusSaved save() const;
  void restore(const FocusSaved& saved);

 private:
  void advance(uint32_t nowMs);
  void finishPhase(bool credited);

  FocusPhase phase_ = FocusPhase::Focus;
  bool running_ = false;
  uint32_t remainingMs_ = kFocusMs;
  uint32_t lastMs_ = 0;
  uint8_t cycleDone_ = 0;
  uint32_t todayFocusMs_ = 0;
  uint16_t todayBlocks_ = 0;
  int32_t dayKey_ = kUnknownDay;
};

}  // namespace ccmeter
