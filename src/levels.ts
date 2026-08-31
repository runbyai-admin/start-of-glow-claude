/**
 * Level configuration: what changes between the three stages. Kept as plain
 * data so LevelScene stays one reusable scene instead of one class per level -
 * difficulty is a curve over these numbers, not new code per stage.
 *
 * A level may also carry a hand-authored `layout`. When present, mote
 * positions and hazard patrol loops come from it verbatim instead of the
 * seeded generator - the layout IS the level design, and the scene derives
 * every count from the data actually used (see LevelScene.buildMotes /
 * buildHazards), so the numeric fields can never drift out of sync with it.
 */

export interface LevelLayout {
  motes: Array<{ x: number; y: number }>;
  /** One waypoint loop per hazard; patrols cycle the loop at hazardSpeed. */
  hazards: Array<Array<{ x: number; y: number }>>;
}

export interface LevelConfig {
  /** 1-based, also the RNG seed so layouts are stable run to run. */
  index: number;
  name: string;
  moteCount: number;
  /**
   * How many motes open the beacon. The rest are optional: collecting every
   * last one earns the flawless variant (warmer beacon, fuller completion
   * run) instead of gating progress - the game's risk/reward decision.
   */
  requiredMotes: number;
  hazardCount: number;
  /** CSS px/second along each hazard's patrol path. */
  hazardSpeed: number;
  /** Sky seed, forest tint, and - for storm-dark - a real weather layer (see LevelScene.buildStorm). */
  mood: "dusk" | "deep-night" | "storm-dark" | "ember-dark";
  layout?: LevelLayout;
  /**
   * "gather" (default) is the forest: press to pull light in. "kindle" is the
   * Hollow: press to give light to a dormant hearth (src/hollow.ts owns that
   * act's layout and economy; `layout`, moteCount and requiredMotes are unused).
   */
  kind?: "gather" | "kindle";
}

/**
 * Level 1 is the pull/cost lesson, so mandatory progress never asks for a
 * second mechanic. Ten lights make one calm route to the beacon. Two pairs of
 * optional lights sit in top and bottom shadow pockets, near enough to buy
 * with a full reach and dangerous to chase after that reach is spent.
 */
export const LEVEL_1_LAYOUT: LevelLayout = {
  motes: [
    // Required opening route: always at least 200px from either patrol.
    { x: 330, y: 430 },
    { x: 480, y: 520 },
    { x: 630, y: 420 },
    { x: 780, y: 400 },
    { x: 930, y: 400 },
    { x: 1100, y: 600 },
    { x: 1230, y: 600 },
    { x: 1420, y: 290 },
    { x: 1800, y: 280 },
    { x: 2150, y: 260 },
    // Optional paid light: two motes inside each patrol pocket.
    { x: 760, y: 120 },
    { x: 840, y: 140 },
    { x: 1650, y: 600 },
    { x: 1780, y: 610 },
  ],
  hazards: [
    [
      { x: 600, y: 80 },
      { x: 1000, y: 90 },
      { x: 800, y: 190 },
    ],
    [
      { x: 1450, y: 650 },
      { x: 1950, y: 650 },
      { x: 1700, y: 550 },
    ],
  ],
};

/**
 * Level 2 is the first place a careful route should become deliberate, not
 * arbitrary. The old seeded layout sometimes sent the cautious path through a
 * shadow near world (955, 241) on a repeat loop. This composed layout keeps a
 * broad S of thirteen motes at least 200px from every patrol segment, ending at
 * the beacon, while five optional motes sit inside the four shadow pockets.
 * The safe route teaches reading lanes; the pockets keep greed dangerous.
 */
export const LEVEL_2_LAYOUT: LevelLayout = {
  motes: [
    // Safe corridor: low through the first half, then rising toward the beacon.
    { x: 340, y: 450 },
    { x: 480, y: 500 },
    { x: 620, y: 520 },
    { x: 780, y: 490 },
    { x: 900, y: 400 },
    { x: 1040, y: 340 },
    { x: 1180, y: 300 },
    { x: 1320, y: 320 },
    { x: 1480, y: 380 },
    { x: 1640, y: 420 },
    { x: 1800, y: 380 },
    { x: 1980, y: 290 },
    { x: 2180, y: 270 },
    // Optional pockets: one or two pieces of light inside each patrol.
    { x: 640, y: 150 },
    { x: 1120, y: 600 },
    { x: 1550, y: 145 },
    { x: 1710, y: 150 },
    { x: 2100, y: 580 },
  ],
  hazards: [
    [
      { x: 480, y: 110 },
      { x: 800, y: 120 },
      { x: 640, y: 220 },
    ],
    [
      { x: 980, y: 630 },
      { x: 1340, y: 630 },
      { x: 1150, y: 560 },
    ],
    [
      { x: 1430, y: 90 },
      { x: 1820, y: 100 },
      { x: 1620, y: 205 },
    ],
    [
      { x: 1840, y: 630 },
      { x: 2310, y: 620 },
      { x: 2100, y: 510 },
    ],
  ],
};

/**
 * Level 3 turns the reach economy into terrain. Three pairs of fast shadows
 * close the middle of the forest. The first sixteen motes take the long safe
 * route below, above, then below those gates; six shortcut motes sit directly
 * inside them. A full reach can buy dangerous light across a gate and shorten
 * the trip. A spent reach has to take the visible way around.
 */
export const LEVEL_3_LAYOUT: LevelLayout = {
  motes: [
    // Required detour: below gate one, above gate two, below gate three.
    { x: 280, y: 600 },
    { x: 420, y: 620 },
    { x: 580, y: 600 },
    { x: 700, y: 600 },
    { x: 800, y: 600 },
    { x: 800, y: 120 },
    { x: 900, y: 120 },
    { x: 1020, y: 120 },
    { x: 1150, y: 100 },
    { x: 1280, y: 120 },
    { x: 1400, y: 120 },
    { x: 1500, y: 120 },
    { x: 1500, y: 600 },
    { x: 1600, y: 600 },
    { x: 1800, y: 620 },
    { x: 2180, y: 600 },
    // Paid shortcuts: visible inside the paired patrols, safe only at range.
    { x: 400, y: 240 },
    { x: 500, y: 480 },
    { x: 1100, y: 240 },
    { x: 1200, y: 480 },
    { x: 1800, y: 240 },
    { x: 1900, y: 480 },
  ],
  hazards: [
    [
      { x: 300, y: 320 },
      { x: 600, y: 320 },
      { x: 450, y: 390 },
    ],
    [
      { x: 320, y: 400 },
      { x: 580, y: 400 },
      { x: 450, y: 330 },
    ],
    [
      { x: 1000, y: 320 },
      { x: 1300, y: 320 },
      { x: 1150, y: 390 },
    ],
    [
      { x: 1020, y: 400 },
      { x: 1280, y: 400 },
      { x: 1150, y: 330 },
    ],
    [
      { x: 1700, y: 320 },
      { x: 1990, y: 320 },
      { x: 1850, y: 390 },
    ],
    [
      { x: 1720, y: 400 },
      { x: 1970, y: 400 },
      { x: 1850, y: 330 },
    ],
  ],
};

export const LEVELS: LevelConfig[] = [
  {
    index: 1,
    name: "The Edge of the Dark",
    moteCount: 14,
    requiredMotes: 10,
    hazardCount: 2,
    hazardSpeed: 70,
    mood: "dusk",
    layout: LEVEL_1_LAYOUT,
  },
  {
    index: 2,
    name: "Where the Trees Close In",
    moteCount: 18,
    requiredMotes: 13,
    hazardCount: 4,
    hazardSpeed: 95,
    mood: "deep-night",
    layout: LEVEL_2_LAYOUT,
  },
  {
    index: 3,
    name: "The Last Clearing",
    moteCount: 22,
    requiredMotes: 16,
    hazardCount: 6,
    hazardSpeed: 120,
    mood: "storm-dark",
    layout: LEVEL_3_LAYOUT,
  },
  {
    index: 4,
    name: "The Hollow",
    moteCount: 0,
    requiredMotes: 0,
    hazardCount: 3,
    hazardSpeed: 100,
    mood: "ember-dark",
    kind: "kindle",
  },
];

export function levelFor(index: number): LevelConfig | undefined {
  return LEVELS.find((l) => l.index === index);
}
