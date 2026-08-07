#include "smooth_font.h"

#include <cstring>

namespace ccmeter {
namespace {

SmoothGlyph readGlyph(const SmoothFont& font, uint8_t character) {
  const uint8_t supported = character >= font.first && character <= font.last ? character : '?';
  SmoothGlyph glyph = {};
  memcpy_P(&glyph, font.glyphs + (supported - font.first), sizeof(glyph));
  return glyph;
}

uint16_t blendRgb565(uint16_t foreground, uint16_t background, uint8_t alpha) {
  if (alpha >= 15) return foreground;
  if (alpha == 0) return background;
  const uint8_t inverse = 15 - alpha;
  const uint16_t red = ((((foreground >> 11) & 0x1F) * alpha) + (((background >> 11) & 0x1F) * inverse) + 7) / 15;
  const uint16_t green = ((((foreground >> 5) & 0x3F) * alpha) + (((background >> 5) & 0x3F) * inverse) + 7) / 15;
  const uint16_t blue = (((foreground & 0x1F) * alpha) + ((background & 0x1F) * inverse) + 7) / 15;
  return static_cast<uint16_t>((red << 11) | (green << 5) | blue);
}

}  // namespace

int smoothTextWidth(const SmoothFont& font, const char* text) {
  if (!text) return 0;
  int width = 0;
  for (const unsigned char* cursor = reinterpret_cast<const unsigned char*>(text); *cursor; ++cursor) {
    width += readGlyph(font, *cursor).xAdvance;
  }
  return width;
}

void drawSmoothText(Arduino_GFX* canvas, int x, int y, const char* text,
                    const SmoothFont& font, uint16_t foreground, uint16_t background) {
  if (!canvas || !text) return;
  int cursorX = x;
  const unsigned char* cursor = reinterpret_cast<const unsigned char*>(text);
  while (*cursor) {
    const SmoothGlyph glyph = readGlyph(font, *cursor++);
    const int glyphX = cursorX + glyph.xOffset;
    const int glyphY = y + font.ascent + glyph.yOffset;
    const size_t pixelCount = static_cast<size_t>(glyph.width) * glyph.height;
    for (size_t pixel = 0; pixel < pixelCount; ++pixel) {
      const uint8_t packed = pgm_read_byte(font.bitmap + glyph.bitmapOffset + pixel / 2);
      const uint8_t alpha = pixel & 1 ? packed & 0x0F : packed >> 4;
      if (alpha == 0) continue;
      const int pixelX = glyphX + static_cast<int>(pixel % glyph.width);
      const int pixelY = glyphY + static_cast<int>(pixel / glyph.width);
      canvas->drawPixel(pixelX, pixelY, blendRgb565(foreground, background, alpha));
    }
    cursorX += glyph.xAdvance;
  }
}

}  // namespace ccmeter
