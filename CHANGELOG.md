# Changelog

One entry per round, written by that round's winner as part of banking the win: what changed and why, in enough detail that the other two contestants can pick it up tomorrow.

## Round 0 - template (owner, 2026-08-17)

The starting point, before any round: TypeScript + Vite + Phaser with a boot scene that proves the Light2D pipeline (dark ambient, silhouette forest, a glowing light-being with a following light and a particle trail, motes that grow the glow when collected), Playwright smoke tests, the `npm run check` repo guard, and `deploy.sh` publishing to the four stable URLs.

Before round 1 the owner also added the round machinery: `ledger.json` + `LEDGER.md` (wins, tips and the escalating tip price), and `scripts/bank-round.sh`, which merges the winner, tags `round-N-winner` and `round-(N+1)-base`, records the win and publishes `/glow/` - refusing any branch without an `ARCHITECTURE.md` update and a `## Round N` entry here.

## Round 1 - Claude (full rebuild, 2026-08-21)

The first round-1 submission (an atmosphere-only slice: a wider world, parallax, a distant beacon that brightened as motes were collected, breathing light, synthesized ambience) was judged correctly as not a game - three pretty clearings with motes in them, no menu, no levels, no way to fail, no ending. This entry replaces it entirely, built fresh on `round-1-base` per RULES.md ("yesterday's losing ideas are not carried forward for free"), keeping only the atmosphere techniques worth rebuilding on top of.

**What's new: an actual game.**

- **Three scenes, not one.** `MenuScene` (title, any input starts play - no menu wall, per SPEC.md's feel notes), `LevelScene` (the whole game loop, one reusable scene driven by data - see `src/levels.ts`), `EndingScene` (the payoff after level 3, loops back to the menu). Full detail in ARCHITECTURE.md.
- **A real goal.** The beacon from the original slice now does something: reach it, fully lit, after collecting every mote in the level, and the level ends - a chime, a warm flash, a fade to the next stage.
- **A real threat and a real fail state.** Shadow-wisps (`makeHazardTexture` - an irregular dark blob with a cold rim light, deliberately not a circle so it reads as a different kind of thing from the wisp at a glance) patrol deterministic loops. Touching one snuffs your light, plays a burst of filtered noise and a falling dissonant interval, and resets the *level's* progress - not the whole run, not your level number. A `resets` counter follows you to the ending.
- **Progression.** Three levels (`src/levels.ts`), each harder: more motes, more hazards, faster hazards, a cooler colour mood. Same reusable scene, different data - adding a fourth level later is one array entry, not a new class.
- **Sound and UI that belong to it.** New: a hit sound, a level-complete arpeggio, a long warm ending chord (all oscillator/noise-buffer synth, no samples). HUD now shows level, motes, and resets; a level-name card fades in at the start of each stage.

**A real bug found and fixed:** `this.time.delayedCall` does not fire reliably in this build's actual runtime environment - `fail()`'s reset callback (and `EndingScene`'s restart-prompt delay) silently never ran, which meant the very first hazard touch would lock the game forever with no error anywhere. Caught by testing the fail path deliberately rather than trusting it because the code looked right - see ARCHITECTURE.md's "`this.time.delayedCall` gotcha" section for the full story and the fix (target-less tweens instead, which fire reliably in the same environment). Worth knowing before anyone else hits the same wall.

**Verification before calling it done:** `npm run check` and `npm test` both green; a from-scratch investigation reproduced and root-caused a visual anomaly Playwright's own test screenshots showed at one specific moment (traced to headless-Chromium screenshot timing around a hazard's own dim light, not a rendering bug - multiple independent manual replays of the same game state, including deliberately standing next to a hazard, show the intended dark/focused-light look throughout); a full manual playthrough exercised every scene transition, the fail-and-recover path, and all three levels through to the ending with zero console or page errors.

**A second infrastructure bug, same as the first:** `deploy.sh` 403'd on first deploy of this round, for the exact reason fixed in the previous round-1 submission - `rsync -a` preserves the deploying account's own restrictive default-ACL permissions onto the deploy target. That fix lived only in this fork's history, and since round 1 was never banked into canonical, resetting to `round-1-base` (per RULES.md - every round starts from the shared base, not your own previous work) silently undid it. Reapplied the same `--chmod=Do+rx,Fo+r` fix, disclosed here again for the same reason RULES.md asks for it the first time. Worth knowing: any fork-local infra fix from an unbanked round will need reapplying every time you reset to that round's base, until a round actually banks and folds it into canonical.

## Round 1 - Claude (continued: plan Phase 1 - a real choice, a composed opening, a storm with weather, 2026-08-23 late)

The 1-year plan (docs/game-1-year-plan.md) is now under a standing execute loop, and this is its Phase 1, built the same evening the loop started. Three changes, all aimed at the same gap the plan named: the game had a goal and a threat, but no *decision*.

**Collection is optional now - that's the decision.** Each level's beacon opens at `requiredMotes` (10/14, 13/18, 16/22), not at full collection. The moment it opens is marked so the choice is legible in one play: a soft two-note call, the beacon's pulse starting, one quiet serif line ("the beacon is lit"), and the HUD flipping from `beacon at 10` to `beacon open`. The remaining motes are the player's own call - and in level 1 they are exactly the motes inside guarded pockets, so the call is "is that one worth the sentry" rather than a bookkeeping preference. Finding *every* mote flips the flawless variant (a warmer, brighter beacon, a deeper pulse, a fuller six-note completion run), a per-run `flawless` count rides to the ending alongside `resets`, and the ending gives it one line when it is earned. A run that skips motes is not scolded - the skip is the design working, not a failure to play properly.

**Level 1 is hand-authored.** The judged first minute looks at level 1, so level 1 is now a composed space, not a seeded roll (`layout` in `src/levels.ts`; seeded placement still drives levels 2-3): an opening arc of five safe motes that teaches collection in the first ten seconds, one vertical sentry patrolling the midfield gap so the player *watches* the threat cross their path before they have to cross it, a calm mid-glade, then a second hazard circling the beacon approach with two greedy motes inside its circuit and a safe low road under it. Nine motes are safe, two need one timed lane-crossing, three sit in the pockets - ten open the beacon, so a careful player clears without ever braving a pocket, and a flawless run braves both.

**Storm-dark is weather now, not a tint.** Level 3 gets wind-blown flecks drifting across the near field, distant lightning that double-flashes between the sky and the hills on a seeded schedule, a soft low-passed thunder swell, and a looping wind bed (filtered noise + gust LFO) that fades in for level 3 and back out for the ending - arriving at the last clearing now *feels* like arriving somewhere, which is what the plan's "not the same forest re-tinted three times" line was about.

**Also fixed while in there:** after a hazard snuff, the wisp's light radius stayed at the snuffed size (90) until the next mote pickup - the fail reset restored position, scale and counts but never the light itself. A respawned light now matches a fresh spawn at zero motes.

**Verified by playing it, not reading it.** `scripts/play-gate.mjs` (new, committed - it is the plan's own Phase 1 check, automated): two full real-input runs against the served production build. Run A plays the whole game cautiously - level 1 by the safe route only, skipping every pocket (completes at 10/14 with 4 motes left behind - the choice, exercised), levels 2-3 greedily to the required count only, storm layer screenshotted on level 3, ending reached with `flawless=0`. Run B plays level 1 flawlessly - both pockets, all 14 motes, the warm beacon variant, `flawless=1` confirmed carried into level 2. The driver steers with real mouse events using only on-screen positions (published via the `window.__glow` telemetry, extended for exactly this), waits for hazard clearance before entering guarded ground, and treats a snuff the way a player does: runs the route again. Smoke tests were also re-paced to the page's own frames - headless software rendering runs the Light2D scene at ~5fps on this host (a real browser with a GPU runs full rate; measured pre-change at the identical 4.5fps, so the slowness is environmental, not this change), and the old wall-clock pacing was silently marginal against it. The collection assertion now runs against level 1's opening arc, which is hazard-free *by design* - hand-authoring made the test deterministic where it used to be luck.

## Round 1 - Claude (continued: gameplay depth + a 1-year plan, 2026-08-23/24)

The owner's judgment on the round-1 rebuild above was right but incomplete: a menu, levels, a fail state and an ending make it *a game*, not a game with real *depth*. This entry is the direct response, done in the same extended window rather than a new day's reset - what changed, why, and what I found while actually playing it rather than just reading the diff.

**A real fairness bug, found by playing it, not by reasoning about it.** Keyboard movement was already speed-capped at 347px/s. Mouse movement was not: `POINTER_MOVE` sets the movement target straight to the cursor's world position with no distance limit, and the wisp's exponential ease-toward-target then covers *more* absolute ground per frame the farther away that target is - so a single mouse flick could close far more distance in one frame than the keyboard's real cap ever allowed. In practice this meant hazard avoidance difficulty was an accident of which input device someone happened to use, not a designed curve. Fixed in `LevelScene.update()`: both inputs now share one real cap (`WISP_MAX_SPEED`), applied by clamping the actual per-frame displacement after easing, not by capping the target itself - so the trailing, gliding feel is untouched for ordinary small movements and only the extreme case (a big mouse jump) is reined in.

That fix immediately broke the existing smoke test (`tests/smoke.spec.ts`'s mote-collection sweep), which had been implicitly relying on the old unbounded mouse speed to sweep the full viewport and collect a mote inside a ~1.5s window - a real signal that 347px/s alone felt too slow for a cursor-chasing light once it was the mouse's real cap too, not just keyboard's. Raised the shared cap to 480px/s (still comfortably above every hazard speed - 4x the fastest, level 3's 120 - so avoidance stays real) and updated the test's own sweep timing to match the now-genuinely-capped movement (40 steps at 90ms instead of 24 at 60ms) rather than leaving a stale assumption baked into its numbers. Both smoke tests pass; the collection test now legitimately needs several real seconds to sweep the viewport, same as a real player would.

**Hazards that notice you, not just patrol.** A shadow-wisp within roughly 2.6 hazard-radii of the player for even one frame goes into an "alert" state: its current patrol tween speeds up (`timeScale`, not a rewritten path - the loop shape stays exactly as seeded, only its pace and a light-intensity brighten change) and its own dim light visibly brightens as a fair "it's noticed you" telegraph, per the same "a threat you can't see coming is cheap, not hard" principle the hazard's cold light was already built on. Patrol layout is still fully deterministic for a fixed play, but a returning player can no longer purely memorize a fixed rhythm - staying close to a hazard is now something the hazard reacts to, not just an inert loop to route around once.

**A reason to play again.** The ending's existing "the dark caught you N times" line now quietly checks `localStorage` for a prior best and appends "- fewest yet" when a run genuinely beats it - nothing shown on a first-ever clear (there's nothing yet to have beaten), no persistent stat clutter otherwise, in keeping with SPEC's "restraint reads as quality." No backend, no account - the whole game already has neither.

**A 1-year plan**, `docs/game-1-year-plan.md`: what this game becomes if this direction keeps winning rounds, honest about the format's actual mechanic (only a winner's code survives into tomorrow's base, so continuity is the prize for winning, not a given), staged milestones with a concrete check for each, and the risks named plainly rather than assumed away.

**Verification:** `npm run check` and `npm test` both green (the collection test needs a generous per-test timeout under today's host load - three contestants' concurrent sessions pushed this shared 4-core host to a sustained 8-12 load average during this work; confirmed by killing my own earlier long-running diagnostic script and watching load stay elevated from other tenants' activity, not just mine). Typecheck clean. Hand-verified via Playwright-driven play (not just automated assertions): the movement cap traversal timing, the rendering and HUD state after a real playthrough segment, and a direct read of the alert/collision code path, since `checkHazardCollisions()` itself was left untouched by this change.

## Round 1 - Claude (continued: judging-day playtest - the ending's stats were near-invisible, 2026-08-24)

A fresh-eyes pass of the deployed build on judging day, looking for anything that hurts the
judged minute rather than for new features.

**The find: the ending's own payoff text had ~1.5:1 contrast.** The three closing lines (the
"the forest remembers the light" farewell, the flawless-clearings line, the resets line) and
the restart prompt were dark browns (`#2a2013`/`#4a3a1e`/`#3a2f1c`) on a near-black sky
(`#05060c`) - designed as silhouettes against the wisp's expanding additive bloom, which works
only where the bloom actually paints brightly behind them. Any renderer or display that draws
the bloom dimmer (software rasterizers provably; display color handling varies) leaves the
run's own closing stats the least readable text in the game. It had "verified" on a real
display the night before because the bloom rescued it there - the base contrast was always
broken. Fixed with warm parchment lettering in the same family the HUD and level card already
use (`#e7dcc2` -> `#d9c9a3` -> `#cfc0a0` -> `#a9987a`, descending brightness for hierarchy),
existing fade/pulse alphas unchanged; the mechanism is documented in the scene.

**Driver, not game:** the play-gate under tonight's shared-host load (three contestant
sessions, load 5-8 on 4 cores) kept losing its sentry-lane crossing at ~5fps headless. Measured
the level instead of assuming: the sentry's 880px patrol at 70px/s gives a ~12.6s cycle and a
~4s safe window; a player at the 480px/s cap crosses in ~0.4s. The gate's own dash was the
342px diagonal from the arc's end - 3-4s at 5fps, marginal by construction. The script (never
the game) gained a staging waypoint hard against the lane and a wider clearance wait.

**Verification (proportional to a color-only change):** typecheck + both Playwright smoke
tests green. Play-gate runs against BOTH the live judged URL and a local preview confirmed the
part a gate can still prove under this load: level 1's hand-authored arc and the
optional-collection choice work (beacon opens at exactly 10/14 for a required-only route, both
runs), HUD and atmosphere render correctly; the full-run legs then died to driver attrition
(deaths scattered over five different waypoints), so the ending evidence comes from
`scripts/ending-render-probe.mjs` instead - a scene-jump harness that renders the ending with
every line present (including the flawless line a required-only run never shows) on the same
build. The probe screenshot on the SOFTWARE rasterizer - the worst case the dark-brown text
failed on - shows all four lines cleanly legible with the intended hierarchy. Contrast measured,
not vibed: 1.27-1.85:1 before, 7.2-14.9:1 after (WCAG formula, against the sky base). The
probe needs a temporary `window.__game` line in `main.ts` that is never committed or deployed
(the deployed bundle is grep-verified free of it).

## Round 2 - Claude (the menu is a mechanic, and every level has one, 2026-08-25/26)

Round 2's brief: the main menu and the mechanics, judged from the deployed slot with no cap on
play time. Built on `round-2-base` (= the round-1 winner): three additions that give every
surface of the game a mechanic of its own, plus the robustness work an uncapped judging session
implies.

**The menu is the first mechanic.** The title screen is now a playable dark clearing: the wisp
is already alive there, light follows the cursor with *exactly* the level scene's trailing
movement (same ease, same 480px/s cap - the menu must feel like the game it opens or the
teaching is a lie), and starting is done in the game's own language - carry your light into the
warm beacon. Proven mouse-only by a scripted real-input run; Enter/Space still start instantly
(accessibility, and the test path), a quiet hint fades in only after ~7s of genuine stalling,
and a returning player's best run sits under the title, discovered rather than announced.

**Level 3: wind currents.** The storm finally touches the player - two data-driven currents
(`winds` in `levels.ts`), each made visible by its own fleck stream flowing along its push
vector: a hard midfield crosswind that makes crossing the open middle a routing choice, and a
beacon-approach updraft that helps you climb directly into the circuit hazard's triangle - the
level's standing risk/reward shape, now done with weather. The real work was a physics bug:
wind that pushes only the wisp is cancelled by the trailing ease (a proportional controller)
at a ~20px equilibrium wobble - caught by refusing to trust "the direction looks right",
measuring drift with a teleport probe, and instrumenting two iterations until drift ==
wind x accumulated-game-dt exactly. Wind pushes the wisp AND its chase target, applied after
the player-motion cap on purpose: the cap governs what the player can do; the storm is the
world acting on them.

**Level 2: shy motes.** Six of eighteen motes are pale, skittish ones (seeded pick, own
silver-teal texture - legible at a glance). Rush at them and they bolt; approach slowly - or
freeze until they settle - and they collect like any other. Flight drains a stamina pool in
~2.4s, their speed sags as they tire, and a spent mote settles dim until calm refills it; flee
direction is biased away from the beacon (a chase can never drag you into an accidental level
completion) and clamped to the playfield, and displaced motes drift home once you are well
away. One whisper line teaches the rule at the first startle. The counts are load-bearing:
13-of-18 required with only 12 normal motes guarantees at least one shy encounter per clear,
and flawless means taming all six. Why this shape and not plain flee-on-proximity: the
arithmetic (480px/s wisp vs any catchable flee speed) makes a pure chase a sub-second
non-event; the startle threshold makes the player's own approach speed the input - the one
thing no other mechanic in the game asks them to modulate - and stamina guarantees every chase
terminates, for humans and scripted drivers alike.

**Telemetry grew with the mechanics.** The published mote positions now refresh live every
frame (shy motes move; a driver reading collect-event snapshots would chase phantom
coordinates), each mote carries a `shy` flag, `winds` are published, and `activeTweens` backs
an event-driven leak check. `?level=N` on the menu is the new dev/test hook for opening a
later level directly - it is how the shy mechanic gets probed in isolation.

**Verification, sized for an uncapped judging session.** `scripts/shy-probe.mjs` proves the
shy rule with real mouse input against `?level=2`: rush -> flee >70px from home, sustained
chase -> tired -> caught, calm creep -> collected with 5px of drift, live telemetry moving
frame-to-frame, exactly 6 shy of 18, required 13. `scripts/round2-gate.mjs` is one scripted
session that plays the whole thing the way a judge would: menu started by walking the beacon
(no keyboard), level 1 by its cautious route, level 2 greedily against the shy motes, three
deliberate hazard deaths in a row on level 3 each verified to respawn clean, the storm played
through, the ending reached with the best recorded, a keypress back to the menu, and a fresh
second run that collects and dies and recovers - with the tween population sampled at every
checkpoint to rule out leak growth across death/level churn. Both smoke tests green.

**Late addition, same day: the startle got its telegraphs.** Round 1's winning margin was
partly sound, and the new mechanic was silent - a fresh startle now fires a quick two-grain
skitter (rate-limited so a startled cluster reads as one darting, quieter than the collect
chime by design) plus a subtle scale pop, both driven frame-side like the rest of the shy
simulation. Verified by re-running the full shy-probe on the built bundle: all three
behavioral legs intact, zero page errors across 22 driver resets with the skitter path
firing on every rush.

**What the gate actually proved before the deadline (run 6, one unbroken session, exit 0):**
menu started by mouse alone; level 2 entered at exactly 18 motes / 6 shy / 13 required and
beaten by greedy play against the fleeing motes; level 3 entered with both winds published;
three deliberate hazard deaths in a row, each respawn verified clean (full mote count back,
progress reset); the storm played through to its beacon; the ending reached with flawless=0
and the best written to localStorage; one keypress back to the menu; and a second run whose
entry tween census exactly matched a cold start (39 = 39 - a full playthrough plus ~57
recovered deaths leaves zero tween residue). Two earlier gate iterations also caught two
real design traps that are fixed above (the near-spawn shy pick and the beacon-zone mote) -
the gate earned its keep twice before it ever passed.

**The two-timebase discovery (standing fact for every future round).** At the ~1.3-5fps this
shared host renders headless (three contestants building at once hits the low end - measured,
and A/B-confirmed as contention, not code), Phaser's delta smoothing clamps each wall frame to
~16.7ms of game time: everything dt-driven (wisp, wind, shy motes) runs at a fraction of wall
speed while tweens (hazard patrols) advance near wall speed. Headless drivers die at crossings
that are trivial at 60fps because hazards are genuinely ~15x faster *relative to the wisp*
there - both timebases converge at full rate, where judging happens. Wall budgets in tests are
environment claims, not game claims, and are sized for the contended host; details in
ARCHITECTURE.md "Verifying a change on this host".
