import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  EMBER_RESTORE,
  EMBERS_PER_HEARTH,
  HEARTH_POOL_RADIUS,
  HOLLOW_LAYOUT,
  KINDLE_COST,
  finalUnlocked,
  hearthStates,
  kindleTarget,
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
