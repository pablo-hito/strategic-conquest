import type { CityState } from '../cities/city.js';
import type { Coord } from '../grid/coords.js';
import { TERRAINS } from '../grid/terrain.js';
import type { PlayerId, UnitId } from '../shared/ids.js';
import type { UnitState } from '../units/unit.js';
import type { UnitTypeId } from '../units/unit-types.js';
import type { WorldState } from '../world/world-state.js';
import type { KnownCity, PlayerFogMap, UnitSighting } from './fog-of-war.js';

export const UNKNOWN_TERRAIN = 255;

/** What an enemy unit looks like from the outside: no cargo, fuel or orders. */
export interface ForeignUnitView {
  readonly id: UnitId;
  readonly type: UnitTypeId;
  readonly owner: PlayerId;
  readonly position: Coord;
  readonly hp: number;
}

/**
 * The only world representation that ever leaves the server for a given player.
 * Built from authoritative state filtered through the player's fog map.
 */
export interface PlayerView {
  readonly viewer: PlayerId;
  readonly turn: number;
  readonly width: number;
  readonly height: number;
  /** Terrain code per tile (index into TERRAINS) or UNKNOWN_TERRAIN if unexplored. */
  readonly terrain: number[];
  /** TileVisibility per tile. */
  readonly visibility: number[];
  readonly ownUnits: UnitState[];
  readonly foreignUnits: ForeignUnitView[];
  readonly ghosts: UnitSighting[];
  readonly ownCities: CityState[];
  /** Everything else known, with the owner as last seen. */
  readonly knownCities: KnownCity[];
}

export function buildPlayerView(world: WorldState, fog: PlayerFogMap): PlayerView {
  const { grid } = world;
  const terrain = new Array<number>(grid.size);
  for (let i = 0; i < grid.size; i++) {
    terrain[i] = fog.isExplored(i) ? TERRAINS.indexOf(grid.terrainAt(grid.coordOf(i))) : UNKNOWN_TERRAIN;
  }

  const ownUnits: UnitState[] = [];
  const foreignUnits: ForeignUnitView[] = [];
  for (const id of fog.detectedUnits) {
    const u = world.unit(id);
    if (!u) continue;
    if (u.owner === fog.viewer) ownUnits.push(u.toSnapshot());
    else foreignUnits.push({ id: u.id, type: u.type, owner: u.owner, position: u.position, hp: u.hp });
  }

  const ownCities = world.citiesOf(fog.viewer).map((c) => c.toSnapshot());
  const knownCities = [...fog.knownCities.values()].filter((k) => world.city(k.id)?.owner !== fog.viewer);

  return {
    viewer: fog.viewer,
    turn: world.turn,
    width: grid.width,
    height: grid.height,
    terrain,
    visibility: Array.from(fog.state),
    ownUnits,
    foreignUnits,
    ghosts: [...fog.sightings.values()].filter((g) => !fog.detectedUnits.has(g.id)),
    ownCities,
    knownCities,
  };
}
