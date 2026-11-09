#pragma once

#include <stdint.h>

#include "focus_model_core.h"

namespace ccmeter {

enum class FocusButton : int8_t { None = -1, Reset = 0, Main = 1, Skip = 2 };

// Two pages: 0 = CC Meter, 1 = focus timer. Dots sit in the header centre.
void uiDrawPageDots(uint8_t activePage, uint16_t background);

// Full frame. tint 0..255 blends the background toward the phase colour for
// the start/pause/finish flash.
void focusUiDraw(const FocusTimer& timer, FocusButton pressed, uint8_t tint);
// Ring, digits, state label and today line only. pulse selects the warning
// colour during the final ten seconds.
void focusUiRefresh(const FocusTimer& timer, bool pulse);
void focusUiRefreshButtons(const FocusTimer& timer, FocusButton pressed);

FocusButton focusUiHitButton(int16_t x, int16_t y);
bool focusUiHitRing(int16_t x, int16_t y);

}  // namespace ccmeter
