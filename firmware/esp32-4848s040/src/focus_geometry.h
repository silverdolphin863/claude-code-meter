#pragma once

#include <math.h>
#include <stdint.h>

namespace ccmeter {

// Focus page layout, from docs/lcd-preview-pomodoro.html (480 x 480).
constexpr int kFocusRingCenterX = 240;
constexpr int kFocusRingCenterY = 54 + 136;  // ring box top 54, size 272
constexpr float kFocusRingRadius = 136.0f * 272.0f / 300.0f;  // SVG r=136 in a 300 viewBox scaled to 272
constexpr float kFocusRingStroke = 16.0f * 272.0f / 300.0f;
// Digit glyphs of kSmoothFontDigits70: cap height 50 px above the baseline.
constexpr int kFocusDigitCapHeight = 50;
constexpr int kFocusDigitAscent = 65;

// Clockwise angle from 12 o'clock as a fraction 0..1, screen coordinates
// (y grows downward).
inline float focusClockwiseFraction(float dx, float dy) {
  float angle = atan2f(dx, -dy);  // 0 at 12 o'clock, +pi/2 at 3 o'clock
  if (angle < 0) angle += 2.0f * 3.14159265f;
  return angle / (2.0f * 3.14159265f);
}

// The ring empties clockwise: the elapsed part [0, elapsedFraction) starting
// at 12 o'clock is track, the remaining part is the coloured arc.
inline bool focusArcCovers(float clockwiseFraction, float elapsedFraction) {
  return clockwiseFraction >= elapsedFraction;
}

// drawSmoothText y argument that puts the digits' cap box centre on the ring
// centre, independent of the state label below.
constexpr int focusDigitTextY() {
  return kFocusRingCenterY - kFocusDigitCapHeight / 2 - (kFocusDigitAscent - kFocusDigitCapHeight);
}

constexpr int focusDigitCapTop() {
  return focusDigitTextY() + kFocusDigitAscent - kFocusDigitCapHeight;
}

}  // namespace ccmeter
