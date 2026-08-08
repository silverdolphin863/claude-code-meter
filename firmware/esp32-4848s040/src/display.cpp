#include "display.h"

#include <Arduino.h>
#include <Arduino_GFX_Library.h>
#include <TAMC_GT911.h>
#include <Wire.h>

namespace ccmeter {
namespace {

constexpr int kBacklightPin = 38;
constexpr int kTouchSdaPin = 19;
constexpr int kTouchSclPin = 45;
constexpr int kScreenWidth = 480;
constexpr int kScreenHeight = 480;

// This is the vendor demo's exact 3-wire ST7701 setup bus.
Arduino_DataBus* initBus = new Arduino_SWSPI(
    GFX_NOT_DEFINED /* DC */, 39 /* CS */, 48 /* SCK */, 47 /* MOSI */, GFX_NOT_DEFINED /* MISO */);

// This is the vendor demo's exact RGB wiring and timing block.
Arduino_ESP32RGBPanel* rgbPanel = new Arduino_ESP32RGBPanel(
    18 /* DE */, 17 /* VSYNC */, 16 /* HSYNC */, 21 /* PCLK */,
    11 /* R0 */, 12 /* R1 */, 13 /* R2 */, 14 /* R3 */, 0 /* R4 */,
    8 /* G0 */, 20 /* G1 */, 3 /* G2 */, 46 /* G3 */, 9 /* G4 */, 10 /* G5 */,
    4 /* B0 */, 5 /* B1 */, 6 /* B2 */, 7 /* B3 */, 15 /* B4 */,
    1 /* hsync_polarity */, 10 /* hsync_front_porch */, 8 /* hsync_pulse_width */, 50 /* hsync_back_porch */,
    1 /* vsync_polarity */, 10 /* vsync_front_porch */, 8 /* vsync_pulse_width */, 20 /* vsync_back_porch */,
    0 /* pclk_active_neg */, 16000000 /* prefer_speed */, false /* useBigEndian */);

Arduino_RGB_Display* gfx = new Arduino_RGB_Display(
    kScreenWidth, kScreenHeight, rgbPanel, 0 /* rotation */, false /* auto_flush */,
    initBus, GFX_NOT_DEFINED /* RST */, st7701_type1_init_operations,
    sizeof(st7701_type1_init_operations));

// The generic ST7701 type-1 preset targets a different panel variant. This
// board requires MDT disabled, RGB order, and display inversion off.
const uint8_t boardColorOperations[] = {
    BEGIN_WRITE,
    WRITE_COMMAND_8, 0xFF,
    WRITE_BYTES, 5, 0x77, 0x01, 0x00, 0x00, 0x10,
    WRITE_C8_D8, 0xCD, 0x00,
    WRITE_COMMAND_8, 0xFF,
    WRITE_BYTES, 5, 0x77, 0x01, 0x00, 0x00, 0x00,
    WRITE_C8_D8, 0x36, 0x00,
    WRITE_COMMAND_8, 0x20,
    END_WRITE};

// This is the vendor demo's exact GT911 construction and normal rotation.
TAMC_GT911 touch = TAMC_GT911(kTouchSdaPin, kTouchSclPin, -1, -1, kScreenWidth, kScreenHeight);

}  // namespace

void displayBegin() {
  Wire.begin(kTouchSdaPin, kTouchSclPin);
  touch.begin();
  touch.setRotation(ROTATION_NORMAL);

  gfx->begin();
  initBus->batchOperation(const_cast<uint8_t*>(boardColorOperations), sizeof(boardColorOperations));
  gfx->fillScreen(BLACK);
  gfx->flush();
  pinMode(kBacklightPin, OUTPUT);
  digitalWrite(kBacklightPin, HIGH);
}

Arduino_GFX* displayCanvas() {
  return gfx;
}

void displayFlushRect(int16_t x, int16_t y, int16_t width, int16_t height) {
  if (width <= 0 || height <= 0) return;

  const int16_t left = constrain(x, 0, kScreenWidth);
  const int16_t top = constrain(y, 0, kScreenHeight);
  const int16_t right = constrain(x + width, 0, kScreenWidth);
  const int16_t bottom = constrain(y + height, 0, kScreenHeight);
  if (left >= right || top >= bottom) return;

  uint16_t* framebuffer = gfx->getFramebuffer();
  if (!framebuffer) return;

  // The RGB DMA engine continuously scans the single PSRAM framebuffer. A
  // whole-frame cache writeback is therefore visible while it is in progress.
  // Write back only the rows that changed, aligned to ESP32-S3 cache lines.
  constexpr uintptr_t kCacheLineBytes = 32;
  for (int16_t row = top; row < bottom; ++row) {
    const uintptr_t firstByte = reinterpret_cast<uintptr_t>(framebuffer + row * kScreenWidth + left);
    const uintptr_t lastByte = reinterpret_cast<uintptr_t>(framebuffer + row * kScreenWidth + right);
    const uintptr_t alignedFirst = firstByte & ~(kCacheLineBytes - 1);
    const uintptr_t alignedLast = (lastByte + kCacheLineBytes - 1) & ~(kCacheLineBytes - 1);
    Cache_WriteBack_Addr(static_cast<uint32_t>(alignedFirst),
                         static_cast<uint32_t>(alignedLast - alignedFirst));
  }
}

bool displayReadTouch(int16_t& x, int16_t& y) {
  touch.read();
  if (!touch.isTouched) return false;

  // ROTATION_NORMAL already flips both raw GT911 axes. This board needs that
  // X flip retained, while Y needs one additional inversion to match the LCD.
  x = static_cast<int16_t>(map(touch.points[0].x, 0, 480, 0, gfx->width() - 1));
  y = static_cast<int16_t>(map(touch.points[0].y, 480, 0, 0, gfx->height() - 1));
  x = constrain(x, 0, gfx->width() - 1);
  y = constrain(y, 0, gfx->height() - 1);
  return true;
}

}  // namespace ccmeter
