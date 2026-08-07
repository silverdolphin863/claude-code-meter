#pragma once

#include "usage_model.h"

namespace ccmeter {

constexpr int kUiRefreshIconCenterX = 418;
constexpr int kUiSettingsIconCenterX = 452;
constexpr int kUiHeaderTouchBottom = 45;
constexpr int kUiRefreshTouchLeft = 398;
constexpr int kUiRefreshTouchRight = 438;
constexpr int kUiSettingsTouchLeft = 438;
constexpr int kUiSettingsTouchRight = 479;

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

}  // namespace ccmeter
