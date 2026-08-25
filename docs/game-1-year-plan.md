# Start of Glow: a one-year plan

Written 2026-08-23 (dated 08-24 in its first commit by mistake), in response to the owner's notice
extending the round-2 window and asking for two things: real depth in the gameplay itself, and a genuine
plan for where this goes over a year - not a task list for tomorrow.

## What kind of plan this actually is

Being honest about the format first, because it changes what a "1-year plan" can mean here.

This is a **daily** competition. Every morning, all three contestants reset to `round-N-base` - whichever
build won the previous round - and build for one day. At 20:00 UTC the owner plays each slot for about a
minute and picks one winner. That winner's code becomes tomorrow's base, for everyone, including the two
contestants who did not write it. My own code only survives past today if I win today, or if nothing I've
built conflicts with whatever direction the actual winner takes the base in.

So there are really two different plans hiding inside "a plan for the game":

1. **A plan for the game I would build if I could freely keep extending my own base** - the creative
   vision, the milestones, the mechanics. This is what the rest of this document mostly is.
2. **A plan for how any of that gets to happen at all**, which is really a plan for *winning rounds
   consistently enough that my direction is the one that persists* - because in this format, continuity is
   not the default, it is the prize.

I am writing this as (1) with (2) treated as the actual constraint it is, not glossed over. If a rival wins
three rounds in a row with a completely different genre, the honest move next time I get to build is to
read their `ARCHITECTURE.md`, understand *why* it won, and decide whether to extend that direction or build
my own case again on top of it - not to pretend this document locks in a codebase that the format itself
does not guarantee me. RULES.md says it plainly: "yesterday's losing ideas are not carried forward for
free." A plan that ignores that isn't a plan, it's a wish.

The other honest constraint: the game-off is **discretionary side work by default** ("main-project
handoffs come first, always... skipping a round carries no penalty"). The owner has twice now explicitly
elevated it to first-class effort for a specific window (notices 246 and 257). This plan assumes effort on
this project is **bursty**, not a steady year-long drip - concentrated when it's asked for or when a round
is worth fighting for, thin otherwise. I'd rather say that plainly than write a plan that implies a
commitment level nothing in the actual rules promises.

## Where it stands today

Round 1 (shipped, judged informally as "three pretty clearings with motes - not a game") proved the
atmosphere: Light2D glow, parallax, a breathing light, synth ambience, the reveal-by-light hook. It had no
structure.

Round 2 (shipped 2026-08-21, extended window closing 2026-08-24) added the structure the spec's own text
predicted round 1 would need: a menu, three levels driven by one data-shaped `LevelConfig`, a real goal
(collect every mote, walk into the beacon), a real threat (patrolling shadow-wisps with a genuine fail
state that costs the level's progress, not the run), sound, and an ending that reports how many times the
player failed.

What round 2 actually is, honestly named: **a collectathon with a fail state.** That's a real genre and a
legitimate direction, not a criticism - but naming it precisely is what makes it possible to see what's
missing. Reviewing the code and playing it directly (see "what I actually found" below) surfaced four
concrete gaps between "a full game" and "a game with real depth":

- **No real risk or choice.** Every mote is mandatory to clear a level. There is no moment where a player
  decides whether something is worth the risk - only whether they can execute a fixed collection route.
- **No replay pull.** The `resets` counter is reported once, at the very end of three levels, and then
  discarded. Nothing carries between sessions. A player who finishes once has seen everything there is.
- **Difficulty by memorization, not skill.** Hazard patrols are fully deterministic (seeded per level) and
  never react to the player. The first playthrough of a level is the hardest one; every subsequent
  playthrough of the *same* level is easier because the player has memorized a fixed loop, not because
  they got better at anything transferable.
- **An input-method inconsistency that may be quietly deciding how hard the game actually is.** Keyboard
  movement is speed-capped (347px/s). Mouse movement sets an immediate target and eases the wisp toward it
  with no equivalent cap - meaning a mouse player can effectively snap toward safety in a way a keyboard
  player cannot. If true, this means the game's difficulty is not a designed curve at all, it's an accident
  of which input device someone happens to use. This is the first thing I checked directly rather than
  reasoning about from the code alone - see below.

## What I actually found (not just reasoned about)

The owner's instruction was to judge this by playing it, not by diff size, so before writing the rest of
this plan, I drove the game programmatically (Playwright simulating real mouse movement, the same input
surface a real player uses) and read the movement math in `LevelScene.update()` directly rather than
guessing at the feel from the architecture doc's prose alone.

That surfaced a real fairness bug, not just a design opinion: keyboard movement was speed-capped at
347px/s, but mouse movement was not - `POINTER_MOVE` set the movement target straight to the cursor's
world position with no distance limit, and the exponential ease-toward-target then covered *more* ground
per frame the farther that target was, so a single mouse flick could close far more distance in one frame
than the keyboard's real cap ever allowed. In practice: hazard-avoidance difficulty was an accident of
input device, not a designed curve. Fixed by capping the actual per-frame displacement (not the target
itself) to one shared speed for both inputs - full detail in `CHANGELOG.md`'s "Round 1 - Claude (continued)"
entry and `ARCHITECTURE.md`'s "Input" note.

The fix immediately exposed a second, more interesting finding: the existing smoke test's mote-collection
sweep had been implicitly relying on the *old, unbounded* mouse speed to work inside its time budget - a
real signal, confirmed by playing it, that treating keyboard's already-shipped 347px/s as automatically the
"correct" pace for mouse too made repositioning feel sluggish, not just avoidance fair. Raised the shared
cap to 480px/s and updated the test's timing to match, rather than either leaving mouse movement
unbounded again or shipping a slower feel nobody had actually checked. This is exactly the kind of thing
that only shows up by playing a change, not by reading the diff - a purely code-review pass on "add a speed
cap" would have plausibly shipped 347 and never noticed it read as worse, not just fairer.

## The vision

If this direction keeps winning long enough to compound, "Start of Glow" becomes a small, complete,
wordless explorer in the Ori spirit - not a big game, a *finished* one. A handful of hand-composed zones
with real geographic identity, not re-tinted procedural forests. A light that grows across an entire
playthrough, not just within one level. Moments a player remembers specifically (a beacon visible from far
away across a valley; a zone whose mechanic is different enough from the others that finding it feels like
discovery) rather than a longer list of interchangeable stages. A short, real ending that pays off the
"light reveals the world" hook at a scale no single level's beacon can - the last few minutes of the whole
game being where the promise of the first few seconds finally cashes out.

The throughline across every phase below is the spec's own hook, unchanged: *you are a small light-being,
you collect light, your glow grows, and growing glow is what reveals the world.* Everything added has to
still be recognisably that, every round.

## Build order

Each phase names what changes, why it's next, and - since the owner explicitly asked how I'd know each
step worked - a concrete, checkable signal for it. The strongest signal in this format is always the same
one: does it win the round. Everything else is a supporting check I can run myself before a build ever
reaches judging.

### Phase 0 - this round (by 2026-08-24 evening)

Fix the things that are arguably bugs in feel, not missing features, and add the smallest real depth that
fits in the remaining window:

- **Consistent movement cap** regardless of input device, so hazard avoidance is one real, designed
  difficulty curve instead of an accident of mouse vs. keyboard.
- **A hazard that reacts**, at least minimally - speeding up or alerting when the player's light lingers
  close - so a second playthrough of the same level requires staying alert, not just recalling a memorized
  loop. Stays fully deterministic (same trigger conditions, same seeded patrol) so builds remain comparable
  in judging, per the architecture's own stated reason for determinism.
- **A personal-best hook**, localStorage only, shown at a natural pause point (level clear or the ending),
  not as persistent HUD clutter - the smallest possible answer to "what makes someone want a second run."

Check: replay my own play-test script before and after the movement fix and confirm avoidance difficulty
converges between keyboard-driven and mouse-driven runs; run the game twice in a row myself and confirm the
best-tracking visibly changes on the second run; and, the real test, whether it wins tomorrow's round.

### Phase 1 - next few rounds I get to build on this direction

- **Make collection optional, not mandatory.** Something like 70-80% of a level's motes opens the beacon;
  full collection instead earns a visibly warmer "flawless" variant (a brighter beacon pulse, a fuller
  chime run) rather than gating progress on it. This is the actual risk/reward decision the game currently
  has none of - go get the mote near the hazard, or don't.
- **Hand-author level 1's layout** instead of pure seeded placement. The first level is what the judged
  minute is actually looking at; a deliberately composed opening space reads as more intentional than a
  procedural roll, and "feel/atmosphere" is explicitly part of what's judged.
- **Give the third level's mood a real identity**, not just a palette shift - a distinct particle behavior
  or audio layer for "storm-dark" so progression feels like arriving somewhere different, not the same
  forest re-tinted three times.

Check: play test 1-3 with someone (or myself) blind to the change and see whether the optional-collection
choice actually gets exercised (a player who never skips a mote means the choice isn't legible); whether
level 1 reads as more composed in a fresh 1-minute play than the current procedural version.

### Phase 2 - roughly the next month of rounds

- **The menu as the first mechanic** *(added 2026-08-25: the round-2 brief names "the screen you
  arrive at before any of it starts" as a judged surface, and this plan had skipped the menu
  entirely - a real omission, since it is the one screen every session and every judging pass
  starts on).* The title screen becomes a small playable clearing: the wisp is already there,
  light follows the cursor, and starting the game is walking into a lit beacon - the core verb
  taught wordlessly before play begins, in the game's own language instead of a "press any key"
  instruction.
- **A small hub between levels** - a short, wordless connective space where the previous level's fully-grown
  light is visible in the distance, so progress has a visual echo instead of a hard cut to the next stage.
- **A light meta-progression**, still localStorage-only, no backend: lifetime motes collected quietly
  unlocks small cosmetic variation (a different wisp trail color, a subtler beacon shape) discovered rather
  than announced - a long-horizon reason to return that doesn't violate "wordless where possible" or
  "restraint reads as quality."
- **More levels**, each still defined as data in `levels.ts`, but with at least one mechanical wrinkle each
  rather than only escalating mote/hazard counts - e.g., a zone where the light also reveals a moving
  platform, so "reveal" starts doing double duty as a traversal mechanic, not just a collection one.

Check: whether a returning player (or a fresh playtest a week apart) notices the hub and meta-progression
without being told; whether the new mechanical wrinkle still reads as "collect light, glow reveals" at a
glance, per the spec's own bar.

### Phase 3 - roughly 3-6 months, if this direction is still the one winning

- **5-8 hand-authored zones** with real identity, replacing procedural placement everywhere, not just level
  1. Each zone keeps the core hook but can vary its mechanic (a wind current, a platform layer, a hazard
  that behaves differently) the way Ori's biomes stay recognizably one game while feeling genuinely
  distinct from each other.
- **Deeper, still fully synthesized audio** - distinct motifs per zone, and the "motion sells it" feel note
  extended into sound: drone intensity or texture shifting with hazard proximity, not just on fixed cues.

Check: does a fresh player, given the whole thing with no instructions, correctly narrate back what each
zone is "about" without being told - the wordless-storytelling bar the spec sets for the whole project.

### Phase 4 - 6-12 months, the aspirational ceiling

- **A real beginning-middle-end arc** across the hand-authored world, ending in one reveal moment bigger
  than any single level's beacon - the hook's biggest possible payoff, once, at the very end.
- **A challenge variant for returning players** who've already finished once (harsher hazards, a "total
  darkness" mode) - built once the base game is finished and worth revisiting, not before.

This phase is explicitly the ceiling to aim at, not a commitment - I don't know whether this format runs a
full year, whether the rules change, or whether a rival's winning direction makes parts of this moot. It
gets re-planned against evidence the same way the business side's vision does: revisit it, don't just trust
it, when the actual round history says something different than expected.

## The points economy, briefly

A win banks one glow point; redeeming a tip from the owner costs more each time I ask (1st tip = 1 point,
2nd = 2, and so on). I have zero points as of this writing, so the question is moot today, but the standing
plan once I have any: bank the first win or two rather than spend immediately - a tip is worth more once I
have a real pattern of *specific* losses to ask about than it is as a generic first-round check-in. If I'm
ever genuinely stuck on direction rather than execution, spending the cheap first point early to correct
course beats compounding a wrong instinct across several rounds for free.

## Risks, named plainly

- **Continuity is not guaranteed.** Everything past Phase 0 depends on winning enough rounds, or on a
  future base being compatible enough with this direction to extend rather than replace. If a rival wins
  with a fundamentally different genre, the honest move is to read why it won and decide fresh, not to
  force this plan onto an incompatible base.
- **This is side work by default.** The constitution and RULES.md both say so. This plan assumes real but
  uneven effort, not a steady year of daily investment - closer to how the business side already treats
  bets: pursued while the evidence and the owner's stated priority support it, re-ranked when they don't.
- **The judged minute rewards immediate feel, not long-horizon systems.** A meta-progression unlock nobody
  sees in a one-minute session doesn't win a round by itself. Phase 0's fixes are weighted toward what a
  single judged minute can actually register (consistent difficulty, a hazard that feels alive) precisely
  because that's the recurring, real signal this format gives me - the deeper systems in later phases are
  bets on the owner spending more than a minute with a build worth returning to, which is exactly what this
  extended window already is.
