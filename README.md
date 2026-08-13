# JUST CHILL — Website

A standalone, deployable version of the JUST CHILL companion app — runs
entirely as a static website, no backend required. Ships with Simulation
Mode so it works with zero hardware.

## Run it locally

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`. Edit `src/App.jsx` and it hot-reloads.

## Deploy it for free (pick one)

### Option A — Vercel (easiest)
1. Go to [vercel.com](https://vercel.com), sign up free (GitHub login works).
2. Push this folder to a GitHub repo (see below), or drag-and-drop the folder
   directly into the Vercel dashboard.
3. Vercel auto-detects Vite. Click **Deploy**. Done — you get a live URL
   like `just-chill.vercel.app` in under a minute.

### Option B — Netlify (also easy, drag-and-drop works without git)
1. Run `npm run build` locally — this creates a `dist/` folder.
2. Go to [app.netlify.com/drop](https://app.netlify.com/drop) and drag the
   `dist/` folder onto the page. It's live immediately at a
   `random-name.netlify.app` URL.
3. To keep it long-term with your own domain, create a free Netlify account
   and connect it to a GitHub repo the same way as Vercel.

### Option C — GitHub Pages (free, tied to a GitHub repo)
```bash
npm install --save-dev gh-pages
```
Add to `package.json` scripts: `"deploy": "vite build && gh-pages -d dist"`
Add `"homepage": "https://<your-username>.github.io/<repo-name>"` at the top level.
Then:
```bash
npm run deploy
```

## Getting it onto GitHub (needed for Option A/C if not drag-and-drop)

```bash
git init
git add .
git commit -m "JUST CHILL website"
gh repo create just-chill-website --public --source=. --push
```
(`gh` is GitHub's CLI — install from [cli.github.com](https://cli.github.com),
or just create the repo manually on github.com and follow its push instructions.)

## Custom domain

Once deployed on Vercel or Netlify, both let you attach a custom domain
(e.g. `justchill.yourcompany.com`) for free under **Project Settings → Domains**
— just point your domain's DNS at the value they give you.

## What's inside

- `src/App.jsx` — the entire app: design tokens, cooling algorithm,
  simulation engine, and all screens (Dashboard, Control, Temperature,
  Battery, Analytics, Alerts, Settings, Profile, Connection, Onboarding).
- Pure React + inline styles — no Tailwind or CSS framework dependency.
- `recharts` for the live temperature graph, `lucide-react` for icons.

## Turning this into a real ESP32-connected app

This build only runs Simulation Mode — browsers can't do Bluetooth Low
Energy the same way native apps can (Web Bluetooth exists but has limited
support and is a different integration path than the mobile app's BLE
layer). For a version that actually talks to a real jacket, use the
React Native / Expo mobile app instead (see the earlier `just-chill-app.zip`
delivered in this conversation) — its `src/services/bleService.ts` is
scaffolded for `react-native-ble-plx` and a real ESP32 device.

If you specifically want browser-based BLE, Web Bluetooth
(`navigator.bluetooth`) works in Chrome/Edge on desktop and Android, but
not Safari/iOS — worth knowing before committing to that path.

---

## Real hardware over Bluetooth (Web Bluetooth)

The website now supports connecting to a real ESP32 jacket directly over
Bluetooth — no cloud, no WiFi required. This uses the browser's Web
Bluetooth API.

**Browser support:** Chrome or Edge, on Android or desktop. **Not supported
in Safari or iOS** (Apple hasn't implemented Web Bluetooth). Since you're on
Android, Chrome is the one to use.

**Requirements:**
- The site must be served over HTTPS (Vercel/Netlify already do this automatically)
- Connecting must be triggered by a tap — browsers block BLE from starting on page load

### Files involved
- `src/services/bleService.js` — the browser-side BLE client (Web Bluetooth)
- `esp32-firmware/just_chill_firmware.ino` — the ESP32 firmware to flash onto your board

### Setup steps
1. Open `esp32-firmware/just_chill_firmware.ino` in Arduino IDE.
2. Install the **ArduinoJson** library via Library Manager (Tools → Manage Libraries).
3. Replace the placeholder `read...()` functions near the top with real
   sensor library calls for your actual hardware (DS18B20 for temperatures,
   INA219 for battery voltage/current, etc.) — the file has TODO comments
   marking exactly where.
4. Select your ESP32 board under Tools → Board, then Upload.
5. Open the Serial Monitor at 115200 baud — you should see
   `JUST CHILL jacket advertising over BLE...` followed by a JSON line every 2 seconds.
6. On your Android phone, open the deployed website in **Chrome**, go to
   Connection, and tap **CONNECT VIA BLUETOOTH**. Pick "JUST CHILL JACKET"
   from the browser's device picker.

### If it won't connect
- Make sure you're using Chrome (not Firefox/Samsung Internet/Safari)
- The site must be HTTPS — `localhost` also works for local testing
- The ESP32 must be powered on and within Bluetooth range (~10m)
- Check the Serial Monitor — if you don't see "Website connected", the
  ESP32 side isn't finishing the handshake; re-check the UUIDs in the
  firmware match `src/services/bleService.js` exactly (they do by default,
  only change both together if you edit either)
