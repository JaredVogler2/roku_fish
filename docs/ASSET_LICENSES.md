# Asset sources and licences

**The channel ships no third-party art, audio or model files.** Everything in `channel/` is
produced by code in this repository:

| Asset | Source |
|---|---|
| Creature sprites (77 species) | Rendered offline by `tools/art/fish.mjs`, `critters.mjs`, `predators.mjs` |
| Corals, sponges, sea fans, seagrass, rock, sand, wreck timber | Rendered offline by `tools/art/flora.mjs`, `rocks.mjs` |
| Effects, rings, light shafts, backdrop silhouettes | `tools/art/fx.mjs` |
| Wordmark, icons, panel pieces | Drawn as vector shapes by `tools/art/ui.mjs` |
| Splash screens and home-screen icons | Composed by `tools/art/make-brand.mjs` from a frame of the channel's own reef and the wordmark |
| Reef layouts | Composed by `tools/art/scene.mjs` from the collision layout of the web game |
| Sound effects and music | Synthesised by `tools/audio` (no samples) |
| Game data | Exported from the REEFBOUND source by `tools/export-data` |

No images were downloaded, scanned or produced by an image-generation model. No assets, names,
logos or text from MECC's *Odell Down Under* are included. Species names are the common and
scientific names of real animals (the Lumen Wrasse is fictional).

## Fonts

- The wordmark is rasterised at build time from **Inter Display Black** (SIL Open Font License
  1.1). The font file itself is not shipped. If it is not installed, `ui.mjs` falls back to the
  system sans-serif.
- All other text is drawn at run time with the Roku system font.

## Development dependencies (not shipped in the channel)

| Package | Licence | Used for |
|---|---|---|
| brighterscript | MIT | Static checking of the BrightScript source |
| brs-engine | MIT | BrightScript simulator for tests and screenshots |
| sharp | Apache-2.0 | Writing WebP, PNG and JPEG |
| @napi-rs/canvas | MIT | Vector drawing for interface art, scene previews |
| fflate | MIT | Building the channel zip |
| Playwright / Chromium | Apache-2.0 / BSD-style | Running the simulator headless (expected to be installed already) |
