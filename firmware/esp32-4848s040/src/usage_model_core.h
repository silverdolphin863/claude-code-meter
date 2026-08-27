#pragma once

#include <stddef.h>
#include <stdint.h>

namespace ccmeter {

constexpr size_t kMaxSections = 2;
constexpr size_t kMaxLimitsPerSection = 8;
constexpr size_t kSectionIdSize = 16;
constexpr size_t kSectionNameSize = 32;
constexpr size_t kPlanSize = 32;
constexpr size_t kLimitLabelSize = 48;
constexpr size_t kResetLabelSize = 24;

struct UsageLimit {
  char label[kLimitLabelSize];
  char resetLabel[kResetLabelSize];
  float percent;
  float windowHours;
  uint64_t resetEpochMs;
  bool hasWindow;
  bool hasReset;
};

struct UsageSection {
  char id[kSectionIdSize];
  char name[kSectionNameSize];
  char plan[kPlanSize];
  UsageLimit limits[kMaxLimitsPerSection];
  uint8_t limitCount;
  uint32_t staleMs;
  bool present;
  bool installed;
  bool authRequired;
  bool refreshError;
  bool hasError;
};

enum class RefreshOutcome : uint8_t {
  None,
  Updated,
  Cooldown,
  Blocked,
  Authentication,
  Busy,
  Failed,
};

struct UsageSnapshot {
  UsageSection sections[kMaxSections];
  uint8_t sectionCount;
  uint32_t serverStaleMs;
  uint64_t generatedAtEpochMs;
  uint64_t refreshRetryEpochMs;
  RefreshOutcome refreshOutcome;
  bool valid;
  bool hasGeneratedAt;
  bool hasRefreshRetry;
};

enum class UsageTone : uint8_t {
  Green,
  Amber,
  Red,
};

void clearLimit(UsageLimit& limit);
void clearSection(UsageSection& section);
void clearSnapshot(UsageSnapshot& snapshot);

const UsageSection* findSection(const UsageSnapshot& snapshot, const char* id);

bool parseIsoTimestamp(const char* text, uint64_t& epochMs);
bool formatCountdown(uint64_t resetEpochMs, uint64_t nowEpochMs, char* output, size_t outputSize);
bool formatResetLabel(uint64_t resetEpochMs, float windowHours, char* output, size_t outputSize);
bool formatAge(uint64_t ageMs, char* output, size_t outputSize);

float calculatePace(float percent, uint64_t resetEpochMs, float windowHours, uint64_t nowEpochMs);
UsageTone usageTone(float percent);
UsageTone paceTone(float pace);

}  // namespace ccmeter
