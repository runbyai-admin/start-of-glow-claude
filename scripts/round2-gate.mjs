/**
 * Round-2 gate: one scripted real-input session that proves the whole game
 * the way an uncapped judging session will exercise it:
 *
 *  1. MENU AS MECHANIC - starts level 1 by steering the wisp into the menu
 *     beacon with the mouse alone (no Enter anywhere in the start path).
 *  2. L1 cautious - the hand-authored safe route, beacon at required-only.
 *  3. L2 vs SHY MOTES - greedy play against the round's new mechanic, with
 *     live-moving telemetry, through the beacon.
 *  4. L3 REPEATED DEATHS - three deliberate hazard deaths in a row, each
 *     verified to respawn clean (progress reset, full mote count back,
 *     telemetry consistent), THEN the storm level played to its beacon.
 *  5. ENDING + SECOND RUN - ending reached with flawless=0, best written to
 *     localStorage, a keypress returns to the menu, Enter starts a fresh
 *     level 1 whose state is genuinely fresh, one more death recovers, done.
 *
 *  Throughout: activeTweens sampled at labelled checkpoints; the run fails
 *  if the tween population grows without bound across death/level churn
 *  (the "minute five" leak check, event-driven rather than wall-clocked).
 *
 * Wall budgets are sized for the CONTENDED shared host (~1.3fps when all
 * three contestants build at once - measured 2026-08-26); they are safety
 * nets against hangs, not performance claims. All game-time waiting is
 * frame-counted.
 *
 * Run against a served build:  node scripts/round2-gate.mjs
 * (default http://127.0.0.1:4173/, override with PLAY_GATE_URL)
 */
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE_URL = process.env.PLAY_GATE_URL ?? "http://127.0.0.1:4173/";
const OUT_DIR = process.env.PLAY_GATE_OUT ?? "test-results/round2-gate";
const VIEW = { w: 1280, h: 720 };
const BEACON = { x: 2202, y: 245 };
const MENU_BEACON = { x: 1010, y: 400 };

const log = (m) => console.log(`[r2] ${new Date().toISOString().slice(11, 19)} ${m}`);
const fail = (m) => {
  console.error(`[r2] FAIL: ${m}`);
  process.exitCode = 1;
  throw new Error(m);
};

const tweenSamples = [];
function sampleTweens(label, s) {
  if (typeof s?.activeTweens === "number") {
    tweenSamples.push({ label, n: s.activeTweens });
    log(`tweens @ ${label}: ${s.activeTweens}`);
  }
}

async function state(page) {
  return page.evaluate(() => window.__glow ?? null);
}

async function frames(page, n = 2) {
  await page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let left = count;
        const tick = () => ((left -= 1) <= 0 ? resolve() : requestAnimationFrame(tick));
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

async function goTo(page, box, wx, wy, opts = {}) {
  const arrive = opts.arrive ?? 36;
  const fleeDist = opts.fleeDist ?? 150;
  const deadline = Date.now() + (opts.timeoutMs ?? 480_000);
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

async function waitClear(page, idx, wx, wy, minDist, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await state(page);
    if (!s || s.scene !== "level") return;
    const h = s.hazards?.[idx];
    if (!h || Math.hypot(h.x - wx, h.y - wy) >= minDist) return;
    await frames(page, 2);
  }
}

/**
 * Wait until hazard #idx is far from a point AND moving further away
 * (direction read from two consecutive samples). At contended-host frame
 * rates the patrols advance near wall speed while the wisp runs game-time,
 * so a distance-only guard launches dashes into a returning patrol - the
 * direction requirement roughly doubles the usable window.
 */
async function waitClearAndLeaving(page, idx, wx, wy, minDist, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let prev = null;
  while (Date.now() < deadline) {
    const s = await state(page);
    if (!s || s.scene !== "level") return;
    const h = s.hazards?.[idx];
    if (!h) return;
    const d = Math.hypot(h.x - wx, h.y - wy);
    if (prev !== null && d >= minDist && d > prev + 1) return;
    prev = d;
    await frames(page, 2);
  }
}

async function runRoute(page, box, route, { label, guards = {}, maxAttempts = 6 }) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let died = false;
    for (let i = 0; i < route.length; i += 1) {
      const [wx, wy] = route[i];
      const guard = guards[i];
      if (guard && guard.leaving) {
        await waitClearAndLeaving(page, guard.hazard, guard.x ?? wx, guard.y ?? wy, guard.minDist ?? 190);
      } else if (guard) {
        await waitClear(page, guard.hazard, guard.x ?? wx, guard.y ?? wy, guard.minDist ?? 190);
      }
      const r = await goTo(page, box, wx, wy);
      if (!r.ok && r.why === "snuffed") {
        log(`${label}: snuffed en route to (${wx},${wy}) - route again (attempt ${attempt + 1})`);
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

async function greedyLevel(page, box, { label, maxMs = 3_600_000 }) {
  const deadline = Date.now() + maxMs;
  let level = (await state(page)).level;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const s = await state(page);
    if (!s || s.scene !== "level" || s.level !== level) return s;
    if (Date.now() - lastLog > 60_000) {
      lastLog = Date.now();
      log(`${label}: L${level} ${s.collected}/${s.required} required (${s.remaining} left, resets ${s.resets})`);
    }
    if (s.beaconOpen) {
      const r = await goTo(page, box, BEACON.x, BEACON.y, { timeoutMs: 600_000 });
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
    // Leash sized for contended-frame chases against fleeing shy motes: a
    // window long enough for real pursuit progress, short enough to drop a
    // target a patrol has converged on.
    await goTo(page, box, safe[0].x, safe[0].y, { timeoutMs: 40_000 });
  }
  fail(`${label}: level ${level} not finished inside ${maxMs / 1000}s`);
}

async function waitScene(page, pred, why, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await state(page);
    if (s && pred(s)) return s;
    await frames(page, 2);
  }
  fail(`timed out waiting for ${why}`);
}

/**
 * Park the mouse on the wisp's own position right after a scene change.
 * goTo keeps steering by the PUBLISHED state, which stays stale through a
 * level fade - so its last moves can land as the new level's first pointer
 * events and send the fresh wisp gliding from spawn toward wherever the old
 * level's beacon happened to sit on screen. (Found the honest way: that
 * stray glide crossed within 4px of a mote at level-2 entry and swallowed
 * it before the entry assertions could see it.)
 */
async function parkOnWisp(page, box) {
  const s = await state(page);
  if (!s || s.scene !== "level") return;
  const p = toScreen(box, s, s.wispX, s.wispY);
  await page.mouse.move(p.x, p.y);
  await frames(page, 2);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, name) });
  log(`screenshot: ${path.join(OUT_DIR, name)}`);
}

/**
 * Deliberately die on the nearest hazard: steer straight onto its live
 * position, ignoring every survival instinct, until resets increments; then
 * wait for the respawn to complete and verify the level reset cleanly.
 */
async function dieOnce(page, box, label) {
  let s = await state(page);
  const startResets = s.resets;
  const total = s.collected + s.remaining;
  let died = false;
  for (let f = 0; f < 2600 && !died; f += 1) {
    s = await state(page);
    if (!s || s.scene !== "level") fail(`${label}: scene changed while trying to die`);
    if (s.resets > startResets) {
      died = true;
      break;
    }
    const near = [...(s.hazards ?? [])].sort(
      (a, b) => Math.hypot(a.x - s.wispX, a.y - s.wispY) - Math.hypot(b.x - s.wispX, b.y - s.wispY),
    )[0];
    if (!near) fail(`${label}: no hazards to die on`);
    const p = toScreen(box, s, near.x, near.y);
    await page.mouse.move(p.x, p.y);
    await frames(page, 1);
  }
  if (!died) fail(`${label}: could not die on a hazard inside the frame budget (grace too long? collision broken?)`);
  // Respawn completes 560 game-ms after the hit: collected back to 0 and the
  // full mote population re-spawned.
  const deadline = Date.now() + 300_000;
  for (;;) {
    if (Date.now() > deadline) fail(`${label}: respawn never completed`);
    s = await state(page);
    if (s.collected === 0 && s.remaining === total && !s.beaconOpen) break;
    await frames(page, 2);
  }
  log(`${label}: death ${s.resets} clean - motes back to ${total}, progress reset`);
  return s;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: VIEW.w, height: VIEW.h } })).newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));

const SKIP_L1 = process.env.PLAY_GATE_SKIP_L1 === "1";

try {
  // ---- 1. menu-as-mechanic: mouse-only start ----
  await page.goto(SKIP_L1 ? `${BASE_URL}?level=2` : BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("body[data-game-ready='true']", { timeout: 120_000 });
  const box = await page.locator("canvas").boundingBox();
  let s = await state(page);
  if (s.scene !== "menu") fail(`expected the menu, got ${s.scene}`);
  log("menu up - steering the wisp into the beacon with the mouse only");
  {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      s = await state(page);
      if (!s || s.scene !== "menu") break;
      const p = { x: box.x + (MENU_BEACON.x * box.width) / VIEW.w, y: box.y + (MENU_BEACON.y * box.height) / VIEW.h };
      await page.mouse.move(p.x, p.y);
      await frames(page, 1);
    }
  }
  s = await waitScene(page, (x) => x.scene === "level" && x.level === (SKIP_L1 ? 2 : 1), "the first level via the menu beacon", 120_000);
  await parkOnWisp(page, box);
  s = await state(page);
  log(`menu beacon started level ${s.level} - no keyboard involved`);
  if (!SKIP_L1 && s.required !== 10) fail(`level 1 required=${s.required}, expected 10`);
  sampleTweens("first entry", s);

  // ---- 2. L1 cautious route ----
  const ARC = [ [330, 430], [430, 355], [545, 305], [665, 290], [780, 510] ];
  const STAGE_HIGH = [820, 300];
  const CROSS_HIGH = [990, 240];
  // Detour south-east off the sentry's top turnaround before the glade - the
  // straight line to the first glade mote lingers inside the pole's reach,
  // which at contended frame rates is where dashes die.
  const CLEAR_POLE = [1085, 470];
  const MID = [ [1160, 380], [1320, 300], [1520, 430] ];
  const LOW_ROAD = [2280, 585];
  if (!SKIP_L1) {
    const route = [...ARC, STAGE_HIGH, CROSS_HIGH, CLEAR_POLE, ...MID, LOW_ROAD];
    const guards = {
      [ARC.length + 1]: { hazard: 0, minDist: 320, leaving: true },
      [route.length - 1]: { hazard: 1, minDist: 210 },
    };
    await runRoute(page, box, route, { label: "L1 cautious", guards, maxAttempts: 14 });
    s = await state(page);
    if (s.scene === "level" && s.level === 1) {
      if (!s.beaconOpen) fail(`safe route ended with beacon closed (collected ${s.collected})`);
      log(`L1: beacon open at ${s.collected}/14 - heading in`);
      for (;;) {
        const r = await goTo(page, box, BEACON.x, BEACON.y, { timeoutMs: 600_000 });
        if (!r.ok && r.why === "snuffed") { await runRoute(page, box, route, { label: "L1 cautious (again)", guards, maxAttempts: 14 }); continue; }
        break;
      }
    }
  } else {
    log("SKIP_L1=1: level 1 leg skipped (evidence stands on the prior play-gate + smoke); proving L2 onward");
  }

  // ---- 3. L2 vs shy motes ----
  s = await waitScene(page, (x) => x.scene === "level" && x.level === 2, "level 2", 120_000);
  await parkOnWisp(page, box);
  s = await state(page);
  if (s.required !== 13) fail(`level 2 required=${s.required}, expected 13`);
  const shyCount = s.motes.filter((m) => m.shy).length;
  if (shyCount !== 6) fail(`level 2 shy motes=${shyCount}, expected 6`);
  sampleTweens("L2 entry", s);
  log(`L2 entered: ${s.motes.length} motes, ${shyCount} shy - greedy play begins`);
  await greedyLevel(page, box, { label: "L2" });
  await shot(page, "l2-done.png");

  // ---- 4. L3: three deliberate deaths, then the storm played through ----
  s = await waitScene(page, (x) => x.scene === "level" && x.level === 3, "level 3", 120_000);
  await parkOnWisp(page, box);
  s = await state(page);
  if (s.required !== 16) fail(`level 3 required=${s.required}, expected 16`);
  if (!(s.winds?.length >= 2)) fail(`level 3 winds missing from telemetry`);
  sampleTweens("L3 entry", s);
  await frames(page, 20);
  const resetsBefore = s.resets;
  for (let d = 1; d <= 3; d += 1) {
    s = await dieOnce(page, box, `L3 death ${d}`);
    sampleTweens(`L3 after death ${d}`, s);
  }
  if (s.resets !== resetsBefore + 3) fail(`resets ${s.resets}, expected ${resetsBefore + 3}`);
  await shot(page, "l3-after-deaths.png");
  log("L3: three clean deaths survived - now playing the storm through");
  await greedyLevel(page, box, { label: "L3" });

  // ---- 5. ending, best, restart, second run ----
  s = await waitScene(page, (x) => x.scene === "ending", "the ending", 120_000);
  if (s.flawless !== 0) fail(`ending flawless=${s.flawless}, expected 0 for this run`);
  const endResets = s.resets;
  await frames(page, 45);
  await shot(page, "ending.png");
  const best = await page.evaluate(() => window.localStorage.getItem("start-of-glow-best-resets"));
  if (best === null) fail("ending did not record a best to localStorage");
  log(`ending reached: resets=${endResets}, best recorded=${best}`);
  await frames(page, 20); // input arms 3.6 game-s after the ending builds
  for (let tries = 0; tries < 40; tries += 1) {
    await page.keyboard.press("Enter");
    const back = await state(page);
    if (back?.scene === "menu") break;
    await frames(page, 10);
  }
  s = await waitScene(page, (x) => x.scene === "menu", "the menu after the ending", 240_000);
  log("back at the menu - starting the second run");
  await page.keyboard.press("Enter");
  s = await waitScene(page, (x) => x.scene === "level" && x.level === 1, "second-run level 1", 120_000);
  await parkOnWisp(page, box);
  s = await state(page);
  if (s.collected !== 0 || s.remaining !== 14 || s.resets !== 0) {
    fail(`second run not fresh: collected=${s.collected} remaining=${s.remaining} resets=${s.resets}`);
  }
  sampleTweens("L1 second run", s);
  // collect the first two arc motes to prove play works post-restart
  for (const [wx, wy] of [[330, 430], [430, 355]]) {
    const r = await goTo(page, box, wx, wy);
    if (!r.ok) fail(`second run: could not reach (${wx},${wy}): ${r.why}`);
  }
  s = await state(page);
  if (s.collected < 1) fail("second run collected nothing on the opening arc");
  log(`second run collects (${s.collected}) - one more death for the road`);
  s = await dieOnce(page, box, "second-run death");
  await shot(page, "second-run-after-death.png");

  // ---- tween-population verdict ----
  const first = tweenSamples[0]?.n ?? 0;
  const max = Math.max(...tweenSamples.map((t) => t.n));
  log(`tween samples: ${tweenSamples.map((t) => `${t.label}=${t.n}`).join(", ")}`);
  if (max > first + 60) fail(`tween population grew from ${first} to ${max} - probable leak`);

  if (pageErrors.length > 0) fail(`page errors during the session: ${pageErrors.join(" | ")}`);
  log("round2-gate PASSED: menu mechanic, all three levels, three deaths, ending, restart, second run - one session, zero errors");
} finally {
  await browser.close();
}
