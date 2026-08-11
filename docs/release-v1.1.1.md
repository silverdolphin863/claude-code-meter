# CC Meter 1.1.1

This release adds the optional 4-inch ESP32 hardware display while keeping the
Windows desktop and tray meter unchanged for people who do not use the panel.

## Highlights

- Adds USB support for the JCZN/Guition `ESP32-4848S040` 480x480 touch display.
- Sends live Claude Code and Codex limits over the same USB cable that powers
  the screen. No provider credentials are stored on the display.
- Adds touch-triggered manual refresh, connection status, and display-only mode.
- Publishes LCD firmware 1.0.8 as a separate optional ZIP. Its installer checks
  the board and image, then saves a verified 16 MB factory backup before
  flashing.
- Stops periodic full-screen LCD redraws that caused visible flashing.
- Fixes LCD touch mapping, refresh feedback, setup-screen recovery, and compact
  header overlap.
- Corrects the one-pixel vertical alignment of reset labels and freshness age
  in the compact Windows strip.

## Downloads

- `CCMeter-Setup-1.1.1.exe` is the Windows app. It includes the USB bridge but
  never flashes a display.
- `CCMeter-LCD-Firmware-1.0.8.zip` is only for the square 480x480 board marked
  `ESP32-4848S040`. Read its included `SETUP.html` before flashing.

The Windows installer is not code-signed, so SmartScreen may warn. The app
checks for updates only after you click **Check for updates...** in the tray
menu. It never checks, downloads, or installs an update on its own.
