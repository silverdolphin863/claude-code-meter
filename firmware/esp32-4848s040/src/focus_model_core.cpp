#include "focus_model_core.h"

namespace ccmeter {

uint32_t focusPhaseDurationMs(FocusPhase phase) {
  switch (phase) {
    case FocusPhase::Focus: return kFocusMs;
    case FocusPhase::ShortBreak: return kShortBreakMs;
    case FocusPhase::LongBreak: return kLongBreakMs;
  }
  return kFocusMs;
}

const char* focusPhaseName(FocusPhase phase) {
  switch (phase) {
    case FocusPhase::Focus: return "focus";
    case FocusPhase::ShortBreak: return "short";
    case FocusPhase::LongBreak: return "long";
  }
  return "focus";
}

int32_t focusDayKey(uint64_t epochMs, bool offsetKnown, int32_t utcOffsetMinutes) {
  if (!offsetKnown || epochMs == 0) return kUnknownDay;
  const int64_t localSeconds = static_cast<int64_t>(epochMs / 1000ULL) +
                               static_cast<int64_t>(utcOffsetMinutes) * 60;
  if (localSeconds < 0) return kUnknownDay;
  return static_cast<int32_t>(localSeconds / 86400);
}

FocusTimer::FocusTimer() = default;

uint8_t FocusTimer::blockNumber() const {
  const uint8_t done = cycleDone_ >= kFocusBlocksPerCycle ? kFocusBlocksPerCycle - 1 : cycleDone_;
  return static_cast<uint8_t>(done + 1);
}

void FocusTimer::advance(uint32_t nowMs) {
  if (!running_) {
    lastMs_ = nowMs;
    return;
  }
  uint32_t step = nowMs - lastMs_;
  lastMs_ = nowMs;
  if (step > remainingMs_) step = remainingMs_;
  remainingMs_ -= step;
  if (phase_ == FocusPhase::Focus) todayFocusMs_ += step;
}

void FocusTimer::start(uint32_t nowMs) {
  if (running_) return;
  if (remainingMs_ == 0) remainingMs_ = totalMs();
  running_ = true;
  lastMs_ = nowMs;
}

void FocusTimer::pause(uint32_t nowMs) {
  if (!running_) return;
  advance(nowMs);
  running_ = false;
}

void FocusTimer::toggle(uint32_t nowMs) {
  if (running_) pause(nowMs);
  else start(nowMs);
}

void FocusTimer::reset(uint32_t nowMs) {
  advance(nowMs);
  running_ = false;
  remainingMs_ = totalMs();
}

void FocusTimer::finishPhase(bool credited) {
  running_ = false;
  if (phase_ == FocusPhase::Focus) {
    if (credited) ++todayBlocks_;
    if (cycleDone_ < kFocusBlocksPerCycle) ++cycleDone_;
    // Every break is short; a set of four only groups the blocks on screen.
    phase_ = FocusPhase::ShortBreak;
  } else {
    if (cycleDone_ >= kFocusBlocksPerCycle) cycleDone_ = 0;
    phase_ = FocusPhase::Focus;
  }
  remainingMs_ = totalMs();
}

void FocusTimer::skip(uint32_t nowMs) {
  advance(nowMs);
  finishPhase(false);
}

FocusTick FocusTimer::tick(uint32_t nowMs) {
  FocusTick result;
  if (!running_) {
    lastMs_ = nowMs;
    return result;
  }
  const uint32_t before = displaySeconds();
  advance(nowMs);
  const uint32_t after = displaySeconds();
  result.secondChanged = before != after;
  if (remainingMs_ == 0) {
    result.finished = true;
    result.secondChanged = true;
    finishPhase(true);
    return result;
  }
  if (result.secondChanged && after <= 10) result.countdownSecond = static_cast<uint8_t>(after);
  return result;
}

void FocusTimer::setDay(int32_t dayKey) {
  if (dayKey == kUnknownDay || dayKey == dayKey_) return;
  if (dayKey_ != kUnknownDay) {
    todayFocusMs_ = 0;
    todayBlocks_ = 0;
  }
  dayKey_ = dayKey;
}

FocusSaved FocusTimer::save() const {
  FocusSaved saved;
  saved.dayKey = dayKey_;
  saved.todayFocusMs = todayFocusMs_;
  saved.todayBlocks = todayBlocks_;
  saved.phase = static_cast<uint8_t>(phase_);
  saved.cycleDone = cycleDone_;
  saved.remainingMs = remainingMs_;
  return saved;
}

void FocusTimer::restore(const FocusSaved& saved) {
  // Long breaks no longer exist; a long break saved by older firmware resumes
  // as a short one.
  phase_ = saved.phase == static_cast<uint8_t>(FocusPhase::ShortBreak) ||
                   saved.phase == static_cast<uint8_t>(FocusPhase::LongBreak)
               ? FocusPhase::ShortBreak
               : FocusPhase::Focus;
  cycleDone_ = saved.cycleDone > kFocusBlocksPerCycle ? 0 : saved.cycleDone;
  remainingMs_ = saved.remainingMs == 0 || saved.remainingMs > totalMs() ? totalMs() : saved.remainingMs;
  todayFocusMs_ = saved.todayFocusMs;
  todayBlocks_ = saved.todayBlocks;
  dayKey_ = saved.dayKey;
  running_ = false;
}

}  // namespace ccmeter
