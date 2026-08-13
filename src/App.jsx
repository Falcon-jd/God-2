import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";
import {
  Bluetooth, Power, Snowflake, Sun, Battery, BatteryCharging, Flame, Fan,
  Sparkles, Leaf, SlidersHorizontal, ShieldCheck, AlertTriangle, ChevronRight,
  Search, X, CheckCircle2, Gauge, Zap, Thermometer, Wind, User, Globe,
  Moon, ChevronDown, Play, Radio, Settings as SettingsIcon, BarChart3, Bell,
} from "lucide-react";
import { connectToJacket, isWebBluetoothSupported } from "./services/bleService";

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
  textTertiary: "#5B688A",
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
  };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const drift = (value, target, rate, noise) =>
    value + (target - value) * rate + (Math.random() - 0.5) * noise;

  return {
    setMode(mode) { s.mode = mode; },
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
        targetLevel = auto.coolingLevel; targetFan = auto.fanSpeedPercent; peltierOn = auto.peltierOn;
      } else if (s.mode === "eco") {
        targetLevel = "low"; targetFan = 40; peltierOn = s.batteryPercent > 5;
      } else {
        targetLevel = s.manualCoolingLevel; targetFan = s.manualFanSpeed; peltierOn = s.manualPeltierOn;
      }
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
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m} min`;
};
const estRuntime = (pct, drainPerMin = 0.5) => Math.max(0, pct / drainPerMin);

/* ---------------------------------------------------------------------- */
/* Small primitives                                                        */
/* ---------------------------------------------------------------------- */
function Card({ children, glow, onClick, style }) {
  return (
    <div
      onClick={onClick}
      style={{
        background: C.card,
        border: `1px solid ${glow === "critical" ? "rgba(255,59,92,0.4)" : C.cardBorder}`,
        borderRadius: 20,
        padding: 18,
        boxShadow: glow === "cyan" ? `0 0 26px rgba(0,229,255,0.22)` : glow === "critical" ? `0 0 26px rgba(255,59,92,0.22)` : "none",
        cursor: onClick ? "pointer" : "default",
        ...style,
      }}
    >
      {children}
    </div>
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

function PowerButton({ isOn, busy, onToggle }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
      <button
        onClick={onToggle}
        disabled={busy}
        style={{
          width: 96, height: 96, borderRadius: 999, border: `2px solid ${isOn ? C.cyan : C.cyanDim}`,
          background: isOn ? C.cyan : C.cardElevated, display: "flex", alignItems: "center", justifyContent: "center",
          cursor: "pointer", boxShadow: isOn ? "0 0 30px rgba(0,229,255,0.55)" : "none", transition: "all 0.3s",
        }}
      >
        <Power size={36} color={isOn ? C.textInverse : C.cyan} />
      </button>
      <div style={{ fontWeight: 700, fontSize: 13, letterSpacing: 0.5, color: isOn ? C.normal : C.textSecondary }}>
        {busy ? "CONNECTING…" : isOn ? "COOLING ACTIVE" : "TAP TO START COOLING"}
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
            onClick={() => onChange(o.v)}
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
  return (
    <div style={{ marginBottom: 20, opacity: disabled ? 0.4 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>{label}</span>
        <span style={{ fontWeight: 700, color: C.cyan, fontSize: 14 }}>{Math.round(value)}{unit}</span>
      </div>
      <input
        type="range" min={min} max={max} value={value} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: C.cyan }}
      />
    </div>
  );
}

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      style={{
        width: 44, height: 26, borderRadius: 999, border: "none", cursor: disabled ? "default" : "pointer",
        background: checked ? C.cyanDim : C.cardElevated, position: "relative", opacity: disabled ? 0.4 : 1, transition: "background 0.2s",
      }}
    >
      <span style={{
        position: "absolute", top: 3, left: checked ? 21 : 3, width: 20, height: 20, borderRadius: 999,
        background: checked ? C.cyan : C.textTertiary, transition: "left 0.2s",
      }} />
    </button>
  );
}

/* ---------------------------------------------------------------------- */
/* Screens                                                                  */
/* ---------------------------------------------------------------------- */
function DashboardScreen({ telemetry, connected, mode, unit, profile, togglePower, connecting, goto }) {
  const bodyStatus = telemetry ? computeSafetyLevel(telemetry) : "offline";
  const comfort = telemetry ? comfortFromBodyTemp(telemetry.bodyTempC) : "comfortable";
  const cm = COMFORT_META[comfort];
  const runtime = telemetry ? estRuntime(telemetry.batteryPercent) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <Overline color={C.cyan}>JUST CHILL</Overline>
          <div style={{ fontSize: 26, fontWeight: 700, color: C.textPrimary, marginTop: 2 }}>
            {profile.name ? `Hi, ${profile.name.split(" ")[0]}` : "Dashboard"}
          </div>
        </div>
        <button onClick={() => goto("connection")} style={{
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

      <Card glow="cyan" onClick={() => goto("temperature")} style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
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

      <Card onClick={() => goto("battery")}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <Overline>BATTERY</Overline>
          <span style={{ fontSize: 12, color: C.textTertiary }}>{telemetry ? fmtRuntime(runtime) + " remaining" : "—"}</span>
        </div>
        <BatteryIndicator percent={telemetry?.batteryPercent ?? 0} charging={telemetry?.isCharging} />
        {telemetry ? <div style={{ fontSize: 12, color: C.textTertiary, marginTop: 8 }}>{telemetry.batteryVoltage.toFixed(2)} V</div> : null}
      </Card>

      <div style={{ display: "flex", justifyContent: "center", padding: "12px 0 8px" }}>
        <PowerButton isOn={connected} busy={connecting} onToggle={togglePower} />
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
            <Toggle checked={manual.peltierOn} disabled={!isManual} onChange={(v) => setManual((m) => ({ ...m, peltierOn: v }))} />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0" }}>
            <span style={{ fontWeight: 700, color: isManual ? C.textPrimary : C.textTertiary, fontSize: 14 }}>Fan</span>
            <Toggle checked={manual.fanSpeedPercent > 0} disabled={!isManual} onChange={(v) => setManual((m) => ({ ...m, fanSpeedPercent: v ? 50 : 0 }))} />
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

function BatteryScreen({ telemetry, unit }) {
  const percent = telemetry?.batteryPercent ?? 0;
  const runtime = telemetry ? estRuntime(percent) : 0;
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
        <div style={{ fontSize: 12, color: C.textTertiary, marginTop: 12 }}>{telemetry ? `${fmtRuntime(runtime)} remaining at current load` : "Awaiting connection"}</div>
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

const RANGE_MULT = { day: 1, week: 6.5, month: 27 };
function AnalyticsScreen({ history, unit }) {
  const [range, setRange] = useState("day");
  const avgBody = history.length ? history.reduce((s, h) => s + h.bodyTempC, 0) / history.length : 36.6;
  const m = RANGE_MULT[range];
  const summary = {
    avg: avgBody, max: avgBody + 1.1, min: avgBody - 0.6,
    coolingMin: Math.round(96 * m), battery: Math.min(100, Math.round(62)), energy: Math.round(38 * m), cycles: Math.round(14 * m),
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.textPrimary }}>Analytics</div>
        <div style={{ color: C.textSecondary, fontSize: 14, marginTop: 2 }}>Cooling performance over time</div>
      </div>
      <div style={{ display: "flex", background: C.bgElevated, border: `1px solid ${C.cardBorder}`, borderRadius: 999, padding: 4 }}>
        {["day", "week", "month"].map((r) => (
          <button key={r} onClick={() => setRange(r)} style={{
            flex: 1, padding: "10px 0", borderRadius: 999, border: "none", cursor: "pointer",
            background: range === r ? C.cyan : "transparent", color: range === r ? C.textInverse : C.textSecondary, fontWeight: 700, fontSize: 13,
          }}>{r.toUpperCase()}</button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <MetricTile icon={Thermometer} label="AVG BODY TEMP" value={fmtTemp(summary.avg, unit)} />
        <MetricTile icon={Gauge} label="MAX TEMP" value={fmtTemp(summary.max, unit)} accent={C.warning} />
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <MetricTile icon={Wind} label="MIN TEMP" value={fmtTemp(summary.min, unit)} accent={C.cyanSoft} />
        <MetricTile icon={Snowflake} label="COOLING TIME" value={fmtRuntime(summary.coolingMin)} />
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        <MetricTile icon={Battery} label="BATTERY USED" value={`${summary.battery}%`} />
        <MetricTile icon={Zap} label="ENERGY USED" value={`${summary.energy} Wh`} accent={C.blue} />
      </div>
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <Overline>COOLING CYCLES</Overline>
          <span style={{ fontSize: 22, fontWeight: 700, color: C.textPrimary }}>{summary.cycles}</span>
        </div>
        <div style={{ fontSize: 12, color: C.textTertiary, marginTop: 4 }}>Number of times the Peltier element engaged during this {range}.</div>
      </Card>
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
        {alerts.length > 0 && <button onClick={clear} style={{ background: "none", border: "none", color: C.textTertiary, fontSize: 12, cursor: "pointer" }}>CLEAR ALL</button>}
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
                <button onClick={() => ack(a.id)} style={{ marginTop: 8, background: "none", border: "none", color: C.cyan, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: 0 }}>ACKNOWLEDGE</button>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function SettingsScreen({ settings, setSettings, deviceInfo, connected, simulationMode, goto, injectScenario, profile, setProfile }) {
  const Row = ({ icon: Icon, label, value, onClick }) => (
    <div onClick={onClick} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 0", borderBottom: `1px solid ${C.divider}`, cursor: onClick ? "pointer" : "default" }}>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: C.cyanDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        <Icon size={16} color={C.cyan} />
      </div>
      <span style={{ flex: 1, fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>{label}</span>
      {value && <span style={{ color: C.textTertiary, fontSize: 13 }}>{value}</span>}
      {onClick && <ChevronRight size={15} color={C.textTertiary} />}
    </div>
  );
  const ToggleRow = ({ icon, label, desc, checked, onChange }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 0", borderBottom: `1px solid ${C.divider}` }}>
      <div style={{ width: 32, height: 32, borderRadius: 9, background: C.cyanDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
        {React.createElement(icon, { size: 16, color: C.cyan })}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>{label}</div>
        {desc && <div style={{ fontSize: 11, color: C.textTertiary, marginTop: 1 }}>{desc}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 26, fontWeight: 700, color: C.textPrimary }}>Settings</div>
        <div style={{ color: C.textSecondary, fontSize: 14, marginTop: 2 }}>Preferences and device</div>
      </div>

      <Overline color={C.textTertiary}>WORKER</Overline>
      <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
        <Row icon={User} label="Worker Profile" value={profile.name || "Not set"} onClick={() => goto("profile")} />
      </Card>

      <Overline color={C.textTertiary}>UNITS AND COOLING</Overline>
      <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
        <div style={{ display: "flex", alignItems: "center", padding: "13px 0", borderBottom: `1px solid ${C.divider}` }}>
          <span style={{ flex: 1, fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>Temperature Unit</span>
          <div style={{ display: "flex", background: C.bgElevated, borderRadius: 999, padding: 3 }}>
            {["C", "F"].map((u) => (
              <button key={u} onClick={() => setSettings((s) => ({ ...s, unit: u }))} style={{
                padding: "6px 14px", borderRadius: 999, border: "none", cursor: "pointer",
                background: settings.unit === u ? C.cyan : "transparent", color: settings.unit === u ? C.textInverse : C.textSecondary, fontWeight: 700, fontSize: 13,
              }}>°{u}</button>
            ))}
          </div>
        </div>
        <ToggleRow icon={Sparkles} label="Automatic Cooling" desc="Allow AUTO mode to run without confirmation" checked={settings.autoCooling} onChange={(v) => setSettings((s) => ({ ...s, autoCooling: v }))} />
      </Card>

      <Overline color={C.textTertiary}>ALERTS</Overline>
      <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
        <ToggleRow icon={Bell} label="Safety Alerts" desc="Warnings for temperature and system faults" checked={settings.alertsEnabled} onChange={(v) => setSettings((s) => ({ ...s, alertsEnabled: v }))} />
        <ToggleRow icon={Battery} label="Battery Alerts" desc="Low battery and charging notifications" checked={settings.batteryAlerts} onChange={(v) => setSettings((s) => ({ ...s, batteryAlerts: v }))} />
      </Card>

      <Overline color={C.textTertiary}>CONNECTIVITY</Overline>
      <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
        <Row icon={Bluetooth} label="Bluetooth" value={connected ? "Connected" : "Disconnected"} onClick={() => goto("connection")} />
      </Card>

      <Overline color={C.textTertiary}>APPEARANCE AND LANGUAGE</Overline>
      <Card style={{ padding: "0 18px", marginBottom: 16, marginTop: 8 }}>
        <ToggleRow icon={Moon} label="Dark Mode" checked={settings.darkMode} onChange={(v) => setSettings((s) => ({ ...s, darkMode: v }))} />
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
              <div key={key} onClick={() => injectScenario(key)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 0", borderBottom: i < arr.length - 1 ? `1px solid ${C.divider}` : "none", cursor: "pointer" }}>
                <div style={{ width: 30, height: 30, borderRadius: 9, background: C.cyanDim, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon size={15} color={C.cyan} />
                </div>
                <span style={{ flex: 1, fontWeight: 700, color: C.textPrimary, fontSize: 14 }}>{label}</span>
                <Play size={13} color={C.textTertiary} />
              </div>
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
  const Field = ({ label, value, onChange, placeholder, type = "text" }) => (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, color: C.textTertiary, marginBottom: 6 }}>{label}</div>
      <input
        value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} type={type}
        style={{
          width: "100%", background: "transparent", border: "none", borderBottom: `1px solid ${C.divider}`,
          color: C.textPrimary, fontSize: 15, paddingBottom: 8, outline: "none", boxSizing: "border-box",
        }}
      />
    </div>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <button onClick={goBack} style={{ background: "none", border: "none", cursor: "pointer", color: C.textSecondary, fontSize: 20, padding: 0 }}>‹</button>
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
            <button key={opt} onClick={() => setLocal({ ...local, coolingPreference: opt })} style={{
              flex: 1, padding: "10px 0", borderRadius: 999, cursor: "pointer",
              background: local.coolingPreference === opt ? C.cyan : C.bgElevated,
              border: `1px solid ${local.coolingPreference === opt ? C.cyan : C.cardBorder}`,
              color: local.coolingPreference === opt ? C.textInverse : C.textSecondary, fontWeight: 700, fontSize: 12,
            }}>{opt.toUpperCase()}</button>
          ))}
        </div>
      </Card>
      <button onClick={() => { setProfile(local); goBack(); }} style={{
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
        <button onClick={goBack} style={{ background: "none", border: "none", cursor: "pointer", color: C.textSecondary, fontSize: 20, padding: 0 }}>‹</button>
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
            onClick={startReal}
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
            <button onClick={startSim} style={{ background: "transparent", border: `1px solid ${C.cyan}`, borderRadius: 999, padding: "8px 14px", color: C.cyan, fontWeight: 700, fontSize: 12, cursor: "pointer" }}>START DEMO</button>
          </Card>
        </>
      ) : (
        <button onClick={disconnect} style={{
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
        <button onClick={() => (isLast ? onDone() : setI(i + 1))} style={{
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
  const [onboarded, setOnboarded] = useState(false);
  const [screen, setScreen] = useState("main");
  const [tab, setTab] = useState("dashboard");
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [simulationMode, setSimulationMode] = useState(false);
  const [telemetry, setTelemetry] = useState(null);
  const [history, setHistory] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [mode, setMode] = useState("auto");
  const [manual, setManual] = useState({ coolingLevel: "medium", fanSpeedPercent: 50, peltierOn: true });
  const [targetTempC, setTargetTempC] = useState(22);
  const [profile, setProfile] = useState({ name: "", workerId: "", workType: "General Labor", targetTempC: 22, coolingPreference: "medium" });
  const [settings, setSettings] = useState({ unit: "C", autoCooling: true, alertsEnabled: true, batteryAlerts: true, darkMode: true });

  const [bleError, setBleError] = useState(null);
  const bleSupported = isWebBluetoothSupported();

  const engineRef = useRef(null);
  const timerRef = useRef(null);
  const jacketRef = useRef(null); // holds { sendCommand, disconnect } from a real BLE connection
  if (!engineRef.current) engineRef.current = createSimEngine();

  const pushAlert = useCallback((type, level) => {
    setAlerts((prev) => {
      if (prev.some((a) => a.type === type && !a.acknowledged)) return prev;
      const [title, message] = ALERT_COPY[type];
      alertSeq += 1;
      const alert = { id: `a-${Date.now()}-${alertSeq}`, type, level, title, message, timestamp: Date.now(), acknowledged: false };
      return [alert, ...prev].slice(0, 50);
    });
  }, []);

  // Runs the same safety-alert checks whether telemetry came from the
  // simulator or a real jacket, so alert behavior is identical either way.
  const evaluateTelemetry = useCallback((t) => {
    setTelemetry(t);
    setHistory((h) => [...h, { timestamp: t.timestamp, bodyTempC: t.bodyTempC, ambientTempC: t.ambientTempC }].slice(-120));
    if (!settings.alertsEnabled) return;
    if (t.bodyTempC >= THRESHOLDS.bodyTempCriticalC) pushAlert("HIGH_BODY_TEMPERATURE", "critical");
    else if (t.bodyTempC >= THRESHOLDS.bodyTempWarningC) pushAlert("HIGH_BODY_TEMPERATURE", "warning");
    if (t.ambientTempC >= THRESHOLDS.ambientTempCriticalC) pushAlert("HIGH_AMBIENT_TEMPERATURE", "critical");
    else if (t.ambientTempC >= THRESHOLDS.ambientTempWarningC) pushAlert("HIGH_AMBIENT_TEMPERATURE", "warning");
    if (t.peltierHotSideC >= THRESHOLDS.peltierHotSideCriticalC) pushAlert("PELTIER_OVERHEATING", "critical");
    else if (t.peltierHotSideC >= THRESHOLDS.peltierHotSideWarningC) pushAlert("PELTIER_OVERHEATING", "warning");
    if (settings.batteryAlerts) {
      if (t.batteryPercent <= THRESHOLDS.batteryCriticalPercent) pushAlert("LOW_BATTERY", "critical");
      else if (t.batteryPercent <= THRESHOLDS.batteryLowPercent) pushAlert("LOW_BATTERY", "warning");
      if (t.batteryTempC >= THRESHOLDS.batteryTempCriticalC) pushAlert("HIGH_BATTERY_TEMPERATURE", "critical");
      if (t.batteryCurrentA >= THRESHOLDS.overcurrentA) pushAlert("OVERCURRENT", "critical");
    }
    if (t.sensorFault) pushAlert("SENSOR_FAILURE", "critical");
    if (!t.fanOn && t.coolingLevel !== "off") pushAlert("FAN_FAILURE", "warning");
  }, [settings, pushAlert]);

  const startSim = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setConnecting(true);
    setTimeout(() => {
      setConnected(true); setConnecting(false); setSimulationMode(true);
      timerRef.current = setInterval(() => {
        const engine = engineRef.current;
        engine.setMode(mode);
        engine.setManualControls(manual);
        const t = engine.tick();
        evaluateTelemetry(t);
      }, 2000);
    }, 700);
  }, [mode, manual, evaluateTelemetry]);

  const stopSim = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    setConnected(false); setSimulationMode(false); setTelemetry(null);
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
    if (jacketRef.current) {
      jacketRef.current.disconnect();
      jacketRef.current = null;
    }
    stopSim();
    pushAlert("JACKET_DISCONNECTED", "warning");
  }, [stopSim, pushAlert]);

  const togglePower = useCallback(() => {
    if (connected) { disconnect(); return; }
    // Prefer real hardware when available; falls back to the demo picker on the Connection screen otherwise.
    if (bleSupported) startReal(); else startSim();
  }, [connected, disconnect, bleSupported, startReal, startSim]);

  const ack = useCallback((id) => setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, acknowledged: true } : a))), []);
  const clear = useCallback(() => setAlerts([]), []);
  const injectScenario = useCallback((s) => engineRef.current.injectScenario(s), []);

  // Whenever mode / manual controls / target temp change, forward them to a
  // real connected jacket as a command. (Simulation reads these directly.)
  useEffect(() => {
    if (jacketRef.current) {
      jacketRef.current
        .sendCommand({
          coolingOn: mode === "manual" ? manual.peltierOn : true,
          coolingLevel: mode === "manual" ? manual.coolingLevel : "auto",
          targetTempC,
          fanSpeedPercent: mode === "manual" ? manual.fanSpeedPercent : 0,
          mode,
        })
        .catch((err) => console.warn("JUST CHILL: failed to send command", err));
    }
  }, [mode, manual, targetTempC]);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (jacketRef.current) jacketRef.current.disconnect();
  }, []);

  const deviceInfo = { name: "JUST CHILL JACKET", firmwareVersion: "1.2.0", hardwareRevision: "ESP32-A1", signalStrengthDbm: -55 };
  const activeAlerts = alerts.filter((a) => !a.acknowledged).length;

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
        <button onClick={() => setScreen("main")} style={{ background: "none", border: "none", color: C.textSecondary, fontSize: 20, cursor: "pointer", padding: 0, marginBottom: 8 }}>‹ Back</button>
        <TemperatureScreen telemetry={telemetry} history={history} unit={settings.unit} />
      </div>
    );
  } else if (screen === "battery") {
    body = (
      <div>
        <button onClick={() => setScreen("main")} style={{ background: "none", border: "none", color: C.textSecondary, fontSize: 20, cursor: "pointer", padding: 0, marginBottom: 8 }}>‹ Back</button>
        <BatteryScreen telemetry={telemetry} unit={settings.unit} />
      </div>
    );
  } else {
    body = (
      <>
        {tab === "dashboard" && <DashboardScreen telemetry={telemetry} connected={connected} mode={mode} unit={settings.unit} profile={profile} togglePower={togglePower} connecting={connecting} goto={goto} />}
        {tab === "control" && <ControlScreen mode={mode} setMode={setMode} manual={manual} setManual={setManual} targetTempC={targetTempC} setTargetTempC={setTargetTempC} unit={settings.unit} telemetry={telemetry} />}
        {tab === "analytics" && <AnalyticsScreen history={history} unit={settings.unit} />}
        {tab === "alerts" && <AlertsScreen alerts={alerts} ack={ack} clear={clear} />}
        {tab === "settings" && <SettingsScreen settings={settings} setSettings={setSettings} deviceInfo={deviceInfo} connected={connected} simulationMode={simulationMode} goto={goto} injectScenario={injectScenario} profile={profile} setProfile={setProfile} />}
      </>
    );
  }

  const showTabBar = onboarded && ["main"].includes(screen);

  return (
    <div style={{
      width: "100%", minHeight: "100vh", background: "#04070D", display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", padding: "24px 12px", boxSizing: "border-box",
    }}>
      <div style={{
        width: 400, maxWidth: "100%", height: 844, maxHeight: "92vh", background: C.bgBase, borderRadius: 40,
        border: "10px solid #0A0E17", boxShadow: "0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
        display: "flex", flexDirection: "column", overflow: "hidden", position: "relative",
      }}>
        <div style={{ flex: 1, overflowY: "auto", padding: onboarded && screen !== "connection" && screen !== "profile" ? "20px 18px" : screen === "connection" || screen === "profile" ? "20px 18px" : 0 }}>
          {body}
        </div>
        {showTabBar && (
          <div style={{ display: "flex", borderTop: `1px solid ${C.divider}`, background: C.bgElevated, padding: "10px 6px 16px" }}>
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.key;
              return (
                <button key={t.key} onClick={() => setTab(t.key)} style={{
                  flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, background: "none",
                  border: "none", cursor: "pointer", position: "relative", padding: "4px 0",
                }}>
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
