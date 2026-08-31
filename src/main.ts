import Phaser from "phaser";
import { MenuScene } from "./scenes/MenuScene";
import { LevelScene } from "./scenes/LevelScene";
import { EndingScene } from "./scenes/EndingScene";
import { VIEW_HEIGHT, VIEW_WIDTH } from "./scenes/dimensions";
import { installReplay, replayRequest, seedRandom } from "./replay";
import { installRoundNotes } from "./round-notes";

// Read before the Game is built: replay mode needs the seeded RNG in place
// before any texture or scene is created. Absent the flag this is null and
// nothing below changes - the judged URL is untouched.
const replay = replayRequest();
if (replay) seedRandom(replay.seed);

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  parent: "game",
  backgroundColor: "#05060c",
  scale: {
    // Fixed 1280x720 design resolution, letterboxed - mandated by SPEC.md.
    // Deterministic layout keeps the smoke-test screenshots comparable across
    // machines, and 720p is a clean source for the recorded judging sessions.
    // A level's own WORLD can be wider than this and scroll under a camera -
    // see dimensions.ts - but the rendered viewport never changes size.
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: VIEW_WIDTH,
    height: VIEW_HEIGHT,
  },
  render: {
    antialias: true,
    // Light2D needs WebGL; Phaser.AUTO falls back to Canvas on machines
    // without it, where the scene degrades to flat silhouettes rather than
    // failing outright.
    pixelArt: false,
  },
  scene: [MenuScene, LevelScene, EndingScene],
  ...(replay
    ? {
        // Fixed-timestep replay: no delta smoothing (it would average the
        // exact 16.667 ms step against Phaser's history) and no Phaser sound
        // manager, because replay hands the game its own offline audio context.
        fps: { target: 60, smoothStep: false },
        audio: { noAudio: true },
        // Phaser seeds its own RND from Date.now(), which alone is enough to
        // make two runs of the same persona drift a pixel apart.
        seed: [String(replay.seed)],
      }
    : {}),
};

const game = new Phaser.Game(config);
if (replay) installReplay(game, replay);
// The judge-facing "what changed this round" badge. DOM-only and skipped in
// replay mode, so captures and personas never see it.
if (!replay) void installRoundNotes();

// Debug handle for the play driver's inspector - harmless in production.
(window as unknown as { __game?: Phaser.Game }).__game = game;
