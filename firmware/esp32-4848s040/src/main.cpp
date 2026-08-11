#include "config_store.h"
#include "display.h"
#include "network.h"
#include "portal.h"
#include "serial_protocol.h"
#include "ui.h"
#include "usage_model_core.h"

#include <Arduino.h>
#include <WiFi.h>
#include <cstring>
#include <time.h>

namespace ccmeter {
namespace {

constexpr uint32_t kPollIntervalMs = 30000;
constexpr uint32_t kManualRefreshCooldownMs = 2000;
constexpr uint32_t kSerialRefreshTimeoutMs = 20000;
constexpr uint32_t kWifiAttemptTimeoutMs = 15000;
constexpr uint32_t kRenderIntervalMs = 60000;
constexpr uint64_t kStaleThresholdMs = 15ULL * 60ULL * 1000ULL;
constexpr size_t kSerialLineCapacity = 49152;
constexpr size_t kSerialRxBufferBytes = 8192;

DeviceConfig deviceConfig;
UsageClient usageClient(deviceConfig);
ConfigPortal configPortal;
UsageSnapshot usageSnapshot;

FetchResult lastFetchResult = FetchResult::Offline;
bool hasSnapshot = false;
bool hasPollAttempt = false;
bool stationConnected = false;
bool wifiAttempting = false;
bool refreshing = false;
bool serialRefreshPending = false;
bool touchDown = false;
bool serialUsageActive = false;
uint32_t wifiAttemptStartedAt = 0;
uint32_t nextPollAt = 0;
uint32_t lastManualRefreshAt = 0;
uint32_t serialRefreshRequestedAt = 0;
uint32_t nextRefreshAnimationAt = 0;
uint32_t lastSuccessAt = 0;
uint32_t nextRenderAt = 0;
bool fullRenderPending = true;
bool snapshotRenderPending = false;
uint64_t clockBaseEpochMs = 0;
uint32_t clockBaseMillis = 0;
bool clockValid = false;

char serialLine[kSerialLineCapacity + 1] = {};
size_t serialLineLength = 0;
bool serialDiscardLine = false;

bool due(uint32_t deadline, uint32_t now) {
  return static_cast<int32_t>(now - deadline) >= 0;
}

uint32_t elapsed(uint32_t now, uint32_t then) {
  return now - then;
}

bool limitVisuallyEqual(const UsageLimit& left, const UsageLimit& right) {
  return strcmp(left.label, right.label) == 0 &&
         strcmp(left.resetLabel, right.resetLabel) == 0 &&
         left.percent == right.percent &&
         left.windowHours == right.windowHours &&
         left.resetEpochMs == right.resetEpochMs &&
         left.hasWindow == right.hasWindow &&
         left.hasReset == right.hasReset;
}

bool sectionVisuallyEqual(const UsageSection& left, const UsageSection& right) {
  if (strcmp(left.id, right.id) != 0 || strcmp(left.name, right.name) != 0 ||
      strcmp(left.plan, right.plan) != 0 || left.limitCount != right.limitCount ||
      left.present != right.present || left.installed != right.installed ||
      left.authRequired != right.authRequired || left.refreshError != right.refreshError ||
      left.hasError != right.hasError) {
    return false;
  }
  for (size_t i = 0; i < left.limitCount; ++i) {
    if (!limitVisuallyEqual(left.limits[i], right.limits[i])) return false;
  }
  return true;
}

bool snapshotVisuallyEqual(const UsageSnapshot& left, const UsageSnapshot& right) {
  if (left.valid != right.valid || left.sectionCount != right.sectionCount) return false;
  for (size_t i = 0; i < left.sectionCount; ++i) {
    if (!sectionVisuallyEqual(left.sections[i], right.sections[i])) return false;
  }
  return true;
}

bool sectionLayoutEqual(const UsageSection& left, const UsageSection& right) {
  return strcmp(left.id, right.id) == 0 && strcmp(left.name, right.name) == 0 &&
         strcmp(left.plan, right.plan) == 0 && left.limitCount == right.limitCount &&
         left.present == right.present && left.installed == right.installed &&
         left.authRequired == right.authRequired && left.refreshError == right.refreshError &&
         left.hasError == right.hasError;
}

bool snapshotLayoutEqual(const UsageSnapshot& left, const UsageSnapshot& right) {
  if (left.valid != right.valid || left.sectionCount != right.sectionCount) return false;
  for (size_t i = 0; i < left.sectionCount; ++i) {
    if (!sectionLayoutEqual(left.sections[i], right.sections[i])) return false;
  }
  return true;
}

uint64_t systemEpochMs() {
  const time_t current = time(nullptr);
  if (current < 1700000000) return 0;
  return static_cast<uint64_t>(current) * 1000ULL;
}

uint64_t currentEpochMs() {
  if (clockValid) return clockBaseEpochMs + elapsed(millis(), clockBaseMillis);
  return systemEpochMs();
}

uint64_t dataAgeMs() {
  if (!hasSnapshot) return 0;
  return static_cast<uint64_t>(usageSnapshot.serverStaleMs) + elapsed(millis(), lastSuccessAt);
}

bool snapshotNeedsAuth() {
  if (!hasSnapshot) return false;
  for (size_t i = 0; i < usageSnapshot.sectionCount; ++i) {
    if (usageSnapshot.sections[i].authRequired) return true;
  }
  return false;
}

UiState currentUiState() {
  if (configPortal.active()) return UiState::ConfigPortal;
  if (lastFetchResult == FetchResult::AuthenticationError || snapshotNeedsAuth()) return UiState::AuthenticationError;
  if (serialUsageActive && hasSnapshot) {
    if (dataAgeMs() > kStaleThresholdMs) return UiState::Stale;
    return UiState::SerialOnline;
  }
  if (!deviceConfig.configured()) return UiState::Setup;
  if (!stationConnected) return wifiAttempting ? UiState::Connecting : UiState::Offline;
  if (!hasSnapshot) return UiState::Connecting;
  if (hasPollAttempt && lastFetchResult != FetchResult::Success) return UiState::Offline;
  if (dataAgeMs() > kStaleThresholdMs) return UiState::Stale;
  return UiState::Online;
}

void drawNow() {
  const String apSsid = configPortal.active() ? configPortal.ssid() : String();
  const String apIp = configPortal.active() ? configPortal.ipAddress() : String();
  uiDraw(hasSnapshot ? &usageSnapshot : nullptr, currentUiState(), refreshing, currentEpochMs(), dataAgeMs(),
         apSsid.c_str(), apIp.c_str());
  fullRenderPending = false;
  snapshotRenderPending = false;
  nextRenderAt = millis() + kRenderIntervalMs;
}

void requestFullRender() {
  fullRenderPending = true;
  snapshotRenderPending = false;
  nextRenderAt = 0;
}

void requestSnapshotRender() {
  if (fullRenderPending) return;
  snapshotRenderPending = true;
  nextRenderAt = 0;
}

void requestDynamicRender() {
  if (!fullRenderPending && !snapshotRenderPending) nextRenderAt = 0;
}

void refreshDynamicNow() {
  if (fullRenderPending) {
    drawNow();
    return;
  }
  if (snapshotRenderPending) {
    uiRefreshSnapshot(hasSnapshot ? &usageSnapshot : nullptr, currentUiState(), refreshing,
                      currentEpochMs(), dataAgeMs());
    snapshotRenderPending = false;
  } else {
    uiRefreshDynamic(hasSnapshot ? &usageSnapshot : nullptr, currentUiState(), refreshing,
                     currentEpochMs(), dataAgeMs());
  }
  nextRenderAt = millis() + kRenderIntervalMs;
}

void beginWifi() {
  if (!deviceConfig.configured()) return;
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(deviceConfig.ssid.c_str(), deviceConfig.password.c_str());
  wifiAttempting = true;
  wifiAttemptStartedAt = millis();
  stationConnected = false;
}

void serviceWifi() {
  if (!deviceConfig.configured()) return;
  if (configPortal.active()) return;
  const uint32_t now = millis();
  if (WiFi.status() == WL_CONNECTED) {
    if (!stationConnected) nextPollAt = now;
    stationConnected = true;
    wifiAttempting = false;
    return;
  }

  stationConnected = false;
  if (wifiAttempting && elapsed(now, wifiAttemptStartedAt) < kWifiAttemptTimeoutMs) return;
  beginWifi();
}

void applyUsageSnapshot(const UsageSnapshot& incomingSnapshot, bool fromSerial) {
  UsageSnapshot nextSnapshot = incomingSnapshot;
  const UiState previousUiState = currentUiState();
  const bool completedSerialRefresh = fromSerial && serialRefreshPending;
  const bool visibleDataChanged = !hasSnapshot || !snapshotVisuallyEqual(usageSnapshot, nextSnapshot);
  const bool layoutChanged = !hasSnapshot || !snapshotLayoutEqual(usageSnapshot, nextSnapshot);
  const uint64_t receivedSystemTime = systemEpochMs();
  if (nextSnapshot.hasGeneratedAt && receivedSystemTime > nextSnapshot.generatedAtEpochMs) {
    const uint64_t generatedAge = receivedSystemTime - nextSnapshot.generatedAtEpochMs;
    if (generatedAge < 7ULL * 86400000ULL && generatedAge > nextSnapshot.serverStaleMs) {
      nextSnapshot.serverStaleMs = generatedAge > UINT32_MAX ? UINT32_MAX : static_cast<uint32_t>(generatedAge);
    }
  }

  const uint32_t successAt = millis();
  if (completedSerialRefresh) {
    serialRefreshPending = false;
    refreshing = false;
  }
  usageSnapshot = nextSnapshot;
  hasSnapshot = true;
  hasPollAttempt = true;
  lastFetchResult = FetchResult::Success;
  lastSuccessAt = successAt;
  nextPollAt = successAt + kPollIntervalMs;
  if (fromSerial) serialUsageActive = true;

  if (nextSnapshot.hasGeneratedAt) {
    clockBaseEpochMs = nextSnapshot.generatedAtEpochMs;
    clockBaseMillis = successAt;
    clockValid = true;
  } else if (receivedSystemTime != 0) {
    clockBaseEpochMs = receivedSystemTime;
    clockBaseMillis = successAt;
    clockValid = true;
  }
  if (layoutChanged || currentUiState() != previousUiState) requestFullRender();
  else if (visibleDataChanged) requestSnapshotRender();
  else if (completedSerialRefresh) requestDynamicRender();
}

void performPoll(bool manual) {
  if (refreshing || !deviceConfig.configured()) return;
  if (manual && lastManualRefreshAt != 0 && elapsed(millis(), lastManualRefreshAt) < kManualRefreshCooldownMs) return;
  if (!stationConnected) {
    lastFetchResult = FetchResult::Offline;
    hasPollAttempt = true;
    return;
  }

  const UiState previousUiState = currentUiState();
  if (manual) lastManualRefreshAt = millis();
  refreshing = true;
  nextRefreshAnimationAt = millis();
  if (hasSnapshot && !fullRenderPending) refreshDynamicNow();
  else drawNow();
  UsageSnapshot nextSnapshot;
  const FetchResult result = usageClient.fetch(manual, nextSnapshot);
  hasPollAttempt = true;
  lastFetchResult = result;
  if (result == FetchResult::Success) {
    applyUsageSnapshot(nextSnapshot, false);
  }
  refreshing = false;
  nextPollAt = millis() + kPollIntervalMs;
  if (!hasSnapshot || currentUiState() != previousUiState) requestFullRender();
  else requestDynamicRender();
}

void servicePoll() {
  if (configPortal.active() || !stationConnected || refreshing || !due(nextPollAt, millis())) return;
  performPoll(false);
}

void processSerialCommand(const char* rawLine) {
  if (!rawLine) return;
  const char* firstNonWhitespace = rawLine;
  while (*firstNonWhitespace == ' ' || *firstNonWhitespace == '\t') ++firstNonWhitespace;
  if (*firstNonWhitespace == '{') {
    UsageSnapshot nextSnapshot;
    char parseError[64] = {};
    if (!parseUsageEnvelope(firstNonWhitespace, strlen(firstNonWhitespace), nextSnapshot,
                            parseError, sizeof(parseError))) {
      Serial.println(serialInvalidUsageLine());
      return;
    }
    applyUsageSnapshot(nextSnapshot, true);
    Serial.println(serialAckLine());
    return;
  }
  if (strcmp(rawLine, "HELP") == 0) {
    Serial.println("HELP STATUS | SET<TAB>ssid<TAB>password<TAB>base_url<TAB>token | CLEAR | usage JSON envelope");
    return;
  }
  if (strcmp(rawLine, "STATUS") == 0) {
    Serial.print("STATUS configured=");
    Serial.print(deviceConfig.configured() ? "yes" : "no");
    Serial.print(" wifi=");
    Serial.print(stationConnected ? "connected" : "disconnected");
    Serial.print(" portal=");
    Serial.println(configPortal.active() ? "active" : "inactive");
    return;
  }
  if (strcmp(rawLine, "CLEAR") == 0) {
    clearDeviceConfig();
    Serial.println("OK cleared; restarting");
    delay(50);
    ESP.restart();
    return;
  }
  if (strncmp(rawLine, "SET\t", 4) != 0) {
    Serial.println("ERR unknown command; send HELP");
    return;
  }

  const String command(rawLine);
  const int firstTab = command.indexOf('\t', 4);
  const int secondTab = firstTab < 0 ? -1 : command.indexOf('\t', firstTab + 1);
  const int thirdTab = secondTab < 0 ? -1 : command.indexOf('\t', secondTab + 1);
  if (firstTab < 0 || secondTab < 0 || thirdTab < 0) {
    Serial.println("ERR expected four tab-separated fields");
    return;
  }

  String ssid = command.substring(4, firstTab);
  String password = command.substring(firstTab + 1, secondTab);
  String baseUrl = command.substring(secondTab + 1, thirdTab);
  String token = command.substring(thirdTab + 1);
  ssid.trim();
  baseUrl.trim();
  if (ssid.indexOf('\t') >= 0 || password.indexOf('\t') >= 0 ||
      baseUrl.indexOf('\t') >= 0 || token.indexOf('\t') >= 0) {
    Serial.println("ERR tabs are not allowed inside fields");
    return;
  }

  char error[64] = {};
  if (!saveDeviceConfig(ssid, password, baseUrl, token, error, sizeof(error))) {
    Serial.println("ERR invalid configuration");
    return;
  }
  deviceConfig.ssid = ssid;
  deviceConfig.password = password;
  deviceConfig.baseUrl = baseUrl;
  while (deviceConfig.baseUrl.endsWith("/") && deviceConfig.baseUrl.length() > 8) {
    deviceConfig.baseUrl.remove(deviceConfig.baseUrl.length() - 1);
  }
  deviceConfig.token = token;
  if (configPortal.active()) configPortal.stop();
  hasSnapshot = false;
  hasPollAttempt = false;
  serialUsageActive = false;
  lastFetchResult = FetchResult::Offline;
  beginWifi();
  requestFullRender();
  Serial.println("OK configured; connecting");
}

void serviceSerial() {
  while (Serial.available() > 0) {
    const char character = static_cast<char>(Serial.read());
    if (character == '\r') continue;
    if (character == '\n') {
      if (!serialDiscardLine) {
        serialLine[serialLineLength] = '\0';
        processSerialCommand(serialLine);
      }
      serialLineLength = 0;
      serialDiscardLine = false;
      serialLine[0] = '\0';
      continue;
    }
    if (serialDiscardLine) continue;
    if (serialLineLength + 1 >= sizeof(serialLine)) {
      serialLineLength = 0;
      serialDiscardLine = true;
      serialLine[0] = '\0';
      Serial.println("ERR command too long");
      continue;
    }
    serialLine[serialLineLength++] = character;
  }
}

void serviceTouch() {
  int16_t x = 0;
  int16_t y = 0;
  const bool down = displayReadTouch(x, y);
  if (!down) {
    touchDown = false;
    return;
  }
  if (touchDown) return;
  touchDown = true;
  if (y <= kUiHeaderTouchBottom && x >= kUiRefreshTouchLeft && x < kUiRefreshTouchRight) {
    const uint32_t now = millis();
    if (lastManualRefreshAt != 0 && elapsed(now, lastManualRefreshAt) < kManualRefreshCooldownMs) return;
    Serial.println(serialRefreshLine());
    if (serialUsageActive || !deviceConfig.configured() || !stationConnected) {
      lastManualRefreshAt = now;
      serialRefreshPending = true;
      serialRefreshRequestedAt = now;
      refreshing = true;
      nextRefreshAnimationAt = now + kUiRefreshAnimationFrameMs;
      // Start visible motion immediately while the Windows host performs the
      // authenticated refresh.
      if (hasSnapshot && !fullRenderPending) refreshDynamicNow();
      else drawNow();
    } else {
      performPoll(true);
    }
    return;
  }
  if (y <= kUiHeaderTouchBottom && x >= kUiSettingsTouchLeft && x <= kUiSettingsTouchRight) {
    if (configPortal.active()) {
      configPortal.stop();
      if (deviceConfig.configured()) beginWifi();
    } else {
      configPortal.begin(deviceConfig, deviceConfig.configured());
    }
    requestFullRender();
  }
}

void serviceSerialRefreshTimeout() {
  if (!serialRefreshPending) return;
  if (elapsed(millis(), serialRefreshRequestedAt) < kSerialRefreshTimeoutMs) return;
  serialRefreshPending = false;
  refreshing = false;
  requestDynamicRender();
}

void serviceRefreshAnimation() {
  if (!refreshing || fullRenderPending || !due(nextRefreshAnimationAt, millis())) return;
  uiRefreshHeader(currentUiState(), true, dataAgeMs());
  nextRefreshAnimationAt = millis() + kUiRefreshAnimationFrameMs;
}

}  // namespace
}  // namespace ccmeter

void setup() {
  using namespace ccmeter;
  Serial.setRxBufferSize(kSerialRxBufferBytes);
  Serial.begin(115200);
  Serial.println(serialHelloLine());
  displayBegin();
  loadDeviceConfig(deviceConfig);
  if (deviceConfig.configured()) beginWifi();
  requestFullRender();
}

void loop() {
  using namespace ccmeter;
  configPortal.handle();
  serviceSerial();
  serviceWifi();
  servicePoll();
  serviceTouch();
  serviceSerialRefreshTimeout();
  serviceRefreshAnimation();
  if (due(nextRenderAt, millis())) refreshDynamicNow();
  delay(5);
}
