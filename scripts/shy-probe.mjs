/**
 * Shy-mote mechanic probe against a served build's level 2 (?level=2 hook).
 * Verifies, with real mouse input and the published telemetry only:
 *  1. L2 exposes 18 motes, exactly 6 shy, required 13.
 *  2. RUSH: charging a shy mote makes it flee (distance from home grows).
 *  3. TELEMETRY: published mote coords move frame-to-frame while fleeing.
 *  4. CALM: parked wisp -> startle decays -> creep in slowly -> collect
 *     WITHOUT the mote moving meaningfully.
 *  5. STAMINA: a sustained chase exhausts the mote (flee ends), collectable.
 * Motes are tracked by POSITION identity, not array index - the published
 * array reindexes whenever anything is collected.
 * Timebase note: at ~5fps headless, game-dt runs ~1/15 of wall time, so all
 * waits are frame-counted, never wall-clocked.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.URL ?? "http://127.0.0.1:4173/";
const VIEW = { w: 1280, h: 720 };
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

function toScreen(box, s, wx, wy) {
  const scrollX = Math.min(Math.max(s.wispX - VIEW.w / 2, 0), 2560 - VIEW.w);
  const sx = Math.min(Math.max(wx - scrollX, 12), VIEW.w - 12);
  const sy = Math.min(Math.max(wy, 12), VIEW.h - 12);
  return { x: box.x + (sx * box.width) / VIEW.w, y: box.y + (sy * box.height) / VIEW.h };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** The shy mote nearest to `pos`, or null; `within` bounds the match. */
function findShyNear(s, pos, within = 120) {
  let best = null;
  for (const m of s.motes) {
    if (!m.shy) continue;
    const d = dist(m, pos);
    if (d <= within && (!best || d < best.d)) best = { m, d };
  }
  return best?.m ?? null;
}

/** Nearest shy mote to the wisp that is well clear of every hazard right now. */
function pickShy(s) {
  const wisp = { x: s.wispX, y: s.wispY };
  return (
    s.motes
      .filter((m) => m.shy && Math.min(...s.hazards.map((h) => dist(h, m)), 9e9) > 240)
      .sort((a, b) => dist(a, wisp) - dist(b, wisp))[0] ?? null
  );
}

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: VIEW.w, height: VIEW.h } })).newPage();
page.on("pageerror", (e) => fail(`page error: ${e}`));

await page.goto(`${BASE}?level=2`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("body[data-game-ready='true']", { timeout: 60_000 });
const box = await page.locator("canvas").boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.keyboard.press("Enter");
await page.waitForFunction(() => window.__glow?.scene === "level", { timeout: 30_000 });
await frames(page, 6);

let s = await state(page);
if (s.level !== 2) fail(`?level=2 hook landed on level ${s.level}`);
const shyCount = s.motes.filter((m) => m.shy).length;
log(`level 2 up: motes=${s.motes.length} shy=${shyCount} required=${s.required}`);
if (s.motes.length !== 18) fail(`expected 18 motes, got ${s.motes.length}`);
if (shyCount !== 6) fail(`expected 6 shy motes, got ${shyCount}`);
if (s.required !== 13) fail(`expected required=13, got ${s.required}`);

// ---- 2 + 3: rush a shy mote, watch it flee and the telemetry move ----
s = await state(page);
let target = pickShy(s);
if (!target) fail("no hazard-clear shy mote to test against");
const home = { x: target.x, y: target.y };
log(`rushing shy mote at (${home.x},${home.y})`);
let fled = false;
let lastPos = { ...home };
let moves = 0;
const resets0 = s.resets;
for (let f = 0; f < 300 && !fled; f += 1) {
  s = await state(page);
  if (!s || s.scene !== "level") fail("scene changed mid-rush");
  if (s.resets > resets0) fail("snuffed by a hazard mid-rush (picked mote was supposed to be clear)");
  const m = findShyNear(s, lastPos, 140);
  if (!m) fail("lost track of the rushed mote");
  if (dist(m, lastPos) > 0.5) moves += 1;
  lastPos = { x: m.x, y: m.y };
  if (dist(m, home) > 70) {
    fled = true;
    break;
  }
  // charge straight at the mote's CURRENT position - full-speed rush
  const p = toScreen(box, s, m.x, m.y);
  await page.mouse.move(p.x, p.y);
  await frames(page, 1);
}
if (!fled) fail(`shy mote never fled its home (moved-frames=${moves})`);
log(`RUSH ok: mote fled >70px from home; telemetry moved on ${moves} distinct frames`);
if (moves < 3) fail(`telemetry looks stale: only ${moves} frames showed movement during a flee`);
await page.screenshot({ path: process.env.SHOT ?? "shy-probe-flee.png" });

// ---- 5: keep chasing until it tires, then collect it ----
log("chasing to exhaustion (stamina drains in ~2.4 game-seconds)...");
let caught = false;
const countAtChase = s.motes.length;
for (let f = 0; f < 1600 && !caught; f += 1) {
  s = await state(page);
  if (!s || s.scene !== "level") fail("scene changed mid-chase");
  const m = findShyNear(s, lastPos, 160);
  if (!m) {
    if (s.motes.length < countAtChase) {
      caught = true;
      break;
    }
    fail("lost track of the chased mote without a collection");
  }
  lastPos = { x: m.x, y: m.y };
  const p = toScreen(box, s, m.x, m.y);
  await page.mouse.move(p.x, p.y);
  await frames(page, 1);
}
if (!caught) fail("sustained chase never caught the shy mote - stamina/tiring may be broken");
s = await state(page);
log(`STAMINA ok: chased mote collected (collected=${s.collected}, remaining=${s.remaining})`);

// ---- 4: calm approach on a fresh shy mote ----
s = await state(page);
target = pickShy(s);
if (!target) fail("no second hazard-clear shy mote for the calm test");
log(`calm-approaching shy mote at (${target.x},${target.y})`);
lastPos = { x: target.x, y: target.y };
// step 1: walk near it (this may startle it - that's fine), then park
for (let f = 0; f < 300; f += 1) {
  s = await state(page);
  const m = findShyNear(s, lastPos, 160);
  if (!m) fail("calm-test mote vanished during approach");
  lastPos = { x: m.x, y: m.y };
  if (dist({ x: s.wispX, y: s.wispY }, m) < 140) break;
  const p = toScreen(box, s, m.x, m.y);
  await page.mouse.move(p.x, p.y);
  await frames(page, 1);
}
// step 2: park the cursor ON the wisp so wisp speed decays to ~0, wait out
// the startle (0.8 game-s ~= 48 frames) plus settle margin
s = await state(page);
let park = toScreen(box, s, s.wispX, s.wispY);
await page.mouse.move(park.x, park.y);
await frames(page, 100);
// step 3: creep - cursor never more than ~20px ahead of the wisp
s = await state(page);
let calmTarget = findShyNear(s, lastPos, 160);
if (!calmTarget) fail("calm-test mote vanished while parked");
const calmStart = { x: calmTarget.x, y: calmTarget.y };
lastPos = { ...calmStart };
let calmCaught = false;
let maxMoteMove = 0;
const countAtCreep = s.motes.length;
for (let f = 0; f < 900 && !calmCaught; f += 1) {
  s = await state(page);
  if (!s || s.scene !== "level") fail("scene changed mid-creep");
  const m = findShyNear(s, lastPos, 160);
  if (!m) {
    if (s.motes.length < countAtCreep) {
      calmCaught = true;
      break;
    }
    fail("lost track of the calm-test mote without a collection");
  }
  lastPos = { x: m.x, y: m.y };
  maxMoteMove = Math.max(maxMoteMove, dist(m, calmStart));
  const dx = m.x - s.wispX;
  const dy = m.y - s.wispY;
  const d = Math.hypot(dx, dy) || 1;
  const step = Math.min(20, d);
  const p = toScreen(box, s, s.wispX + (dx / d) * step, s.wispY + (dy / d) * step);
  await page.mouse.move(p.x, p.y);
  await frames(page, 1);
}
if (!calmCaught) fail(`calm creep never collected the mote (it moved ${Math.round(maxMoteMove)}px)`);
if (maxMoteMove > 40) fail(`calm approach still spooked the mote ${Math.round(maxMoteMove)}px from rest - threshold broken`);
log(`CALM ok: collected with a slow approach; mote drifted only ${Math.round(maxMoteMove)}px (bob included)`);

s = await state(page);
log(`done: collected=${s.collected} remaining=${s.remaining} resets=${s.resets} activeTweens=${s.activeTweens}`);
log("shy-probe PASSED");
await browser.close();
