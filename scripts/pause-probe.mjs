/**
 * Shell probe for the round-2 extension: the pause overlay and the deepened
 * menu, against a served build, real inputs + published telemetry only.
 *  1. MENU: the clearing renders with the light pipeline (screenshot for the
 *     eyeball gate) and Enter still begins level 1.
 *  2. PAUSE: Escape holds BOTH timebases - wisp (dt) and hazards (tweens)
 *     freeze in telemetry across observed frames.
 *  3. RESUME: Escape again - hazards move again, wisp obeys input again.
 *  4. RESTART: pause -> r restarts the level fresh (collected back to 0)
 *     with run totals (resets) preserved.
 *  5. QUIT: pause -> q lands on the menu scene, game restartable from there.
 * Timebase note: at ~5fps headless all waits are frame-counted, never
 * wall-clocked (ARCHITECTURE.md "two-timebase trap").
 */
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const BASE = process.env.URL ?? "http://127.0.0.1:4173/";
const OUT = "test-results/pause-probe";
const log = (m) => console.log(`[probe] ${m}`);
const fail = (m) => {
  console.error(`[probe] FAIL: ${m}`);
  process.exitCode = 1;
  throw new Error(m);
};

const state = (page) => page.evaluate(() => window.__glow ?? null);
const frames = (page, n) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let left = count;
        const tick = () => ((left -= 1) <= 0 ? resolve() : requestAnimationFrame(tick));
        requestAnimationFrame(tick);
      }),
    n,
  );

const hazardSig = (s) => s.hazards.map((h) => `${h.x},${h.y}`).join(" ");

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
page.on("pageerror", (e) => fail(`page error: ${e}`));

// --- 1. The menu clearing ---
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector("body[data-game-ready=true]", { timeout: 120_000 });
await frames(page, 40); // let the entrance bloom and title land
let s = await state(page);
if (!s || s.scene !== "menu") fail(`expected menu, got ${s?.scene}`);
if (!s.lightsActive) fail("menu light pipeline not active");
await page.screenshot({ path: `${OUT}/menu.png` });
log("menu clearing up, lights active - screenshot for the eyeball gate");

// Steer the wisp with the mouse first - the menu is playable and must obey.
const box = await page.locator("canvas").boundingBox();
await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.75, { steps: 4 });
await frames(page, 24);
s = await state(page);
const menuWisp = { x: s.wispX, y: s.wispY };
if (Math.hypot(menuWisp.x - 250, menuWisp.y - 480) < 30) fail("menu wisp ignored the mouse");
log(`menu wisp follows the mouse (${menuWisp.x},${menuWisp.y})`);

await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__glow?.scene === "level", null, { timeout: 120_000 });
await page.waitForSelector("body[data-game-ready=true]", { timeout: 120_000 });
await frames(page, 12);
s = await state(page);
if (s.level !== 1) fail(`expected level 1, got ${s.level}`);
log("level 1 entered");

// --- 2. Pause holds both timebases ---
const before = await state(page);
await page.keyboard.press("Escape");
await frames(page, 6); // let the pause land
const p0 = await state(page);
const sig0 = hazardSig(p0);
// push the mouse hard while paused - the wisp must NOT follow
await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.2, { steps: 3 });
await frames(page, 30);
const p1 = await state(page);
if (hazardSig(p1) !== sig0) fail(`hazards moved while paused: ${sig0} -> ${hazardSig(p1)}`);
if (Math.abs(p1.wispX - p0.wispX) > 2 || Math.abs(p1.wispY - p0.wispY) > 2)
  fail(`wisp moved while paused: ${p0.wispX},${p0.wispY} -> ${p1.wispX},${p1.wispY}`);
await page.screenshot({ path: `${OUT}/paused.png` });
log(`paused: hazards + wisp held across 30 frames (wisp ${p1.wispX},${p1.wispY})`);

// --- 3. Resume: the world moves again ---
await page.keyboard.press("Escape");
await frames(page, 40);
const r1 = await state(page);
if (hazardSig(r1) === sig0) fail("hazards still frozen after resume");
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6, { steps: 4 });
await frames(page, 30);
const r2 = await state(page);
if (Math.abs(r2.wispX - p1.wispX) < 10 && Math.abs(r2.wispY - p1.wispY) < 10)
  fail("wisp not following input after resume");
log("resumed: hazards patrol, wisp follows input");

// --- 4. Restart level keeps run totals, resets the attempt ---
const resetsBefore = r2.resets;
await page.keyboard.press("Escape");
await frames(page, 6);
await page.keyboard.press("r");
await page.waitForSelector("body[data-game-ready=true]", { timeout: 120_000 });
await frames(page, 12);
const fresh = await state(page);
if (fresh.scene !== "level" || fresh.level !== 1) fail(`restart landed on ${fresh.scene}/${fresh.level}`);
if (fresh.collected !== 0) fail(`restart kept collected=${fresh.collected}`);
if (fresh.resets !== resetsBefore) fail(`restart changed resets ${resetsBefore} -> ${fresh.resets}`);
log(`restart: fresh attempt, resets preserved at ${fresh.resets}`);

// --- 5. Quit to menu, and the menu still starts a game ---
await page.keyboard.press("Escape");
await frames(page, 6);
await page.keyboard.press("q");
await page.waitForFunction(() => window.__glow?.scene === "menu", null, { timeout: 120_000 });
await frames(page, 10);
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__glow?.scene === "level", null, { timeout: 120_000 });
log("quit lands on the menu; menu still opens a fresh level");

await browser.close();
log("PASS: menu clearing, pause/resume both-timebase hold, restart, quit");
