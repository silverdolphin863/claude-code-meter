#pragma once

#include "usage_model.h"

namespace ccmeter {

constexpr int kUiRefreshIconCenterX = 418;
constexpr int kUiSettingsIconCenterX = 452;
// Finger targets are deliberately larger than the 18 px glyphs. The cards
// begin below this header zone, and the midpoint keeps refresh/settings apart.
constexpr int kUiHeaderTouchBottom = 64;
constexpr int kUiRefreshTouchLeft = 360;
constexpr int kUiRefreshTouchRight = 438;
constexpr int kUiSettingsTouchLeft = 438;
constexpr int kUiSettingsTouchRight = 479;
constexpr uint32_t kUiRefreshAnimationFrameMs = 100;

static_assert(kUiRefreshTouchLeft < kUiRefreshIconCenterX &&
              kUiRefreshIconCenterX < kUiRefreshTouchRight);
static_assert(kUiSettingsTouchLeft < kUiSettingsIconCenterX &&
              kUiSettingsIconCenterX < kUiSettingsTouchRight);
static_assert(kUiRefreshTouchRight <= kUiSettingsTouchLeft);

enum class UiState : uint8_t {
  Setup,
  ConfigPortal,
  Connecting,
  Online,
  SerialOnline,
  Stale,
  Offline,
  AuthenticationError,
};

void uiDraw(const UsageSnapshot* snapshot, UiState state, bool refreshing,
            uint64_t nowEpochMs, uint64_t dataAgeMs, const char* apSsid, const char* apIp);
void uiRefreshDynamic(const UsageSnapshot* snapshot, UiState state, bool refreshing,
                      uint64_t nowEpochMs, uint64_t dataAgeMs);
void uiRefreshSnapshot(const UsageSnapshot* snapshot, UiState state, bool refreshing,
                       uint64_t nowEpochMs, uint64_t dataAgeMs);
void uiRefreshHeader(UiState state, bool refreshing, uint64_t dataAgeMs);

}  // namespace ccmeter
