import type { Coord, TileIndex } from '../grid/coords.js';
import { Grid } from '../grid/grid.js';
import type { Terrain } from '../grid/terrain.js';
import type { CityId, PlayerId } from '../shared/ids.js';
import { invariant } from '../shared/result.js';
import { Rng } from '../shared/rng.js';
import type { UnitTypeId } from '../units/unit-types.js';
import { WorldState } from '../world/world-state.js';
import { SimplexNoise } from './simplex.js';

export const MAP_SIZES = {
  small: { width: 60, height: 40 },
  medium: { width: 100, height: 64 },
  huge: { width: 160, height: 100 },
} as const;
export type MapSize = keyof typeof MAP_SIZES;

/** Share of the map that is land. */
export const LAND_RATIO = { sparse: 0.22, normal: 0.32, dense: 0.42 } as const;
export type IslandDensity = keyof typeof LAND_RATIO;

export interface MapSettings {
  readonly size: MapSize | { readonly width: number; readonly height: number };
  readonly density: IslandDensity;
  readonly seed: number | string;
  /** Cities per land tile (original game: roughly one per 16-20 land tiles). */
  readonly cityDensity?: number;
  /** Units each player starts with, inside their capital. */
  readonly startingUnits?: readonly UnitTypeId[];
  /** Generation attempts before settling for the fairest map found. */
  readonly maxAttempts?: number;
  /** Stop early once start positions are at least this balanced (0..1). */
  readonly targetBalance?: number;
}

export interface MapReport {
  readonly seed: string;
  readonly attempt: number;
  readonly landRatio: number;
  readonly cities: number;
  readonly islands: number;
  /** Weakest player's expansion potential / strongest's (1 = perfectly even). */
  readonly balance: number;
  readonly minCapitalDistance: number;
}

export interface GeneratedMap {
  readonly world: WorldState;
  readonly capitals: ReadonlyMap<PlayerId, CityId>;
  readonly report: MapReport;
}

/** Typical island diameter in tiles: controls how broken-up the archipelago is. */
const FEATURE_TILES = 11;
/** Ocean border so no landmass touches the map edge. */
const EDGE_MARGIN = 3;
const MIN_ISLAND_TILES = 3;
const MOUNTAIN_SHARE = 0.06;
const HILL_SHARE = 0.12;
const FOREST_MOISTURE = 0.2;
const MIN_CITY_SPACING = 3;
/** How fast a neutral city's value to a player decays with distance (tiles). */
const EXPANSION_FALLOFF = 10;
/** How far (tiles) the refinement step may move a capital. */
const REFINE_RADIUS = 12;

/**
 * Procedural archipelago generator, fully determined by `settings.seed`.
 *
 *  1. fBm simplex height field with an ocean border, thresholded at the exact
 *     percentile that yields the requested land ratio;
 *  2. specks under MIN_ISLAND_TILES sink; highest land becomes mountains/hills,
 *     a second (moisture) field plants forests; water next to land is shallow;
 *  3. cities are scattered greedily by site quality (coast > plains) with a
 *     minimum spacing, mountains excluded;
 *  4. capitals are picked among coastal cities by farthest-point sampling, scored
 *     by how evenly the neutral cities are shared out between players.
 *
 * Whole maps are retried with forked RNG streams until the start is balanced enough;
 * the fairest attempt wins. The same seed always yields the same map.
 */
export function generateMap(settings: MapSettings, players: readonly PlayerId[]): GeneratedMap {
  invariant(players.length >= 2 && players.length <= 6, 'maps are generated for 2 to 6 players');
  const { width, height } = typeof settings.size === 'string' ? MAP_SIZES[settings.size] : settings.size;
  invariant(width >= 20 && height >= 16, 'map too small');
  const seed = String(settings.seed);
  const root = new Rng(seed);
  const maxAttempts = settings.maxAttempts ?? 12;
  const targetBalance = settings.targetBalance ?? 0.8;

  let best: Attempt | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const a = tryGenerate(root.fork(`attempt-${attempt}`), width, height, settings, players.length, attempt);
    if (a && (!best || a.score > best.score)) best = a;
    if (best && best.balance >= targetBalance) break;
  }
  invariant(best, 'could not place capitals: try a denser or larger map');

  return build(best, seed, settings, players);
}

// ─── Attempt ──────────────────────────────────────────────────────────────────

interface Attempt {
  readonly attempt: number;
  readonly grid: Grid;
  readonly cities: Coord[];
  readonly capitals: Coord[];
  readonly islands: number;
  readonly balance: number;
  readonly minCapitalDistance: number;
  readonly score: number;
  readonly names: string[];
}

function tryGenerate(
  rng: Rng,
  width: number,
  height: number,
  settings: MapSettings,
  playerCount: number,
  attempt: number,
): Attempt | null {
  const grid = shapeTerrain(rng, width, height, LAND_RATIO[settings.density]);
  const { labels, sizes } = landmasses(grid);
  const cities = placeCities(rng, grid, settings.cityDensity ?? 1 / 18);
  if (cities.length < playerCount * 2) return null;

  const picked = pickCapitals(rng, grid, cities, labels, playerCount);
  if (!picked) return null;
  return {
    attempt,
    grid,
    cities,
    ...picked,
    islands: sizes.size,
    names: cityNames(rng, cities.length),
  };
}

function shapeTerrain(rng: Rng, width: number, height: number, landRatio: number): Grid {
  const elevNoise = new SimplexNoise(rng.fork('elevation'));
  const moistNoise = new SimplexNoise(rng.fork('moisture'));
  const size = width * height;
  const elev = new Float64Array(size);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let e = elevNoise.fbm(x / FEATURE_TILES, y / FEATURE_TILES, 5);
      const edge = Math.min(x, y, width - 1 - x, height - 1 - y) / EDGE_MARGIN;
      if (edge < 1) e -= (1 - edge) * 2;
      elev[y * width + x] = e;
    }
  }

  const sorted = Float64Array.from(elev).sort();
  const seaLevel = sorted[Math.floor(size * (1 - landRatio))]!;
  const isLand = (i: number) => elev[i]! > seaLevel;

  const grid = Grid.filled(width, height, 'deep_ocean');
  for (let i = 0; i < size; i++) if (isLand(i)) grid.setTerrain(grid.coordOf(i), 'plains');

  // Sink specks.
  const { labels, sizes } = landmasses(grid);
  for (let i = 0; i < size; i++) {
    const l = labels[i]!;
    if (l >= 0 && sizes.get(l)! < MIN_ISLAND_TILES) grid.setTerrain(grid.coordOf(i), 'deep_ocean');
  }

  // Relief from the same height field: the highest land tiles become mountains, then hills.
  const landIdx: TileIndex[] = [];
  for (let i = 0; i < size; i++) if (grid.isLand(grid.coordOf(i))) landIdx.push(i);
  landIdx.sort((a, b) => elev[b]! - elev[a]!);
  const mountains = Math.floor(landIdx.length * MOUNTAIN_SHARE);
  const hills = Math.floor(landIdx.length * HILL_SHARE);
  landIdx.forEach((i, rank) => {
    const c = grid.coordOf(i);
    let t: Terrain = 'plains';
    if (rank < mountains) t = 'mountains';
    else if (rank < mountains + hills) t = 'hills';
    else if (moistNoise.fbm(c.x / 10, c.y / 10, 3) > FOREST_MOISTURE) t = 'forest';
    grid.setTerrain(c, t);
  });

  for (let i = 0; i < size; i++) {
    const c = grid.coordOf(i);
    if (grid.isWater(c) && grid.neighbors(c).some((n) => grid.isLand(n))) grid.setTerrain(c, 'shallow_water');
  }
  return grid;
}

/** Connected land components (8-way). labels[i] = -1 for water. */
function landmasses(grid: Grid): { labels: Int32Array; sizes: Map<number, number> } {
  const labels = new Int32Array(grid.size).fill(-1);
  const sizes = new Map<number, number>();
  let next = 0;
  for (let start = 0; start < grid.size; start++) {
    if (labels[start] !== -1 || !grid.isLand(grid.coordOf(start))) continue;
    const label = next++;
    const stack = [start];
    labels[start] = label;
    let count = 0;
    while (stack.length) {
      const i = stack.pop()!;
      count++;
      for (const n of grid.neighbors(grid.coordOf(i))) {
        const j = grid.index(n);
        if (labels[j] === -1 && grid.isLand(n)) {
          labels[j] = label;
          stack.push(j);
        }
      }
    }
    sizes.set(label, count);
  }
  return { labels, sizes };
}

function placeCities(rng: Rng, grid: Grid, density: number): Coord[] {
  const candidates: { c: Coord; score: number }[] = [];
  let land = 0;
  for (let i = 0; i < grid.size; i++) {
    const c = grid.coordOf(i);
    if (!grid.isLand(c)) continue;
    land++;
    const t = grid.terrainAt(c);
    if (t === 'mountains') continue;
    const score = (grid.isCoastal(c) ? 2 : 0) + (t === 'plains' ? 1 : 0) + rng.next() * 1.5;
    candidates.push({ c, score });
  }
  candidates.sort((a, b) => b.score - a.score);

  const target = Math.max(1, Math.round(land * density));
  const placed: Coord[] = [];
  for (const { c } of candidates) {
    if (placed.length >= target) break;
    if (placed.every((p) => grid.distance(p, c) >= MIN_CITY_SPACING)) placed.push(c);
  }
  return placed;
}

const euclid = (a: Coord, b: Coord) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Farthest-point sampling from several random starts, then local refinement; sets
 * are scored by scoreCapitals. Capitals prefer coastal cities on landmasses with
 * room for at least one more city, so nobody starts stranded on a rock.
 */
function pickCapitals(
  rng: Rng,
  grid: Grid,
  cities: readonly Coord[],
  labels: Int32Array,
  n: number,
): CapitalPick | null {
  const citiesOnMass = new Map<number, number>();
  for (const c of cities) {
    const l = labels[grid.index(c)]!;
    citiesOnMass.set(l, (citiesOnMass.get(l) ?? 0) + 1);
  }
  let pool = cities.filter((c) => grid.isCoastal(c) && citiesOnMass.get(labels[grid.index(c)]!)! >= 2);
  if (pool.length < n) pool = cities.filter((c) => grid.isCoastal(c));
  if (pool.length < n) return null;

  const idealSpread = 0.6 * Math.sqrt((grid.width * grid.height) / n);
  const evaluate = (chosen: Coord[]) => scoreCapitals(chosen, cities, idealSpread);

  let best: CapitalPick | null = null;
  for (let trial = 0; trial < 24; trial++) {
    const chosen = [rng.pick(pool)];
    while (chosen.length < n) {
      let far: Coord | null = null;
      let farD = -1;
      for (const c of pool) {
        const d = Math.min(...chosen.map((k) => euclid(k, c)));
        if (d > farD) [far, farD] = [c, d];
      }
      chosen.push(far!);
    }
    const pick = evaluate(chosen);
    if (!best || pick.score > best.score) best = pick;
  }

  // Farthest-point sampling spreads capitals out but favors corners; nudge each
  // capital to a nearby candidate while that improves the score (hill climbing).
  for (let round = 0; round < 6 && best; round++) {
    let improved = false;
    for (let i = 0; i < n; i++) {
      for (const c of pool) {
        if (best.capitals.includes(c) || euclid(c, best.capitals[i]!) > REFINE_RADIUS) continue;
        const next = [...best.capitals];
        next[i] = c;
        const pick = evaluate(next);
        if (pick.score > best.score + 1e-9) {
          best = pick;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return best;
}

interface CapitalPick {
  readonly capitals: Coord[];
  readonly balance: number;
  readonly minCapitalDistance: number;
  readonly score: number;
}

/**
 * Expansion balance: every other city counts for its nearest capital, weighted by
 * exp(-distance / EXPANSION_FALLOFF); balance = weakest / strongest. The score also
 * penalizes capitals closer than `idealSpread` to each other.
 */
function scoreCapitals(chosen: Coord[], cities: readonly Coord[], idealSpread: number): CapitalPick {
  const n = chosen.length;
  let minD = Infinity;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) minD = Math.min(minD, euclid(chosen[i]!, chosen[j]!));

  const potential = new Array<number>(n).fill(0);
  for (const c of cities) {
    if (chosen.includes(c)) continue;
    const ds = chosen.map((k) => euclid(k, c));
    const nearest = Math.min(...ds);
    const owners = ds.flatMap((d, i) => (d === nearest ? [i] : []));
    for (const i of owners) potential[i]! += Math.exp(-nearest / EXPANSION_FALLOFF) / owners.length;
  }
  const balance = Math.max(...potential) > 0 ? Math.min(...potential) / Math.max(...potential) : 0;
  return { capitals: chosen, balance, minCapitalDistance: minD, score: balance * Math.min(1, minD / idealSpread) };
}

// ─── Assembly ─────────────────────────────────────────────────────────────────

function build(a: Attempt, seed: string, settings: MapSettings, players: readonly PlayerId[]): GeneratedMap {
  const world = new WorldState(a.grid);
  const capitals = new Map<PlayerId, CityId>();
  const startingUnits = settings.startingUnits ?? ['infantry'];

  a.cities.forEach((c, i) => {
    const city = world.foundCity(a.names[i]!, c);
    const p = a.capitals.findIndex((k) => k.x === c.x && k.y === c.y);
    if (p < 0) return;
    const player = players[p]!;
    city.capture(player);
    capitals.set(player, city.id);
    for (const u of startingUnits) world.spawnUnit(u, player, c);
  });

  let land = 0;
  for (let i = 0; i < a.grid.size; i++) if (a.grid.isLand(a.grid.coordOf(i))) land++;

  return {
    world,
    capitals,
    report: {
      seed,
      attempt: a.attempt,
      landRatio: land / a.grid.size,
      cities: a.cities.length,
      islands: a.islands,
      balance: a.balance,
      minCapitalDistance: a.minCapitalDistance,
    },
  };
}

const SYLLABLES = ['al', 'ba', 'cor', 'den', 'el', 'fa', 'gor', 'ha', 'is', 'ka', 'lor', 'ma', 'nor', 'os', 'pra', 'qua', 'ra', 'sel', 'tor', 'ul', 'va', 'wen', 'xa', 'yor', 'zan'];

function cityNames(rng: Rng, count: number): string[] {
  const names = new Set<string>();
  while (names.size < count) {
    const parts = rng.int(2, 3);
    let n = '';
    for (let i = 0; i < parts; i++) n += rng.pick(SYLLABLES);
    names.add(n[0]!.toUpperCase() + n.slice(1));
  }
  return [...names];
}
