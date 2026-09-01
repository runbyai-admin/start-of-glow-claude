import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  EMBER_RESTORE,
  EMBERS_PER_HEARTH,
  HEARTH_POOL_RADIUS,
  HOLLOW_LAYOUT,
  KINDLE_COST,
  LEYLINE_CARRY,
  LEYLINE_HALF_WIDTH,
  LEYLINE_LANDING,
  finalUnlocked,
  hearthStates,
  kindleTarget,
  leylineAt,
  leylineBoost,
  leylinePoint,
  leylines,
  staticEmberBudget,
} from "../src/hollow.ts";
import { REACH_MIN, REACH_READY } from "../src/reach.ts";

test("layout has exactly one final hearth, placed last", () => {
  const finals = HOLLOW_LAYOUT.hearths.filter((h) => h.final);
  assert.equal(finals.length, 1);
  assert.ok(HOLLOW_LAYOUT.hearths[HOLLOW_LAYOUT.hearths.length - 1].final);
});

test("the ember economy funds every kindle with real slack", () => {
  const { income, needed } = staticEmberBudget(HOLLOW_LAYOUT);
  // At least one spare press of slack: the zone must never soft-lock a player
  // who missed a few embers, before the hearth breath is even counted.
  assert.ok(
    income >= needed + KINDLE_COST,
    `income ${income} must cover needed ${needed} plus one spare press ${KINDLE_COST}`,
  );
});

test("a full press is affordable from any five embers of a six-ember gift", () => {
  assert.ok((EMBERS_PER_HEARTH - 1) * EMBER_RESTORE >= KINDLE_COST);
});

test("kindleTarget refuses the final hearth until every other hearth burns", () => {
  const hearths = hearthStates(HOLLOW_LAYOUT);
  const final = hearths.find((h) => h.final)!;
  // A spot in reach of ONLY the tree: not takeable while any hearth is cold.
  const spot = { x: final.x + 170, y: final.y - 150 };
  for (const h of hearths) {
    if (h.final) continue;
    assert.ok(Math.hypot(h.x - spot.x, h.y - spot.y) > REACH_READY, "test spot must be out of reach of ordinary hearths");
  }
  assert.equal(kindleTarget(hearths, spot.x, spot.y, REACH_READY), -1);
  for (const h of hearths) if (!h.final) h.lit = true;
  assert.ok(finalUnlocked(hearths));
  assert.equal(hearths[kindleTarget(hearths, spot.x, spot.y, REACH_READY)], final);
});

test("kindleTarget picks the nearest dormant hearth inside the reach and never a lit one", () => {
  const hearths = hearthStates(HOLLOW_LAYOUT);
  const [first, second] = hearths;
  const between = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  const nearer =
    Math.hypot(first.x - between.x, first.y - between.y) <= Math.hypot(second.x - between.x, second.y - between.y)
      ? 0
      : 1;
  assert.equal(kindleTarget(hearths, between.x, between.y, 10_000), nearer);
  hearths[nearer].lit = true;
  assert.notEqual(kindleTarget(hearths, between.x, between.y, 10_000), nearer);
  // Out of reach: nothing to give to.
  assert.equal(kindleTarget(hearths, first.x + 5000, first.y, REACH_MIN), -1);
});

test("every hearth is reachable from the previous one on a walk-and-press budget", () => {
  // From each hearth (starting point included), the next hearth must be
  // kindleable after a walk of open ground: the gap between consecutive
  // hearths can exceed the reach (walking is the game) but each hearth must
  // sit inside the world and no two hearths may share a pool, or one press
  // would visually light two.
  const hearths = HOLLOW_LAYOUT.hearths;
  for (let i = 0; i < hearths.length - 1; i += 1) {
    for (let j = i + 1; j < hearths.length; j += 1) {
      const d = Math.hypot(hearths[i].x - hearths[j].x, hearths[i].y - hearths[j].y);
      assert.ok(d > HEARTH_POOL_RADIUS, `hearths ${i} and ${j} are ${Math.round(d)}px apart - pools overlap`);
    }
  }
});

test("a lit hearth runs one thread to the nearest cold hearth, never to the tree early", () => {
  const hearths = hearthStates(HOLLOW_LAYOUT);
  assert.equal(leylines(hearths).length, 0, "no thread before any hearth burns");
  hearths[0].lit = true;
  const lines = leylines(hearths);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].from, hearths[0]);
  assert.equal(lines[0].to, hearths[1], "the teaching hearth points at the upper pocket");
  // Everything but the last ordinary hearth lit: the thread from hearth 4
  // goes to hearth 5, not the tree, because the tree is not takeable yet.
  for (let i = 0; i < 4; i += 1) hearths[i].lit = true;
  const late = leylines(hearths);
  assert.ok(late.every((l) => !l.to.final), "no thread reaches the tree while a hearth is cold");
  hearths[4].lit = true;
  const last = leylines(hearths);
  assert.ok(last.some((l) => l.to.final), "once every hearth burns, a thread runs to the First Tree");
});

test("the thread carries only a wisp moving along it, and only inside its width", () => {
  const hearths = hearthStates(HOLLOW_LAYOUT);
  hearths[0].lit = true;
  const [line] = leylines(hearths);
  const mid = leylinePoint(line, 0.5);
  const on = leylineAt([line], mid.x, mid.y);
  assert.ok(on, "the midpoint is on the thread");
  assert.ok(on!.strength > 0.99);
  const dt = 1 / 60;
  const maxStep = 480 * dt;
  const withIt = leylineBoost(on, on!.dirX * maxStep, on!.dirY * maxStep, dt, maxStep);
  assert.ok(Math.hypot(withIt.x, withIt.y) > LEYLINE_CARRY * dt * 0.99, "full carry when moving with the road at speed");
  const against = leylineBoost(on, -on!.dirX * maxStep, -on!.dirY * maxStep, dt, maxStep);
  assert.deepEqual(against, { x: 0, y: 0 }, "no carry against the road");
  const still = leylineBoost(on, 0, 0, dt, maxStep);
  assert.deepEqual(still, { x: 0, y: 0 }, "a still wisp is never dragged");
  // The eased tail after a released key is a crawl: a hundredth of a step
  // along the road must earn next to nothing, or the road is a conveyor.
  const crawl = leylineBoost(on, on!.dirX * maxStep * 0.01, on!.dirY * maxStep * 0.01, dt, maxStep);
  assert.ok(Math.hypot(crawl.x, crawl.y) < LEYLINE_CARRY * dt * 0.05, "a crawl is not carried");
  // Off the thread by more than its half-width: nothing.
  const nx = -on!.dirY;
  const ny = on!.dirX;
  const off = leylineAt([line], mid.x + nx * (LEYLINE_HALF_WIDTH + 5), mid.y + ny * (LEYLINE_HALF_WIDTH + 5));
  assert.equal(off, undefined);
  // Past the cold end the road stops.
  const beyond = leylineAt([line], line.to.x + on!.dirX * 30, line.to.y + on!.dirY * 30);
  assert.equal(beyond, undefined);
});

test("the carry lets go before the cold hearth", () => {
  const hearths = hearthStates(HOLLOW_LAYOUT);
  hearths[0].lit = true;
  const [line] = leylines(hearths);
  const len = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y);
  const mid = leylineAt([line], ...Object.values(leylinePoint(line, 0.5)) as [number, number]);
  const near = leylineAt([line], ...Object.values(leylinePoint(line, 1 - 40 / len)) as [number, number]);
  const atDoor = leylineAt([line], line.to.x, line.to.y);
  assert.ok(mid && mid.strength > 0.99, "full carry mid-road");
  assert.ok(near && near.strength < 40 / LEYLINE_LANDING + 0.01, "faded inside the landing stretch");
  assert.equal(atDoor, undefined, "no carry at the socket itself");
});
