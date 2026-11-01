/*
  ================================================================
   Confined-Space Air Safety Monitor  —  ESP32 firmware
  ================================================================
  Board     : "ESP32 Dev Module"  (Arduino IDE, "esp32 by Espressif Systems")
  Libraries : Adafruit SSD1306, Adafruit GFX Library, Adafruit BMP280 Library,
              RTClib (by Adafruit), ESP32Servo (by Kevin Harrington)
              -> install all from Sketch > Include Library > Manage Libraries

  What it does
   1. Reads MQ135 (gas level, shown as CO2-equivalent ppm), BMP280 (temperature
      and pressure), LDR (light) and the HC-SR04 mounted on the SG90 servo
      (180-degree obstacle scan, shown as a radar on the OLED).
   2. Estimates O2 from the gas rise (or reads a potentiometer, for the demo).
   3. Decides SAFE / CAUTION / DANGER and drives the LED, buzzer and relay.
   4. Timestamps every reading with the DS3231 (auto-synced from the internet
      whenever Wi-Fi is available).
   5. Signs every reading (HMAC-SHA256) and uploads it to the server, which
      puts a hash of the data on the blockchain. Readings taken without Wi-Fi
      are buffered and uploaded later.

  Serial Monitor (115200 baud) commands:
     c = calibrate MQ135 (do this in fresh outdoor air, after warm-up)
     r = show current R0      h = help
*/

#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <time.h>
#include <math.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_BMP280.h>
#include <RTClib.h>
#include <ESP32Servo.h>
#include "mbedtls/md.h"
#include "secrets.h"   // copy secrets.example.h to secrets.h and set your Wi-Fi

// =================== 1. YOUR SETTINGS (edit these) ===================
const char* WIFI_SSID     = WIFI_SSID_VALUE;
const char* WIFI_PASSWORD = WIFI_PASSWORD_VALUE;
// IP of the laptop running the server (it prints this when it starts).
// Laptop and ESP32 must be on the same Wi-Fi / hotspot.
const char* SERVER_URL    = "http://192.168.1.100:3000/api/readings";
const char* DEVICE_ID     = "AQM-01";
const char* DEVICE_SECRET = "change-this-secret";  // must match DEVICE_SECRETS in server/.env
const long  TZ_OFFSET_SEC = 19800;                  // IST (UTC+5:30), used for the display only

#define USE_O2_POT 0   // 1 = potentiometer on GPIO 32 simulates O2 (demo knob)
                       // 0 = O2 estimated from the MQ135 reading

// =================== 2. PINS (match the wiring guide) ===================
#define PIN_SDA     21
#define PIN_SCL     22
#define PIN_MQ135   34   // through the 3-resistor divider
#define PIN_LDR     35
#define PIN_O2_POT  32   // only used when USE_O2_POT = 1
#define PIN_TRIG     5
#define PIN_ECHO    18   // through the 3-resistor divider
#define PIN_SERVO   13
#define PIN_RELAY   26
#define PIN_LED     25
#define PIN_BUZZER  27

// =================== 3. MODULE BEHAVIOUR (flip if yours acts reversed) ===================
#define RELAY_ACTIVE_LOW    true   // most blue relay modules switch ON with LOW
#define BUZZER_ACTIVE_LOW   false  // set true if your buzzer beeps when it should be quiet
#define LDR_BRIGHT_IS_HIGH  true   // bare LDR (3.3V-LDR-pin-1k-GND): true. Most LDR modules: false
const int LDR_DARK_THRESHOLD = 1000;  // tune by watching "LDR=" in Serial Monitor

// =================== 4. SAFETY LIMITS ===================
const float CO2_CAUTION_PPM = 800;
const float CO2_DANGER_PPM  = 1500;
const float O2_CAUTION_PCT  = 20.0;
const float O2_DANGER_LOW   = 19.5;
const float O2_DANGER_HIGH  = 23.5;
const float TEMP_CAUTION_C  = 40;
const float TEMP_DANGER_C   = 50;

// =================== 5. TIMING ===================
const unsigned long WARMUP_MS          = 120000UL;  // MQ135 heater warm-up (2 min)
const unsigned long SENSOR_INTERVAL_MS = 1000;
const unsigned long LOG_INTERVAL_MS    = 10000;     // one stored/uploaded reading every 10 s
const unsigned long DISPLAY_PAGE_MS    = 4000;      // switch OLED page every 4 s
const unsigned long SCAN_SETTLE_MS     = 80;        // servo settle time per scan step
const unsigned long RELAY_HOLD_MS      = 10000;     // keep fan on 10 s after danger clears
const unsigned long WIFI_RETRY_MS      = 15000;

// =================== 6. MQ135 MODEL ===================
const float MQ_VCC           = 5.0;     // heater/module supply
const float MQ_RL_KOHM       = 1.0;     // load resistor on the module ("102" = 1k)
const float MQ_DIVIDER_RATIO = 1.5;     // AO-[R]-pin-[R]-[R]-GND  => V_AO = V_pin * 1.5
const float MQ_PARA          = 116.6020682;
const float MQ_PARB          = 2.769034857;
const float ATMO_CO2_PPM     = 420.0;   // fresh outdoor air, used for calibration
const float ASSUMED_RH       = 50.0;    // no humidity sensor, assume 50 %
const float MQ_R0_DEFAULT    = 10.0;    // replaced by calibration (command "c")

// =================== 7. SCAN / RADAR ===================
const int   SCAN_MIN_DEG   = 0;
const int   SCAN_MAX_DEG   = 180;
const int   SCAN_STEP_DEG  = 10;
const int   SCAN_POINTS    = (SCAN_MAX_DEG - SCAN_MIN_DEG) / SCAN_STEP_DEG + 1;
const int   RADAR_RANGE_CM = 200;       // edge of the radar circle on the OLED

// =================== TYPES ===================
enum Level : uint8_t { LVL_SAFE = 0, LVL_CAUTION = 1, LVL_DANGER = 2, LVL_WARMUP = 3 };

struct Reading {
  uint32_t ts;          // unix time (UTC) from the DS3231
  uint32_t seq;
  float    co2, o2, temp, pres;
  uint16_t nearestCm, light;
  uint8_t  level;
  bool     timeTrusted;
  char     reason[32];
};

// =================== GLOBALS ===================
Adafruit_SSD1306 display(128, 64, &Wire, -1);
Adafruit_BMP280  bmp;
RTC_DS3231       rtc;
Servo            scanServo;
Preferences      prefs;

bool displayOk = false, bmpOk = false, rtcOk = false;
bool timeTrusted = false, ntpOk = false, wifiWasUp = false, serverOk = false;
unsigned long lastNtpSync = 0;

float mqR0 = MQ_R0_DEFAULT, mqVao = 0, mqRs = 0, mqRsCorr = 0;
float co2ppm = 0, o2pct = 20.9, tempC = NAN, presHpa = NAN;
int   ldrRaw = 0;
bool  isDark = false;

uint16_t scanDist[SCAN_POINTS];
int  scanAngle = SCAN_MIN_DEG, scanDir = 1;
uint16_t nearestCm = 0;

Level level = LVL_WARMUP;
char  reason[32] = "Starting";
bool  relayOn = false;
unsigned long lastDangerMs = 0;

uint32_t bootId = 0, seqCounter = 0;

// ring buffer for readings waiting to be uploaded
const int BUF_SIZE = 300;          // 300 x 10 s = 50 min without Wi-Fi
Reading   buf[BUF_SIZE];
int bufHead = 0, bufCount = 0;
uint32_t droppedReadings = 0;
unsigned long nextUploadTry = 0;

unsigned long lastSensorMs = 0, lastLogMs = 0, lastDisplayMs = 0,
              lastPrintMs = 0, lastScanStepMs = 0, lastWifiTry = 0;

// =================== SMALL HELPERS ===================
void setRelay(bool on)  { digitalWrite(PIN_RELAY,  (on ^ RELAY_ACTIVE_LOW)  ? HIGH : LOW); }
void setBuzzer(bool on) { digitalWrite(PIN_BUZZER, (on ^ BUZZER_ACTIVE_LOW) ? HIGH : LOW); }

const char* levelName(uint8_t l) {
  static const char* names[] = { "SAFE", "CAUTION", "DANGER", "WARMUP" };
  return l < 4 ? names[l] : "?";
}

uint32_t nowUtc() {
  if (rtcOk) return rtc.now().unixtime();
  time_t t = time(nullptr);
  return t > 1700000000 ? (uint32_t)t : 0;
}

void formatLocalTime(char* out) {          // "HH:MM:SS" in IST
  uint32_t t = nowUtc();
  if (t == 0) { strcpy(out, "--:--:--"); return; }
  DateTime d(t + TZ_OFFSET_SEC);
  sprintf(out, "%02d:%02d:%02d", d.hour(), d.minute(), d.second());
}

String hmacSha256Hex(const char* key, const char* msg) {
  uint8_t out[32];
  const mbedtls_md_info_t* info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, (const uint8_t*)key, strlen(key),
                  (const uint8_t*)msg, strlen(msg), out);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + 2 * i, "%02x", out[i]);
  return String(hex);
}

// =================== SENSORS ===================
float readMqVoltage() {                    // voltage at the MQ135 AO pin (before divider)
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) { sum += analogReadMilliVolts(PIN_MQ135); delayMicroseconds(200); }
  return (sum / 16.0f) / 1000.0f * MQ_DIVIDER_RATIO;
}

float mqResistance(float vao) {            // sensor resistance in kOhm
  vao = constrain(vao, 0.01f, MQ_VCC - 0.01f);
  return MQ_RL_KOHM * (MQ_VCC - vao) / vao;
}

float mqCorrection(float t, float h) {     // temperature/humidity correction (MQ135 datasheet fit)
  if (t < 20) return 0.00035f * t * t - 0.02718f * t + 1.39538f - (h - 33.0f) * 0.0018f;
  return -0.003333333f * t - 0.001923077f * h + 1.130128205f;
}

uint16_t readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH); delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long us = pulseIn(PIN_ECHO, HIGH, 25000UL);   // ~4 m max
  if (us == 0) return 0;                                  // no echo
  float t = isnan(tempC) ? 25.0f : tempC;
  float cm = us * (331.3f + 0.606f * t) / 20000.0f;       // speed of sound corrected for temperature
  return (cm < 2 || cm > 400) ? 0 : (uint16_t)cm;
}

void readSensors() {
  if (bmpOk) {
    tempC   = bmp.readTemperature();
    presHpa = bmp.readPressure() / 100.0f;
  }
  float t = isnan(tempC) ? 25.0f : tempC;

  mqVao    = readMqVoltage();
  mqRs     = mqResistance(mqVao);
  mqRsCorr = mqRs / mqCorrection(t, ASSUMED_RH);
  co2ppm   = constrain(MQ_PARA * powf(mqRsCorr / mqR0, -MQ_PARB), 0.0f, 10000.0f);

#if USE_O2_POT
  o2pct = 15.0f + analogRead(PIN_O2_POT) * (10.0f / 4095.0f);   // knob: 15 % .. 25 %
#else
  // breathing / burning / rotting uses up O2 roughly 1:1 with the CO2 it produces
  o2pct = 20.9f - max(0.0f, co2ppm - ATMO_CO2_PPM) / 10000.0f;
#endif

  ldrRaw = analogRead(PIN_LDR);
  bool dark = LDR_BRIGHT_IS_HIGH ? (ldrRaw < LDR_DARK_THRESHOLD) : (ldrRaw > LDR_DARK_THRESHOLD);
  if (dark != isDark) {
    isDark = dark;
    if (displayOk) display.dim(isDark);          // dim the OLED in the dark
  }

  nearestCm = 0;                                  // nearest obstacle from the last scan
  for (int i = 0; i < SCAN_POINTS; i++)
    if (scanDist[i] > 0 && (nearestCm == 0 || scanDist[i] < nearestCm)) nearestCm = scanDist[i];
}

// one scan step: measure at the current angle, then move the servo on
void updateScan() {
  if (millis() - lastScanStepMs < SCAN_SETTLE_MS) return;
  lastScanStepMs = millis();
  scanDist[(scanAngle - SCAN_MIN_DEG) / SCAN_STEP_DEG] = readDistanceCm();
  scanAngle += scanDir * SCAN_STEP_DEG;
  if (scanAngle >= SCAN_MAX_DEG)      { scanAngle = SCAN_MAX_DEG; scanDir = -1; }
  else if (scanAngle <= SCAN_MIN_DEG) { scanAngle = SCAN_MIN_DEG; scanDir =  1; }
  scanServo.write(scanAngle);
}

// =================== SAFETY DECISION ===================
void raiseLevel(Level l, const char* fmt, float v) {
  if (l > level) { level = l; snprintf(reason, sizeof(reason), fmt, v); }
}

void evaluate() {
  if (millis() < WARMUP_MS) {
    level = LVL_WARMUP;
    snprintf(reason, sizeof(reason), "Sensor warm-up %lus", (WARMUP_MS - millis()) / 1000);
    return;
  }
  level = LVL_SAFE;
  strcpy(reason, "All readings OK");
  // danger checks first, so the most serious reason is the one shown
  if (o2pct < O2_DANGER_LOW)                       raiseLevel(LVL_DANGER, "Low O2 %.1f%%", o2pct);
  if (o2pct > O2_DANGER_HIGH)                      raiseLevel(LVL_DANGER, "High O2 %.1f%%", o2pct);
  if (co2ppm >= CO2_DANGER_PPM)                    raiseLevel(LVL_DANGER, "Gas high %.0fppm", co2ppm);
  if (!isnan(tempC) && tempC >= TEMP_DANGER_C)     raiseLevel(LVL_DANGER, "Too hot %.0fC", tempC);
  if (o2pct < O2_CAUTION_PCT)                      raiseLevel(LVL_CAUTION, "O2 dropping %.1f%%", o2pct);
  if (co2ppm >= CO2_CAUTION_PPM)                   raiseLevel(LVL_CAUTION, "Gas rising %.0fppm", co2ppm);
  if (!isnan(tempC) && tempC >= TEMP_CAUTION_C)    raiseLevel(LVL_CAUTION, "Warm %.0fC", tempC);
}

void updateOutputs() {
  unsigned long t = millis();
  bool led = false, buzz = false;
  switch (level) {
    case LVL_SAFE:    led = true; break;                                       // steady
    case LVL_CAUTION: led = (t / 500) % 2; buzz = (t % 3000) < 100; break;     // blink + chirp
    case LVL_DANGER:  led = (t / 150) % 2; buzz = (t / 200) % 2;    break;     // fast + alarm
    case LVL_WARMUP:  led = (t / 1000) % 2; break;                             // slow blink
  }
  digitalWrite(PIN_LED, led ? HIGH : LOW);
  setBuzzer(buzz);

  if (level == LVL_DANGER) { relayOn = true; lastDangerMs = t; }               // fan / blower on
  else if (relayOn && t - lastDangerMs > RELAY_HOLD_MS) relayOn = false;
  setRelay(relayOn);
}

// =================== DATA LOG + UPLOAD ===================
void bufPush(const Reading& r) {
  if (bufCount == BUF_SIZE) {                       // full: drop the oldest
    bufHead = (bufHead + 1) % BUF_SIZE; bufCount--; droppedReadings++;
  }
  buf[(bufHead + bufCount) % BUF_SIZE] = r;
  bufCount++;
}

void logReading() {
  Reading r;
  r.ts = nowUtc();     r.seq = seqCounter++;
  r.co2 = co2ppm;      r.o2 = o2pct;   r.temp = tempC;  r.pres = presHpa;
  r.nearestCm = nearestCm;  r.light = ldrRaw;  r.level = level;
  r.timeTrusted = timeTrusted;
  strncpy(r.reason, reason, sizeof(r.reason) - 1); r.reason[sizeof(r.reason) - 1] = 0;
  bufPush(r);
}

void fmtNum(char* out, float v, int decimals) {      // JSON-safe number (NaN -> null)
  if (isnan(v)) strcpy(out, "null"); else sprintf(out, "%.*f", decimals, v);
}

void buildJson(const Reading& r, char* out, size_t n) {
  char t[16], p[16];
  fmtNum(t, r.temp, 1);
  fmtNum(p, r.pres, 1);
  snprintf(out, n,
    "{\"device\":\"%s\",\"boot\":%u,\"seq\":%u,\"ts\":%u,\"timeTrusted\":%s,"
    "\"co2eqPpm\":%.0f,\"o2Pct\":%.2f,\"o2Source\":\"%s\",\"tempC\":%s,\"pressureHpa\":%s,"
    "\"nearestCm\":%u,\"light\":%u,\"status\":\"%s\",\"reason\":\"%s\"}",
    DEVICE_ID, (unsigned)bootId, (unsigned)r.seq, (unsigned)r.ts, r.timeTrusted ? "true" : "false",
    r.co2, r.o2, USE_O2_POT ? "potentiometer" : "estimate", t, p,
    r.nearestCm, r.light, levelName(r.level), r.reason);
}

void uploadPending() {
  if (WiFi.status() != WL_CONNECTED || bufCount == 0 || millis() < nextUploadTry) return;
  int sent = 0;
  while (bufCount > 0 && sent < 5) {                // max 5 per loop so the device stays responsive
    char body[420];
    buildJson(buf[bufHead], body, sizeof(body));
    String sig = hmacSha256Hex(DEVICE_SECRET, body);

    HTTPClient http;
    http.setConnectTimeout(3000);
    http.setTimeout(4000);
    if (!http.begin(SERVER_URL)) { nextUploadTry = millis() + 10000; return; }
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Device-Id", DEVICE_ID);
    http.addHeader("X-Signature", sig);
    int code = http.POST((uint8_t*)body, strlen(body));
    http.end();

    if (code == 200 || code == 201 || code == 409) {   // 409 = server already has it
      bufHead = (bufHead + 1) % BUF_SIZE; bufCount--; sent++;
      serverOk = true;
    } else {
      serverOk = false;
      if (code == 401) Serial.println("[UPLOAD] 401: DEVICE_ID / DEVICE_SECRET don't match server .env");
      else Serial.printf("[UPLOAD] failed (%d) - is the server running at %s ?\n", code, SERVER_URL);
      nextUploadTry = millis() + 10000;
      return;
    }
  }
}

// =================== WI-FI + TIME ===================
void manageWiFi() {
  if (WiFi.status() == WL_CONNECTED) {
    if (!wifiWasUp) {
      wifiWasUp = true;
      Serial.printf("[WIFI] Connected, IP %s\n", WiFi.localIP().toString().c_str());
    }
    return;
  }
  if (wifiWasUp) { wifiWasUp = false; serverOk = false; Serial.println("[WIFI] Lost - buffering readings"); }
  if (millis() - lastWifiTry > WIFI_RETRY_MS) {
    lastWifiTry = millis();
    WiFi.disconnect();
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

void syncTimeIfNeeded() {          // internet time -> DS3231, once at start and then hourly
  if (WiFi.status() != WL_CONNECTED) return;
  if (ntpOk && millis() - lastNtpSync < 3600000UL) return;
  static unsigned long lastTry = 0;
  if (millis() - lastTry < 10000) return;
  lastTry = millis();
  time_t t = time(nullptr);
  if (t > 1700000000) {
    if (rtcOk) rtc.adjust(DateTime((uint32_t)t));
    ntpOk = true; timeTrusted = true; lastNtpSync = millis();
    Serial.println("[TIME] DS3231 synced from internet");
  }
}

// =================== DISPLAY ===================
void drawStatusPage() {
  char tbuf[10]; formatLocalTime(tbuf);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.printf("%s %s %s\n", DEVICE_ID, tbuf,
                 WiFi.status() == WL_CONNECTED ? (serverOk ? "UP" : "W") : "--");
  display.printf("Gas : %4.0f ppm CO2e\n", co2ppm);
  display.printf("O2  : %5.2f %% %s\n", o2pct, USE_O2_POT ? "(pot)" : "(est)");
  if (isnan(tempC)) display.print("Temp: --  BMP error\n");
  else display.printf("T:%4.1fC  P:%5.0fhPa\n", tempC, presHpa);
  display.printf("Near:%3ucm  Buf:%d\n", nearestCm, bufCount);

  display.setTextSize(2);
  display.setCursor(0, 40);
  display.print(level == LVL_WARMUP ? "WARM-UP" : levelName(level));
  display.setTextSize(1);
  display.setCursor(0, 56);
  display.print(reason);
}

void drawRadarPage() {
  const int cx = 64, cy = 63, R = 52;
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.printf("SCAN %dm", RADAR_RANGE_CM / 100);
  display.setCursor(74, 0);
  if (nearestCm) display.printf("Near:%ucm", nearestCm); else display.print("Near: --");

  display.drawCircleHelper(cx, cy, R, 0x1 | 0x2, SSD1306_WHITE);       // outer arc
  display.drawCircleHelper(cx, cy, R / 2, 0x1 | 0x2, SSD1306_WHITE);   // half-range arc
  display.drawFastHLine(cx - R, cy, 2 * R + 1, SSD1306_WHITE);

  float a = scanAngle * DEG_TO_RAD;                                     // sweep line
  display.drawLine(cx, cy, cx + R * cosf(a), cy - R * sinf(a), SSD1306_WHITE);

  for (int i = 0; i < SCAN_POINTS; i++) {                               // echoes
    uint16_t d = scanDist[i];
    if (d == 0 || d > RADAR_RANGE_CM) continue;
    float ang = (SCAN_MIN_DEG + i * SCAN_STEP_DEG) * DEG_TO_RAD;
    float r = (float)d * R / RADAR_RANGE_CM;
    display.fillCircle(cx + r * cosf(ang), cy - r * sinf(ang), 2, SSD1306_WHITE);
  }
}

void drawDisplay() {
  if (!displayOk) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  bool radar = (level != LVL_DANGER) && ((millis() / DISPLAY_PAGE_MS) % 2 == 1);
  if (radar) drawRadarPage(); else drawStatusPage();
  display.invertDisplay(level == LVL_DANGER && (millis() / 500) % 2);  // flash the screen in danger
  display.display();
}

// =================== SERIAL ===================
void printHelp() {
  Serial.println(F("\nCommands: c = calibrate MQ135 in fresh air (after warm-up), r = show R0, h = help"));
}

void calibrateMq() {
  if (millis() < WARMUP_MS) Serial.println(F("[CAL] Warning: still warming up, result may be off"));
  float sum = 0;
  for (int i = 0; i < 20; i++) {
    float t = isnan(tempC) ? 25.0f : tempC;
    sum += mqResistance(readMqVoltage()) / mqCorrection(t, ASSUMED_RH);
    delay(50);
  }
  mqR0 = (sum / 20.0f) * powf(ATMO_CO2_PPM / MQ_PARA, 1.0f / MQ_PARB);
  prefs.putFloat("r0", mqR0);
  Serial.printf("[CAL] New R0 = %.2f kOhm (saved, survives restart)\n", mqR0);
}

void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == 'c' || c == 'C') calibrateMq();
    else if (c == 'r' || c == 'R') Serial.printf("R0 = %.2f kOhm\n", mqR0);
    else if (c == 'h' || c == 'H') printHelp();
  }
}

void printDebug() {
  char tbuf[10]; formatLocalTime(tbuf);
  Serial.printf("[%s] %-7s CO2e=%.0fppm O2=%.2f%% T=%.1fC P=%.1fhPa | Vao=%.2fV Rs=%.2fk R0=%.2fk "
                "| LDR=%d%s near=%ucm angle=%d | buf=%d %s | %s\n",
                tbuf, levelName(level), co2ppm, o2pct, tempC, presHpa, mqVao, mqRs, mqR0,
                ldrRaw, isDark ? "(dark)" : "", nearestCm, scanAngle,
                bufCount, WiFi.status() == WL_CONNECTED ? "wifi" : "no-wifi", reason);
}

// =================== SETUP / LOOP ===================
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println(F("\n=== Confined-Space Air Safety Monitor ==="));

  pinMode(PIN_LED, OUTPUT);
  pinMode(PIN_BUZZER, OUTPUT);
  pinMode(PIN_RELAY, OUTPUT);
  setRelay(false); setBuzzer(false);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_MQ135, ADC_11db);
  analogSetPinAttenuation(PIN_LDR, ADC_11db);
  analogSetPinAttenuation(PIN_O2_POT, ADC_11db);

  Wire.begin(PIN_SDA, PIN_SCL);
  Wire.setClock(100000);

  displayOk = display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  Serial.println(displayOk ? "[OK] OLED" : "[ERR] OLED not found at 0x3C");
  if (displayOk) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println("Air Safety Monitor");
    display.println("Starting...");
    display.display();
  }

  bmpOk = bmp.begin(0x76) || bmp.begin(0x77);
  Serial.println(bmpOk ? "[OK] BMP280" : "[ERR] BMP280 not found (check CSB->3.3V, SDO->GND)");
  if (bmpOk) bmp.setSampling(Adafruit_BMP280::MODE_NORMAL, Adafruit_BMP280::SAMPLING_X2,
                             Adafruit_BMP280::SAMPLING_X16, Adafruit_BMP280::FILTER_X16,
                             Adafruit_BMP280::STANDBY_MS_500);

  rtcOk = rtc.begin();
  if (!rtcOk) Serial.println("[ERR] DS3231 not found");
  else if (rtc.lostPower()) {
    // clock was never set (or coin cell died): use compile time until internet time arrives
    rtc.adjust(DateTime(F(__DATE__), F(__TIME__)) - TimeSpan(TZ_OFFSET_SEC));
    timeTrusted = false;
    Serial.println("[OK] DS3231 (time set from compile time - will correct when online)");
  } else {
    timeTrusted = true;
    Serial.println("[OK] DS3231");
  }

  prefs.begin("aqm", false);
  mqR0   = prefs.getFloat("r0", MQ_R0_DEFAULT);
  bootId = prefs.getUInt("boot", 0) + 1;
  prefs.putUInt("boot", bootId);
  Serial.printf("[OK] R0 = %.2f kOhm %s, boot #%u\n", mqR0,
                mqR0 == MQ_R0_DEFAULT ? "(DEFAULT - please calibrate with 'c')" : "", (unsigned)bootId);

  scanServo.setPeriodHertz(50);
  scanServo.attach(PIN_SERVO, 500, 2400);     // wide pulse range => close to full 180 degrees
  scanServo.write(SCAN_MIN_DEG);

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  lastWifiTry = millis();
  configTime(0, 0, "pool.ntp.org", "time.google.com");   // keep system time in UTC

  printHelp();
}

void loop() {
  unsigned long now = millis();

  handleSerial();
  updateScan();

  if (now - lastSensorMs >= SENSOR_INTERVAL_MS) {
    lastSensorMs = now;
    readSensors();
    Level previous = level;
    evaluate();
    if (level != previous) {                       // record every status change immediately
      Serial.printf("[STATUS] %s -> %s (%s)\n", levelName(previous), levelName(level), reason);
      logReading();
      lastLogMs = now;
    }
  }

  updateOutputs();

  if (now - lastLogMs >= LOG_INTERVAL_MS) { lastLogMs = now; logReading(); }

  manageWiFi();
  syncTimeIfNeeded();
  uploadPending();

  if (now - lastDisplayMs >= 200)  { lastDisplayMs = now; drawDisplay(); }
  if (now - lastPrintMs   >= 2000) { lastPrintMs   = now; printDebug(); }
}
