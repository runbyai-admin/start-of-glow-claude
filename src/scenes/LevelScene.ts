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
/** How close a hazard lets the player linger before it notices - see checkHazardAlerts(). */
const ALERT_RADIUS = HAZARD_RADIUS * 2.6;
const ALERT_TIME_SCALE = 1.55;
const ALERT_LIGHT_INTENSITY = 1.55;
const CALM_LIGHT_INTENSITY = 0.9;
/**
 * Shy-mote tuning (see updateShyMotes / ShyConfig in levels.ts). Startle
 * lingers ~0.8s after the last rush so a mote does not calm the instant the
 * player freezes mid-lunge - it settles when the rushing genuinely stops.
 * Stamina empties in ~2.4s of flight and refills in ~3.5s of calm; a spent
 * mote will not flee again until it has recovered past the 0.6 hysteresis
 * mark, so "tired" is a real window, not a one-frame flicker.
 */
const SHY_STARTLE_MS = 800;
const SHY_DRAIN_SECONDS = 2.4;
const SHY_REGAIN_SECONDS = 3.5;
const SHY_RECOVER_AT = 0.6;
const SHY_HOME_SPEED = 45;
/**
 * A mote closer than this to the spawn point never enters the shy pick: the
 * opening rush collects it before it can visibly flee, so it demonstrates
 * nothing - and the teaching whisper would fire over a mote that no longer
 * exists. Found the honest way: level 2's seed places a mote 49px from
 * spawn, and the round-2 gate caught it being swallowed at level entry.
 */
const SHY_MIN_SPAWN_DIST = 250;

interface LevelInitData {
  levelIndex: number;
  ambience: Ambience;
  resets?: number;
  /** Flawless levels (every mote found) completed earlier in this run. */
  flawless?: number;
}

/**
 * One placed mote's runtime state. Normal motes only ever use `img` (their
 * bob is a tween); shy motes are simulated in updateShyMotes, so their
 * logical position lives in `pos` and the rendered image adds a bob offset
 * on top - a tween animating y would fight the flee movement frame by frame.
 */
interface MoteState {
  img: Phaser.GameObjects.Image;
  shy: boolean;
  home: { x: number; y: number };
  pos: { x: number; y: number };
  stamina: number;
  startleMs: number;
  exhausted: boolean;
  phase: number;
  /** 1 on a fresh startle, decaying - drives a small scale pop. */
  pop: number;
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
  private motes: MoteState[] = [];
  private hazards: Array<{
    img: Phaser.GameObjects.Image;
    light: Phaser.GameObjects.Light;
    tween?: Phaser.Tweens.Tween;
    alert: boolean;
  }> = [];

  private hud!: Phaser.GameObjects.Text;
  private levelCard!: Phaser.GameObjects.Text;
  private openLine!: Phaser.GameObjects.Text;
  private whisperLine!: Phaser.GameObjects.Text;
  private whisperShown = false;
  /** Rate limit for the skitter sound - a startled cluster is one darting, not a drumroll. */
  private lastSkitterAt = 0;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private target = new Phaser.Math.Vector2(START_X, START_Y);

  private collected = 0;
  /** Motes actually placed this level - derived from the data used, never assumed from config. */
  private totalMotes = 0;
  private pulseBoost = 0;
  private levelClear = false;
  /** Every mote currently collected - the flawless variant is showing. */
  private flawlessNow = false;
  private locked = false;
  private graceUntil = 0;

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
    this.levelClear = false;
    this.flawlessNow = false;
    this.locked = false;
    this.whisperShown = false;
    this.lastSkitterAt = 0;
    this.moteConfigs = [];
    this.motes = [];
    this.hazards = [];
    this.target.set(START_X, START_Y);
  }

  preload(): void {
    makeGlowTexture(this, "wisp", 85, "rgba(255,255,255,1)", "rgba(150,214,255,0.55)");
    makeGlowTexture(this, "mote", 27, "rgba(255,244,214,1)", "rgba(255,196,92,0.5)");
    // The shy ones are pale - cool silver-teal against the normal motes' warm
    // gold, so which kind you are walking toward is legible at a glance.
    makeGlowTexture(this, "mote-shy", 27, "rgba(228,252,248,1)", "rgba(148,226,214,0.5)");
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
      // No seeded mote may sit close to the beacon: once the beacon is open,
      // arriving completes the level, so a mote whose whole collect circle
      // lies inside the completion radius is uncollectable from then on -
      // an invisible ordering trap for flawless runs (level 2's seed
      // genuinely placed one 32px from the beacon). Offenders are pushed
      // radially out to a clear ring, deterministically. Hand-authored
      // layouts are exempt: their beacon-adjacent motes are deliberate,
      // placed where the approach from the level's interior collects them
      // outside the completion radius.
      const minR = BEACON_RADIUS + COLLECT_RADIUS + 25;
      for (const m of this.moteConfigs) {
        const d = Phaser.Math.Distance.Between(m.x, m.y, BEACON_X, BEACON_Y);
        if (d >= minR) continue;
        const ux = d > 0 ? (m.x - BEACON_X) / d : 1;
        const uy = d > 0 ? (m.y - BEACON_Y) / d : 0;
        let px = BEACON_X + ux * minR;
        let py = BEACON_Y + uy * minR;
        if (py < 110) {
          // A straight push would leave the playfield band; slide along the
          // ring instead so the distance still holds.
          py = 110;
          const dx = Math.sqrt(Math.max(minR * minR - (BEACON_Y - py) * (BEACON_Y - py), 0));
          px = BEACON_X + (ux >= 0 ? dx : -dx);
        }
        m.x = px;
        m.y = py;
      }
    }
    this.totalMotes = this.moteConfigs.length;
    this.spawnMotes();
  }

  /**
   * Which motes are shy, chosen by a dedicated seeded shuffle so the pick is
   * identical on every spawn of the same level - a respawn after a snuff
   * rebuilds the exact same clearing, pale motes in the same places.
   */
  private pickShyIndices(): Set<number> {
    const out = new Set<number>();
    const shy = this.config.shy;
    if (!shy) return out;
    const rng = new Phaser.Math.RandomDataGenerator([`start-of-glow-shy-${this.config.index}`]);
    const eligible = this.moteConfigs
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => Phaser.Math.Distance.Between(m.x, m.y, START_X, START_Y) > SHY_MIN_SPAWN_DIST)
      .map(({ i }) => i);
    const order = rng.shuffle(eligible);
    for (const i of order.slice(0, Math.min(shy.count, order.length))) out.add(i);
    return out;
  }

  private spawnMotes(): void {
    for (const m of this.motes) {
      this.tweens.killTweensOf(m.img);
      m.img.destroy();
    }
    this.motes = [];
    const shyIndices = this.pickShyIndices();
    const rng = new Phaser.Math.RandomDataGenerator([`start-of-glow-motes-${this.config.index}`]);
    this.moteConfigs.forEach((cfg, i) => {
      const shy = shyIndices.has(i);
      const img = this.add
        .image(cfg.x, cfg.y, shy ? "mote-shy" : "mote")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.55)
        .setDepth(5);
      if (shy) {
        // No tween: shy motes are simulated in updateShyMotes, which drives
        // their bob and alpha itself - see the MoteState note.
        img.setAlpha(0.88);
      } else {
        this.tweens.add({
          targets: img,
          y: cfg.y - rng.between(8, 21),
          alpha: { from: 0.55, to: 1 },
          duration: rng.between(1200, 2200),
          yoyo: true,
          repeat: -1,
          ease: "Sine.easeInOut",
        });
      }
      this.motes.push({
        img,
        shy,
        home: { x: cfg.x, y: cfg.y },
        pos: { x: cfg.x, y: cfg.y },
        stamina: 1,
        startleMs: 0,
        exhausted: false,
        phase: rng.realInRange(0, Math.PI * 2),
        pop: 0,
      });
    });
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
    this.wispLight = this.lights.addLight(this.wisp.x, this.wisp.y, 347, 0xbfe4ff, 1.6);
    this.trail.startFollow(this.wisp);
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
      const hazard = { img, light, alert: false };
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

    this.buildWinds();

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
   * The wind zones' visible bodies (round 2): each current carries its own
   * denser fleck stream flowing along its push vector, world-anchored inside
   * the zone's rectangle - so the force is readable before it is felt, the
   * same fairness rule the hazards' cold lights follow. The ambient storm
   * flecks stay screen-space set dressing; these are the mechanic's telltale.
   */
  private buildWinds(): void {
    for (const z of this.config.winds ?? []) {
      const stream = this.add.particles(0, 0, "spark", {
        emitZone: {
          type: "random",
          source: new Phaser.Geom.Rectangle(z.x, z.y, z.w, z.h),
          quantity: 1,
        },
        speedX: { min: z.vx * 0.85, max: z.vx * 1.25 },
        speedY: { min: z.vy * 0.85, max: z.vy * 1.25 },
        lifespan: { min: 900, max: 1700 },
        scale: { start: 0.34, end: 0.1 },
        alpha: { start: 0.42, end: 0 },
        quantity: 1,
        frequency: 26,
        tint: [0x9db4e8, 0xbcd0f4, 0x86a0d8],
        blendMode: Phaser.BlendModes.ADD,
      });
      stream.setDepth(-6);
    }
  }

  /**
   * A shadow-wisp that has noticed the player: closer than ALERT_RADIUS for
   * even one frame speeds it up (via the running patrol tween's timeScale,
   * not a rewritten path - still fully deterministic for a fixed play, just
   * reactive to it) and brightens its own light as a fair "it sees you"
   * telegraph. Patrol *shape* never changes, only its pace and how visible
   * it is - a hazard should feel alive without ever feeling like it cheated.
   */
  private checkHazardAlerts(): void {
    for (const h of this.hazards) {
      const dist = Phaser.Math.Distance.Between(h.img.x, h.img.y, this.wisp.x, this.wisp.y);
      const alert = dist <= ALERT_RADIUS;
      if (alert === h.alert) continue;
      h.alert = alert;
      if (h.tween) h.tween.timeScale = alert ? ALERT_TIME_SCALE : 1;
      h.light.intensity = alert ? ALERT_LIGHT_INTENSITY : CALM_LIGHT_INTENSITY;
    }
  }

  private patrol(
    hazard: { img: Phaser.GameObjects.Image; light: Phaser.GameObjects.Light; tween?: Phaser.Tweens.Tween; alert: boolean },
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
    if (hazard.alert) hazard.tween.timeScale = ALERT_TIME_SCALE;
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
      .text(VIEW_WIDTH / 2, 80, "the beacon is lit", {
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: "17px",
        color: "#ffd9a0",
      })
      .setOrigin(0.5, 0)
      .setAlpha(0)
      .setDepth(100)
      .setScrollFactor(0);

    this.whisperLine = this.add
      .text(VIEW_WIDTH / 2, 108, "", {
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: "16px",
        color: "#9db4d8",
      })
      .setOrigin(0.5, 0)
      .setAlpha(0)
      .setDepth(100)
      .setScrollFactor(0);

    this.updateHud();
  }

  /** One quiet teaching line, used at most once per level visit - see updateShyMotes. */
  private showWhisper(text: string): void {
    this.whisperLine.setText(text);
    this.tweens.killTweensOf(this.whisperLine);
    this.whisperLine.setAlpha(0);
    this.tweens.add({
      targets: this.whisperLine,
      alpha: { from: 0, to: 0.8 },
      duration: 700,
      yoyo: true,
      hold: 2600,
      ease: "Sine.easeInOut",
    });
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
      this.pulse();
    });
    this.cursors = this.input.keyboard!.createCursorKeys();
  }

  private pulse(): void {
    this.pulseBoost = 1.6;
    this.trail.explode(24, this.wisp.x, this.wisp.y);
  }

  private baseIntensity(): number {
    return 1.6 + this.collected * 0.06;
  }

  update(time: number, delta: number): void {
    if (this.locked) return;

    const dt = delta / 1000;
    const step = dt * WISP_MAX_SPEED;
    if (this.cursors.left.isDown) this.target.x -= step;
    if (this.cursors.right.isDown) this.target.x += step;
    if (this.cursors.up.isDown) this.target.y -= step;
    if (this.cursors.down.isDown) this.target.y += step;
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
    // The wisp's own pace this frame, px per game-second - what the shy motes
    // react to. Player motion only (post-cap), measured before wind: the storm
    // moving you is not you rushing anyone.
    const wispSpeed = dt > 0 ? Math.sqrt(dx * dx + dy * dy) / dt : 0;

    // Wind (round 2): a current pushes the wisp AND its chase target, so the
    // drift is real displacement, not a nudge the trailing ease immediately
    // pulls back (pushing only the wisp left a ~20px equilibrium wobble - the
    // proportional pull toward a pinned target cancels any constant force).
    // Pushing both means a light left unattended genuinely blows downwind
    // until the player fights back - every pointer twitch re-pins the target
    // to the cursor, and the 480 px/s cap vs |wind| <= ~120 keeps escape easy.
    // Applied after the cap on purpose: the cap governs what the PLAYER can
    // do; the storm is the world doing something to them.
    for (const z of this.config.winds ?? []) {
      if (
        this.wisp.x >= z.x && this.wisp.x <= z.x + z.w &&
        this.wisp.y >= z.y && this.wisp.y <= z.y + z.h
      ) {
        this.wisp.x += z.vx * dt;
        this.wisp.y += z.vy * dt;
        this.target.x += z.vx * dt;
        this.target.y += z.vy * dt;
      }
    }
    this.wisp.x = Phaser.Math.Clamp(this.wisp.x, 27, WORLD_WIDTH - 27);
    this.wisp.y = Phaser.Math.Clamp(this.wisp.y, 27, WORLD_HEIGHT - 27);
    this.wispLight.setPosition(this.wisp.x, this.wisp.y);
    this.hazardTrail.setPosition(0, 0);

    const breathe = Math.sin(time * 0.0007) * 0.12;
    this.pulseBoost = Phaser.Math.Linear(this.pulseBoost, 0, 1 - Math.pow(0.001, dt));
    this.wispLight.intensity = this.baseIntensity() + breathe + this.pulseBoost;

    for (const h of this.hazards) {
      this.hazardTrail.emitParticleAt(h.img.x, h.img.y, 1);
    }
    this.checkHazardAlerts();
    this.updateShyMotes(dt, time, wispSpeed);

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
    // Motes included since round 2: the shy ones move, and a driver reading
    // stale coordinates would chase spots a mote left seconds ago.
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
      if (published.motes.length === this.motes.length) {
        for (let i = 0; i < this.motes.length; i += 1) {
          published.motes[i].x = Math.round(this.motes[i].img.x);
          published.motes[i].y = Math.round(this.motes[i].img.y);
        }
      }
    }
  }

  /**
   * The shy-mote simulation (level 2's mechanic - see ShyConfig in levels.ts).
   * A rushing wisp inside the shy radius startles a pale mote; startle lingers
   * SHY_STARTLE_MS past the last rush, and while startled-and-near the mote
   * flees straight away from the wisp, tiring as it goes - flight drains its
   * stamina, its speed sags with it, and an empty pool leaves it settled and
   * dim until it recovers. A calm approach never triggers any of this: drift
   * in slowly and a shy mote is collected like any other. Fleeing is biased
   * away from the beacon so a chase can never drag the player into an
   * accidental level completion, and clamped to the playfield so "walled" is
   * a real place a pursuit ends.
   */
  private updateShyMotes(dt: number, timeMs: number, wispSpeed: number): void {
    const shy = this.config.shy;
    if (!shy) return;
    for (const m of this.motes) {
      if (!m.shy) continue;
      const dist = Phaser.Math.Distance.Between(m.pos.x, m.pos.y, this.wisp.x, this.wisp.y);
      const near = dist <= shy.radius;
      if (near && wispSpeed > shy.rushSpeed && !m.exhausted) {
        // A fresh startle (not the sustained one a chase keeps refreshed)
        // gets its telegraphs: the scale pop, and - rate-limited so a
        // startled cluster reads as one darting - the skitter sound.
        if (m.startleMs <= 0) {
          m.pop = 1;
          if (timeMs - this.lastSkitterAt > 350) {
            this.lastSkitterAt = timeMs;
            this.ambience.skitter();
          }
        }
        m.startleMs = SHY_STARTLE_MS;
        if (!this.whisperShown) {
          this.whisperShown = true;
          this.showWhisper("the pale ones startle at a rushing light");
        }
      } else {
        m.startleMs = Math.max(0, m.startleMs - dt * 1000);
      }

      const fleeing = !m.exhausted && near && m.startleMs > 0;
      if (fleeing) {
        m.stamina = Math.max(0, m.stamina - dt / SHY_DRAIN_SECONDS);
        if (m.stamina === 0) m.exhausted = true;
        let dx = m.pos.x - this.wisp.x;
        let dy = m.pos.y - this.wisp.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        const bDist = Phaser.Math.Distance.Between(m.pos.x, m.pos.y, BEACON_X, BEACON_Y);
        if (bDist < 260) {
          const bw = ((260 - bDist) / 260) * 1.4;
          dx += ((m.pos.x - BEACON_X) / (bDist || 1)) * bw;
          dy += ((m.pos.y - BEACON_Y) / (bDist || 1)) * bw;
          const len2 = Math.hypot(dx, dy) || 1;
          dx /= len2;
          dy /= len2;
        }
        const speed = shy.fleeSpeed * (0.45 + 0.55 * m.stamina);
        m.pos.x = Phaser.Math.Clamp(m.pos.x + dx * speed * dt, 40, WORLD_WIDTH - 40);
        m.pos.y = Phaser.Math.Clamp(m.pos.y + dy * speed * dt, 110, WORLD_HEIGHT - 80);
      } else {
        m.stamina = Math.min(1, m.stamina + dt / SHY_REGAIN_SECONDS);
        if (m.exhausted && m.stamina >= SHY_RECOVER_AT) m.exhausted = false;
        // With the player well away, a displaced mote drifts back toward its
        // home spot - the clearing quietly rearranges itself behind you.
        if (dist > shy.radius * 1.6) {
          const hx = m.home.x - m.pos.x;
          const hy = m.home.y - m.pos.y;
          const hd = Math.hypot(hx, hy);
          if (hd > 6) {
            const step = Math.min(SHY_HOME_SPEED * dt, hd);
            m.pos.x += (hx / hd) * step;
            m.pos.y += (hy / hd) * step;
          }
        }
      }

      const bob = fleeing ? 0 : Math.sin(timeMs * 0.0021 + m.phase) * 4;
      m.img.setPosition(m.pos.x, m.pos.y + bob);
      const targetAlpha = m.exhausted ? 0.55 : fleeing ? 1 : 0.88;
      m.img.alpha = Phaser.Math.Linear(m.img.alpha, targetAlpha, 1 - Math.pow(0.02, dt));
      m.pop = Phaser.Math.Linear(m.pop, 0, 1 - Math.pow(0.005, dt));
      m.img.setScale(0.55 + m.pop * 0.09);
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
      if (Phaser.Math.Distance.Between(mote.img.x, mote.img.y, this.wisp.x, this.wisp.y) > COLLECT_RADIUS) continue;
      this.motes.splice(i, 1);
      this.tweens.killTweensOf(mote.img);
      this.trail.explode(18, mote.img.x, mote.img.y);
      mote.img.destroy();
      this.collected += 1;
      this.ambience.chime(this.collected);
      this.grow();
    }
  }

  /** How many motes open the beacon this level (defensively never above what was actually placed). */
  private requiredMotes(): number {
    return Math.min(this.config.requiredMotes, this.totalMotes);
  }

  private grow(): void {
    this.wispLight.radius = 347 + this.collected * 20;
    this.wisp.setScale(0.5 + this.collected * 0.018);

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
    this.cameras.main.flash(220, 40, 10, 60);
    this.cameras.main.shake(220, 0.006);

    this.tweens.add({
      targets: this.wispLight,
      intensity: 0.05,
      radius: 90,
      duration: 260,
      ease: "Quad.easeIn",
    });
    this.wisp.setScale(0.2);

    this.after(560, () => {
      this.target.set(START_X, START_Y);
      this.wisp.setPosition(START_X, START_Y);
      this.wispLight.setPosition(START_X, START_Y);
      this.wisp.setScale(0.5);
      // Restore the light itself too - the snuff tween shrank its radius, and
      // nothing else resets it until the next collect. A respawned light
      // should match a fresh spawn at zero motes, not stay snuffed-small.
      this.tweens.killTweensOf(this.wispLight);
      this.wispLight.radius = 347;
      this.wispLight.intensity = this.baseIntensity();
      this.collected = 0;
      this.levelClear = false;
      this.flawlessNow = false;
      this.beacon.setAlpha(0.05);
      this.beaconLight.intensity = 0;
      this.beaconLight.setColor(0xffcf8a);
      this.tweens.killTweensOf(this.beacon);
      this.beacon.setScale(1);
      this.tweens.killTweensOf(this.openLine);
      this.openLine.setAlpha(0);
      this.spawnMotes();
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
    this.cameras.main.flash(280, 255, 232, 190);
    this.cameras.main.fadeOut(520, 8, 7, 14);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      const next = this.config.index + 1;
      if (levelFor(next)) {
        this.scene.start("level", { levelIndex: next, ambience: this.ambience, resets: this.resets, flawless });
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
      motes: this.motes.map((m) => ({ x: Math.round(m.img.x), y: Math.round(m.img.y), shy: m.shy })),
      hazards: this.hazards.map((h) => ({ x: Math.round(h.img.x), y: Math.round(h.img.y) })),
      winds: this.config.winds ?? [],
      activeTweens: this.tweens.getTweens().length,
    };
  }
}
