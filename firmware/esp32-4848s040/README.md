# CC Meter ESP32 4848S040 firmware

This is the CC Meter-only firmware for the JCZN/Guition ESP32-4848S040 display. It replaces the vendor weather, clock, and light-control screen with the expanded CC Meter view: Claude Code and Codex cards, usage bars, percentages, pace badges, reset countdowns, freshness, and explicit setup or failure states.

## Hardware

The firmware uses the vendor demo wiring without changes:

- ESP32-S3-WROOM-1, 16 MB flash, 8 MB OPI PSRAM.
- The host connection is the onboard CH340 UART0 bridge. USB CDC is disabled, so `Serial` uses UART0 at 115200 baud.
- 480x480 ST7701 RGB panel, backlight GPIO 38, 16 MHz pixel clock, normal RGB565 line mapping, MDT disabled, and display inversion off.
- RGB panel bus: CS 39, SCK 48, SDA 47, DE 18, VSYNC 17, HSYNC 16, PCLK 21.
- Red pins 11, 12, 13, 14, 0.
- Green pins 8, 20, 3, 46, 9, 10.
- Blue pins 4, 5, 6, 7, 15.
- GT911 touch: SDA GPIO 19, SCL GPIO 45, no interrupt or reset pin.
- Touch mapping is the vendor mapping from 480 to 0 on both axes.

## Build and flash

Before changing the physical panel, update `docs/lcd-preview.html`, run `npm run docs:lcd-preview` from the repository root, and obtain visual approval for the 480x480 preview. Flashing is an explicit step after that approval, not part of preview generation.

Install PlatformIO, then run from this directory:

```text
pio run
pio test -e native
pio run -t upload
pio device monitor -b 115200
```

The ESP32 platform is pinned to `6.10.0`. Arduino GFX, GT911, and ArduinoJson are pinned to immutable public commits in `platformio.ini`. The native test environment is host-testable and uses the same model parser and formatting helpers as the firmware.
The monitor baud is 115200 and the upload baud is deliberately 460800 for reliable CH340 transfers.

The live meter uses a generated four-bit grayscale glyph subset based on the unmodified Cascadia Mono font. The source font and SIL Open Font License 1.1 are stored under `tools/font/`. To regenerate `src/smooth_font_data.h`, install Pillow and run:

```text
python tools/font/generate_smooth_font.py
```

The generated data contains printable ASCII at 11, 13, 15, and 18 pixel sizes with weight 600. Firmware builds consume the generated header and do not require Python or Pillow.

## First-run provisioning

USB serial is the primary live-data transport and does not require Wi-Fi credentials. On first boot, the display waits for CC Meter over USB. Touch the settings icon only if you want the optional Wi-Fi fallback. This starts an open local access point named `CCMeter-Setup-XXXX`; join it and open `http://192.168.4.1/`. The form stores the Wi-Fi SSID/password, panel base URL, and bearer token in ESP32 Preferences/NVS. Password and token inputs are never filled back into the form, printed to serial, or drawn on the display.

The base URL is normally an origin such as `http://panel-host:7373`. The firmware requests `/panel/v1/usage` below that origin. For compatibility with the current desktop server during integration, a full base URL ending in `/usage.json` is also accepted.

Tap the settings icon in the header to open or close the local setup AP. Wi-Fi setup stays off unless explicitly requested.

## USB serial protocol

Serial runs at 115200 baud over the CH340 UART0 connection. Native USB CDC is disabled because GPIO 19 is used by the GT911 touch bus. Every message is newline terminated. The firmware uses an enlarged receive buffer, and the desktop bridge paces long JSON lines in small chunks so a full-screen redraw cannot cause UART loss. The firmware does not echo command contents and never prints a Wi-Fi password or bearer token. The host may use this transport with no Wi-Fi configuration at all.

After boot, the firmware emits this compact hello line:

```json
{"type":"hello","firmware":"1.0.0","model":"ESP32-4848S040"}
```

The host sends one panel payload per line by wrapping the normal schema-1 object in a usage envelope. The `data` object is the same object accepted by the Wi-Fi endpoint:

```json
{"type":"usage","data":{"generated_at":"2026-08-07T12:00:00.000Z","sections":[{"id":"codex","limits":[{"label":"Weekly","percent":31,"resets_at":"2026-08-14T12:00:00.000Z","window_hours":168}]}]}}
```

After a valid usage envelope is applied and rendered, the firmware emits:

```json
{"type":"ack"}
```

If the on-screen refresh icon is touched, the firmware immediately emits:

```json
{"type":"refresh"}
```

The host should answer with a new usage envelope. If Wi-Fi fallback credentials exist, the firmware may also request `/panel/v1/usage?refresh=1` directly, but the serial refresh event and serial data path remain independent. Invalid usage envelopes produce the generic response `{"type":"error","error":"invalid_usage"}` and do not replace the last valid values.

The existing configuration commands remain available:

```text
HELP
STATUS
SET<TAB>ssid<TAB>wifi_password<TAB>base_url<TAB>bearer_token
CLEAR
```

`SET` uses literal tab characters between the five fields. Wi-Fi passwords may be empty for an open network. Passwords and tokens must not contain tabs or control characters. `STATUS` reports only whether configuration, Wi-Fi, and the setup AP are present. `CLEAR` removes the saved configuration and restarts into setup mode.

## Endpoint contract

Wi-Fi is an optional fallback transport. When configured and connected, normal polling is every 30 seconds. Tapping `REF` requests the same endpoint with `?refresh=1` in addition to the serial refresh event. Every Wi-Fi request includes:

```text
Authorization: Bearer <token>
```

The expected successful response is an object with a non-empty `sections` array. The current desktop payload shape is:

```json
{
  "generated_at": "2026-08-07T12:00:00.000Z",
  "sections": [
    {
      "id": "claude",
      "name": "Claude Code",
      "installed": true,
      "plan": "pro",
      "stale_ms": 12000,
      "auth_required": false,
      "refresh_error": null,
      "error": null,
      "limits": [
        {
          "label": "5-hour",
          "percent": 22,
          "resets_at": "2026-08-07T14:00:00.000Z",
          "window_hours": 5
        }
      ]
    }
  ]
}
```

`limits`, `plan`, `stale_ms`, and status fields are optional. Missing sections and missing windows are rendered as no data. Invalid individual limits are skipped if another valid limit remains. Percentages are clamped to 0 through 100, and reset timestamps accept ISO UTC strings or Unix seconds/milliseconds.

## Runtime states and recovery

- `USB WAIT` means no complete Wi-Fi fallback configuration exists and the display is waiting for the desktop app over USB.
- `SERIAL` means the last valid usage payload arrived over USB serial. This state works without Wi-Fi credentials.
- `CONNECTING` means the station is attempting Wi-Fi or waiting for its first response.
- `ONLINE` means the last response was valid and fresh.
- `STALE` means valid data is older than 15 minutes, including the server-reported source age.
- `OFFLINE` means Wi-Fi, HTTP, or payload validation failed. The last valid values remain visible when available.
- `AUTH ERROR` means HTTP 401/403 or a response section marked `auth_required`.

The desktop app exposes `/panel/v1/usage` only when the optional Wi-Fi transport is enabled. USB remains the default and does not open a LAN listener.

HTTPS uses the ESP32 secure client in no-certificate mode because there is no CA provisioning UI in this firmware. Use a trusted local network or add a CA provisioning design before exposing the panel endpoint to an untrusted network.
