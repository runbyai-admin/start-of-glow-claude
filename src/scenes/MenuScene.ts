import Phaser from "phaser";
import { makeGlowTexture, makeSkyTexture } from "../textures";
import { Ambience } from "../audio";
import { VIEW_HEIGHT, VIEW_WIDTH } from "./dimensions";

const ambience = new Ambience();

const BEST_RESETS_KEY = "start-of-glow-best-resets";
const WISP_MAX_SPEED = 480; // same cap as LevelScene - the menu IS the game's movement
const BEACON = { x: 1010, y: 400 };
const BEGIN_DIST = 64;

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
 */
export class MenuScene extends Phaser.Scene {
  private wisp!: Phaser.GameObjects.Image;
  private wispLight!: Phaser.GameObjects.Light;
  private beacon!: Phaser.GameObjects.Image;
  private beaconLight!: Phaser.GameObjects.Light;
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
  }

  create(): void {
    this.lights.enable().setAmbientColor(0x0a0d18);
    this.cameras.main.setBackgroundColor(0x05060c);
    this.begun = false;
    this.hintShown = false;
    this.idleMs = 0;
    this.target = { x: 250, y: 480 };

    this.add.image(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, "sky").setDepth(-100);

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

    this.wisp = this.add
      .image(this.target.x, this.target.y, "wisp")
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.62)
      .setDepth(10);
    this.wispLight = this.lights.addLight(this.wisp.x, this.wisp.y, 420, 0xbfe4ff, 1.7);

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
    this.tweens.add({ targets: title, alpha: 1, duration: 1400, ease: "Sine.easeOut" });

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
      this.tweens.add({ targets: bestLine, alpha: 0.55, duration: 1400, delay: 900, ease: "Sine.easeOut" });
    }

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
    });

    this.events.once(Phaser.Scenes.Events.POST_UPDATE, () => {
      document.body.dataset.gameReady = "true";
    });
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
    this.wispLight.intensity = 1.7 + breathe;
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

  private begin(): void {
    if (this.begun) return;
    this.begun = true;
    ambience.unlock();
    // The beacon answers before the cut - same warm swell the levels use.
    this.tweens.add({ targets: this.beacon, alpha: 1, scale: 1.35, duration: 340, ease: "Sine.easeOut" });
    this.tweens.add({ targets: this.beaconLight, intensity: 3.2, radius: 700, duration: 340, ease: "Sine.easeOut" });
    this.cameras.main.fadeOut(420, 5, 6, 12);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start("level", { levelIndex: 1, ambience });
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
