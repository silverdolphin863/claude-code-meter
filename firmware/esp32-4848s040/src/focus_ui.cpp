#include "focus_ui.h"

#include "display.h"
#include "focus_geometry.h"
#include "smooth_font_data.h"

#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <math.h>
#include <stdio.h>

namespace ccmeter {
namespace {

constexpr uint16_t rgb565(uint8_t red, uint8_t green, uint8_t blue) {
  return static_cast<uint16_t>(((red & 0xF8) << 8) | ((green & 0xFC) << 3) | (blue >> 3));
}

// Palette shared with ui.cpp and docs/lcd-preview-pomodoro.html.
constexpr uint16_t kBackground = rgb565(20, 19, 26);
constexpr uint16_t kCard = rgb565(30, 28, 39);
constexpr uint16_t kLine = rgb565(47, 44, 59);
constexpr uint16_t kTrack = rgb565(38, 35, 50);
constexpr uint16_t kText = rgb565(244, 242, 249);
constexpr uint16_t kMuted = rgb565(139, 133, 160);
constexpr uint16_t kDim = rgb565(98, 92, 120);
constexpr uint16_t kFocusColor = rgb565(255, 122, 89);
constexpr uint16_t kBreakColor = rgb565(57, 217, 138);
constexpr uint16_t kWarnColor = rgb565(255, 202, 59);

constexpr int kHeaderCenterY = 27;
constexpr int kLabelTop = 54 + 136 + 46;  // preview: top: calc(50% + 46px) of the ring box
constexpr int kButtonsCenterY = 340 + 38;
constexpr int kMainRadius = 38;
constexpr int kSideRadius = 32;
constexpr int kResetCenterX = 240 - 96;
constexpr int kSkipCenterX = 240 + 96;
constexpr int kRingBoxHalf = 132;

Arduino_GFX* canvas() { return displayCanvas(); }

uint16_t blend565(uint16_t foreground, uint16_t background, uint8_t alpha) {
  if (alpha >= 255) return foreground;
  if (alpha == 0) return background;
  const uint16_t inverse = 255 - alpha;
  const uint16_t red = ((((foreground >> 11) & 0x1F) * alpha) + (((background >> 11) & 0x1F) * inverse) + 127) / 255;
  const uint16_t green = ((((foreground >> 5) & 0x3F) * alpha) + (((background >> 5) & 0x3F) * inverse) + 127) / 255;
  const uint16_t blue = (((foreground & 0x1F) * alpha) + ((background & 0x1F) * inverse) + 127) / 255;
  return static_cast<uint16_t>((red << 11) | (green << 5) | blue);
}

uint8_t coverage(float value) {
  if (value <= 0.0f) return 0;
  if (value >= 1.0f) return 255;
  return static_cast<uint8_t>(value * 255.0f + 0.5f);
}

uint16_t phaseColor(const FocusTimer& timer) {
  return timer.phase() == FocusPhase::Focus ? kFocusColor : kBreakColor;
}

void fillCircleAA(int cx, int cy, float radius, uint16_t color, uint16_t background) {
  const int extent = static_cast<int>(radius) + 2;
  for (int y = cy - extent; y <= cy + extent; ++y) {
    for (int x = cx - extent; x <= cx + extent; ++x) {
      const float dx = x + 0.5f - cx;
      const float dy = y + 0.5f - cy;
      const uint8_t alpha = coverage(radius + 0.5f - sqrtf(dx * dx + dy * dy));
      if (alpha) canvas()->drawPixel(x, y, blend565(color, background, alpha));
    }
  }
}

// Clockwise arc between two fractions (0 = 12 o'clock), anti-aliased across
// the stroke. Used for the reset icon.
void drawArcAA(int cx, int cy, float radius, float stroke, float from, float to,
               uint16_t color, uint16_t background) {
  const int extent = static_cast<int>(radius + stroke) + 2;
  for (int y = cy - extent; y <= cy + extent; ++y) {
    for (int x = cx - extent; x <= cx + extent; ++x) {
      const float dx = x + 0.5f - cx;
      const float dy = y + 0.5f - cy;
      const uint8_t alpha = coverage(stroke * 0.5f + 0.5f - fabsf(sqrtf(dx * dx + dy * dy) - radius));
      if (!alpha) continue;
      const float fraction = focusClockwiseFraction(dx, dy);
      if (fraction < from || fraction > to) continue;
      canvas()->drawPixel(x, y, blend565(color, background, alpha));
    }
  }
}

void ringPoint(float fraction, float& x, float& y) {
  const float angle = fraction * 2.0f * 3.14159265f;
  x = kFocusRingCenterX + sinf(angle) * kFocusRingRadius;
  y = kFocusRingCenterY - cosf(angle) * kFocusRingRadius;
}

// Track plus the remaining arc. The arc covers [elapsed, 1) clockwise from
// 12 o'clock, so the ring empties clockwise. Both arc ends are rounded.
void drawRing(float elapsed, uint16_t arcColor, uint16_t background) {
  const float half = kFocusRingStroke * 0.5f;
  const bool fullArc = elapsed <= 0.0005f;
  const bool emptyArc = elapsed >= 0.9995f;
  float startX = 0, startY = 0, endX = 0, endY = 0;
  ringPoint(elapsed, startX, startY);
  ringPoint(0.0f, endX, endY);
  const int extent = static_cast<int>(kFocusRingRadius + half) + 2;
  const float outer = kFocusRingRadius + half + 1.0f;
  const float inner = kFocusRingRadius - half - 1.0f;
  for (int y = kFocusRingCenterY - extent; y <= kFocusRingCenterY + extent; ++y) {
    const float dy = y + 0.5f - kFocusRingCenterY;
    for (int x = kFocusRingCenterX - extent; x <= kFocusRingCenterX + extent; ++x) {
      const float dx = x + 0.5f - kFocusRingCenterX;
      const float squared = dx * dx + dy * dy;
      if (squared > outer * outer || squared < inner * inner) continue;
      const float distance = sqrtf(squared);
      const uint8_t band = coverage(half + 0.5f - fabsf(distance - kFocusRingRadius));
      if (!band) {
        canvas()->drawPixel(x, y, background);
        continue;
      }
      uint8_t arc = 0;
      if (fullArc) {
        arc = band;
      } else if (!emptyArc) {
        if (focusArcCovers(focusClockwiseFraction(dx, dy), elapsed)) arc = band;
        const float px = x + 0.5f;
        const float py = y + 0.5f;
        const float startDistance = sqrtf((px - startX) * (px - startX) + (py - startY) * (py - startY));
        const float endDistance = sqrtf((px - endX) * (px - endX) + (py - endY) * (py - endY));
        const uint8_t cap = coverage(half + 0.5f - fminf(startDistance, endDistance));
        if (cap > arc) arc = cap;
      }
      const uint16_t base = blend565(kTrack, background, band);
      canvas()->drawPixel(x, y, blend565(arcColor, base, arc));
    }
  }
}

void formatClock(uint32_t seconds, char* out, size_t size) {
  snprintf(out, size, "%02lu:%02lu", static_cast<unsigned long>(seconds / 60),
           static_cast<unsigned long>(seconds % 60));
}

void formatTotal(uint32_t ms, char* out, size_t size) {
  const uint32_t minutes = ms / 60000UL;
  if (minutes >= 60) {
    snprintf(out, size, "%luh %lum", static_cast<unsigned long>(minutes / 60),
             static_cast<unsigned long>(minutes % 60));
  } else {
    snprintf(out, size, "%lum", static_cast<unsigned long>(minutes));
  }
}

const char* stateLabel(const FocusTimer& timer) {
  if (timer.running()) return timer.phase() == FocusPhase::Focus ? "FOCUSING" : "BREAK";
  return timer.atFullDuration() ? "TAP TO START" : "PAUSED";
}

void drawDigits(const FocusTimer& timer, uint16_t background) {
  char clock[8] = {};
  formatClock(timer.displaySeconds(), clock, sizeof(clock));
  const int capTop = focusDigitCapTop();
  canvas()->fillRect(132, capTop - 6, 216, kFocusDigitCapHeight + 12, background);
  const int width = smoothTextWidth(kSmoothFontDigits70, clock);
  drawSmoothText(canvas(), kFocusRingCenterX - width / 2, focusDigitTextY(), clock, kSmoothFontDigits70,
                 timer.running() ? kText : kMuted, background);
}

void drawStateLabel(const FocusTimer& timer, uint16_t background) {
  canvas()->fillRect(150, kLabelTop - 2, 180, kSmoothFont13.lineHeight + 4, background);
  const char* label = stateLabel(timer);
  drawSmoothText(canvas(), kFocusRingCenterX - smoothTextWidth(kSmoothFont13, label) / 2, kLabelTop, label,
                 kSmoothFont13, kMuted, background);
}

int todayLineTop() {
  return 480 - 22 - kSmoothFont13.lineHeight;
}

void drawToday(const FocusTimer& timer, uint16_t background) {
  const int top = todayLineTop();
  canvas()->fillRect(0, top - 2, 480, kSmoothFont13.lineHeight + 4, background);
  char total[16] = {};
  formatTotal(timer.todayFocusMs(), total, sizeof(total));
  int x = 22;
  drawSmoothText(canvas(), x, top, "Today ", kSmoothFont13, kMuted, background);
  x += smoothTextWidth(kSmoothFont13, "Today ");
  drawSmoothText(canvas(), x, top, total, kSmoothFont13, kText, background);
  x += smoothTextWidth(kSmoothFont13, total);
  drawSmoothText(canvas(), x, top, " active", kSmoothFont13, kMuted, background);

  char blocks[8] = {};
  snprintf(blocks, sizeof(blocks), "%u", static_cast<unsigned>(timer.todayBlocks()));
  const char* suffix = timer.todayBlocks() == 1 ? " focus block" : " focus blocks";
  const int right = 458;
  const int suffixWidth = smoothTextWidth(kSmoothFont13, suffix);
  const int countWidth = smoothTextWidth(kSmoothFont13, blocks);
  drawSmoothText(canvas(), right - suffixWidth - countWidth, top, blocks, kSmoothFont13, kText, background);
  drawSmoothText(canvas(), right - suffixWidth, top, suffix, kSmoothFont13, kMuted, background);
}

void drawHeader(const FocusTimer& timer, uint16_t background) {
  const int top = kHeaderCenterY - kSmoothFont15.lineHeight / 2;
  const char* mode = timer.phase() == FocusPhase::Focus
                         ? "FOCUS"
                         : timer.phase() == FocusPhase::ShortBreak ? "SHORT BREAK" : "LONG BREAK";
  drawSmoothText(canvas(), 22, top, mode, kSmoothFont15, kText, background);
  if (timer.phase() == FocusPhase::Focus) {
    char sub[12] = {};
    snprintf(sub, sizeof(sub), "%u of %u", static_cast<unsigned>(timer.blockNumber()),
             static_cast<unsigned>(kFocusBlocksPerCycle));
    drawSmoothText(canvas(), 22 + smoothTextWidth(kSmoothFont15, mode) + 9, top, sub, kSmoothFont15, kMuted,
                   background);
  }
  // Cycle dots, right aligned: filled = finished, ring = current block.
  for (uint8_t i = 0; i < kFocusBlocksPerCycle; ++i) {
    const int cx = 398 + i * 18;
    const bool done = i < timer.cycleDone();
    const bool current = !done && i == timer.cycleDone() && timer.phase() == FocusPhase::Focus;
    fillCircleAA(cx, kHeaderCenterY, 6.0f, done || current ? kFocusColor : kDim, background);
    if (!done) fillCircleAA(cx, kHeaderCenterY, 4.0f, background, done || current ? kFocusColor : kDim);
  }
  uiDrawPageDots(1, background);
}

void drawPlayIcon(int cx, int cy, uint16_t color) {
  canvas()->fillTriangle(cx - 8, cy - 13, cx - 8, cy + 13, cx + 14, cy, color);
}

void drawPauseIcon(int cx, int cy, uint16_t color) {
  canvas()->fillRoundRect(cx - 10, cy - 12, 7, 24, 2, color);
  canvas()->fillRoundRect(cx + 3, cy - 12, 7, 24, 2, color);
}

void drawSkipIcon(int cx, int cy, uint16_t color) {
  canvas()->fillTriangle(cx - 10, cy - 10, cx - 10, cy + 10, cx + 5, cy, color);
  canvas()->fillRect(cx + 6, cy - 10, 3, 20, color);
}

void drawResetIcon(int cx, int cy, uint16_t color, uint16_t background) {
  drawArcAA(cx, cy + 1, 9.0f, 2.6f, 0.02f, 0.80f, color, background);
  canvas()->fillTriangle(cx - 7, cy - 8, cx + 1, cy - 14, cx + 1, cy - 2, color);
}

void drawButtons(const FocusTimer& timer, FocusButton pressed, uint16_t background) {
  canvas()->fillRect(240 - 96 - kSideRadius - 4, kButtonsCenterY - kMainRadius - 4,
                     (96 + kSideRadius + 4) * 2, (kMainRadius + 4) * 2, background);
  const float sideScale = 1.0f;
  const float resetRadius = kSideRadius * (pressed == FocusButton::Reset ? 0.88f : sideScale);
  const float skipRadius = kSideRadius * (pressed == FocusButton::Skip ? 0.88f : sideScale);
  const float mainRadius = kMainRadius * (pressed == FocusButton::Main ? 0.88f : 1.0f);

  fillCircleAA(kResetCenterX, kButtonsCenterY, resetRadius, kLine, background);
  fillCircleAA(kResetCenterX, kButtonsCenterY, resetRadius - 2.0f, kCard, kLine);
  drawResetIcon(kResetCenterX, kButtonsCenterY, kText, kCard);

  fillCircleAA(kSkipCenterX, kButtonsCenterY, skipRadius, kLine, background);
  fillCircleAA(kSkipCenterX, kButtonsCenterY, skipRadius - 2.0f, kCard, kLine);
  drawSkipIcon(kSkipCenterX, kButtonsCenterY, kText);

  const uint16_t mainColor = phaseColor(timer);
  fillCircleAA(240, kButtonsCenterY, mainRadius, mainColor, background);
  if (timer.running()) drawPauseIcon(240, kButtonsCenterY, kBackground);
  else drawPlayIcon(240, kButtonsCenterY, kBackground);
}

float elapsedFraction(const FocusTimer& timer) {
  const uint32_t total = timer.totalMs();
  if (total == 0) return 0.0f;
  return 1.0f - static_cast<float>(timer.remainingMs()) / static_cast<float>(total);
}

uint16_t arcColor(const FocusTimer& timer, bool pulse) {
  if (!timer.running()) return kDim;
  if (pulse) return kWarnColor;
  return phaseColor(timer);
}

}  // namespace

void uiDrawPageDots(uint8_t activePage, uint16_t background) {
  canvas()->fillRect(218, kHeaderCenterY - 6, 44, 12, background);
  int x = 225;
  for (uint8_t page = 0; page < 2; ++page) {
    const bool active = page == activePage;
    const int width = active ? 16 : 6;
    canvas()->fillRoundRect(x, kHeaderCenterY - 3, width, 6, 3, active ? kText : kDim);
    x += width + 8;
  }
}

void focusUiDraw(const FocusTimer& timer, FocusButton pressed, uint8_t tint) {
  const uint16_t background = blend565(phaseColor(timer), kBackground, tint);
  Arduino_GFX* display = canvas();
  display->fillScreen(background);
  drawHeader(timer, background);
  drawRing(elapsedFraction(timer), arcColor(timer, false), background);
  drawDigits(timer, background);
  drawStateLabel(timer, background);
  drawButtons(timer, pressed, background);
  drawToday(timer, background);
  displayFlushRect(0, 0, 480, 480);
}

void focusUiRefresh(const FocusTimer& timer, bool pulse) {
  drawRing(elapsedFraction(timer), arcColor(timer, pulse), kBackground);
  drawDigits(timer, kBackground);
  drawStateLabel(timer, kBackground);
  displayFlushRect(kFocusRingCenterX - kRingBoxHalf, kFocusRingCenterY - kRingBoxHalf,
                   kRingBoxHalf * 2, kRingBoxHalf * 2);
  drawToday(timer, kBackground);
  displayFlushRect(0, todayLineTop() - 2, 480, kSmoothFont13.lineHeight + 4);
}

void focusUiRefreshButtons(const FocusTimer& timer, FocusButton pressed) {
  drawButtons(timer, pressed, kBackground);
  displayFlushRect(240 - 96 - kSideRadius - 4, kButtonsCenterY - kMainRadius - 4,
                   (96 + kSideRadius + 4) * 2, (kMainRadius + 4) * 2);
}

FocusButton focusUiHitButton(int16_t x, int16_t y) {
  auto within = [&](int cx, int radius) {
    const int dx = x - cx;
    const int dy = y - kButtonsCenterY;
    return dx * dx + dy * dy <= (radius + 8) * (radius + 8);
  };
  if (within(240, kMainRadius)) return FocusButton::Main;
  if (within(kResetCenterX, kSideRadius)) return FocusButton::Reset;
  if (within(kSkipCenterX, kSideRadius)) return FocusButton::Skip;
  return FocusButton::None;
}

bool focusUiHitRing(int16_t x, int16_t y) {
  const int dx = x - kFocusRingCenterX;
  const int dy = y - kFocusRingCenterY;
  const int radius = static_cast<int>(kFocusRingRadius + kFocusRingStroke);
  return dx * dx + dy * dy <= radius * radius;
}

}  // namespace ccmeter
