/**
 * JUST CHILL — Real BLE connection via the Web Bluetooth API.
 *
 * This talks to an actual ESP32 running the matching firmware
 * (see esp32-firmware/just_chill_firmware.ino in this project).
 *
 * Browser support: Chrome or Edge on Android, Windows, macOS, ChromeOS,
 * or Linux. NOT supported in Safari or iOS (Apple has not implemented
 * Web Bluetooth). Must be served over HTTPS (Vercel/Netlify already do this).
 * The user must tap a button to start pairing — browsers block BLE from
 * starting automatically for security reasons.
 *
 * ── GATT layout (must match the ESP32 firmware exactly) ────────────────
 * Service UUID:            12345678-1234-5678-1234-56789abcdef0
 *   Telemetry characteristic (notify): 12345678-1234-5678-1234-56789abcdef1
 *     ESP32 -> Browser, JSON string, sent every ~2s
 *   Command characteristic  (write):   12345678-1234-5678-1234-56789abcdef2
 *     Browser -> ESP32, JSON string, sent whenever settings change
 */

export const SERVICE_UUID = "12345678-1234-5678-1234-56789abcdef0";
export const TELEMETRY_CHAR_UUID = "12345678-1234-5678-1234-56789abcdef1";
export const COMMAND_CHAR_UUID = "12345678-1234-5678-1234-56789abcdef2";

export function isWebBluetoothSupported() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

/**
 * Opens the browser's native device picker, connects, and subscribes to
 * telemetry notifications. Returns a handle with a disconnect() method and
 * a sendCommand() method; calls onTelemetry(t) every time new data arrives
 * and onDisconnect() if the link drops.
 */
export async function connectToJacket({ onTelemetry, onDisconnect }) {
  if (!isWebBluetoothSupported()) {
    throw new Error(
      "Web Bluetooth isn't supported in this browser. Use Chrome or Edge on Android/desktop."
    );
  }

  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [SERVICE_UUID] }],
    // If your firmware advertises a device name instead of the service UUID,
    // swap the line above for:
    // filters: [{ namePrefix: "JUST CHILL" }],
    // optionalServices: [SERVICE_UUID],
  });

  device.addEventListener("gattserverdisconnected", () => {
    onDisconnect && onDisconnect();
  });

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const telemetryChar = await service.getCharacteristic(TELEMETRY_CHAR_UUID);
  const commandChar = await service.getCharacteristic(COMMAND_CHAR_UUID);

  await telemetryChar.startNotifications();

  const decoder = new TextDecoder("utf-8");
  const handleNotification = (event) => {
    try {
      const text = decoder.decode(event.target.value);
      const telemetry = JSON.parse(text);
      onTelemetry && onTelemetry(telemetry);
    } catch (err) {
      console.warn("JUST CHILL: failed to parse telemetry payload", err);
    }
  };
  telemetryChar.addEventListener("characteristicvaluechanged", handleNotification);

  async function sendCommand(command) {
    const encoder = new TextEncoder();
    const payload = encoder.encode(JSON.stringify(command));
    // BLE writes are capped (typically ~20 bytes on older stacks, more with
    // negotiated MTU). Keep JacketCommand small — it's five short fields.
    await commandChar.writeValue(payload);
  }

  function disconnect() {
    telemetryChar.removeEventListener("characteristicvaluechanged", handleNotification);
    if (device.gatt.connected) device.gatt.disconnect();
  }

  return {
    deviceName: device.name || "JUST CHILL JACKET",
    sendCommand,
    disconnect,
  };
}
