#pragma once

#include "config_store.h"

#include <WebServer.h>

namespace ccmeter {

class ConfigPortal {
 public:
  ConfigPortal();

  void begin(DeviceConfig& config, bool keepStation);
  void stop();
  void handle();

  bool active() const;
  const String& ssid() const;
  String ipAddress() const;

 private:
  void registerRoutes();
  void handleIndex();
  void handleSave();
  String renderPage(const String& message, bool saved) const;

  WebServer server_;
  DeviceConfig* config_;
  String apSsid_;
  bool active_;
  uint32_t restartAt_;
};

}  // namespace ccmeter
