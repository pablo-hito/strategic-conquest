import type { City } from './city.js';
import type { Coord } from '../grid/coords.js';
import type { PlayerId } from '../shared/ids.js';
import type { WorldState } from '../world/world-state.js';

/**
 * Stacking: land units (not aboard a transport) that fit on one tile. Keeps a side
 * that is losing from pouring its whole army into its last cities, which made sieges
 * endless. Ships and aircraft are not limited.
 */
export const STACK_LIMIT_CITY = 4;
export const STACK_LIMIT_FIELD = 2;

export function stackLimitAt(world: WorldState, c: Coord): number {
  return world.cityAt(c) ? STACK_LIMIT_CITY : STACK_LIMIT_FIELD;
}

/** Land units of `player` standing on `c` (cargo aboard transports does not count). */
export function landStackAt(world: WorldState, player: PlayerId, c: Coord): number {
  return world.unitsAt(c).filter((u) => u.owner === player && u.def.domain === 'land' && u.carriedBy === null).length;
}

/** Can one more land unit of `player` end its move on `c`? */
export function hasRoomFor(world: WorldState, player: PlayerId, c: Coord): boolean {
  return landStackAt(world, player, c) < stackLimitAt(world, c);
}

/**
 * Siege: enemy land units or ships on at least half of the tiles around the city, and
 * none of the owner's units outside on any of them. A besieged city produces nothing,
 * repairs nothing and its defenders cannot dig in. Breaking out (or relieving it from
 * outside) ends the siege.
 */
export function isBesieged(world: WorldState, city: City): boolean {
  const owner = city.owner;
  if (owner === null) return false;
  const around = world.grid.neighbors(city.position);
  let enemy = 0;
  for (const n of around) {
    const units = world.unitsAt(n).filter((u) => u.carriedBy === null && u.def.domain !== 'air');
    if (units.some((u) => u.owner === owner)) return false;
    if (units.some((u) => u.owner !== owner)) enemy++;
  }
  return enemy * 2 >= around.length;
}
