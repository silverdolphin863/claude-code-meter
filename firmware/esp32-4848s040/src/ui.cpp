#include "ui.h"

#include "display.h"
#include "smooth_font_data.h"

#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <algorithm>
#include <cstdio>
#include <cstring>

#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif

namespace ccmeter {
namespace {

constexpr int kScreenWidth = 480;
constexpr int kScreenHeight = 480;
constexpr int kOuterMargin = 14;
constexpr int kCardWidth = kScreenWidth - kOuterMargin * 2;
constexpr int kHeaderHeight = 54;
constexpr int kCardGap = 8;
constexpr int kCardHeaderHeight = 34;
constexpr int kCardEmptyHeight = 84;
constexpr int kCardBottomPadding = 14;
constexpr int kBottomMargin = 12;
constexpr int kContentLeft = 29;
constexpr int kContentRight = 451;
constexpr int kContentWidth = kContentRight - kContentLeft;
constexpr size_t kMaxVisibleLimits = 5;

Arduino_GFX* canvas() {
  return displayCanvas();
}

uint16_t rgb(uint8_t red, uint8_t green, uint8_t blue) {
  return canvas()->color565(red, green, blue);
}

constexpr uint16_t rgb565(uint8_t red, uint8_t green, uint8_t blue) {
  return static_cast<uint16_t>(((red & 0xF8) << 8) | ((green & 0xFC) << 3) | (blue >> 3));
}

const uint16_t kBackground = rgb565(20, 19, 26);
const uint16_t kCard = rgb565(30, 28, 39);
const uint16_t kTrack = rgb565(38, 35, 50);
const uint16_t kLine = rgb565(47, 44, 59);
const uint16_t kText = rgb565(244, 242, 249);
const uint16_t kMuted = rgb565(139, 133, 160);
const uint16_t kAccent = rgb565(167, 139, 250);
const uint16_t kBadge = rgb565(48, 45, 57);

uint16_t toneColor(UsageTone tone) {
  switch (tone) {
    case UsageTone::Red: return rgb(255, 91, 91);
    case UsageTone::Amber: return rgb(255, 202, 59);
    case UsageTone::Green: return rgb(57, 217, 138);
  }
  return kText;
}

const SmoothFont& fontForSize(uint8_t size) {
  return size >= 2 ? kSmoothFont15 : kSmoothFont11;
}

int textWidth(const char* text, uint8_t size) {
  return smoothTextWidth(fontForSize(size), text);
}

void drawFontText(int x, int y, const char* text, const SmoothFont& font,
                  uint16_t color, uint16_t background) {
  if (!text || !*text) return;
  drawSmoothText(canvas(), x, y, text, font, color, background);
}

void drawFontRightText(int right, int y, const char* text, const SmoothFont& font,
                       uint16_t color, uint16_t background) {
  drawFontText(right - smoothTextWidth(font, text), y, text, font, color, background);
}

void drawFontCenteredText(int x, int width, int y, const char* text, const SmoothFont& font,
                          uint16_t color, uint16_t background) {
  drawFontText(x + (width - smoothTextWidth(font, text)) / 2, y, text, font, color, background);
}

void drawText(int x, int y, const char* text, uint8_t size, uint16_t color, uint16_t background = kCard) {
  drawFontText(x, y, text, fontForSize(size), color, background);
}

void drawRightText(int right, int y, const char* text, uint8_t size, uint16_t color,
                   uint16_t background = kCard) {
  drawFontRightText(right, y, text, fontForSize(size), color, background);
}

void drawCenteredText(int x, int width, int y, const char* text, uint8_t size, uint16_t color,
                      uint16_t background = kCard) {
  drawFontCenteredText(x, width, y, text, fontForSize(size), color, background);
}

void drawRefreshIcon(int centerX, int centerY, bool active) {
  const uint16_t color = active ? kAccent : kMuted;
  canvas()->fillArc(centerX, centerY, 9, 8, 205, 350, color);
  canvas()->fillArc(centerX, centerY, 9, 8, 25, 170, color);
  canvas()->fillTriangle(centerX - 9, centerY - 4, centerX - 9, centerY - 9,
                         centerX - 4, centerY - 4, color);
  canvas()->fillTriangle(centerX + 9, centerY + 4, centerX + 9, centerY + 9,
                         centerX + 4, centerY + 4, color);
}

void drawSettingsIcon(int centerX, int centerY, bool active) {
  const uint16_t color = active ? kAccent : kMuted;
  canvas()->drawCircle(centerX, centerY, 7, color);
  canvas()->fillCircle(centerX, centerY, 3, color);
  for (int offset = -1; offset <= 1; offset += 2) {
    canvas()->drawLine(centerX + offset * 5, centerY - 10, centerX + offset * 4, centerY - 7, color);
    canvas()->drawLine(centerX + offset * 5, centerY + 10, centerX + offset * 4, centerY + 7, color);
    canvas()->drawLine(centerX - 10, centerY + offset * 5, centerX - 7, centerY + offset * 4, color);
    canvas()->drawLine(centerX + 10, centerY + offset * 5, centerX + 7, centerY + offset * 4, color);
  }
}

void drawClockIcon(int centerX, int centerY) {
  canvas()->drawCircle(centerX, centerY, 5, kMuted);
  canvas()->drawLine(centerX, centerY, centerX, centerY - 3, kMuted);
  canvas()->drawLine(centerX, centerY, centerX + 3, centerY + 2, kMuted);
}

const char* stateLabel(UiState state) {
  switch (state) {
    case UiState::Setup: return "USB WAIT";
    case UiState::ConfigPortal: return "CONFIG AP";
    case UiState::Connecting: return "CONNECTING";
    case UiState::Online: return "ONLINE";
    case UiState::SerialOnline: return "SERIAL";
    case UiState::Stale: return "STALE";
    case UiState::Offline: return "OFFLINE";
    case UiState::AuthenticationError: return "AUTH ERROR";
  }
  return "UNKNOWN";
}

UsageTone stateTone(UiState state) {
  switch (state) {
    case UiState::Online:
    case UiState::SerialOnline: return UsageTone::Green;
    case UiState::Setup:
    case UiState::ConfigPortal:
    case UiState::Connecting:
    case UiState::Stale: return UsageTone::Amber;
    case UiState::Offline:
    case UiState::AuthenticationError: return UsageTone::Red;
  }
  return UsageTone::Red;
}

void drawHeaderDynamic(UiState state, bool refreshing, uint64_t dataAgeMs) {
  char age[16] = {};
  formatAge(dataAgeMs, age, sizeof(age));
  drawFontRightText(341, 20, age, kSmoothFont11, kMuted, kBackground);
  canvas()->fillCircle(354, 27, 4, toneColor(stateTone(state)));
  drawFontRightText(393, 20, state == UiState::SerialOnline ? "USB" : stateLabel(state),
                    kSmoothFont11, toneColor(stateTone(state)), kBackground);
  drawRefreshIcon(kUiRefreshIconCenterX, 27, refreshing);
  drawSettingsIcon(kUiSettingsIconCenterX, 27, state == UiState::ConfigPortal);
}

void uppercaseCopy(const char* source, char* destination, size_t destinationSize) {
  if (!destination || destinationSize == 0) return;
  if (!source) source = "";
  size_t i = 0;
  for (; source[i] && i + 1 < destinationSize; ++i) {
    const char character = source[i];
    destination[i] = character >= 'a' && character <= 'z' ? static_cast<char>(character - ('a' - 'A')) : character;
  }
  destination[i] = '\0';
}

const char* sectionDisplayName(const UsageSection& section) {
  if (strcmp(section.id, "claude") == 0) return "CLAUDE CODE";
  if (strcmp(section.id, "codex") == 0) return "CODEX";
  return section.name;
}

const char* limitDisplayLabel(const UsageLimit& limit) {
  return strcmp(limit.label, "Weekly, all models") == 0 ? "Weekly" : limit.label;
}

size_t visibleLimitCount(const UsageSection* section) {
  if (!section) return 0;
  return std::min(kMaxVisibleLimits, static_cast<size_t>(section->limitCount));
}

int sectionHeight(const UsageSection* section, int rowHeight) {
  const size_t count = visibleLimitCount(section);
  return count == 0 ? kCardEmptyHeight
                    : kCardHeaderHeight + static_cast<int>(count) * rowHeight + kCardBottomPadding;
}

void drawSetupBody(UiState state, const char* apSsid, const char* apIp) {
  const int y = 64;
  const int height = 336;
  canvas()->fillRoundRect(kOuterMargin, y, kCardWidth, height, 15, kCard);
  canvas()->drawRoundRect(kOuterMargin, y, kCardWidth, height, 15, kLine);

  if (state == UiState::ConfigPortal) {
    drawText(34, y + 22, "OPTIONAL WI-FI SETUP", 2, kText);
    drawText(34, y + 64, "Join the local setup Wi-Fi:", 1, kMuted);
    drawText(34, y + 87, apSsid && *apSsid ? apSsid : "CCMeter-Setup", 2, kAccent);
    drawText(34, y + 128, "Open this address in a browser:", 1, kMuted);
    drawText(34, y + 151, apIp && *apIp ? apIp : "192.168.4.1", 2, kAccent);
    drawText(34, y + 198, "Save Wi-Fi, panel URL, and token", 1, kText);
    drawText(34, y + 220, "in the private setup form.", 1, kText);
    drawText(34, y + 267, "Press CFG again to return to USB.", 1, kMuted);
    return;
  }
  drawText(34, y + 22, "USB CONNECTION", 2, kText);
  drawText(34, y + 72, "Open CC Meter Settings", 2, kAccent);
  drawText(34, y + 112, "Enable ESP32 hardware display", 1, kText);
  drawText(34, y + 142, "Usage appears here automatically.", 1, kText);
  drawText(34, y + 198, "USB carries power and live data.", 1, kMuted);
  drawText(34, y + 246, "CFG opens optional Wi-Fi setup.", 1, kMuted);
}

void drawEmptyBody(UiState state) {
  const int y = 64;
  const int height = 245;
  canvas()->fillRoundRect(kOuterMargin, y, kCardWidth, height, 15, kCard);
  canvas()->drawRoundRect(kOuterMargin, y, kCardWidth, height, 15, kLine);
  drawCenteredText(kOuterMargin, kCardWidth, y + 58, stateLabel(state), 2, toneColor(stateTone(state)));
  switch (state) {
    case UiState::Connecting:
      drawCenteredText(kOuterMargin, kCardWidth, y + 111, "Connecting to Wi-Fi", 1, kMuted);
      drawCenteredText(kOuterMargin, kCardWidth, y + 133, "then requesting usage", 1, kMuted);
      break;
    case UiState::AuthenticationError:
      drawCenteredText(kOuterMargin, kCardWidth, y + 111, "Check the saved bearer token", 1, kMuted);
      drawCenteredText(kOuterMargin, kCardWidth, y + 133, "and panel access policy", 1, kMuted);
      break;
    case UiState::Offline:
      drawCenteredText(kOuterMargin, kCardWidth, y + 111, "No valid response from the panel", 1, kMuted);
      drawCenteredText(kOuterMargin, kCardWidth, y + 133, "Last valid values are retained", 1, kMuted);
      break;
    default:
      drawCenteredText(kOuterMargin, kCardWidth, y + 111, "Waiting for the first valid response", 1, kMuted);
      break;
  }
}

void drawLimitMetrics(const UsageLimit& limit, int labelY, uint64_t nowEpochMs) {
  const uint16_t usageColor = toneColor(usageTone(limit.percent));
  char percent[8] = {};
  snprintf(percent, sizeof(percent), "%d%%", static_cast<int>(limit.percent + 0.5f));

  const float pace = calculatePace(limit.percent, limit.hasReset ? limit.resetEpochMs : 0,
                                   limit.hasWindow ? limit.windowHours : 0.0f, nowEpochMs);
  constexpr int kPaceWidth = 54;
  constexpr int kPaceHeight = 22;
  constexpr int kMetricGap = 9;
  const int paceX = kContentRight - kPaceWidth;
  drawFontRightText(pace >= 0.0f ? paceX - kMetricGap : kContentRight,
                    labelY, percent, kSmoothFont18, usageColor, kCard);
  if (pace >= 0.0f) {
    char paceText[12] = {};
    snprintf(paceText, sizeof(paceText), "%.1fx", pace);
    canvas()->fillRoundRect(paceX, labelY, kPaceWidth, kPaceHeight, 6, kBadge);
    drawFontCenteredText(paceX, kPaceWidth, labelY + 1, paceText, kSmoothFont15,
                         toneColor(paceTone(pace)), kBadge);
  }
}

void drawLimitReset(const UsageLimit& limit, int subY, uint64_t nowEpochMs) {
  char countdown[32] = {};
  char resetLabel[24] = {};
  formatCountdown(limit.hasReset ? limit.resetEpochMs : 0, nowEpochMs, countdown, sizeof(countdown));
  if (limit.resetLabel[0]) {
    strncpy(resetLabel, limit.resetLabel, sizeof(resetLabel) - 1);
  } else {
    formatResetLabel(limit.hasReset ? limit.resetEpochMs : 0, limit.hasWindow ? limit.windowHours : 0.0f,
                     resetLabel, sizeof(resetLabel));
  }

  const char* countdownText = countdown[0] ? countdown : "No reset";
  constexpr const char* kResetPrefix = "Resets in ";
  if (strncmp(countdownText, kResetPrefix, strlen(kResetPrefix)) == 0) {
    countdownText += strlen(kResetPrefix);
  }
  drawClockIcon(kContentLeft + 6, subY + 8);
  drawFontText(kContentLeft + 18, subY, countdownText, kSmoothFont15, rgb(184, 178, 200), kCard);
  if (resetLabel[0]) {
    char target[sizeof(resetLabel)] = {};
    uppercaseCopy(resetLabel, target, sizeof(target));
    drawFontRightText(kContentRight, subY + 1, target, kSmoothFont13, kMuted, kCard);
  }
}

void drawLimitBar(const UsageLimit& limit, int barY) {
  const uint16_t usageColor = toneColor(usageTone(limit.percent));
  constexpr int kBarHeight = 12;
  constexpr int kStripeSpan = kBarHeight - 1;
  canvas()->fillRoundRect(kContentLeft, barY, kContentWidth, kBarHeight, 6, kTrack);
  for (int stripe = kContentLeft + 6; stripe + kStripeSpan < kContentRight - 6; stripe += 14) {
    canvas()->drawLine(stripe, barY + kStripeSpan, stripe + kStripeSpan, barY, rgb(55, 51, 67));
  }
  const int fillWidth = static_cast<int>(kContentWidth *
      std::max(0.0f, std::min(100.0f, limit.percent)) / 100.0f);
  if (fillWidth > 0) {
    canvas()->fillRoundRect(kContentLeft, barY, std::max(6, fillWidth), kBarHeight, 6, usageColor);
  }
}

void drawLimitRow(const UsageLimit& limit, int y, int rowHeight, uint64_t nowEpochMs) {
  const int labelY = y;
  drawFontText(kContentLeft, labelY, limitDisplayLabel(limit), kSmoothFont18, kText, kCard);
  drawLimitMetrics(limit, labelY, nowEpochMs);

  const int barY = y + 28;
  drawLimitBar(limit, barY);

  const int subY = y + (rowHeight >= 64 ? 47 : 42);
  drawLimitReset(limit, subY, nowEpochMs);
}

void refreshLimitRow(const UsageLimit& limit, int y, int rowHeight, uint64_t nowEpochMs) {
  constexpr int kLabelTopPadding = 1;
  constexpr int kLabelHeight = 24;
  const int labelY = y - kLabelTopPadding;
  canvas()->fillRect(kContentLeft, labelY, kContentWidth, kLabelHeight, kCard);
  drawFontText(kContentLeft, y, limitDisplayLabel(limit), kSmoothFont18, kText, kCard);
  drawLimitMetrics(limit, y, nowEpochMs);
  displayFlushRect(kContentLeft, labelY, kContentWidth, kLabelHeight);

  constexpr int kBarHeight = 12;
  const int barY = y + 28;
  canvas()->fillRect(kContentLeft, barY, kContentWidth, kBarHeight, kCard);
  drawLimitBar(limit, barY);
  displayFlushRect(kContentLeft, barY, kContentWidth, kBarHeight);

  constexpr int kSubTopPadding = 1;
  constexpr int kSubHeight = 22;
  const int subY = y + (rowHeight >= 64 ? 47 : 42);
  canvas()->fillRect(kContentLeft, subY - kSubTopPadding, kContentWidth, kSubHeight, kCard);
  drawLimitReset(limit, subY, nowEpochMs);
  displayFlushRect(kContentLeft, subY - kSubTopPadding, kContentWidth, kSubHeight);
}

void refreshLimitTime(const UsageLimit& limit, int y, int rowHeight, uint64_t nowEpochMs) {
  constexpr int kMetricLeft = 340;
  constexpr int kMetricTopPadding = 1;
  constexpr int kMetricHeight = 24;
  const int metricY = y - kMetricTopPadding;
  canvas()->fillRect(kMetricLeft, metricY, kContentRight - kMetricLeft + 1, kMetricHeight, kCard);
  drawLimitMetrics(limit, y, nowEpochMs);
  displayFlushRect(kMetricLeft, metricY, kContentRight - kMetricLeft + 1, kMetricHeight);

  constexpr int kSubTopPadding = 1;
  constexpr int kSubHeight = 22;
  const int subY = y + (rowHeight >= 64 ? 47 : 42);
  canvas()->fillRect(kContentLeft, subY - kSubTopPadding, kContentWidth, kSubHeight, kCard);
  drawLimitReset(limit, subY, nowEpochMs);
  displayFlushRect(kContentLeft, subY - kSubTopPadding, kContentWidth, kSubHeight);
}

void calculateRowHeights(const UsageSection* claude, const UsageSection* codex,
                         int& claudeRowHeight, int& codexRowHeight) {
  const size_t claudeRows = visibleLimitCount(claude);
  const size_t codexRows = visibleLimitCount(codex);
  const size_t totalRows = claudeRows + codexRows;
  claudeRowHeight = 62;
  codexRowHeight = 62;

  if (claudeRows == 3 && codexRows == 1) {
    claudeRowHeight = 82;
    codexRowHeight = 64;
  } else if (totalRows > 0) {
    const int fixedHeight = kCardHeaderHeight * 2 + kCardGap + kCardBottomPadding * 2;
    const int availableRows = kScreenHeight - kHeaderHeight - kBottomMargin - fixedHeight;
    const int sharedRowHeight = std::min(82, std::max(54, availableRows / static_cast<int>(totalRows)));
    claudeRowHeight = sharedRowHeight;
    codexRowHeight = sharedRowHeight;
  }
}

void refreshSection(const UsageSection* section, int y, int rowHeight,
                    uint64_t nowEpochMs, bool snapshotValuesChanged) {
  if (!section) return;
  const size_t count = visibleLimitCount(section);
  for (size_t i = 0; i < count; ++i) {
    const int rowY = y + kCardHeaderHeight + static_cast<int>(i) * rowHeight;
    if (snapshotValuesChanged) refreshLimitRow(section->limits[i], rowY, rowHeight, nowEpochMs);
    else refreshLimitTime(section->limits[i], rowY, rowHeight, nowEpochMs);
  }
}

void drawSection(const UsageSection* source, const char* fallbackId, int y, int rowHeight, uint64_t nowEpochMs) {
  UsageSection empty;
  clearSection(empty);
  if (!source) {
    empty.present = false;
    strncpy(empty.id, fallbackId, sizeof(empty.id) - 1);
    strncpy(empty.name, strcmp(fallbackId, "claude") == 0 ? "Claude Code" : "Codex", sizeof(empty.name) - 1);
    source = &empty;
  }

  const size_t count = visibleLimitCount(source);
  const int height = sectionHeight(source, rowHeight);
  canvas()->fillRoundRect(kOuterMargin, y, kCardWidth, height, 15, kCard);
  canvas()->drawRoundRect(kOuterMargin, y, kCardWidth, height, 15, kLine);
  drawFontText(kContentLeft, y + 6, sectionDisplayName(*source), kSmoothFont13, kMuted, kCard);

  char plan[sizeof(source->plan)] = {};
  uppercaseCopy(source->plan, plan, sizeof(plan));
  if (plan[0]) {
    drawFontText(std::min(330, kContentLeft + smoothTextWidth(kSmoothFont13, sectionDisplayName(*source)) + 7),
                 y + 8, plan, kSmoothFont11, kAccent, kCard);
  }
  if (source->authRequired) {
    drawFontRightText(kContentRight, y + 8, "AUTH", kSmoothFont11, toneColor(UsageTone::Red), kCard);
  } else if (source->hasError || source->refreshError) {
    drawFontRightText(kContentRight, y + 8, "ERROR", kSmoothFont11, toneColor(UsageTone::Red), kCard);
  }

  if (count == 0) {
    drawFontText(kContentLeft, y + 49, source->authRequired ? "Authentication required" : "No current data",
                 kSmoothFont13, source->authRequired ? toneColor(UsageTone::Red) : kMuted, kCard);
    return;
  }
  for (size_t i = 0; i < count; ++i) drawLimitRow(source->limits[i], y + kCardHeaderHeight + static_cast<int>(i) * rowHeight,
                                                    rowHeight, nowEpochMs);
  if (source->limitCount > count) {
    drawFontRightText(kContentRight, y + height - 17, "+ more", kSmoothFont11, kMuted, kCard);
  }
}

void refreshUiRegions(const UsageSnapshot* snapshot, UiState state, bool refreshing,
                      uint64_t nowEpochMs, uint64_t dataAgeMs, bool snapshotValuesChanged) {
  constexpr int kHeaderDynamicLeft = 276;
  constexpr int kHeaderDynamicTop = 14;
  constexpr int kHeaderDynamicWidth = 190;
  constexpr int kHeaderDynamicHeight = 28;
  canvas()->fillRect(kHeaderDynamicLeft, kHeaderDynamicTop,
                     kHeaderDynamicWidth, kHeaderDynamicHeight, kBackground);
  drawHeaderDynamic(state, refreshing, dataAgeMs);
  displayFlushRect(kHeaderDynamicLeft, kHeaderDynamicTop,
                   kHeaderDynamicWidth, kHeaderDynamicHeight);

  if (!snapshot || !snapshot->valid || state == UiState::Setup || state == UiState::ConfigPortal) return;

  const UsageSection* claude = findSection(*snapshot, "claude");
  const UsageSection* codex = findSection(*snapshot, "codex");
  int claudeRowHeight = 0;
  int codexRowHeight = 0;
  calculateRowHeights(claude, codex, claudeRowHeight, codexRowHeight);

  const int firstY = kHeaderHeight;
  refreshSection(claude, firstY, claudeRowHeight, nowEpochMs, snapshotValuesChanged);
  const int secondY = firstY + sectionHeight(claude, claudeRowHeight) + kCardGap;
  refreshSection(codex, secondY, codexRowHeight, nowEpochMs, snapshotValuesChanged);
}

}  // namespace

void uiDraw(const UsageSnapshot* snapshot, UiState state, bool refreshing,
            uint64_t nowEpochMs, uint64_t dataAgeMs, const char* apSsid, const char* apIp) {
  Arduino_GFX* display = canvas();
  display->fillScreen(kBackground);

  drawFontText(17, 16, "CC Meter", kSmoothFont18, kText, kBackground);
  drawHeaderDynamic(state, refreshing, dataAgeMs);

  if (state == UiState::Setup || state == UiState::ConfigPortal) {
    drawSetupBody(state, apSsid, apIp);
  } else if (!snapshot || !snapshot->valid) {
    drawEmptyBody(state);
  } else {
    const UsageSection* claude = findSection(*snapshot, "claude");
    const UsageSection* codex = findSection(*snapshot, "codex");
    const int firstY = kHeaderHeight;
    int claudeRowHeight = 0;
    int codexRowHeight = 0;
    calculateRowHeights(claude, codex, claudeRowHeight, codexRowHeight);

    drawSection(claude, "claude", firstY, claudeRowHeight, nowEpochMs);
    const int secondY = firstY + sectionHeight(claude, claudeRowHeight) + kCardGap;
    drawSection(codex, "codex", secondY, codexRowHeight, nowEpochMs);
  }

  // The RGB panel scans the same framebuffer that drawing commands modify.
  // Publish only after the complete frame is composed so the once-per-minute
  // countdown repaint cannot expose the cleared background between elements.
  display->flush();
}

void uiRefreshDynamic(const UsageSnapshot* snapshot, UiState state, bool refreshing,
                      uint64_t nowEpochMs, uint64_t dataAgeMs) {
  // The ST7701 panel scans a single framebuffer continuously. A complete cache
  // writeback can be seen as a flash, so the one-minute timer only redraws and
  // publishes the small regions whose text changes with time.
  refreshUiRegions(snapshot, state, refreshing, nowEpochMs, dataAgeMs, false);
}

void uiRefreshSnapshot(const UsageSnapshot* snapshot, UiState state, bool refreshing,
                       uint64_t nowEpochMs, uint64_t dataAgeMs) {
  refreshUiRegions(snapshot, state, refreshing, nowEpochMs, dataAgeMs, true);
}

}  // namespace ccmeter
