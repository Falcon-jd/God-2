import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Bluetooth, Power, Snowflake, Sun, Battery, BatteryCharging, Flame, Fan,
  Sparkles, Leaf, SlidersHorizontal, ShieldCheck, AlertTriangle, ChevronRight,
  X, CheckCircle2, Gauge, Zap, Thermometer, Wind, User, Globe,
  Play, Radio, Settings as SettingsIcon, BarChart3, Bell, Volume2,
} from "lucide-react";
import { connectToJacket, isWebBluetoothSupported } from "./services/bleService";
import { sounds, setSoundEnabled } from "./services/soundService";

/* ---------------------------------------------------------------------- */
/* Design tokens — dark navy / ice-blue-cyan industrial-tech              */
/* ---------------------------------------------------------------------- */
const C = {
  bgBase: "#070B14",
  bgElevated: "#0D1424",
  card: "#121B30",
  cardElevated: "#182342",
  cardBorder: "rgba(140,190,255,0.10)",
  divider: "rgba(255,255,255,0.06)",
  cyan: "#00E5FF",
  cyanSoft: "#5AD8FF",
  cyanDim: "rgba(0,229,255,0.14)",
  blue: "#2E7DFF",
  textPrimary: "#F5F9FF",
  textSecondary: "#8FA0C2",
  // #5B688A only reached 3.10:1 on C.card, below the WCAG AA 4.5:1 minimum for
  // body text. #7C89AD measures 4.93:1 on C.card and 5.29:1 on C.bgElevated
  // while staying visibly dimmer than textSecondary.
  textTertiary: "#7C89AD",
  textInverse: "#02101F",
  normal: "#22E0B0",
  normalDim: "rgba(34,224,176,0.14)",
  warning: "#FFB020",
  warningDim: "rgba(255,176,32,0.14)",
  critical: "#FF3B5C",
  criticalDim: "rgba(255,59,92,0.15)",
  offline: "#4B5878",
};

const THRESHOLDS = {
  bodyTempWarningC: 37.5,
  bodyTempCriticalC: 38.5,
  ambientTempWarningC: 38,
  ambientTempCriticalC: 45,
  peltierHotSideWarningC: 55,
  peltierHotSideCriticalC: 65,
  batteryLowPercent: 20,
  batteryCriticalPercent: 8,
  batteryTempCriticalC: 55,
  overcurrentA: 6,
};

// A Peltier module with no airflow over its heatsink does not cool — it dumps
// its full electrical power plus the pumped heat into a stalled block and the
// delta-T collapses. Whenever the Peltier draws current the fan must move air.
const MIN_FAN_WITH_PELTIER = 40;

const statusColor = (level) => {
  if (level === "normal") return { fg: C.normal, bg: C.normalDim };
  if (level === "warning") return { fg: C.warning, bg: C.warningDim };
  if (level === "critical") return { fg: C.critical, bg: C.criticalDim };
  return { fg: C.offline, bg: "rgba(75,88,120,0.18)" };
};

/* ---------------------------------------------------------------------- */
/* Cooling algorithm (ported 1:1 from the mobile app's coolingAlgorithm.ts)*/
/* ---------------------------------------------------------------------- */
function computeAutoDecision({ bodyTempC, ambientTempC, peltierHotSideC, sensorFault }) {
  if (sensorFault) {
    return { coolingLevel: "medium", fanSpeedPercent: 60, peltierOn: true };
  }
  if (peltierHotSideC >= THRESHOLDS.peltierHotSideCriticalC) {
    return { coolingLevel: "low", fanSpeedPercent: 100, peltierOn: false };
  }
  if (peltierHotSideC >= THRESHOLDS.peltierHotSideWarningC) {
    return { coolingLevel: "low", fanSpeedPercent: 80, peltierOn: true };
  }
  const heatIndex = Math.max(
    bodyTempC - THRESHOLDS.bodyTempWarningC,
    (ambientTempC - THRESHOLDS.ambientTempWarningC) * 0.3
  );
  if (bodyTempC >= THRESHOLDS.bodyTempCriticalC || ambientTempC >= THRESHOLDS.ambientTempCriticalC) {
    return { coolingLevel: "high", fanSpeedPercent: 100, peltierOn: true };
  }
  if (bodyTempC >= THRESHOLDS.bodyTempWarningC || heatIndex > 0) {
    return { coolingLevel: "medium", fanSpeedPercent: 65 + Math.min(20, Math.round(heatIndex * 10)), peltierOn: true };
  }
  return { coolingLevel: "low", fanSpeedPercent: 35, peltierOn: true };
}

function computeSafetyLevel(t) {
  const critical =
    t.bodyTempC >= THRESHOLDS.bodyTempCriticalC ||
    t.ambientTempC >= THRESHOLDS.ambientTempCriticalC ||
    t.peltierHotSideC >= THRESHOLDS.peltierHotSideCriticalC ||
    t.batteryPercent <= THRESHOLDS.batteryCriticalPercent ||
    t.batteryTempC >= THRESHOLDS.batteryTempCriticalC ||
    t.batteryCurrentA >= THRESHOLDS.overcurrentA ||
    t.sensorFault;
  if (critical) return "critical";
  const warning =
    t.bodyTempC >= THRESHOLDS.bodyTempWarningC ||
    t.ambientTempC >= THRESHOLDS.ambientTempWarningC ||
    t.peltierHotSideC >= THRESHOLDS.peltierHotSideWarningC ||
    t.batteryPercent <= THRESHOLDS.batteryLowPercent;
  return warning ? "warning" : "normal";
}

// Body temperature considered on its own, for the UI elements that are
// specifically about the wearer rather than the whole system.
function computeBodyLevel(bodyTempC) {
  if (bodyTempC >= THRESHOLDS.bodyTempCriticalC) return "critical";
  if (bodyTempC >= THRESHOLDS.bodyTempWarningC) return "warning";
  return "normal";
}

function comfortFromBodyTemp(bodyTempC) {
  if (bodyTempC >= THRESHOLDS.bodyTempCriticalC) return "critical";
  if (bodyTempC >= THRESHOLDS.bodyTempWarningC) return "hot";
  if (bodyTempC >= THRESHOLDS.bodyTempWarningC - 0.8) return "warm";
  return "comfortable";
}

const COMFORT_META = {
  comfortable: { label: "Comfortable", color: C.normal },
  warm: { label: "Warm", color: C.warning },
  hot: { label: "Hot", color: C.warning },
  critical: { label: "Critical", color: C.critical },
};

/* ---------------------------------------------------------------------- */
/* Simulation engine (ported from simulationService.ts)                    */
/* ---------------------------------------------------------------------- */
function createSimEngine() {
  const s = {
    t: 0,
    bodyTempC: 36.6,
    ambientTempC: 33,
    peltierColdSideC: 18,
    peltierHotSideC: 32,
    batteryPercent: 86,
    batteryVoltage: 11.8,
    fanSpeedPercent: 30,
    coolingLevel: "low",
    peltierOn: true,
    isCharging: false,
    sensorFault: false,
    mode: "auto",
    manualCoolingLevel: "medium",
    manualFanSpeed: 50,
    manualPeltierOn: true,
    autoCoolingEnabled: true,
  };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const drift = (value, target, rate, noise) =>
    value + (target - value) * rate + (Math.random() - 0.5) * noise;

  return {
    setMode(mode) { s.mode = mode; },
    setAutoCoolingEnabled(enabled) { s.autoCoolingEnabled = enabled; },
    setManualControls({ coolingLevel, fanSpeedPercent, peltierOn }) {
      if (coolingLevel !== undefined) s.manualCoolingLevel = coolingLevel;
      if (fanSpeedPercent !== undefined) s.manualFanSpeed = fanSpeedPercent;
      if (peltierOn !== undefined) s.manualPeltierOn = peltierOn;
    },
    injectScenario(scenario) {
      if (scenario === "heatSpike") { s.bodyTempC += 1.6; s.ambientTempC += 4; }
      if (scenario === "coolDown") { s.bodyTempC = 36.4; s.ambientTempC = 30; }
      if (scenario === "sensorFault") s.sensorFault = true;
      if (scenario === "lowBattery") s.batteryPercent = 6;
      if (scenario === "clear") s.sensorFault = false;
    },
    tick() {
      s.t += 1;
      const ambientTarget = 33 + Math.sin(s.t / 60) * 6;
      s.ambientTempC = clamp(drift(s.ambientTempC, ambientTarget, 0.04, 0.15), 24, 48);

      const auto = computeAutoDecision({
        bodyTempC: s.bodyTempC, ambientTempC: s.ambientTempC,
        peltierHotSideC: s.peltierHotSideC, sensorFault: s.sensorFault,
      });

      let targetLevel, targetFan, peltierOn;
      if (s.mode === "auto") {
        if (s.autoCoolingEnabled) {
          targetLevel = auto.coolingLevel; targetFan = auto.fanSpeedPercent; peltierOn = auto.peltierOn;
        } else {
          // "Automatic Cooling" off in Settings — AUTO monitors, never drives.
          targetLevel = "off"; targetFan = 0; peltierOn = false;
        }
      } else if (s.mode === "eco") {
        targetLevel = "low"; targetFan = 40; peltierOn = s.batteryPercent > 5;
      } else {
        targetLevel = s.manualCoolingLevel; targetFan = s.manualFanSpeed; peltierOn = s.manualPeltierOn;
      }

      // Safety interlocks applied to the RESULT of every mode, not just AUTO.
      // The hot-side cutoff used to live inside computeAutoDecision, so MANUAL
      // and ECO drove the Peltier with no thermal limit whatsoever — and a
      // Peltier at full duty with a stalled fan is a thermal runaway, not a
      // cooler. Mirrors the interlock in the ESP32 firmware.
      if (s.peltierHotSideC >= THRESHOLDS.peltierHotSideCriticalC) {
        peltierOn = false; targetFan = 100;
      } else if (s.peltierHotSideC >= THRESHOLDS.peltierHotSideWarningC) {
        targetLevel = "low"; targetFan = Math.max(targetFan, 80);
      }
      if (peltierOn) targetFan = Math.max(targetFan, MIN_FAN_WITH_PELTIER);
      if (!peltierOn) targetLevel = "off";

      s.coolingLevel = targetLevel;
      s.fanSpeedPercent = clamp(drift(s.fanSpeedPercent, targetFan, 0.3, 2), 0, 100);
      s.peltierOn = peltierOn;

      const coolingPower = !peltierOn ? 0 : { off: 0, low: 0.3, medium: 0.6, high: 1 }[s.coolingLevel];
      const bodyTarget = 36.4 + (s.ambientTempC - 30) * 0.06 - coolingPower * 0.9;
      s.bodyTempC = s.sensorFault ? s.bodyTempC : clamp(drift(s.bodyTempC, bodyTarget, 0.05, 0.06), 35.5, 40);

      const coldTarget = peltierOn ? 22 - coolingPower * 14 : s.ambientTempC - 2;
      const hotTarget = peltierOn ? s.ambientTempC + 8 + coolingPower * 22 : s.ambientTempC + 2;
      s.peltierColdSideC = clamp(drift(s.peltierColdSideC, coldTarget, 0.2, 0.3), 2, 30);
      s.peltierHotSideC = clamp(drift(s.peltierHotSideC, hotTarget, 0.15, 0.4), 25, 75);

      if (s.isCharging) {
        s.batteryPercent = clamp(s.batteryPercent + 0.08, 0, 100);
      } else {
        const drain = 0.02 + coolingPower * 0.045 + s.fanSpeedPercent * 0.0004;
        s.batteryPercent = clamp(s.batteryPercent - drain, 0, 100);
      }
      s.batteryVoltage = clamp(10.8 + (s.batteryPercent / 100) * 1.8 + (Math.random() - 0.5) * 0.05, 9.5, 12.6);
      const batteryCurrentA = clamp(0.4 + coolingPower * 2.2 + s.fanSpeedPercent * 0.01 + (Math.random() - 0.5) * 0.1, 0.1, 8);
      const batteryTempC = clamp(28 + coolingPower * 10 + (Math.random() - 0.5) * 1, 20, 60);

      let safetyStatus = "normal";
      if (s.sensorFault || s.bodyTempC >= 38.5 || s.peltierHotSideC >= 65 || s.batteryPercent <= 8) safetyStatus = "critical";
      else if (s.bodyTempC >= 37.5 || s.peltierHotSideC >= 55 || s.batteryPercent <= 20) safetyStatus = "warning";

      return {
        timestamp: Date.now(),
        bodyTempC: +s.bodyTempC.toFixed(2),
        ambientTempC: +s.ambientTempC.toFixed(1),
        peltierColdSideC: +s.peltierColdSideC.toFixed(1),
        peltierHotSideC: +s.peltierHotSideC.toFixed(1),
        batteryPercent: +s.batteryPercent.toFixed(1),
        batteryVoltage: +s.batteryVoltage.toFixed(2),
        batteryCurrentA: +batteryCurrentA.toFixed(2),
        batteryTempC: +batteryTempC.toFixed(1),
        isCharging: s.isCharging,
        fanSpeedPercent: Math.round(s.fanSpeedPercent),
        coolingLevel: s.coolingLevel,
        peltierOn: s.peltierOn,
        fanOn: s.fanSpeedPercent > 2,
        safetyStatus,
        sensorFault: s.sensorFault,
      };
    },
  };
}

/* ---------------------------------------------------------------------- */
/* Formatters                                                              */
/* ---------------------------------------------------------------------- */
const toUnit = (c, unit) => (unit === "F" ? c * 1.8 + 32 : c);
const fmtTemp = (c, unit, d = 1) => `${toUnit(c, unit).toFixed(d)}°${unit}`;
const fmtRuntime = (min) => {
  // Round to whole minutes FIRST. Flooring the hour and rounding the remainder
  // independently produced impossible strings like "1h 60m" at min = 119.6.
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60), m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
};

/**
 * Battery runtime, estimated from the drain actually observed in the history
 * buffer rather than a fixed 0.5 %/min guess (which was 2-6x optimistic under
 * real cooling load). Returns null until there is enough data to say anything
 * honest, so the UI can show "—" instead of a made-up number.
 */
function estRuntimeFromHistory(history) {
  const samples = history.filter((h) => typeof h.batteryPercent === "number");
  if (samples.length < 5) return null;
  const first = samples[0], last = samples[samples.length - 1];
  const minutes = (last.timestamp - first.timestamp) / 60000;
  const used = first.batteryPercent - last.batteryPercent;
  if (minutes < 0.5 || used <= 0) return null; // charging, flat, or too short to tell
  const drainPerMin = used / minutes;
  return Math.max(0, last.batteryPercent / drainPerMin);
}

/* ---------------------------------------------------------------------- */
/* Persistence                                                             */
/* ---------------------------------------------------------------------- */
// Installed as a PWA, this app gets relaunched constantly. Without this, every
// relaunch replayed the three onboarding slides and wiped the worker profile,
// the °C/°F choice and the entire alert history — which is the only record of
// a heat-safety event the app keeps.
const STORE_PREFIX = "justchill.";

function loadPersisted(key, fallback) {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    // Merge onto the fallback so a value saved by an older build that lacks a
    // newly-added field doesn't leave it undefined.
    if (fallback && typeof fallback === "object" && !Array.isArray(fallback)) {
      return { ...fallback, ...parsed };
    }
    return parsed;
  } catch {
    // Private mode, quota, or a corrupted value — defaults are fine.
    return fallback;
  }
}

function savePersisted(key, value) {
  try {
    localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage unavailable; the app works, it just won't remember.
  }
}

/** True on a narrow viewport, where the desktop phone-bezel mockup gets in the way. */
function useIsPhone() {
  const query = "(max-width: 520px)";
  const [phone, setPhone] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = (e) => setPhone(e.matches);
    mq.addEventListener("change", onChange);
    setPhone(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return phone;
}

/* ---------------------------------------------------------------------- */
/* Small primitives                                                        */
/* ---------------------------------------------------------------------- */
function Card({ children, glow, onClick, style, label }) {
  const base = {
    background: C.card,
    border: `1px solid ${glow === "critical" ? "rgba(255,59,92,0.4)" : C.cardBorder}`,
    borderRadius: 20,
    padding: 18,
    boxShadow: glow === "cyan" ? `0 0 26px rgba(0,229,255,0.22)` : glow === "critical" ? `0 0 26px rgba(255,59,92,0.22)` : "none",
    ...style,
  };
  if (!onClick) return <div style={{ ...base, cursor: "default" }}>{children}</div>;
  // A tappable card must be a real button, not a <div onClick>. As a div the
  // Battery, Temperature and Worker Profile screens had no keyboard or screen
  // reader route at all.
  return (
    <button type="button" onClick={onClick} aria-label={label} style={{
      ...base, cursor: "pointer", width: "100%", textAlign: "left",
      font: "inherit", color: "inherit", appearance: "none",
    }}>
      {children}
    </button>
  );
}

function Badge({ level, small }) {
  const { fg, bg } = statusColor(level);
  const label = { normal: "NORMAL", warning: "WARNING", critical: "CRITICAL", offline: "OFFLINE" }[level];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6, background: bg, color: fg,
      fontSize: small ? 10 : 11, fontWeight: 700, letterSpacing: 1, padding: small ? "3px 9px" : "5px 12px",
      borderRadius: 999, textTransform: "uppercase",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 3, background: fg }} />
      {label}
    </span>
  );
}

function Overline({ children, color }) {
  return <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", color: color || C.textSecondary }}>{children}</div>;
}

function MetricTile({ icon: Icon, label, value, sub, accent = C.cyan }) {
  return (
    <Card style={{ flex: 1, minWidth: 0 }}>
      <div style={{ width: 32, height: 32, borderRadius: 10, background: accent + "22", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 10 }}>
        <Icon size={17} color={accent} />
      </div>
      <Overline>{label}</Overline>
      <div style={{ fontSize: 20, fontWeight: 700, color: C.textPrimary, marginTop: 3 }}>{value}</div>
      {sub ? <div style={{ fontSize: 12, color: C.textTertiary, marginTop: 2 }}>{sub}</div> : null}
    </Card>
  );
}

function CircularGauge({ value, min, max, unit, status, size = 210 }) {
  const stroke = 15;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const progress = Math.min(1, Math.max(0, (value - min) / (max - min)));
  const { fg } = statusColor(status);
  const gid = "gauge-grad";
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size}>
        <defs>
          <linearGradient id={gid} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={C.cyan} />
            <stop offset="100%" stopColor={fg} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} stroke={C.cardElevated} strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={r} stroke={`url(#${gid})`} strokeWidth={stroke}
          strokeLinecap="round" fill="none" strokeDasharray={circ}
          strokeDashoffset={circ - progress * circ}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset 0.6s ease" }}
        />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ fontSize: 46, fontWeight: 300, color: C.textPrimary, letterSpacing: -1 }}>
          {value.toFixed(1)}<span style={{ fontSize: 20, color: C.textSecondary }}>°{unit}</span>
        </div>
      </div>
    </div>
  );
}

function BatteryIndicator({ percent, charging, large }) {
  const color = percent <= 15 ? C.critical : percent <= 30 ? C.warning : C.normal;
  const w = large ? 60 : 38, h = large ? 28 : 18;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <div style={{ position: "relative", width: w, height: h, border: `2px solid ${color}`, borderRadius: 6, padding: 3 }}>
        <div style={{ position: "absolute", right: -6, top: "30%", width: 4, height: h * 0.4, background: color, borderRadius: "0 3px 3px 0" }} />
        <div style={{ width: `${Math.max(2, percent)}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
      <div>
        <div style={{ fontWeight: 700, color: C.textPrimary, fontSize: 16 }}>{percent.toFixed(0)}%</div>
        {charging ? <div style={{ display: "flex", alignItems: "center", gap: 3, color: C.cyan, fontSize: 12 }}><Zap size={11} /> Charging</div> : null}
      </div>
    </div>
  );
}

// The button connects and disconnects the jacket — it does not switch cooling
// on and off. It used to be labelled "COOLING ACTIVE" purely from link state,
// which contradicted the COOLING STATUS card directly below it whenever the
// Peltier was idle. Link state drives the ring; cooling state drives the words.
function PowerButton({ connected, cooling, busy, onToggle }) {
  const handleClick = () => {
    (connected ? sounds.powerOff : sounds.powerOn)();
    onToggle();
  };
  const label = busy
    ? "CONNECTING…"
    : connected
      ? (cooling ? "CONNECTED · COOLING" : "CONNECTED · IDLE")
      : "TAP TO CONNECT";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <button
        onClick={handleClick}
        disabled={busy}
        aria-label={connected ? "Disconnect jacket" : "Connect jacket"}
        style={{
          width: 96, height: 96, borderRadius: 999, border: `2px solid ${connected ? C.cyan : C.cyanDim}`,
          background: connected ? C.cyan : C.cardElevated, display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", boxShadow: connected ? "0 0 30px rgba(0,229,255,0.55)" : "none", transition: "all 0.3s",
        }}
      >
        <Power size={36} color={connected ? C.textInverse : C.cyan} />
      </button>
      <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.5, color: connected ? (cooling ? C.normal : C.textSecondary) : C.textSecondary }}>
        {label}
      </div>
    </div>
  );
}

function ModeSelector({ value, onChange }) {
  const options = [
    { v: "auto", label: "AUTO", icon: Sparkles },
    { v: "manual", label: "MANUAL", icon: SlidersHorizontal },
    { v: "eco", label: "ECO", icon: Leaf },
  ];
  return (
    <div style={{ display: "flex", background: C.bgElevated, border: `1px solid ${C.cardBorder}`, borderRadius: 999, padding: 4, gap: 4 }}>
      {options.map((o) => {
        const active = o.v === value;
        const Icon = o.icon;
        return (
          <button
            key={o.v}
            onClick={() => { if (o.v !== value) sounds.select(); onChange(o.v); }}
            style={{
              flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              padding: "10px 0", borderRadius: 999, border: "none", cursor: "pointer",
              background: active ? C.cyan : "transparent", color: active ? C.textInverse : C.textSecondary,
              fontWeight: 700, fontSize: 13,
            }}
          >
            <Icon size={15} /> {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SliderControl({ label, value, min = 0, max = 100, unit = "%", disabled, onChange }) {
  const lastTickRef = useRef(0);
  const handleChange = (v) => {
    const now = Date.now();
    // Throttle to ~8 ticks/sec so dragging doesn't machine-gun the speaker
    if (now - lastTickRef.current > 120) {
      sounds.sliderTick();
      lastTickRef.current = now;
    }
    onChange(v);
  };
  return (
    <div style={{ marginBottom: 20, opacity: disabled ? 0.4 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>{label}</span>
        <span style={{ fontWeight: 700, color: C.cyan, fontSize: 14 }}>{Math.round(value)}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} value={value} disabled={disabled}
        aria-label={label}
        onChange={(e) => handleChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: C.cyan, height: 32 }}
      />
    </div>
  );
}

function Toggle({ checked, onChange, disabled, label }) {
  const handleClick = () => {
    if (disabled) return;
    (checked ? sounds.toggleOff : sounds.toggleOn)();
    onChange(!checked);
  };
  return (
    // role="switch" + aria-checked + aria-label, or TalkBack announces every
    // Settings row as an unlabeled "button" with no on/off state. The 44px
    // wrapper is the tap target; the 44x26 track inside stays the visual size.
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={handleClick}
      style={{
        minWidth: 44, minHeight: 44, border: "none", background: "none", padding: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.4 : 1,
      }}
    >
      <span style={{
        display: "block", width: 44, height: 26, borderRadius: 999,
        background: checked ? C.cyanDim : C.cardElevated, position: "relative", transition: "background 0.2s",
      }}>
        <span style={{
          position: "absolute", top: 3, left: checked ? 21 : 3, width: 20, height: 20, borderRadius: 999,
          background: checked ? C.cyan : C.textTertiary, transition: "left 0.2s",
        }} />
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------------- */
/* Settings list rows — module scope on purpose                            */
/* ---------------------------------------------------------------------- */
// These were declared inside SettingsScreen/ProfileScreen bodies, which gives
// them a fresh component identity on every render. React then unmounts and
// remounts the subtree instead of updating it — harmless for a static row, but
// fatal for <Field>, whose <input> lost focus on every keystroke and every 2s
// telemetry tick. Keep them out here.
function Row({ icon: Icon, label, value, onClick }) {
  const inner = (
    <>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: C.cyanDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon size={16} color={C.cyan} />
      </div>
      <span style={{ flex: 1, fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>{label}</span>
      {value && <span style={{ color: C.textTertiary, fontSize: 13 }}>{value}</span>}
      {onClick && <ChevronRight size={15} color={C.textTertiary} />}
    </>
  );
  const style = {
    display: "flex", alignItems: "center", gap: 12, width: "100%", minHeight: 48,
    padding: "13px 0", borderBottom: `1px solid ${C.divider}`, textAlign: "left",
  };
  if (!onClick) return <div style={style}>{inner}</div>;
  return (
    <button type="button" onClick={onClick} style={{ ...style, background: "none", border: "none", borderBottom: `1px solid ${C.divider}`, font: "inherit", cursor: "pointer" }}>
      {inner}
    </button>
  );
}

function ToggleRow({ icon, label, desc, checked, onChange }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: `1px solid ${C.divider}` }}>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: C.cyanDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {React.createElement(icon, { size: 16, color: C.cyan })}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: C.textTertiary, marginTop: 1 }}>{desc}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  );
}

function Field({ label, value, onChange, placeholder, type = "text" }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, color: C.textTertiary, marginBottom: 6 }}>{label}</div>
      <input
        value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type={type}
        aria-label={label}
        style={{
          width: "100%", background: "transparent", border: "none", borderBottom: `1px solid ${C.divider}`,
          color: C.textPrimary, fontSize: 15, paddingBottom: 8, outline: "none", boxSizing: "border-box",
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Screens                                                                  */
/* ---------------------------------------------------------------------- */
function DashboardScreen({ telemetry, connected, mode, unit, profile, togglePower, connecting, goto, runtimeMin }) {
  // The BODY TEMPERATURE card must report body temperature. It previously used
  // computeSafetyLevel, which also goes critical on low battery, hot Peltier or
  // overcurrent — so a flat battery painted a perfectly normal 36.6°C red.
  const bodyStatus = telemetry ? computeBodyLevel(telemetry.bodyTempC) : "offline";
  const systemStatus = telemetry ? computeSafetyLevel(telemetry) : "offline";
  const comfort = telemetry ? comfortFromBodyTemp(telemetry.bodyTempC) : "comfortable";
  const cm = COMFORT_META[comfort];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <Overline color={C.cyan}>JUST CHILL</Overline>
          <div style={{ fontSize: 26, fontWeight: 700, color: C.textPrimary, marginTop: 2 }}>
            {profile.name ? `Hi, ${profile.name.split(" ")[0]}` : "Dashboard"}
          </div>
        </div>
        <button onClick={() => { sounds.click(); goto("connection"); }} style={{
          display: "flex", alignItems: "center", gap: 6, background: C.card, border: `1px solid ${C.cardBorder}`,
          borderRadius: 999, padding: "8px 14px", cursor: "pointer", color: connected ? C.normal : C.textTertiary, fontSize: 12,
        }}>
          <Bluetooth size={13} /> {connected ? "Connected" : "Offline"}
        </button>
      </div>

      {!connected ? (
        <Card style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Bluetooth size={17} color={C.textTertiary} />
          <span style={{ color: C.textSecondary, fontSize: 14 }}>No jacket connected. Showing placeholders — connect or start Simulation Mode.</span>
        </Card>
      ) : null}

      <Card glow={systemStatus === "critical" ? "critical" : "cyan"} label="Body temperature details" onClick={() => { sounds.click(); goto("temperature"); }} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ display: "flex", justifyContent: "space-between", width: "100%", marginBottom: 14 }}>
          <Overline>BODY TEMPERATURE</Overline>
          <Badge level={bodyStatus} small />
        </div>
        <CircularGauge
          value={toUnit(telemetry?.bodyTempC ?? 36.5, unit)}
          min={toUnit(34, unit)} max={toUnit(40, unit)} unit={unit} status={bodyStatus}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, background: cm.color }} />
          <span style={{ fontWeight: 700, color: cm.color, fontSize: 14 }}>{cm.label}</span>
        </div>
      </Card>

      <div style={{ display: "flex", gap: 12 }}>
        <MetricTile icon={Sun} label="AMBIENT TEMP" value={fmtTemp(telemetry?.ambientTempC ?? 38, unit)} accent={C.blue} />
        <MetricTile icon={Snowflake} label="COOLING" value={telemetry ? (telemetry.peltierOn ? telemetry.coolingLevel.toUpperCase() : "OFF") : "—"} sub={mode.toUpperCase() + " MODE"} />
      </div>

      <Card>
        <Overline>COOLING STATUS</Overline>
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Thermometer size={16} color={telemetry?.peltierOn ? C.cyan : C.textTertiary} />
            <span style={{ flex: 1, color: C.textSecondary, fontSize: 14 }}>Peltier</span>
            <span style={{ fontWeight: 700, color: telemetry?.peltierOn ? C.normal : C.textTertiary, fontSize: 14 }}>{telemetry?.peltierOn ? "ON" : "OFF"}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Fan size={16} color={telemetry?.fanOn ? C.cyan : C.textTertiary} />
            <span style={{ flex: 1, color: C.textSecondary, fontSize: 14 }}>Fan</span>
            <span style={{ fontWeight: 700, color: telemetry?.fanOn ? C.normal : C.textTertiary, fontSize: 14 }}>{telemetry?.fanOn ? `ON · ${telemetry.fanSpeedPercent}%` : "OFF"}</span>
          </div>
        </div>
      </Card>

      <Card label="Battery details" onClick={() => { sounds.click(); goto("battery"); }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <Overline>BATTERY</Overline>
          <span style={{ fontSize: 12, color: C.textTertiary }}>{runtimeMin != null ? fmtRuntime(runtimeMin) + " remaining" : "—"}</span>
        </div>
        <BatteryIndicator percent={telemetry?.batteryPercent ?? 0} charging={telemetry?.isCharging} />
        {telemetry ? <div style={{ fontSize: 12, color: C.textTertiary, marginTop: 8 }}>{telemetry.batteryVoltage.toFixed(2)} V</div> : null}
      </Card>

      <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 8px" }}>
        <PowerButton connected={connected} cooling={!!telemetry?.peltierOn} busy={connecting} onToggle={togglePower} />
      </div>
    </div>
  );
}

function ControlScreen({ mode, setMode, manual, setManual, targetTempC, setTargetTempC, unit, telemetry }) {
  const isManual = mode === "manual";
  const intensityMap = { off: 0, low: 33, medium: 66, high: 100 };
  const intensity = intensityMap[manual.coolingLevel];
  const setIntensity = (v) => {
    const level = v < 10 ? "off" : v < 45 ? "low" : v < 80 ? "medium" : "high";
    setManual((m) => ({ ...m, coolingLevel: level }));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.textPrimary }}>Control</div>
        <div style={{ color: C.textSecondary, fontSize: 14, marginTop: 2 }}>Choose how the jacket cools you</div>
      </div>

      <ModeSelector value={mode} onChange={setMode} />

      {mode === "auto" && (
        <Card glow="cyan" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Sparkles size={20} color={C.cyan} />
          <span style={{ color: C.textSecondary, fontSize: 14 }}>Peltier cooling and fan speed adjust automatically from body and ambient readings.</span>
        </Card>
      )}
      {mode === "eco" && (
        <Card style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <Leaf size={20} color={C.normal} />
          <span style={{ color: C.textSecondary, fontSize: 14 }}>Cooling output is capped to extend battery life.</span>
        </Card>
      )}

      <Card>
        <Overline>MANUAL CONTROLS</Overline>
        <div style={{ marginTop: 16 }}>
          <SliderControl label="Cooling Intensity" value={intensity} disabled={!isManual} onChange={setIntensity} />
          <SliderControl label="Fan Speed" value={manual.fanSpeedPercent} disabled={!isManual} onChange={(v) => setManual((m) => ({ ...m, fanSpeedPercent: v }))} />
          <SliderControl
            label="Target Temperature" value={toUnit(targetTempC, unit)}
            min={toUnit(16, unit)} max={toUnit(28, unit)} unit={`°${unit}`} disabled={!isManual}
            onChange={(v) => setTargetTempC(unit === "F" ? (v - 32) / 1.8 : v)}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
            <span style={{ fontWeight: 700, color: isManual ? C.textPrimary : C.textTertiary, fontSize: 14 }}>Peltier</span>
            <Toggle label="Peltier" checked={manual.peltierOn} disabled={!isManual} onChange={(v) => setManual((m) => ({ ...m, peltierOn: v }))} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
            <span style={{ fontWeight: 700, color: isManual ? C.textPrimary : C.textTertiary, fontSize: 14 }}>Fan</span>
            <Toggle label="Fan" checked={manual.fanSpeedPercent > 0} disabled={!isManual} onChange={(v) => setManual((m) => ({ ...m, fanSpeedPercent: v ? 50 : 0 }))} />
          </div>
        </div>
      </Card>

      {telemetry && (
        <Card>
          <Overline>LIVE OUTPUT</Overline>
          <div style={{ display: "flex", marginTop: 12 }}>
            {[["Cooling", telemetry.coolingLevel.toUpperCase()], ["Fan", `${telemetry.fanSpeedPercent}%`], ["Cold Side", fmtTemp(telemetry.peltierColdSideC, unit)]].map(([l, v]) => (
              <div key={l} style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.cyan }}>{v}</div>
                <div style={{ fontSize: 11, color: C.textTertiary, marginTop: 2 }}>{l}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function TemperatureScreen({ telemetry, history, unit }) {
  const chartData = history.map((h) => ({
    time: new Date(h.timestamp).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
    body: +toUnit(h.bodyTempC, unit).toFixed(1),
    ambient: +toUnit(h.ambientTempC, unit).toFixed(1),
  }));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.textPrimary }}>Temperature</div>
        <div style={{ color: C.textSecondary, fontSize: 14, marginTop: 2 }}>Live sensor readings across the jacket</div>
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <MetricTile icon={User} label="BODY" value={fmtTemp(telemetry?.bodyTempC ?? 36.5, unit)} accent={C.cyan} />
        <MetricTile icon={Sun} label="AMBIENT" value={fmtTemp(telemetry?.ambientTempC ?? 38, unit)} accent={C.blue} />
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <MetricTile icon={Snowflake} label="COLD SIDE" value={fmtTemp(telemetry?.peltierColdSideC ?? 18, unit)} accent={C.cyanSoft} />
        <MetricTile icon={Flame} label="HOT SIDE" value={fmtTemp(telemetry?.peltierHotSideC ?? 32, unit)} accent={C.warning} />
      </div>
      <Card>
        <Overline>TEMPERATURE HISTORY</Overline>
        <div style={{ height: 200, marginTop: 12 }}>
          {chartData.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid stroke={C.divider} vertical={false} />
                <XAxis dataKey="time" stroke={C.textTertiary} fontSize={10} interval="preserveStartEnd" />
                <YAxis stroke={C.textTertiary} fontSize={10} domain={["auto", "auto"]} />
                <Tooltip contentStyle={{ background: C.cardElevated, border: `1px solid ${C.cardBorder}`, borderRadius: 8, fontSize: 12 }} labelStyle={{ color: C.textSecondary }} />
                <Line type="monotone" dataKey="body" stroke={C.cyan} strokeWidth={2.5} dot={false} name="Body Temp" />
                <Line type="monotone" dataKey="ambient" stroke={C.blue} strokeWidth={2} dot={false} name="Ambient Temp" />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: C.textTertiary, fontSize: 14 }}>Collecting live data…</div>
          )}
        </div>
      </Card>
      <Card>
        <div style={{ fontSize: 12, color: C.textTertiary, lineHeight: 1.6 }}>
          Readings are device sensor measurements only. JUST CHILL does not diagnose or predict heat-related illness — use readings alongside your organization's heat-safety protocol.
        </div>
      </Card>
    </div>
  );
}

function BatteryScreen({ telemetry, unit, runtimeMin }) {
  const percent = telemetry?.batteryPercent ?? 0;
  const warnings = [
    telemetry && percent <= THRESHOLDS.batteryLowPercent ? { label: "Low battery", level: percent <= THRESHOLDS.batteryCriticalPercent ? "critical" : "warning" } : null,
    telemetry && telemetry.batteryTempC >= THRESHOLDS.batteryTempCriticalC ? { label: "High battery temperature", level: "critical" } : null,
    telemetry && telemetry.batteryCurrentA >= THRESHOLDS.overcurrentA ? { label: "Overcurrent detected", level: "critical" } : null,
  ].filter(Boolean);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.textPrimary }}>Battery</div>
        <div style={{ color: C.textSecondary, fontSize: 14, marginTop: 2 }}>Power system status</div>
      </div>
      <Card style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <BatteryIndicator percent={percent} charging={telemetry?.isCharging} large />
        <div style={{ fontSize: 12, color: C.textTertiary, marginTop: 12 }}>
          {!telemetry ? "Awaiting connection"
            : runtimeMin != null ? `${fmtRuntime(runtimeMin)} remaining at current load`
              : "Measuring drain…"}
        </div>
      </Card>
      <div style={{ display: "flex", gap: 12 }}>
        <MetricTile icon={Zap} label="VOLTAGE" value={telemetry ? `${telemetry.batteryVoltage.toFixed(2)} V` : "—"} />
        <MetricTile icon={Gauge} label="CURRENT" value={telemetry ? `${telemetry.batteryCurrentA.toFixed(2)} A` : "—"} />
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <MetricTile icon={Thermometer} label="BATT. TEMP" value={telemetry ? fmtTemp(telemetry.batteryTempC, unit) : "—"} />
        <MetricTile icon={ShieldCheck} label="HEALTH" value={telemetry ? (telemetry.batteryTempC < 45 ? "Good" : "Fair") : "—"} accent={C.normal} />
      </div>
      <Card style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {telemetry?.isCharging ? <BatteryCharging size={19} color={C.cyan} /> : <Battery size={19} color={C.textSecondary} />}
        <span style={{ flex: 1, fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>Charging Status</span>
        <span style={{ color: telemetry?.isCharging ? C.cyan : C.textTertiary, fontSize: 14 }}>{telemetry?.isCharging ? "Charging" : "Not charging"}</span>
      </Card>
      <Overline>WARNINGS</Overline>
      {warnings.length === 0 ? (
        <Card style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <CheckCircle2 size={17} color={C.normal} />
          <span style={{ color: C.textSecondary, fontSize: 14 }}>No active battery warnings</span>
        </Card>
      ) : warnings.map((w) => (
        <Card key={w.label} glow={w.level === "critical" ? "critical" : undefined} style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <AlertTriangle size={17} color={w.level === "critical" ? C.critical : C.warning} />
          <span style={{ fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>{w.label}</span>
        </Card>
      ))}
    </div>
  );
}

/**
 * Everything on this screen is measured from the live history buffer.
 *
 * The previous version showed `avg + 1.1` as MAX TEMP, `avg - 0.6` as MIN TEMP
 * and a hardcoded 96/62/38/14 scaled by a DAY/WEEK/MONTH multiplier — numbers
 * that had never touched a sensor. The app only ever holds the current session
 * (a 120-sample ring buffer), so there is no week or month to report and the
 * range selector is gone rather than faked.
 */
function summarizeHistory(history) {
  if (history.length < 2) return null;
  const temps = history.map((h) => h.bodyTempC).filter((v) => typeof v === "number");
  if (!temps.length) return null;

  const spanMin = (history[history.length - 1].timestamp - history[0].timestamp) / 60000;
  let coolingMin = 0, energyWh = 0, cycles = 0;
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1], cur = history[i];
    const dtHours = Math.max(0, cur.timestamp - prev.timestamp) / 3600000;
    if (cur.peltierOn) coolingMin += dtHours * 60;
    if (cur.peltierOn && !prev.peltierOn) cycles += 1;
    if (typeof cur.batteryVoltage === "number" && typeof cur.batteryCurrentA === "number") {
      energyWh += cur.batteryVoltage * cur.batteryCurrentA * dtHours;
    }
  }
  if (history[0].peltierOn) cycles += 1; // already running when recording started

  const batteryStart = history.find((h) => typeof h.batteryPercent === "number");
  const batteryEndSample = [...history].reverse().find((h) => typeof h.batteryPercent === "number");
  const batteryUsed = batteryStart && batteryEndSample
    ? Math.max(0, batteryStart.batteryPercent - batteryEndSample.batteryPercent)
    : null;

  return {
    spanMin,
    avg: temps.reduce((s, v) => s + v, 0) / temps.length,
    max: Math.max(...temps),
    min: Math.min(...temps),
    coolingMin,
    energyWh,
    cycles,
    batteryUsed,
  };
}

function AnalyticsScreen({ history, unit }) {
  const summary = summarizeHistory(history);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.textPrimary }}>Analytics</div>
        <div style={{ color: C.textSecondary, fontSize: 14, marginTop: 2 }}>
          {summary ? `Measured over the last ${fmtRuntime(summary.spanMin)} of this session` : "Cooling performance for this session"}
        </div>
      </div>
      {!summary ? (
        <Card style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "36px 18px" }}>
          <BarChart3 size={34} color={C.textTertiary} />
          <div style={{ fontWeight: 700, color: C.textPrimary, fontSize: 16, marginTop: 12 }}>No data yet</div>
          <div style={{ color: C.textSecondary, fontSize: 13, textAlign: "center", marginTop: 4 }}>
            Connect a jacket or start Simulation Mode — readings appear here as they arrive.
          </div>
        </Card>
      ) : (
        <>
          <div style={{ display: "flex", gap: 12 }}>
            <MetricTile icon={Thermometer} label="AVG BODY TEMP" value={fmtTemp(summary.avg, unit)} />
            <MetricTile icon={Gauge} label="MAX BODY TEMP" value={fmtTemp(summary.max, unit)} accent={C.warning} />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <MetricTile icon={Wind} label="MIN BODY TEMP" value={fmtTemp(summary.min, unit)} accent={C.cyanSoft} />
            <MetricTile icon={Snowflake} label="COOLING TIME" value={fmtRuntime(summary.coolingMin)} />
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <MetricTile icon={Battery} label="BATTERY USED" value={summary.batteryUsed != null ? `${summary.batteryUsed.toFixed(1)}%` : "—"} />
            <MetricTile icon={Zap} label="ENERGY USED" value={summary.energyWh > 0 ? `${summary.energyWh.toFixed(2)} Wh` : "—"} accent={C.blue} />
          </div>
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <Overline>COOLING CYCLES</Overline>
              <span style={{ fontSize: 22, fontWeight: 700, color: C.textPrimary }}>{summary.cycles}</span>
            </div>
            <div style={{ fontSize: 12, color: C.textTertiary, marginTop: 4 }}>Times the Peltier element engaged during this session.</div>
          </Card>
        </>
      )}
    </div>
  );
}

function AlertsScreen({ alerts, ack, clear }) {
  const active = alerts.filter((a) => !a.acknowledged);
  const critical = active.filter((a) => a.level === "critical").length;
  const warning = active.filter((a) => a.level === "warning").length;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 700, color: C.textPrimary }}>Alerts</div>
          <div style={{ color: C.textSecondary, fontSize: 14, marginTop: 2 }}>Safety notifications</div>
        </div>
        {alerts.length > 0 && <button onClick={() => { sounds.click(); clear(); }} style={{ background: "none", border: "none", color: C.textTertiary, fontSize: 12, cursor: "pointer", minHeight: 44, padding: "0 4px" }}>CLEAR ALL</button>}
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ flex: 1, textAlign: "center", padding: "14px 0", borderRadius: 16, border: `1px solid ${C.critical}`, background: C.card }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.critical }}>{critical}</div>
          <div style={{ fontSize: 12, color: C.textSecondary }}>Critical</div>
        </div>
        <div style={{ flex: 1, textAlign: "center", padding: "14px 0", borderRadius: 16, border: `1px solid ${C.warning}`, background: C.card }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.warning }}>{warning}</div>
          <div style={{ fontSize: 12, color: C.textSecondary }}>Warning</div>
        </div>
      </div>
      {alerts.length === 0 ? (
        <Card style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "36px 18px" }}>
          <ShieldCheck size={38} color={C.normal} />
          <div style={{ fontWeight: 700, color: C.textPrimary, fontSize: 17, marginTop: 12 }}>All Clear</div>
          <div style={{ color: C.textSecondary, fontSize: 14, textAlign: "center", marginTop: 4 }}>No safety alerts right now.</div>
        </Card>
      ) : alerts.map((a) => {
        const { fg, bg } = statusColor(a.level);
        return (
          <Card key={a.id} glow={a.level === "critical" && !a.acknowledged ? "critical" : undefined} style={{ display: "flex", gap: 12, opacity: a.acknowledged ? 0.5 : 1 }}>
            <div style={{ width: 40, height: 40, borderRadius: 12, background: bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <AlertTriangle size={19} color={fg} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>{a.title}</span>
                <span style={{ fontSize: 11, color: C.textTertiary }}>{new Date(a.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <div style={{ color: C.textSecondary, fontSize: 13, marginTop: 3 }}>{a.message}</div>
              {!a.acknowledged && (
                <button onClick={() => { sounds.success(); ack(a.id); }} style={{ marginTop: 4, background: "none", border: "none", color: C.cyan, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: "12px 4px", minHeight: 44 }}>ACKNOWLEDGE</button>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function SettingsScreen({ settings, setSettings, deviceInfo, connected, simulationMode, goto, injectScenario, profile }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.textPrimary }}>Settings</div>
        <div style={{ color: C.textSecondary, fontSize: 14, marginTop: 2 }}>Preferences and device</div>
      </div>

      <Overline color={C.textTertiary}>WORKER</Overline>
      <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
        <Row icon={User} label="Worker Profile" value={profile.name || "Not set"} onClick={() => { sounds.click(); goto("profile"); }} />
      </Card>

      <Overline color={C.textTertiary}>UNITS AND COOLING</Overline>
      <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", padding: "13px 0", borderBottom: `1px solid ${C.divider}` }}>
          <span style={{ flex: 1, fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>Temperature Unit</span>
          <div style={{ display: "flex", background: C.bgElevated, borderRadius: 999, padding: 3 }}>
            {["C", "F"].map((u) => (
              <button key={u} onClick={() => { sounds.select(); setSettings((s) => ({ ...s, unit: u })); }} style={{
                padding: "6px 14px", borderRadius: 999, border: "none", cursor: "pointer",
                background: settings.unit === u ? C.cyan : "transparent", color: settings.unit === u ? C.textInverse : C.textSecondary, fontWeight: 700, fontSize: 13,
              }}>°{u}</button>
            ))}
          </div>
        </div>
        <ToggleRow icon={Sparkles} label="Automatic Cooling" desc="Let AUTO mode drive the Peltier by itself. Off = monitor only." checked={settings.autoCooling} onChange={(v) => setSettings((s) => ({ ...s, autoCooling: v }))} />
      </Card>

      <Overline color={C.textTertiary}>ALERTS</Overline>
      <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
        <ToggleRow icon={Bell} label="Safety Alerts" desc="Warnings for temperature and system faults" checked={settings.alertsEnabled} onChange={(v) => setSettings((s) => ({ ...s, alertsEnabled: v }))} />
        <ToggleRow icon={Battery} label="Battery Alerts" desc="Low battery and charging notifications" checked={settings.batteryAlerts} onChange={(v) => setSettings((s) => ({ ...s, batteryAlerts: v }))} />
      </Card>

      <Overline color={C.textTertiary}>CONNECTIVITY</Overline>
      <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
        <Row icon={Bluetooth} label="Bluetooth" value={connected ? "Connected" : "Disconnected"} onClick={() => { sounds.click(); goto("connection"); }} />
      </Card>

      {/* The "Dark Mode" switch used to live here. It wrote settings.darkMode,
          which nothing read — the C palette is a static dark theme. A switch
          that visibly moves and changes nothing is worse than no switch, so it
          is gone until there is a light theme to switch to. */}
      <Overline color={C.textTertiary}>APPEARANCE AND LANGUAGE</Overline>
      <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
        <ToggleRow
          icon={Volume2}
          label="Sound Effects"
          desc="Button taps, alerts, and confirmations"
          checked={settings.soundEnabled}
          onChange={(v) => { setSoundEnabled(v); setSettings((s) => ({ ...s, soundEnabled: v })); if (v) sounds.click(); }}
        />
        <Row icon={Globe} label="Language" value="English" />
      </Card>

      <Overline color={C.textTertiary}>DEVICE</Overline>
      <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
        <Row icon={Radio} label="Firmware Version" value={deviceInfo.firmwareVersion} />
        <Row icon={SettingsIcon} label="Hardware Revision" value={deviceInfo.hardwareRevision} />
        <Row icon={Bluetooth} label="Device Name" value={deviceInfo.name} />
      </Card>

      {connected && simulationMode && (
        <>
          <Overline color={C.textTertiary}>SIMULATION MODE — DEMO SCENARIOS</Overline>
          <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
            {[["Heat Spike", Flame, "heatSpike"], ["Cool Down", Snowflake, "coolDown"], ["Sensor Fault", AlertTriangle, "sensorFault"], ["Low Battery", Battery, "lowBattery"], ["Clear Faults", CheckCircle2, "clear"]].map(([label, Icon, key], i, arr) => (
              <button key={key} type="button" onClick={() => { sounds.click(); injectScenario(key); }} style={{
                display: "flex", alignItems: "center", gap: 12, width: "100%", minHeight: 48, padding: "13px 0",
                borderBottom: i < arr.length - 1 ? `1px solid ${C.divider}` : "none",
                background: "none", border: "none", font: "inherit", textAlign: "left", cursor: "pointer",
              }}>
                <div style={{ width: 30, height: 30, borderRadius: 9, background: C.cyanDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon size={15} color={C.cyan} />
                </div>
                <span style={{ flex: 1, fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>{label}</span>
                <Play size={13} color={C.textTertiary} />
              </button>
            ))}
          </Card>
        </>
      )}
      <div style={{ textAlign: "center", color: C.textTertiary, fontSize: 12, marginTop: 8, marginBottom: 8 }}>JUST CHILL v1.0.0</div>
    </div>
  );
}

function ProfileScreen({ profile, setProfile, goBack }) {
  const [local, setLocal] = useState(profile);
  const save = () => {
    sounds.success();
    // The number input yields a string; the rest of the app does arithmetic on
    // this value, so coerce here and fall back to the current value if the
    // field was cleared or filled with something that isn't a number.
    const parsed = Number(local.targetTempC);
    setProfile({
      ...local,
      targetTempC: Number.isFinite(parsed) ? Math.min(28, Math.max(16, parsed)) : profile.targetTempC,
    });
    goBack();
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={() => { sounds.click(); goBack(); }} aria-label="Back" style={{ background: "none", border: "none", cursor: "pointer", color: C.textSecondary, fontSize: 20, padding: 0, minWidth: 44, minHeight: 44 }}>‹</button>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.textPrimary }}>Worker Profile</div>
          <div style={{ color: C.textSecondary, fontSize: 13 }}>Only what's needed to personalize cooling</div>
        </div>
      </div>
      <Card>
        <Field label="Name" value={local.name} onChange={(v) => setLocal({ ...local, name: v })} placeholder="e.g. Alex Rivera" />
        <Field label="Worker ID" value={local.workerId} onChange={(v) => setLocal({ ...local, workerId: v })} placeholder="e.g. W-1042" />
        <Field label="Work Type" value={local.workType} onChange={(v) => setLocal({ ...local, workType: v })} placeholder="e.g. Welding, Warehouse" />
        <Field label="Preferred Target Temperature (°C)" value={local.targetTempC} onChange={(v) => setLocal({ ...local, targetTempC: v })} placeholder="22" type="number" />
        <Overline>COOLING PREFERENCE</Overline>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {["low", "medium", "high"].map((opt) => (
            <button key={opt} onClick={() => { sounds.select(); setLocal({ ...local, coolingPreference: opt }); }} style={{
              flex: 1, padding: "13px 0", borderRadius: 999, cursor: "pointer",
              background: local.coolingPreference === opt ? C.cyan : C.bgElevated,
              border: `1px solid ${local.coolingPreference === opt ? C.cyan : C.cardBorder}`,
              color: local.coolingPreference === opt ? C.textInverse : C.textSecondary, fontWeight: 700, fontSize: 12,
            }}>{opt.toUpperCase()}</button>
          ))}
        </div>
      </Card>
      <button onClick={save} style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: C.cyan, border: "none",
        borderRadius: 999, padding: "15px 0", color: C.textInverse, fontWeight: 700, fontSize: 14, cursor: "pointer",
      }}>
        <CheckCircle2 size={17} /> SAVE PROFILE
      </button>
    </div>
  );
}

function ConnectionScreen({ connected, connecting, deviceInfo, telemetry, startSim, startReal, disconnect, goBack, bleSupported, bleError }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={goBack} aria-label="Back" style={{ background: "none", border: "none", cursor: "pointer", color: C.textSecondary, fontSize: 20, padding: 0, minWidth: 44, minHeight: 44 }}>‹</button>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.textPrimary }}>Connection</div>
          <div style={{ color: C.textSecondary, fontSize: 13 }}>Pair with your JUST CHILL jacket</div>
        </div>
      </div>

      <Card glow={connected ? "cyan" : undefined} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <div style={{ width: 60, height: 60, borderRadius: 30, background: C.cyanDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <Bluetooth size={26} color={connected ? C.cyan : C.textTertiary} />
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.textPrimary, marginTop: 12 }}>{deviceInfo.name}</div>
        <div style={{ marginTop: 8 }}>
          <Badge level={connected ? "normal" : connecting ? "warning" : "offline"} small />
        </div>
        {connected && telemetry && (
          <div style={{ display: "flex", gap: 28, marginTop: 18 }}>
            {[["Signal", `${deviceInfo.signalStrengthDbm} dBm`], ["Battery", `${telemetry.batteryPercent.toFixed(0)}%`], ["Firmware", deviceInfo.firmwareVersion]].map(([l, v]) => (
              <div key={l} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.textPrimary }}>{v}</div>
                <div style={{ fontSize: 11, color: C.textTertiary }}>{l}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {!connected ? (
        <>
          {!bleSupported && (
            <Card style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AlertTriangle size={17} color={C.warning} />
              <span style={{ color: C.textSecondary, fontSize: 13 }}>
                This browser doesn't support Web Bluetooth. Open this site in Chrome or Edge on Android to connect a real jacket.
              </span>
            </Card>
          )}

          <button
            onClick={() => { sounds.click(); startReal(); }}
            disabled={connecting || !bleSupported}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
              background: bleSupported ? C.cyan : C.cardElevated, border: "none",
              borderRadius: 999, padding: "15px 0", color: bleSupported ? C.textInverse : C.textTertiary,
              fontWeight: 700, fontSize: 14, cursor: bleSupported ? "pointer" : "default",
            }}
          >
            <Bluetooth size={16} /> {connecting ? "CONNECTING…" : "CONNECT VIA BLUETOOTH"}
          </button>

          {bleError && (
            <Card glow="critical" style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AlertTriangle size={17} color={C.critical} />
              <span style={{ color: C.textSecondary, fontSize: 13 }}>{bleError}</span>
            </Card>
          )}

          <Card style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: C.cyanDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Play size={16} color={C.cyan} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>No hardware yet?</div>
              <div style={{ fontSize: 12, color: C.textTertiary }}>Try Simulation Mode with realistic live sensor data.</div>
            </div>
            <button
              onClick={() => { sounds.click(); startSim(); }}
              disabled={connecting}
              style={{ background: "transparent", border: `1px solid ${C.cyan}`, borderRadius: 999, padding: "12px 14px", minHeight: 44, color: C.cyan, fontWeight: 700, fontSize: 12, cursor: connecting ? "default" : "pointer", opacity: connecting ? 0.5 : 1 }}
            >START DEMO</button>
          </Card>
        </>
      ) : (
        <button onClick={() => { sounds.disconnect(); disconnect(); }} style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "transparent",
          border: `1px solid ${C.critical}`, borderRadius: 999, padding: "15px 0", color: C.critical, fontWeight: 700, fontSize: 14, cursor: "pointer",
        }}>
          <X size={16} /> DISCONNECT
        </button>
      )}

      <Card>
        <div style={{ fontSize: 12, color: C.textTertiary, lineHeight: 1.6 }}>
          JUST CHILL is built for an ESP32-based jacket controller over Bluetooth Low Energy. When no jacket is connected, the app runs Simulation Mode with realistic sensor data so you can preview the full experience.
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Onboarding                                                               */
/* ---------------------------------------------------------------------- */
const SLIDES = [
  { icon: Snowflake, title: "JUST CHILL", subtitle: "Stay Cool. Stay Safe. Stay Productive.", body: "Smart hybrid Peltier cooling for people working in hot environments." },
  { icon: Bluetooth, title: "Connect Your Jacket", subtitle: "One tap, always in sync", body: "Pair with your JUST CHILL jacket over Bluetooth to see live body temperature, cooling, and battery status." },
  { icon: ShieldCheck, title: "Built-In Safety", subtitle: "Alerts before it matters", body: "Configurable thresholds trigger early warnings and automatically ease cooling load if anything runs unsafe." },
];
function Onboarding({ onDone }) {
  const [i, setI] = useState(0);
  const isLast = i === SLIDES.length - 1;
  const S = SLIDES[i];
  const Icon = S.icon;
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", justifyContent: "space-between", padding: "60px 28px 32px" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, textAlign: "center" }}>
        <div style={{
          width: 110, height: 110, borderRadius: 55, background: C.cyanDim, border: `1px solid ${C.cardBorder}`,
          display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 32, boxShadow: "0 0 40px rgba(0,229,255,0.3)",
        }}>
          <Icon size={48} color={C.cyan} />
        </div>
        <div style={{ fontSize: 34, fontWeight: 700, color: C.textPrimary, letterSpacing: -0.5 }}>{S.title}</div>
        <div style={{ fontSize: 16, fontWeight: 600, color: C.cyan, marginTop: 10 }}>{S.subtitle}</div>
        <div style={{ fontSize: 14, color: C.textSecondary, marginTop: 10, lineHeight: 1.6, maxWidth: 280 }}>{S.body}</div>
      </div>
      <div>
        <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 24 }}>
          {SLIDES.map((_, idx) => (
            <div key={idx} style={{ width: idx === i ? 22 : 8, height: 8, borderRadius: 4, background: idx === i ? C.cyan : C.cardElevated, transition: "width 0.2s" }} />
          ))}
        </div>
        <button onClick={() => { sounds.click(); isLast ? onDone() : setI(i + 1); }} style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: C.cyan,
          border: "none", borderRadius: 999, padding: "16px 0", color: C.textInverse, fontWeight: 700, fontSize: 14, cursor: "pointer",
        }}>
          {isLast ? "GET STARTED" : "NEXT"} →
        </button>
        {!isLast && <button onClick={onDone} style={{ width: "100%", background: "none", border: "none", color: C.textTertiary, marginTop: 14, cursor: "pointer", fontSize: 13 }}>Skip</button>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Root app                                                                 */
/* ---------------------------------------------------------------------- */
const TABS = [
  { key: "dashboard", label: "Dashboard", icon: Gauge },
  { key: "control", label: "Control", icon: SlidersHorizontal },
  { key: "analytics", label: "Analytics", icon: BarChart3 },
  { key: "alerts", label: "Alerts", icon: Bell },
  { key: "settings", label: "Settings", icon: SettingsIcon },
];

let alertSeq = 0;
const ALERT_COPY = {
  HIGH_BODY_TEMPERATURE: ["High Body Temperature", "Body temperature reading is elevated. Cooling has been increased."],
  HIGH_AMBIENT_TEMPERATURE: ["High Ambient Temperature", "Surrounding temperature is high. Consider a shaded rest break."],
  LOW_BATTERY: ["Low Battery", "Jacket battery is running low. Recharge soon."],
  PELTIER_OVERHEATING: ["Peltier Overheating", "Peltier hot side is running hot — cooling output reduced automatically."],
  FAN_FAILURE: ["Fan Failure", "Fan is not responding as expected. Check for obstructions."],
  SENSOR_FAILURE: ["Sensor Failure", "A sensor reading looks invalid. System switched to a safe state."],
  JACKET_DISCONNECTED: ["Jacket Disconnected", "Bluetooth connection to the jacket was lost."],
  OVERCURRENT: ["Overcurrent Detected", "Battery current exceeds the safe limit."],
  HIGH_BATTERY_TEMPERATURE: ["High Battery Temperature", "Battery temperature is elevated. Cooling load has been reduced."],
};

export default function App() {
  const [onboarded, setOnboarded] = useState(() => loadPersisted("onboarded", false));
  const [screen, setScreen] = useState("main");
  const [tab, setTab] = useState("dashboard");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [simulationMode, setSimulationMode] = useState(false);
  const [telemetry, setTelemetry] = useState(null);
  const [history, setHistory] = useState([]);
  const [alerts, setAlerts] = useState(() => loadPersisted("alerts", []));
  const [mode, setMode] = useState(() => loadPersisted("mode", "auto"));
  const [manual, setManual] = useState(() => loadPersisted("manual", { coolingLevel: "medium", fanSpeedPercent: 50, peltierOn: true }));
  const [targetTempC, setTargetTempC] = useState(() => loadPersisted("targetTempC", 22));
  const [profile, setProfile] = useState(() => loadPersisted("profile", { name: "", workerId: "", workType: "General Labor", targetTempC: 22, coolingPreference: "medium" }));
  const [settings, setSettings] = useState(() => loadPersisted("settings", { unit: "C", autoCooling: true, alertsEnabled: true, batteryAlerts: true, soundEnabled: true }));

  const [bleError, setBleError] = useState(null);
  const [linkId, setLinkId] = useState(0); // bumped on every successful BLE connect
  const bleSupported = isWebBluetoothSupported();

  const engineRef = useRef(null);
  const timerRef = useRef(null);
  const startDelayRef = useRef(null);
  const jacketRef = useRef(null); // holds { sendCommand, disconnect } from a real BLE connection
  if (!engineRef.current) engineRef.current = createSimEngine();

  // ── Live mirrors of state, for code that outlives a single render ──────
  // The simulation ticker is a long-lived setInterval and evaluateTelemetry is
  // handed to the BLE service once at connect time. Both used to close over
  // `mode`, `manual` and `settings` from the render that created them, so every
  // Control-screen change and every alert toggle was ignored for the rest of
  // the session. Refs give them a live view without rebuilding the timer.
  const modeRef = useRef(mode);
  const manualRef = useRef(manual);
  const settingsRef = useRef(settings);
  const alertsRef = useRef(alerts);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { manualRef.current = manual; }, [manual]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { alertsRef.current = alerts; }, [alerts]);

  // ── Persistence ───────────────────────────────────────────────────────
  useEffect(() => { savePersisted("onboarded", onboarded); }, [onboarded]);
  useEffect(() => { savePersisted("profile", profile); }, [profile]);
  useEffect(() => { savePersisted("settings", settings); }, [settings]);
  useEffect(() => { savePersisted("targetTempC", targetTempC); }, [targetTempC]);
  useEffect(() => { savePersisted("mode", mode); }, [mode]);
  useEffect(() => { savePersisted("manual", manual); }, [manual]);
  useEffect(() => { savePersisted("alerts", alerts); }, [alerts]);

  // Sound preference is module state in soundService, so restore it on load.
  useEffect(() => { setSoundEnabled(settings.soundEnabled !== false); }, [settings.soundEnabled]);

  const pushAlert = useCallback((type, level) => {
    // Dedupe on type AND level. Keying on type alone meant a WARNING already on
    // screen swallowed the CRITICAL that followed it: body temp crossing 37.5
    // raised a yellow alert, and crossing 38.5 was discarded as a duplicate, so
    // the emergency stayed yellow and the critical tone never played.
    const existing = alertsRef.current.find((a) => a.type === type && !a.acknowledged);
    if (existing && (existing.level === level || (existing.level === "critical" && level === "warning"))) return;

    const [title, message] = ALERT_COPY[type];
    alertSeq += 1;
    const alert = { id: `a-${Date.now()}-${alertSeq}`, type, level, title, message, timestamp: Date.now(), acknowledged: false };
    // Keep alertsRef in step immediately — several pushAlert calls can happen
    // within one telemetry tick, before React has re-rendered.
    alertsRef.current = [alert, ...alertsRef.current.filter((a) => a.id !== existing?.id)].slice(0, 50);
    setAlerts(alertsRef.current);
    (level === "critical" ? sounds.alertCritical : sounds.alertWarning)();
  }, []);

  // Runs the same safety-alert checks whether telemetry came from the
  // simulator or a real jacket, so alert behavior is identical either way.
  const evaluateTelemetry = useCallback((t) => {
    setTelemetry(t);
    setHistory((h) => [...h, {
      // Stamp arrival time here. The firmware sends millis()-since-boot, which
      // rendered as a 1970 wall-clock time on the temperature chart's axis.
      timestamp: Date.now(),
      bodyTempC: t.bodyTempC,
      ambientTempC: t.ambientTempC,
      batteryPercent: t.batteryPercent,
      batteryVoltage: t.batteryVoltage,
      batteryCurrentA: t.batteryCurrentA,
      peltierOn: !!t.peltierOn,
    }].slice(-120));

    const cfg = settingsRef.current;
    if (!cfg.alertsEnabled) return;
    if (t.bodyTempC >= THRESHOLDS.bodyTempCriticalC) pushAlert("HIGH_BODY_TEMPERATURE", "critical");
    else if (t.bodyTempC >= THRESHOLDS.bodyTempWarningC) pushAlert("HIGH_BODY_TEMPERATURE", "warning");
    if (t.ambientTempC >= THRESHOLDS.ambientTempCriticalC) pushAlert("HIGH_AMBIENT_TEMPERATURE", "critical");
    else if (t.ambientTempC >= THRESHOLDS.ambientTempWarningC) pushAlert("HIGH_AMBIENT_TEMPERATURE", "warning");
    if (t.peltierHotSideC >= THRESHOLDS.peltierHotSideCriticalC) pushAlert("PELTIER_OVERHEATING", "critical");
    else if (t.peltierHotSideC >= THRESHOLDS.peltierHotSideWarningC) pushAlert("PELTIER_OVERHEATING", "warning");
    if (cfg.batteryAlerts) {
      if (t.batteryPercent <= THRESHOLDS.batteryCriticalPercent) pushAlert("LOW_BATTERY", "critical");
      else if (t.batteryPercent <= THRESHOLDS.batteryLowPercent) pushAlert("LOW_BATTERY", "warning");
      if (t.batteryTempC >= THRESHOLDS.batteryTempCriticalC) pushAlert("HIGH_BATTERY_TEMPERATURE", "critical");
      if (t.batteryCurrentA >= THRESHOLDS.overcurrentA) pushAlert("OVERCURRENT", "critical");
    }
    if (t.sensorFault) pushAlert("SENSOR_FAILURE", "critical");
    // Only a fan that was ASKED to spin and isn't spinning is a fan failure.
    // Comparing against t.coolingLevel alone fired this every time the user
    // deliberately turned the fan off with its own toggle.
    const commandedFan = modeRef.current === "manual" ? manualRef.current.fanSpeedPercent : t.fanSpeedPercent;
    if (commandedFan > 2 && !t.fanOn) pushAlert("FAN_FAILURE", "warning");
  }, [pushAlert]);

  const startSim = useCallback(() => {
    // Guard re-entry: double-tapping START DEMO used to leave the first
    // interval running untracked, so it kept ticking after DISCONNECT.
    if (timerRef.current || startDelayRef.current) return;
    setConnecting(true);
    startDelayRef.current = setTimeout(() => {
      startDelayRef.current = null;
      setConnected(true); setConnecting(false); setSimulationMode(true);
      timerRef.current = setInterval(() => {
        const engine = engineRef.current;
        engine.setMode(modeRef.current);
        engine.setManualControls(manualRef.current);
        engine.setAutoCoolingEnabled(settingsRef.current.autoCooling !== false);
        evaluateTelemetry(engine.tick());
      }, 2000);
    }, 700);
  }, [evaluateTelemetry]);

  const stopSim = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (startDelayRef.current) { clearTimeout(startDelayRef.current); startDelayRef.current = null; }
    setConnected(false); setSimulationMode(false); setTelemetry(null); setConnecting(false);
  }, []);

  // Real hardware connection over Web Bluetooth. Requires Chrome/Edge on
  // Android or desktop, and must be triggered by a user tap (browser rule).
  const startReal = useCallback(async () => {
    setBleError(null);
    setConnecting(true);
    try {
      const jacket = await connectToJacket({
        onTelemetry: evaluateTelemetry,
        onDisconnect: () => {
          jacketRef.current = null;
          setConnected(false);
          setSimulationMode(false);
          setTelemetry(null);
          pushAlert("JACKET_DISCONNECTED", "warning");
        },
      });
      jacketRef.current = jacket;
      setConnected(true);
      setSimulationMode(false);
      // Bump the link generation so the command effect fires on connect. It is
      // keyed on mode/manual/targetTempC, none of which change when a jacket
      // appears — so a jacket that connected after the user had already picked
      // MANUAL and dragged the sliders never received any of it.
      setLinkId((n) => n + 1);
      sounds.connect();
    } catch (err) {
      // User cancelling the device picker also lands here — not a real error.
      if (err && err.name !== "NotFoundError") {
        setBleError(err.message || "Couldn't connect to the jacket. Make sure it's powered on and nearby.");
      }
    } finally {
      setConnecting(false);
    }
  }, [evaluateTelemetry, pushAlert]);

  const disconnect = useCallback(() => {
    // "Jacket Disconnected — Bluetooth connection to the jacket was lost" is
    // false and alarming when the user simply ended a simulation session that
    // never involved Bluetooth. Only alert if a real jacket was attached.
    const hadJacket = !!jacketRef.current;
    if (hadJacket) {
      jacketRef.current.disconnect();
      jacketRef.current = null;
    }
    stopSim();
    if (hadJacket) pushAlert("JACKET_DISCONNECTED", "warning");
  }, [stopSim, pushAlert]);

  const togglePower = useCallback(() => {
    if (connected) { disconnect(); return; }
    // Prefer real hardware when available; falls back to the demo picker on the Connection screen otherwise.
    if (bleSupported) startReal(); else startSim();
  }, [connected, disconnect, bleSupported, startReal, startSim]);

  const ack = useCallback((id) => setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, acknowledged: true } : a))), []);
  const clear = useCallback(() => setAlerts([]), []);
  const injectScenario = useCallback((s) => engineRef.current.injectScenario(s), []);

  // Whenever mode / manual controls / target temp change — or a jacket
  // connects — forward the current settings as a command. (Simulation reads
  // these directly.) Debounced, because an <input type="range"> fires a change
  // event per pixel of drag and BLE rejects a write that starts while another
  // is still in flight ("GATT operation already in progress"), which used to
  // leave the jacket sitting on a stale mid-drag value.
  useEffect(() => {
    if (!jacketRef.current) return;
    const cooling = mode === "manual" ? manual.peltierOn : true;
    const command = {
      coolingOn: cooling,
      coolingLevel: mode === "manual" ? manual.coolingLevel : "auto",
      targetTempC: Math.round(targetTempC * 10) / 10,
      // Never ask for the Peltier without airflow — see MIN_FAN_WITH_PELTIER.
      // The firmware enforces this too; sending a consistent command keeps the
      // fan speed shown in the app equal to the fan speed actually applied.
      fanSpeedPercent: mode === "manual"
        ? (cooling ? Math.max(manual.fanSpeedPercent, MIN_FAN_WITH_PELTIER) : manual.fanSpeedPercent)
        : 0,
      mode,
      autoCooling: settings.autoCooling !== false,
    };
    const id = setTimeout(() => {
      const jacket = jacketRef.current;
      if (!jacket) return;
      jacket.sendCommand(command).catch((err) => console.warn("JUST CHILL: failed to send command", err));
    }, 250);
    return () => clearTimeout(id);
  }, [mode, manual, targetTempC, settings.autoCooling, linkId]);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (startDelayRef.current) clearTimeout(startDelayRef.current);
    if (jacketRef.current) jacketRef.current.disconnect();
  }, []);

  const deviceInfo = { name: "JUST CHILL JACKET", firmwareVersion: "1.2.0", hardwareRevision: "ESP32-A1", signalStrengthDbm: -55 };
  const activeAlerts = alerts.filter((a) => !a.acknowledged).length;
  const runtimeMin = estRuntimeFromHistory(history);
  const phone = useIsPhone();

  const goto = (s) => setScreen(s);

  let body;
  if (!onboarded) {
    body = <Onboarding onDone={() => setOnboarded(true)} />;
  } else if (screen === "connection") {
    body = <ConnectionScreen connected={connected} connecting={connecting} deviceInfo={deviceInfo} telemetry={telemetry} startSim={startSim} startReal={startReal} disconnect={disconnect} goBack={() => setScreen("main")} bleSupported={bleSupported} bleError={bleError} />;
  } else if (screen === "profile") {
    body = <ProfileScreen profile={profile} setProfile={setProfile} goBack={() => setScreen("main")} />;
  } else if (screen === "temperature") {
    body = (
      <div>
        <button onClick={() => { sounds.click(); setScreen("main"); }} style={{ background: "none", border: "none", color: C.textSecondary, fontSize: 16, cursor: "pointer", padding: "10px 4px", minHeight: 44, marginBottom: 4 }}>‹ Back</button>
        <TemperatureScreen telemetry={telemetry} history={history} unit={settings.unit} />
      </div>
    );
  } else if (screen === "battery") {
    body = (
      <div>
        <button onClick={() => { sounds.click(); setScreen("main"); }} style={{ background: "none", border: "none", color: C.textSecondary, fontSize: 16, cursor: "pointer", padding: "10px 4px", minHeight: 44, marginBottom: 4 }}>‹ Back</button>
        <BatteryScreen telemetry={telemetry} unit={settings.unit} runtimeMin={runtimeMin} />
      </div>
    );
  } else {
    body = (
      <>
        {tab === "dashboard" && <DashboardScreen telemetry={telemetry} connected={connected} mode={mode} unit={settings.unit} profile={profile} togglePower={togglePower} connecting={connecting} goto={goto} runtimeMin={runtimeMin} />}
        {tab === "control" && <ControlScreen mode={mode} setMode={setMode} manual={manual} setManual={setManual} targetTempC={targetTempC} setTargetTempC={setTargetTempC} unit={settings.unit} telemetry={telemetry} />}
        {tab === "analytics" && <AnalyticsScreen history={history} unit={settings.unit} />}
        {tab === "alerts" && <AlertsScreen alerts={alerts} ack={ack} clear={clear} />}
        {tab === "settings" && <SettingsScreen settings={settings} setSettings={setSettings} deviceInfo={deviceInfo} connected={connected} simulationMode={simulationMode} goto={goto} injectScenario={injectScenario} profile={profile} />}
      </>
    );
  }

  const showTabBar = onboarded && ["main"].includes(screen);

  // On a desktop the 400x844 bezel is a nice product mockup. On the phone this
  // app is actually for, it was a fixed-height frame inside a scrolling page:
  // 844px tall capped at 92vh, with its own nested scroller, so the bottom tab
  // bar sat below the fold and the whole page scrolled behind it. On a phone,
  // drop the mockup and fill the viewport with 100dvh, which tracks the URL bar.
  return (
    <div style={{
      width: "100%", minHeight: phone ? "100dvh" : "100vh", background: "#04070D", display: "flex",
      alignItems: "center", justifyContent: "center",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      padding: phone ? 0 : "24px 12px", boxSizing: "border-box",
    }}>
      <div style={{
        width: phone ? "100%" : 400, maxWidth: "100%",
        height: phone ? "100dvh" : 844, maxHeight: phone ? "none" : "92vh",
        background: C.bgBase,
        borderRadius: phone ? 0 : 40,
        border: phone ? "none" : "10px solid #0A0E17",
        boxShadow: phone ? "none" : "0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
        display: "flex", flexDirection: "column", overflow: "hidden", position: "relative",
      }}>
        <div style={{
          flex: 1, overflowY: "auto", WebkitOverflowScrolling: "touch",
          padding: onboarded ? "20px 18px" : 0,
          paddingTop: phone && onboarded ? "max(20px, env(safe-area-inset-top))" : undefined,
        }}>
          {body}
        </div>
        {showTabBar && (
          <div style={{
            display: "flex", borderTop: `1px solid ${C.divider}`, background: C.bgElevated,
            padding: "10px 6px 16px",
            paddingBottom: phone ? "max(16px, env(safe-area-inset-bottom))" : 16,
          }}>
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button
                  key={t.key}
                  onClick={() => { if (tab !== t.key) sounds.navigate(); setTab(t.key); }}
                  aria-label={t.key === "alerts" && activeAlerts > 0 ? `${t.label}, ${activeAlerts} unacknowledged` : t.label}
                  aria-current={active ? "page" : undefined}
                  style={{
                    flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: "none",
                    border: "none", cursor: "pointer", position: "relative", padding: "6px 0", minHeight: 44,
                  }}
                >
                  <Icon size={20} color={active ? C.cyan : C.textTertiary} />
                  <span style={{ fontSize: 10, fontWeight: 600, color: active ? C.cyan : C.textTertiary }}>{t.label}</span>
                  {t.key === "alerts" && activeAlerts > 0 && (
                    <span style={{ position: "absolute", top: -2, right: "28%", background: C.critical, color: "#fff", fontSize: 9, fontWeight: 700, borderRadius: 999, minWidth: 15, height: 15, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px" }}>{activeAlerts}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
