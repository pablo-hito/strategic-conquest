import type { City } from '../cities/city.js';
import type { Coord, TileIndex } from '../grid/coords.js';
import type { Grid } from '../grid/grid.js';
import type { Unit } from '../units/unit.js';
import type { UnitDomain } from '../units/unit-types.js';
import { hasLineOfSight } from './line-of-sight.js';

const CITY_EYE_HEIGHT = 1; // watchtowers / rooftops

/** Anything that reveals the map for a player: a unit or an owned city. */
export interface VisionSource {
  readonly position: Coord;
  readonly radius: number;
  readonly eyeHeight: number;
  /** null for cities. */
  readonly domain: UnitDomain | null;
  /** Detects stealth units within this radius regardless of LOS (water only). */
  readonly sonarRange: number;
}

export function unitVisionSource(grid: Grid, unit: Unit): VisionSource {
  const def = unit.def;
  const terrainBonus = def.domain === 'land' ? grid.defAt(unit.position).landVisionBonus : 0;
  return {
    position: unit.position,
    radius: def.vision + terrainBonus,
    eyeHeight: def.eyeHeight,
    domain: def.domain,
    sonarRange: def.sonarRange ?? 0,
  };
}

export function cityVisionSource(city: City): VisionSource {
  return {
    position: city.position,
    radius: city.specializationDef.vision,
    eyeHeight: CITY_EYE_HEIGHT,
    domain: null,
    sonarRange: 0,
  };
}

/** Tiles this source can see: inside its radius and with line of sight. */
export function visibleTilesFrom(grid: Grid, src: VisionSource): TileIndex[] {
  const out: TileIndex[] = [];
  for (const c of grid.disc(src.position, src.radius)) {
    if (hasLineOfSight(grid, src.position, src.eyeHeight, c)) out.push(grid.index(c));
  }
  return out;
}
