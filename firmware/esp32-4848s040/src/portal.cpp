#include "portal.h"

#include <WiFi.h>
#include <cstdio>

namespace ccmeter {
namespace {

String escapeHtml(String value) {
  value.replace("&", "&amp;");
  value.replace("<", "&lt;");
  value.replace(">", "&gt;");
  value.replace("\"", "&quot;");
  value.replace("'", "&#39;");
  return value;
}

String setupSsid() {
  const uint64_t chipId = ESP.getEfuseMac();
  char buffer[32] = {};
  snprintf(buffer, sizeof(buffer), "CCMeter-Setup-%04X", static_cast<unsigned int>(chipId & 0xFFFF));
  return String(buffer);
}

}  // namespace

ConfigPortal::ConfigPortal()
    : server_(80), config_(nullptr), apSsid_(), active_(false), restartAt_(0) {}

void ConfigPortal::begin(DeviceConfig& config, bool keepStation) {
  if (active_) return;
  config_ = &config;
  apSsid_ = setupSsid();
  WiFi.mode(keepStation ? WIFI_AP_STA : WIFI_AP);
  WiFi.softAP(apSsid_.c_str());
  registerRoutes();
  server_.begin();
  active_ = true;
}

void ConfigPortal::stop() {
  if (!active_) return;
  server_.stop();
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  active_ = false;
  restartAt_ = 0;
}

void ConfigPortal::handle() {
  if (!active_) return;
  server_.handleClient();
  if (restartAt_ != 0 && static_cast<int32_t>(millis() - restartAt_) >= 0) ESP.restart();
}

bool ConfigPortal::active() const {
  return active_;
}

const String& ConfigPortal::ssid() const {
  return apSsid_;
}

String ConfigPortal::ipAddress() const {
  return WiFi.softAPIP().toString();
}

void ConfigPortal::registerRoutes() {
  server_.on("/", HTTP_GET, [this]() { handleIndex(); });
  server_.on("/save", HTTP_POST, [this]() { handleSave(); });
  server_.onNotFound([this]() { server_.send(404, "text/plain", "not found"); });
}

String ConfigPortal::renderPage(const String& message, bool saved) const {
  const bool existing = config_ && config_->configured();
  String messageHtml;
  if (saved) messageHtml = "<p class=\"msg\">Saved. The device is restarting.</p>";
  else if (message.length()) messageHtml = String("<p class=\"msg\">") + escapeHtml(message) + "</p>";
  String page = R"rawliteral(<!doctype html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CC Meter setup</title>
<style>body{font-family:system-ui,sans-serif;background:#110f18;color:#eee;max-width:560px;margin:32px auto;padding:0 18px}main{background:#201e29;border:1px solid #413b51;border-radius:16px;padding:24px}h1{font-size:22px;margin:0 0 8px}p{color:#aaa;line-height:1.5}label{display:block;margin:16px 0 6px;color:#d7d1e5;font-size:14px}input{box-sizing:border-box;width:100%;padding:11px;border-radius:8px;border:1px solid #514a60;background:#14121c;color:#fff;font-size:16px}button{margin-top:22px;background:#39d98a;color:#0d1711;border:0;border-radius:8px;padding:12px 18px;font-weight:700;font-size:15px}.msg{color:#ffc83d;font-weight:600}</style></head>
<body><main><h1>CC Meter setup</h1>
<p>Connect this device to Wi-Fi and the CC Meter panel endpoint. The setup access point is open and is intended for local provisioning only.</p>
%MESSAGE%
<form method="post" action="/save">
<label for="ssid">Wi-Fi SSID</label><input id="ssid" name="ssid" maxlength="32" required value="%SSID%">
<label for="password">Wi-Fi password</label><input id="password" name="password" type="password" maxlength="128" autocomplete="new-password" %PASSWORD_REQUIRED%>
<p>%PASSWORD_HINT%</p>
<label for="base_url">Base URL</label><input id="base_url" name="base_url" maxlength="192" required value="%BASE_URL%" placeholder="http://host:port">
<label for="token">Bearer token</label><input id="token" name="token" type="password" maxlength="512" autocomplete="new-password" %TOKEN_REQUIRED%>
<p>%TOKEN_HINT%</p>
<button type="submit">Save and restart</button></form></main></body></html>)rawliteral";
  page.replace("%MESSAGE%", messageHtml);
  page.replace("%SSID%", existing ? escapeHtml(config_->ssid) : String());
  page.replace("%BASE_URL%", existing ? escapeHtml(config_->baseUrl) : String());
  page.replace("%PASSWORD_REQUIRED%", "");
  page.replace("%TOKEN_REQUIRED%", existing ? "" : "required");
  page.replace("%PASSWORD_HINT%", existing ? "Leave the password blank to keep the stored value." : "Required on first setup. An open Wi-Fi network may leave this blank.");
  page.replace("%TOKEN_HINT%", existing ? "Leave the token blank to keep the stored value." : "Required on first setup.");
  return page;
}

void ConfigPortal::handleIndex() {
  server_.sendHeader("Cache-Control", "no-store");
  server_.send(200, "text/html; charset=utf-8", renderPage("", false));
}

void ConfigPortal::handleSave() {
  if (!config_) {
    server_.send(500, "text/plain", "setup unavailable");
    return;
  }
  const bool existing = config_->configured();
  String ssid = server_.arg("ssid");
  String password = server_.arg("password");
  String baseUrl = server_.arg("base_url");
  String token = server_.arg("token");
  ssid.trim();
  baseUrl.trim();
  if (existing && password.length() == 0) password = config_->password;
  if (existing && token.length() == 0) token = config_->token;

  char error[64] = {};
  if (!saveDeviceConfig(ssid, password, baseUrl, token, error, sizeof(error))) {
    server_.sendHeader("Cache-Control", "no-store");
    server_.send(400, "text/html; charset=utf-8", renderPage("Please check the fields and try again.", false));
    return;
  }
  config_->ssid = ssid;
  config_->password = password;
  config_->baseUrl = baseUrl;
  while (config_->baseUrl.endsWith("/") && config_->baseUrl.length() > 8) config_->baseUrl.remove(config_->baseUrl.length() - 1);
  config_->token = token;
  restartAt_ = millis() + 1200;
  server_.sendHeader("Cache-Control", "no-store");
  server_.send(200, "text/html; charset=utf-8", renderPage("", true));
}

}  // namespace ccmeter
