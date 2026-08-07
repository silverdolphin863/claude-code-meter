#pragma once

#include "config_store.h"
#include "usage_model.h"

namespace ccmeter {

enum class FetchResult : uint8_t {
  Success,
  Offline,
  AuthenticationError,
  ServerError,
  InvalidPayload,
};

class UsageClient {
 public:
  explicit UsageClient(const DeviceConfig& config);

  FetchResult fetch(bool refresh, UsageSnapshot& snapshot) const;

 private:
  const DeviceConfig& config_;
};

}  // namespace ccmeter
