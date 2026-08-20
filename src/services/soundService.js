/**
 * JUST CHILL — UI sound effects, synthesized with the Web Audio API.
 *
 * No audio files needed — every sound is a short generated tone. This keeps
 * the bundle small and lets the whole sound set share one consistent voice
 * (soft sine/triangle blips, matching the app's clean industrial-tech feel).
 *
 * Browsers require a user gesture before audio can play, so the
 * AudioContext is created lazily on the first call rather than at module
 * load — calling any function here before a real click/tap simply no-ops
 * safely (caught below) instead of throwing.
 */

let ctx = null;
let enabled = true;

function getContext() {
  if (!ctx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    ctx = new AudioContextClass();
  }
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

export function setSoundEnabled(value) {
  enabled = value;
}

export function isSoundEnabled() {
  return enabled;
}

/**
 * Plays one or more short tones in sequence.
 * notes: array of { freq, start, duration, type, gain }
 */
function playTones(notes) {
  if (!enabled) return;
  const audioCtx = getContext();
  if (!audioCtx) return;

  try {
    const now = audioCtx.currentTime;
    notes.forEach(({ freq, start = 0, duration = 0.08, type = "sine", gain = 0.06 }) => {
      const osc = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + start);
      gainNode.gain.setValueAtTime(0, now + start);
      gainNode.gain.linearRampToValueAtTime(gain, now + start + 0.008);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, now + start + duration);
      osc.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      osc.start(now + start);
      osc.stop(now + start + duration + 0.02);
    });
  } catch {
    // Audio isn't critical to app function — fail silently.
  }
}

// ── Sound palette ──────────────────────────────────────────────────────
export const sounds = {
  // Generic UI tap — buttons, nav tabs, cards
  click: () => playTones([{ freq: 1400, duration: 0.05, type: "sine", gain: 0.05 }]),

  // Toggle switch flip — slightly different pitch for on vs off
  toggleOn: () => playTones([{ freq: 1100, duration: 0.06 }, { freq: 1650, start: 0.03, duration: 0.07 }]),
  toggleOff: () => playTones([{ freq: 900, duration: 0.07 }]),

  // Segmented control / mode selector change
  select: () => playTones([{ freq: 1200, duration: 0.05 }, { freq: 1500, start: 0.04, duration: 0.06 }]),

  // Slider — soft, quick tick, deliberately tiny so rapid dragging doesn't spam
  sliderTick: () => playTones([{ freq: 900 + Math.random() * 200, duration: 0.03, gain: 0.025, type: "triangle" }]),

  // Power on / off — the big glowing button
  powerOn: () => playTones([
    { freq: 440, duration: 0.09, type: "triangle" },
    { freq: 660, start: 0.07, duration: 0.1, type: "triangle" },
    { freq: 880, start: 0.14, duration: 0.14, type: "triangle" },
  ]),
  powerOff: () => playTones([
    { freq: 660, duration: 0.09, type: "triangle" },
    { freq: 440, start: 0.06, duration: 0.14, type: "triangle" },
  ]),

  // Connection lifecycle
  connect: () => playTones([
    { freq: 700, duration: 0.06 },
    { freq: 1050, start: 0.05, duration: 0.06 },
    { freq: 1400, start: 0.1, duration: 0.12 },
  ]),
  disconnect: () => playTones([
    { freq: 1000, duration: 0.06 },
    { freq: 600, start: 0.05, duration: 0.12 },
  ]),

  // Confirmation — save profile, acknowledge alert
  success: () => playTones([
    { freq: 1000, duration: 0.06 },
    { freq: 1500, start: 0.06, duration: 0.12 },
  ]),

  // Warning / critical alert — distinct, slightly urgent without being harsh
  alertWarning: () => playTones([
    { freq: 820, duration: 0.09, type: "square", gain: 0.035 },
    { freq: 820, start: 0.14, duration: 0.09, type: "square", gain: 0.035 },
  ]),
  alertCritical: () => playTones([
    { freq: 950, duration: 0.09, type: "square", gain: 0.045 },
    { freq: 700, start: 0.11, duration: 0.09, type: "square", gain: 0.045 },
    { freq: 950, start: 0.22, duration: 0.09, type: "square", gain: 0.045 },
  ]),

  // Navigation — switching tabs/screens
  navigate: () => playTones([{ freq: 1300, duration: 0.04, gain: 0.04 }]),
};
