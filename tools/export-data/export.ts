/**
 * Exports REEFBOUND's game content to the formats the Roku channel reads.
 *
 * It imports the web game's own TypeScript modules, so species, balance numbers, food-web rules
 * and reef layouts stay identical to the source game. Run it with vite-node from a REEFBOUND
 * checkout (see package.json "export:data"):
 *
 *   REEFBOUND_DIR=../REEFBOUND OUT_DIR=channel/data vite-node tools/export-data/export.ts
 *
 * Outputs
 *   species.json    every species (stats, diet, text) + ability and upgrade tables
 *   balance.json    tuning numbers, difficulty presets, mode progression, Reef Lab costs
 *   foodweb.json    precomputed "who can eat whom" matrix (the game's checkFeed at nominal size)
 *   region_<id>.json  sectors, shelters, cleaning stations, crawl surfaces, spawn anchors, passes
 *   region_<id>.bin   baked collision field: signed distance + nearby shelter ids per 0.25 unit
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(process.env.REEFBOUND_DIR ?? '../REEFBOUND', 'src/game');
const OUT = path.resolve(process.env.OUT_DIR ?? 'channel/data');
const TOOLS_OUT = path.resolve(process.env.TOOLS_OUT_DIR ?? 'tools/art/data');

const imp = (rel: string) => import(/* @vite-ignore */ path.join(SRC, rel));

/**
 * BrightScript's ParseJson returns case-sensitive associative arrays, and the dot operator
 * lower-cases the member name, so every key written here is lower case. Values keep their case.
 */
function lowerKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(lowerKeys);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k.toLowerCase()] = lowerKeys(val);
    return o;
  }
  return v;
}
/** The em dash is the only non-ASCII character in the game text; a hyphen is safe in every device font. */
const toJson = (v: unknown) => JSON.stringify(lowerKeys(v)).replace(/\u2014/g, '-');

const round = (v: number, d = 3) => {
  const k = 10 ** d;
  return Math.round(v * k) / k;
};

async function main() {
  const { ALL_SPECIES, getSpecies } = await imp('data/species.ts');
  const { ABILITIES } = await imp('data/abilities.ts');
  const { BALANCE, DIFFICULTY } = await imp('data/balance.ts');
  const prog = await imp('data/progression.ts');
  const custom = await imp('data/customFish.ts');
  const { Creature } = await imp('core/creature.ts');
  const feeding = await imp('systems/feeding.ts');
  const { buildRegion } = await imp('world/region.ts');
  const { REGION_IDS } = await imp('world/blueprints.ts');
  const { preyOf, predatorsOf, FOOD_LABEL } = await imp('content/foodweb.ts');
  const { TUTORIAL_STEPS } = await imp('modes/tutorial.ts');
  const constants = await imp('core/constants.ts');

  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(TOOLS_OUT, { recursive: true });

  // ------------------------------------------------------------------ species
  const index = new Map<string, number>();
  ALL_SPECIES.forEach((s: any, i: number) => index.set(s.id, i));

  const species = ALL_SPECIES.map((s: any) => {
    const o: Record<string, unknown> = {
      id: s.id,
      name: s.displayName,
      group: s.group,
      archetype: s.archetype,
      activity: s.activity,
      habitat: s.habitatTags,
      rows: s.rows,
      band: s.depthBand,
      movement: s.movement,
      tier: s.trophicTier,
      len: s.baseBodyLength,
      mass: s.baseMass,
      health: s.baseHealth,
      swim: s.swimSpeed,
      burst: s.burstSpeed,
      accel: round(s.acceleration),
      agility: s.agility,
      perception: round(s.perceptionRadius),
      gape: s.mouthGape,
      bite: s.biteStrength,
      armor: s.armor,
      venomRes: s.venomResistance,
      tox: s.toxicity,
      spines: s.spines,
      foodTags: s.foodTags,
      sizeTag: s.sizeFoodTag,
      diet: s.diet.map((d: any) => {
        const e: Record<string, unknown> = { tag: d.foodTag, pref: d.preference };
        if (d.minTargetSizeRatio !== undefined) e.minRatio = d.minTargetSizeRatio;
        if (d.maxTargetSizeRatio !== undefined) e.maxRatio = d.maxTargetSizeRatio;
        if (d.biteOnly) e.biteOnly = true;
        if (d.toxinTolerance !== undefined) e.tol = d.toxinTolerance;
        if (d.requiresAbility) e.ability = d.requiresAbility;
        if (d.requiresMilestone !== undefined) e.ms = d.requiresMilestone;
        return e;
      }),
      abilities: s.specialAbilities,
      model: s.modelKey,
      pattern: s.patternKey,
      palette: s.palette,
      playable: s.playable,
      summary: s.encyclopedia.summary,
      fact: s.encyclopedia.ecologyFact,
    };
    if (s.scientificName) o.sci = s.scientificName;
    if (s.foodCharges) o.charges = s.foodCharges;
    if (s.chargeRegenPerMin) o.regen = s.chargeRegenPerMin;
    if (s.nutrition !== undefined) o.nutrition = s.nutrition;
    if (s.immuneTo) o.immuneTo = s.immuneTo;
    if (s.schooling) o.school = { count: s.schooling.preferredCount, cohesion: s.schooling.cohesion };
    if (s.emissive) o.emissive = s.emissive;
    if (s.role) o.role = s.role;
    if (s.cleaner) o.cleaner = s.cleaner.activity;
    if (s.anemoneSymbiont) o.anemoneSymbiont = true;
    if (s.ambush) o.ambush = true;
    if (s.protectedByEtiquette) o.protected = true;
    if (s.fictional) o.fictional = true;
    if (s.encyclopedia.stylization) o.stylization = s.encyclopedia.stylization;
    // Field Guide food web (same rules the game uses).
    o.prey = preyOf(s.id).map((id: string) => index.get(id));
    o.predators = predatorsOf(s.id).map((id: string) => index.get(id));
    return o;
  });

  const abilities = Object.values(ABILITIES).map((a: any) => ({
    id: a.id, name: a.name, description: a.description, cooldown: a.cooldown, duration: a.duration, energyCost: a.energyCost,
    drainPerSec: a.drainPerSec ?? 0, toggle: !!a.toggle,
  }));

  // Upgrades: the web game stores closures; mirror them as data the BrightScript side applies.
  const UPGRADE_EFFECTS: Record<string, Record<string, unknown>> = {
    burstTail: { mul: { burst: 1.2, sprintDrain: 0.75 } },
    armorScales: { add: { armor: 0.2 }, mul: { damageTaken: 0.8 } },
    keenSenses: { mul: { perception: 1.35 } },
    efficientGills: { mul: { drain: 0.75 } },
    quickJaw: { mul: { lungeCooldown: 0.65 }, add: { biteStrength: 0.2 } },
    poisonTolerance: { add: { venomRes: 0.4 } },
    camouflage: { grant: 'camouflage' },
    defensiveSpines: { add: { spines: 0.25 }, grant: 'defensiveSpines' },
    swiftFins: { mul: { speed: 1.12, agility: 1.15 } },
  };
  const upgrades = prog.UPGRADES.map((u: any) => {
    if (!UPGRADE_EFFECTS[u.id]) throw new Error(`No effect table for upgrade ${u.id}`);
    return { id: u.id, name: u.name, description: u.description.replace(' (Q)', ''), ...UPGRADE_EFFECTS[u.id] };
  });
  // Sanity-check the mirrored tables against the real closures.
  for (const u of prog.UPGRADES) {
    const c = new Creature(1, getSpecies('lumenWrasse'), 0, 0, 1);
    const before = JSON.parse(JSON.stringify(c.mods));
    let granted: string | null = null;
    u.apply(c, (ab: string) => (granted = ab));
    const eff = UPGRADE_EFFECTS[u.id] as any;
    const expect = { ...before };
    for (const [k, v] of Object.entries(eff.mul ?? {})) expect[k] *= v as number;
    for (const [k, v] of Object.entries(eff.add ?? {})) expect[k] += v as number;
    for (const k of Object.keys(expect)) {
      if (Math.abs(expect[k] - (c.mods as any)[k]) > 1e-9) throw new Error(`Upgrade ${u.id}: mirrored effect differs on ${k}`);
    }
    if ((eff.grant ?? null) !== granted) throw new Error(`Upgrade ${u.id}: mirrored grant differs`);
  }

  fs.writeFileSync(path.join(OUT, 'species.json'), toJson({ species, abilities, upgrades, foodLabels: FOOD_LABEL }));

  // ------------------------------------------------------------------ balance / progression
  const balance = {
    balance: BALANCE,
    difficulty: DIFFICULTY,
    world: {
      sectorW: constants.SECTOR_W, sectorH: constants.SECTOR_H, cols: constants.COLS, rows: constants.ROWS,
      regionW: constants.REGION_W, regionH: constants.REGION_H,
    },
    tournamentLadder: prog.TOURNAMENT_LADDER,
    upgradeMilestones: prog.UPGRADE_MILESTONES,
    regionUnlockMilestone: prog.REGION_UNLOCK_MILESTONE,
    regionUnlockStage: prog.REGION_UNLOCK_STAGE,
    challengePools: prog.CHALLENGE_POOLS,
    creator: {
      budget: custom.CREATOR_BUDGET, sizeCost: custom.SIZE_COST, statCost: custom.STAT_COST, abilityCost: custom.ABILITY_COST,
      dietCost: custom.DIET_COST, archetypeCost: custom.ARCHETYPE_COST,
    },
    tutorialSteps: TUTORIAL_STEPS.map((s: any) => ({ id: s.id, title: s.title })),
  };
  fs.writeFileSync(path.join(OUT, 'balance.json'), toJson(balance));

  // ------------------------------------------------------------------ food-web matrix
  // For AI perception sweeps the Roku build looks up species-vs-species results instead of running
  // the full rule check for every neighbour. Rows = attacker, columns = target, nominal sizes.
  // Entry: 0 (cannot eat) or [mode(1 swallow, 2 bite), preference*100, spineDamage*10, mealEnergy*10].
  const n = ALL_SPECIES.length;
  const eat: (number | number[])[][] = [];
  const threat: number[][] = [];
  for (let a = 0; a < n; a++) {
    const A = new Creature(-1, ALL_SPECIES[a], 0, 0, 1);
    const row: (number | number[])[] = [];
    const trow: number[] = [];
    for (let t = 0; t < n; t++) {
      const T = new Creature(-2, ALL_SPECIES[t], 0, 0, 1);
      let entry: number | number[] = 0;
      if (a !== t && ALL_SPECIES[a].diet.length) {
        const chk = feeding.checkFeed(A, T, { ignoreRange: true });
        if (chk.result === 'SWALLOW' || chk.result === 'BITE') {
          const mode = chk.result === 'SWALLOW' ? 1 : 2;
          const energy = feeding.mealEnergy(A, T, chk.result);
          entry = [mode, Math.round((chk.edge?.preference ?? 0.5) * 100), Math.round(chk.spineDamage * 10), Math.round(energy * 10)];
        }
      }
      row.push(entry);
      trow.push(a !== t && feeding.isThreatTo(A, T) ? 1 : 0);
    }
    eat.push(row);
    threat.push(trow);
  }
  fs.writeFileSync(path.join(OUT, 'foodweb.json'), JSON.stringify({ eat, threat }));

  // ------------------------------------------------------------------ regions
  const CELL = 0.25;
  const SDF_STEP = 0.04;
  const NEAR = 1.6;
  const GW = Math.round(constants.REGION_W / CELL) + 1; // 289 (last column repeats the first: x wraps)
  const GH = Math.round(constants.REGION_H / CELL) + 1; // 163
  let maxNear = 0;
  const regionSummaries: Record<string, unknown> = {};
  for (const id of REGION_IDS as string[]) {
    const r = buildRegion(id, 'reefbound');
    const t = r.terrain;
    const shelters = t.shelters.map((s: any) => ({
      id: s.id, kind: s.kind, sector: s.sector, x: round(s.x), y: round(s.y), hw: round(s.hw), hh: round(s.hh),
      clearance: round(s.clearance), concealment: s.concealment, blocksSight: s.blocksSight,
    }));
    if (shelters.length > 250) throw new Error('Too many shelters for a byte id');

    const boxSdf = (s: any, x: number, y: number) => {
      let dx = x - s.x;
      if (dx > 36) dx -= 72;
      else if (dx < -36) dx += 72;
      const qx = Math.abs(dx) - (s.hw - 0.2);
      const qy = Math.abs(y - s.y) - (s.hh - 0.2);
      const ox = Math.max(qx, 0);
      const oy = Math.max(qy, 0);
      return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - 0.2;
    };

    // Layers: [sdf][near1][near2][near3], each GW*GH bytes, row-major from y = 0 upward.
    const LAYERS = 4;
    const bin = Buffer.alloc(GW * GH * LAYERS);
    for (let j = 0; j < GH; j++) {
      const y = j * CELL;
      for (let i = 0; i < GW; i++) {
        const x = (i % (GW - 1)) * CELL;
        const d = t.sdf(x, y);
        const k = j * GW + i;
        bin[k] = Math.max(0, Math.min(255, Math.round(d / SDF_STEP) + 128));
        const near: [number, number][] = [];
        for (const s of t.shelters as any[]) {
          const sd = boxSdf(s, x, y);
          if (sd < NEAR) near.push([sd, s.id]);
        }
        near.sort((p, q) => p[0] - q[0]);
        maxNear = Math.max(maxNear, near.length);
        for (let m = 0; m < 3; m++) bin[GW * GH * (1 + m) + k] = m < near.length ? near[m][1] + 1 : 0;
      }
    }
    fs.writeFileSync(path.join(OUT, `region_${id}.bin`), bin);

    const floor: number[] = [];
    for (let i = 0; i < t.floor.length; i++) floor.push(round(t.floor[i]));

    const sectors = r.sectors.map((s: any, si: number) => {
      const bp = r.blueprint.sectors[si];
      return {
        name: s.name, biome: s.biome, blurb: s.blurb,
        pop: bp.pop.map((p: any) => {
          const o: Record<string, unknown> = { sp: p.species, n: p.count };
          if (p.school) o.school = p.school;
          if (p.band) o.band = p.band;
          if (p.size) o.size = p.size;
          return o;
        }),
        res: Object.entries(bp.res).map(([sp, n]) => ({ sp, n })),
      };
    });

    const region = {
      id: r.id,
      name: r.name,
      grid: { w: GW, h: GH, cell: CELL, step: SDF_STEP, layers: LAYERS },
      sectors,
      shelters,
      stations: r.stations.map((s: any) => ({ id: s.id, sector: s.sector, x: round(s.x), y: round(s.y), kind: s.kind })),
      surfaces: r.surfaces.map((s: any) => ({ id: s.id, sector: s.sector, x0: round(s.x0), x1: round(s.x1), ys: s.ys.map((v: number) => round(v)), kind: s.kind })),
      anchors: r.anchors.map((a: any) => {
        const o: Record<string, unknown> = { k: a.kind, x: round(a.x), y: round(a.y), s: a.sector };
        if (a.shelterId !== undefined) o.sh = a.shelterId;
        return o;
      }),
      fixed: r.fixed.map((f: any) => ({ sp: f.species, x: round(f.x), y: round(f.y), s: f.sector })),
      passes: r.passes.map((p: any) => ({ x: round(p.x), y: round(p.y), sector: p.sector, dest: p.to, requires: p.requires, r: p.r })),
    };
    fs.writeFileSync(path.join(OUT, `region_${id}.json`), toJson(region));

    // Art-pipeline input (not shipped): the solids, props and seabed the scene composer dresses.
    const scene = {
      id: r.id,
      name: r.name,
      sectors: r.sectors,
      rocks: r.rocks.map((k: any) => ({ ...k.solid, style: k.style, sector: k.sector, seed: k.seed })),
      solids: t.solids,
      props: r.props,
      shelters,
      stations: region.stations,
      passes: region.passes,
      fixed: region.fixed,
      anchors: region.anchors,
      surfaces: region.surfaces,
      floor,
      floorRes: 0.5,
    };
    fs.writeFileSync(path.join(TOOLS_OUT, `scene_${id}.json`), JSON.stringify(scene));
    regionSummaries[id] = { shelters: shelters.length, stations: r.stations.length, surfaces: r.surfaces.length, anchors: r.anchors.length, rocks: r.rocks.length, props: r.props.length };
  }

  // Art pipeline also needs the species table and the original fish body plans.
  const fishGeom = await imp('render/fishGeometry.ts').catch(() => null);
  fs.writeFileSync(path.join(TOOLS_OUT, 'species.json'), JSON.stringify(species));
  if (fishGeom?.FISH_SHAPES) fs.writeFileSync(path.join(TOOLS_OUT, 'fish_shapes.json'), JSON.stringify(fishGeom.FISH_SHAPES, null, 1));
  const biomes = await imp('render/biomes.ts');
  fs.writeFileSync(path.join(TOOLS_OUT, 'biomes.json'), JSON.stringify(biomes.BIOMES, null, 1));
  // Water colours and haze for the device's backdrop (sRGB 0..255).
  const rgb = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const devBiomes: Record<string, unknown> = {};
  for (const [id, b] of Object.entries(biomes.BIOMES as Record<string, any>)) {
    devBiomes[id] = {
      day_top: rgb(b.waterTop), day_deep: rgb(b.waterDeep), night_top: rgb(b.nightTop), night_deep: rgb(b.nightDeep),
      haze: rgb(b.deepTint), backwall: b.backWall,
    };
  }
  fs.writeFileSync(path.join(OUT, 'biomes.json'), toJson(devBiomes));

  console.log(`species: ${species.length}  abilities: ${abilities.length}  upgrades: ${upgrades.length}`);
  console.log(`grid: ${GW}x${GH} x4 layers, max shelters near one sample: ${maxNear}`);
  console.log('regions:', JSON.stringify(regionSummaries));
  let edges = 0;
  for (const row of eat) for (const e of row) if (e !== 0) edges++;
  console.log(`food-web edges: ${edges}`);
  if (maxNear > 3) throw new Error(`A sample has ${maxNear} shelters in range; the grid stores only 3.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
