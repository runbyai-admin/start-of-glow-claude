import Phaser from "phaser";
import { makeGlowTexture, makeSkyTexture } from "../textures";
import type { Ambience } from "../audio";
import { VIEW_HEIGHT, VIEW_WIDTH, WORLD_WIDTH } from "./dimensions";
import { HOLLOW_LAYOUT } from "../hollow";

interface EndingInitData {
  ambience: Ambience;
  resets: number;
  /** Flawless levels (every mote found) completed this run. */
  flawless?: number;
  /** The run came through the Hollow: the light was given back, and dawn is earned. */
  dawn?: boolean;
  hearths?: number;
}

/**
 * The payoff for finishing the last level: the thing the whole game has been
 * building - light growing until it fills the frame - happens one final time,
 * at full scale, uninterrupted. Wordless except for one short line, per
 * SPEC.md's "text is a fallback, not a feature."
 */
const BEST_RESETS_KEY = "start-of-glow-best-resets";

export class EndingScene extends Phaser.Scene {
  private ambience!: Ambience;
  private resets = 0;
  private flawless = 0;
  private dawn = false;
  private hearths = 0;
  private isNewBest = false;
  /** The dawn's constellation: the Hollow's hearths and the roads between them, drawn in on scene time. */
  private roadsGfx?: Phaser.GameObjects.Graphics;
  private roadsStart = 0;

  /**
   * The roads the player lit, seen from above as the sun comes up: hearth to
   * hearth in the order the Hollow was built, ending at the tree. Drawn on
   * scene time rather than tweened, so the replay harness sees the same
   * reveal a player does.
   */
  private drawRoads(time: number): void {
    const g = this.roadsGfx;
    if (!g) return;
    g.clear();
    const t = Math.max(0, Math.min(1, (time - this.roadsStart) / 4800));
    // High in the frame, above the wisp's bloom (which grows to cover the
    // middle third in real time), and each line drawn twice: a dark stroke
    // underneath that survives the bloom, a light one on top for the sky.
    const pts = HOLLOW_LAYOUT.hearths.map((h) => ({
      x: VIEW_WIDTH * 0.16 + (h.x / WORLD_WIDTH) * VIEW_WIDTH * 0.68,
      y: VIEW_HEIGHT * 0.07 + ((h.y - 200) / 380) * VIEW_HEIGHT * 0.17,
      final: h.final === true,
    }));
    const segments = pts.length - 1;
    for (let i = 0; i < segments; i += 1) {
      const local = Math.max(0, Math.min(1, t * (segments + 1) - i));
      if (local <= 0) continue;
      const a = pts[i];
      const b = pts[i + 1];
      const ex = a.x + (b.x - a.x) * local;
      const ey = a.y + (b.y - a.y) * local;
      g.lineStyle(4, 0x4a1c08, 0.55 * local);
      g.lineBetween(a.x, a.y, ex, ey);
      g.lineStyle(1.4, 0xffd9a8, 0.6 * local);
      g.lineBetween(a.x, a.y, ex, ey);
    }
    pts.forEach((p, i) => {
      const local = Math.max(0, Math.min(1, t * (segments + 1) - i + 0.6));
      if (local <= 0) return;
      g.fillStyle(0x4a1c08, 0.6 * local);
      g.fillCircle(p.x, p.y, p.final ? 9 : 6);
      g.fillStyle(0xffd9a8, 0.9 * local);
      g.fillCircle(p.x, p.y, p.final ? 6 : 3.5);
    });
  }

  update(time: number): void {
    if (this.roadsGfx) this.drawRoads(time);
  }

  constructor() {
    super("ending");
  }

  init(data: EndingInitData): void {
    this.ambience = data.ambience;
    this.resets = data.resets ?? 0;
    this.flawless = data.flawless ?? 0;
    this.dawn = data.dawn ?? false;
    this.hearths = data.hearths ?? 0;
    this.isNewBest = this.recordBest(this.resets);
  }

  /**
   * localStorage only, no backend, no account - the whole game already has
   * neither. Only worth celebrating against a PRIOR run: a first-ever clear
   * quietly sets the baseline rather than announcing a "best" with nothing
   * to compare against. Wrapped defensively - private browsing or storage
   * being unavailable should never be able to break the ending.
   */
  private recordBest(resets: number): boolean {
    try {
      const raw = window.localStorage.getItem(BEST_RESETS_KEY);
      const prevBest = raw === null ? null : Number(raw);
      const hadPrior = prevBest !== null && Number.isFinite(prevBest);
      const isBest = !hadPrior || resets < (prevBest as number);
      if (isBest) window.localStorage.setItem(BEST_RESETS_KEY, String(resets));
      return hadPrior && isBest;
    } catch {
      return false;
    }
  }

  preload(): void {
    makeSkyTexture(this, "sky", VIEW_WIDTH, VIEW_HEIGHT, 11);
    makeGlowTexture(this, "wisp", 85, "rgba(255,255,255,1)", "rgba(150,214,255,0.55)");
  }

  create(): void {
    // A dawn ending is warm from the first frame - the Hollow's First Tree
    // took the light, so the black the game has held for four acts finally
    // gives. A forest ending keeps the old night.
    this.lights.enable().setAmbientColor(this.dawn ? 0x2a1a10 : 0x0a0d18);
    this.cameras.main.setBackgroundColor(this.dawn ? 0x1a0e08 : 0x05060c);

    const sky = this.add.image(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, "sky").setDepth(-100);
    if (this.dawn) {
      sky.setTint(0xff9a5a).setAlpha(0.85);
      // Tinting a night sky cannot brighten it - the sun has to be painted.
      // A warm base wash, then a horizon bloom that swells as the scene
      // settles: the first sunrise this game has ever shown.
      this.add
        .rectangle(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, VIEW_WIDTH, VIEW_HEIGHT, 0x2e1608)
        .setDepth(-99)
        .setAlpha(0.85);
      const sunrise = this.add
        .image(VIEW_WIDTH / 2, VIEW_HEIGHT * 1.05, "wisp")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setTint(0xff9040)
        .setScale(6, 3.4)
        .setAlpha(0.5)
        .setDepth(-95);
      this.tweens.add({
        targets: sunrise,
        alpha: 0.85,
        scaleX: 8.5,
        scaleY: 4.6,
        duration: 4200,
        ease: "Sine.easeOut",
      });
      // The roads pay off: as the sky warms, the Hollow's hearths and the
      // threads between them are traced across it like a constellation.
      this.roadsGfx = this.add.graphics().setDepth(5);
      this.roadsStart = this.time.now + 900;
    }

    const wisp = this.add
      .image(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, "wisp")
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.5)
      .setDepth(10);
    if (this.dawn) wisp.setTint(0xffd9a8);
    const light = this.lights.addLight(wisp.x, wisp.y, 300, this.dawn ? 0xffc590 : 0xffe6bf, 1.4);

    this.ambience.setStorm(false);
    this.ambience.ending();

    this.tweens.add({
      targets: wisp,
      scale: 5.5,
      duration: 4200,
      ease: "Sine.easeOut",
    });
    this.tweens.add({
      targets: light,
      intensity: 3.4,
      radius: 1400,
      duration: 4200,
      ease: "Sine.easeOut",
    });

    // Warm parchment lettering, same family as the HUD and level card. The
    // first cut used dark browns (#2a2013 etc.) meant to read as silhouettes
    // against the wisp's bloom - ~1.5:1 contrast against the sky wherever
    // the bloom is dimmer than intended (software rasterizers provably, and
    // any display that tones the additive glow down), which made the run's
    // own closing stats the least readable text in the game (found at the
    // 08-24 judging-day playtest).
    const line = this.add
      .text(VIEW_WIDTH / 2, VIEW_HEIGHT * 0.78, this.dawn ? "you gave the light back, and the sun answered" : "the forest remembers the light", {
        fontFamily: "Georgia, 'Times New Roman', serif",
        fontSize: "24px",
        color: "#e7dcc2",
      })
      .setOrigin(0.5)
      .setAlpha(0)
      .setDepth(20);
    this.tweens.add({ targets: line, alpha: 0.75, duration: 1400, delay: 2400, ease: "Sine.easeOut" });

    if (this.dawn && this.hearths > 0) {
      const hearthLine = this.add
        .text(VIEW_WIDTH / 2, VIEW_HEIGHT * 0.81, `${this.hearths} hearths burn in the hollow behind you`, {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "14px",
          color: "#e8b98a",
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(20);
      this.tweens.add({ targets: hearthLine, alpha: 0.7, duration: 1400, delay: 2500, ease: "Sine.easeOut" });
    }

    // Only worth a line when it happened - a run that skipped motes gets no
    // scolding, just the resets line it would have gotten anyway.
    if (this.flawless > 0) {
      const flawlessText =
        this.flawless >= 3 ? "you found every mote there was" : `${this.flawless} of 3 clearings gave up every mote`;
      const flawlessLine = this.add
        .text(VIEW_WIDTH / 2, VIEW_HEIGHT * 0.845, flawlessText, {
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: "14px",
          color: "#d9c9a3",
        })
        .setOrigin(0.5)
        .setAlpha(0)
        .setDepth(20);
      this.tweens.add({ targets: flawlessLine, alpha: 0.65, duration: 1400, delay: 2600, ease: "Sine.easeOut" });
    }

    const baseLine =
      this.resets > 0
        ? `the dark caught you ${this.resets} time${this.resets === 1 ? "" : "s"} on the way here`
        : "not once did the dark catch you";
    const resetsLine = this.add
      .text(VIEW_WIDTH / 2, VIEW_HEIGHT * 0.885, this.isNewBest ? `${baseLine} - fewest yet` : baseLine, {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "14px",
        color: "#cfc0a0",
      })
      .setOrigin(0.5)
      .setAlpha(0)
      .setDepth(20);
    this.tweens.add({ targets: resetsLine, alpha: 0.6, duration: 1400, delay: 2800, ease: "Sine.easeOut" });

    const prompt = this.add
      .text(VIEW_WIDTH / 2, VIEW_HEIGHT * 0.94, "press to begin again", {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "13px",
        color: "#a9987a",
      })
      .setOrigin(0.5)
      .setAlpha(0)
      .setDepth(20);
    this.tweens.add({
      targets: prompt,
      alpha: { from: 0.25, to: 0.55 },
      duration: 1600,
      delay: 3600,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });

    // A target-less tween is this codebase's "wait N ms" - see LevelScene's
    // `after()` for why this.time.delayedCall is avoided here.
    this.tweens.add({
      targets: {},
      duration: 3600,
      onComplete: () => {
        this.input.once(Phaser.Input.Events.POINTER_DOWN, () => this.restart());
        this.input.keyboard!.once("keydown", () => this.restart());
      },
    });

    this.events.once(Phaser.Scenes.Events.POST_UPDATE, () => {
      document.body.dataset.gameReady = "true";
      this.reportState(light);
    });
  }

  private restart(): void {
    this.cameras.main.fadeOut(360, 5, 6, 12);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start("menu");
    });
  }

  private reportState(light: Phaser.GameObjects.Light): void {
    window.__glow = {
      ready: true,
      scene: "ending",
      collected: 0,
      remaining: 0,
      glowRadius: light.radius,
      lightsActive: this.lights.active,
      level: 0,
      resets: this.resets,
      required: 0,
      beaconOpen: false,
      flawless: this.flawless,
      wispX: 0,
      wispY: 0,
      motes: [],
      hazards: [],
    };
  }
}
