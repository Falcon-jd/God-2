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
#define PELTIER_PWM_PIN   25
#define FAN_PWM_PIN        26
#define BODY_TEMP_PIN      32   // DS18B20 data pin (OneWire)
#define AMBIENT_TEMP_PIN   33
#define COLD_SIDE_PIN      27
#define HOT_SIDE_PIN       14

// ── Configurable safety thresholds (mirrors coolingAlgorithm.ts) ──────────
const float BODY_TEMP_WARNING_C   = 37.5;
const float BODY_TEMP_CRITICAL_C  = 38.5;
const float AMBIENT_WARNING_C     = 38.0;
const float AMBIENT_CRITICAL_C    = 45.0;
const float HOTSIDE_WARNING_C     = 55.0;
const float HOTSIDE_CRITICAL_C    = 65.0;
const float BATTERY_LOW_PCT       = 20.0;
const float BATTERY_CRITICAL_PCT  = 8.0;

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

unsigned long lastTelemetryMs = 0;
const unsigned long TELEMETRY_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------
// BLE connection callbacks
// ---------------------------------------------------------------------
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    deviceConnected = true;
    Serial.println("Website connected.");
  }
  void onDisconnect(BLEServer *server) override {
    deviceConnected = false;
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
    currentFanSpeed = doc["fanSpeedPercent"] | currentFanSpeed;
    currentTargetTempC = doc["targetTempC"] | currentTargetTempC;
    currentPeltierOn = doc["coolingOn"] | currentPeltierOn;

    Serial.printf("Command received: mode=%s level=%s fan=%d%% target=%.1fC peltier=%d\n",
      currentMode.c_str(), currentCoolingLevel.c_str(), currentFanSpeed, currentTargetTempC, currentPeltierOn);
  }
};

// ---------------------------------------------------------------------
// Sensor reads — replace these with real library calls for your sensors.
// Left as clearly-labeled placeholders so the sketch compiles and runs
// standalone; swap in DallasTemperature / INA219 / etc. per your wiring.
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
bool  readSensorFault()  { return false; /* TODO: validate sensor reads are in-range */ }

// ---------------------------------------------------------------------
// Automatic cooling algorithm — mirrors coolingAlgorithm.ts exactly
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

// Applies the decided cooling level + fan speed to the actual hardware
void applyCooling(const String &level, int fanPercent, bool peltierOn) {
  int peltierDuty = 0;
  if (peltierOn) {
    if (level == "low") peltierDuty = 90;
    else if (level == "medium") peltierDuty = 160;
    else if (level == "high") peltierDuty = 255;
  }
  analogWrite(PELTIER_PWM_PIN, peltierDuty);
  analogWrite(FAN_PWM_PIN, map(fanPercent, 0, 100, 0, 255));
}

// ---------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------
void setup() {
  Serial.begin(115200);
  pinMode(PELTIER_PWM_PIN, OUTPUT);
  pinMode(FAN_PWM_PIN, OUTPUT);

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

  Serial.println("JUST CHILL jacket advertising over BLE — open the website and tap 'Connect via Bluetooth'.");
}

// ---------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------
void loop() {
  unsigned long now = millis();
  if (now - lastTelemetryMs < TELEMETRY_INTERVAL_MS) return;
  lastTelemetryMs = now;

  float bodyC = readBodyTempC();
  float ambientC = readAmbientTempC();
  float coldC = readColdSideC();
  float hotC = readHotSideC();
  float battPct = readBatteryPct();
  float battV = readBatteryVoltage();
  float battA = readBatteryCurrentA();
  float battTempC = readBatteryTempC();
  bool charging = readIsCharging();
  bool sensorFault = readSensorFault();

  // Decide cooling behavior based on the app's chosen mode
  String coolingLevel; int fanSpeed; bool peltierOn;
  if (currentMode == "auto") {
    AutoDecision d = computeAutoDecision(bodyC, ambientC, hotC, sensorFault);
    coolingLevel = d.coolingLevel; fanSpeed = d.fanSpeedPercent; peltierOn = d.peltierOn;
  } else if (currentMode == "eco") {
    coolingLevel = "low"; fanSpeed = 40; peltierOn = battPct > 5;
  } else { // manual
    coolingLevel = currentCoolingLevel; fanSpeed = currentFanSpeed; peltierOn = currentPeltierOn;
  }
  applyCooling(coolingLevel, fanSpeed, peltierOn);

  // Overall safety status (mirrors computeSafetyLevel in coolingAlgorithm.ts)
  String safety = "normal";
  if (sensorFault || bodyC >= BODY_TEMP_CRITICAL_C || hotC >= HOTSIDE_CRITICAL_C || battPct <= BATTERY_CRITICAL_PCT) {
    safety = "critical";
  } else if (bodyC >= BODY_TEMP_WARNING_C || hotC >= HOTSIDE_WARNING_C || battPct <= BATTERY_LOW_PCT) {
    safety = "warning";
  }

  // Build and send the telemetry JSON frame (must match JacketTelemetry shape)
  StaticJsonDocument<384> doc;
  doc["timestamp"] = (uint32_t)(now);
  doc["bodyTempC"] = bodyC;
  doc["ambientTempC"] = ambientC;
  doc["peltierColdSideC"] = coldC;
  doc["peltierHotSideC"] = hotC;
  doc["batteryPercent"] = battPct;
  doc["batteryVoltage"] = battV;
  doc["batteryCurrentA"] = battA;
  doc["batteryTempC"] = battTempC;
  doc["isCharging"] = charging;
  doc["fanSpeedPercent"] = fanSpeed;
  doc["coolingLevel"] = coolingLevel;
  doc["peltierOn"] = peltierOn;
  doc["fanOn"] = fanSpeed > 2;
  doc["safetyStatus"] = safety;
  doc["sensorFault"] = sensorFault;

  String payload;
  serializeJson(doc, payload);

  if (deviceConnected) {
    pTelemetryChar->setValue(payload.c_str());
    pTelemetryChar->notify();
  }

  Serial.println(payload);
}
