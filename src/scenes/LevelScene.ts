import Phaser from "phaser";
import {
  makeGlowTexture,
  makeGroundTexture,
  makeHazardTexture,
  makeHillsTexture,
  makeSkyTexture,
  makeTreeTexture,
} from "../textures";
import type { Ambience } from "../audio";
import { levelFor, LEVELS, type LevelConfig } from "../levels";
import { VIEW_HEIGHT, VIEW_WIDTH, WORLD_HEIGHT, WORLD_WIDTH } from "./dimensions";
import { advanceChain, chainActiveForLevel, CHAIN_CAP, CHAIN_WINDOW_MS, emptyChain, expireChain, resetChain, type ChainState } from "../chain";
import {
  REACH_MAX,
  REACH_MIN,
  REACH_START,
  reachReadiness,
  reachReady,
  restoreReach,
  spendReach,
  type MoteArrival,
} from "../reach";
import {
  EMBER_RESTORE,
  EMBERS_PER_HEARTH,
  HEARTH_BREATH_MAX_STANDING,
  HEARTH_BREATH_MS,
  HEARTH_POOL_RADIUS,
  HOLLOW_LAYOUT,
  LEYLINE_HALF_WIDTH,
  hearthStates,
  finalUnlocked,
  kindleTarget,
  leylineAt,
  leylineBoost,
  leylinePoint,
  leylines,
  type HearthState,
  type Leyline,
} from "../hollow";

const COLLECT_RADIUS = 45;
const HAZARD_RADIUS = 34;
const BEACON_RADIUS = 90;
const BEACON_X = WORLD_WIDTH * 0.86;
const BEACON_Y = WORLD_HEIGHT * 0.34;
const START_X = 220;
const START_Y = WORLD_HEIGHT * 0.62;
const RESPAWN_GRACE_MS = 1100;
const TREE_COUNT = 14;
const FIREFLY_COUNT = 11;
/**
 * Shared speed cap, keyboard and mouse alike - see the note in update().
 * Raised from the old keyboard-only 347 once capping mouse input to that
 * same number exposed it as too slow for a cursor-chasing light: closing a
 * full 1280px viewport width took ~3.7s and made ordinary repositioning
 * feel sluggish, not just hazard-avoidance fair. 480 keeps a real, equal
 * cap for both inputs (still finite, unlike the old unbounded mouse case)
 * while staying comfortably above every level's hazardSpeed (4x the
 * fastest, level 3's 120) so avoidance is still a real skill, not a freebie.
 */
const WISP_MAX_SPEED = 480;
/**
 * How far a shadow notices the light from. Not a constant any more: a shadow
 * sees the light, so the distance scales with the player's own reach (see
 * alertRadius()). A wisp burning at full reach wakes the glade from a long way
 * off; one that has just spent itself on a pull goes nearly unseen. Noticing
 * is only a look, though - the chase speed ramps in from ALERT_RADIUS_FLOOR,
 * which is fixed. See checkHazardAlerts().
 */
const ALERT_RADIUS_FLOOR = HAZARD_RADIUS * 2.4;
const ALERT_RADIUS_PER_REACH = 0.6;
const ALERT_RADIUS_CEILING = 290;
const ALERT_TIME_SCALE = 1.55;
const ALERT_LIGHT_INTENSITY = 1.55;
const CALM_LIGHT_INTENSITY = 0.9;
const RADIANCE_RADIUS = 390;
const RADIANCE_SLOW_MS = 1800;
const RADIANCE_TIME_SCALE = 0.42;

/**
 * The reach. This round's one verb: your glow is how far you can pull light in,
 * and pulling spends it. Press (click, tap or space) and every mote inside the
 * lit circle comes to you. A pull burns a full glow to its floor, and light
 * carried in by the pull gives back only a glimmer. Walking through five motes
 * rekindles a four-mote reach; until then the press is visibly spent. That makes
 * reaching a choice about which cluster is worth going dark for, rather than a
 * button whose own reward immediately buys another press.
 * The lit radius IS the rule: nothing to read, because you can see exactly as
 * far as you can reach.
 */
const GATHER_COOLDOWN_MS = 420;
/** A reach takes an armful, not a room; the rest stays on the ground. */
const GATHER_MAX_MOTES = 4;
/** Per-mote stagger on the way in - the cascade is the reward, so it lands as notes, not a chord. */
const GATHER_STAGGER_MS = 62;
const GATHER_FLIGHT_MS = 300;

interface LevelInitData {
  levelIndex: number;
  ambience: Ambience;
  resets?: number;
  /** Flawless levels (every mote found) completed earlier in this run. */
  flawless?: number;
  /** The player has already pressed once this run - do not teach the reach again. */
  taught?: boolean;
}

/** Cosmetic per-mood tint - purely a palette shift between stages, same shapes. */
const MOOD_TINT: Record<LevelConfig["mood"], { tree: number[]; ground: number; hillsTint: number }> = {
  dusk: { tree: [0x1b2438, 0x161d2e, 0x141a2a], ground: 0x10151f, hillsTint: 0x0d1526 },
  "deep-night": { tree: [0x141a2c, 0x101624, 0x0e1220], ground: 0x0b0f18, hillsTint: 0x0a0f1e },
  "storm-dark": { tree: [0x171226, 0x120e1e, 0x0f0c1a], ground: 0x0d0a16, hillsTint: 0x120c22 },
  // The Hollow: burnt wood, no blue left in it. The sky is tinted down in
  // buildSky and the fireflies stay away - a kindled hearth is the only
  // living light this act starts with.
  "ember-dark": { tree: [0x201014, 0x180c10, 0x120a0c], ground: 0x0e0806, hillsTint: 0x120808 },
};

/**
 * The reusable stage. One scene, driven entirely by LevelConfig data (see
 * src/levels.ts) - three levels means three configs, not three classes.
 * Everything from BootScene's original slice (Light2D, parallax, the
 * breathing light, ambience) lives here, plus the structure the game was
 * missing after round 1: a real goal (the beacon), a real threat (hazards),
 * and a fail state that costs the player something (this level's progress).
 */
export class LevelScene extends Phaser.Scene {
  private config!: LevelConfig;
  private ambience!: Ambience;
  private resets = 0;
  private flawlessLevels = 0;

  private wisp!: Phaser.GameObjects.Image;
  private wispLight!: Phaser.GameObjects.Light;
  private beacon!: Phaser.GameObjects.Image;
  private beaconLight!: Phaser.GameObjects.Light;
  private trail!: Phaser.GameObjects.Particles.ParticleEmitter;
  private hazardTrail!: Phaser.GameObjects.Particles.ParticleEmitter;

  private moteConfigs: Array<{ x: number; y: number }> = [];
  private motes: Phaser.GameObjects.Image[] = [];
  private hazards: Array<{
    img: Phaser.GameObjects.Image;
    light: Phaser.GameObjects.Light;
    /** Patrol path, walked in update() on the scene clock - see patrolStep(). */
    waypoints: Phaser.Math.Vector2[];
    nextWaypoint: number;
    alert: boolean;
    /** 0 at the edge of notice, 1 at hunting range - the speed-up ramps across it. */
    pressure: number;
    slowUntil: number;
  }> = [];

  private hud!: Phaser.GameObjects.Text;
  private levelCard!: Phaser.GameObjects.Text;
  private openLine!: Phaser.GameObjects.Text;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;
  private target = new Phaser.Math.Vector2(START_X, START_Y);
  private chainArc!: Phaser.GameObjects.Graphics;
  private chainText!: Phaser.GameObjects.Text;

  private reachRing!: Phaser.GameObjects.Graphics;
  private reachLine?: Phaser.GameObjects.Text;
  private inviteAt = 0;
  private lastShakeAt = 0;
  private gutter = 0;
  private deathVeil!: Phaser.GameObjects.Rectangle;
  private arrivalVeil!: Phaser.GameObjects.Rectangle;
  private inviteShown = 0;
  private incoming: Phaser.GameObjects.Image[] = [];

  /** The Hollow's hearths - empty in gather levels. See src/hollow.ts. */
  private hearths: Array<{
    state: HearthState;
    img: Phaser.GameObjects.Image;
    halo: Phaser.GameObjects.Image;
    light?: Phaser.GameObjects.Light;
    breathAt: number;
    socket?: Phaser.GameObjects.Arc;
  }> = [];
  private kindles = 0;
  private kindleLine?: Phaser.GameObjects.Text;
  /**
   * Kindles in flight, keyed to GAME time. Phaser's TweenManager runs on
   * Date.now() (wall clock), so under the fixed-step replay harness a tween
   * crawls relative to game frames - fine for decoration, fatal for progress.
   * Anything that gates state lives here and resolves in update().
   */
  private pendingKindles: Array<{ hearth: number; igniteAt: number }> = [];
  private hollowEndAt = 0;
  /** Threads of light from every lit hearth to the next cold one - see src/hollow.ts leylines. */
  private leylineNow: Leyline[] = [];
  private leylineGfx?: Phaser.GameObjects.Graphics;
  private roadLine?: Phaser.GameObjects.Text;
  /** Whether the thread carried the wisp this frame - drives the glow and the play driver's state. */
  private carried = 0;
  private carrySparks?: Phaser.GameObjects.Particles.ParticleEmitter;

  private collected = 0;
  /** Motes actually placed this level - derived from the data used, never assumed from config. */
  private totalMotes = 0;
  private pulseBoost = 0;
  /** How far the light reaches right now - the light's radius, the pull's radius, one number. */
  private reach = REACH_START;
  private gatherReadyAt = 0;
  private gathers = 0;
  private deniedGathers = 0;
  private touchedMotes = 0;
  private gatheredMotes = 0;
  private costShown = false;
  /** Motes were in reach and the player has not pressed yet - drives the wordless invitation. */
  private taught = false;
  private levelClear = false;
  /** Every mote currently collected - the flawless variant is showing. */
  private flawlessNow = false;
  private locked = false;
  private graceUntil = 0;
  private chainState: ChainState = emptyChain();

  constructor() {
    super("level");
  }

  init(data: LevelInitData): void {
    this.config = levelFor(data.levelIndex) ?? LEVELS[0];
    this.ambience = data.ambience;
    this.resets = data.resets ?? 0;
    this.flawlessLevels = data.flawless ?? 0;
    this.collected = 0;
    this.totalMotes = 0;
    this.pulseBoost = 0;
    this.reach = REACH_START;
    this.gatherReadyAt = 0;
    this.gathers = 0;
    this.deniedGathers = 0;
    this.touchedMotes = 0;
    this.gatheredMotes = 0;
    this.costShown = false;
    this.inviteAt = 0;
    this.inviteShown = 0;
    this.gutter = 0;
    this.reachLine = undefined;
    this.taught = data.taught ?? false;
    this.levelClear = false;
    this.flawlessNow = false;
    this.locked = false;
    this.chainState = emptyChain();
    this.moteConfigs = [];
    this.motes = [];
    this.incoming = [];
    this.hazards = [];
    this.hearths = [];
    this.kindles = 0;
    this.kindleLine = undefined;
    this.pendingKindles = [];
    this.hollowEndAt = 0;
    this.leylineNow = [];
    this.leylineGfx = undefined;
    this.roadLine = undefined;
    this.carried = 0;
    this.target.set(START_X, START_Y);
  }

  /** The Hollow reverses the verb - almost every branch in this scene keys off this. */
  private isKindle(): boolean {
    return this.config.kind === "kindle";
  }

  preload(): void {
    makeGlowTexture(this, "wisp", 85, "rgba(255,255,255,1)", "rgba(150,214,255,0.55)");
    makeGlowTexture(this, "mote", 27, "rgba(255,244,214,1)", "rgba(255,196,92,0.5)");
    makeGlowTexture(this, "spark", 16, "rgba(255,255,255,0.9)", "rgba(190,226,255,0.35)");
    makeGlowTexture(this, "firefly", 12, "rgba(226,255,196,1)", "rgba(198,255,130,0.4)");
    makeGlowTexture(this, "beacon", 170, "rgba(255,226,168,1)", "rgba(255,182,102,0.4)");
    makeGlowTexture(this, "shadow-spark", 10, "rgba(150,110,220,0.85)", "rgba(90,50,150,0.3)");
    makeGlowTexture(this, "hearth", 46, "rgba(255,150,80,0.95)", "rgba(150,55,25,0.35)");
    makeGlowTexture(this, "hearth-halo", 150, "rgba(255,180,110,0.5)", "rgba(200,90,40,0.18)");
    makeGlowTexture(this, "ember", 18, "rgba(255,190,120,1)", "rgba(255,120,50,0.5)");
    if (this.isKindle()) makeTreeTexture(this, "great-tree", 420, 700, 9);
    makeHazardTexture(this, `hazard-${this.config.index}`, 30, this.config.index * 97);
    makeSkyTexture(this, "sky", VIEW_WIDTH, VIEW_HEIGHT, 11);
    makeHillsTexture(this, "hills", 1760, 260, 3);
    makeGroundTexture(this, "ground", WORLD_WIDTH, 240, 7);
    for (let i = 0; i < 4; i += 1) {
      makeTreeTexture(this, `tree-${i}`, 240, 560, i + 1);
    }
  }

  create(): void {
    this.lights.enable().setAmbientColor(0x0a0d18);
    this.cameras.main.setBackgroundColor(0x05060c);

    this.buildSky();
    this.buildHills();
    this.buildForest();
    if (!this.isKindle()) {
      this.buildBeacon();
      this.buildFireflies();
    }
    this.buildMotes();
    if (this.isKindle()) this.buildHearths();
    this.buildWisp();
    this.buildHazards();
    this.buildStorm();
    this.buildAsh();
    this.buildCamera();
    this.buildVignette();
    this.buildHud();
    this.bindInput();

    this.ambience.setStorm(this.config.mood === "storm-dark");

    this.graceUntil = this.time.now + RESPAWN_GRACE_MS;
    this.cameras.main.fadeIn(420, 5, 6, 12);
    this.events.once(Phaser.Scenes.Events.POST_UPDATE, () => this.announceReady());
  }

  private buildSky(): void {
    const sky = this.add.image(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, "sky").setScrollFactor(0).setDepth(-100);
    // The Hollow has no night sky worth the name: the stars are choked to a
    // dim rust wash, so the first kindled hearth visibly gives the act its light.
    if (this.isKindle()) sky.setTint(0x55261a).setAlpha(0.8);
  }

  /**
   * Ash instead of fireflies: the Hollow's air is full of dead light, falling
   * slowly. Purely atmospheric, and grey on purpose - everything warm in this
   * act has to be something the player lit.
   */
  private buildAsh(): void {
    if (!this.isKindle()) return;
    const ash = this.add.particles(0, 0, "spark", {
      x: { min: -60, max: VIEW_WIDTH + 60 },
      y: { min: -40, max: VIEW_HEIGHT },
      speedX: { min: -14, max: 10 },
      speedY: { min: 8, max: 26 },
      lifespan: { min: 2600, max: 5200 },
      scale: { start: 0.28, end: 0.08 },
      alpha: { start: 0.2, end: 0 },
      quantity: 1,
      frequency: 90,
      tint: [0x6a5f58, 0x4a423d, 0x84766c],
    });
    ash.setScrollFactor(0.85).setDepth(-6);
  }

  private buildHills(): void {
    const tint = MOOD_TINT[this.config.mood].hillsTint;
    this.add.image(0, WORLD_HEIGHT - 150, "hills").setOrigin(0, 1).setTint(tint).setScrollFactor(0.25).setDepth(-40);
  }

  private buildForest(): void {
    const rng = new Phaser.Math.RandomDataGenerator([`start-of-glow-trees-${this.config.index}`]);
    const tints = MOOD_TINT[this.config.mood].tree;
    for (let i = 0; i < TREE_COUNT; i += 1) {
      const x = 60 + (i / (TREE_COUNT - 1)) * (WORLD_WIDTH - 120) + rng.between(-45, 45);
      const tree = this.add
        .image(x, WORLD_HEIGHT - 120 + rng.between(-8, 8), `tree-${i % 4}`)
        .setOrigin(0.5, 1)
        .setScale(rng.realInRange(0.75, 1.3))
        .setTint(tints[rng.between(0, tints.length - 1)])
        .setDepth(-30);
      tree.setPipeline("Light2D");
    }

    const ground = this.add
      .image(0, WORLD_HEIGHT, "ground")
      .setOrigin(0, 1)
      .setTint(MOOD_TINT[this.config.mood].ground)
      .setDepth(-10);
    ground.setPipeline("Light2D");
  }

  /** Dark until every mote in the level is found - then it lights, and pulls the player in for the arrival. */
  private buildBeacon(): void {
    this.beacon = this.add.image(BEACON_X, BEACON_Y, "beacon").setBlendMode(Phaser.BlendModes.ADD).setDepth(-35).setAlpha(0.05);
    this.beaconLight = this.lights.addLight(BEACON_X, BEACON_Y, 260, 0xffcf8a, 0);
  }

  private buildFireflies(): void {
    const rng = new Phaser.Math.RandomDataGenerator([`start-of-glow-fireflies-${this.config.index}`]);
    for (let i = 0; i < FIREFLY_COUNT; i += 1) {
      const startX = rng.between(60, WORLD_WIDTH - 60);
      const startY = rng.between(180, WORLD_HEIGHT - 100);
      const firefly = this.add
        .image(startX, startY, "firefly")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScrollFactor(0.75)
        .setScale(rng.realInRange(0.5, 1))
        .setAlpha(rng.realInRange(0.35, 0.8))
        .setDepth(-5);

      this.tweens.add({
        targets: firefly,
        x: startX + rng.between(-70, 70),
        y: startY + rng.between(-50, 50),
        duration: rng.between(3600, 6200),
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      this.tweens.add({
        targets: firefly,
        alpha: { from: firefly.alpha * 0.4, to: firefly.alpha },
        duration: rng.between(900, 1700),
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
        delay: rng.between(0, 800),
      });
    }
  }

  private buildMotes(): void {
    if (this.isKindle()) {
      // Wild embers: the Hollow's only walking food before a hearth burns.
      this.moteConfigs = HOLLOW_LAYOUT.embers.map((m) => ({ ...m }));
      this.totalMotes = this.moteConfigs.length;
      this.spawnMotes();
      return;
    }
    if (this.config.layout) {
      this.moteConfigs = this.config.layout.motes.map((m) => ({ ...m }));
    } else {
      const rng = new Phaser.Math.RandomDataGenerator([`start-of-glow-${this.config.index}`]);
      const near = Math.ceil(this.config.moteCount / 2);
      for (let i = 0; i < this.config.moteCount; i += 1) {
        const x = i < near ? rng.between(80, VIEW_WIDTH - 80) : rng.between(VIEW_WIDTH + 40, WORLD_WIDTH - 80);
        this.moteConfigs.push({ x, y: rng.between(140, WORLD_HEIGHT - 160) });
      }
    }
    this.totalMotes = this.moteConfigs.length;
    this.spawnMotes();
  }

  private spawnMotes(): void {
    for (const m of this.motes.concat(this.incoming)) {
      this.tweens.killTweensOf(m);
      m.destroy();
    }
    this.motes = [];
    this.incoming = [];
    const rng = new Phaser.Math.RandomDataGenerator([`start-of-glow-motes-${this.config.index}`]);
    const texture = this.isKindle() ? "ember" : "mote";
    const scale = this.isKindle() ? 0.8 : 0.55;
    for (const cfg of this.moteConfigs) {
      const mote = this.add.image(cfg.x, cfg.y, texture).setBlendMode(Phaser.BlendModes.ADD).setScale(scale).setDepth(5);
      // Collection is judged against this, not the bobbing draw position: the
      // bob tween rides the wall clock, and a pickup that depends on where the
      // bob happens to be makes two replays of the same inputs disagree.
      mote.setData("restX", cfg.x);
      mote.setData("restY", cfg.y);
      this.tweens.add({
        targets: mote,
        y: cfg.y - rng.between(8, 21),
        alpha: { from: 0.55, to: 1 },
        duration: rng.between(1200, 2200),
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      this.motes.push(mote);
    }
  }

  /**
   * The Hollow's hearths: dormant embers barely holding on, each waiting to
   * take a full press of light. The First Tree renders bigger and darker -
   * it visibly belongs to the same family but is not takeable until every
   * lesser hearth burns (src/hollow.ts kindleTarget owns that rule).
   */
  private buildHearths(): void {
    for (const state of hearthStates(HOLLOW_LAYOUT)) {
      const scale = state.final ? 1.5 : 0.9;
      // The First Tree is a place, not a pickup: a dead giant looming over
      // the east end of the Hollow with the final hearth as its heart. It
      // takes the Light2D pipeline, so the moment its hearth lights, the
      // trunk itself catches the glow.
      if (state.final) {
        this.add
          .image(state.x, WORLD_HEIGHT - 60, "great-tree")
          .setOrigin(0.5, 1)
          .setScale(1.1)
          .setTint(0x1a1016)
          .setDepth(-25)
          .setPipeline("Light2D");
      }
      const halo = this.add
        .image(state.x, state.y, "hearth-halo")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(scale)
        .setAlpha(0)
        .setDepth(3);
      const img = this.add
        .image(state.x, state.y, "hearth")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(scale * 0.7)
        .setAlpha(0.28)
        .setDepth(5);
      // A dormant hearth barely breathes - enough to be findable in the dark,
      // never enough to light anything.
      this.tweens.add({
        targets: img,
        alpha: { from: 0.18, to: 0.4 },
        duration: 1700 + state.x % 900,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      // A thin cold ring marks a dormant hearth as a socket waiting for the
      // light, so it never reads as one more ember to walk into. It goes the
      // moment the hearth takes a press.
      const socket = this.add
        .circle(state.x, state.y, state.final ? 52 : 34, 0x000000, 0)
        .setStrokeStyle(1.5, 0xc9a289, 0.4)
        .setDepth(4);
      this.hearths.push({ state, img, halo, breathAt: 0, socket });
    }
    // The threads are redrawn every frame (five segments at most): they
    // flow, and they brighten under the wisp while it is being carried.
    this.leylineGfx = this.add.graphics().setBlendMode(Phaser.BlendModes.ADD).setDepth(2);
  }

  /**
   * Draw the leylines: a wide faint band that says "road", a thin bright
   * core, and beads of light running from the lit hearth toward the cold
   * one so the direction reads without a word.
   */
  private drawLeylines(time: number): void {
    const g = this.leylineGfx;
    if (!g) return;
    g.clear();
    if (this.leylineNow.length === 0) return;
    const flow = (time * 0.00009) % 1;
    for (const line of this.leylineNow) {
      const under = this.carried > 0 && leylineAt([line], this.wisp.x, this.wisp.y) !== undefined;
      const lift = under ? 0.5 * this.carried : 0;
      g.lineStyle(LEYLINE_HALF_WIDTH * 1.4, 0xff8a45, 0.045 + lift * 0.05);
      g.lineBetween(line.from.x, line.from.y, line.to.x, line.to.y);
      g.lineStyle(2, 0xffc890, 0.22 + lift * 0.4);
      g.lineBetween(line.from.x, line.from.y, line.to.x, line.to.y);
      const len = Math.hypot(line.to.x - line.from.x, line.to.y - line.from.y);
      const beads = Math.max(3, Math.floor(len / 64));
      for (let i = 0; i < beads; i += 1) {
        const t = (i / beads + flow) % 1;
        const p = leylinePoint(line, t);
        // Beads fade in at the lit end and out at the cold one - a breath
        // travelling toward the hearth still to be given.
        const a = Math.sin(t * Math.PI) * (0.35 + lift * 0.4);
        g.fillStyle(0xffd9a8, a);
        g.fillCircle(p.x, p.y, 3.2 + lift * 1.5);
      }
    }
  }

  private buildWisp(): void {
    this.trail = this.add.particles(0, 0, "spark", {
      speed: { min: 6, max: 30 },
      lifespan: { min: 500, max: 1100 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 0.55, end: 0 },
      tint: [0xffffff, 0x9fd8ff, 0xffe6a8],
      blendMode: Phaser.BlendModes.ADD,
      frequency: 40,
      quantity: 1,
      emitZone: { type: "random", source: new Phaser.Geom.Circle(0, 0, 19), quantity: 1 },
    });
    this.trail.setDepth(9);

    this.wisp = this.add.image(this.target.x, this.target.y, "wisp").setBlendMode(Phaser.BlendModes.ADD).setScale(0.5).setDepth(10);
    this.wispLight = this.lights.addLight(this.wisp.x, this.wisp.y, REACH_START, 0xbfe4ff, 1.6);
    this.trail.startFollow(this.wisp);
    // The road's tail: warm sparks that stream off the wisp only while a
    // thread is carrying it, fired by hand each frame so speed reads as
    // light being shed, not as a permanent costume.
    if (this.isKindle()) {
      this.carrySparks = this.add.particles(0, 0, "spark", {
        speed: { min: 40, max: 120 },
        lifespan: { min: 350, max: 700 },
        scale: { start: 0.7, end: 0 },
        alpha: { start: 0.7, end: 0 },
        tint: [0xffc890, 0xff9a55, 0xffe6a8],
        blendMode: Phaser.BlendModes.ADD,
        emitting: false,
      });
      this.carrySparks.setDepth(9);
    }

    // The edge of the light, drawn thin. Light2D already falls off at exactly
    // this radius, but a soft gradient does not tell you where the rule ends -
    // this does, and it only becomes bright when there is something to take.
    this.reachRing = this.add.graphics().setDepth(4);
    // One source of truth for the wisp's size: derive the spawn scale from the
    // starting reach rather than leaving a hand-set 0.5 that the first collect
    // would silently correct.
    this.setReach(REACH_START);
  }

  /**
   * Shadow-wisps: the thing the light is not. Each patrols a small loop of
   * waypoints (deterministic per level+index) at the level's hazardSpeed.
   * Touching one snuffs the player's light and resets the level's progress -
   * see fail(). They carry a dim cold light of their own, not because a real
   * shadow would, but because a threat the player cannot see coming in a
   * game about darkness is cheap, not hard.
   */
  private buildHazards(): void {
    const trailEmitter = this.add.particles(0, 0, "shadow-spark", {
      speed: { min: 4, max: 16 },
      lifespan: { min: 300, max: 650 },
      scale: { start: 0.5, end: 0 },
      alpha: { start: 0.5, end: 0 },
      blendMode: Phaser.BlendModes.ADD,
      frequency: 70,
      quantity: 1,
    });
    trailEmitter.setDepth(8);
    this.hazardTrail = trailEmitter;

    const rng = new Phaser.Math.RandomDataGenerator([`start-of-glow-hazards-${this.config.index}`]);
    const authored = this.isKindle() ? HOLLOW_LAYOUT.hazards : this.config.layout?.hazards;
    const count = authored ? authored.length : this.config.hazardCount;
    for (let i = 0; i < count; i += 1) {
      const img = this.add
        .image(0, 0, `hazard-${this.config.index}`)
        .setDepth(6)
        .setScale(rng.realInRange(0.85, 1.15));
      const light = this.lights.addLight(0, 0, 130, 0x9a6efa, CALM_LIGHT_INTENSITY);

      const waypoints: Phaser.Math.Vector2[] = [];
      if (authored) {
        for (const w of authored[i]) {
          waypoints.push(new Phaser.Math.Vector2(w.x, w.y));
        }
      } else {
        const legs = 3;
        for (let w = 0; w < legs; w += 1) {
          waypoints.push(
            new Phaser.Math.Vector2(rng.between(340, WORLD_WIDTH - 100), rng.between(120, WORLD_HEIGHT - 140)),
          );
        }
      }
      img.setPosition(waypoints[0].x, waypoints[0].y);
      light.setPosition(waypoints[0].x, waypoints[0].y);
      this.hazards.push({ img, light, waypoints, nextWaypoint: 1, alert: false, pressure: 0, slowUntil: 0 });
    }
  }

  /**
   * Walk every patrol on the scene clock. This used to be a chain of tweens,
   * but Phaser's TweenManager advances on Date.now() - under the fixed-step
   * replay harness the shadows stood almost still while the wisp played a
   * whole level, so every persona metric about danger was fiction. Constant
   * speed along each leg, the alert/slow logic scaling dt exactly as it used
   * to scale the tween.
   */
  private patrolStep(dt: number): void {
    for (const h of this.hazards) {
      const speed = this.config.hazardSpeed * this.hazardTimeScale(h);
      let remaining = speed * dt;
      while (remaining > 0) {
        const next = h.waypoints[h.nextWaypoint % h.waypoints.length];
        const dist = Phaser.Math.Distance.Between(h.img.x, h.img.y, next.x, next.y);
        if (dist <= remaining) {
          h.img.setPosition(next.x, next.y);
          h.nextWaypoint = (h.nextWaypoint + 1) % h.waypoints.length;
          remaining -= dist;
        } else {
          h.img.setPosition(h.img.x + ((next.x - h.img.x) / dist) * remaining, h.img.y + ((next.y - h.img.y) / dist) * remaining);
          remaining = 0;
        }
      }
      h.light.setPosition(h.img.x, h.img.y);
    }
  }

  /**
   * The storm-dark weather layer - level 3's identity beyond a palette shift.
   * Wind-blown flecks drift left across the near field, and a seeded flicker
   * schedule fires distant lightning behind the hills (a screen-space wash
   * above the sky, below everything else) with a soft thunder swell. Fully
   * deterministic per run, like every other moving part in a level.
   */
  private buildStorm(): void {
    if (this.config.mood !== "storm-dark") return;

    const flecks = this.add.particles(0, 0, "spark", {
      x: { min: -120, max: VIEW_WIDTH + 260 },
      y: { min: -60, max: VIEW_HEIGHT },
      speedX: { min: -150, max: -80 },
      speedY: { min: 18, max: 42 },
      lifespan: { min: 1300, max: 2400 },
      scale: { start: 0.3, end: 0.08 },
      alpha: { start: 0.3, end: 0 },
      quantity: 1,
      frequency: 55,
      tint: [0x8a9fd8, 0x6f83c4, 0xa9b8e8],
      blendMode: Phaser.BlendModes.ADD,
    });
    flecks.setScrollFactor(0.9).setDepth(-8);

    const rng = new Phaser.Math.RandomDataGenerator([`start-of-glow-storm-${this.config.index}`]);
    const flash = this.add
      .rectangle(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, VIEW_WIDTH, VIEW_HEIGHT, 0xcdd8ff)
      .setScrollFactor(0)
      .setAlpha(0)
      .setDepth(-90);
    const schedule = (): void => {
      this.after(rng.between(6500, 12500), () => {
        if (!flash.active) return;
        this.ambience.rumble();
        this.tweens.add({
          targets: flash,
          alpha: { from: 0, to: 0.07 },
          duration: 90,
          yoyo: true,
          repeat: 1,
          repeatDelay: 60,
          onComplete: () => schedule(),
        });
      });
    };
    schedule();
  }

  /**
   * Noticing and hunting are two different distances. A shadow *sees* the light
   * as far as the light carries (alertRadius, which grows with the reach), and
   * that is a look: its own glow comes up so the player can read it from across
   * the glade. It only *hunts* at close quarters, and the speed-up ramps in
   * between. Coupling the full chase speed to the reach - the first version of
   * this - punished the one player who most needs help, the one who has not
   * found the press yet and is therefore walking around at full brightness.
   *
   * Either way it is the running patrol tween's timeScale that changes, never
   * the path - the patrol shape stays exactly as authored, so a hazard is
   * reactive without ever feeling like it cheated.
   */
  private checkHazardAlerts(): void {
    const notice = this.alertRadius();
    for (const h of this.hazards) {
      const dist = Phaser.Math.Distance.Between(h.img.x, h.img.y, this.wisp.x, this.wisp.y);
      h.alert = dist <= notice;
      h.pressure = h.alert
        ? Phaser.Math.Clamp(1 - (dist - ALERT_RADIUS_FLOOR) / Math.max(1, notice - ALERT_RADIUS_FLOOR), 0, 1)
        : 0;
      h.light.intensity = h.slowUntil > this.time.now
        ? 0.62
        : CALM_LIGHT_INTENSITY + (ALERT_LIGHT_INTENSITY - CALM_LIGHT_INTENSITY) * (h.alert ? 0.4 + 0.6 * h.pressure : 0);
    }
  }

  /** The distance at which a shadow notices the light - as far as the light carries. */
  private alertRadius(): number {
    return Phaser.Math.Clamp(this.reach * ALERT_RADIUS_PER_REACH, ALERT_RADIUS_FLOOR, ALERT_RADIUS_CEILING);
  }

  private hazardTimeScale(hazard: { alert: boolean; pressure: number; slowUntil: number }): number {
    if (hazard.slowUntil > this.time.now) return RADIANCE_TIME_SCALE;
    return 1 + (ALERT_TIME_SCALE - 1) * hazard.pressure;
  }

  private buildCamera(): void {
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.startFollow(this.wisp, false, 0.09, 0.09);
  }

  private buildVignette(): void {
    const width = VIEW_WIDTH;
    const height = VIEW_HEIGHT;
    const key = "vignette";
    if (!this.textures.exists(key)) {
      const texture = this.textures.createCanvas(key, width, height);
      const ctx = texture!.getContext();
      const cx = width / 2;
      const cy = height / 2;
      const gradient = ctx.createRadialGradient(cx, cy, Math.min(width, height) * 0.32, cx, cy, Math.max(width, height) * 0.72);
      gradient.addColorStop(0, "rgba(0,0,0,0)");
      gradient.addColorStop(1, "rgba(0,0,0,0.78)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);
      texture!.refresh();
    }
    this.add.image(width / 2, height / 2, key).setScrollFactor(0).setDepth(90);

    this.deathVeil = this.add
      .rectangle(width / 2, height / 2, width, height, 0x120424)
      .setScrollFactor(0)
      .setAlpha(0)
      .setDepth(94);

    this.arrivalVeil = this.add
      .rectangle(width / 2, height / 2, width, height, 0xffe8c0)
      .setScrollFactor(0)
      .setAlpha(0)
      .setDepth(93)
      .setBlendMode(Phaser.BlendModes.ADD);
  }

  /**
   * Teaching the press without saying it: a ghost of the reach collapsing
   * inward, repeated every couple of seconds while there is something in range
   * and the player has not tried it yet. It is the gather's own animation
   * played at a whisper - the first real press then looks like the answer to
   * a question the screen already asked. It stops for good on that press.
   */
  private inviteGather(): void {
    // Six is asking; more than six is nagging. After that the quiet line on
    // level 1 is the only thing still offering, and the screen goes back to
    // being the player's problem.
    if (this.taught || this.locked || this.inviteShown >= 6 || this.inviteAt > this.time.now) return;
    let inReach = false;
    for (const t of this.pressTargets()) {
      if (Phaser.Math.Distance.Between(t.x, t.y, this.wisp.x, this.wisp.y) <= this.reach) {
        inReach = true;
        break;
      }
    }
    if (!inReach) return;
    this.inviteAt = this.time.now + 2100;
    // The ghost plays the press it is asking for: collapsing inward in the
    // forest (the pull), blooming outward in the Hollow (the gift).
    const kindle = this.isKindle();
    const ghost = this.add
      .circle(this.wisp.x, this.wisp.y, kindle ? 18 : this.reach, kindle ? 0xffb070 : 0xffe2a8, 0)
      .setStrokeStyle(2, kindle ? 0xffb070 : 0xffe2a8, 0.3)
      .setDepth(4);
    this.tweens.add({
      targets: ghost,
      radius: kindle ? this.reach : 18,
      alpha: 0,
      duration: 900,
      ease: kindle ? "Cubic.easeOut" : "Cubic.easeIn",
      onUpdate: () => ghost.setPosition(this.wisp.x, this.wisp.y),
      onComplete: () => ghost.destroy(),
    });
    // Words are the fallback, not the lesson: only after the wordless version
    // has played three times unanswered, and only on the first level.
    this.inviteShown += 1;
    if (this.inviteShown === 3 && this.config.index === 1 && this.reachLine) {
      this.tweens.add({ targets: this.reachLine, alpha: { from: 0, to: 0.75 }, duration: 700, ease: "Sine.easeInOut" });
    }
  }

  private buildHud(): void {
    this.hud = this.add
      .text(27, 24, "", {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "17px",
        color: "#7e93b8",
      })
      .setAlpha(0.85)
      .setDepth(100)
      .setScrollFactor(0);

    this.levelCard = this.add
      .text(VIEW_WIDTH / 2, 46, `${this.config.index} · ${this.config.name}`, {
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: "20px",
        color: "#e7dcc2",
      })
      .setOrigin(0.5, 0)
      .setAlpha(0)
      .setDepth(100)
      .setScrollFactor(0);
    this.tweens.add({
      targets: this.levelCard,
      alpha: { from: 0, to: 0.9 },
      duration: 900,
      yoyo: true,
      hold: 1400,
      ease: "Sine.easeInOut",
    });

    this.openLine = this.add
      .text(VIEW_WIDTH / 2, 80, this.isKindle() ? "the first tree will take the light now" : "the beacon is lit", {
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: "17px",
        color: "#ffd9a0",
      })
      .setOrigin(0.5, 0)
      .setAlpha(0)
      .setDepth(100)
      .setScrollFactor(0);

    if (this.config.index === 1) {
      this.reachLine = this.add
        .text(VIEW_WIDTH / 2, VIEW_HEIGHT - 54, "press · draw the light in", {
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: "17px",
          color: "#ffd9a0",
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(100)
        .setScrollFactor(0);
    }

    // The Hollow reverses the one verb the player has spent three levels
    // learning, so this line does not wait to be earned: it shows on arrival
    // and leaves at the first kindle.
    if (this.isKindle()) {
      this.kindleLine = this.add
        .text(VIEW_WIDTH / 2, VIEW_HEIGHT - 54, "the hearths are cold · press to give the light back", {
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: "17px",
          color: "#ffbe8a",
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(100)
        .setScrollFactor(0);
      this.tweens.add({ targets: this.kindleLine, alpha: 0.8, duration: 1200, delay: 1400, ease: "Sine.easeOut" });
    }

    this.chainArc = this.add.graphics().setDepth(95).setScrollFactor(0);
    this.chainText = this.add.text(VIEW_WIDTH - 28, 24, "", {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "15px",
      color: "#ffd9a0",
      letterSpacing: 2,
    }).setOrigin(1, 0).setDepth(100).setScrollFactor(0);

    this.updateHud();
  }

  private bindInput(): void {
    this.input.on(Phaser.Input.Events.POINTER_MOVE, (pointer: Phaser.Input.Pointer) => {
      if (this.locked) return;
      this.target.set(pointer.worldX, pointer.worldY);
    });
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (pointer: Phaser.Input.Pointer) => {
      this.ambience.unlock();
      if (this.locked) return;
      this.target.set(pointer.worldX, pointer.worldY);
      this.gather();
    });
    this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE).on("down", () => {
      this.ambience.unlock();
      this.gather();
    });
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = {
      up: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
  }

  /**
   * The press. Everything inside the lit circle is drawn in, nearest first, and
   * the circle pays for it. Only a fully kindled glow can reach. The press burns
   * that glow to its floor whether or not it catches anything; moving through
   * light, rather than pulling it, is what earns the next reach.
   */
  private gather(): void {
    if (this.locked || this.time.now < this.gatherReadyAt) return;
    this.gatherReadyAt = this.time.now + GATHER_COOLDOWN_MS;
    if (!reachReady(this.reach)) {
      this.deniedGathers += 1;
      this.gatherDenied();
      this.reportState();
      return;
    }
    if (this.isKindle()) {
      this.kindlePress();
      return;
    }
    this.gathers += 1;
    if (!this.taught) {
      this.taught = true;
      if (this.reachLine) {
        this.tweens.killTweensOf(this.reachLine);
        this.reachLine.setAlpha(0);
      }
    }

    const caught: Array<{ mote: Phaser.GameObjects.Image; d: number }> = [];
    for (let i = this.motes.length - 1; i >= 0; i -= 1) {
      const mote = this.motes[i];
      const d = this.moteRestDistance(mote, this.wisp.x, this.wisp.y);
      if (d > this.reach) continue;
      this.motes.splice(i, 1);
      this.incoming.push(mote);
      caught.push({ mote, d });
    }
    caught.sort((a, b) => a.d - b.d);
    // A reach takes an armful, not a room. The overflow goes straight back so
    // a wide-open press still leaves something to walk to, and the cascade
    // stays a phrase you can hear rather than a chord.
    for (const spare of caught.splice(GATHER_MAX_MOTES)) {
      this.incoming.splice(this.incoming.indexOf(spare.mote), 1);
      this.motes.push(spare.mote);
    }

    const spent = this.reach;
    this.setReach(spendReach(this.reach));
    this.gatherWave(spent, caught.length);
    this.ambience.gather(caught.length);
    this.pulseBoost = caught.length > 0 ? 1.5 : 0.5;
    this.showGatherCost();

    caught.forEach(({ mote, d }, index) => {
      this.tweens.killTweensOf(mote);
      this.tweens.add({
        targets: mote,
        x: () => this.wisp.x,
        y: () => this.wisp.y,
        scale: 0.9,
        alpha: 1,
        delay: index * GATHER_STAGGER_MS,
        duration: GATHER_FLIGHT_MS + d * 0.28,
        ease: "Cubic.easeIn",
        onComplete: () => this.absorb(mote),
      });
    });
  }

  /**
   * The Hollow's press: give the light. The nearest dormant hearth inside the
   * reach takes the whole press - the same cost as the forest's pull, spent
   * the other way. With nothing in range the light stays put: income here is
   * finite, so the press only spends when something is there to receive it
   * (a soft outward ring answers the hand either way).
   */
  private kindlePress(): void {
    const target = kindleTarget(
      this.hearths.map((h) => h.state),
      this.wisp.x,
      this.wisp.y,
      this.reach,
    );
    if (target < 0) {
      this.kindleRefused();
      this.reportState();
      return;
    }
    this.gathers += 1;
    this.kindles += 1;
    if (!this.taught) this.taught = true;
    if (this.kindleLine) {
      this.tweens.killTweensOf(this.kindleLine);
      this.tweens.add({ targets: this.kindleLine, alpha: 0, duration: 420 });
    }

    const hearth = this.hearths[target];
    const spent = this.reach;
    this.setReach(spendReach(this.reach));
    this.pulseBoost = 1.2;

    // The reach leaves the wisp as a visible gift: an outward ring, and a
    // filament of light that runs from the wisp into the hearth.
    const ring = this.add
      .circle(this.wisp.x, this.wisp.y, 20, 0xffb070, 0)
      .setStrokeStyle(3, 0xffb070, 0.85)
      .setDepth(7);
    this.tweens.add({
      targets: ring,
      radius: spent,
      alpha: 0,
      duration: 460,
      ease: "Cubic.easeOut",
      onComplete: () => ring.destroy(),
    });
    // The beam is decorative and may run slow under replay; the ignition is
    // progress and therefore rides GAME time via pendingKindles (see update()).
    const beam = this.add.graphics().setDepth(7);
    const from = { x: this.wisp.x, y: this.wisp.y };
    const progress = { t: 0 };
    this.tweens.add({
      targets: progress,
      t: 1,
      duration: 340,
      ease: "Cubic.easeIn",
      onUpdate: () => {
        beam.clear();
        beam.lineStyle(3, 0xffc088, 0.85 * (1 - progress.t * 0.4));
        beam.lineBetween(
          from.x + (hearth.state.x - from.x) * progress.t,
          from.y + (hearth.state.y - from.y) * progress.t,
          hearth.state.x,
          hearth.state.y,
        );
      },
      onComplete: () => beam.destroy(),
    });
    this.pendingKindles.push({ hearth: this.hearths.indexOf(hearth), igniteAt: this.time.now + 340 });
    // The light has already left the wisp: a shadow that touches it during
    // the flight would kill a player who just paid to unmake that shadow.
    // Watched in play - dead 130ms after a good press on hearth 2.
    this.graceUntil = Math.max(this.graceUntil, this.time.now + 400);
    this.ambience.gather(1);
    this.updateHud();
    this.reportState();
  }

  /** Resolve in-flight kindles and the dawn on the scene clock, never the tween clock. */
  private resolveKindles(): void {
    for (let i = this.pendingKindles.length - 1; i >= 0; i -= 1) {
      const pending = this.pendingKindles[i];
      if (this.time.now < pending.igniteAt) continue;
      this.pendingKindles.splice(i, 1);
      this.igniteHearth(this.hearths[pending.hearth]);
    }
  }

  /** Nothing in range to take the light - the press answers but does not spend. */
  private kindleRefused(): void {
    this.ambience.gather(0);
    const ring = this.add
      .circle(this.wisp.x, this.wisp.y, 26, 0xd8926a, 0)
      .setStrokeStyle(2, 0xd8926a, 0.5)
      .setDepth(8);
    this.tweens.add({
      targets: ring,
      radius: 64,
      alpha: 0,
      duration: 320,
      ease: "Cubic.easeOut",
      onUpdate: () => ring.setPosition(this.wisp.x, this.wisp.y),
      onComplete: () => ring.destroy(),
    });
  }

  /** A hearth takes the light: permanent terrain, a banish, and an ember gift. */
  private igniteHearth(hearth: (typeof this.hearths)[number]): void {
    hearth.state.lit = true;
    hearth.breathAt = this.time.now + HEARTH_BREATH_MS;
    hearth.socket?.destroy();
    hearth.socket = undefined;
    this.tweens.killTweensOf(hearth.img);
    hearth.img.setAlpha(1);
    const scale = hearth.state.final ? 1.5 : 0.9;
    this.tweens.add({
      targets: hearth.img,
      scale: { from: scale * 0.7, to: scale },
      alpha: { from: 1, to: 0.92 },
      duration: 700,
      ease: "Back.easeOut",
    });
    // Baseline first, tween the rest: tweens ride the wall clock, so under
    // the replay harness a from-zero fade can leave a lit hearth looking dark.
    hearth.halo.setAlpha(0.35);
    this.tweens.add({
      targets: hearth.halo,
      alpha: { from: 0.35, to: 0.75 },
      duration: 900,
      ease: "Sine.easeOut",
    });
    this.tweens.add({
      targets: hearth.halo,
      scale: { from: hearth.halo.scale, to: hearth.halo.scale * 1.12 },
      duration: 2400,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    const litIntensity = hearth.state.final ? 2.6 : 1.7;
    hearth.light = this.lights.addLight(hearth.state.x, hearth.state.y, HEARTH_POOL_RADIUS, 0xffb070, litIntensity * 0.55);
    this.tweens.add({ targets: hearth.light, intensity: litIntensity, duration: 900, ease: "Sine.easeOut" });
    this.cameras.main.shake(90, 0.0014);
    this.ambience.kindle(hearth.state.final);

    this.banishShadows(hearth.state.x, hearth.state.y);
    this.leylineNow = leylines(this.hearths.map((h) => h.state));
    if (this.kindles === 1 && this.leylineNow.length > 0) this.showRoadLine();
    if (hearth.state.final) {
      this.completeHollow();
    } else {
      this.releaseEmbers(hearth, EMBERS_PER_HEARTH);
      if (finalUnlocked(this.hearths.map((h) => h.state))) this.showOpenLine();
    }
    this.updateHud();
    this.reportState();
  }

  /**
   * Light as a weapon, once per hearth: any shadow standing in the new pool
   * when it ignites is unmade. This is the Hollow's answer to the forest's
   * radiance - not a slow, an erasure - and it makes WHERE to spend a press
   * a tactical question, not only an economic one.
   */
  private banishShadows(x: number, y: number): void {
    for (let i = this.hazards.length - 1; i >= 0; i -= 1) {
      const h = this.hazards[i];
      if (Phaser.Math.Distance.Between(h.img.x, h.img.y, x, y) > HEARTH_POOL_RADIUS) continue;
      this.hazards.splice(i, 1);
      this.tweens.add({
        targets: h.img,
        alpha: 0,
        scale: h.img.scale * 1.8,
        duration: 620,
        ease: "Sine.easeOut",
        onComplete: () => h.img.destroy(),
      });
      this.tweens.add({
        targets: h.light,
        intensity: 0,
        duration: 620,
        onComplete: () => this.lights.removeLight(h.light),
      });
      this.hazardTrail.explode(22, h.img.x, h.img.y);
      this.ambience.radiance();
    }
  }

  /** Embers drift out of a lit hearth into its pool and become touchable light. */
  private releaseEmbers(hearth: (typeof this.hearths)[number], count: number): void {
    const rng = new Phaser.Math.RandomDataGenerator([
      `hollow-embers-${hearth.state.x}-${this.collected}-${this.kindles}`,
    ]);
    for (let i = 0; i < count; i += 1) {
      const angle = rng.realInRange(0, Math.PI * 2);
      const dist = rng.realInRange(70, HEARTH_POOL_RADIUS * 0.85);
      const tx = Phaser.Math.Clamp(hearth.state.x + Math.cos(angle) * dist, 40, WORLD_WIDTH - 40);
      const ty = Phaser.Math.Clamp(hearth.state.y + Math.sin(angle) * dist, 100, WORLD_HEIGHT - 60);
      this.spawnEmber(tx, ty, rng);
    }
    // New light on the ground is state the play driver steers by.
    this.reportState();
  }

  /**
   * One ember, placed at its rest position from frame one: collection is
   * gameplay, and a positional flight tween would let a player standing on
   * the hearth swallow the whole gift before it scattered. The pop-in is
   * purely cosmetic.
   */
  private spawnEmber(tx: number, ty: number, rng: Phaser.Math.RandomDataGenerator): void {
    const ember = this.add
      .image(tx, ty, "ember")
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.8)
      .setAlpha(0.3)
      .setDepth(5);
    ember.setData("restX", tx);
    ember.setData("restY", ty);
    this.tweens.add({
      targets: ember,
      y: ty - rng.between(8, 18),
      alpha: { from: 0.6, to: 1 },
      duration: rng.between(1200, 2000),
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
    this.motes.push(ember);
  }

  /**
   * The slow income: a lit hearth breathes one ember at a time, and only while
   * its pool is nearly bare - counting the live embers around it rather than
   * bookkeeping, so a collected ember re-opens the tap by itself.
   */
  private breatheHearths(): void {
    for (const hearth of this.hearths) {
      if (!hearth.state.lit || hearth.state.final) continue;
      if (this.time.now < hearth.breathAt) continue;
      hearth.breathAt = this.time.now + HEARTH_BREATH_MS;
      // Once a thread runs from this hearth, its breath travels down the
      // road instead of settling in the pool: the dark stretch ahead is
      // where a walking player needs something to touch, not the ground
      // they already stripped. The standing cap counts the road too.
      const road = this.leylineNow.find((l) => l.from === hearth.state);
      const standing = this.motes.filter(
        (m) =>
          Phaser.Math.Distance.Between(m.x, m.y, hearth.state.x, hearth.state.y) <= HEARTH_POOL_RADIUS ||
          (road !== undefined && leylineAt([road], m.x, m.y) !== undefined),
      ).length;
      if (standing >= HEARTH_BREATH_MAX_STANDING) continue;
      if (road) {
        const rng = new Phaser.Math.RandomDataGenerator([`hollow-breath-${hearth.state.x}-${this.collected}-${this.kindles}`]);
        const p = leylinePoint(road, rng.realInRange(0.3, 0.7));
        this.spawnEmber(p.x, p.y, rng);
        this.reportState();
      } else {
        this.releaseEmbers(hearth, 1);
      }
    }
  }

  /** The Hollow's second wordless lesson, once: the thread is a road, and it carries. */
  private showRoadLine(): void {
    this.roadLine = this.add
      .text(VIEW_WIDTH / 2, VIEW_HEIGHT - 54, "a thread runs to the next hearth · walk it and the light carries you", {
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: "17px",
        color: "#ffbe8a",
      })
      .setOrigin(0.5)
      .setAlpha(0)
      .setDepth(100)
      .setScrollFactor(0);
    this.tweens.add({
      targets: this.roadLine,
      alpha: 0.8,
      duration: 900,
      delay: 900,
      ease: "Sine.easeOut",
      yoyo: true,
      hold: 4200,
    });
  }

  /** A spent press answers immediately, but cannot pull or hide its state. */
  private gatherDenied(): void {
    this.ambience.gather(0);
    const ring = this.add
      .circle(this.wisp.x, this.wisp.y, 42, 0x8fb4d8, 0)
      .setStrokeStyle(2, 0x8fb4d8, 0.7)
      .setDepth(8);
    this.tweens.add({
      targets: ring,
      radius: 22,
      alpha: 0,
      duration: 260,
      ease: "Cubic.easeOut",
      onUpdate: () => ring.setPosition(this.wisp.x, this.wisp.y),
      onComplete: () => ring.destroy(),
    });
  }

  /** One quiet sentence, once, after the screen has already shown the cost. */
  private showGatherCost(): void {
    if (this.costShown || this.config.index !== 1 || !this.reachLine) return;
    this.costShown = true;
    this.reachLine.setText("move through light to kindle the reach").setAlpha(0);
    this.tweens.add({ targets: this.reachLine, alpha: 0.72, duration: 260, ease: "Sine.easeOut" });
    this.after(1750, () => {
      if (!this.reachLine) return;
      this.tweens.add({ targets: this.reachLine, alpha: 0, duration: 520, ease: "Sine.easeIn" });
    });
  }

  /** The inward ring: the reach collapsing onto the wisp, so the press has a shape. */
  private gatherWave(from: number, caughtCount: number): void {
    const hit = caughtCount > 0;
    const ring = this.add
      .circle(this.wisp.x, this.wisp.y, from, 0xffe2a8, 0)
      .setStrokeStyle(hit ? 3 : 1.5, hit ? 0xffe2a8 : 0x8fb4d8, hit ? 0.8 : 0.34)
      .setDepth(7);
    this.tweens.add({
      targets: ring,
      radius: 14,
      alpha: hit ? 0.9 : 0.25,
      duration: hit ? 300 : 230,
      ease: "Cubic.easeIn",
      onUpdate: () => ring.setPosition(this.wisp.x, this.wisp.y),
      onComplete: () => ring.destroy(),
    });
    if (hit) this.cameras.main.shake(70, 0.0012);
  }

  /** A gathered mote reaching the wisp - the same collect as a touch, one flight later. */
  private absorb(mote: Phaser.GameObjects.Image): void {
    const index = this.incoming.indexOf(mote);
    if (index >= 0) this.incoming.splice(index, 1);
    mote.destroy();
    // A shadow caught the wisp while this one was still in flight: the light
    // that snuffed the run does not get to bank the mote that was on its way.
    if (this.locked) return;
    this.trail.explode(16, this.wisp.x, this.wisp.y);
    this.takeMote("gathered");
  }

  private setReach(next: number): void {
    this.reach = Phaser.Math.Clamp(next, REACH_MIN, REACH_MAX);
    this.wispLight.radius = this.reach;
    this.wisp.setScale(0.34 + (this.reach / REACH_MAX) * 0.42);
  }

  /** The world positions a press would act on right now - motes in the forest, dormant hearths in the Hollow. */
  private pressTargets(): Array<{ x: number; y: number }> {
    if (!this.isKindle()) return this.motes;
    const treeReady = finalUnlocked(this.hearths.map((h) => h.state));
    return this.hearths.filter((h) => !h.state.lit && (!h.state.final || treeReady)).map((h) => h.state);
  }

  /** Draw the edge of the reach, bright only while it has something in it. */
  private drawReachRing(time: number): void {
    this.reachRing.clear();
    if (this.locked) return;
    const targets = this.pressTargets();
    let inReach = false;
    for (const t of targets) {
      if (Phaser.Math.Distance.Between(t.x, t.y, this.wisp.x, this.wisp.y) <= this.reach) {
        inReach = true;
        break;
      }
    }
    const ready = this.time.now >= this.gatherReadyAt;
    const kindled = reachReady(this.reach);
    const readiness = reachReadiness(this.reach);
    // Untaught players get a slow breathing edge the first time something is in
    // range; once they have pressed once the ring settles down and stops asking.
    const invite = inReach && !this.taught ? 0.18 + Math.sin(time * 0.006) * 0.12 : 0;
    const alpha = (inReach ? (ready && kindled ? 0.42 : 0.16) : 0.06) + invite;
    const reachColor = kindled ? 0xffe2a8 : 0x8fb4d8;
    this.reachRing.lineStyle(inReach ? 2 : 1, reachColor, alpha);
    this.reachRing.strokeCircle(this.wisp.x, this.wisp.y, this.reach);

    // The close halo is the hand-readable resource: complete gold means the
    // pull is ready; a spent blue arc fills only as the player moves through
    // light. It lives on the wisp, not in a detached HUD meter.
    this.reachRing.lineStyle(kindled ? 3.5 : 3, reachColor, kindled ? 0.82 : 0.58);
    this.reachRing.beginPath();
    this.reachRing.arc(
      this.wisp.x,
      this.wisp.y,
      38,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * Math.max(0.025, readiness),
    );
    this.reachRing.strokePath();

    // A filament to each target in reach: what the press will take - or, in
    // the Hollow, what it will give to - before it is pressed.
    if (!inReach) return;
    const filament = this.isKindle() ? 0xffb070 : 0xffe2a8;
    for (const t of targets) {
      const d = Phaser.Math.Distance.Between(t.x, t.y, this.wisp.x, this.wisp.y);
      if (d > this.reach) continue;
      this.reachRing.lineStyle(1, filament, 0.16 + 0.26 * (1 - d / this.reach));
      this.reachRing.lineBetween(this.wisp.x, this.wisp.y, t.x, t.y);
    }
  }

  private baseIntensity(): number {
    return 1.6 + this.collected * 0.06;
  }

  /**
   * Make the number felt. Reach is the only stat in the game and it never gets
   * a HUD line, so it has to be legible in the light itself: a wide reach
   * burns white and streams sparks, a spent one guts down to a small cold
   * flicker. The gutter is the tell that a press just cost you something real.
   */
  private reachFeel(time: number, dt: number): number {
    const t = Phaser.Math.Clamp((this.reach - REACH_MIN) / (REACH_MAX - REACH_MIN), 0, 1);
    // Frequency only - the emitter's alpha ramp is what fades a spark out, and
    // overriding it with a constant makes the trail pop instead of dissolve.
    this.trail.frequency = 64 - t * 34;
    this.wisp.setAlpha(0.78 + t * 0.22);

    // Below a third of the range the light is running out: a fast, shallow
    // flicker on top of the slow breath, so "nearly spent" is visible before
    // it is a problem.
    if (t > 0.34) {
      this.gutter = Phaser.Math.Linear(this.gutter, 0, 1 - Math.pow(0.02, dt));
      return this.gutter;
    }
    const depth = (0.34 - t) / 0.34;
    this.gutter = Math.sin(time * 0.021) * 0.1 * depth + Math.sin(time * 0.053) * 0.06 * depth;
    return this.gutter;
  }

  update(time: number, delta: number): void {
    // The dawn handoff must fire while the scene is locked for the epilogue.
    if (this.hollowEndAt > 0 && time >= this.hollowEndAt) {
      this.hollowEndAt = 0;
      this.finishHollow();
    }
    if (this.locked) return;

    const dt = delta / 1000;
    const step = dt * WISP_MAX_SPEED;
    if (this.cursors.left.isDown || this.wasd.left.isDown) this.target.x -= step;
    if (this.cursors.right.isDown || this.wasd.right.isDown) this.target.x += step;
    if (this.cursors.up.isDown || this.wasd.up.isDown) this.target.y -= step;
    if (this.cursors.down.isDown || this.wasd.down.isDown) this.target.y += step;
    this.target.x = Phaser.Math.Clamp(this.target.x, 27, WORLD_WIDTH - 27);
    this.target.y = Phaser.Math.Clamp(this.target.y, 27, WORLD_HEIGHT - 27);

    // Ease toward the target (the trailing, gliding feel), but then clamp
    // the actual distance covered this frame to WISP_MAX_SPEED. Pointer
    // input sets `target` straight to the cursor's world position with no
    // distance limit of its own, which - unclamped - let a single mouse
    // flick close far more ground per frame than the keyboard's own capped
    // step ever could, making hazard avoidance an accident of input device
    // rather than a designed difficulty curve. For ordinary small movements
    // the eased step is already under the cap, so this only ever bites the
    // extreme case, not the everyday trailing feel.
    const easeT = 1 - Math.pow(0.002, dt);
    const easedX = Phaser.Math.Linear(this.wisp.x, this.target.x, easeT);
    const easedY = Phaser.Math.Linear(this.wisp.y, this.target.y, easeT);
    let dx = easedX - this.wisp.x;
    let dy = easedY - this.wisp.y;
    const moveDist = Math.sqrt(dx * dx + dy * dy);
    const maxStep = WISP_MAX_SPEED * dt;
    if (moveDist > maxStep && moveDist > 0) {
      const scale = maxStep / moveDist;
      dx *= scale;
      dy *= scale;
    }
    this.wisp.x += dx;
    this.wisp.y += dy;
    // The Hollow's threads carry a wisp moving along them. Under keyboard
    // steering the target trails the wisp, so the push lands on it too or the
    // ease pulls the ground back next frame; under the pointer the target IS
    // where the player pointed, and the carry only gets them there sooner.
    this.carried = 0;
    if (this.leylineNow.length > 0) {
      const carry = leylineAt(this.leylineNow, this.wisp.x, this.wisp.y);
      const boost = leylineBoost(carry, dx, dy, dt, maxStep);
      if (boost.x !== 0 || boost.y !== 0) {
        this.wisp.x = Phaser.Math.Clamp(this.wisp.x + boost.x, 27, WORLD_WIDTH - 27);
        this.wisp.y = Phaser.Math.Clamp(this.wisp.y + boost.y, 27, WORLD_HEIGHT - 27);
        const keyed =
          this.cursors.left.isDown || this.cursors.right.isDown || this.cursors.up.isDown || this.cursors.down.isDown ||
          this.wasd.left.isDown || this.wasd.right.isDown || this.wasd.up.isDown || this.wasd.down.isDown;
        if (keyed) {
          this.target.x = Phaser.Math.Clamp(this.target.x + boost.x, 27, WORLD_WIDTH - 27);
          this.target.y = Phaser.Math.Clamp(this.target.y + boost.y, 27, WORLD_HEIGHT - 27);
        }
        this.carried = carry ? carry.strength : 0;
        this.pulseBoost = Math.max(this.pulseBoost, 0.25 * this.carried);
        if (this.carrySparks && this.carried > 0.2) {
          this.carrySparks.emitParticleAt(this.wisp.x - boost.x * 3, this.wisp.y - boost.y * 3, this.carried > 0.6 ? 2 : 1);
        }
      }
    }
    if (this.isKindle()) this.ambience.carry(this.carried);
    this.wispLight.setPosition(this.wisp.x, this.wisp.y);
    this.hazardTrail.setPosition(0, 0);

    const breathe = Math.sin(time * 0.0007) * 0.12;
    this.pulseBoost = Phaser.Math.Linear(this.pulseBoost, 0, 1 - Math.pow(0.001, dt));
    this.wispLight.intensity = this.baseIntensity() + breathe + this.pulseBoost + this.reachFeel(time, dt);

    this.drawReachRing(time);
    this.inviteGather();

    const beforeExpiry = this.chainState;
    this.chainState = expireChain(this.chainState, time);
    if (beforeExpiry !== this.chainState) this.clearChainDisplay();
    this.drawChainBoundary(time);

    this.patrolStep(dt);
    for (const h of this.hazards) {
      this.hazardTrail.emitParticleAt(h.img.x, h.img.y, 1);
    }
    this.checkHazardAlerts();

    if (time > this.graceUntil) {
      this.checkHazardCollisions();
    }
    this.collectNearbyMotes();
    if (this.levelClear) {
      this.checkBeaconArrival();
    }
    if (this.isKindle()) {
      this.resolveKindles();
      this.breatheHearths();
      this.drawLeylines(time);
    }

    // Keep the published positions live between collect/fail events, so a
    // scripted play run can steer by them - telemetry a human player already
    // has by looking at the screen, not a capability the game itself lacks.
    const published = window.__glow;
    if (published && published.scene === "level") {
      published.wispX = Math.round(this.wisp.x);
      published.wispY = Math.round(this.wisp.y);
      for (let i = 0; i < this.hazards.length; i += 1) {
        const h = published.hazards[i];
        if (h) {
          h.x = Math.round(this.hazards[i].img.x);
          h.y = Math.round(this.hazards[i].img.y);
        }
      }
    }
  }

  private checkHazardCollisions(): void {
    for (const h of this.hazards) {
      if (Phaser.Math.Distance.Between(h.img.x, h.img.y, this.wisp.x, this.wisp.y) <= HAZARD_RADIUS) {
        this.fail();
        return;
      }
    }
  }

  /** Where a mote counts as being for game rules - its authored rest point, not the bob. */
  private moteRestDistance(mote: Phaser.GameObjects.Image, x: number, y: number): number {
    const rx = (mote.getData("restX") as number | undefined) ?? mote.x;
    const ry = (mote.getData("restY") as number | undefined) ?? mote.y;
    return Phaser.Math.Distance.Between(rx, ry, x, y);
  }

  private collectNearbyMotes(): void {
    for (let i = this.motes.length - 1; i >= 0; i -= 1) {
      const mote = this.motes[i];
      if (this.moteRestDistance(mote, this.wisp.x, this.wisp.y) > COLLECT_RADIUS) continue;
      this.motes.splice(i, 1);
      this.tweens.killTweensOf(mote);
      this.trail.explode(18, mote.x, mote.y);
      const pullX = this.wisp.x;
      const pullY = this.wisp.y;
      this.tweens.add({
        targets: mote,
        x: pullX,
        y: pullY,
        scale: 0.08,
        alpha: 0,
        duration: 190,
        ease: "Cubic.easeIn",
        onComplete: () => mote.destroy(),
      });
      this.takeMote("touched");
    }
  }

  /**
   * One mote becomes yours. Pulled light returns a glimmer; touched light
   * rekindles the reach. The difference is the cost of replacing travel with
   * a press, and is drawn continuously by the halo around the wisp.
   */
  private takeMote(arrival: MoteArrival): void {
    if (this.isKindle()) {
      // An ember. No chain, no beacon math - it rekindles the reach harder
      // than forest light does (see EMBER_RESTORE), because embers are the
      // Hollow's whole income and every one has to feel like fuel.
      this.collected += 1;
      this.ambience.chime(this.collected, 1);
      const wasReady = reachReady(this.reach);
      this.setReach(Math.min(REACH_MAX, this.reach + EMBER_RESTORE));
      this.touchedMotes += 1;
      if (!wasReady && reachReady(this.reach)) this.kindleReach();
      this.collectionImpact();
      this.updateHud();
      this.reportState();
      return;
    }
    this.collected += 1;
    // The opening belongs to the pull and its cost. The inherited five-light
    // chain is a useful escalation later, but its corner timer and radiance
    // wave would introduce a second resource inside the first ten seconds.
    // The final clearing earns that extra layer; the first two levels keep the
    // chain completely quiet even for a reacher who clears level 1 in six seconds.
    const chainActive = chainActiveForLevel(this.config.index);
    if (chainActive) this.advanceChain();
    this.ambience.chime(this.collected, chainActive ? this.chainState.count : 1);
    const wasReady = reachReady(this.reach);
    this.setReach(restoreReach(this.reach, arrival));
    if (arrival === "touched") this.touchedMotes += 1;
    else this.gatheredMotes += 1;
    if (!wasReady && reachReady(this.reach)) this.kindleReach();
    this.collectionImpact();
    this.grow();
  }

  /** Completing the close halo gets one restrained world-space bloom. */
  private kindleReach(): void {
    const ring = this.add
      .circle(this.wisp.x, this.wisp.y, 38, 0xffe2a8, 0)
      .setStrokeStyle(3, 0xffe2a8, 0.86)
      .setDepth(8);
    this.tweens.add({
      targets: ring,
      radius: 92,
      alpha: 0,
      duration: 480,
      ease: "Quad.easeOut",
      onUpdate: () => ring.setPosition(this.wisp.x, this.wisp.y),
      onComplete: () => ring.destroy(),
    });
  }

  private advanceChain(): void {
    const result = advanceChain(this.chainState, this.time.now);
    this.chainState = result.state;
    if (result.released) this.releaseRadiance();
  }

  private clearChainDisplay(): void {
    this.tweens.killTweensOf(this.chainText);
    this.chainText.setAlpha(1);
    this.chainText.setText("");
    this.chainArc.clear();
  }

  private resetChain(): void {
    this.chainState = resetChain(this.chainState);
    this.clearChainDisplay();
  }

  private collectionImpact(): void {
    // Rate-limited: a gathered cascade lands four collects inside a quarter
    // second and four overlapping shakes read as a rattle, not as impact.
    if (this.time.now - this.lastShakeAt > 120) {
      this.lastShakeAt = this.time.now;
      this.cameras.main.shake(65 + this.chainState.count * 12, 0.0009 + this.chainState.count * 0.00018);
    }
    this.trail.explode(14 + this.chainState.count * 4, this.wisp.x, this.wisp.y);
    const ring = this.add.circle(this.wisp.x, this.wisp.y, 22, 0xffdfa0, 0)
      .setStrokeStyle(2 + this.chainState.count * 0.35, 0xffdfa0, 0.72).setDepth(7);
    this.tweens.add({
      targets: ring,
      radius: 54 + this.chainState.count * 13,
      alpha: 0,
      duration: 360 + this.chainState.count * 45,
      ease: "Quad.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  private releaseRadiance(): void {
    let affected = 0;
    for (const hazard of this.hazards) {
      const distance = Phaser.Math.Distance.Between(hazard.img.x, hazard.img.y, this.wisp.x, this.wisp.y);
      if (!hazard.alert || distance > RADIANCE_RADIUS) continue;
      hazard.slowUntil = this.time.now + RADIANCE_SLOW_MS;
      affected += 1;
    }
    this.ambience.radiance();
    // No camera flash. A full-screen cream wash is the one effect that can
    // undo the whole art direction in 170ms, and with the reach filling a
    // chain in a single press it was firing several times a level - the
    // screenshot of this game at its best moment was a blank yellow rectangle.
    // The wave and the shadows going quiet say it without blinding anyone.
    this.cameras.main.shake(150, 0.0022);
    const wave = this.add.circle(this.wisp.x, this.wisp.y, 32, 0xffe2a8, 0.08)
      .setStrokeStyle(5, 0xffe2a8, 0.92).setDepth(8);
    this.tweens.add({
      targets: wave,
      radius: RADIANCE_RADIUS,
      alpha: 0,
      duration: 760,
      ease: "Cubic.easeOut",
      onComplete: () => wave.destroy(),
    });
    // Says its piece and goes. Left to the chain's own expiry it sat in the
    // corner for the full four-second window, which on a contact sheet is six
    // frames in a row of a game that is meant to be quiet.
    this.chainText.setText(affected > 0 ? "shadows slowed" : "");
    this.tweens.killTweensOf(this.chainText);
    this.chainText.setAlpha(1);
    if (affected > 0) {
      this.tweens.add({ targets: this.chainText, alpha: 0, duration: 500, delay: 1100 });
    }
  }

  private drawChainBoundary(time: number): void {
    this.chainArc.clear();
    if (this.chainState.count <= 0) return;
    const remaining = Phaser.Math.Clamp((this.chainState.deadline - time) / CHAIN_WINDOW_MS, 0, 1);
    const color = this.chainState.count === CHAIN_CAP ? 0xffdfa0 : 0x9fcfff;
    this.chainArc.lineStyle(3, color, 0.72);
    this.chainArc.beginPath();
    this.chainArc.arc(VIEW_WIDTH - 43, 64, 18, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remaining);
    this.chainArc.strokePath();
    // The arc is the whole readout - a filling ring in the corner, no number to
    // read. The words are kept for the one moment they mean something.
  }

  /** How many motes open the beacon this level (defensively never above what was actually placed). */
  private requiredMotes(): number {
    return Math.min(this.config.requiredMotes, this.totalMotes);
  }

  private grow(): void {
    const required = this.requiredMotes();
    const progress = Phaser.Math.Clamp(this.collected / required, 0, 1);
    this.beacon.setAlpha(0.05 + progress * 0.8);
    this.beaconLight.intensity = progress * 1.4;

    // The beacon opens at the required count - everything past it is the
    // player's own choice: bank the level now, or brave the guarded pockets
    // for the remaining motes and the flawless variant.
    if (this.collected >= required && !this.levelClear) {
      this.levelClear = true;
      this.ambience.beaconOpen();
      this.showOpenLine();
      this.beaconPulse(1.12);
    }

    if (this.collected >= this.totalMotes && !this.flawlessNow) {
      this.flawlessNow = true;
      this.beacon.setAlpha(1);
      this.beaconLight.intensity = 2.2;
      this.beaconLight.setColor(0xffe9c0);
      this.beaconPulse(1.2);
    }

    this.updateHud();
    this.reportState();
  }

  private beaconPulse(to: number): void {
    this.tweens.killTweensOf(this.beacon);
    this.beacon.setScale(1);
    this.tweens.add({
      targets: [this.beacon],
      scale: { from: 1, to },
      duration: 900,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  /** One quiet serif line under the level card, the moment the beacon opens. */
  private showOpenLine(): void {
    this.tweens.killTweensOf(this.openLine);
    this.openLine.setAlpha(0);
    this.tweens.add({
      targets: this.openLine,
      alpha: { from: 0, to: 0.85 },
      duration: 700,
      yoyo: true,
      hold: 1900,
      ease: "Sine.easeInOut",
    });
  }

  private checkBeaconArrival(): void {
    if (this.locked) return;
    if (Phaser.Math.Distance.Between(this.wisp.x, this.wisp.y, BEACON_X, BEACON_Y) <= BEACON_RADIUS) {
      this.completeLevel();
    }
  }

  /** The player touched a shadow-wisp: snuff the light, lose this level's progress, try again. */
  /**
   * A tween with no real target is Phaser's reliable way to run "wait N ms,
   * then do X" inside a scene - this.time.delayedCall shares the Scene's
   * Clock with everything else here and, empirically, doesn't fire
   * reliably under every host this build runs on, where tween onComplete
   * always does. Every other timed handoff in this scene (fail's reset,
   * the settle before a hit registers again) goes through this helper
   * instead, for the same reason.
   */
  private after(ms: number, onComplete: () => void): void {
    this.tweens.add({ targets: {}, duration: ms, onComplete });
  }

  private fail(): void {
    this.locked = true;
    this.resets += 1;
    this.ambience.hit();
    // The dark closes over you. A camera flash - even a violet one - answers
    // "your light just went out" by turning the whole screen ON, which is
    // exactly backwards in this game and reads as a rendering fault at 720p.
    this.tweens.killTweensOf(this.deathVeil);
    this.deathVeil.setAlpha(0);
    this.tweens.add({
      targets: this.deathVeil,
      alpha: { from: 0, to: 0.82 },
      duration: 200,
      yoyo: true,
      hold: 190,
      ease: "Sine.easeOut",
    });
    this.cameras.main.shake(220, 0.006);

    this.tweens.add({
      targets: this.wispLight,
      intensity: 0.05,
      radius: 90,
      duration: 260,
      ease: "Quad.easeIn",
    });
    this.wisp.setScale(0.2);
    this.reachRing.clear();
    for (const mote of this.incoming) this.tweens.killTweensOf(mote);
    this.resetChain();

    this.after(560, () => {
      // In the Hollow a lit hearth keeps your light: you wake at the nearest
      // one you kindled, not at the door. Every kindle is also a foothold.
      let respawnX = START_X;
      let respawnY = START_Y;
      if (this.isKindle()) {
        let best = Infinity;
        for (const hearth of this.hearths) {
          if (!hearth.state.lit || hearth.state.final) continue;
          const d = Phaser.Math.Distance.Between(hearth.state.x, hearth.state.y, this.wisp.x, this.wisp.y);
          if (d < best) {
            best = d;
            respawnX = hearth.state.x;
            respawnY = Math.min(hearth.state.y + 40, WORLD_HEIGHT - 60);
          }
        }
      }
      this.target.set(respawnX, respawnY);
      this.wisp.setPosition(respawnX, respawnY);
      this.wispLight.setPosition(respawnX, respawnY);
      // What a shadow takes is your light, not your work. The old fail wiped
      // the level's motes and started it again, which at twenty seconds in is
      // the moment a player stops playing - and it punished the one thing the
      // round wants them doing, which is going near a shadow to reach past it.
      // Now the sting is the reach itself: it is snuffed to the floor and only
      // motes bring it back, so a death late in a level means finishing that
      // level nearly blind, walking back across ground you already lit. Same
      // currency as the press, so there is one number in the game and dying,
      // spending and collecting all speak it.
      this.tweens.killTweensOf(this.wispLight);
      this.setReach(REACH_MIN);
      this.wispLight.intensity = this.baseIntensity();
      this.gatherReadyAt = 0;
      this.updateHud();
      this.reportState();
      this.graceUntil = this.time.now + RESPAWN_GRACE_MS;
      this.locked = false;
    });
  }

  private completeLevel(): void {
    this.locked = true;
    const wasFlawless = this.collected >= this.totalMotes;
    const flawless = this.flawlessLevels + (wasFlawless ? 1 : 0);
    this.ambience.levelComplete(wasFlawless);
    // The arrival is a swell, not a switch. A camera flash paints the frame
    // solid at full alpha before it fades, so the one frame in three that a
    // contact sheet catches of this game's best moment was a cream rectangle -
    // the same fault as the old radiance flash and the old death flash. An
    // additive veil to 0.42 and a beacon that blooms says "you made it" while
    // the forest is still visible behind it.
    this.tweens.killTweensOf(this.arrivalVeil);
    this.arrivalVeil.setAlpha(0);
    this.tweens.add({
      targets: this.arrivalVeil,
      alpha: { from: 0, to: 0.42 },
      duration: 200,
      yoyo: true,
      hold: 90,
      ease: "Sine.easeOut",
    });
    // beaconPulse() leaves an infinite yoyo running on the same property.
    this.tweens.killTweensOf(this.beacon);
    this.tweens.add({
      targets: this.beacon,
      scale: { from: this.beacon.scale, to: this.beacon.scale * 1.8 },
      duration: 520,
      ease: "Cubic.easeOut",
    });
    this.tweens.add({
      targets: this.beaconLight,
      intensity: 3.4,
      radius: 520,
      duration: 420,
      ease: "Cubic.easeOut",
    });
    this.cameras.main.fadeOut(520, 8, 7, 14);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      const next = this.config.index + 1;
      if (levelFor(next)) {
        this.scene.start("level", {
          levelIndex: next,
          ambience: this.ambience,
          resets: this.resets,
          flawless,
          taught: this.taught,
        });
      } else {
        this.scene.start("ending", { ambience: this.ambience, resets: this.resets, flawless });
      }
    });
  }

  /**
   * The First Tree takes the light: dawn. The sky the whole game has kept
   * black warms from the horizon up, every hearth flares in answer, and the
   * ending arrives as the payoff of everything given, not a fade to more dark.
   */
  private completeHollow(): void {
    this.locked = true;
    // No arpeggio on top - the final kindle's own deep swell (already
    // playing) is the dawn's voice, and the ending scene brings its chord.
    for (const hearth of this.hearths) {
      if (!hearth.state.lit || !hearth.light) continue;
      this.tweens.add({
        targets: hearth.light,
        intensity: 3,
        radius: HEARTH_POOL_RADIUS * 1.6,
        duration: 2200,
        ease: "Sine.easeOut",
      });
    }
    // Dawn is a slow additive wash rising from warm rust to pale gold - the
    // one moment the game is allowed to be bright, and it is earned light.
    const dawn = this.add
      .rectangle(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, VIEW_WIDTH, VIEW_HEIGHT, 0xff9a50)
      .setScrollFactor(0)
      .setAlpha(0)
      .setDepth(92)
      .setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: dawn, alpha: 0.34, duration: 2600, ease: "Sine.easeIn" });
    this.tweens.add({
      targets: this.wispLight,
      intensity: 3,
      radius: 900,
      duration: 2600,
      ease: "Sine.easeOut",
    });
    // Game-time handoff (see pendingKindles) - update() calls finishHollow().
    this.hollowEndAt = this.time.now + 2900;
  }

  private finishHollow(): void {
    // Ordinary hearths only - the HUD counts x/5 all act, and the ending's
    // "N hearths burn behind you" must agree with it (the tree is the dawn,
    // not a hearth in the tally).
    const hearthsLit = this.hearths.filter((h) => h.state.lit && !h.state.final).length;
    this.cameras.main.fadeOut(900, 40, 24, 16);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start("ending", {
        ambience: this.ambience,
        resets: this.resets,
        flawless: this.flawlessLevels,
        dawn: true,
        hearths: hearthsLit,
      });
    });
  }

  private updateHud(): void {
    if (this.isKindle()) {
      const lit = this.hearths.filter((h) => h.state.lit && !h.state.final).length;
      const total = this.hearths.filter((h) => !h.state.final).length;
      const treeSegment = finalUnlocked(this.hearths.map((h) => h.state))
        ? "the first tree will take the light"
        : `the first tree waits`;
      this.hud.setText(`THE HOLLOW   hearths ${lit}/${total} · ${treeSegment}   resets ${this.resets}`);
      return;
    }
    const moteSegment = this.flawlessNow
      ? `motes ${this.collected}/${this.totalMotes} · flawless`
      : this.levelClear
        ? `motes ${this.collected}/${this.totalMotes} · beacon open`
        : `motes ${this.collected}/${this.totalMotes} · beacon at ${this.requiredMotes()}`;
    this.hud.setText(`LEVEL ${this.config.index}/${LEVELS.length}   ${moteSegment}   resets ${this.resets}`);
  }

  private announceReady(): void {
    document.body.dataset.gameReady = "true";
    this.reportState();
  }

  private reportState(): void {
    window.__glow = {
      ready: true,
      scene: "level",
      collected: this.collected,
      remaining: this.motes.length,
      glowRadius: this.wispLight.radius,
      lightsActive: this.lights.active,
      level: this.config.index,
      resets: this.resets,
      required: this.requiredMotes(),
      beaconOpen: this.levelClear,
      flawless: this.flawlessLevels,
      wispX: Math.round(this.wisp.x),
      wispY: Math.round(this.wisp.y),
      motes: this.motes.map((m) => ({ x: Math.round(m.x), y: Math.round(m.y) })),
      hazards: this.hazards.map((h) => ({ x: Math.round(h.img.x), y: Math.round(h.img.y) })),
      reach: Math.round(this.reach),
      gathers: this.gathers,
      gatherReady: reachReady(this.reach),
      deniedGathers: this.deniedGathers,
      touchedMotes: this.touchedMotes,
      gatheredMotes: this.gatheredMotes,
      chain: this.chainState.count,
      chainRemainingMs: Math.max(0, Math.round(this.chainState.deadline - this.time.now)),
      radianceWaves: this.chainState.waves,
      slowedHazards: this.hazards.filter((h) => h.slowUntil > this.time.now).length,
      ...(this.isKindle()
        ? {
            hearthsLit: this.hearths.filter((h) => h.state.lit && !h.state.final).length,
            hearthsTotal: this.hearths.filter((h) => !h.state.final).length,
            hearths: this.hearths.map((h) => ({ x: h.state.x, y: h.state.y, lit: h.state.lit, final: h.state.final })),
            kindles: this.kindles,
            leylines: this.leylineNow.map((l) => ({ x1: l.from.x, y1: l.from.y, x2: l.to.x, y2: l.to.y })),
            carried: Math.round(this.carried * 100) / 100,
          }
        : {}),
    };
  }
}
