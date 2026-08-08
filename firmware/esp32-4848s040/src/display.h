#pragma once

#include <stdint.h>

class Arduino_GFX;

namespace ccmeter {

void displayBegin();
Arduino_GFX* displayCanvas();
void displayFlushRect(int16_t x, int16_t y, int16_t width, int16_t height);
bool displayReadTouch(int16_t& x, int16_t& y);

}  // namespace ccmeter
