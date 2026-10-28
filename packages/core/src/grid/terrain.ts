/**
 * How a unit moves. Terrain costs are keyed by movement class rather than by unit
 * type, so adding a unit never requires editing the terrain table.
 */
export const MOVEMENT_CLASSES = [
  'foot', // infantry: slow but goes almost everywhere on land
  'wheeled', // recon, AA: fast on open ground, poor off-road
  'tracked', // tanks, mech infantry, artillery
  'naval', // light hulls: corvette, destroyer, sub, transport
  'naval_heavy', // capital ships: penalized in shallow water
  'air',
] as const;
export type MovementClass = (typeof MOVEMENT_CLASSES)[number];

export const TERRAINS = [
  'deep_ocean',
  'shallow_water',
  'plains',
  'forest',
  'hills',
  'mountains',
] as const;
export type Terrain = (typeof TERRAINS)[number];

export type SurfaceDomain = 'land' | 'water';

/** Movement cost that means "cannot enter". */
export const IMPASSABLE = Number.POSITIVE_INFINITY;

export interface TerrainDef {
  readonly id: Terrain;
  readonly domain: SurfaceDomain;
  /** Ground height, used by line of sight (0 = sea level). */
  readonly elevation: number;
  /**
   * Extra height that blocks sight through the tile but not from it (tree canopy).
   * Obstruction height = elevation + canopy.
   */
  readonly canopy: number;
  /** Vision range bonus for land units standing here (hills +1, mountains +2). */
  readonly landVisionBonus: number;
  /** Land units in this tile are only seen by aircraft that are adjacent. */
  readonly concealsFromAir: boolean;
  /** Defensive multiplier bonus per movement class (0.3 = +30%). */
  readonly defenseBonus: Readonly<Partial<Record<MovementClass, number>>>;
  readonly moveCost: Readonly<Record<MovementClass, number>>;
  /** Single character used by the ASCII map parser and debug renderers. */
  readonly glyph: string;
}

const X = IMPASSABLE;

export const TERRAIN_DEFS: Readonly<Record<Terrain, TerrainDef>> = {
  deep_ocean: {
    id: 'deep_ocean',
    domain: 'water',
    elevation: 0,
    canopy: 0,
    landVisionBonus: 0,
    concealsFromAir: false,
    defenseBonus: {},
    moveCost: { foot: X, wheeled: X, tracked: X, naval: 1, naval_heavy: 1, air: 1 },
    glyph: '~',
  },
  shallow_water: {
    id: 'shallow_water',
    domain: 'water',
    elevation: 0,
    canopy: 0,
    landVisionBonus: 0,
    concealsFromAir: false,
    defenseBonus: {},
    // Capital ships maneuver poorly near the coast.
    moveCost: { foot: X, wheeled: X, tracked: X, naval: 1, naval_heavy: 2, air: 1 },
    glyph: '-',
  },
  plains: {
    id: 'plains',
    domain: 'land',
    elevation: 0,
    canopy: 0,
    landVisionBonus: 0,
    concealsFromAir: false,
    defenseBonus: {},
    moveCost: { foot: 1, wheeled: 1, tracked: 1, naval: X, naval_heavy: X, air: 1 },
    glyph: '.',
  },
  forest: {
    id: 'forest',
    domain: 'land',
    elevation: 0,
    canopy: 1,
    landVisionBonus: 0,
    concealsFromAir: true,
    defenseBonus: { foot: 0.3 },
    moveCost: { foot: 1, wheeled: 3, tracked: 2, naval: X, naval_heavy: X, air: 1 },
    glyph: 'f',
  },
  hills: {
    id: 'hills',
    domain: 'land',
    elevation: 1,
    canopy: 0,
    landVisionBonus: 1,
    concealsFromAir: false,
    defenseBonus: { foot: 0.25, tracked: 0.1, wheeled: 0.1 },
    moveCost: { foot: 2, wheeled: 3, tracked: 2, naval: X, naval_heavy: X, air: 1 },
    glyph: 'h',
  },
  mountains: {
    id: 'mountains',
    domain: 'land',
    elevation: 2,
    canopy: 0,
    landVisionBonus: 2,
    concealsFromAir: false,
    defenseBonus: { foot: 0.5 },
    // Vehicles cannot cross; infantry can, slowly.
    moveCost: { foot: 3, wheeled: X, tracked: X, naval: X, naval_heavy: X, air: 1 },
    glyph: 'M',
  },
};

export const TERRAIN_BY_GLYPH: ReadonlyMap<string, Terrain> = new Map(
  TERRAINS.map((t) => [TERRAIN_DEFS[t].glyph, t]),
);
