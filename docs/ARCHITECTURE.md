# Architecture

How the channel is put together and why. For the art see [ART_PIPELINE.md](ART_PIPELINE.md); for
the traps of the language and platform see [PORTING_NOTES.md](PORTING_NOTES.md).

## The shape of it

One `roScreen` (1280x720, double buffered), one message port, one loop (`main.brs`):

```
loop:
  read the remote                      input.brs
  advance the reef in 1/30 s ticks     game.brs -> world.brs (at most three ticks per frame)
  draw the reef                        render_world.brs, render.brs, backdrop.brs
  draw the interface                   hud.brs, screens.brs, overlays.brs, guide.brs, creatorui.brs
  swap buffers
```

The reef behind the menus is the same simulation without a player (the "attract" world), so the
menus cost no extra code path.

| File | What it holds |
|---|---|
| `main.brs` | Entry point, loading screen, the loop, which interface is in front |
| `game.brs` | Starting and ending runs, the fixed-step frame, events turned into sound, toasts and saves |
| `world.brs` | One simulation tick; the list of active creatures |
| `brain.brs` | Creature AI: perception, decisions, steering, movement |
| `player.brs` | The player's fish: targeting, chasing, sprinting, eating |
| `feeding.brs`, `combat.brs`, `abilities.brs`, `cleaning.brs`, `travel.brs`, `spawner.brs` | The rule systems, one per file, ported from the web game's `systems/` |
| `modes.brs` | Ascension goals, ladders, the tutorial script |
| `terrain.brs` | Collision and shelter queries on the baked grid |
| `data.brs`, `creature.brs`, `creator.brs`, `save.brs` | Species data, creature records, Reef Lab rules, the registry |
| `render*.brs`, `backdrop.brs`, `gfx.brs` | Camera, sprite atlases, the reef renderer |
| `ui.brs`, `hud.brs`, `screens.brs`, `overlays.brs`, `guide.brs`, `creatorui.brs` | The interface |
| `input.brs`, `audio.brs`, `util.brs` | Remote, sound, maths and helpers |

## Making an interpreter keep up

BrightScript is interpreted and slow: a statement costs on the order of a microsecond and a
function call that returns a value several. A reef of 300 animals, each sensing and steering 60
times a second, is far out of reach. The simulation was reorganised around that, without changing
the rules:

- **Fixed 30 Hz ticks, drawn with interpolation.** The frame rate and the simulation rate are
  independent; every creature remembers its previous position and the renderer blends between
  the two, so motion is smooth at 60 fps on a fast player and correct at 20 on a slow one. A
  frame runs at most three ticks; time left over after a stall is dropped rather than replayed.
- **An active bubble.** Only creatures within the camera's view plus a margin are fully simulated
  (typically 40 to 60 of about 300). The rest are *dormant*: every four seconds they take one
  coarse step along a waypoint, keep their hunger and day/night state up to date, and wake when
  the bubble reaches them. A rolling scan (24 creatures a tick) moves animals in and out.
- **Thinking is rarer than moving.** A creature decides what to do (hunt, flee, hide, school,
  visit a cleaner) about five times a second near the player and three times a second further
  away, staggered so the work is spread across ticks. Steering and collision run on the
  creature's own period: every tick for the player and for anything hunting the player or being
  hunted by them, every second tick for animals close by or fleeing, every third or fourth
  further out, with the step length scaled to match. Sessile life is not moved at all.
- **Collision is a lookup.** The web game evaluates signed-distance shapes per query. The build
  bakes each region into a grid (0.25 units a sample, one byte of distance plus up to three
  nearby shelter ids). A query is a bilinear read that gives the distance and the surface
  normal.
- **The food web is a table.** "Can species A eat species B, how, and how much is it worth" is
  precomputed for nominal body sizes and read as an array index. Exact checks (the real feeding
  rules, with actual sizes, shelters and line of sight) are kept for the player and for the
  moment an attack lands.
- **Timers are absolute times,** so an idle creature costs nothing, and hunger, cooldowns and
  ability durations do not need counting down.
- **No trigonometry in the hot path.** Headings are unit vectors, turning is a vector rotation
  with a small-angle step, and the pitch of a swimming fish comes from a polynomial.
- **Hot helpers are subs that write into fields** (`m.td`, `m.tnx`, `m.fc`...) instead of
  functions that return values, which measured several times faster.

Measured in the simulator: about 5 to 10 ms a tick with 40 to 50 active creatures, and about
4 ms of script to draw the scenery. The simulator's speed is only a rough guide to a device.

## Data

Nothing about the game's content is typed into the channel. `tools/export-data/export.ts` imports
the web game's own TypeScript modules and writes:

| File | Content |
|---|---|
| `data/species.json` | 77 species with their stats, diets, abilities, text; ability and upgrade tables |
| `data/balance.json` | Balance constants, difficulty presets, ladders, goals, Reef Lab costs |
| `data/foodweb.json` | The precomputed eat and threat matrices |
| `data/region_<id>.json`, `.bin` | Sectors, populations, shelters, stations, surfaces, passes; the baked collision grid |
| `data/biomes.json` | Water and haze colours per biome |
| `data/scene_<id>.json` | The display lists composed by `tools/art/scene.mjs` |

JSON keys are lower case throughout because `ParseJson` gives case-sensitive arrays while
BrightScript's dot operator lower-cases the name it looks up.

## Rendering

Back to front, per frame:

1. Water: a clear colour plus a tinted gradient for the depth and biome; sky and waterline when
   the surface is in view.
2. Backdrop: two reef silhouettes with parallax, light shafts.
3. Scenery layers of the sectors in view — *back* (cave interiors, hazy distant growth), the
   seabed body, *rock*, *flora*.
4. Reef passes, then creatures: bottom-dwellers and rooted life, effects, swimmers, the player.
5. *Front* layer: seagrass and coral that hide what swims behind them, cave gloom.
6. Particles, target rings, vignette and damage tints, then the interface.

A scenery piece is one or a few `DrawScaledObject` / `DrawTransformedObject` calls with a colour.
The colour is the piece's tint multiplied by the light for its depth and the time of day,
recomputed only when the time of day changes noticeably. A creature is drawn part by part from
its rig (see the art pipeline notes).

Each atlas has half and quarter size copies made at load time. A sprite drawn at less than 60 %
or 30 % of its authored size comes from the smaller copy, which avoids the shimmer of scaling a
large texture far down with bilinear filtering.

`GfxProbe` draws a test pattern off-screen at start-up and reads it back to learn whether the
device mirrors, rotates and tints sprites as documented.

## Saving

One JSON document in the registry section `reefbound` (a few kilobytes of the 32 KB allowed):
settings, discovered species, the Ascension checkpoint, the Tournament stage, the best Challenge
runs, Reef Lab designs, records. It is written at checkpoints, on death, when a run ends and
when settings change. Unknown or damaged data falls back to defaults field by field.

## Deliberate limits

- Hunters steer around obstacles but do not path-find; they give up a chase that is not closing.
- Creature-versus-creature perception uses nominal body sizes (the matrix); the player's
  interactions use exact sizes.
- AI randomness uses the built-in generator; the seeded generator is kept for what must repeat
  (populations, Challenge line-ups, upgrade offers).
