import type { Coord } from '../grid/coords.js';
import type { Grid } from '../grid/grid.js';
import type { Terrain } from '../grid/terrain.js';
import type { PlayerId } from '../shared/ids.js';
import type { Unit } from '../units/unit.js';
import type { PlayerFogMap } from '../visibility/fog-of-war.js';
import type { WorldState } from '../world/world-state.js';

export interface KnownCityInfo {
  readonly owner: PlayerId | null;
  readonly isCoastal: boolean;
}

/**
 * What movement rules are allowed to look at. Two implementations:
 *  - truth: the server validating and executing a move against real state;
 *  - fog:   planning (paths, reach overlay, bots) with only what a player knows,
 *           so planning never routes around an enemy the player cannot see.
 */
export interface MapKnowledge {
  readonly grid: Grid;
  /** null = unexplored. */
  terrain(c: Coord): Terrain | null;
  city(c: Coord): KnownCityInfo | null;
  /** Top-level (not carried) units known to be on the tile. */
  units(c: Coord): readonly Unit[];
}

export function truthKnowledge(world: WorldState): MapKnowledge {
  return {
    grid: world.grid,
    terrain: (c) => world.grid.terrainAt(c),
    city: (c) => world.cityAt(c) ?? null,
    units: (c) => world.unitsAt(c).filter((u) => u.carriedBy === null),
  };
}

export function fogKnowledge(world: WorldState, fog: PlayerFogMap): MapKnowledge {
  const { grid } = world;
  return {
    grid,
    terrain: (c) => (fog.isExplored(grid.index(c)) ? grid.terrainAt(c) : null),
    city: (c) => {
      const real = world.cityAt(c);
      if (!real) return null;
      if (real.owner === fog.viewer) return real;
      const known = fog.knownCities.get(real.id);
      return known ? { owner: known.owner, isCoastal: real.isCoastal } : null;
    },
    units: (c) =>
      world.unitsAt(c).filter((u) => u.carriedBy === null && fog.detectedUnits.has(u.id)),
  };
}
