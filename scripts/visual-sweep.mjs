/**
 * Visual sweep: capture the judge-visible states no screenshot has yet shown,
 * against a served build (default the live claude slot). READ-ONLY - it plays
 * and screenshots; it changes nothing.
 *
 *   node scripts/visual-sweep.mjs
 *   URL=http://127.0.0.1:4173/ node scripts/visual-sweep.mjs
 *
 * Captures:
 *  1. L1 entry card + an actual collect moment (ring + light lift frame).
 *  2. L1 beacon OPEN: the "beacon is lit" line, HUD flip, invitation sparks -
 *     from across the level and from up close (stopping short of arrival).
 *  3. L1 arrival swell frame.
 *  4. L2 whisper line at the first shy startle.
 *  5. L3 wind fleck streams + a burst of frames to catch a lightning flash.
 * Timebase note: ~5fps headless -> frame-counted waits only (see ARCHITECTURE
 * "the two-timebase trap").
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.URL ?? "https://app.electricity.studio/glow/claude/";
const OUT = "test-results/visual-sweep";
const VIEW = { w: 1280, h: 720 };
const BEACON = { x: 2202, y: 245 };
const log = (m) => console.log(`[sweep] ${m}`);
const fail = (m) => {
  console.error(`[sweep] FAIL: ${m}`);
  process.exitCode = 1;
  throw new Error(m);
};

fs.mkdirSync(OUT, { recursive: true });

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

function toScreen(box, s, wx, wy) {
  const scrollX = Math.min(Math.max(s.wispX - VIEW.w / 2, 0), 2560 - VIEW.w);
  const sx = Math.min(Math.max(wx - scrollX, 12), VIEW.w - 12);
  const sy = Math.min(Math.max(wy, 12), VIEW.h - 12);
  return { x: box.x + (sx * box.width) / VIEW.w, y: box.y + (sy * box.height) / VIEW.h };
}

async function goTo(page, box, wx, wy, opts = {}) {
  const arrive = opts.arrive ?? 36;
  const fleeDist = opts.fleeDist ?? 150;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  let s = await state(page);
  const startResets = s?.resets ?? 0;
  while (Date.now() < deadline) {
    s = await state(page);
    if (!s || s.scene !== "level") return { ok: false, s, why: "scene-changed" };
    if (s.resets > startResets) return { ok: false, s, why: "snuffed" };
    const dx = wx - s.wispX;
    const dy = wy - s.wispY;
    if (Math.hypot(dx, dy) <= arrive) return { ok: true, s };
    let tx = wx;
    let ty = wy;
    let fx = 0;
    let fy = 0;
    for (const h of s.hazards ?? []) {
      const d = Math.hypot(h.x - s.wispX, h.y - s.wispY);
      if (d < fleeDist && d > 0) {
        const w = (fleeDist - d) / d;
        fx += (s.wispX - h.x) * w;
        fy += (s.wispY - h.y) * w;
      }
    }
    if (fx !== 0 || fy !== 0) {
      tx = s.wispX + fx * 4;
      ty = s.wispY + fy * 4;
    }
    const p = toScreen(box, s, tx, ty);
    await page.mouse.move(p.x, p.y);
    await frames(page, 1);
  }
  return { ok: false, s, why: "timeout" };
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name) });
  log(`screenshot: ${name}`);
}

async function openLevel(page, n) {
  await page.goto(`${BASE}?level=${n}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body[data-game-ready='true']", { timeout: 60_000 });
  const box = await page.locator("canvas").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => window.__glow?.scene === "level", { timeout: 30_000 });
  await frames(page, 4);
  return box;
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: VIEW.w, height: VIEW.h } })).newPage();
page.on("pageerror", (e) => fail(`page error: ${e}`));

// ---- 1+2+3: level 1 - entry card, a collect, beacon open, arrival ----------
let box = await openLevel(page, 1);
await shot(page, "l1-entry-card.png");

let s = await state(page);
// Greedy-collect safe motes until the beacon opens (10 of 14 on L1).
const deadline = Date.now() + 12 * 60_000;
let shotCollect = false;
while (Date.now() < deadline) {
  s = await state(page);
  if (!s || s.scene !== "level") fail("left level 1 unexpectedly");
  if (s.beaconOpen) break;
  const hazardDist = (m) => Math.min(...(s.hazards ?? []).map((h) => Math.hypot(h.x - m.x, h.y - m.y)), 9999);
  const wispDist = (m) => Math.hypot(m.x - s.wispX, m.y - s.wispY);
  const safe = (s.motes ?? []).filter((m) => hazardDist(m) >= 170).sort((a, b) => wispDist(a) - wispDist(b));
  if (safe.length === 0) {
    await frames(page, 4);
    continue;
  }
  const before = s.collected;
  const r = await goTo(page, box, safe[0].x, safe[0].y, { arrive: 20, timeoutMs: 20_000 });
  if (r.ok && !shotCollect) {
    // We are on top of a mote; the collect fires within a frame or two.
    const t = Date.now() + 8_000;
    while (Date.now() < t) {
      const now = await state(page);
      if (now && now.collected > before) {
        await shot(page, "l1-collect-moment.png");
        shotCollect = true;
        break;
      }
      await frames(page, 1);
    }
  }
}
s = await state(page);
if (!s.beaconOpen) fail("beacon never opened on level 1");
log(`beacon open at ${s.collected}/${s.required}`);
await frames(page, 2);
await shot(page, "l1-beacon-open-far.png"); // the line + HUD flip, beacon likely off-screen
// Walk toward the beacon but stop well short of arrival to see the invitation.
const near = await goTo(page, box, BEACON.x - 320, BEACON.y + 180, { arrive: 40, timeoutMs: 120_000 });
if (near.ok) {
  await frames(page, 3);
  await shot(page, "l1-beacon-open-near.png"); // pulse + rising sparks in frame
}
// Arrival: catch the swell mid-transition.
const arr = await goTo(page, box, BEACON.x, BEACON.y, { arrive: 60, timeoutMs: 120_000 });
await frames(page, 2);
await shot(page, "l1-arrival.png");
log(`arrival leg: ${arr.ok ? "reached" : arr.why}`);

// ---- 4: level 2 - the whisper line ----------------------------------------
box = await openLevel(page, 2);
s = await state(page);
const shy = (s.motes ?? [])
  .filter((m) => m.shy)
  .sort((a, b) => Math.hypot(a.x - s.wispX, a.y - s.wispY) - Math.hypot(b.x - s.wispX, b.y - s.wispY))[0];
if (!shy) fail("no shy mote published on level 2");
// Rush it: repeated fast pointer jumps straight at it to trip the startle.
for (let i = 0; i < 40; i += 1) {
  s = await state(page);
  if (!s || s.scene !== "level") break;
  const target = (s.motes ?? []).find((m) => m.shy && Math.hypot(m.x - shy.x, m.y - shy.y) < 200) ?? shy;
  const p = toScreen(box, s, target.x, target.y);
  await page.mouse.move(p.x, p.y);
  await frames(page, 1);
}
await shot(page, "l2-whisper-line.png");

// ---- 5: level 3 - wind streams + lightning burst ---------------------------
box = await openLevel(page, 3);
// Drift into the midfield crosswind zone so its fleck stream is in frame.
await goTo(page, box, 1280, 380, { arrive: 60, timeoutMs: 90_000 });
await frames(page, 3);
await shot(page, "l3-wind-midfield.png");
// Burst-sample frames to catch the seeded lightning double-flash.
for (let i = 0; i < 14; i += 1) {
  await frames(page, 6);
  await shot(page, `l3-burst-${String(i).padStart(2, "0")}.png`);
}

await browser.close();
log("sweep complete");
