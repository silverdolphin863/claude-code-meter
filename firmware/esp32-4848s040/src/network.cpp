#include "network.h"

#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

namespace ccmeter {
namespace {

constexpr size_t kMaxResponseBytes = 32768;

String usageUrl(const String& baseUrl, bool refresh) {
  String url = baseUrl;
  while (url.endsWith("/") && url.length() > 8) url.remove(url.length() - 1);
  if (!url.endsWith("/panel/v1/usage") && !url.endsWith("/usage.json")) url += "/panel/v1/usage";
  if (refresh) url += url.indexOf('?') >= 0 ? "&refresh=1" : "?refresh=1";
  return url;
}

}  // namespace

UsageClient::UsageClient(const DeviceConfig& config) : config_(config) {}

FetchResult UsageClient::fetch(bool refresh, UsageSnapshot& snapshot) const {
  if (!config_.configured() || WiFi.status() != WL_CONNECTED) return FetchResult::Offline;

  const String url = usageUrl(config_.baseUrl, refresh);
  HTTPClient http;
  WiFiClient plainClient;
  WiFiClientSecure secureClient;
  bool began = false;
  if (url.startsWith("https://")) {
    // A user-provisioned CA is not available in this small device image. The
    // endpoint contract therefore recommends HTTPS on a trusted local route.
    secureClient.setInsecure();
    began = http.begin(secureClient, url);
  } else {
    began = http.begin(plainClient, url);
  }
  if (!began) return FetchResult::Offline;

  http.setConnectTimeout(5000);
  http.setTimeout(8000);
  http.addHeader("Authorization", String("Bearer ") + config_.token);
  const int status = http.GET();
  if (status == 401 || status == 403) {
    http.end();
    return FetchResult::AuthenticationError;
  }
  if (status < 200 || status >= 300) {
    http.end();
    return status < 0 ? FetchResult::Offline : FetchResult::ServerError;
  }

  const int responseLength = http.getSize();
  if (responseLength > static_cast<int>(kMaxResponseBytes)) {
    http.end();
    return FetchResult::InvalidPayload;
  }
  const String body = http.getString();
  http.end();
  if (body.length() == 0 || body.length() > kMaxResponseBytes) return FetchResult::InvalidPayload;

  UsageSnapshot parsed;
  char parseError[64] = {};
  if (!parseUsageJson(body.c_str(), body.length(), parsed, parseError, sizeof(parseError))) {
    return FetchResult::InvalidPayload;
  }
  snapshot = parsed;
  return FetchResult::Success;
}

}  // namespace ccmeter
