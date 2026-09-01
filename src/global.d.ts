/** State the active scene publishes for the smoke tests. See each scene's reportState(). */
interface GlowTestState {
  ready: boolean;
  scene: "menu" | "level" | "ending";
  collected: number;
  remaining: number;
  glowRadius: number;
  lightsActive: boolean;
  /** 0 outside a level (menu/ending), otherwise the 1-based level index. */
  level: number;
  /** How many times a hazard has snuffed the player's light this run. */
  resets: number;
  /** Motes that open this level's beacon; 0 outside a level. */
  required: number;
  /** True once the beacon has opened (the required count is reached). */
  beaconOpen: boolean;
  /** Flawless levels (every mote found) completed so far this run. */
  flawless: number;
  /** Live wisp world position inside a level; 0 outside one. */
  wispX: number;
  wispY: number;
  /** World positions of the motes still uncollected / the patrolling hazards; empty outside a level. */
  motes: Array<{ x: number; y: number }>;
  hazards: Array<{ x: number; y: number }>;
  /** How far the light currently reaches - the pull radius and the lit radius are one number. */
  reach?: number;
  /** Presses of the gather this level attempt. */
  gathers?: number;
  /** Whether the wisp is fully kindled and can pay for another gather. */
  gatherReady?: boolean;
  deniedGathers?: number;
  touchedMotes?: number;
  gatheredMotes?: number;
  /** Visible lumen-chain state; zero outside an active chain. */
  chain?: number;
  chainRemainingMs?: number;
  /** Number of cap waves released in this level attempt and hazards currently slowed. */
  radianceWaves?: number;
  slowedHazards?: number;
  /** The Hollow (act 4) only: hearth progress and positions for scripted play. */
  hearthsLit?: number;
  hearthsTotal?: number;
  hearths?: Array<{ x: number; y: number; lit: boolean; final: boolean }>;
  kindles?: number;
  /** Threads from lit hearths to the next cold one, and how hard one is carrying the wisp right now (0..1). */
  leylines?: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  carried?: number;
}

interface Window {
  __glow?: GlowTestState;
  /** Only present under ?glow-replay= - see src/replay.ts. */
  __glowReplay?: import("./replay").GlowReplay;
}
