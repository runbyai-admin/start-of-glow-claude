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
import { advanceChain, CHAIN_CAP, CHAIN_WINDOW_MS, emptyChain, expireChain, resetChain, type ChainState } from "../chain";

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
 * lit circle comes to you; the circle shrinks by GATHER_COST whether or not it
 * catches anything.
 *
 * Round 4 makes the press a decision instead of a habit. Two things changed.
 *
 * First, THE PRESS HAS TO BE AFFORDED. It only fires while the reach is at or
 * above CHARGE_LINE - high enough that paying GATHER_COST still leaves the
 * light at its floor rather than below it. Round 3 let the reach bottom out at
 * REACH_MIN and then kept firing for free, which is exactly why the round-3
 * verdict read "spammed the pull - nothing stopped me": the cost was real
 * everywhere except at the bottom, and the bottom is where a spammer lives.
 * Below the line the press is refused, audibly and visibly, and the only way
 * back is to walk.
 *
 * Second, WALKING PAYS BETTER THAN PULLING. A mote you walk into returns
 * REACH_PER_WALK; a mote the press drags in returns REACH_PER_PULL, well under
 * half. So a press can never fund the next press - a full armful of four still
 * leaves you short of the line - and the loop has a rhythm: spend the circle to
 * take what you could not safely reach, then walk a mote or two to earn the
 * next press back. Convenience is the thing you are paying for.
 *
 * The lit radius IS the rule: nothing to read, because you can see exactly as
 * far as you can reach - and, while you are charged, exactly how small the next
 * press will leave you (see drawReachRing's cost ghost).
 */
const REACH_START = 390;
const REACH_MIN = 170;
const REACH_MAX = 470;
/** Walked into: the economical way to gather, and the only way to fund a press. */
const REACH_PER_WALK = 46;
/** Dragged in by a press: worth taking, never worth pressing for on its own. */
const REACH_PER_PULL = 18;
const GATHER_COST = 160;
/**
 * The charge line. A press is affordable only at or above this, so paying for
 * one lands exactly on REACH_MIN and never below it: the floor is the bottom of
 * a press, not a place you can sit and press for free.
 */
const CHARGE_LINE = REACH_MIN + GATHER_COST;
const GATHER_COOLDOWN_MS = 420;
/**
 * The light has two colours, and which one it is burning is the whole state of
 * the game. Charged is warm - it has a press in it. Spent is the cold blue the
 * wisp has always been. openai answered this round's brief with a "LUMEN 4/5"
 * gauge in the corner, which is instantly readable and is exactly the HUD this
 * game does not want; the colour of the light itself is readable in the same
 * half-second and lives where the player is already looking.
 */
const LIGHT_CHARGED = 0xffe9c8;
const LIGHT_SPENT = 0x8fb8ff;
/** Fast enough to read as a state change (~0.15s), slow enough not to strobe on the line. */
const LIGHT_SHIFT_PER_SECOND = 3;
/** The brief's own window: after ten seconds the opening is over either way. */
const HUD_LATEST_REVEAL_MS = 10_000;

/**
 * The deep reach - the further mechanic this round's brief allows on top,
 * explicitly not in the opening. A tap is still exactly the press it was, and
 * the first ten seconds never change.
 *
 * Keep holding, though, and the wisp starts POURING its light outward: a bright
 * edge travels out past the lit circle, taking every mote it crosses, while the
 * reach itself drains behind it to pay for the distance. You are throwing your
 * light away from you to take something you could not otherwise get near, and
 * you can watch the trade happen - the sweep going out, the circle shrinking in.
 *
 * It falls out of rules that already existed rather than adding a currency. The
 * hold can only spend down to REACH_MIN, so how far you can throw is set by how
 * bright you already are: at the charge line a press is all you can afford and
 * there is no deep reach at all, and only a wisp near REACH_MAX can throw far.
 * Since a shadow notices light as far as the light carries (alertRadius), being
 * bright enough to reach deep is also being loud - so the guarded pocket is
 * takeable, and getting bright enough to take it is the risk you pay in.
 */
const DEEP_HOLD_DELAY_MS = 240;
/** World px the poured edge travels per second. */
const DEEP_SWEEP_SPEED = 420;
/**
 * Reach spent per world px of sweep - the exchange rate for distance, and the
 * whole balance of the mechanic. At 0.62 a wisp at full brightness could throw
 * its edge past 530px, which is most of a 1280-wide frame: that is not reaching
 * past a patrol, it is vacuuming the level, and a button that is always correct
 * when you are bright is the same failure as a press that is always free. At
 * 1.0 a full wisp buys about 140px beyond where its light already ended - one
 * guarded pocket, one hazard lane, and no more.
 */
const DEEP_COST_PER_PX = 1.0;
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
    tween?: Phaser.Tweens.Tween;
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

  private collected = 0;
  /** Motes actually placed this level - derived from the data used, never assumed from config. */
  private totalMotes = 0;
  private pulseBoost = 0;
  /** How far the light reaches right now - the light's radius, the pull's radius, one number. */
  private reach = REACH_START;
  private gatherReadyAt = 0;
  /** When the reach last crossed back over CHARGE_LINE - drives the "ready" glint. */
  private chargedAt = -9999;
  /** 0 spent, 1 charged - lerped so the colour snaps without strobing on the line. */
  private chargeTint = 1;
  /** Set while the player holds the press; -1 when nothing is held. */
  private holdSince = -1;
  /** Radius of the poured edge while a deep reach is running, else 0. */
  private sweep = 0;
  private sweepRing?: Phaser.GameObjects.Arc;
  private gathers = 0;
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
    this.chargedAt = -9999;
    this.chargeTint = 1;
    this.holdSince = -1;
    this.sweep = 0;
    this.sweepRing = undefined;
    this.gathers = 0;
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
    this.target.set(START_X, START_Y);
  }

  preload(): void {
    makeGlowTexture(this, "wisp", 85, "rgba(255,255,255,1)", "rgba(150,214,255,0.55)");
    makeGlowTexture(this, "mote", 27, "rgba(255,244,214,1)", "rgba(255,196,92,0.5)");
    makeGlowTexture(this, "spark", 16, "rgba(255,255,255,0.9)", "rgba(190,226,255,0.35)");
    makeGlowTexture(this, "firefly", 12, "rgba(226,255,196,1)", "rgba(198,255,130,0.4)");
    makeGlowTexture(this, "beacon", 170, "rgba(255,226,168,1)", "rgba(255,182,102,0.4)");
    makeGlowTexture(this, "shadow-spark", 10, "rgba(150,110,220,0.85)", "rgba(90,50,150,0.3)");
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
    this.buildBeacon();
    this.buildFireflies();
    this.buildMotes();
    this.buildWisp();
    this.buildHazards();
    this.buildStorm();
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
    this.add.image(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, "sky").setScrollFactor(0).setDepth(-100);
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
    for (const cfg of this.moteConfigs) {
      const mote = this.add.image(cfg.x, cfg.y, "mote").setBlendMode(Phaser.BlendModes.ADD).setScale(0.55).setDepth(5);
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
    const count = this.config.layout ? this.config.layout.hazards.length : this.config.hazardCount;
    for (let i = 0; i < count; i += 1) {
      const img = this.add
        .image(0, 0, `hazard-${this.config.index}`)
        .setDepth(6)
        .setScale(rng.realInRange(0.85, 1.15));
      const light = this.lights.addLight(0, 0, 130, 0x9a6efa, CALM_LIGHT_INTENSITY);
      const hazard = { img, light, alert: false, pressure: 0, slowUntil: 0 };
      this.hazards.push(hazard);

      const waypoints: Phaser.Math.Vector2[] = [];
      if (this.config.layout) {
        for (const w of this.config.layout.hazards[i]) {
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
      this.patrol(hazard, waypoints, 0);
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
      if (h.tween) h.tween.timeScale = this.hazardTimeScale(h);
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

  private patrol(
    hazard: { img: Phaser.GameObjects.Image; light: Phaser.GameObjects.Light; tween?: Phaser.Tweens.Tween; alert: boolean; pressure: number; slowUntil: number },
    waypoints: Phaser.Math.Vector2[],
    index: number,
  ): void {
    const { img, light } = hazard;
    const next = waypoints[(index + 1) % waypoints.length];
    const dist = Phaser.Math.Distance.Between(img.x, img.y, next.x, next.y);
    const duration = (dist / this.config.hazardSpeed) * 1000;
    hazard.tween = this.tweens.add({
      targets: img,
      x: next.x,
      y: next.y,
      duration,
      ease: "Sine.easeInOut",
      onUpdate: () => light.setPosition(img.x, img.y),
      onComplete: () => {
        if (!img.active) return;
        this.patrol(hazard, waypoints, index + 1);
      },
    });
    hazard.tween.timeScale = this.hazardTimeScale(hazard);
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
    for (const mote of this.motes) {
      if (Phaser.Math.Distance.Between(mote.x, mote.y, this.wisp.x, this.wisp.y) <= this.reach) {
        inReach = true;
        break;
      }
    }
    if (!inReach) return;
    this.inviteAt = this.time.now + 2100;
    const ghost = this.add
      .circle(this.wisp.x, this.wisp.y, this.reach, 0xffe2a8, 0)
      .setStrokeStyle(2, 0xffe2a8, 0.3)
      .setDepth(4);
    this.tweens.add({
      targets: ghost,
      radius: 18,
      alpha: 0,
      duration: 900,
      ease: "Cubic.easeIn",
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

  /** Idempotent: the first press and the ten-second backstop both call it. */
  private revealHud(): void {
    if (!this.hud || this.hud.alpha > 0.4) return;
    this.tweens.add({ targets: this.hud, alpha: 0.85, duration: 900, ease: "Sine.easeInOut" });
  }

  /**
   * The stat line, and when the game has earned the right to show it.
   *
   * The brief for this round says the first ten seconds are the pull and its
   * cost and nothing else. 'LEVEL 1/3   motes 0/14 · beacon at 10   resets 0'
   * is emphatically something else: it talks about levels, quotas and beacons
   * before the player has pressed once, and it is the same corner-of-the-screen
   * bookkeeping I just criticised openai for carrying. So it starts invisible
   * and fades in on the first press - by which point the player has done the
   * one thing the opening is for, and a count of what is left is finally an
   * answer to a question they might actually have - or at ten seconds,
   * whichever comes first, so a player who never presses is not left without
   * it for the whole level.
   */
  private buildHud(): void {
    this.hud = this.add
      .text(27, 24, "", {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "17px",
        color: "#7e93b8",
      })
      .setAlpha(this.taught ? 0.85 : 0)
      .setDepth(100)
      .setScrollFactor(0);
    if (!this.taught) this.time.delayedCall(HUD_LATEST_REVEAL_MS, () => this.revealHud());

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
      .text(VIEW_WIDTH / 2, 80, "the beacon is lit", {
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
      // The press still fires on DOWN, so a tap feels exactly as it did and the
      // deep reach costs no input latency; holding only ever adds.
      this.gather();
      this.holdSince = this.time.now;
    });
    this.input.on(Phaser.Input.Events.POINTER_UP, () => this.endDeepReach());
    this.input.on(Phaser.Input.Events.GAME_OUT, () => this.endDeepReach());
    const space = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE);
    space.on("down", () => {
      this.ambience.unlock();
      this.gather();
      this.holdSince = this.time.now;
    });
    space.on("up", () => this.endDeepReach());
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
   * the circle pays for it. A reach that catches nothing still costs - reaching
   * into the dark on spec is how you end up small - but the floor at REACH_MIN
   * means a bad run of presses makes you weak, never stuck.
   */
  private gather(): void {
    if (this.locked || this.time.now < this.gatherReadyAt) return;
    // The press has to be afforded. Refusing costs nothing - a spiral where a
    // broke player is also punished for asking would just be a dead end - but
    // it is unmistakable: the ring snaps cold, the light gutters, and the
    // reach's own sound closes instead of opening.
    if (!this.charged()) {
      this.gatherReadyAt = this.time.now + GATHER_COOLDOWN_MS;
      this.denyGather();
      return;
    }
    this.gatherReadyAt = this.time.now + GATHER_COOLDOWN_MS;
    this.gathers += 1;
    if (!this.taught) {
      this.taught = true;
      if (this.reachLine) {
        this.tweens.killTweensOf(this.reachLine);
        this.tweens.add({ targets: this.reachLine, alpha: 0, duration: 420 });
      }
      // The opening has done its job; the bookkeeping may now appear.
      this.revealHud();
    }

    const caught: Array<{ mote: Phaser.GameObjects.Image; d: number }> = [];
    for (let i = this.motes.length - 1; i >= 0; i -= 1) {
      const mote = this.motes[i];
      const d = Phaser.Math.Distance.Between(mote.x, mote.y, this.wisp.x, this.wisp.y);
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
    this.setReach(this.reach - GATHER_COST);
    this.gatherWave(spent, caught.length);
    this.ambience.gather(caught.length);
    this.pulseBoost = caught.length > 0 ? 1.5 : 0.5;

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

  /**
   * A gathered mote reaching the wisp - the same collect as a touch, one flight
   * later, but worth less light: this one was carried to you.
   */
  private absorb(mote: Phaser.GameObjects.Image): void {
    const index = this.incoming.indexOf(mote);
    if (index >= 0) this.incoming.splice(index, 1);
    mote.destroy();
    // A shadow caught the wisp while this one was still in flight: the light
    // that snuffed the run does not get to bank the mote that was on its way.
    if (this.locked) return;
    this.trail.explode(16, this.wisp.x, this.wisp.y);
    this.takeMote(REACH_PER_PULL);
  }

  /**
   * The deep reach, stepped once per frame while the press is held. The poured
   * edge travels out from the lit circle at DEEP_SWEEP_SPEED, every mote it
   * crosses is taken, and the reach drains by DEEP_COST_PER_PX for every pixel
   * of distance bought. It ends itself the moment the light hits its floor, so
   * the mechanic can empty you but never break you.
   */
  private stepDeepReach(dt: number): void {
    if (this.holdSince < 0 || this.locked) {
      if (this.sweep > 0) this.endDeepReach();
      return;
    }
    if (this.time.now - this.holdSince < DEEP_HOLD_DELAY_MS) return;
    if (this.reach <= REACH_MIN) {
      if (this.sweep > 0) this.endDeepReach();
      return;
    }

    if (this.sweep <= 0) {
      // Starts at the edge of the light: the pour is a continuation of the
      // press, not a second circle appearing out of nowhere.
      this.sweep = this.reach;
      this.sweepRing = this.add
        .circle(this.wisp.x, this.wisp.y, this.sweep, 0xffe2a8, 0)
        .setStrokeStyle(2.5, 0xffe8c4, 0.75)
        .setDepth(7);
      this.ambience.pour();
    }

    // Buy as much distance as the remaining light can pay for this frame.
    const wanted = DEEP_SWEEP_SPEED * dt;
    const affordable = Math.max(0, (this.reach - REACH_MIN) / DEEP_COST_PER_PX);
    const step = Math.min(wanted, affordable);
    const from = this.sweep;
    this.sweep += step;
    this.setReach(this.reach - step * DEEP_COST_PER_PX);
    this.sweepRing?.setRadius(this.sweep).setPosition(this.wisp.x, this.wisp.y);

    // Everything the edge crossed this frame comes in.
    for (let i = this.motes.length - 1; i >= 0; i -= 1) {
      const mote = this.motes[i];
      const d = Phaser.Math.Distance.Between(mote.x, mote.y, this.wisp.x, this.wisp.y);
      if (d <= from || d > this.sweep) continue;
      this.motes.splice(i, 1);
      this.incoming.push(mote);
      this.tweens.killTweensOf(mote);
      this.tweens.add({
        targets: mote,
        x: () => this.wisp.x,
        y: () => this.wisp.y,
        scale: 0.9,
        alpha: 1,
        duration: GATHER_FLIGHT_MS + d * 0.28,
        ease: "Cubic.easeIn",
        onComplete: () => this.absorb(mote),
      });
    }

    if (this.reach <= REACH_MIN) this.endDeepReach();
  }

  /** Let go: the poured edge fades where it stopped and the light settles. */
  private endDeepReach(): void {
    this.holdSince = -1;
    if (this.sweep <= 0) return;
    this.sweep = 0;
    const ring = this.sweepRing;
    this.sweepRing = undefined;
    if (!ring) return;
    this.tweens.add({
      targets: ring,
      alpha: 0,
      duration: 260,
      ease: "Sine.easeOut",
      onComplete: () => ring.destroy(),
    });
  }

  /** True while the reach can pay for a press and still land on its floor. */
  private charged(): boolean {
    return this.reach >= CHARGE_LINE;
  }

  /**
   * A refused press. The gesture still gets an answer - the ring snaps inward
   * cold and stops at the charge line rather than the wisp, so the shape the
   * refusal draws is the exact distance still to be walked.
   */
  private denyGather(): void {
    this.ambience.denied();
    // A dip, not a flash. reachFeel rewrites this.gutter every frame, so the
    // flinch goes through the light's own intensity where it survives: the
    // wisp ducks and comes back, the visual shape of "not enough".
    this.pulseBoost = -0.55;
    const ring = this.add
      .circle(this.wisp.x, this.wisp.y, this.reach, 0x8fb4d8, 0)
      .setStrokeStyle(2, 0x8fb4d8, 0.5)
      .setDepth(7);
    this.tweens.add({
      targets: ring,
      radius: CHARGE_LINE,
      alpha: 0,
      duration: 260,
      ease: "Cubic.easeOut",
      onUpdate: () => ring.setPosition(this.wisp.x, this.wisp.y),
      onComplete: () => ring.destroy(),
    });
  }

  private setReach(next: number): void {
    const was = this.charged();
    this.reach = Phaser.Math.Clamp(next, REACH_MIN, REACH_MAX);
    this.wispLight.radius = this.reach;
    this.wisp.setScale(0.34 + (this.reach / REACH_MAX) * 0.42);
    // Crossing back over the line is the payoff for walking, so it gets a
    // moment of its own: a two-note lift and the ring blooming warm. Without
    // it, "you can press again" is a state the player has to infer.
    if (!was && this.charged()) this.markCharged();
  }

  /** The ring coming back up to the line - the reward for the walk. */
  private markCharged(): void {
    this.ambience.charged();
    this.chargedAt = this.time.now;
    const ring = this.add
      .circle(this.wisp.x, this.wisp.y, CHARGE_LINE * 0.72, 0xffe2a8, 0)
      .setStrokeStyle(2.5, 0xffe2a8, 0.8)
      .setDepth(7);
    this.tweens.add({
      targets: ring,
      radius: this.reach,
      alpha: 0,
      duration: 340,
      ease: "Cubic.easeOut",
      onUpdate: () => ring.setPosition(this.wisp.x, this.wisp.y),
      onComplete: () => ring.destroy(),
    });
  }

  /**
   * The edge of the reach, and - this round's whole point - what pressing it
   * would cost. Three circles at most, none of them a HUD:
   *
   *  - the reach itself, warm and solid while a press is affordable, thin and
   *    cold while it is not;
   *  - the COST GHOST, a faint inner circle at (reach - GATHER_COST) drawn only
   *    while charged and only while there is something to take. That is the
   *    price, on screen, before the press: this is how small you will be;
   *  - the CHARGE LINE, drawn only while spent, at the radius the light has to
   *    grow back to. It is the same circle the refused press collapses onto, so
   *    "not yet" and "this far" are one shape.
   */
  private drawReachRing(time: number): void {
    this.reachRing.clear();
    if (this.locked) return;
    let inReach = false;
    for (const mote of this.motes) {
      if (Phaser.Math.Distance.Between(mote.x, mote.y, this.wisp.x, this.wisp.y) <= this.reach) {
        inReach = true;
        break;
      }
    }
    const charged = this.charged();
    const ready = charged && this.time.now >= this.gatherReadyAt;
    // Untaught players get a slow breathing edge the first time something is in
    // range; once they have pressed once the ring settles down and stops asking.
    const invite = inReach && !this.taught ? 0.18 + Math.sin(time * 0.006) * 0.12 : 0;
    // A glint for a beat after the reach comes back over the line: the edge you
    // just earned announces itself, then settles.
    const glint = Math.max(0, 1 - (this.time.now - this.chargedAt) / 700) * 0.3;
    const warm = charged && inReach;
    const alpha = (inReach ? (ready ? 0.34 : 0.13) : 0.06) + invite + glint;
    this.reachRing.lineStyle(warm ? 2 : 1, warm ? 0xffe2a8 : 0x8fb4d8, alpha);
    this.reachRing.strokeCircle(this.wisp.x, this.wisp.y, this.reach);

    if (charged) {
      // The cost ghost. Only while there is something worth taking, so it reads
      // as the price of THIS press rather than as permanent furniture.
      if (inReach) {
        this.reachRing.lineStyle(1, 0xffb36b, 0.2 + glint * 0.5);
        this.reachRing.strokeCircle(this.wisp.x, this.wisp.y, Math.max(this.reach - GATHER_COST, REACH_MIN));
      }
    } else {
      // Spent: the charge line, and how far along it you are - stolen from
      // grok, who draw their resource as an arc on the light's own edge rather
      // than as a gauge in a corner. Two concentric circles make the player
      // compare radii, which is slow; an arc filling toward a full circle is
      // one shape and reads at a glance. It vanishes the moment it closes.
      const progress = Phaser.Math.Clamp((this.reach - REACH_MIN) / (CHARGE_LINE - REACH_MIN), 0, 1);
      this.reachRing.lineStyle(1, 0x8fb4d8, 0.1);
      this.reachRing.strokeCircle(this.wisp.x, this.wisp.y, CHARGE_LINE);
      // Wound from straight up, clockwise, so "nearly there" is a nearly
      // closed ring and not a length the player has to measure.
      this.reachRing.lineStyle(2.5, 0xffe2a8, 0.42 + Math.sin(time * 0.005) * 0.08);
      this.reachRing.beginPath();
      this.reachRing.arc(
        this.wisp.x,
        this.wisp.y,
        CHARGE_LINE,
        Phaser.Math.DegToRad(-90),
        Phaser.Math.DegToRad(-90 + 360 * progress),
        false,
      );
      this.reachRing.strokePath();
    }

    // A filament to each mote in reach: what the press will take, before it is
    // pressed. Cold and thin while spent - still there to take, just not now.
    if (!inReach) return;
    for (const mote of this.motes) {
      const d = Phaser.Math.Distance.Between(mote.x, mote.y, this.wisp.x, this.wisp.y);
      if (d > this.reach) continue;
      const near = 1 - d / this.reach;
      if (charged) this.reachRing.lineStyle(1, 0xffe2a8, 0.16 + 0.26 * near);
      else this.reachRing.lineStyle(1, 0x8fb4d8, 0.07 + 0.1 * near);
      this.reachRing.lineBetween(this.wisp.x, this.wisp.y, mote.x, mote.y);
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

  /**
   * Say charged or spent in the colour of the light. Everything else about the
   * reach is a quantity - a radius, a scale, a spark rate - and quantities read
   * slowly. This one is a state, so it gets the fastest channel on screen: the
   * wisp and its light go warm when a press is affordable and cold when it is
   * not, at the centre of the frame, where the eye already is.
   */
  private paintCharge(dt: number): void {
    const want = this.charged() ? 1 : 0;
    this.chargeTint = Phaser.Math.Linear(this.chargeTint, want, 1 - Math.pow(0.001, dt * LIGHT_SHIFT_PER_SECOND));
    const blend = Phaser.Display.Color.Interpolate.ColorWithColor(
      Phaser.Display.Color.ValueToColor(LIGHT_SPENT),
      Phaser.Display.Color.ValueToColor(LIGHT_CHARGED),
      100,
      Math.round(this.chargeTint * 100),
    );
    this.wispLight.color.set(blend.r / 255, blend.g / 255, blend.b / 255);
    this.wisp.setTint(Phaser.Display.Color.GetColor(blend.r, blend.g, blend.b));
  }

  update(time: number, delta: number): void {
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
    this.wispLight.setPosition(this.wisp.x, this.wisp.y);
    this.hazardTrail.setPosition(0, 0);

    const breathe = Math.sin(time * 0.0007) * 0.12;
    this.pulseBoost = Phaser.Math.Linear(this.pulseBoost, 0, 1 - Math.pow(0.001, dt));
    this.wispLight.intensity = this.baseIntensity() + breathe + this.pulseBoost + this.reachFeel(time, dt);
    this.paintCharge(dt);
    this.stepDeepReach(dt);

    this.drawReachRing(time);
    this.inviteGather();

    const beforeExpiry = this.chainState;
    this.chainState = expireChain(this.chainState, time);
    if (beforeExpiry !== this.chainState) this.clearChainDisplay();
    this.drawChainBoundary(time);

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

  private collectNearbyMotes(): void {
    for (let i = this.motes.length - 1; i >= 0; i -= 1) {
      const mote = this.motes[i];
      if (Phaser.Math.Distance.Between(mote.x, mote.y, this.wisp.x, this.wisp.y) > COLLECT_RADIUS) continue;
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
      this.takeMote();
    }
  }

  /**
   * One mote becomes yours - the single place a collect is counted, whether it
   * was walked into or reached for. What it is worth depends on which: walking
   * into one returns REACH_PER_WALK and is how a press gets funded, while one
   * the press dragged in returns REACH_PER_PULL, so no armful ever pays for the
   * armful after it.
   */
  private takeMote(gain: number = REACH_PER_WALK): void {
    this.collected += 1;
    this.advanceChain();
    this.ambience.chime(this.collected, this.chainState.count);
    this.setReach(this.reach + gain);
    this.collectionImpact();
    this.grow();
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
      if (hazard.tween) hazard.tween.timeScale = RADIANCE_TIME_SCALE;
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
      this.target.set(START_X, START_Y);
      this.wisp.setPosition(START_X, START_Y);
      this.wispLight.setPosition(START_X, START_Y);
      // What a shadow takes is your light, not your work. The old fail wiped
      // the level's motes and started it again, which at twenty seconds in is
      // the moment a player stops playing - and it punished the one thing the
      // round wants them doing, which is going near a shadow to reach past it.
      // Now the sting is the reach itself: it is snuffed and only motes bring
      // it back, so a death late in a level means finishing that level nearly
      // blind, walking back across ground you already lit. Same currency as the
      // press, so there is one number in the game and dying, spending and
      // collecting all speak it.
      //
      // It stops AT the charge line, not at the floor. Round 3 could snuff to
      // the floor safely because the press still fired down there; now that a
      // press has to be afforded, the floor also means "you may not use the
      // verb", and a greedy run dying six times in thirty seconds spent most of
      // itself blind AND locked out of the one thing the game is about. A
      // shadow takes your light. It does not get to take your next move: you
      // come back small, with exactly one press in hand, and spending it puts
      // you on the floor by your own choice rather than by the shadow's.
      this.tweens.killTweensOf(this.wispLight);
      this.setReach(CHARGE_LINE);
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

  private updateHud(): void {
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
      chain: this.chainState.count,
      chainRemainingMs: Math.max(0, Math.round(this.chainState.deadline - this.time.now)),
      radianceWaves: this.chainState.waves,
      slowedHazards: this.hazards.filter((h) => h.slowUntil > this.time.now).length,
    };
  }
}
