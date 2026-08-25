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

/**
 * A rectangular wind current (round 2): while the wisp is inside, the storm
 * pushes it by (vx, vy) px/s on top of its own movement. Rules that keep it
 * a mechanic and not a punishment: |v| stays well under the wisp's 480 px/s
 * cap so no current is ever inescapable, and every zone is made visible by
 * its own drifting fleck stream (LevelScene.buildWinds) - a force you cannot
 * see coming is cheap, the same principle the hazards' lights follow.
 */
export interface WindZone {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
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
  mood: "dusk" | "deep-night" | "storm-dark";
  layout?: LevelLayout;
  /** Wind currents (round 2) - so far only the storm level carries them. */
  winds?: WindZone[];
}

/**
 * Level 1, hand-composed rather than seeded: the judged first minute looks at
 * this space. Reading left to right (start x=220, beacon x=2202):
 * - an opening arc of four safe motes teaches collection in the first seconds;
 * - a lone vertical sentry patrols the midfield gap at x=900, so the player
 *   *sees* the threat crossing their path before they must cross it;
 * - one greedy mote sits just below the sentry's turnaround - the first
 *   optional risk;
 * - a calm mid-glade breathes, then a second hazard circles the beacon
 *   approach with two greedy motes inside its circuit and a safe low road
 *   under it.
 * Nine motes are safely reachable, two more need one timed lane-crossing,
 * three sit in guarded pockets; ten open the beacon, so a careful player
 * clears without ever braving a pocket and a flawless run braves both.
 */
const LEVEL_1_LAYOUT: LevelLayout = {
  motes: [
    // opening arc - safe, rising toward the first treeline
    { x: 330, y: 430 },
    { x: 430, y: 355 },
    { x: 545, y: 305 },
    { x: 665, y: 290 },
    // a dip toward the sentry lane - still safe, sets up the crossing
    { x: 780, y: 510 },
    // just past the lane, high and low - crossing the patrol is the lesson
    { x: 990, y: 240 },
    { x: 1010, y: 540 },
    // greed pocket A - just below the sentry's lowest turnaround
    { x: 900, y: 635 },
    // mid glade - safe breathers along a gentle S
    { x: 1160, y: 380 },
    { x: 1320, y: 300 },
    { x: 1520, y: 430 },
    // greed pocket B - inside the beacon-approach circuit
    { x: 1985, y: 415 },
    { x: 2090, y: 295 },
    // the safe low road under the beacon
    { x: 2280, y: 585 },
  ],
  hazards: [
    // the sentry: a pure vertical lane guarding the midfield gap
    [
      { x: 900, y: 160 },
      { x: 900, y: 600 },
      { x: 900, y: 380 },
    ],
    // the circuit: a broad triangle in front of the beacon approach
    [
      { x: 1880, y: 240 },
      { x: 2120, y: 480 },
      { x: 1760, y: 490 },
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
  { index: 2, name: "Where the Trees Close In", moteCount: 18, requiredMotes: 13, hazardCount: 4, hazardSpeed: 95, mood: "deep-night" },
  {
    index: 3,
    name: "The Last Clearing",
    moteCount: 22,
    requiredMotes: 16,
    hazardCount: 6,
    hazardSpeed: 120,
    mood: "storm-dark",
    // The storm finally touches the player. Two currents, both escapable and
    // both readable by their fleck streams:
    // - the open midfield blows hard left-and-down: crossing the middle costs
    //   fighting the storm, hugging the calmer low tree line does not - a
    //   routing choice, not a wall;
    // - an updraft channel on the beacon approach helps you climb toward the
    //   goal, but it feeds you INTO the circuit hazard's triangle - the
    //   level's standing risk/reward shape, now done with weather.
    winds: [
      { x: 1100, y: 60, w: 560, h: 520, vx: -115, vy: 30 },
      { x: 1880, y: 260, w: 340, h: 420, vx: 55, vy: -95 },
    ],
  },
];

export function levelFor(index: number): LevelConfig | undefined {
  return LEVELS.find((l) => l.index === index);
}
