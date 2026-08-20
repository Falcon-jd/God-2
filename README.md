# JUST CHILL — Website

The companion app for the JUST CHILL smart hybrid Peltier cooling jacket.
It runs entirely as a static website — no backend, no server, no account.

Two ways to use it:

- **Simulation Mode** — realistic live sensor data with no hardware at all.
  Good for demos.
- **Real jacket** — connects to an ESP32 over Bluetooth from Chrome on
  Android or desktop, using the Web Bluetooth API.

## Run it locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`. Edit `src/App.jsx` and it hot-reloads.

To check a production build before deploying:

```bash
npm run build
npm run preview
```

## Check it still works before a demo

`smoke.mjs` drives the built site in a real Chrome at phone size and asserts the
things that actually matter: onboarding completes, Simulation Mode produces live
readings, the MANUAL controls reach the simulation, the Peltier/fan interlock
holds, the profile field keeps focus while typing, settings survive a reload,
a warning alert escalates to critical, and nothing overflows a 390px screen.

In one terminal:

```bash
npm run build
npm run preview
```

In another:

```bash
npm run test:smoke
```

It uses the Chrome already installed on the machine and pulls `playwright-core`
on demand rather than keeping it as a dependency, so deploy builds stay fast.

## Deploy it for free (pick one)

The build uses `base: './'` in `vite.config.js`, so the same `dist/` folder
works at a domain root *and* under a subpath. All three options below work
without changing anything.

### Option A — Vercel (easiest)

1. Go to [vercel.com](https://vercel.com) and sign up free (GitHub login works).
2. **Add New → Project**, pick this repository, click **Deploy**.
   Vercel detects Vite on its own; no settings to change.
3. You get a live HTTPS URL like `just-chill.vercel.app` in about a minute.
   Every push to `main` redeploys automatically.

### Option B — Netlify (drag-and-drop, no git needed)

1. Run `npm run build` — this creates a `dist/` folder.
2. Go to [app.netlify.com/drop](https://app.netlify.com/drop) and drag the
   `dist/` folder onto the page. It's live immediately at a
   `random-name.netlify.app` URL.
3. For something permanent, create a free Netlify account and connect it to
   the GitHub repo the same way as Vercel.

### Option C — GitHub Pages

```bash
npm install --save-dev gh-pages
```

Add to the `scripts` block in `package.json`:

```json
"deploy": "vite build && gh-pages -d dist"
```

Then:

```bash
npm run deploy
```

In the repository's **Settings → Pages**, set the source to the `gh-pages`
branch. The site appears at `https://<username>.github.io/<repo-name>/`.

> Do **not** add a `"homepage"` field to `package.json`. That is a Create
> React App convention and Vite ignores it completely. The subpath is handled
> by `base: './'` in `vite.config.js` — that line is what makes Pages work,
> and removing it produces a blank page with no visible error.

## Custom domain

Once deployed on Vercel or Netlify, both let you attach a custom domain
(e.g. `justchill.yourcompany.com`) for free under **Project Settings → Domains**
— point your domain's DNS at the value they give you.

## Install it to a phone home screen

The site ships as a PWA (`public/manifest.json` + `public/sw.js`). Open the
deployed HTTPS URL in Chrome on Android and use **⋮ → Add to Home screen** —
it launches full-screen with no browser chrome. This also makes it packageable
as an APK through [PWABuilder](https://www.pwabuilder.com) if you ever want one.

The service worker does no offline caching on purpose: this app exists to show
live telemetry, and serving an hour-old body temperature from cache would be
worse than showing nothing.

## What's inside

- `src/App.jsx` — the entire app: design tokens, cooling algorithm, simulation
  engine, and every screen (Dashboard, Control, Temperature, Battery,
  Analytics, Alerts, Settings, Profile, Connection, Onboarding).
- `src/services/bleService.js` — Web Bluetooth client for a real jacket.
- `src/services/soundService.js` — UI sound effects, synthesised with the Web
  Audio API. No audio files, so nothing to load.
- `esp32-firmware/just_chill_firmware.ino` — the firmware to flash on the board.
- `public/` — PWA manifest, service worker, and app icons.
- Pure React with inline styles — no Tailwind or CSS framework.
- `recharts` for the live temperature graph, `lucide-react` for icons.

Settings, the worker profile, the °C/°F choice and the alert history are saved
to `localStorage`, so they survive a reload and an app relaunch.

## Real hardware over Bluetooth

**Browser support:** Chrome or Edge, on Android or desktop. **Not Safari, and
not anything on iOS** — Apple has not implemented Web Bluetooth, and that
includes Chrome on iPhone, which is Safari underneath.

**Requirements**

- The site must be served over HTTPS. Vercel, Netlify and GitHub Pages all do
  this automatically. `http://localhost` also counts, for local testing.
- Connecting must be triggered by a tap. Browsers block BLE from starting on
  page load, so there is a button for it and there has to be.

### Setup steps

1. Open `esp32-firmware/just_chill_firmware.ino` in the Arduino IDE.
2. Install the **ArduinoJson** library (Tools → Manage Libraries).
3. Replace the placeholder `read…()` functions near the top with real sensor
   calls for your hardware — DS18B20 for temperatures, INA219 for battery
   voltage and current. The TODO comments mark exactly where.
   **Return `NAN` when a read fails.** DallasTemperature returns `-127` for a
   disconnected probe; passing that through means a dangling wire reads as a
   very cold, very safe jacket.
4. Select your board under Tools → Board, then Upload.
5. Open the Serial Monitor at 115200 baud. You should see
   `JUST CHILL jacket advertising over BLE…` followed by a JSON line every
   2 seconds.
6. On the phone, open the deployed site in **Chrome**, go to Connection, and
   tap **CONNECT VIA BLUETOOTH**. Pick "JUST CHILL JACKET" from the picker.

### The wire protocol

Both sides must agree exactly. The UUIDs are defined in
`src/services/bleService.js` and at the top of the `.ino` — only ever change
them together.

| | |
|---|---|
| Service | `12345678-1234-5678-1234-56789abcdef0` |
| Telemetry (notify, ESP32 → browser) | `…def1`, JSON, every ~2 s |
| Command (write, browser → ESP32) | `…def2`, JSON, on every settings change |

The firmware calls `BLEDevice::setMTU(517)` in `setup()`. This matters: the
default ATT MTU of 23 bytes leaves only 20 usable bytes per notification, and
the telemetry frame is far larger than that. Without it every frame is
truncated, the browser fails to parse all of them, and the app shows a green
"Connected" badge next to placeholder readings that never came from a sensor —
with nothing in the UI to say so. Each frame ends with `\n` so the browser can
reassemble fragments if a peer refuses the larger MTU anyway.

### If it won't connect

- Use Chrome. Not Firefox, not Samsung Internet, not anything on iOS.
- The site must be HTTPS (or `localhost`).
- The ESP32 must be powered on and within about 10 m.
- Check the Serial Monitor. No "Website connected" means the ESP32 side never
  finished the handshake — re-check that the UUIDs in the firmware match
  `src/services/bleService.js`.
- If the jacket doesn't appear in the picker at all, confirm
  `pAdvertising->addServiceUUID(SERVICE_UUID)` is still in `setup()`. The
  browser also matches on the name `JUST CHILL…` as a fallback.

## Safety

This drives a Peltier module inside a garment worn against skin. The firmware
enforces these in `applyOutputs()`, in every mode:

- **The Peltier is never energised without airflow.** A Peltier with a stalled
  fan does not cool — it dumps its full electrical power plus the heat it
  pumped into a heatsink with nowhere to send it.
- **The hot-side cutoff applies in MANUAL and ECO too**, not just AUTO, with
  hysteresis so it doesn't chatter at the limit.
- **Battery over-temperature and overcurrent cut the Peltier**, not just raise
  an alert.
- **A dropped Bluetooth link shuts cooling down** instead of leaving the
  Peltier latched at its last commanded duty. So does 30 seconds of silence
  from the app while in MANUAL.
- **A sensor fault stops the Peltier.** If the readings the limits depend on
  can't be trusted, the limits can't be either.

Don't remove these to get more cooling out of it.

Readings are device sensor measurements only. JUST CHILL does not diagnose or
predict heat-related illness — use it alongside a real heat-safety protocol,
not instead of one.
