# Porting notes

What was learned turning a TypeScript / three.js game into a BrightScript channel. Useful if you
change the channel or port something else.

## Platform limits that shaped the design

| Limit | Consequence |
|---|---|
| A store channel may be at most 4 MB | Compact sprite kits composed at run time instead of painted backgrounds; lossy WebP; 16 kHz mono effects and 40 kbps music |
| A bitmap may be at most 2048x2048 | Atlas pages of that size |
| The 2D API has no shaders or lighting | Shading is baked into the sprites; light is a per-draw colour multiply |
| BrightScript is interpreted | The simulation was reorganised (see [ARCHITECTURE.md](ARCHITECTURE.md)) |
| `roAudioResource` plays WAV only and mixes very few at once | Short effects, rotated across the available streams, with a 70 ms guard against retriggering |
| `roAudioPlayer` cannot set a volume | The music-to-effects balance is fixed in the files |
| The registry holds 32 KB per channel | One small JSON save document |
| A remote has a D-pad and a handful of buttons | Lock-on biting, an inspect button, forms and grids for every menu, names picked from a list |

## BrightScript traps met along the way

- **`ParseJson` arrays are case-sensitive, the dot operator is not.** `obj.someKey` looks up
  `somekey`. Every key in the exported JSON is lower case; ids used as keys are looked up through
  `LCase`.
- **Reserved words cannot be identifiers or member names,** and the list is long: `run`, `pos`,
  `rem`, `type`, `to`, `step`, `stop`, `tab`, `box`, `next`... A local variable also may not
  share its name with a function (`nowMs = NowMs()` is an error).
- **Nested `for each` over the same array is not safe** (the iterator is shared). Outer loops
  that may be re-entered use an index.
- **Associative arrays cannot be compared with `=`.** Compare ids.
- **Integers are 32-bit signed.** A colour `&hRRGGBBAA` with red at or above 128 is negative;
  `Rgba()` in `util.brs` builds colours without overflowing.
- **Calling a function that returns a value is several times dearer than a sub.** Hot helpers
  write their results into fields of `m` instead.
- **`roScreen` reports one press and one release per button, no repeats.** Held state and menu
  key-repeat are done in `input.brs`.
- **Alpha blending must be switched off on the destination when copying a bitmap** that should
  keep its transparency (the reduced texture copies), or the copy is blended onto black.

## The simulator

Development used [brs-engine](https://github.com/lvcabral/brs-engine), a BrightScript
implementation in JavaScript, driven by Playwright (`tools/sim/run.mjs`). It was good enough to
find every script error met so far and to take the screenshots in this repository. Its limits:

- It rasterises in software and re-colours tinted textures in JavaScript, so its frame rate
  says little about a device. The harness replaces that one path with a per-sprite tint cache.
- Its relative costs are not a device's (a value-returning call is unusually expensive there).
- Audio was not auditioned.
- Its registry lives in the browser profile, which the harness discards, so saves were tested
  within a session (save a Reef Lab design, see it in Practice; reach a checkpoint, see
  *Continue* on the menu), not across launches.

`npx bsc --project bsconfig.json` (BrighterScript) checks the source without running it and
catches most typing mistakes: reserved words, unknown functions, wrong argument counts.

## Things that are approximations

- The scenery matches the collision shapes, not the web game's 3D meshes; props were re-laid by
  rules, so individual corals are not where they are in the browser.
- Creature sprites are side views. A fish turning around is a quick squash through zero width.
- Depth of field, caustics on surfaces and real-time shadows have no equivalent; the baked
  shading, depth tinting, light shafts and vignette stand in for them.
