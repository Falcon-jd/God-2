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
    // Entries in `filters` are OR'd. Matching on the service UUID alone meant
    // the picker was empty on any build whose advertisement packet carried the
    // name but not the service UUID — the jacket was simply invisible with no
    // error to explain why. Matching the name as well makes it show up either
    // way; optionalServices is what grants access to the service once paired.
    filters: [{ services: [SERVICE_UUID] }, { namePrefix: "JUST CHILL" }],
    optionalServices: [SERVICE_UUID],
  });

  const handleGattDisconnected = () => {
    onDisconnect && onDisconnect();
  };
  device.addEventListener("gattserverdisconnected", handleGattDisconnected);

  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const telemetryChar = await service.getCharacteristic(TELEMETRY_CHAR_UUID);
  const commandChar = await service.getCharacteristic(COMMAND_CHAR_UUID);

  await telemetryChar.startNotifications();

  const decoder = new TextDecoder("utf-8");

  // Telemetry can arrive split across several notifications when the peer
  // refuses to negotiate an MTU larger than the 23-byte default (20 usable
  // payload bytes) — and one JSON frame is far bigger than that. Parsing each
  // notification in isolation threw a SyntaxError on every single frame and
  // silently dropped all live data while the UI still showed "Connected", so
  // accumulate fragments until the buffer parses.
  let buffer = "";
  const handleNotification = (event) => {
    buffer += decoder.decode(event.target.value);

    // The firmware marks the end of a frame with a newline; if it doesn't,
    // fall back to trying the buffer as-is on every fragment.
    const parts = buffer.split("\n");
    buffer = parts.pop();
    for (const part of parts) {
      const text = part.trim();
      if (!text) continue;
      try {
        onTelemetry && onTelemetry(JSON.parse(text));
      } catch (err) {
        console.warn("JUST CHILL: dropped an unparseable telemetry frame", text, err);
      }
    }

    if (buffer.length) {
      try {
        const telemetry = JSON.parse(buffer);
        buffer = "";
        onTelemetry && onTelemetry(telemetry);
      } catch {
        // Still mid-frame — keep accumulating. Guard against an unterminated
        // frame growing without bound if the firmware sends garbage.
        if (buffer.length > 4096) buffer = "";
      }
    }
  };
  telemetryChar.addEventListener("characteristicvaluechanged", handleNotification);

  // A GATT write started while another is still in flight is rejected with
  // "GATT operation already in progress". Dragging a slider fires a change per
  // pixel, so writes are serialised through one chain and superseded commands
  // are dropped — only the newest pending value is ever sent, and it always
  // wins, instead of the jacket being left on a stale mid-drag value.
  let inFlight = Promise.resolve();
  let queued = null;
  async function sendCommand(command) {
    queued = command;
    const run = inFlight.then(async () => {
      const next = queued;
      if (next === null) return;
      queued = null;
      const payload = new TextEncoder().encode(JSON.stringify(next));
      // writeValueWithResponse where available: it waits for the peer to ack,
      // which is what keeps the queue honest. Older stacks only have writeValue.
      if (commandChar.writeValueWithResponse) await commandChar.writeValueWithResponse(payload);
      else await commandChar.writeValue(payload);
    }).catch((err) => {
      console.warn("JUST CHILL: command write failed", err);
    });
    inFlight = run;
    return run;
  }

  function disconnect() {
    queued = null;
    telemetryChar.removeEventListener("characteristicvaluechanged", handleNotification);
    device.removeEventListener("gattserverdisconnected", handleGattDisconnected);
    telemetryChar.stopNotifications().catch(() => {});
    if (device.gatt.connected) device.gatt.disconnect();
  }

  return {
    deviceName: device.name || "JUST CHILL JACKET",
    sendCommand,
    disconnect,
  };
}
