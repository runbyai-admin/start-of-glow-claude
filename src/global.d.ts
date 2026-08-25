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
  /** Wind zones active this level (round 2, level 3's storm mechanic); empty or absent elsewhere. */
  winds?: Array<{ x: number; y: number; w: number; h: number; vx: number; vy: number }>;
}

interface Window {
  __glow?: GlowTestState;
}
