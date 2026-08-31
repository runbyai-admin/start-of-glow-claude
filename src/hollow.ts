/**
 * The Hollow - act 4, behind the third beacon. The forest's rule reverses
 * here: the press GIVES light instead of taking it. Dormant hearths wait in
 * a burnt-black wood; kindling one spends the whole reach to its floor
 * (same cost, same muscle memory as the pull), and in return the hearth
 * stays lit forever, banishes any shadow standing in its pool, and breathes
 * out embers the player walks through to rekindle the reach. Lighting the
 * First Tree at the far end - takeable only once every other hearth burns -
 * ends the game with a dawn instead of a fade.
 *
 * Pure module: rules and authored layout only, no Phaser, so
 * tests/hollow.test.ts can hold the economy to account directly.
 */

import { REACH_MIN, REACH_READY } from "./reach.ts";

/** How far a kindled hearth's permanent light carries - also the banish radius. */
export const HEARTH_POOL_RADIUS = 250;
/**
 * Embers a hearth releases the moment it takes the light. Six embers at 44
 * refill a full 220 press from any five of them - the pool never has to be
 * picked perfectly clean, which live scatter makes unreasonable.
 */
export const EMBERS_PER_HEARTH = 6;
/**
 * One ember rekindles this much reach. Deliberately above the forest's
 * touched-mote 36: income in the Hollow is finite and walking between
 * hearths in the dark is the whole game, so each ember has to matter.
 */
export const EMBER_RESTORE = 44;
/**
 * A lit hearth breathes: every few seconds it releases one more ember into
 * its pool, up to a small standing pile. Slow enough that waiting is never
 * better than walking, but it means a player who wasted presses is stalled,
 * not stranded.
 */
export const HEARTH_BREATH_MS = 7000;
export const HEARTH_BREATH_MAX_STANDING = 2;

export interface HearthSpec {
  x: number;
  y: number;
  /** The First Tree - only kindleable once every other hearth is lit. */
  final?: boolean;
}

export interface HollowLayout {
  hearths: HearthSpec[];
  /** Wild embers scattered in the dark gaps - walking food between hearths. */
  embers: Array<{ x: number; y: number }>;
  /** One waypoint loop per shadow, exactly like LevelLayout.hazards. */
  hazards: Array<Array<{ x: number; y: number }>>;
}

/**
 * The Hollow's authored floor (world 2560x720, wisp starts ~220,446, the
 * First Tree far right). Five hearths make a rising path of choices: the
 * teaching hearth sits alone near the start, the middle three each trade
 * against a shadow lane, and the last one funds the approach to the tree.
 * Every shadow's loop crosses at least one hearth pool, so each kindle is
 * also a chance to clear a road.
 */
export const HOLLOW_LAYOUT: HollowLayout = {
  hearths: [
    { x: 540, y: 500 }, // the teaching hearth: close, safe, obvious
    { x: 950, y: 220 }, // upper pocket - shadow 1 crosses this pool
    { x: 1330, y: 560 }, // lower bend - shadow 2 patrols the gap beyond it
    { x: 1720, y: 240 }, // high shelf on the way up
    { x: 2050, y: 540 }, // the last waypost - shadow 3 guards past here
    { x: 2330, y: 300, final: true }, // the First Tree
  ],
  embers: [
    // Between start and hearth 1.
    { x: 360, y: 470 },
    // The dark crossing to hearth 2.
    { x: 700, y: 380 },
    { x: 830, y: 300 },
    // Down and across to hearth 3.
    { x: 1100, y: 400 },
    { x: 1210, y: 500 },
    // The long climb to hearth 4.
    { x: 1480, y: 420 },
    { x: 1600, y: 320 },
    // Toward hearth 5.
    { x: 1860, y: 380 },
    { x: 1960, y: 470 },
    // The last dark stretch before the tree.
    { x: 2200, y: 420 },
  ],
  hazards: [
    [
      { x: 850, y: 140 },
      { x: 1120, y: 160 },
      { x: 980, y: 300 },
    ],
    [
      { x: 1220, y: 640 },
      { x: 1560, y: 620 },
      { x: 1400, y: 500 },
    ],
    [
      { x: 2140, y: 200 },
      { x: 2420, y: 480 },
      { x: 2180, y: 560 },
    ],
  ],
};

export interface HearthState {
  x: number;
  y: number;
  final: boolean;
  lit: boolean;
}

export function hearthStates(layout: HollowLayout): HearthState[] {
  return layout.hearths.map((h) => ({ x: h.x, y: h.y, final: h.final === true, lit: false }));
}

/** Every ordinary hearth burns - the First Tree will take the light now. */
export function finalUnlocked(hearths: HearthState[]): boolean {
  return hearths.every((h) => h.final || h.lit);
}

/**
 * The hearth a press would kindle: the nearest dormant one inside the reach.
 * The First Tree does not count until every other hearth is lit - the light
 * has to be given everywhere before it can be given back. Returns -1 when
 * nothing in range can take the light (and then the press must NOT spend:
 * unlike the forest's pull, income here is finite, so the light only leaves
 * the wisp when something is there to receive it).
 */
export function kindleTarget(hearths: HearthState[], wispX: number, wispY: number, reach: number): number {
  const treeReady = finalUnlocked(hearths);
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < hearths.length; i += 1) {
    const h = hearths[i];
    if (h.lit) continue;
    if (h.final && !treeReady) continue;
    const d = Math.hypot(h.x - wispX, h.y - wispY);
    if (d <= reach && d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

/** The reach a full press leaves behind, and what a run must earn back per press. */
export const KINDLE_COST = REACH_READY - REACH_MIN;

/**
 * The economy the layout must honour: arriving with one full press in hand,
 * the embers the zone can give (releases plus wild) must fund every kindle
 * with real slack, or the zone soft-locks the exact player it was built for.
 * The breath makes the floor forgiving over time; the static budget still
 * has to work without waiting on it.
 */
export function staticEmberBudget(layout: HollowLayout): { income: number; needed: number } {
  const ordinaryHearths = layout.hearths.filter((h) => !h.final).length;
  const income = (ordinaryHearths * EMBERS_PER_HEARTH + layout.embers.length) * EMBER_RESTORE;
  // One press is free on arrival (the wisp walks in fully kindled).
  const needed = (layout.hearths.length - 1) * KINDLE_COST;
  return { income, needed };
}
