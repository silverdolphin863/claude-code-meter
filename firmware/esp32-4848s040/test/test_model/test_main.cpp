#include <cstring>

#include <unity.h>

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
  const char payload[] = R"json({"type":"usage","data":{"server_time_ms":1786104000000,"generated_at":"2026-08-07T12:00:00Z","sections":[{"id":"codex","name":"Codex","limits":[{"label":"Weekly","percent":31,"resets_at":"2026-08-14T12:00:00Z","reset_label":"14.08 14:00","window_hours":168}]}]}})json";
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
}

void test_serial_usage_envelope_rejects_non_usage_messages() {
  const char payload[] = R"json({"type":"status","data":{"sections":[]}})json";
  UsageSnapshot snapshot;
  char error[64] = {};
  TEST_ASSERT_FALSE(parseUsageEnvelope(payload, strlen(payload), snapshot, error, sizeof(error)));
  TEST_ASSERT_EQUAL_STRING("usage envelope required", error);
}

void test_serial_protocol_lines_are_stable() {
  TEST_ASSERT_EQUAL_STRING("{\"type\":\"hello\",\"firmware\":\"1.0.8\",\"model\":\"ESP32-4848S040\"}", serialHelloLine());
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
  return UNITY_END();
}
