/**
 * Sprite definitions: the contract between the art generators, the atlas packer and the Roku
 * runtime rig.
 *
 * A SpriteDef is
 *   {
 *     lenPx:  number,   // creatures: pixels that equal the creature's body length in the sim
 *                       // kit pieces: pixels per world unit they were authored at (normally 96)
 *     anchor: 'center' | 'base',
 *                       // center: origin = body centre (swimmers, drifters)
 *                       // base:   origin = point where the organism touches the ground
 *     tintable: boolean, // true: rendered with a white/neutral albedo; the device multiplies it by a
 *                       // colour (reef flora and rock, re-coloured per biome). false/omitted: full colour.
 *     parts: [ Part, ... ]   // drawn in order, first = furthest back
 *   }
 * A Part is
 *   {
 *     img:   Img,           // premultiplied linear RGBA, y down
 *     pivot: [x, y],        // pivot inside img (px); rotation and scaling happen about it
 *     at:    [x, y],        // where the pivot sits relative to the sprite origin (px, y DOWN,
 *                           // sprite facing +x / to the right)
 *     anim:  null | Anim,
 *   }
 * Anim kinds (all cheap for the device; angles in degrees, rates in cycles per second):
 *   { kind: 'tail',  rot, squash, phase }   swim-driven: rotates +-rot and narrows by up to squash
 *   { kind: 'wave',  amp, lag }             swim-driven body strip: moves +-amp px across the body, lag radians behind the head
 *   { kind: 'flap',  amp, rate, phase }     rotates +-amp about the pivot (pectoral fins, claws)
 *   { kind: 'sway',  amp, rate, phase }     slow rotation +-amp (tentacles, fronds, antennae)
 *   { kind: 'pulse', amp, rate, phase }     scale x by 1+amp*s and y by 1-amp*s (jelly bells, polyps)
 *   { kind: 'bob',   amp, rate, phase }     moves +-amp px vertically
 */
import { Img, over } from './core.mjs';

/** Flatten a SpriteDef into one image (neutral pose) for review sheets. Returns { img, origin }. */
export function flatten(def, margin = 4) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const p of def.parts) {
    const l = p.at[0] - p.pivot[0];
    const t = p.at[1] - p.pivot[1];
    x0 = Math.min(x0, l);
    y0 = Math.min(y0, t);
    x1 = Math.max(x1, l + p.img.w);
    y1 = Math.max(y1, t + p.img.h);
  }
  x0 = Math.floor(x0) - margin;
  y0 = Math.floor(y0) - margin;
  const img = new Img(Math.ceil(x1) + margin - x0, Math.ceil(y1) + margin - y0);
  for (const p of def.parts) over(img, p.img, Math.round(p.at[0] - p.pivot[0]) - x0, Math.round(p.at[1] - p.pivot[1]) - y0);
  return { img, origin: [-x0, -y0] };
}

/** Basic structural checks; returns a list of problems (empty = fine). */
export function validate(id, def) {
  const issues = [];
  if (!(def.lenPx > 0)) issues.push(`${id}: lenPx missing`);
  if (def.anchor !== 'center' && def.anchor !== 'base') issues.push(`${id}: anchor must be 'center' or 'base'`);
  if (!Array.isArray(def.parts) || def.parts.length === 0) issues.push(`${id}: no parts`);
  for (const [i, p] of (def.parts ?? []).entries()) {
    if (!(p.img instanceof Img)) issues.push(`${id}[${i}]: img is not an Img`);
    else if (p.img.w > 1024 || p.img.h > 1024) issues.push(`${id}[${i}]: part larger than 1024 px`);
    if (!Array.isArray(p.pivot) || !Array.isArray(p.at)) issues.push(`${id}[${i}]: pivot/at missing`);
    if (p.anim && !['tail', 'wave', 'flap', 'sway', 'pulse', 'bob'].includes(p.anim.kind)) issues.push(`${id}[${i}]: unknown anim ${p.anim.kind}`);
  }
  return issues;
}
