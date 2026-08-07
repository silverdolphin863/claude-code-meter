#pragma once

#include "usage_model_core.h"

#include <ArduinoJson.h>
#include <stddef.h>

namespace ccmeter {

bool parseUsageJson(const char* json, size_t jsonLength, UsageSnapshot& snapshot, char* error, size_t errorSize);
bool parseUsageEnvelope(const char* json, size_t jsonLength, UsageSnapshot& snapshot, char* error, size_t errorSize);

}  // namespace ccmeter
