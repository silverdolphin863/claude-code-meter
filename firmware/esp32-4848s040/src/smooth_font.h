#pragma once

#include <Arduino.h>
#include <Arduino_GFX_Library.h>

namespace ccmeter {

struct SmoothGlyph {
  uint32_t bitmapOffset;
  uint8_t width;
  uint8_t height;
  int8_t xOffset;
  int8_t yOffset;
  uint8_t xAdvance;
};

struct SmoothFont {
  uint8_t first;
  uint8_t last;
  uint8_t ascent;
  uint8_t descent;
  uint8_t lineHeight;
  const SmoothGlyph* glyphs;
  const uint8_t* bitmap;
};

int smoothTextWidth(const SmoothFont& font, const char* text);
void drawSmoothText(Arduino_GFX* canvas, int x, int y, const char* text,
                    const SmoothFont& font, uint16_t foreground, uint16_t background);

}  // namespace ccmeter
