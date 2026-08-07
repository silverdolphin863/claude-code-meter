#include "config_store.h"

#include <Preferences.h>
#include <cstring>

namespace ccmeter {
namespace {

constexpr size_t kMaxSsidLength = 32;
constexpr size_t kMaxPasswordLength = 128;
constexpr size_t kMaxBaseUrlLength = 192;
constexpr size_t kMaxTokenLength = 512;

void writeError(char* output, size_t outputSize, const char* value) {
  if (!output || outputSize == 0) return;
  strncpy(output, value ? value : "invalid configuration", outputSize - 1);
  output[outputSize - 1] = '\0';
}

bool validText(const String& value, size_t maxLength) {
  if (value.length() == 0 || value.length() > maxLength) return false;
  for (size_t i = 0; i < value.length(); ++i) {
    const uint8_t character = static_cast<uint8_t>(value[i]);
    if (character < 32 || character == 127) return false;
  }
  return true;
}

bool validPassword(const String& value) {
  if (value.length() > kMaxPasswordLength) return false;
  for (size_t i = 0; i < value.length(); ++i) {
    const uint8_t character = static_cast<uint8_t>(value[i]);
    if (character < 32 || character == 127) return false;
  }
  return true;
}

bool validBaseUrl(String value) {
  value.trim();
  if (!validText(value, kMaxBaseUrlLength)) return false;
  if (!value.startsWith("http://") && !value.startsWith("https://")) return false;
  if (value.indexOf('?') >= 0 || value.indexOf('#') >= 0) return false;
  if (value.endsWith("//")) return false;
  return value.length() > 7;
}

}  // namespace

bool DeviceConfig::configured() const {
  return ssid.length() > 0 && baseUrl.length() > 0 && token.length() > 0;
}

void loadDeviceConfig(DeviceConfig& config) {
  Preferences preferences;
  if (!preferences.begin("ccmeter", true)) {
    config = DeviceConfig{};
    return;
  }
  config.ssid = preferences.getString("ssid", "");
  config.password = preferences.getString("password", "");
  config.baseUrl = preferences.getString("base_url", "");
  config.token = preferences.getString("token", "");
  preferences.end();
}

bool saveDeviceConfig(const String& ssid, const String& password, const String& baseUrl,
                      const String& token, char* error, size_t errorSize) {
  if (error && errorSize > 0) error[0] = '\0';
  String normalizedUrl = baseUrl;
  normalizedUrl.trim();
  while (normalizedUrl.endsWith("/") && normalizedUrl.length() > 8) normalizedUrl.remove(normalizedUrl.length() - 1);

  if (!validText(ssid, kMaxSsidLength) || !validPassword(password) ||
      !validBaseUrl(normalizedUrl) || !validText(token, kMaxTokenLength)) {
    writeError(error, errorSize, "invalid configuration fields");
    return false;
  }

  Preferences preferences;
  if (!preferences.begin("ccmeter", false)) {
    writeError(error, errorSize, "configuration storage unavailable");
    return false;
  }
  preferences.putString("ssid", ssid);
  preferences.putString("password", password);
  preferences.putString("base_url", normalizedUrl);
  preferences.putString("token", token);
  preferences.end();
  return true;
}

void clearDeviceConfig() {
  Preferences preferences;
  if (!preferences.begin("ccmeter", false)) return;
  preferences.clear();
  preferences.end();
}

}  // namespace ccmeter
