# Art pipeline

Everything you see is produced by code in `tools/art` and can be rebuilt with `npm run art`.
There are no hand-painted, downloaded or AI-generated images in the channel.

```
fish.mjs  critters.mjs  predators.mjs     creatures (rigged sprites)
flora.mjs  rocks.mjs                      the reef kit (tintable)
fx.mjs  ui.mjs                            effects, indicators, interface
        |
   build-art.mjs      renders (cached), packs atlases, writes sprites.json
        |
   scene.mjs          composes each region's scenery from the kit -> data/scene_<id>.json
   make-brand.mjs     splash screens and icons
```

## The renderer

`lib/core.mjs` is a small software renderer: float images in linear light, a supersampled
"pixel shader" runner (`shade(w, h, ss, fn)`), value / fractal / cellular noise that can tile,
colour helpers, and file output. Sprites are saved as WebP with lossy colour and a lossless
alpha plane, with colour bled under the transparent pixels so that bilinear filtering on the
device never drags in a dark fringe.

`lib/light.mjs` is the one light rig every sprite shares: a warm key light from above and
slightly in front, a blue hemisphere ambient, and a cool rim light on edges that turn away from
the viewer. Because a fish, a coral and a rock are all lit by it, they look like they are in the
same water when the device puts them next to each other.

`lib/relief.mjs` renders solid scenery from a height field: normals from the heights, ambient
occlusion from how far a point sits below its surroundings, and soft cast shadows marched toward
the key light. It evaluates a margin outside the image, so a piece that joins a neighbour is
shaded as part of the larger shape and has no seam.

## Creatures are rigs

A sprite is a list of parts, each with a pivot, a position and an optional animation
(`lib/sprite.mjs` is the contract):

| Animation | What the device does | Used for |
|---|---|---|
| `tail` | swings and narrows with the swim cycle, follows the body wave | tail fins |
| `wave` | moves across the body, lagging the head | body strips of slender fish, sharks, eels |
| `flap` | rotates about its pivot | pectoral fins, claws |
| `sway` | slow rotation | tentacles, fronds, antennae, sea fans |
| `pulse` | stretches one way and squeezes the other | jellyfish bells, polyps, clam mantles |
| `bob` | moves up and down | legs, hovering bodies |

The device (`DrawCreature` in `render.brs`) mirrors the rig for the facing direction, pitches it
with the heading, and drives the swim cycle by speed: a cruising fish beats its tail slowly, a
sprinting one fast. This costs a handful of draw calls per animal and gives motion a flipbook of
any affordable length could not.

`node tools/art/preview.mjs tools/art/fish.mjs lionfish` renders a review sheet of any sprite.

## The reef kit

Scenery is authored grey — neutral albedo with the shading baked in — and coloured on the
device by multiplying with a tint. One sea fan sprite is purple in the Sun Garden, crimson on the
drop-off and dim blue behind the play plane. Rock comes as three-slice families (a cap, a middle
that tiles, another cap; shelves, slabs, walls, posts, pillars) plus boulders, so any collision
box in the reef can be dressed to its exact size. Middles come in two versions that join each
other, so long runs do not visibly repeat.

## Composing a scene

`scene.mjs` turns each region's collision layout (exported from the web game) into four display
lists per sector:

| Layer | Content |
|---|---|
| back | cave back walls; large growth and boulders in the colour of the distance |
| rock | the three-slice rock and timber dressing the collision shapes, the sand line, encrusting colour |
| flora | authored corals and seagrass, scatter on every surface, growth on walls and under ledges |
| front | seagrass and coral branches drawn over the animals, gloom over cave mouths |

Everything is seeded, so the same reef comes out every time. Each placement is
`[sprite, x, y, scaleX, scaleY, rotation, tint, swayAmp, swayRate, flags]` and each biome has a
small table of tints. Scatter avoids cleaning stations, creature anchors and reef passes, checks
that wall growth has open water in front of it, and keeps out of shelters.

`node tools/art/scene-preview.mjs reef --sector=4 --debug` draws a composed sector offline with
the collision shapes overlaid — the quickest way to judge a change.

## Atlases

`build-art.mjs` packs every part into pages of at most 2048x2048 on a 4-pixel grid with a
4-pixel gutter, so the half and quarter size copies made on the device stay aligned and do not
bleed into neighbours. Groups: `creatures`, `kit` (flora and rock) and `ui` (interface, effects,
indicators; never reduced by Low detail). `sprites.json` carries the rig data.

Rendered sprites are cached in `tools/art/.cache` by the hash of their module and the shared
libraries, so a rebuild after a small change takes seconds.

## Sizes

| | |
|---|---|
| Creature sheets | 2 pages, 77 sprites, about 300 parts |
| Kit sheet | 1 page, about 80 sprites |
| Interface and effects sheet | 1 page, about 65 sprites |
| On disk | about 1.5 MB of WebP |
| As textures | about 41 MB (High detail), plus reduced copies |
| Scene data | 17 to 28 KB per region |
