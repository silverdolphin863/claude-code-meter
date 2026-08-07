#pragma once

#include <Arduino.h>
#include <stddef.h>

namespace ccmeter {

struct DeviceConfig {
  String ssid;
  String password;
  String baseUrl;
  String token;

  bool configured() const;
};

void loadDeviceConfig(DeviceConfig& config);
bool saveDeviceConfig(const String& ssid, const String& password, const String& baseUrl,
                      const String& token, char* error, size_t errorSize);
void clearDeviceConfig();

}  // namespace ccmeter
