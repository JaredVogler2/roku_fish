/**
 * The one lighting rig shared by every sprite, so creatures, corals and rocks look like they sit
 * in the same water: a warm key light from above/front-left, a blue hemisphere ambient (bright
 * water above, darker water below) and a cool rim light on edges that face away from the viewer.
 * Vectors: +X right, +Y up, +Z toward the viewer. Colours are linear.
 */
import { add3, mul3, mulc, mix3, dot3, norm3, clamp } from './core.mjs';

export const KEY = norm3([-0.28, 0.82, 0.5]);
export const KEY_COL = [1.18, 1.12, 1.0];
export const SKY = [0.42, 0.62, 0.8];
export const GROUND = [0.2, 0.34, 0.42];
export const RIM = [0.55, 0.85, 1.0];
const VIEW = [0, 0, 1];
export const HALF = norm3([KEY[0] + VIEW[0], KEY[1] + VIEW[1], KEY[2] + VIEW[2]]);

/**
 * Shade a surface point.
 * @param albedo linear RGB
 * @param n      unit normal
 * @param gloss  tight wet highlight strength (0 = matte, ~0.5 = wet fish)
 * @param sheen  broad soft highlight strength (0..0.3)
 * @param ao     ambient occlusion 0..1 (1 = unoccluded), darkens ambient and softens the key light
 */
export function lit(albedo, n, gloss = 0, sheen = 0.1, ao = 1) {
  const ndl = clamp((dot3(n, KEY) + 0.35) / 1.35);
  const hemi = n[1] * 0.5 + 0.5;
  const amb = mul3(mix3(GROUND, SKY, hemi), ao);
  let c = mulc(albedo, add3(mul3(KEY_COL, (ndl * ndl * 0.25 + ndl * 0.75) * (0.55 + 0.45 * ao)), amb));
  const ndh = Math.max(0, dot3(n, HALF));
  const spec = Math.pow(ndh, 14) * sheen + Math.pow(ndh, 70) * gloss;
  c = add3(c, mul3(KEY_COL, spec * ao));
  const fres = Math.pow(1 - clamp(n[2]), 2.6);
  c = add3(c, mul3(RIM, fres * (0.1 + 0.3 * clamp(n[1] * 0.5 + 0.5)) * ao));
  return c;
}

/**
 * Thin translucent tissue (fins, membranes, petals): ribbed, brighter toward the thin edge where
 * light shines through, with a pale rim.
 * @param base     linear RGB
 * @param rayPhase radians; advances across the ribs (cos gives one rib per 2*PI)
 * @param r        0 at the attached base .. 1 at the free edge
 * @param edge     0..1 how close to the outline (for the pale rim)
 * @param spiny    stronger dark spines along the ribs
 */
export function membrane(base, rayPhase, r, edge = 0, spiny = false) {
  const ray = 0.5 + 0.5 * Math.cos(rayPhase);
  let c = mul3(base, 0.74 + 0.2 * ray + 0.16 * r);
  c = add3(c, mul3([0.5, 0.7, 0.8], 0.05 + 0.1 * r));
  if (spiny) c = mix3(c, mul3(base, 0.45), (ray > 0.75 ? (ray - 0.75) / 0.25 : 0) * 0.5);
  c = mix3(c, add3(mul3(c, 0.7), [0.25, 0.33, 0.36]), edge * 0.55);
  return c;
}

/** Normal of a height field z(x,y) sampled by central differences (x right, y up). */
export function heightNormal(zf, x, y, e = 0.004, strength = 1) {
  const zx = (zf(x + e, y) - zf(x - e, y)) / (2 * e);
  const zy = (zf(x, y + e) - zf(x, y - e)) / (2 * e);
  return norm3([-zx * strength, -zy * strength, 1]);
}
