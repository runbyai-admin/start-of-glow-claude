# Architecture

The winner of each round updates this file. It is the shared map of the codebase, and keeping it honest is what lets the other two contestants pick the game up the next morning.

## Stack

- **Phaser 3** (WebGL) for rendering, input, tweens, particles and the Light2D pipeline.
- **TypeScript**, strict, no emit - Vite does the transform, `tsc` only typechecks.
- **Vite 7** for dev server and production build. `base` is relative (`./`) so one build serves from four different URL prefixes.
- **Playwright** for smoke tests, driving a real production build in Chromium.

No game framework beyond Phaser, no asset build step, no backend. The game is a static bundle.

## Layout

```
index.html                page shell, canvas mount, analytics beacon
src/main.ts                Phaser game config (1280x720, FIT scaling) and the scene list
src/scenes/dimensions.ts   VIEW_WIDTH/VIEW_HEIGHT (fixed) and WORLD_WIDTH/WORLD_HEIGHT (a level's scroll bounds)
src/scenes/MenuScene.ts    the title clearing - playable (see "The menu is the first mechanic"), walk into the beacon to start
src/scenes/LevelScene.ts   the whole game loop, reused for all three levels via LevelConfig
src/scenes/EndingScene.ts  the payoff after level 3, then loops back to the menu
src/levels.ts              the three LevelConfig entries - what actually changes between stages (layouts, winds, shy motes)
src/textures.ts            runtime-generated textures, including the hazard's silhouette
src/audio.ts               Web Audio: drone, chime, hit, level-complete arpeggio, ending chord
public/assets/             committed assets you generated (images, audio) - copied verbatim into dist/
src/global.d.ts            the window.__glow test hook contract
tests/smoke.spec.ts        the smoke tests every build must pass
scripts/check-workspace.mjs   repo hygiene guard behind `npm run check`
scripts/play-gate.mjs      real-input full-game playthroughs (plan Phase 1's check)
scripts/shy-probe.mjs      real-input proof of the level-2 shy-mote mechanic (?level=2)
scripts/round2-gate.mjs    one-session full proof: menu mechanic, 3 levels, repeated deaths, ending, second run
scripts/visual-sweep.mjs   read-only judge-eye capture of the transient states (beacon open, whisper, storm) against a served build
scripts/slot-verify.mjs    pre-deadline check: live slot serves exactly the local dist bundle, boots clean at 1280x720
deploy.sh                  publish a build to one of the four slots
```

## Scene flow

`Menu -> Level (x3, index 1-3) -> Ending -> Menu`, via `this.scene.start(key, data)`. Phaser only keeps one scene of each type running at a time here (no scene stacking), so each scene's `create()` rebuilds everything it needs from `init(data)` - nothing is assumed to survive a scene swap except the shared `Ambience` instance, passed forward explicitly in the `data` object at every `scene.start()` call so the drone doesn't restart and audio stays unlocked across scene changes. `resets` (see below) rides along the same way.

- **MenuScene.** The game's first clearing, not a screen in front of it - see "The menu is the first mechanic" below. Enter/Space still `begin()` immediately (accessibility and the drivers' fast path); `begin()` honors a `?level=N` query as the test hook for opening a later level directly (out-of-range or absent falls back to 1).
- **LevelScene.** One reusable scene, not one class per level - see "Levels are data" below. Everything from the original slice (Light2D, parallax, the breathing light, the mote/glow loop, ambience) lives here, plus what round 1 was missing: hazards, a fail state, and a real goal.
- **EndingScene.** Receives the run's total `resets` and `flawless` counts and reports them back to the player as one or two lines, then the wisp's light expands to fill the frame - the same reveal gesture the whole game is built on, played once at full scale with nothing left to interrupt it. Any input after a short beat restarts from the menu. `recordBest()` checks `localStorage` (key `start-of-glow-best-resets`, wrapped in try/catch so a blocked or unavailable store can never break the ending) against this run's `resets`; only a run that beats a *prior* clear appends "- fewest yet" to the existing line - a first-ever clear quietly sets the baseline rather than announcing a "best" with nothing to compare against, and every other non-best run is left exactly as it always was, per SPEC's "restraint reads as quality."

## The menu is the first mechanic (round 2)

The title screen is a playable dark clearing. The wisp already lives there, light follows the cursor with *exactly* `LevelScene`'s trailing movement - same ease constant, same 480px/s displacement cap, deliberately duplicated so the menu can never drift out of feel-sync with the game it opens - and starting is done in the game's own language: carry your light into the warm beacon (`BEGIN_DIST` of it). The core verb is taught wordlessly before play begins. Three quiet affordances layer on top: Enter/Space begin immediately (accessibility, and what the smoke tests use), a hint line ("carry your light to the beacon") fades in only after ~7s of genuine idling, and a returning player's best run shows under the title (`fewest resets: N`, or "the dark never caught you" for a zero-reset best) read from the same `localStorage` key the ending writes. The `Ambience` instance is a module singleton here so audio unlocked on the menu stays unlocked across every scene that follows.

Since the round-2 extension the clearing is a real *place* in the levels' own idiom: silhouette trees and a ground strip on the `Light2D` pipeline (so the player's light reveals the world it stands in), a hills ridge, drifting fireflies, and the same spark trail the wisp wears in play. Composition is hand-placed for the one fixed frame - a stand of trees on the left where the wisp wakes, open middle for the title (soft breathing halo behind the lettering), treeline thinning toward the beacon. The wisp *arrives*: sprite and light bloom in from nearly nothing over ~1.5s (`update()`'s breathing skips the light while `tweens.isTweening(wispLight)` so the entrance tween is never fought). Menu-sized world textures use their own keys (`menu-ground`, `menu-hills`) because `makeCanvasTexture` returns early on an existing key and the level variants are wider - sharing a key would hand the levels a half-width world; `tree-0..3`, `firefly` and `spark` are shared with identical dims/params on purpose. The shell's first setting lives here too: `m` toggles sound, persisted to `localStorage` (`start-of-glow-muted`) and honored by every scene through the shared `Ambience` (the ending's any-key restart excludes `m` for the same reason).

## The shell: holding the game (round 2 extension)

Escape or P in a level holds the world - both timebases at once: `tweens.pauseAll()` freezes the wall-clock actors (hazard patrols, fireflies, cosmetic motion) and the `update()` gate (`this.paused`) freezes everything dt-driven (wisp, winds, shy motes), while the wisp's trail stops emitting and the mix ducks to a distant murmur (`Ambience.setDucked` - master gain to ~22%, never a dead cut) instead of stopping. The held screen is static objects only (no tweens - pauseAll would freeze them): "held" in serif, then `esc · keep going`, `r · begin this level again` (scene.restart with the run's `resets`/`flawless` carried - an attempt reset, not a run reset), `q · give up to the menu` (storm bed off, duck off), `m · sound on/off`. All keyboard on purpose: the mouse is the wisp's hand, and a clickable menu you could mis-click while steering would cost a run. Pausing is refused while `locked` (mid-fail, mid-complete - a timed handoff is in flight); the grace window is extended by the held duration on resume so a pause cannot eat it. Two particle systems deliberately keep running under the hold: the storm flecks and the open beacon's shimmer are the world's set dressing, and a held world still glows. The keydown listener is removed on scene shutdown (`SHUTDOWN` event) - scene restarts would otherwise stack handlers.

## Moment-to-moment feedback (round 2 extension)

The three beats a player hits hundreds of times each got their answer layered in light and sound, all reusing channels that already existed rather than adding second writers: a **collect** swells a ring of the mote's own glow texture where it stood (330ms, additive, then destroyed), lifts the wisp's light through the same `pulseBoost` the pointer-press uses (max, not add - the two never stack), and once the beacon is open every chime carries an extra octave sparkle (`Ambience.chime(step, bright)`) - progress you can hear. A **death** makes the shadow that took the light answer for it (its cold light and blob flare/yoyo for 130ms) and the respawn is a re-ignition, not a light switch: radius tweens back 130→347 over 550ms and intensity climbs back through a *negative* `pulseBoost` (-1.15) that `update()`'s existing decay breathes back to zero - no second writer on intensity, the one per-frame formula stays the only author. `grow()` kills wispLight tweens before its direct radius write so a collect during re-ignition completes it instantly instead of being overwritten. An **arrival** gets the same warm swell the menu's beacon gives the start (beacon scale/alpha + light radius/intensity, 420ms) so beginning and finishing rhyme, and an **open beacon** streams rising warm sparks (denser once flawless, stopped and cleared by a fail's reset) so the invitation is legible from across the level, not only in the HUD line. **Movement itself is audible**: `Ambience.setGlide(speed01)` runs a looping bandpassed noise breath whose gain (square curve) and center frequency track the wisp's post-cap speed, fed per frame from both the level and the menu - a stalking creep is genuinely silent, a rush is heard, which is the shy rule told in sound; pause, fail, completion and the menu handoff all zero it explicitly since a gated `update()` stops feeding it (setTargetAtTime smoothing makes 5fps and 60fps callers settle identically).

## Levels are data, not code

`src/levels.ts` exports `LEVELS: LevelConfig[]` - `index`, `name`, `moteCount`, `requiredMotes`, `hazardCount`, `hazardSpeed`, `mood`, and optionally `layout`, `winds` (level 3's currents) and `shy` (level 2's shy motes). `LevelScene.init(data)` reads the config for `data.levelIndex` and everything downstream (mote count, hazard count and speed, the forest's colour tint via `MOOD_TINT`, which mechanics are active) follows from that one object. Adding a fourth level is adding one entry to the array; it does not touch `LevelScene.ts`.

Two placement modes:

- **Seeded (levels 2-3).** Mote and hazard positions come from `` `start-of-glow-<thing>-${config.index}` `` RNG, so a level's layout is identical every time you play it, but distinct from every other level.
- **Hand-authored (level 1).** A config may carry a `layout`: explicit mote positions and one waypoint loop per hazard, used verbatim instead of the generator. Level 1 is composed this way because the judged first minute looks at it: an opening arc of safe motes teaches collection, a single vertical sentry guards the midfield gap so the threat is *seen* crossing the path before it must be crossed, and two guarded "greed pockets" hold the optional motes (see "Optional collection" below). The scene derives every count from the data actually used (`totalMotes` from placed motes, hazard count from the loops), so the numeric config fields cannot drift out of sync with a layout.

Tree and firefly placement stays seeded in both modes - it is set dressing, not level design.

## The goal: the beacon

Unchanged in spirit from the base slice, extended into an actual win condition. The beacon sits at a fixed point near the far edge of the level, invisible at the start. Its alpha and its own dim `Light2D` light both track `collected / requiredMotes`, so it visibly brightens as the player finds motes - a second, slower payoff tied to the same variable that grows the wisp. Once the *required* count is collected (not every mote - see "Optional collection" below), `levelClear` goes true, the beacon starts a slow pulse (an invitation, wordlessly), a soft two-note call plays, one quiet serif line ("the beacon is lit") fades through under the level card, and `update()` begins checking the player's distance to it. Arriving within `BEACON_RADIUS` calls `completeLevel()`: a level-complete chime, a warm camera flash, a fade to black, then the next level (or `EndingScene`, after level 3).

## Optional collection: the risk/reward decision

`requiredMotes` (10/13/16 of 14/18/22) opens the beacon; the rest of the motes are the player's own call. In the hand-authored level 1 the optional motes are exactly the ones inside the guarded pockets, so "skip it or brave it" is a real spatial decision, not a formality. Collecting *every* mote flips the level into its flawless variant - the beacon jumps to full alpha, its light brightens and warms (`setColor(0xffe9c0)`), the pulse deepens, and `completeLevel()` plays a fuller six-note run instead of four. The HUD states the contract plainly the whole way: `beacon at N` before it opens, `beacon open` after, `flawless` at full collection. A per-run `flawless` count rides forward through `scene.start()` data exactly like `resets`, and the ending reports it with one line when it is non-zero (nothing is said on a run that skipped motes - the choice was allowed, so it is not scolded). A fail resets the flawless state along with everything else in the attempt.

## Shy motes: level 2's mechanic (round 2)

Six of level 2's eighteen motes are pale, skittish ones (`shy` in `LevelConfig`; a dedicated seeded shuffle picks which six, so every spawn of the level - including a post-snuff respawn - places the same pale motes in the same spots). They render from their own cool silver-teal texture (`mote-shy`) against the normal motes' warm gold, so which kind you are approaching is legible at a glance.

The behavioral rule (`LevelScene.updateShyMotes()`, all game-dt based, no tweens): a wisp inside `shy.radius` moving faster than `shy.rushSpeed` px/s **startles** the mote - startle lingers `SHY_STARTLE_MS` (~0.8s) past the last rush, and while startled-and-near the mote flees straight away from the wisp. Flight drains a stamina pool empty in ~2.4s (`SHY_DRAIN_SECONDS`), its speed sags with stamina (`0.45 + 0.55 * stamina` of `shy.fleeSpeed`), and a spent mote settles, dimmed, until calm refills it past a hysteresis mark (`SHY_RECOVER_AT`). A slow approach never triggers any of it: freeze until it settles, drift in gently, collect it like any other mote. Flee direction is biased away from the beacon (so a chase can never drag the player into an accidental level completion) and clamped to the playfield, so "walled" is a real place a pursuit ends; when the player is well away, displaced motes drift home at `SHY_HOME_SPEED`. One whisper line ("the pale ones startle at a rushing light") teaches the rule at the run's first startle, once per level visit.

Why this shape: the arithmetic of a plain flee-on-proximity is a non-mechanic - 480px/s wisp vs. any catchable flee speed closes the gap in well under a second. The startle threshold makes the player's *own speed* the input (nothing else in the game asks for that), the two viable strategies are a real choice (stalk = elegant and safe; chase = fast but scatters them toward walls and patrol lanes), and stamina guarantees every chase terminates - for a human and for the scripted drivers alike. The mote counts are load-bearing: 13 required of 18 with only 12 normal motes means the beacon cannot open without at least one shy encounter, and flawless means taming all six. Shy motes have no y-bob tween on purpose - a tween animating y would fight the flee simulation frame by frame, so `updateShyMotes` drives their bob and alpha itself (`MoteState` holds the logical position; the render adds the bob offset on top).

## Wind currents: level 3's mechanic (round 2)

The storm finally touches the player. `winds` in `LevelConfig` is a list of world rectangles each carrying a push vector (`vx`, `vy` px/s); while the wisp is inside one, `update()` displaces it by the wind each frame. Two design rules keep it a mechanic instead of a punishment: every zone's |v| stays well under the 480px/s cap so no current is inescapable, and every zone is made visible by its own denser fleck stream flowing along its push vector (`buildWinds()`, world-anchored inside the zone's rectangle - the ambient storm flecks stay screen-space set dressing). Level 3 ships two currents: a hard left-and-down midfield crosswind (crossing the open middle costs fighting the storm; the calmer low tree line is the routing choice) and an updraft channel on the beacon approach that helps you climb - directly into the circuit hazard's triangle, the level's standing risk/reward shape done with weather.

**The physics lesson, learned the hard way:** wind must push the wisp AND its chase target. The wisp's trailing ease is a proportional controller pulling toward the target; push only the wisp and the ease cancels the force at a ~20px equilibrium wobble - "wind" that visibly does nothing. Pushing both means a light left unattended genuinely blows downwind until the player fights back (every pointer twitch re-pins the target to the cursor). Wind is applied *after* the player-motion cap on purpose: the cap governs what the player can do; the storm is the world doing something to them.

## The threat: hazards

Shadow-wisps - the thing the light is not. `makeHazardTexture` draws an irregular dark blob (not a circle; the wisp already owns "perfect radial glow", so the hazard needed to read as a different *kind* of thing at a glance) with a thin cold-violet rim, and each carries a small, dim `Light2D` light of its own (`0x9a6efa`, radius 130) - not because a real shadow would glow, but because a threat the player cannot see coming in a game about darkness is cheap, not hard. Each hazard patrols a loop of three deterministic waypoints via chained tweens (`LevelScene.patrol()`), at the level's `hazardSpeed`. Touching one (`HAZARD_RADIUS`, checked every frame once the level's opening grace period has passed) calls `fail()`.

**Hazards notice proximity.** `checkHazardAlerts()` runs every frame: a hazard within `ALERT_RADIUS` (2.6x `HAZARD_RADIUS`) of the wisp for even one frame flips into an "alert" state - its *currently running* patrol tween gets `timeScale = ALERT_TIME_SCALE` (faster playback of the same eased path, not a different path) and its light's intensity rises from `CALM_LIGHT_INTENSITY` toward `ALERT_LIGHT_INTENSITY` as a fair telegraph. `patrol()` now stores the live tween on the hazard object (`hazard.tween`) specifically so this can reach in and adjust it; the last line of `patrol()` re-applies the current alert `timeScale` to a freshly created next-leg tween, so the boost doesn't silently reset to calm at a waypoint if the player is still close. The patrol *shape* stays exactly as seeded and fully deterministic for a fixed play - only pace and visibility change - so builds stay comparable in judging the way "Deterministic layout" below already requires, while a returning player still has to stay reactive rather than purely memorize a fixed rhythm.

`fail()` is the cost: it snuffs the wisp's light (a hard tween down, not a fade), plays a burst of filtered noise plus a falling dissonant interval, then - after a beat - resets the *level's* progress: position back to the start, `collected` back to 0, every mote respawned, the beacon dark again. It does not reset which level you are on or send you back to level 1; only this attempt's progress is lost, which is what makes avoiding a hazard worth doing without making one mistake cost the whole run. `resets` accumulates across the whole playthrough and is the only number `EndingScene` reports back.

## A `this.time.delayedCall` gotcha

`fail()` and `EndingScene`'s "wait before the restart prompt is live" both need a plain "wait N ms, then run this" - the obvious tool is `this.time.delayedCall`. In this build's actual runtime environment it did not fire reliably: `fail()` would lock input, play its sound and light-snuff tween, and then never unlock, because the delayed callback that does the unlocking silently never ran. Confirmed by adding a log at the top of the callback and inside `fail()` itself - the second log never printed, no error anywhere, the game just soft-locked on the first hazard touch. Root cause not fully chased down (plausibly something about how this host's environment steps the Scene `Clock` between frames), but the fix was straightforward: `LevelScene.after(ms, onComplete)` runs a target-less `this.tweens.add({ duration: ms, onComplete })` instead, and tween `onComplete` fired every time in the same environment where `delayedCall` didn't. Every timed handoff in this build (`fail`'s reset, `EndingScene`'s restart-prompt delay) goes through a tween now, not the Clock. If you need a delayed one-shot anywhere in this codebase, use a tween, not `delayedCall`, until someone chases the root cause down - and test it with something slower than a glance, the failure mode is silent, not an error.

## Menu-to-level transition cost is real, and it isn't the textures

Clicking through from the menu to level 1 takes close to two seconds
(measured locally, quiet host, three runs: ~1.9-2.0s from click to
`window.__glow.scene === "level"`) - long enough that it can read as a
stall rather than a fade. The obvious suspect is `LevelScene.preload()`
drawing its ~11 canvas textures (`makeGroundTexture` at 2560x240 and
`makeHillsTexture` at 1760x260 are the two genuinely expensive draws) cold,
on the player's own click. That suspicion was tested properly: `preload()`'s
texture calls were pulled into an exported `levelTextureTasks()` list so
`MenuScene` could drain it one texture per frame during idle menu time
(never `this.time.delayedCall` - see the gotcha above; `update()` is what
already runs the wisp-breathing effect, so it's the scheduling mechanism
already proven reliable on this screen), dedup-guarded so a fast click
before the queue drains just falls back to today's behavior for whatever's
still missing. Measured **with the full prewarm confirmed drained
before clicking**: 1.89-1.95s. Measured cold, same host, same conditions:
1.93-2.02s. The difference is inside the noise of a three-run sample -
texture generation is not the bottleneck, or at most a small fraction of
one. (The change was reverted rather than shipped - `git stash` on this
branch has the diff if the shared-task-list refactor is worth resurrecting
on its own merits later; it should not be resubmitted as a performance fix
without new evidence.)

What's actually eating the time is more likely `LevelScene.create()`
itself: it builds 40+ game objects (14 trees, 11 fireflies, up to 22 motes,
2+ hazards, the wisp, its particle trail, the beacon) and registers 25+
tweens in one synchronous pass, several of them through the `Light2D`
pipeline - and pipeline/shader setup on a GameObject's first `Light2D` use
is itself a plausible one-time GPU cost, distinct from and untested here.
Neither has been profiled - this is a lead for whoever has time to chase
it next, not a diagnosis. Don't re-reach for texture prewarming as the fix
without measuring create() itself first.

## How the scene works (LevelScene specifics)

- **Lighting.** `this.lights.enable().setAmbientColor(0x0a0d18)` makes the world nearly black. Anything that should be lit calls `setPipeline("Light2D")` - the trees and the ground do. The wisp is *not* lit - it is a light *source*, drawn with `ADD` blending, with a `Phaser.GameObjects.Light` following it. A second, dimmer light sits at the beacon; hazards each carry their own cold one.
- **World vs. viewport.** The rendered viewport is fixed at `VIEW_WIDTH`/`VIEW_HEIGHT` (1280x720, mandated) but a level's *world* is wider: `WORLD_WIDTH` (2560) x `WORLD_HEIGHT` (720), both in `src/scenes/dimensions.ts`. The camera has `setBounds` and `startFollow(wisp, false, 0.09, 0.09)`.
- **Parallax.** The sky is `scrollFactor(0)` (fixed to the screen), the distant hill ridge `0.25`, background fireflies `0.75`. Anything Light2D-piped (trees, ground) or anything that carries its own `Light` (the beacon, hazards) stays at the default `1` - a `Light`'s world position cannot itself be parallaxed, so a reduced scroll factor on a lit or light-emitting object would visibly drift out of register with its own light as the camera scrolls.
- **Reveal loop.** Collecting a mote raises `collected`, which grows the wisp light's `radius`/`intensity` and the sprite's scale, and feeds the beacon's brightening (see "The goal" above). The world is revealed by the light, not by unhiding objects.
- **Breathing light.** `update()` adds a slow sine on top of the wisp light's base intensity, plus a `pulseBoost` that jumps on pointer-down and decays toward 0 every frame - both modulate the same `intensity` value per frame rather than fighting over a Phaser tween.
- **Ambience audio.** `src/audio.ts`'s `Ambience` class is oscillator- and noise-buffer-only (a breathing drone, a pentatonic collect chime, a filtered-noise-plus-falling-interval hit, a rising arpeggio for level-complete, a long warm chord for the ending) - no samples, per SPEC.md's synth path. `unlock()` runs inside a pointer-down handler (browsers block `AudioContext` until a user gesture); every method is wrapped in try/catch so audio can never throw into the game loop.
- **Textures.** Everything is drawn into canvas textures at `preload()` from `src/textures.ts`: radial gradients for the glowing things (wisp, motes, sparks, fireflies, the beacon, the hazard trail's sparks), the hazard's own irregular-blob-with-rim shape, silhouette trees and ground, the sky (gradient + seeded stars) and hills. Seeded `RandomDataGenerator` keeps every layer identical run to run.
- **Input.** Pointer move and pointer down set a target the wisp eases toward; arrow keys move the same target. Both are ignored while `this.locked` is true (mid-fail, mid-level-complete) so the player cannot interrupt either transition.
- **Movement is speed-capped, identically for both input methods.** `update()` eases the wisp toward `target` (the trailing, gliding feel), then clamps the *actual per-frame displacement* to `WISP_MAX_SPEED` (480px/s). This matters because pointer input sets `target` straight to the cursor's world position with no distance limit of its own - unclamped, the exponential ease covers more ground the farther the target is, so a single mouse flick could out-run the keyboard's own step-based cap by a wide margin. Clamping the *displacement* rather than the target preserves the eased feel for ordinary small movements (almost always already under the cap) and only reins in the extreme case. `WISP_MAX_SPEED` was raised from keyboard's original 347 to 480 after capping mouse input to 347 made ordinary repositioning feel sluggish, not just hazard-avoidance fair - see `tests/smoke.spec.ts`'s mote-collection test for the corresponding timing update (a full-viewport sweep now takes several real seconds, not the near-instant catch-up unbounded mouse input used to allow).
- **Storm weather (level 3 only).** `buildStorm()` gives storm-dark a real identity beyond its palette: wind-blown flecks drifting left across the near field (an additive particle layer at `scrollFactor 0.9`), plus a seeded flicker schedule that double-flashes a screen-space wash sitting *between* the sky and the hills (depth -90: distant lightning behind the ridge, never over the playfield) with a soft low-passed thunder swell (`Ambience.rumble()`). The wind bed itself is `Ambience.setStorm(on)` - looping filtered noise with a slow gust LFO, faded in by `LevelScene.create()` on storm-dark and back out otherwise (and by the ending); it is built lazily and deferred until `unlock()` if requested before audio exists, and turning it off zeroes the LFO depth too so "off" is silent rather than oscillating around zero.
- **Test hook.** `reportState()` publishes `window.__glow` (`scene`, `level`, `resets`, `required`, `beaconOpen`, `flawless`, the wisp position, the remaining motes - each flagged `shy` - the patrolling hazards, active `winds`, and `activeTweens` for leak checks) and each scene's `create()` sets `document.body.dataset.gameReady` after its first rendered frame. Since round 2 the level's `update()` refreshes the published *mote* positions live every frame alongside the wisp and hazards - shy motes move, and a driver reading collect-event snapshots would chase coordinates a mote left seconds ago. The smoke tests wait on the ready attribute, then use Enter through the menu; `scripts/play-gate.mjs`, `scripts/shy-probe.mjs` and `scripts/round2-gate.mjs` steer full real-input sessions by the same telemetry (positions a sighted player already has by looking at the screen - there is no state in it the screen does not show). If you change a scene's reported shape, keep `src/global.d.ts` in sync - it is the contract the tests type-check against.

## Fixed resolution

The rendered viewport runs at a **1280x720** design resolution with `Phaser.Scale.FIT`, letterboxed. `VIEW_WIDTH`/`VIEW_HEIGHT` in `src/scenes/dimensions.ts` are the single source of truth - `main.ts` imports them for the Phaser scale config, every scene imports them for layout. `WORLD_WIDTH`/`WORLD_HEIGHT` are a separate, larger pair used only inside `LevelScene` for camera bounds and content placement - the canvas itself never changes size regardless of how wide a level's world is.

Deterministic layout is deliberate: it makes screenshots comparable between machines, it means the owner plays the same framing on every build, and 720p is a clean source for the recorded judging sessions. The resolution is mandated by [SPEC.md](SPEC.md) - do not change it.

## Verifying a change on this host: the two-timebase trap

Headless Chromium here renders the Light2D level scene on a software rasterizer at ~5fps on a quiet host - and as low as ~1.3fps when all three contestants build at once (measured 2026-08-26 under load ~8; an A/B of consecutive commits under identical load confirmed the slowness is contention, not code). Two consequences, both permanent:

1. **Game speed splits into two timebases at low fps.** Phaser's delta smoothing clamps a ~250-750ms wall frame to ~16.7ms of game time, so everything dt-driven (the wisp, wind, shy motes) runs at a fraction of wall speed - while **tweens advance near wall speed** (hazard patrols, all cosmetic motion). At 5fps a patrol is effectively ~15x faster *relative to the wisp* than it is for a judge at 60fps. A headless driver dying at a crossing that is trivial at full rate is measuring this divergence, not unfairness; both timebases converge at 60fps, where gameplay is judged. Every feel claim must be reasoned in game-time ratios (which are fps-independent between dt-driven actors) or tested on real hardware.
2. **Wall-clock budgets in tests are environment claims, not game claims.** The smoke budget (300s) and the gate scripts' generous safety timeouts are sized for the *contended* host, because deadline days are exactly when all three sessions run. Frame-counted waits (`requestAnimationFrame` chains) are the only honest pacing primitive here - never `waitForTimeout` for anything the game must process. Do not re-tighten a budget because it looks lazy on a quiet afternoon.

## Constraints worth knowing before you refactor

- The production bundle serves from four URL prefixes, so never hardcode an absolute asset path or set `base` to `/`.
- Everything in the build is made by you: draw or synthesize it in code, or generate it with an AI model and commit it under `public/assets/`. Never a downloaded sprite pack, stock texture or asset-store sound.
- Private notes, journals and durable agent state live in your own workspace, never here. `npm run check` will stop you.
- Prefer a target-less tween over `this.time.delayedCall` for anything timed - see the gotcha above.
