#include "usage_model_core.h"

#include <algorithm>
#include <cstdarg>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace ccmeter {
namespace {

struct CalendarTime {
  int year;
  unsigned month;
  unsigned day;
  unsigned hour;
  unsigned minute;
};

bool isDigit(char value) {
  return value >= '0' && value <= '9';
}

int readDigits(const char* text, size_t offset, size_t count, int& value) {
  int result = 0;
  for (size_t i = 0; i < count; ++i) {
    if (!isDigit(text[offset + i])) return 0;
    result = result * 10 + (text[offset + i] - '0');
  }
  value = result;
  return 1;
}

bool leapYear(int year) {
  return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

unsigned daysInMonth(int year, unsigned month) {
  static const unsigned days[] = {0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (month == 2 && leapYear(year)) return 29;
  return month <= 12 ? days[month] : 0;
}

int64_t daysFromCivil(int year, unsigned month, unsigned day) {
  year -= month <= 2;
  const int era = (year >= 0 ? year : year - 399) / 400;
  const unsigned yearOfEra = static_cast<unsigned>(year - era * 400);
  const int monthPart = static_cast<int>(month) + (month > 2 ? -3 : 9);
  const unsigned dayOfYear = static_cast<unsigned>((153 * monthPart + 2) / 5) + day - 1;
  const unsigned dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear;
  return static_cast<int64_t>(era) * 146097 + static_cast<int64_t>(dayOfEra) - 719468;
}

void civilFromDays(int64_t days, int& year, unsigned& month, unsigned& day) {
  days += 719468;
  const int era = static_cast<int>((days >= 0 ? days : days - 146096) / 146097);
  const unsigned dayOfEra = static_cast<unsigned>(days - static_cast<int64_t>(era) * 146097);
  const unsigned yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146096) / 365;
  year = static_cast<int>(yearOfEra) + era * 400;
  const unsigned dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100);
  const unsigned monthPart = (5 * dayOfYear + 2) / 153;
  day = dayOfYear - (153 * monthPart + 2) / 5 + 1;
  month = static_cast<unsigned>(static_cast<int>(monthPart) + (monthPart < 10 ? 3 : -9));
  year += month <= 2;
}

bool calendarFromEpoch(uint64_t epochMs, CalendarTime& value) {
  const int64_t totalSeconds = static_cast<int64_t>(epochMs / 1000ULL);
  const int64_t days = totalSeconds / 86400;
  const int64_t secondsOfDay = totalSeconds % 86400;
  if (secondsOfDay < 0) return false;
  civilFromDays(days, value.year, value.month, value.day);
  value.hour = static_cast<unsigned>(secondsOfDay / 3600);
  value.minute = static_cast<unsigned>((secondsOfDay % 3600) / 60);
  return true;
}

bool writeText(char* output, size_t outputSize, const char* format, ...) {
  if (!output || outputSize == 0) return false;
  va_list args;
  va_start(args, format);
  const int written = vsnprintf(output, outputSize, format, args);
  va_end(args);
  if (written < 0 || static_cast<size_t>(written) >= outputSize) {
    output[outputSize - 1] = '\0';
    return false;
  }
  return true;
}

}  // namespace

void clearLimit(UsageLimit& limit) {
  memset(&limit, 0, sizeof(limit));
}

void clearSection(UsageSection& section) {
  memset(&section, 0, sizeof(section));
  section.installed = true;
}

void clearSnapshot(UsageSnapshot& snapshot) {
  memset(&snapshot, 0, sizeof(snapshot));
  for (size_t i = 0; i < kMaxSections; ++i) clearSection(snapshot.sections[i]);
}

const UsageSection* findSection(const UsageSnapshot& snapshot, const char* id) {
  if (!id) return nullptr;
  for (size_t i = 0; i < snapshot.sectionCount; ++i) {
    if (strcmp(snapshot.sections[i].id, id) == 0) return &snapshot.sections[i];
  }
  return nullptr;
}

bool parseIsoTimestamp(const char* text, uint64_t& epochMs) {
  epochMs = 0;
  if (!text || strlen(text) < 19) return false;
  int year = 0;
  int month = 0;
  int day = 0;
  int hour = 0;
  int minute = 0;
  int second = 0;
  if (!readDigits(text, 0, 4, year) || text[4] != '-' ||
      !readDigits(text, 5, 2, month) || text[7] != '-' ||
      !readDigits(text, 8, 2, day) ||
      (text[10] != 'T' && text[10] != ' ') ||
      !readDigits(text, 11, 2, hour) || text[13] != ':' ||
      !readDigits(text, 14, 2, minute) || text[16] != ':' ||
      !readDigits(text, 17, 2, second)) {
    return false;
  }
  if (year < 1970 || month < 1 || month > 12 || day < 1 ||
      day > static_cast<int>(daysInMonth(year, static_cast<unsigned>(month))) ||
      hour > 23 || minute > 59 || second > 59) {
    return false;
  }

  size_t offset = 19;
  int milliseconds = 0;
  if (text[offset] == '.') {
    ++offset;
    int digits = 0;
    while (isDigit(text[offset]) && digits < 3) {
      milliseconds = milliseconds * 10 + (text[offset] - '0');
      ++offset;
      ++digits;
    }
    while (isDigit(text[offset])) ++offset;
    while (digits < 3) {
      milliseconds *= 10;
      ++digits;
    }
  }

  int timezoneOffsetSeconds = 0;
  if (text[offset] == 'Z' || text[offset] == '\0') {
    // ISO timestamps from the CC Meter server use UTC. A missing suffix is
    // accepted as UTC for tolerant parsing of hand-built test payloads.
  } else if (text[offset] == '+' || text[offset] == '-') {
    const int sign = text[offset] == '+' ? 1 : -1;
    int zoneHour = 0;
    int zoneMinute = 0;
    if (strlen(text) < offset + 6) return false;
    if (!readDigits(text, offset + 1, 2, zoneHour) || text[offset + 3] != ':' ||
        !readDigits(text, offset + 4, 2, zoneMinute) || zoneHour > 23 || zoneMinute > 59) {
      return false;
    }
    timezoneOffsetSeconds = sign * (zoneHour * 3600 + zoneMinute * 60);
  } else {
    return false;
  }

  const int64_t seconds = daysFromCivil(year, static_cast<unsigned>(month), static_cast<unsigned>(day)) * 86400LL +
                          hour * 3600LL + minute * 60LL + second - timezoneOffsetSeconds;
  if (seconds < 0) return false;
  epochMs = static_cast<uint64_t>(seconds) * 1000ULL + static_cast<uint64_t>(milliseconds);
  return true;
}

bool formatCountdown(uint64_t resetEpochMs, uint64_t nowEpochMs, char* output, size_t outputSize) {
  if (!output || outputSize == 0) return false;
  output[0] = '\0';
  if (resetEpochMs == 0) return false;
  if (nowEpochMs == 0) return writeText(output, outputSize, "reset time unknown");
  if (resetEpochMs <= nowEpochMs) return writeText(output, outputSize, "resetting");

  const uint64_t seconds = (resetEpochMs - nowEpochMs) / 1000ULL;
  const uint64_t days = seconds / 86400ULL;
  const uint64_t hours = (seconds % 86400ULL) / 3600ULL;
  const uint64_t minutes = (seconds % 3600ULL) / 60ULL;
  if (days > 0) return writeText(output, outputSize, "Resets in %llud %lluh", days, hours);
  if (hours > 0) return writeText(output, outputSize, "Resets in %lluh %llum", hours, minutes);
  return writeText(output, outputSize, "Resets in %llum", minutes);
}

bool formatResetLabel(uint64_t resetEpochMs, float windowHours, char* output, size_t outputSize) {
  if (!output || outputSize == 0) return false;
  output[0] = '\0';
  if (resetEpochMs == 0) return false;
  CalendarTime value{};
  if (!calendarFromEpoch(resetEpochMs, value)) return false;
  if (windowHours > 0.0f && windowHours <= 24.0f) {
    return writeText(output, outputSize, "%02u:%02u", value.hour, value.minute);
  }
  return writeText(output, outputSize, "%02u.%02u %02u:%02u", value.day, value.month, value.hour, value.minute);
}

bool formatAge(uint64_t ageMs, char* output, size_t outputSize) {
  if (!output || outputSize == 0) return false;
  const uint64_t seconds = ageMs / 1000ULL;
  if (seconds < 60) return writeText(output, outputSize, "<1m");
  if (seconds < 3600) return writeText(output, outputSize, "%llum", (seconds + 30) / 60);
  return writeText(output, outputSize, "%lluh", (seconds + 1800) / 3600);
}

float calculatePace(float percent, uint64_t resetEpochMs, float windowHours, uint64_t nowEpochMs) {
  if (percent <= 0.0f || resetEpochMs == 0 || windowHours <= 0.0f || nowEpochMs == 0) return -1.0f;
  const double windowMs = static_cast<double>(windowHours) * 3600000.0;
  const double remainingMs = static_cast<double>(resetEpochMs) - static_cast<double>(nowEpochMs);
  const double elapsedPercent = std::max(1.0, std::min(100.0, (windowMs - remainingMs) * 100.0 / windowMs));
  return static_cast<float>(percent / elapsedPercent);
}

UsageTone usageTone(float percent) {
  if (percent >= 90.0f) return UsageTone::Red;
  if (percent >= 50.0f) return UsageTone::Amber;
  return UsageTone::Green;
}

UsageTone paceTone(float pace) {
  if (pace >= 1.5f) return UsageTone::Red;
  if (pace >= 0.9f) return UsageTone::Amber;
  return UsageTone::Green;
}

}  // namespace ccmeter
