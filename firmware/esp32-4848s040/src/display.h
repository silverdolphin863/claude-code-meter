#pragma once

#include <stdint.h>

class Arduino_GFX;

namespace ccmeter {

void displayBegin();
Arduino_GFX* displayCanvas();
bool displayReadTouch(int16_t& x, int16_t& y);

}  // namespace ccmeter
