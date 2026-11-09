#include <cstring>

#include <unity.h>

#include "focus_geometry.h"
#include "touch_debounce.h"
#include "focus_model_core.h"
#include "serial_protocol.h"
#include "usage_model.h"
#include "usage_model_core.h"

using namespace ccmeter;

void setUp() {}
void tearDown() {}

void test_usage_payload_maps_optional_windows_and_sections() {
  const char payload[] = R"json({
    "generated_at":"2026-08-07T12:00:00Z",
    "sections":[
      {"id":"claude","name":"Claude Code","installed":true,"stale_ms":12000,
       "limits":[
         {"label":"5-hour","percent":22,"resets_at":"2026-08-07T14:00:00Z","window_hours":5},
         {"label":"Weekly, all models","percent":54,"resets_at":"2026-08-10T12:00:00Z"},
         {"label":"Weekly, Fable","percent":68,"resets_at":"2026-08-10T12:00:00Z","window_hours":168}
       ]},
      {"id":"codex","name":"Codex","plan":"pro","limits":[
        {"label":"Weekly","percent":31,"resets_at":"2026-08-14T12:00:00Z","window_hours":168}
      ]}
    ]
  })json";

  UsageSnapshot snapshot;
  char error[64] = {};
  TEST_ASSERT_TRUE(parseUsageJson(payload, strlen(payload), snapshot, error, sizeof(error)));
  TEST_ASSERT_TRUE(snapshot.valid);
  TEST_ASSERT_EQUAL_UINT(2, snapshot.sectionCount);
  TEST_ASSERT_EQUAL_UINT(12000, snapshot.serverStaleMs);

  const UsageSection* claude = findSection(snapshot, "claude");
  const UsageSection* codex = findSection(snapshot, "codex");
  TEST_ASSERT_NOT_NULL(claude);
  TEST_ASSERT_NOT_NULL(codex);
  TEST_ASSERT_EQUAL_UINT(3, claude->limitCount);
  TEST_ASSERT_FLOAT_WITHIN(0.01f, 168.0f, claude->limits[1].windowHours);
  TEST_ASSERT_EQUAL_STRING("pro", codex->plan);
  TEST_ASSERT_EQUAL_UINT(1, codex->limitCount);
}

void test_serial_usage_envelope_maps_the_same_panel_payload() {
  const char payload[] = R"json({"type":"usage","data":{"server_time_ms":1786104000000,"generated_at":"2026-08-07T12:00:00Z","manual_refresh":{"status":"cooldown","retry_at":1786104060000},"sections":[{"id":"codex","name":"Codex","limits":[{"label":"Weekly","percent":31,"resets_at":"2026-08-14T12:00:00Z","reset_label":"14.08 14:00","window_hours":168}]}]}})json";
  UsageSnapshot snapshot;
  char error[64] = {};
  TEST_ASSERT_TRUE(parseUsageEnvelope(payload, strlen(payload), snapshot, error, sizeof(error)));
  TEST_ASSERT_TRUE(snapshot.valid);
  TEST_ASSERT_EQUAL_UINT(1, snapshot.sectionCount);
  TEST_ASSERT_EQUAL_STRING("codex", snapshot.sections[0].id);
  TEST_ASSERT_EQUAL_UINT(1, snapshot.sections[0].limitCount);
  TEST_ASSERT_FLOAT_WITHIN(0.01f, 31.0f, snapshot.sections[0].limits[0].percent);
  TEST_ASSERT_FLOAT_WITHIN(0.01f, 168.0f, snapshot.sections[0].limits[0].windowHours);
  TEST_ASSERT_EQUAL_STRING("14.08 14:00", snapshot.sections[0].limits[0].resetLabel);
  TEST_ASSERT_EQUAL_UINT64(1786104000000ULL, snapshot.generatedAtEpochMs);
  TEST_ASSERT_EQUAL(static_cast<int>(RefreshOutcome::Cooldown), static_cast<int>(snapshot.refreshOutcome));
  TEST_ASSERT_TRUE(snapshot.hasRefreshRetry);
  TEST_ASSERT_EQUAL_UINT64(1786104060000ULL, snapshot.refreshRetryEpochMs);
}

void test_serial_usage_envelope_rejects_non_usage_messages() {
  const char payload[] = R"json({"type":"status","data":{"sections":[]}})json";
  UsageSnapshot snapshot;
  char error[64] = {};
  TEST_ASSERT_FALSE(parseUsageEnvelope(payload, strlen(payload), snapshot, error, sizeof(error)));
  TEST_ASSERT_EQUAL_STRING("usage envelope required", error);
}

void test_serial_protocol_lines_are_stable() {
  TEST_ASSERT_EQUAL_STRING("{\"type\":\"hello\",\"firmware\":\"1.1.2\",\"model\":\"ESP32-4848S040\"}", serialHelloLine());
  TEST_ASSERT_EQUAL_STRING("{\"type\":\"ack\"}", serialAckLine());
  TEST_ASSERT_EQUAL_STRING("{\"type\":\"refresh\"}", serialRefreshLine());
}

void test_parser_keeps_valid_limit_when_another_limit_is_malformed() {
  const char payload[] = R"json({"sections":[{"id":"codex","limits":[
    {"label":"Weekly","percent":31,"resets_at":"2026-08-14T12:00:00Z","window_hours":168},
    {"label":"broken","percent":"not-a-number"}
  ]}]})json";
  UsageSnapshot snapshot;
  char error[64] = {};
  TEST_ASSERT_TRUE(parseUsageJson(payload, strlen(payload), snapshot, error, sizeof(error)));
  TEST_ASSERT_EQUAL_UINT(1, snapshot.sectionCount);
  TEST_ASSERT_EQUAL_UINT(1, snapshot.sections[0].limitCount);
  TEST_ASSERT_FALSE(snapshot.sections[0].hasError);
}

void test_parser_rejects_missing_sections() {
  const char payload[] = R"json({"generated_at":"2026-08-07T12:00:00Z"})json";
  UsageSnapshot snapshot;
  char error[64] = {};
  TEST_ASSERT_FALSE(parseUsageJson(payload, strlen(payload), snapshot, error, sizeof(error)));
  TEST_ASSERT_EQUAL_STRING("missing sections array", error);
}

void test_countdown_and_reset_format_match_desktop_shape() {
  uint64_t now = 0;
  uint64_t reset = 0;
  TEST_ASSERT_TRUE(parseIsoTimestamp("2026-08-07T12:00:00Z", now));
  TEST_ASSERT_TRUE(parseIsoTimestamp("2026-08-07T14:00:00Z", reset));
  char text[40] = {};
  TEST_ASSERT_TRUE(formatCountdown(reset, now, text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("Resets in 2h 0m", text);
  TEST_ASSERT_TRUE(formatResetLabel(reset, 5.0f, text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("14:00", text);
  TEST_ASSERT_TRUE(formatResetLabel(reset + 3ULL * 86400000ULL, 168.0f, text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("10.08 14:00", text);
}

void test_age_and_pace_helpers() {
  char text[24] = {};
  TEST_ASSERT_TRUE(formatAge(0, text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("<1m", text);
  TEST_ASSERT_TRUE(formatAge(16ULL * 60ULL * 1000ULL, text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("16m", text);
  TEST_ASSERT_TRUE(formatAge(2ULL * 3600ULL * 1000ULL, text, sizeof(text)));
  TEST_ASSERT_EQUAL_STRING("2h", text);

  uint64_t now = 0;
  TEST_ASSERT_TRUE(parseIsoTimestamp("2026-08-07T12:00:00Z", now));
  const uint64_t reset = now + 150ULL * 60ULL * 1000ULL;
  TEST_ASSERT_FLOAT_WITHIN(0.01f, 1.0f, calculatePace(50.0f, reset, 5.0f, now));
  TEST_ASSERT_EQUAL(static_cast<int>(UsageTone::Green), static_cast<int>(usageTone(31.0f)));
  TEST_ASSERT_EQUAL(static_cast<int>(UsageTone::Amber), static_cast<int>(usageTone(68.0f)));
  TEST_ASSERT_EQUAL(static_cast<int>(UsageTone::Red), static_cast<int>(usageTone(97.0f)));
}

void test_focus_timer_counts_down_and_credits_active_time() {
  FocusTimer timer;
  TEST_ASSERT_EQUAL_UINT32(1500, timer.displaySeconds());
  timer.start(1000);
  FocusTick tick = timer.tick(1000 + 61000);
  TEST_ASSERT_TRUE(tick.secondChanged);
  TEST_ASSERT_FALSE(tick.finished);
  TEST_ASSERT_EQUAL_UINT32(1439, timer.displaySeconds());
  TEST_ASSERT_EQUAL_UINT32(61000, timer.todayFocusMs());
  timer.pause(1000 + 62000);
  timer.tick(1000 + 500000);  // paused: no time passes
  TEST_ASSERT_EQUAL_UINT32(62000, timer.todayFocusMs());
  TEST_ASSERT_EQUAL_UINT32(1438, timer.displaySeconds());
}

void test_focus_timer_final_countdown_and_finish() {
  FocusTimer timer;
  timer.start(0);
  timer.tick(kFocusMs - 10500);
  FocusTick tick = timer.tick(kFocusMs - 9900);  // 10 -> displayed 10 s
  TEST_ASSERT_EQUAL_UINT8(10, tick.countdownSecond);
  tick = timer.tick(kFocusMs - 9800);  // same second, no new tick
  TEST_ASSERT_EQUAL_UINT8(0, tick.countdownSecond);
  tick = timer.tick(kFocusMs + 5000);
  TEST_ASSERT_TRUE(tick.finished);
  TEST_ASSERT_EQUAL_UINT16(1, timer.todayBlocks());
  TEST_ASSERT_EQUAL_UINT32(kFocusMs, timer.todayFocusMs());
  TEST_ASSERT_EQUAL(static_cast<int>(FocusPhase::ShortBreak), static_cast<int>(timer.phase()));
  TEST_ASSERT_FALSE(timer.running());
  TEST_ASSERT_EQUAL_UINT32(300, timer.displaySeconds());
}

void test_focus_cycle_gives_long_break_after_four_blocks() {
  FocusTimer timer;
  uint32_t now = 0;
  for (int block = 0; block < 4; ++block) {
    TEST_ASSERT_EQUAL_UINT8(block + 1, timer.blockNumber());
    timer.start(now); now += kFocusMs; timer.tick(now);
    if (block < 3) {
      TEST_ASSERT_EQUAL(static_cast<int>(FocusPhase::ShortBreak), static_cast<int>(timer.phase()));
      timer.skip(now);
    }
  }
  TEST_ASSERT_EQUAL(static_cast<int>(FocusPhase::LongBreak), static_cast<int>(timer.phase()));
  TEST_ASSERT_EQUAL_UINT8(4, timer.cycleDone());
  timer.skip(now);
  TEST_ASSERT_EQUAL(static_cast<int>(FocusPhase::Focus), static_cast<int>(timer.phase()));
  TEST_ASSERT_EQUAL_UINT8(1, timer.blockNumber());
  TEST_ASSERT_EQUAL_UINT16(4, timer.todayBlocks());
}

void test_focus_skip_does_not_credit_a_block() {
  FocusTimer timer;
  timer.start(0);
  timer.tick(60000);
  timer.skip(60000);
  TEST_ASSERT_EQUAL_UINT16(0, timer.todayBlocks());
  TEST_ASSERT_EQUAL_UINT32(60000, timer.todayFocusMs());
  TEST_ASSERT_EQUAL(static_cast<int>(FocusPhase::ShortBreak), static_cast<int>(timer.phase()));
}

void test_focus_day_change_clears_today_only_from_a_known_day() {
  FocusTimer timer;
  timer.start(0);
  timer.tick(120000);
  timer.setDay(20400);  // first known day: keep what accrued
  TEST_ASSERT_EQUAL_UINT32(120000, timer.todayFocusMs());
  timer.setDay(20400);
  TEST_ASSERT_EQUAL_UINT32(120000, timer.todayFocusMs());
  timer.setDay(20401);
  TEST_ASSERT_EQUAL_UINT32(0, timer.todayFocusMs());
  // 2026-11-09 23:30 UTC is already 2026-11-10 in UTC+1.
  const uint64_t epoch = 1794267000000ULL;
  TEST_ASSERT_EQUAL_INT32(focusDayKey(epoch, true, 0) + 1, focusDayKey(epoch, true, 60));
  TEST_ASSERT_EQUAL_INT32(kUnknownDay, focusDayKey(epoch, false, 60));
}

void test_focus_restore_comes_back_paused() {
  FocusTimer timer;
  timer.start(0);
  timer.tick(300000);
  FocusSaved saved = timer.save();
  FocusTimer restored;
  restored.restore(saved);
  TEST_ASSERT_FALSE(restored.running());
  TEST_ASSERT_EQUAL_UINT32(1200, restored.displaySeconds());
  TEST_ASSERT_EQUAL_UINT32(300000, restored.todayFocusMs());
  saved.phase = 9;
  saved.remainingMs = 0;
  restored.restore(saved);
  TEST_ASSERT_EQUAL(static_cast<int>(FocusPhase::Focus), static_cast<int>(restored.phase()));
  TEST_ASSERT_EQUAL_UINT32(kFocusMs, restored.remainingMs());
}

void test_focus_ring_empties_clockwise_from_twelve() {
  // A quarter elapsed: the gap runs from 12 to 3 o'clock.
  const float quarter = 0.25f;
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 0.0f, focusClockwiseFraction(0, -10));
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 0.25f, focusClockwiseFraction(10, 0));
  TEST_ASSERT_FLOAT_WITHIN(0.001f, 0.75f, focusClockwiseFraction(-10, 0));
  TEST_ASSERT_FALSE(focusArcCovers(focusClockwiseFraction(7, -7), quarter));   // 1:30, emptied
  TEST_ASSERT_TRUE(focusArcCovers(focusClockwiseFraction(0, 10), quarter));    // 6 o'clock, remaining
  TEST_ASSERT_TRUE(focusArcCovers(focusClockwiseFraction(-7, -7), quarter));   // 10:30, remaining
}

void test_focus_digits_are_centred_on_the_ring() {
  const int capCentre = focusDigitCapTop() + kFocusDigitCapHeight / 2;
  TEST_ASSERT_INT_WITHIN(1, kFocusRingCenterY, capCentre);
}

void test_usage_payload_reads_optional_utc_offset() {
  const char payload[] = R"json({"server_time_ms":1786104000000,"utc_offset_min":60,"sections":[{"id":"codex","name":"Codex","limits":[]}]})json";
  UsageSnapshot snapshot;
  char error[64] = {};
  TEST_ASSERT_TRUE(parseUsageJson(payload, strlen(payload), snapshot, error, sizeof(error)));
  TEST_ASSERT_TRUE(snapshot.hasUtcOffset);
  TEST_ASSERT_EQUAL_INT16(60, snapshot.utcOffsetMinutes);
  const char bad[] = R"json({"utc_offset_min":9999,"sections":[{"id":"codex","name":"Codex","limits":[]}]})json";
  TEST_ASSERT_TRUE(parseUsageJson(bad, strlen(bad), snapshot, error, sizeof(error)));
  TEST_ASSERT_FALSE(snapshot.hasUtcOffset);
}

void test_touch_gap_does_not_release(void) {
  TouchDebounce debounce;
  int16_t x = 0, y = 0;
  TEST_ASSERT_TRUE(debounce.update(true, 400, 200, 1000, x, y));
  // GT911 not ready yet: a 5 ms poll reads no touch while the finger moves on.
  TEST_ASSERT_TRUE(debounce.update(false, 0, 0, 1005, x, y));
  TEST_ASSERT_EQUAL_INT16(400, x);
  TEST_ASSERT_TRUE(debounce.update(true, 300, 205, 1030, x, y));
  TEST_ASSERT_TRUE(debounce.update(false, 0, 0, 1030 + kTouchReleaseMs - 1, x, y));
  TEST_ASSERT_FALSE(debounce.update(false, 0, 0, 1030 + kTouchReleaseMs, x, y));
  TEST_ASSERT_EQUAL_INT16(300, x);  // the swipe ends where the finger was last seen
}

int main() {
  UNITY_BEGIN();
  RUN_TEST(test_usage_payload_maps_optional_windows_and_sections);
  RUN_TEST(test_serial_usage_envelope_maps_the_same_panel_payload);
  RUN_TEST(test_serial_usage_envelope_rejects_non_usage_messages);
  RUN_TEST(test_serial_protocol_lines_are_stable);
  RUN_TEST(test_parser_keeps_valid_limit_when_another_limit_is_malformed);
  RUN_TEST(test_parser_rejects_missing_sections);
  RUN_TEST(test_countdown_and_reset_format_match_desktop_shape);
  RUN_TEST(test_age_and_pace_helpers);
  RUN_TEST(test_focus_timer_counts_down_and_credits_active_time);
  RUN_TEST(test_focus_timer_final_countdown_and_finish);
  RUN_TEST(test_focus_cycle_gives_long_break_after_four_blocks);
  RUN_TEST(test_focus_skip_does_not_credit_a_block);
  RUN_TEST(test_focus_day_change_clears_today_only_from_a_known_day);
  RUN_TEST(test_focus_restore_comes_back_paused);
  RUN_TEST(test_focus_ring_empties_clockwise_from_twelve);
  RUN_TEST(test_focus_digits_are_centred_on_the_ring);
  RUN_TEST(test_usage_payload_reads_optional_utc_offset);
  RUN_TEST(test_touch_gap_does_not_release);
  return UNITY_END();
}
