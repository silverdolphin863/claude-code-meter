#pragma once

namespace ccmeter {

inline const char* serialHelloLine() {
  return "{\"type\":\"hello\",\"firmware\":\"1.0.4\",\"model\":\"ESP32-4848S040\"}";
}

inline const char* serialAckLine() {
  return "{\"type\":\"ack\"}";
}

inline const char* serialRefreshLine() {
  return "{\"type\":\"refresh\"}";
}

inline const char* serialInvalidUsageLine() {
  return "{\"type\":\"error\",\"error\":\"invalid_usage\"}";
}

}  // namespace ccmeter
