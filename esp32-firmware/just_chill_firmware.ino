/*
  JUST CHILL — ESP32 firmware
  ----------------------------
  Implements the BLE GATT server the website connects to via Web Bluetooth.
  Publishes a JSON telemetry frame every ~2 seconds and listens for JSON
  command frames written by the app.

  ── Required Arduino libraries (Library Manager) ──────────────────────────
    - ArduinoJson (by Benoit Blanchon)          — JSON encode/decode
    - OneWire + DallasTemperature                — DS18B20 temp sensors
    - Adafruit INA219 (if using an INA219 current/voltage sensor)
  BLE support (BLEDevice, BLEServer, etc.) ships built-in with the
  "ESP32" board package in Arduino IDE — no separate install needed.

  ── Board settings ─────────────────────────────────────────────────────
    Tools > Board > ESP32 Dev Module (or your specific board)

  ── What to wire up (see README for a full parts list) ────────────────
    - Body temp sensor          -> BODY_TEMP_PIN (DS18B20, OneWire bus)
    - Ambient temp sensor       -> AMBIENT_TEMP_PIN
    - Peltier cold-side sensor  -> COLD_SIDE_PIN
    - Peltier hot-side sensor   -> HOT_SIDE_PIN
    - Peltier MOSFET driver     -> PELTIER_PWM_PIN
    - Fan driver                -> FAN_PWM_PIN
    - Battery current sensor    -> I2C (SDA/SCL) if using INA219

  This file is a complete, working starting point — swap the placeholder
  sensor-reading functions for your actual sensor library calls, and it's
  ready to run.

  ── SAFETY ────────────────────────────────────────────────────────────
  This drives a Peltier module inside a garment worn against skin. The
  interlocks in applyOutputs() are not optional decoration:

    * The Peltier is never energised without airflow over its heatsink.
      A Peltier with a stalled fan does not cool — it dumps its full
      electrical power plus the heat it pumped into a heatsink that has
      nowhere to send it, and the hot side climbs without limit.
    * The hot-side cutoff applies in EVERY mode, not just AUTO. Previously
      it lived inside computeAutoDecision(), so MANUAL and ECO ran with no
      thermal limit at all.
    * If the phone disconnects or stops sending commands, the Peltier is
      shut down rather than left latched at whatever it was last told.

  Do not remove these to "get more cooling".
*/

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <ArduinoJson.h>

// ── Must match src/services/bleService.js in the website exactly ─────────
#define SERVICE_UUID           "12345678-1234-5678-1234-56789abcdef0"
#define TELEMETRY_CHAR_UUID    "12345678-1234-5678-1234-56789abcdef1"
#define COMMAND_CHAR_UUID      "12345678-1234-5678-1234-56789abcdef2"

// ── Pin assignments — change to match your wiring ─────────────────────────
// Note: GPIO 34-39 are input-only on the ESP32 and cannot drive an output.
// Keep PELTIER_PWM_PIN and FAN_PWM_PIN out of that range.
#define PELTIER_PWM_PIN   25
#define FAN_PWM_PIN        26
#define BODY_TEMP_PIN      32   // DS18B20 data pin (OneWire)
#define AMBIENT_TEMP_PIN   33
#define COLD_SIDE_PIN      27
#define HOT_SIDE_PIN       14

// ── Configurable safety thresholds (mirrors THRESHOLDS in src/App.jsx) ────
const float BODY_TEMP_WARNING_C   = 37.5;
const float BODY_TEMP_CRITICAL_C  = 38.5;
const float AMBIENT_WARNING_C     = 38.0;
const float AMBIENT_CRITICAL_C    = 45.0;
const float HOTSIDE_WARNING_C     = 55.0;
const float HOTSIDE_CRITICAL_C    = 65.0;
const float BATTERY_LOW_PCT       = 20.0;
const float BATTERY_CRITICAL_PCT  = 8.0;
const float BATTERY_TEMP_CRITICAL_C = 55.0;
const float OVERCURRENT_A         = 6.0;

// Once the hot side trips the critical limit the Peltier stays off until it
// has fallen this far back down. Without hysteresis it would chatter fully
// on/off around exactly 65.0 C.
const float HOTSIDE_RECOVER_C     = 55.0;

// Minimum fan duty (0-255) whenever the Peltier draws any current at all.
// Mirrors MIN_FAN_WITH_PELTIER in src/App.jsx (40% of 255 ≈ 102).
const int MIN_FAN_DUTY_WITH_PELTIER = 102;

// If no command arrives for this long while in MANUAL, assume the phone is
// gone and fall back to AUTO, which has its own limits.
const unsigned long COMMAND_TIMEOUT_MS = 30000;

BLEServer *pServer = nullptr;
BLECharacteristic *pTelemetryChar = nullptr;
BLECharacteristic *pCommandChar = nullptr;
bool deviceConnected = false;

// Current command state received from the app (defaults to AUTO / medium)
String currentMode = "auto";
String currentCoolingLevel = "medium";
int currentFanSpeed = 50;
float currentTargetTempC = 22.0;
bool currentPeltierOn = true;
bool autoCoolingEnabled = true;
unsigned long lastCommandMs = 0;

// What was actually applied to the hardware on the last control pass. Telemetry
// reports these, not what was requested — the app used to display "Peltier ON"
// while a safety interlock held the PWM output at 0.
int appliedPeltierDuty = 0;
int appliedFanDuty = 0;
String appliedCoolingLevel = "off";
bool hotSideLatched = false;   // true while the hot-side cutoff is holding

unsigned long lastTelemetryMs = 0;
unsigned long lastControlMs = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 2000;
// The control loop runs far more often than telemetry so a thermal runaway is
// caught in a fifth of a second rather than up to two seconds later.
const unsigned long CONTROL_INTERVAL_MS = 200;

// ---------------------------------------------------------------------
// BLE connection callbacks
// ---------------------------------------------------------------------
void shutDownCooling(const char *reason);

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    deviceConnected = true;
    lastCommandMs = millis();
    Serial.println("Website connected.");
  }
  void onDisconnect(BLEServer *server) override {
    deviceConnected = false;
    // Do not leave the Peltier latched at its last commanded duty with nobody
    // watching. Kill the output and hand control back to AUTO.
    shutDownCooling("BLE link dropped");
    currentMode = "auto";
    Serial.println("Website disconnected — restarting advertising.");
    server->getAdvertising()->start();
  }
};

// Called whenever the website writes a new command
class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    String value = characteristic->getValue().c_str();
    if (value.length() == 0) return;

    StaticJsonDocument<256> doc;
    DeserializationError err = deserializeJson(doc, value);
    if (err) {
      Serial.print("Bad command JSON: ");
      Serial.println(err.c_str());
      return;
    }

    currentMode = doc["mode"] | currentMode;
    currentCoolingLevel = doc["coolingLevel"] | currentCoolingLevel;
    // Clamp everything that arrives over the air. A malformed or truncated
    // frame must not be able to drive an out-of-range duty.
    currentFanSpeed = constrain((int)(doc["fanSpeedPercent"] | currentFanSpeed), 0, 100);
    currentTargetTempC = constrain((float)(doc["targetTempC"] | currentTargetTempC), 5.0f, 35.0f);
    currentPeltierOn = doc["coolingOn"] | currentPeltierOn;
    autoCoolingEnabled = doc["autoCooling"] | autoCoolingEnabled;
    lastCommandMs = millis();

    Serial.printf("Command received: mode=%s level=%s fan=%d%% target=%.1fC peltier=%d auto=%d\n",
      currentMode.c_str(), currentCoolingLevel.c_str(), currentFanSpeed,
      currentTargetTempC, currentPeltierOn, autoCoolingEnabled);
  }
};

// ---------------------------------------------------------------------
// Sensor reads — replace these with real library calls for your sensors.
// Left as clearly-labeled placeholders so the sketch compiles and runs
// standalone; swap in DallasTemperature / INA219 / etc. per your wiring.
//
// IMPORTANT: return NAN from a reader when the sensor is missing or the
// read failed. DallasTemperature returns DEVICE_DISCONNECTED_C (-127) for a
// disconnected probe — do NOT pass that through as a real temperature, or a
// dangling wire reads as a very cold, very safe jacket.
// ---------------------------------------------------------------------
float readBodyTempC()    { return 36.6; /* TODO: DS18B20 on BODY_TEMP_PIN */ }
float readAmbientTempC() { return 33.0; /* TODO: DS18B20 on AMBIENT_TEMP_PIN */ }
float readColdSideC()    { return 18.0; /* TODO: DS18B20 on COLD_SIDE_PIN */ }
float readHotSideC()     { return 32.0; /* TODO: DS18B20 on HOT_SIDE_PIN */ }
float readBatteryPct()   { return 86.0; /* TODO: from INA219 or fuel-gauge IC */ }
float readBatteryVoltage() { return 11.8; /* TODO: INA219 bus voltage */ }
float readBatteryCurrentA() { return 1.2; /* TODO: INA219 current */ }
float readBatteryTempC() { return 29.0; /* TODO: DS18B20 near battery pack */ }
bool  readIsCharging()   { return false; /* TODO: charger status pin */ }

// A reading is a fault if it is NAN or outside what the sensor could plausibly
// see on a working jacket. This used to be a hardcoded `return false`, which
// meant a disconnected probe was reported as a healthy sensor forever.
bool isPlausible(float v, float lo, float hi) {
  return !isnan(v) && v > lo && v < hi;
}

bool detectSensorFault(float bodyC, float ambientC, float coldC, float hotC,
                       float battV, float battA, float battTempC) {
  if (!isPlausible(bodyC, 20.0, 45.0)) return true;
  if (!isPlausible(ambientC, -20.0, 70.0)) return true;
  if (!isPlausible(coldC, -20.0, 70.0)) return true;
  if (!isPlausible(hotC, -20.0, 120.0)) return true;
  if (!isPlausible(battV, 5.0, 30.0)) return true;
  if (isnan(battA) || battA < -1.0 || battA > 20.0) return true;
  if (!isPlausible(battTempC, -20.0, 90.0)) return true;
  return false;
}

// ---------------------------------------------------------------------
// Automatic cooling algorithm — mirrors computeAutoDecision in src/App.jsx
// ---------------------------------------------------------------------
struct AutoDecision { String coolingLevel; int fanSpeedPercent; bool peltierOn; };

AutoDecision computeAutoDecision(float bodyC, float ambientC, float hotSideC, bool sensorFault) {
  if (sensorFault) return { "medium", 60, true };

  if (hotSideC >= HOTSIDE_CRITICAL_C) return { "low", 100, false };
  if (hotSideC >= HOTSIDE_WARNING_C)  return { "low", 80, true };

  float heatIndex = max(bodyC - BODY_TEMP_WARNING_C, (ambientC - AMBIENT_WARNING_C) * 0.3f);

  if (bodyC >= BODY_TEMP_CRITICAL_C || ambientC >= AMBIENT_CRITICAL_C) return { "high", 100, true };
  if (bodyC >= BODY_TEMP_WARNING_C || heatIndex > 0) {
    int fan = 65 + min(20, (int)round(heatIndex * 10));
    return { "medium", fan, true };
  }
  return { "low", 35, true };
}

int dutyForLevel(const String &level) {
  if (level == "low") return 90;
  if (level == "medium") return 160;
  if (level == "high") return 255;
  return 0; // "off" or anything unrecognised
}

/*
  Closes the loop on the Target Temperature slider in the app.

  The slider previously did nothing at all: onWrite stored targetTempC and no
  code ever read it, so a control the user could drag had zero effect on the
  hardware. Here the chosen cooling level sets the CEILING and the cold-side
  error decides how much of that ceiling is actually used — full output at
  4 C or more above the setpoint, tapering to zero once the setpoint is met.
*/
int dutyForTarget(const String &level, float coldC, float targetC) {
  int ceiling = dutyForLevel(level);
  if (ceiling == 0) return 0;
  if (isnan(coldC)) return ceiling;   // no cold-side reading: fall back to open loop
  float error = coldC - targetC;      // positive = still warmer than asked for
  if (error <= 0.0f) return 0;        // at or below setpoint, coast
  float gain = constrain(error / 4.0f, 0.0f, 1.0f);
  return (int)(ceiling * gain);
}

/*
  The single place that touches the PWM pins.

  Every safety interlock lives here rather than in the per-mode branches, so
  MANUAL and ECO get exactly the same protection AUTO does.
*/
void applyOutputs(const String &level, int requestedPeltierDuty, int fanPercent,
                  float hotC, float battTempC, float battA, bool sensorFault) {
  int peltierDuty = constrain(requestedPeltierDuty, 0, 255);
  int fanDuty = map(constrain(fanPercent, 0, 100), 0, 100, 0, 255);
  String levelOut = (peltierDuty > 0) ? level : String("off");

  // 1. Hot-side cutoff, with hysteresis so it does not chatter at the limit.
  if (!isnan(hotC)) {
    if (hotC >= HOTSIDE_CRITICAL_C) hotSideLatched = true;
    else if (hotC < HOTSIDE_RECOVER_C) hotSideLatched = false;

    if (hotSideLatched) {
      peltierDuty = 0;
      levelOut = "off";
      fanDuty = 255;              // keep pulling heat out of the sink
    } else if (hotC >= HOTSIDE_WARNING_C) {
      peltierDuty = min(peltierDuty, 90);
      if (peltierDuty > 0) levelOut = "low";
      fanDuty = max(fanDuty, 204); // 80%
    }
  } else {
    // No hot-side reading at all. Running a Peltier blind is not acceptable.
    peltierDuty = 0;
    levelOut = "off";
  }

  // 2. Battery pack limits — transmitted to the app before, but never acted on.
  if ((!isnan(battTempC) && battTempC >= BATTERY_TEMP_CRITICAL_C) ||
      (!isnan(battA) && battA >= OVERCURRENT_A)) {
    peltierDuty = 0;
    levelOut = "off";
  }

  // 3. A sensor fault means we do not trust the numbers the limits above use.
  if (sensorFault) {
    peltierDuty = 0;
    levelOut = "off";
    fanDuty = max(fanDuty, MIN_FAN_DUTY_WITH_PELTIER);
  }

  // 4. THE INTERLOCK. No Peltier current without airflow, ever. This is last
  //    so nothing above can reintroduce the {peltier on, fan stopped} pair.
  if (peltierDuty > 0) fanDuty = max(fanDuty, MIN_FAN_DUTY_WITH_PELTIER);

  analogWrite(PELTIER_PWM_PIN, peltierDuty);
  analogWrite(FAN_PWM_PIN, fanDuty);

  appliedPeltierDuty = peltierDuty;
  appliedFanDuty = fanDuty;
  appliedCoolingLevel = levelOut;
}

void shutDownCooling(const char *reason) {
  analogWrite(PELTIER_PWM_PIN, 0);
  analogWrite(FAN_PWM_PIN, MIN_FAN_DUTY_WITH_PELTIER); // purge residual heat
  appliedPeltierDuty = 0;
  appliedFanDuty = MIN_FAN_DUTY_WITH_PELTIER;
  appliedCoolingLevel = "off";
  Serial.print("Cooling shut down: ");
  Serial.println(reason);
}

// ---------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(PELTIER_PWM_PIN, OUTPUT);
  pinMode(FAN_PWM_PIN, OUTPUT);
  analogWrite(PELTIER_PWM_PIN, 0);
  analogWrite(FAN_PWM_PIN, 0);

  // Raise the ATT MTU BEFORE anything else BLE-related.
  //
  // The default MTU is 23 bytes, which leaves 20 usable bytes in a
  // notification. The telemetry frame below is around 280 bytes, so with the
  // default MTU every single notification was silently truncated to its first
  // 20 characters, the browser's JSON.parse threw on all of them, and the app
  // sat there showing a green "Connected" badge next to placeholder readings
  // that had never come from a sensor. Nothing in the UI revealed the problem.
  //
  // setMTU() only sets what this device is willing to accept; the peer still
  // has to agree. The website reassembles newline-delimited fragments as a
  // fallback for peers that refuse to go above 23.
  BLEDevice::setMTU(517);

  BLEDevice::init("JUST CHILL JACKET");
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService *pService = pServer->createService(SERVICE_UUID);

  pTelemetryChar = pService->createCharacteristic(
    TELEMETRY_CHAR_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  pTelemetryChar->addDescriptor(new BLE2902());

  pCommandChar = pService->createCharacteristic(
    COMMAND_CHAR_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  pCommandChar->setCallbacks(new CommandCallbacks());

  pService->start();

  BLEAdvertising *pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  BLEDevice::startAdvertising();

  lastCommandMs = millis();
  Serial.println("JUST CHILL jacket advertising over BLE — open the website and tap 'Connect via Bluetooth'.");
}

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------
void loop() {
  unsigned long now = millis();
  if (now - lastControlMs < CONTROL_INTERVAL_MS) return;
  lastControlMs = now;

  float bodyC = readBodyTempC();
  float ambientC = readAmbientTempC();
  float coldC = readColdSideC();
  float hotC = readHotSideC();
  float battPct = readBatteryPct();
  float battV = readBatteryVoltage();
  float battA = readBatteryCurrentA();
  float battTempC = readBatteryTempC();
  bool charging = readIsCharging();
  bool sensorFault = detectSensorFault(bodyC, ambientC, coldC, hotC, battV, battA, battTempC);

  // A phone that stopped talking to us — app backgrounded, screen off, walked
  // out of range without a clean disconnect — must not leave MANUAL settings
  // driving the hardware indefinitely.
  if (currentMode == "manual" && (now - lastCommandMs > COMMAND_TIMEOUT_MS)) {
    Serial.println("No command for 30s — leaving MANUAL, falling back to AUTO.");
    currentMode = "auto";
  }

  // Decide cooling behavior based on the app's chosen mode
  String coolingLevel; int fanSpeed; bool peltierOn; int peltierDuty;
  if (currentMode == "auto") {
    if (autoCoolingEnabled) {
      AutoDecision d = computeAutoDecision(bodyC, ambientC, hotC, sensorFault);
      coolingLevel = d.coolingLevel; fanSpeed = d.fanSpeedPercent; peltierOn = d.peltierOn;
    } else {
      // "Automatic Cooling" switched off in the app: monitor, never drive.
      coolingLevel = "off"; fanSpeed = 0; peltierOn = false;
    }
    peltierDuty = peltierOn ? dutyForLevel(coolingLevel) : 0;
  } else if (currentMode == "eco") {
    coolingLevel = "low"; fanSpeed = 40; peltierOn = battPct > 5;
    peltierDuty = peltierOn ? dutyForLevel(coolingLevel) : 0;
  } else { // manual — the Target Temperature slider is live in this mode
    coolingLevel = currentCoolingLevel; fanSpeed = currentFanSpeed; peltierOn = currentPeltierOn;
    peltierDuty = peltierOn ? dutyForTarget(coolingLevel, coldC, currentTargetTempC) : 0;
  }

  applyOutputs(coolingLevel, peltierDuty, fanSpeed, hotC, battTempC, battA, sensorFault);

  // ── Telemetry, at the slower interval ──────────────────────────────────
  if (now - lastTelemetryMs < TELEMETRY_INTERVAL_MS) return;
  lastTelemetryMs = now;

  // Build and send the telemetry JSON frame (must match what src/App.jsx reads).
  //
  // `timestamp` and `safetyStatus` are deliberately NOT sent: the app stamps
  // arrival time itself (this board has no real-time clock, so millis() showed
  // up on the chart as a 1970 date) and recomputes the safety level from the
  // raw readings. Both were pure MTU cost.
  StaticJsonDocument<384> doc;
  doc["bodyTempC"] = bodyC;
  doc["ambientTempC"] = ambientC;
  doc["peltierColdSideC"] = coldC;
  doc["peltierHotSideC"] = hotC;
  doc["batteryPercent"] = battPct;
  doc["batteryVoltage"] = battV;
  doc["batteryCurrentA"] = battA;
  doc["batteryTempC"] = battTempC;
  doc["isCharging"] = charging;
  // Report what was APPLIED, not what was requested. Reporting the commanded
  // flag meant the dashboard said "Peltier ON" while an interlock held the
  // output at zero.
  doc["fanSpeedPercent"] = map(appliedFanDuty, 0, 255, 0, 100);
  doc["coolingLevel"] = appliedCoolingLevel;
  doc["peltierOn"] = appliedPeltierDuty > 0;
  doc["fanOn"] = appliedFanDuty > 5;
  doc["sensorFault"] = sensorFault;

  String payload;
  serializeJson(doc, payload);
  payload += "\n";   // frame delimiter, so the website can reassemble fragments

  if (deviceConnected) {
    pTelemetryChar->setValue(payload.c_str());
    pTelemetryChar->notify();
  }

  Serial.print(payload);
}
