#include "usage_model.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace ccmeter {
namespace {

constexpr size_t kMaxPayloadBytes = 49152;

void writeError(char* output, size_t outputSize, const char* value) {
  if (!output || outputSize == 0) return;
  strncpy(output, value ? value : "invalid payload", outputSize - 1);
  output[outputSize - 1] = '\0';
}

void copyText(char* destination, size_t destinationSize, const char* source) {
  if (!destination || destinationSize == 0) return;
  if (!source) {
    destination[0] = '\0';
    return;
  }
  strncpy(destination, source, destinationSize - 1);
  destination[destinationSize - 1] = '\0';
}

bool equalsIgnoreCase(const char* left, const char* right) {
  if (!left || !right) return false;
  while (*left && *right) {
    const char a = *left >= 'A' && *left <= 'Z' ? static_cast<char>(*left + ('a' - 'A')) : *left;
    const char b = *right >= 'A' && *right <= 'Z' ? static_cast<char>(*right + ('a' - 'A')) : *right;
    if (a != b) return false;
    ++left;
    ++right;
  }
  return *left == '\0' && *right == '\0';
}

bool containsIgnoreCase(const char* text, const char* needle) {
  if (!text || !needle || !*needle) return false;
  for (const char* start = text; *start; ++start) {
    const char* a = start;
    const char* b = needle;
    while (*a && *b) {
      const char left = *a >= 'A' && *a <= 'Z' ? static_cast<char>(*a + ('a' - 'A')) : *a;
      const char right = *b >= 'A' && *b <= 'Z' ? static_cast<char>(*b + ('a' - 'A')) : *b;
      if (left != right) break;
      ++a;
      ++b;
    }
    if (!*b) return true;
  }
  return false;
}

bool readNumber(JsonVariantConst value, double& output) {
  if (value.isNull() || value.is<bool>() || value.is<const char*>()) return false;
  if (!value.is<int>() && !value.is<unsigned>() && !value.is<long>() &&
      !value.is<unsigned long>() && !value.is<int64_t>() && !value.is<uint64_t>() &&
      !value.is<float>() && !value.is<double>()) {
    return false;
  }
  output = value.as<double>();
  return std::isfinite(output);
}

bool readFlag(JsonVariantConst value) {
  if (value.is<bool>()) return value.as<bool>();
  const char* text = value.as<const char*>();
  if (!text) return false;
  return equalsIgnoreCase(text, "true") || equalsIgnoreCase(text, "yes") ||
         equalsIgnoreCase(text, "1") || equalsIgnoreCase(text, "auth_required");
}

bool readErrorFlag(JsonVariantConst value) {
  if (value.isNull()) return false;
  if (value.is<bool>()) return value.as<bool>();
  const char* text = value.as<const char*>();
  return text ? *text != '\0' : true;
}

bool readTimestamp(JsonVariantConst value, uint64_t& epochMs) {
  const char* text = value.as<const char*>();
  if (text) return parseIsoTimestamp(text, epochMs);
  double number = 0;
  if (!readNumber(value, number) || number <= 0.0) return false;
  epochMs = number > 1000000000000.0 ? static_cast<uint64_t>(number) : static_cast<uint64_t>(number * 1000.0);
  return true;
}

float inferredWindowHours(const char* label) {
  if (containsIgnoreCase(label, "5-hour") || containsIgnoreCase(label, "5h")) return 5.0f;
  if (containsIgnoreCase(label, "weekly") || containsIgnoreCase(label, "7-day") || containsIgnoreCase(label, "7d")) {
    return 168.0f;
  }
  return 0.0f;
}

bool readLimit(JsonObjectConst object, UsageLimit& limit) {
  clearLimit(limit);
  double percent = 0;
  if (!readNumber(object["percent"], percent) || percent < 0.0 || percent > 100000.0) return false;
  limit.percent = static_cast<float>(std::max(0.0, std::min(100.0, percent)));

  const char* label = object["label"].as<const char*>();
  if (label && *label) copyText(limit.label, sizeof(limit.label), label);
  if (!limit.label[0]) {
    const char* kind = object["kind"].as<const char*>();
    if (kind && *kind) copyText(limit.label, sizeof(limit.label), kind);
  }

  double windowHours = 0;
  if (readNumber(object["window_hours"], windowHours) && windowHours > 0.0 && windowHours <= 1000.0) {
    limit.windowHours = static_cast<float>(windowHours);
    limit.hasWindow = true;
  } else {
    limit.windowHours = inferredWindowHours(limit.label);
    limit.hasWindow = limit.windowHours > 0.0f;
  }
  if (!limit.label[0]) {
    copyText(limit.label, sizeof(limit.label), limit.hasWindow && limit.windowHours <= 24.0f ? "5-hour" : "Usage");
  }

  uint64_t resetEpochMs = 0;
  if (readTimestamp(object["resets_at"], resetEpochMs)) {
    limit.resetEpochMs = resetEpochMs;
    limit.hasReset = true;
  }
  const char* resetLabel = object["reset_label"].as<const char*>();
  if (resetLabel && *resetLabel) copyText(limit.resetLabel, sizeof(limit.resetLabel), resetLabel);
  return true;
}

void normalizeSectionName(UsageSection& section) {
  if (containsIgnoreCase(section.id, "claude")) copyText(section.id, sizeof(section.id), "claude");
  else if (containsIgnoreCase(section.id, "codex")) copyText(section.id, sizeof(section.id), "codex");

  if (!section.name[0]) {
    if (equalsIgnoreCase(section.id, "claude")) copyText(section.name, sizeof(section.name), "Claude Code");
    else if (equalsIgnoreCase(section.id, "codex")) copyText(section.name, sizeof(section.name), "Codex");
    else copyText(section.name, sizeof(section.name), section.id[0] ? section.id : "Meter");
  }
}

bool parseUsageObject(JsonObjectConst root, UsageSnapshot& snapshot, char* error, size_t errorSize) {
  clearSnapshot(snapshot);
  if (error && errorSize > 0) error[0] = '\0';
  if (root.isNull()) {
    writeError(error, errorSize, "JSON root is not an object");
    return false;
  }

  uint64_t generatedAt = 0;
  if (readTimestamp(root["server_time_ms"], generatedAt) ||
      readTimestamp(root["generated_at"], generatedAt)) {
    snapshot.generatedAtEpochMs = generatedAt;
    snapshot.hasGeneratedAt = true;
  }

  const JsonArrayConst sections = root["sections"].as<JsonArrayConst>();
  if (sections.isNull()) {
    writeError(error, errorSize, "missing sections array");
    return false;
  }

  for (JsonVariantConst rawSection : sections) {
    if (snapshot.sectionCount >= kMaxSections) break;
    const JsonObjectConst object = rawSection.as<JsonObjectConst>();
    if (object.isNull()) continue;

    UsageSection& section = snapshot.sections[snapshot.sectionCount];
    clearSection(section);
    section.present = true;

    const char* id = object["id"].as<const char*>();
    const char* name = object["name"].as<const char*>();
    if (id && *id) copyText(section.id, sizeof(section.id), id);
    if (name && *name) copyText(section.name, sizeof(section.name), name);
    if (!section.id[0] && name && *name) copyText(section.id, sizeof(section.id), name);
    if (!section.id[0]) copyText(section.id, sizeof(section.id), snapshot.sectionCount == 0 ? "claude" : "codex");
    normalizeSectionName(section);

    if (object["installed"].is<bool>()) section.installed = object["installed"].as<bool>();
    const char* plan = object["plan"].as<const char*>();
    if (plan) copyText(section.plan, sizeof(section.plan), plan);

    section.hasError = readErrorFlag(object["error"]);
    section.authRequired = readFlag(object["auth_required"]);
    section.refreshError = readFlag(object["refresh_error"]);

    double staleMs = 0;
    if (readNumber(object["stale_ms"], staleMs) && staleMs > 0.0) {
      section.staleMs = staleMs >= 4294967295.0 ? UINT32_MAX : static_cast<uint32_t>(staleMs);
      snapshot.serverStaleMs = std::max(snapshot.serverStaleMs, section.staleMs);
    }

    const JsonArrayConst limits = object["limits"].as<JsonArrayConst>();
    if (!limits.isNull()) {
      bool sawInvalidLimit = false;
      for (JsonVariantConst rawLimit : limits) {
        if (section.limitCount >= kMaxLimitsPerSection) break;
        const JsonObjectConst limitObject = rawLimit.as<JsonObjectConst>();
        if (limitObject.isNull()) {
          sawInvalidLimit = true;
          continue;
        }
        UsageLimit& limit = section.limits[section.limitCount];
        if (readLimit(limitObject, limit)) ++section.limitCount;
        else sawInvalidLimit = true;
      }
      if (sawInvalidLimit && section.limitCount == 0) section.hasError = true;
    }

    ++snapshot.sectionCount;
  }

  if (snapshot.sectionCount == 0) {
    writeError(error, errorSize, "sections array is empty");
    return false;
  }
  snapshot.valid = true;
  return true;
}

}  // namespace

bool parseUsageJson(const char* json, size_t jsonLength, UsageSnapshot& snapshot, char* error, size_t errorSize) {
  clearSnapshot(snapshot);
  if (error && errorSize > 0) error[0] = '\0';
  if (!json || jsonLength == 0 || jsonLength > kMaxPayloadBytes) {
    writeError(error, errorSize, "payload too large or empty");
    return false;
  }

  JsonDocument document;
  const DeserializationError parseError = deserializeJson(document, json, jsonLength);
  if (parseError) {
    writeError(error, errorSize, "invalid JSON");
    return false;
  }
  return parseUsageObject(document.as<JsonObjectConst>(), snapshot, error, errorSize);
}

bool parseUsageEnvelope(const char* json, size_t jsonLength, UsageSnapshot& snapshot, char* error, size_t errorSize) {
  clearSnapshot(snapshot);
  if (error && errorSize > 0) error[0] = '\0';
  if (!json || jsonLength == 0 || jsonLength > kMaxPayloadBytes) {
    writeError(error, errorSize, "payload too large or empty");
    return false;
  }

  JsonDocument document;
  const DeserializationError parseError = deserializeJson(document, json, jsonLength);
  if (parseError) {
    writeError(error, errorSize, "invalid JSON");
    return false;
  }

  const JsonObjectConst root = document.as<JsonObjectConst>();
  if (root.isNull()) {
    writeError(error, errorSize, "JSON root is not an object");
    return false;
  }
  const char* type = root["type"].as<const char*>();
  if (!type || strcmp(type, "usage") != 0) {
    writeError(error, errorSize, "usage envelope required");
    return false;
  }
  const JsonObjectConst data = root["data"].as<JsonObjectConst>();
  if (data.isNull()) {
    writeError(error, errorSize, "usage envelope data is not an object");
    return false;
  }
  return parseUsageObject(data, snapshot, error, errorSize);
}

}  // namespace ccmeter
