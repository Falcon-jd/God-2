import { chromium } from 'playwright-core';

const URL = process.argv[2] || 'http://localhost:4190/';
const results = [];
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

await page.goto(URL, { waitUntil: 'networkidle' });

// ── Onboarding ────────────────────────────────────────────────────────
ok('app renders', (await page.locator('#root *').count()) > 0);
ok('onboarding shows', await page.getByText('JUST CHILL', { exact: true }).first().isVisible());

for (let i = 0; i < 3; i++) {
  const next = page.getByRole('button', { name: /NEXT|GET STARTED/ });
  if (await next.count()) { await next.first().click(); await page.waitForTimeout(150); }
}
ok('reached main app', await page.getByText('Dashboard').first().isVisible());

// ── Start the demo ────────────────────────────────────────────────────
await page.getByRole('button', { name: /Offline|Connected/ }).first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'START DEMO' }).click();
await page.waitForTimeout(3000);
ok('demo connects', await page.getByText('DISCONNECT').isVisible());

await page.getByRole('button', { name: 'Back' }).click();
await page.waitForTimeout(300);

const bodyTemp = async () => {
  const t = await page.locator('svg + div, #root').first().innerText();
  const m = t.match(/(3[4-9]\.\d)°C/);
  return m ? parseFloat(m[1]) : null;
};
const t1 = await bodyTemp();
ok('live body temp on dashboard', t1 !== null, `${t1}°C`);

// ── The bug that killed the demo: MANUAL controls were inert ──────────
await page.getByRole('button', { name: 'Control' }).click();
await page.waitForTimeout(200);
await page.getByRole('button', { name: /MANUAL/ }).click();
await page.waitForTimeout(200);

const fan = page.getByRole('slider', { name: 'Fan Speed' });
await fan.fill('95');
await page.waitForTimeout(200);
const intensity = page.getByRole('slider', { name: 'Cooling Intensity' });
// The sim eases fan speed toward its target rather than snapping, so give it
// several 2s ticks to converge before asserting.
await intensity.fill('100');
await page.waitForTimeout(14000);

const liveOut = await page.locator('#root').innerText();
ok('MANUAL cooling level reaches sim', /HIGH/.test(liveOut), 'LIVE OUTPUT shows HIGH');
const fanMatch = liveOut.match(/(\d+)%\nFan\n/);
ok('MANUAL fan speed reaches sim', fanMatch && Number(fanMatch[1]) > 80, fanMatch ? fanMatch[1] + '%' : 'not found');

// ── Peltier/fan interlock: fan off must not leave Peltier running ─────
const fanToggle = page.getByRole('switch', { name: 'Fan' });
await fanToggle.click();
await page.waitForTimeout(9000);
const afterFanOff = await page.locator('#root').innerText();
const fanNow = afterFanOff.match(/(\d+)%\nFan\n/);
ok('interlock holds fan above 0 while Peltier runs', fanNow && Number(fanNow[1]) >= 35, fanNow ? fanNow[1] + '%' : 'not found');

// ── Profile input focus — Field used to remount every keystroke ───────
await page.getByRole('button', { name: 'Settings' }).click();
await page.waitForTimeout(200);
await page.getByRole('button', { name: /Worker Profile/ }).click();
await page.waitForTimeout(300);
const nameField = page.getByRole('textbox', { name: 'Name' });
await nameField.click();
await page.keyboard.type('Alex Rivera', { delay: 60 });
await page.waitForTimeout(200);
ok('name field keeps every keystroke', (await nameField.inputValue()) === 'Alex Rivera', await nameField.inputValue());
ok('name field keeps focus', await nameField.evaluate((el) => el === document.activeElement));

await page.getByRole('button', { name: /SAVE PROFILE/ }).click();
await page.waitForTimeout(400);

// ── Persistence across reload ─────────────────────────────────────────
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const afterReload = await page.locator('#root').innerText();
ok('onboarding not replayed after reload', !/GET STARTED|Stay Cool\. Stay Safe/.test(afterReload));
ok('profile survives reload', /Alex/.test(afterReload), afterReload.split('\n').slice(0, 3).join(' | '));

// ── Alert escalation: warning must not swallow critical ──────────────
await page.getByRole('button', { name: 'Settings' }).click();
await page.waitForTimeout(200);
// Demo scenarios only appear while a sim session is running; restart one.
await page.getByRole('button', { name: /Bluetooth/ }).first().click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'START DEMO' }).click();
await page.waitForTimeout(2500);
await page.getByRole('button', { name: 'Back' }).click();
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Settings' }).click();
await page.waitForTimeout(300);

await page.getByRole('button', { name: /Heat Spike/ }).click();
await page.waitForTimeout(2500);
await page.getByRole('button', { name: /Heat Spike/ }).click();
await page.waitForTimeout(4500);

await page.getByRole('button', { name: /Alerts/ }).click();
await page.waitForTimeout(400);
const alertsText = await page.locator('#root').innerText();
ok('alerts raised', /High Body Temperature|High Ambient Temperature/.test(alertsText));
const criticalCount = Number((alertsText.match(/(\d+)\nCritical/) || [])[1] ?? 0);
ok('escalates to critical', criticalCount > 0, `critical=${criticalCount}`);

// ── Layout: no horizontal overflow, tab bar visible ──────────────────
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
ok('no horizontal page scroll at 390px', overflow <= 0, `overflow=${overflow}px`);
const tabBarVisible = await page.getByRole('button', { name: /^Dashboard/ }).isVisible();
ok('bottom tab bar on screen', tabBarVisible);
const tabBox = await page.getByRole('button', { name: /^Dashboard/ }).boundingBox();
ok('tab bar within viewport height', tabBox && tabBox.y + tabBox.height <= 845, tabBox ? `bottom=${Math.round(tabBox.y + tabBox.height)}` : 'no box');

// ── Analytics uses real data, not avg+1.1 ────────────────────────────
await page.getByRole('button', { name: /^Analytics/ }).click();
await page.waitForTimeout(400);
const analytics = await page.locator('#root').innerText();
ok('analytics has no fake range selector', !/\bWEEK\b|\bMONTH\b/.test(analytics));
const nums = [...analytics.matchAll(/(3[0-9]\.\d)°C/g)].map((m) => parseFloat(m[1]));
ok('analytics max/min are not fixed offsets from avg', nums.length >= 3 && !(Math.abs((nums[1] - nums[0]) - 1.1) < 0.001 && Math.abs((nums[0] - nums[2]) - 0.6) < 0.001), nums.slice(0, 3).join(' / '));

// ── Keyboard reachability ────────────────────────────────────────────
await page.getByRole('button', { name: /^Dashboard/ }).click();
await page.waitForTimeout(300);
ok('battery card is a real button', (await page.getByRole('button', { name: 'Battery details' }).count()) > 0);
ok('temperature card is a real button', (await page.getByRole('button', { name: 'Body temperature details' }).count()) > 0);

console.log('\n--- console/page errors ---');
console.log(errors.length ? errors.join('\n') : '(none)');

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length || errors.length ? 1 : 0);
