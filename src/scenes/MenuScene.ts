import Phaser from "phaser";
import {
  makeGlowTexture,
  makeGroundTexture,
  makeHillsTexture,
  makeSkyTexture,
  makeTreeTexture,
} from "../textures";
import { Ambience } from "../audio";
import { LEVELS } from "../levels";
import { VIEW_HEIGHT, VIEW_WIDTH } from "./dimensions";

const ambience = new Ambience();

const BEST_RESETS_KEY = "start-of-glow-best-resets";
const WISP_MAX_SPEED = 480; // same cap as LevelScene - the menu IS the game's movement
const BEACON = { x: 1010, y: 400 };
const BEGIN_DIST = 64;

// The clearing's own pre-dawn palette - a touch colder than any level, so the
// levels still get to feel like somewhere you went.
const MENU_TREE_TINTS = [0x16203a, 0x1a2743, 0x141c33];
const MENU_GROUND_TINT = 0x151b2f;
const MENU_HILLS_TINT = 0x0e1526;

/**
 * The title screen, round 2: not a screen in front of the game but the game's
 * first clearing. The wisp is already alive here - light follows the cursor
 * with exactly LevelScene's trailing movement - and starting is done in the
 * game's own language: carry your light into the lit beacon. The core verb is
 * taught wordlessly before play begins (SPEC.md's "wordless where possible";
 * the round-2 brief judges "the screen you arrive at before any of it
 * starts"). Enter or Space still begins immediately - the accessibility and
 * test path - and a quiet hint line fades in only if nothing has happened for
 * a while. Shares the module-singleton Ambience so audio unlocked here keeps
 * working across scenes.
 *
 * Round 2 extension: the clearing is a real place now, in the same idiom as
 * the levels - silhouette trees and ground on the Light2D pipeline, so the
 * player's own light reveals the world it is standing in; fireflies drift in
 * the dark; the wisp *arrives* (light blooms in from nothing) rather than
 * popping into existence; and the shell grows its first setting - `m` toggles
 * sound, persisted, honored everywhere.
 */
export class MenuScene extends Phaser.Scene {
  private wisp!: Phaser.GameObjects.Image;
  private wispLight!: Phaser.GameObjects.Light;
  private beacon!: Phaser.GameObjects.Image;
  private beaconLight!: Phaser.GameObjects.Light;
  private soundLine!: Phaser.GameObjects.Text;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private target = { x: 250, y: 480 };
  private begun = false;
  private hintShown = false;
  private idleMs = 0;

  constructor() {
    super("menu");
  }

  preload(): void {
    makeSkyTexture(this, "sky", VIEW_WIDTH, VIEW_HEIGHT, 11);
    makeGlowTexture(this, "wisp", 85, "rgba(255,255,255,1)", "rgba(150,214,255,0.55)");
    makeGlowTexture(this, "menu-beacon", 170, "rgba(255,226,168,1)", "rgba(255,182,102,0.4)");
    makeGlowTexture(this, "title-glow", 170, "rgba(214,232,255,0.5)", "rgba(140,180,240,0.18)");
    makeGlowTexture(this, "firefly", 12, "rgba(226,255,196,1)", "rgba(198,255,130,0.4)");
    // Same key + params as LevelScene's spark - the trail must match exactly.
    makeGlowTexture(this, "spark", 16, "rgba(255,255,255,0.9)", "rgba(190,226,255,0.35)");
    // Menu-sized world pieces. The level's "ground"/"hills" keys are wider
    // textures - makeCanvasTexture returns early on an existing key, so a
    // shared key here would hand the levels a half-width world. Distinct keys.
    makeHillsTexture(this, "menu-hills", 1400, 260, 3);
    makeGroundTexture(this, "menu-ground", VIEW_WIDTH, 220, 5);
    // Same dims and seeds as LevelScene's trees - shared on purpose: identical
    // silhouettes, and the level's preload finds them already made.
    for (let i = 0; i < 4; i += 1) {
      makeTreeTexture(this, `tree-${i}`, 240, 560, i + 1);
    }
  }

  create(): void {
    this.lights.enable().setAmbientColor(0x0a0d18);
    this.cameras.main.setBackgroundColor(0x05060c);
    this.begun = false;
    this.hintShown = false;
    this.idleMs = 0;
    this.target = { x: 250, y: 480 };

    this.buildClearing();

    // The beacon: the destination that is also the start button.
    this.beacon = this.add
      .image(BEACON.x, BEACON.y, "menu-beacon")
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.85)
      .setAlpha(0.55)
      .setDepth(5);
    this.beaconLight = this.lights.addLight(BEACON.x, BEACON.y, 320, 0xffcf8a, 1.5);
    this.tweens.add({
      targets: this.beacon,
      alpha: 0.8,
      scale: 0.95,
      duration: 2600,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    // The wisp arrives: the sprite and its light bloom in from nearly nothing,
    // the same reveal gesture the whole game is built on, played first here.
    // It wears the same spark trail as in the levels - it IS the same being,
    // and the menu teaching only holds if nothing about it changes at start.
    const trail = this.add.particles(0, 0, "spark", {
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
    trail.setDepth(9);
    this.wisp = this.add
      .image(this.target.x, this.target.y, "wisp")
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.62)
      .setAlpha(0)
      .setDepth(10);
    trail.startFollow(this.wisp);
    this.wispLight = this.lights.addLight(this.wisp.x, this.wisp.y, 90, 0xbfe4ff, 0.25);
    this.tweens.add({ targets: this.wisp, alpha: 1, duration: 1100, ease: "Sine.easeOut" });
    this.tweens.add({
      targets: this.wispLight,
      radius: 420,
      intensity: 1.7,
      duration: 1500,
      ease: "Sine.easeOut",
    });

    // A soft cool halo behind the title, breathing slowly - the words sit in
    // the world's light instead of floating over it.
    const halo = this.add
      .image(VIEW_WIDTH / 2, VIEW_HEIGHT * 0.3, "title-glow")
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(3.2, 1.05)
      .setAlpha(0)
      .setDepth(19);
    this.tweens.add({ targets: halo, alpha: 0.16, duration: 2000, delay: 500, ease: "Sine.easeOut" });
    this.tweens.add({
      targets: halo,
      scaleX: 3.45,
      duration: 3800,
      delay: 2500,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    const title = this.add
      .text(VIEW_WIDTH / 2, VIEW_HEIGHT * 0.3, "START OF GLOW", {
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: "58px",
        color: "#f2ead8",
        letterSpacing: 6,
      })
      .setOrigin(0.5)
      .setAlpha(0)
      .setDepth(20);
    this.tweens.add({ targets: title, alpha: 1, duration: 1400, delay: 400, ease: "Sine.easeOut" });

    // A returning player's best run, discovered rather than announced.
    const best = this.readBest();
    if (best !== null) {
      const bestLine = this.add
        .text(VIEW_WIDTH / 2, VIEW_HEIGHT * 0.3 + 46, best === 0 ? "the dark never caught you" : `fewest resets: ${best}`, {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "13px",
          color: "#a9987a",
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(20);
      this.tweens.add({ targets: bestLine, alpha: 0.55, duration: 1400, delay: 1100, ease: "Sine.easeOut" });
    }

    // The shell's first setting: sound, toggled with one key, remembered.
    this.soundLine = this.add
      .text(VIEW_WIDTH - 24, VIEW_HEIGHT - 20, this.soundLabel(), {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "12px",
        color: "#63769a",
      })
      .setOrigin(1, 1)
      .setAlpha(0)
      .setDepth(20);
    this.tweens.add({ targets: this.soundLine, alpha: 0.5, duration: 1400, delay: 1400, ease: "Sine.easeOut" });

    this.cursors = this.input.keyboard!.createCursorKeys();

    // Pointer steers; a press anywhere also unlocks audio (a real gesture).
    this.input.on(Phaser.Input.Events.POINTER_MOVE, (p: Phaser.Input.Pointer) => {
      this.target.x = p.worldX;
      this.target.y = p.worldY;
      this.idleMs = 0;
    });
    this.input.on(Phaser.Input.Events.POINTER_DOWN, (p: Phaser.Input.Pointer) => {
      ambience.unlock();
      this.target.x = p.worldX;
      this.target.y = p.worldY;
      this.idleMs = 0;
    });
    this.input.keyboard!.on("keydown", (ev: KeyboardEvent) => {
      ambience.unlock();
      this.idleMs = 0;
      if (ev.key === "Enter" || ev.key === " ") this.begin();
      if (ev.key === "m" || ev.key === "M") {
        ambience.toggleMuted();
        this.soundLine.setText(this.soundLabel());
      }
    });

    this.events.once(Phaser.Scenes.Events.POST_UPDATE, () => {
      document.body.dataset.gameReady = "true";
    });
  }

  /**
   * The clearing itself - the same world idiom as the levels (silhouettes on
   * the Light2D pipeline, lit by the player's own glow), composed for one
   * fixed frame: a stand of trees on the left where the wisp wakes, an open
   * middle for the title, the treeline thinning toward the beacon.
   */
  private buildClearing(): void {
    this.add.image(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, "sky").setDepth(-100);

    this.add.image(-40, 570, "menu-hills").setOrigin(0, 1).setTint(MENU_HILLS_TINT).setDepth(-40);

    const trees: Array<{ x: number; scale: number; tex: number; tint: number }> = [
      { x: 88, scale: 1.18, tex: 0, tint: 0 },
      { x: 218, scale: 0.92, tex: 2, tint: 1 },
      { x: 338, scale: 1.06, tex: 1, tint: 2 },
      { x: 585, scale: 0.78, tex: 3, tint: 1 },
      { x: 1168, scale: 1.12, tex: 3, tint: 0 },
      { x: 1262, scale: 0.9, tex: 0, tint: 2 },
    ];
    for (const t of trees) {
      this.add
        .image(t.x, 604, `tree-${t.tex}`)
        .setOrigin(0.5, 1)
        .setScale(t.scale)
        .setTint(MENU_TREE_TINTS[t.tint])
        .setDepth(-30)
        .setPipeline("Light2D");
    }

    this.add
      .image(0, VIEW_HEIGHT, "menu-ground")
      .setOrigin(0, 1)
      .setTint(MENU_GROUND_TINT)
      .setDepth(-10)
      .setPipeline("Light2D");

    const rng = new Phaser.Math.RandomDataGenerator(["start-of-glow-menu-fireflies"]);
    for (let i = 0; i < 7; i += 1) {
      const startX = rng.between(60, VIEW_WIDTH - 60);
      const startY = rng.between(200, VIEW_HEIGHT - 130);
      const firefly = this.add
        .image(startX, startY, "firefly")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(rng.realInRange(0.5, 1))
        .setAlpha(rng.realInRange(0.3, 0.7))
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

  private soundLabel(): string {
    return ambience.isMuted() ? "m · sound off" : "m · sound on";
  }

  update(time: number, delta: number): void {
    if (this.begun) return;

    const dt = delta / 1000;
    const step = dt * WISP_MAX_SPEED;
    if (this.cursors.left.isDown) { this.target.x -= step; this.idleMs = 0; }
    if (this.cursors.right.isDown) { this.target.x += step; this.idleMs = 0; }
    if (this.cursors.up.isDown) { this.target.y -= step; this.idleMs = 0; }
    if (this.cursors.down.isDown) { this.target.y += step; this.idleMs = 0; }
    this.target.x = Phaser.Math.Clamp(this.target.x, 27, VIEW_WIDTH - 27);
    this.target.y = Phaser.Math.Clamp(this.target.y, 27, VIEW_HEIGHT - 27);

    // Same trailing ease + hard cap as LevelScene - the menu must FEEL like
    // the game it opens, or the teaching is a lie.
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

    const breathe = Math.sin(time * 0.0009) * 0.25;
    // Only breathe once the entrance bloom has finished - fighting the
    // arrival tween for the same value would stutter it.
    if (!this.tweens.isTweening(this.wispLight)) {
      this.wispLight.intensity = 1.7 + breathe;
    }
    this.wispLight.setPosition(this.wisp.x, this.wisp.y);

    // Arriving at the beacon IS pressing start.
    if (Phaser.Math.Distance.Between(this.wisp.x, this.wisp.y, BEACON.x, BEACON.y) < BEGIN_DIST) {
      this.begin();
      return;
    }

    // A quiet hint only for a player who has genuinely stalled.
    this.idleMs += delta;
    if (!this.hintShown && this.idleMs > 7000) {
      this.hintShown = true;
      const hint = this.add
        .text(VIEW_WIDTH / 2, VIEW_HEIGHT * 0.82, "carry your light to the beacon", {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "15px",
          color: "#7e93b8",
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(20);
      this.tweens.add({
        targets: hint,
        alpha: { from: 0.3, to: 0.8 },
        duration: 1600,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
    }

    this.reportState();
  }

  private readBest(): number | null {
    try {
      const raw = window.localStorage.getItem(BEST_RESETS_KEY);
      if (raw === null) return null;
      const n = parseInt(raw, 10);
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * Where a run begins. Normally level 1; a `?level=N` query is the test
   * hook that lets headless drivers (and a debugging human) open a later
   * level directly - see ARCHITECTURE.md "Verifying a change". Out of range
   * or absent falls back to 1, so the hook can never break a normal start.
   */
  private startLevelIndex(): number {
    try {
      const n = parseInt(new URLSearchParams(window.location.search).get("level") ?? "", 10);
      return Number.isInteger(n) && n >= 1 && n <= LEVELS.length ? n : 1;
    } catch {
      return 1;
    }
  }

  private begin(): void {
    if (this.begun) return;
    this.begun = true;
    ambience.unlock();
    // The beacon answers before the cut - same warm swell the levels use.
    this.tweens.add({ targets: this.beacon, alpha: 1, scale: 1.35, duration: 340, ease: "Sine.easeOut" });
    this.tweens.add({ targets: this.beaconLight, intensity: 3.2, radius: 700, duration: 340, ease: "Sine.easeOut" });
    this.cameras.main.fadeOut(420, 5, 6, 12);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start("level", { levelIndex: this.startLevelIndex(), ambience });
    });
  }

  private reportState(): void {
    window.__glow = {
      ready: true,
      scene: "menu",
      collected: 0,
      remaining: 0,
      glowRadius: this.wispLight.radius,
      lightsActive: this.lights.active,
      level: 0,
      resets: 0,
      required: 0,
      beaconOpen: true,
      flawless: 0,
      wispX: Math.round(this.wisp.x),
      wispY: Math.round(this.wisp.y),
      motes: [],
      hazards: [],
    };
  }
}
