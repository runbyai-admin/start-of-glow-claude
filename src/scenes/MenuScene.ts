import Phaser from "phaser";
import {
  makeGlowTexture,
  makeGroundTexture,
  makeHillsTexture,
  makeSkyTexture,
  makeTreeTexture,
} from "../textures";
import { Ambience } from "../audio";
import { VIEW_HEIGHT, VIEW_WIDTH } from "./dimensions";

const ambience = new Ambience();
const MENU_SPEED = 390;
const MENU_COLLECT_RADIUS = 44;
const MENU_MAGNET_RADIUS = 132;
const WISP_BASE_SCALE = 0.58;

/**
 * The title screen is the game's first authored clearing, not a wall before it.
 * The moving wisp reveals a layered Light2D forest, draws an afterglow through
 * five composed motes, and wakes a distant threshold one pickup at a time.
 * Click/touch, Enter or Space still starts immediately; menu play never gates it.
 */
export class MenuScene extends Phaser.Scene {
  private wisp!: Phaser.GameObjects.Image;
  private wispLight!: Phaser.GameObjects.Light;
  private threshold!: Phaser.GameObjects.Image;
  private thresholdRing!: Phaser.GameObjects.Arc;
  private target = new Phaser.Math.Vector2(315, 470);
  private motes: Phaser.GameObjects.Image[] = [];
  private fireflies: Phaser.GameObjects.Image[] = [];
  private wakeableForest: Phaser.GameObjects.Image[] = [];
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<"up" | "down" | "left" | "right", Phaser.Input.Keyboard.Key>;
  private mechanicLine!: Phaser.GameObjects.Text;
  private startInvitation!: Phaser.GameObjects.Text;
  private startHint!: Phaser.GameObjects.Text;
  private titleGroup!: Phaser.GameObjects.Container;
  private pathThreads!: Phaser.GameObjects.Graphics;
  private collected = 0;
  private begun = false;
  private lastTrailAt = 0;
  private previousWisp = new Phaser.Math.Vector2(315, 470);

  constructor() {
    super("menu");
  }

  preload(): void {
    makeSkyTexture(this, "sky", VIEW_WIDTH, VIEW_HEIGHT, 11);
    makeHillsTexture(this, "menu-hills", VIEW_WIDTH, 250, 71);
    makeGroundTexture(this, "menu-ground", VIEW_WIDTH, 180, 72);
    makeTreeTexture(this, "menu-tree-tall", 180, 430, 73);
    makeTreeTexture(this, "menu-tree-small", 130, 330, 74);
    makeGlowTexture(this, "wisp", 85, "rgba(255,255,255,1)", "rgba(150,214,255,0.55)");
    makeGlowTexture(this, "mote", 27, "rgba(255,244,214,1)", "rgba(255,196,92,0.5)");
    makeGlowTexture(this, "spark", 16, "rgba(255,255,255,0.9)", "rgba(190,226,255,0.35)");
    makeGlowTexture(this, "menu-threshold", 150, "rgba(255,248,224,0.95)", "rgba(255,174,72,0.08)");
  }

  create(): void {
    this.begun = false;
    this.collected = 0;
    this.motes = [];
    this.fireflies = [];
    this.wakeableForest = [];
    this.target.set(315, 470);
    this.previousWisp.set(this.target.x, this.target.y);
    this.lastTrailAt = 0;

    this.lights.enable().setAmbientColor(0x070a12);
    this.cameras.main.setBackgroundColor(0x05060c);
    this.add.image(VIEW_WIDTH / 2, VIEW_HEIGHT / 2, "sky").setDepth(-100);

    this.composeForest();
    this.composeThreshold();
    this.composeMotePath();
    this.composeTitle();

    this.wisp = this.add.image(this.target.x, this.target.y, "wisp")
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(WISP_BASE_SCALE)
      .setDepth(12);
    this.wispLight = this.lights.addLight(this.wisp.x, this.wisp.y, 390, 0xbfe4ff, 1.72);

    this.input.on(Phaser.Input.Events.POINTER_MOVE, (pointer: Phaser.Input.Pointer) => {
      if (!this.begun) this.target.set(pointer.x, pointer.y);
    });
    this.input.once(Phaser.Input.Events.POINTER_DOWN, () => this.begin());
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = {
      up: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    this.input.keyboard!.once("keydown", () => ambience.unlock());
    this.input.keyboard!.on("keydown-ENTER", () => this.begin());
    this.input.keyboard!.on("keydown-SPACE", () => this.begin());

    this.events.once(Phaser.Scenes.Events.POST_UPDATE, () => {
      document.body.dataset.gameReady = "true";
      this.reportState();
    });
  }

  update(time: number, delta: number): void {
    if (this.begun) return;
    const step = MENU_SPEED * delta / 1000;
    if (this.cursors.left.isDown || this.wasd.left.isDown) this.target.x -= step;
    if (this.cursors.right.isDown || this.wasd.right.isDown) this.target.x += step;
    if (this.cursors.up.isDown || this.wasd.up.isDown) this.target.y -= step;
    if (this.cursors.down.isDown || this.wasd.down.isDown) this.target.y += step;
    this.target.x = Phaser.Math.Clamp(this.target.x, 70, VIEW_WIDTH - 70);
    this.target.y = Phaser.Math.Clamp(this.target.y, 300, VIEW_HEIGHT - 76);

    const ease = 1 - Math.pow(0.0012, delta / 1000);
    this.wisp.x = Phaser.Math.Linear(this.wisp.x, this.target.x, ease);
    this.wisp.y = Phaser.Math.Linear(this.wisp.y, this.target.y, ease);
    const dx = this.wisp.x - this.previousWisp.x;
    const dy = this.wisp.y - this.previousWisp.y;
    const speed = Phaser.Math.Clamp(Math.hypot(dx, dy) / Math.max(delta, 1) * 5.2, 0, 1);
    const direction = Math.atan2(dy, dx);
    this.wisp.rotation = Phaser.Math.Angle.RotateTo(this.wisp.rotation, direction, 0.085);
    this.wisp.scaleX = Phaser.Math.Linear(this.wisp.scaleX, WISP_BASE_SCALE + speed * 0.14, 0.22);
    this.wisp.scaleY = Phaser.Math.Linear(this.wisp.scaleY, WISP_BASE_SCALE - speed * 0.08, 0.22);
    this.previousWisp.set(this.wisp.x, this.wisp.y);

    const lightLag = 9 + speed * 15;
    this.wispLight.setPosition(this.wisp.x - Math.cos(direction) * lightLag, this.wisp.y - Math.sin(direction) * lightLag);
    this.wispLight.intensity = 1.72 + Math.sin(time * 0.00115) * 0.2 + this.collected * 0.075;
    this.wispLight.radius = 390 + this.collected * 30 + Math.sin(time * 0.00075) * 8;

    if (time - this.lastTrailAt > Phaser.Math.Linear(78, 34, speed)) {
      this.leaveAfterglow(speed);
      this.lastTrailAt = time;
    }
    this.floatAndMagnetizeMotes(time);
    this.drawMoteThreads(time);
    this.collectNearbyMotes();
    this.reportState();
  }

  private composeForest(): void {
    const hills = this.add.image(VIEW_WIDTH / 2, 642, "menu-hills")
      .setOrigin(0.5, 1)
      .setTint(0x152039)
      .setPipeline("Light2D")
      .setDepth(-30);
    const ground = this.add.image(VIEW_WIDTH / 2, VIEW_HEIGHT, "menu-ground")
      .setOrigin(0.5, 1)
      .setTint(0x0c1421)
      .setPipeline("Light2D")
      .setDepth(-8);
    this.wakeableForest.push(hills, ground);

    const treeSpecs: Array<[number, number, string, number, number]> = [
      [34, 710, "menu-tree-tall", 1.2, -4],
      [190, 716, "menu-tree-small", 0.95, -5],
      [1085, 716, "menu-tree-small", 1.05, -5],
      [1246, 712, "menu-tree-tall", 1.25, -4],
    ];
    for (const [x, y, key, scale, depth] of treeSpecs) {
      const tree = this.add.image(x, y, key)
        .setOrigin(0.5, 1)
        .setScale(scale)
        .setTint(0x121b2a)
        .setPipeline("Light2D")
        .setDepth(depth);
      this.wakeableForest.push(tree);
    }

    for (let index = 0; index < 22; index += 1) {
      const x = 70 + ((index * 173) % 1140);
      const y = 330 + ((index * 97) % 280);
      const firefly = this.add.image(x, y, "spark")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.08 + (index % 4) * 0.018)
        .setAlpha(0.1 + (index % 3) * 0.05)
        .setDepth(-2);
      this.tweens.add({
        targets: firefly,
        x: x + (index % 2 === 0 ? 13 : -13),
        y: y - 12 - (index % 5) * 3,
        alpha: { from: firefly.alpha, to: 0.28 + (index % 4) * 0.08 },
        duration: 1800 + index * 83,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut",
      });
      this.fireflies.push(firefly);
    }

    this.add.rectangle(VIEW_WIDTH / 2, 694, VIEW_WIDTH, 52, 0x03050a, 0.66).setDepth(30);
  }

  private composeThreshold(): void {
    this.threshold = this.add.image(1040, 448, "menu-threshold")
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.48)
      .setAlpha(0.22)
      .setDepth(4);
    this.thresholdRing = this.add.circle(1040, 448, 48, 0xffd58a, 0)
      .setStrokeStyle(1, 0xffd58a, 0.18)
      .setDepth(3);
    this.tweens.add({
      targets: this.thresholdRing,
      scale: { from: 0.92, to: 1.12 },
      alpha: { from: 0.2, to: 0.04 },
      duration: 2200,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private composeMotePath(): void {
    this.pathThreads = this.add.graphics().setDepth(2);
    const positions = [
      [420, 500], [535, 442], [650, 474], [770, 414], [900, 454],
    ];
    positions.forEach(([x, y], index) => {
      const mote = this.add.image(x, y, "mote")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.43 + index * 0.025)
        .setAlpha(0.74)
        .setDepth(6);
      mote.setDataEnabled();
      mote.setData("homeX", x);
      mote.setData("homeY", y);
      mote.setData("phase", index * 0.91);
      this.motes.push(mote);
    });
  }

  private composeTitle(): void {
    const eyebrow = this.add.text(0, 0, "A QUIET JOURNEY", {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "13px",
      color: "#7f91aa",
      letterSpacing: 5,
    });
    const title = this.add.text(0, 25, "START OF\nGLOW", {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontSize: "66px",
      color: "#f1e8d4",
      lineSpacing: -14,
      letterSpacing: 4,
    });
    const rule = this.add.rectangle(2, 171, 212, 1, 0xd9c9a3, 0.46).setOrigin(0, 0.5);
    this.titleGroup = this.add.container(92, 78, [eyebrow, title, rule]).setAlpha(0).setDepth(20);
    this.tweens.add({ targets: this.titleGroup, alpha: 1, y: 88, duration: 1050, ease: "Cubic.easeOut" });

    this.mechanicLine = this.add.text(96, 612, "move through the dark  ·  press to draw the light in", {
      fontFamily: "Georgia, 'Times New Roman', serif",
      fontStyle: "italic",
      fontSize: "17px",
      color: "#9eafc5",
      letterSpacing: 1,
    }).setAlpha(0.58).setDepth(20);

    this.startInvitation = this.add.text(1040, 554, "ENTER THE FOREST", {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "15px",
      color: "#eadfc7",
      letterSpacing: 3,
    }).setOrigin(0.5).setDepth(20);
    this.startHint = this.add.text(1040, 584, "click  ·  enter  ·  space", {
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: "11px",
      color: "#8190a6",
      letterSpacing: 1,
    }).setOrigin(0.5).setAlpha(0.68).setDepth(20);
    this.tweens.add({
      targets: [this.startInvitation, this.startHint],
      alpha: { from: 0.52, to: 1 },
      duration: 1550,
      yoyo: true,
      repeat: -1,
      ease: "Sine.easeInOut",
    });
  }

  private floatAndMagnetizeMotes(time: number): void {
    for (const mote of this.motes) {
      const distance = Phaser.Math.Distance.Between(mote.x, mote.y, this.wisp.x, this.wisp.y);
      const phase = Number(mote.getData("phase"));
      const homeX = Number(mote.getData("homeX"));
      const homeY = Number(mote.getData("homeY"));
      if (distance < MENU_MAGNET_RADIUS) {
        const pull = Phaser.Math.Linear(0.015, 0.095, 1 - distance / MENU_MAGNET_RADIUS);
        mote.x = Phaser.Math.Linear(mote.x, this.wisp.x, pull);
        mote.y = Phaser.Math.Linear(mote.y, this.wisp.y, pull);
        mote.setScale(Phaser.Math.Linear(mote.scaleX, 0.62, 0.12));
        mote.setAlpha(1);
      } else {
        mote.x = Phaser.Math.Linear(mote.x, homeX + Math.cos(time * 0.00055 + phase) * 4, 0.045);
        mote.y = Phaser.Math.Linear(mote.y, homeY + Math.sin(time * 0.0011 + phase) * 9, 0.045);
        mote.setScale(Phaser.Math.Linear(mote.scaleX, 0.43 + phase * 0.027, 0.06));
        mote.setAlpha(Phaser.Math.Linear(mote.alpha, 0.74, 0.06));
      }
    }
  }

  private drawMoteThreads(time: number): void {
    this.pathThreads.clear();
    if (this.motes.length < 2) return;
    const pulse = 0.055 + (Math.sin(time * 0.0012) + 1) * 0.018;
    this.pathThreads.lineStyle(1, 0x9bb5d4, pulse);
    this.pathThreads.beginPath();
    this.pathThreads.moveTo(this.motes[0].x, this.motes[0].y);
    for (let index = 1; index < this.motes.length; index += 1) {
      this.pathThreads.lineTo(this.motes[index].x, this.motes[index].y);
    }
    this.pathThreads.strokePath();
  }

  private leaveAfterglow(speed: number): void {
    const afterglow = this.add.image(this.wisp.x, this.wisp.y, "spark")
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(0.16 + speed * 0.13)
      .setAlpha(0.2 + speed * 0.25)
      .setTint(0xbfe4ff)
      .setDepth(8);
    this.tweens.add({
      targets: afterglow,
      scale: 0.03,
      alpha: 0,
      duration: 620,
      ease: "Quad.easeOut",
      onComplete: () => afterglow.destroy(),
    });
  }

  private collectNearbyMotes(): void {
    for (let index = this.motes.length - 1; index >= 0; index -= 1) {
      const mote = this.motes[index];
      if (Phaser.Math.Distance.Between(mote.x, mote.y, this.wisp.x, this.wisp.y) > MENU_COLLECT_RADIUS) continue;
      this.motes.splice(index, 1);
      this.collected += 1;
      ambience.chime(this.collected - 1, this.collected);
      this.cameras.main.shake(85 + this.collected * 7, 0.0011 + this.collected * 0.00018);
      this.contactBurst(mote.x, mote.y);
      this.tweens.add({
        targets: mote,
        x: this.wisp.x,
        y: this.wisp.y,
        scale: 0.08,
        alpha: 0,
        duration: 220,
        ease: "Cubic.easeIn",
        onComplete: () => mote.destroy(),
      });

      const lines = ["the path remembers", "keep the light moving", "the threshold is listening", "almost awake", "the forest opens"];
      this.mechanicLine.setText(lines[this.collected - 1]);
      this.mechanicLine.setAlpha(1);
      this.tweens.add({ targets: this.mechanicLine, alpha: 0.58, duration: 900, ease: "Sine.easeOut" });

      this.threshold.setAlpha(0.22 + this.collected * 0.13).setScale(0.48 + this.collected * 0.055);
      this.thresholdRing.setStrokeStyle(1 + this.collected * 0.3, 0xffd58a, 0.18 + this.collected * 0.08);
      this.wakeableForest.forEach((layer, layerIndex) => {
        layer.setAlpha(Math.min(1, layer.alpha + 0.035 + layerIndex * 0.003));
      });
      this.fireflies.forEach((firefly, fireflyIndex) => {
        if (fireflyIndex % 5 === this.collected - 1) firefly.setAlpha(0.65);
      });

      const ring = this.add.circle(this.wisp.x, this.wisp.y, 24, 0xffdfa0, 0)
        .setStrokeStyle(2 + this.collected * 0.35, 0xffdfa0, 0.86)
        .setDepth(9);
      this.tweens.add({
        targets: ring,
        radius: 62 + this.collected * 12,
        alpha: 0,
        duration: 500,
        ease: "Cubic.easeOut",
        onComplete: () => ring.destroy(),
      });

      if (this.collected === 5) this.completeMenuChain();
    }
  }

  private contactBurst(x: number, y: number): void {
    for (let index = 0; index < 11; index += 1) {
      const angle = (index / 11) * Math.PI * 2 + this.collected * 0.31;
      const distance = 28 + (index % 4) * 11;
      const spark = this.add.image(x, y, "spark")
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(0.12 + (index % 3) * 0.04)
        .setAlpha(0.88)
        .setTint(index % 2 === 0 ? 0xffdfa0 : 0xbfe4ff)
        .setDepth(11);
      this.tweens.add({
        targets: spark,
        x: x + Math.cos(angle) * distance,
        y: y + Math.sin(angle) * distance,
        scale: 0.02,
        alpha: 0,
        duration: 360 + (index % 4) * 55,
        ease: "Quad.easeOut",
        onComplete: () => spark.destroy(),
      });
    }
  }

  private completeMenuChain(): void {
    ambience.radiance();
    this.startInvitation.setText("THE WAY IS OPEN").setColor("#fff1d2");
    this.startHint.setText("enter whenever you are ready");
    this.cameras.main.flash(220, 255, 216, 150, false, undefined, 0.08);
    this.tweens.add({
      targets: this.threshold,
      scale: 0.9,
      alpha: 0.96,
      duration: 680,
      yoyo: true,
      ease: "Cubic.easeOut",
    });
    const wave = this.add.circle(this.threshold.x, this.threshold.y, 32, 0xffd58a, 0)
      .setStrokeStyle(3, 0xffd58a, 0.72)
      .setDepth(5);
    this.tweens.add({
      targets: wave,
      radius: 230,
      alpha: 0,
      duration: 1050,
      ease: "Cubic.easeOut",
      onComplete: () => wave.destroy(),
    });
  }

  private begin(): void {
    if (this.begun) return;
    this.begun = true;
    ambience.unlock();
    this.tweens.killTweensOf([this.startInvitation, this.startHint]);
    this.cameras.main.zoomTo(1.04, 520, "Sine.easeIn");
    this.tweens.add({ targets: [this.titleGroup, this.mechanicLine, this.startInvitation, this.startHint], alpha: 0, duration: 260 });
    this.tweens.add({
      targets: this.wisp,
      x: this.threshold.x,
      y: this.threshold.y,
      scaleX: 0.12,
      scaleY: 0.12,
      duration: 520,
      ease: "Cubic.easeIn",
    });
    this.tweens.add({ targets: this.threshold, scale: 1.08, alpha: 1, duration: 520, ease: "Cubic.easeIn" });
    this.cameras.main.fadeOut(560, 5, 6, 12);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      // ?level=N jumps straight to an act - a doorway for playtesting and for
      // anyone who has already walked the forest. The bare URL is untouched.
      const requested = Number(new URLSearchParams(window.location.search).get("level"));
      const levelIndex = Number.isInteger(requested) && requested >= 1 && requested <= 4 ? requested : 1;
      this.scene.start("level", { levelIndex, ambience, taught: levelIndex > 1 });
    });
  }

  private reportState(): void {
    window.__glow = {
      ready: true,
      scene: "menu",
      collected: this.collected,
      remaining: this.motes.length,
      glowRadius: this.wispLight.radius,
      lightsActive: this.lights.active,
      level: 0,
      resets: 0,
      required: 0,
      beaconOpen: false,
      flawless: 0,
      wispX: Math.round(this.wisp.x),
      wispY: Math.round(this.wisp.y),
      motes: this.motes.map((m) => ({ x: Math.round(m.x), y: Math.round(m.y) })),
      hazards: [],
      chain: this.collected,
      chainRemainingMs: 0,
      radianceWaves: this.collected === 5 ? 1 : 0,
      slowedHazards: 0,
    };
  }
}
