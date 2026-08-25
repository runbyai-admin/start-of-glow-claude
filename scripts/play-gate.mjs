/**
 * Play-gate: scripted real-input playthroughs that verify a milestone the way
 * the owner judges it - by playing the deployed page, not reading the diff.
 *
 * Run against a served build (default http://127.0.0.1:4173/, override with
 * PLAY_GATE_URL):   node scripts/play-gate.mjs
 *
 * Two runs, matching docs/game-1-year-plan.md Phase 1's own check:
 *  A. Cautious full game - level 1 by its hand-authored safe route, skipping
 *     the guarded pockets (the optional-collection choice, exercised); levels
 *     2-3 by nearest-mote greed only up to the required count; storm layer
 *     screenshotted on level 3; ending reached with flawless=0.
 *  B. Flawless level 1 - every mote including both guarded pockets, the
 *     flawless beacon variant, and flawless=1 carried into level 2.
 *
 * The driver steers with real mouse events using only what a sighted player
 * has: the published telemetry mirrors on-screen positions (see reportState
 * in LevelScene.ts). It waits for hazard clearance before entering guarded
 * ground and flees any hazard that closes in - and a death is not a script
 * failure: like a player, it just runs the route again.
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.PLAY_GATE_URL ?? "http://127.0.0.1:4173/";
const OUT_DIR = process.env.PLAY_GATE_OUT ?? "test-results/play-gate";
const VIEW = { w: 1280, h: 720 };
const BEACON = { x: 2202, y: 245 };

const log = (m) => console.log(`[gate] ${m}`);
const fail = (m) => {
  console.error(`[gate] FAIL: ${m}`);
  process.exitCode = 1;
  throw new Error(m);
};

async function state(page) {
  return page.evaluate(() => window.__glow ?? null);
}

async function frames(page, n = 2) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let left = count;
        const tick = () => (left -= 1) <= 0 ? resolve() : requestAnimationFrame(tick);
        requestAnimationFrame(tick);
      }),
    n,
  );
}

function toScreen(box, s, wx, wy) {
  const scrollX = Math.min(Math.max(s.wispX - VIEW.w / 2, 0), 2560 - VIEW.w);
  const sx = Math.min(Math.max(wx - scrollX, 12), VIEW.w - 12);
  const sy = Math.min(Math.max(wy, 12), VIEW.h - 12);
  return { x: box.x + (sx * box.width) / VIEW.w, y: box.y + (sy * box.height) / VIEW.h };
}

/**
 * Steer the wisp to a world point. Returns {ok, s} - ok=false when the scene
 * changed or the light was snuffed on the way (resets went up). While any
 * hazard is within fleeDist of the wisp, steer straight away from it first.
 */
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
    if (s.collected < s.required && s.beaconOpen) fail("beacon reported open below the required count");
    const dx = wx - s.wispX;
    const dy = wy - s.wispY;
    if (Math.hypot(dx, dy) <= arrive) return { ok: true, s };
    let tx = wx;
    let ty = wy;
    // Repulsion from every hazard inside fleeDist, not just the nearest -
    // fleeing one shadow straight into another is a level-3 classic.
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

/** Wait until hazard #idx is at least minDist from a world point (its patrol always cycles past any point). */
async function waitClear(page, idx, wx, wy, minDist, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await state(page);
    if (!s || s.scene !== "level") return;
    const h = s.hazards?.[idx];
    if (!h || Math.hypot(h.x - wx, h.y - wy) >= minDist) return;
    await frames(page, 2);
  }
}

/** Run one route of world waypoints; on a snuff, start the route over (like a player would). */
async function runRoute(page, box, route, { label, guards = {}, maxAttempts = 6 }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let died = false;
    for (let i = 0; i < route.length; i += 1) {
      const [wx, wy] = route[i];
      const guard = guards[i];
      if (guard) await waitClear(page, guard.hazard, guard.x ?? wx, guard.y ?? wy, guard.minDist ?? 190);
      const r = await goTo(page, box, wx, wy);
      if (!r.ok && r.why === "snuffed") {
        log(`${label}: snuffed on the way to (${wx},${wy}) - re-running the route (attempt ${attempt + 1})`);
        died = true;
        break;
      }
      if (!r.ok && r.why === "scene-changed") return r.s;
      if (!r.ok) fail(`${label}: could not reach (${wx},${wy}): ${r.why}`);
    }
    if (!died) return state(page);
  }
  fail(`${label}: route still incomplete after ${maxAttempts} attempts`);
}

/**
 * Greedy: collect motes until the beacon opens, then walk into it. Prefers
 * motes with no hazard nearby right now (nearest such mote first); when every
 * remaining mote is contested it retreats from the closest hazard and waits a
 * beat for patrols to move on - patience a real player would also use.
 */
async function greedyLevel(page, box, { label, stopAtRequired = true, maxMs = 900_000 }) {
  const deadline = Date.now() + maxMs;
  let level = (await state(page)).level;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const s = await state(page);
    if (!s || s.scene !== "level" || s.level !== level) return s;
    if (Date.now() - lastLog > 30_000) {
      lastLog = Date.now();
      log(`${label}: L${level} ${s.collected}/${s.required} required (${s.remaining} left, resets ${s.resets})`);
    }
    const done = stopAtRequired ? s.beaconOpen : s.remaining === 0;
    if (done) {
      const r = await goTo(page, box, BEACON.x, BEACON.y, { timeoutMs: 120_000 });
      if (!r.ok && r.why === "scene-changed") return r.s;
      if (!r.ok && r.why === "snuffed") continue;
      const arrived = await state(page);
      if (arrived?.scene !== "level" || arrived.level !== level) return arrived;
      await frames(page, 4);
      continue;
    }
    const hazardDist = (m) => Math.min(...(s.hazards ?? []).map((h) => Math.hypot(h.x - m.x, h.y - m.y)), 9999);
    const wispDist = (m) => Math.hypot(m.x - s.wispX, m.y - s.wispY);
    const safe = (s.motes ?? []).filter((m) => hazardDist(m) >= 170).sort((a, b) => wispDist(a) - wispDist(b));
    if (safe.length === 0) {
      const near = [...(s.hazards ?? [])].sort(
        (a, b) => Math.hypot(a.x - s.wispX, a.y - s.wispY) - Math.hypot(b.x - s.wispX, b.y - s.wispY),
      )[0];
      if (near) {
        const away = { x: s.wispX + (s.wispX - near.x) * 2, y: s.wispY + (s.wispY - near.y) * 2 };
        const p = toScreen(box, s, away.x, away.y);
        await page.mouse.move(p.x, p.y);
      }
      await frames(page, 4);
      continue;
    }
    // Short leash: re-evaluate the target every few seconds, so a mote that
    // a patrol has since converged on is dropped instead of walked into.
    await goTo(page, box, safe[0].x, safe[0].y, { timeoutMs: 8_000 });
  }
  fail(`${label}: level ${level} not finished inside ${maxMs / 1000}s`);
}

async function waitScene(page, pred, why, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await state(page);
    if (s && pred(s)) return s;
    await frames(page, 2);
  }
  fail(`timed out waiting for ${why}`);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, name) });
  log(`screenshot: ${path.join(OUT_DIR, name)}`);
}

async function startLevelOne(page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body[data-game-ready='true']", { timeout: 60_000 });
  const box = await page.locator("canvas").boundingBox();
  // Round 2 menu is playable; Enter is the immediate start path for drivers.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("Enter");
  await waitScene(page, (s) => s.scene === "level" && s.level === 1, "level 1");
  await frames(page, 4);
  return box;
}

// Level 1's hand-authored geography (kept in step with levels.ts by eye -
// the gate fails loudly if the level stops matching it).
const ARC = [ [330, 430], [430, 355], [545, 305], [665, 290], [780, 510] ];
// Staging point hard against the lane's safe side: the guarded dash across is
// then ~180px, not the 342px diagonal from ARC's end - at 5fps under host
// load the long dash lost its race with the sentry's return about half the
// time (2026-08-24, load ~8: six straight snuffs mid-crossing).
const STAGE_HIGH = [820, 300];
const CROSS_HIGH = [990, 240];
const MID = [ [1160, 380], [1320, 300], [1520, 430] ];
const LOW_ROAD = [2280, 585];
const POCKET_A = [900, 635];
const CROSS_LOW = [1010, 540];
const POCKET_B = [ [1985, 415], [2090, 295] ];

async function runCautious(browser) {
  log("run A: cautious full game - skip every guarded pocket");
  const page = await (await browser.newContext({ viewport: { width: VIEW.w, height: VIEW.h } })).newPage();
  const box = await startLevelOne(page);

  const s0 = await state(page);
  if (s0.required !== 10) fail(`level 1 required=${s0.required}, expected 10`);

  const route = [...ARC, STAGE_HIGH, CROSS_HIGH, ...MID, LOW_ROAD];
  const guards = {
    [ARC.length + 1]: { hazard: 0, minDist: 320 }, // crossing the sentry lane
    [route.length - 1]: { hazard: 1, minDist: 210 }, // passing under the circuit
  };
  await runRoute(page, box, route, { label: "cautious L1", guards });

  let s = await state(page);
  if (s.scene === "level" && s.level === 1) {
    if (!s.beaconOpen) fail(`safe route ended with beacon closed (collected ${s.collected})`);
    if (s.collected >= 14) fail("cautious route collected everything - the skip did not happen");
    log(`cautious L1: beacon open at ${s.collected}/14 - heading in, leaving ${s.remaining} motes behind`);
    await shot(page, "a-l1-beacon-open.png");
    for (;;) {
      const r = await goTo(page, box, BEACON.x, BEACON.y, { timeoutMs: 120_000 });
      if (!r.ok && r.why === "snuffed") { await runRoute(page, box, route, { label: "cautious L1 (again)", guards }); continue; }
      break;
    }
  }
  s = await waitScene(page, (x) => x.scene === "level" && x.level === 2, "level 2", 60_000);
  if (s.flawless !== 0) fail(`cautious run reports flawless=${s.flawless} after level 1, expected 0`);
  if (s.required !== 13) fail(`level 2 required=${s.required}, expected 13`);
  log(`level 2 entered, flawless=0 as expected; playing greedily to required only`);
  await greedyLevel(page, box, { label: "cautious", maxMs: 900_000 });

  s = await waitScene(page, (x) => x.scene === "level" && x.level === 3, "level 3", 60_000);
  if (s.required !== 16) fail(`level 3 required=${s.required}, expected 16`);
  await frames(page, 30); // let the storm establish before the evidence shot
  await shot(page, "a-l3-storm.png");
  await greedyLevel(page, box, { label: "cautious", maxMs: 1_200_000 });

  s = await waitScene(page, (x) => x.scene === "ending", "the ending", 60_000);
  if (s.flawless !== 0) fail(`ending reports flawless=${s.flawless}, expected 0 for the cautious run`);
  await frames(page, 40); // ending lines fade in
  await shot(page, "a-ending.png");
  log(`run A complete: resets=${s.resets}, flawless=${s.flawless}`);
  await page.context().close();
}

async function runFlawless(browser) {
  log("run B: flawless level 1 - every mote, both pockets");
  const page = await (await browser.newContext({ viewport: { width: VIEW.w, height: VIEW.h } })).newPage();
  const box = await startLevelOne(page);

  const route = [...ARC, STAGE_HIGH, CROSS_HIGH, CROSS_LOW, POCKET_A, ...MID, ...POCKET_B, LOW_ROAD];
  const guards = {
    [ARC.length + 1]: { hazard: 0, minDist: 320 },
    [ARC.length + 3]: { hazard: 0, minDist: 200 }, // pocket A sits at the sentry's turnaround
    [ARC.length + 4 + MID.length]: { hazard: 1, minDist: 200 }, // first pocket-B mote
    [ARC.length + 5 + MID.length]: { hazard: 1, minDist: 200 }, // second pocket-B mote
    [route.length - 1]: { hazard: 1, minDist: 210 },
  };
  await runRoute(page, box, route, { label: "flawless L1", guards });

  let s = await state(page);
  if (s.scene === "level" && s.level === 1) {
    if (s.remaining !== 0) fail(`flawless route left ${s.remaining} motes uncollected`);
    log("flawless L1: all 14 motes - the beacon should be showing its warm variant");
    await shot(page, "b-l1-flawless-beacon.png");
    for (;;) {
      const r = await goTo(page, box, BEACON.x, BEACON.y, { timeoutMs: 120_000 });
      if (!r.ok && r.why === "snuffed") { await runRoute(page, box, route, { label: "flawless L1 (again)", guards }); continue; }
      break;
    }
  }
  s = await waitScene(page, (x) => x.scene === "level" && x.level === 2, "level 2", 60_000);
  if (s.flawless !== 1) fail(`flawless run reports flawless=${s.flawless} after level 1, expected 1`);
  log("run B complete: flawless=1 carried into level 2");
  await page.context().close();
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
try {
  await runCautious(browser);
  await runFlawless(browser);
  log("play-gate PASSED: the optional-collection choice is real in both directions");
} finally {
  await browser.close();
}
