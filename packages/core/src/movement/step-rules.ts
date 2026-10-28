import type { Coord } from '../grid/coords.js';
import { IMPASSABLE, TERRAIN_DEFS } from '../grid/terrain.js';
import type { UnitId } from '../shared/ids.js';
import { err, ok, type Result } from '../shared/result.js';
import type { Unit } from '../units/unit.js';
import type { MapKnowledge } from './map-knowledge.js';

export type StepKind =
  | 'move'
  /** Land unit steps onto an own transport at sea; ends its movement. */
  | 'board'
  /** Carried land unit steps off its transport onto land. */
  | 'disembark';

export interface StepPlan {
  readonly cost: number;
  readonly kind: StepKind;
  /** Transport being boarded. */
  readonly carrierId?: UnitId;
}

export type StepError =
  | 'OUT_OF_BOUNDS'
  | 'NOT_ADJACENT'
  | 'OUT_OF_FUEL'
  | 'ENEMY_PRESENT'
  | 'CITY_NOT_OWNED'
  | 'IMPASSABLE'
  | 'NO_TRANSPORT_SPACE';

/**
 * Can `unit` take one step from `from` to `to` given what `k` knows? Does not look at
 * movement points: affordability depends on turn state and is checked by the caller.
 *
 * Unexplored tiles are assumed passable at cost 1 (optimistic planning); the server
 * re-validates every step against the truth when executing.
 */
export function checkStep(k: MapKnowledge, unit: Unit, from: Coord, to: Coord): Result<StepPlan, StepError> {
  const { grid } = k;
  if (!grid.inBounds(to)) return err('OUT_OF_BOUNDS', 'destination is off the map');
  if (grid.distance(from, to) !== 1) return err('NOT_ADJACENT', 'steps must be to an adjacent tile');
  if (unit.isOutOfFuel) return err('OUT_OF_FUEL', 'no fuel left');

  const terrain = k.terrain(to);
  if (terrain === null) return ok({ cost: 1, kind: 'move' });
  const tdef = TERRAIN_DEFS[terrain];

  const here = k.units(to);
  if (here.some((u) => u.owner !== unit.owner)) {
    return err('ENEMY_PRESENT', 'tile is occupied by an enemy (attack instead)');
  }

  const city = k.city(to);
  const ownCity = city !== null && city.owner === unit.owner;
  if (city && !ownCity) {
    // Capture is a separate command (only for canCaptureCities units).
    return err('CITY_NOT_OWNED', 'cannot enter a city you do not own');
  }

  const def = unit.def;
  switch (def.domain) {
    case 'air':
      return ok({ cost: tdef.moveCost.air, kind: 'move' });

    case 'sea': {
      // Own coastal city = port: ships can dock in it.
      if (ownCity && city.isCoastal) return ok({ cost: 1, kind: 'move' });
      const cost = tdef.moveCost[def.movementClass];
      return cost === IMPASSABLE ? err('IMPASSABLE', `${def.name} cannot enter ${terrain}`) : ok({ cost, kind: 'move' });
    }

    case 'land': {
      if (tdef.domain === 'water') {
        const transport = here.find(
          (u) => u.id !== unit.carriedBy && u.def.cargo?.accepts.includes('land') && u.cargo.length < u.def.cargo.slots,
        );
        if (!transport) {
          const anyTransport = here.some((u) => u.def.cargo?.accepts.includes('land'));
          return anyTransport
            ? err('NO_TRANSPORT_SPACE', 'transport is full')
            : err('IMPASSABLE', `${def.name} cannot enter water`);
        }
        return ok({ cost: 1, kind: 'board', carrierId: transport.id });
      }
      // Cities have roads.
      const cost = ownCity ? 1 : tdef.moveCost[def.movementClass];
      if (cost === IMPASSABLE) return err('IMPASSABLE', `${def.name} cannot enter ${terrain}`);
      return ok({ cost, kind: unit.carriedBy !== null ? 'disembark' : 'move' });
    }
  }
}

/** Is this an own city or an own carrier with room, where aircraft refuel? */
export function isRefuelPoint(k: MapKnowledge, unit: Unit, at: Coord): boolean {
  const city = k.city(at);
  if (city && city.owner === unit.owner) return true;
  return k
    .units(at)
    .some(
      (u) =>
        u.owner === unit.owner &&
        u.id !== unit.id &&
        !!u.def.cargo?.accepts.includes('air') &&
        (u.cargo.length < u.def.cargo.slots || u.cargo.includes(unit.id)),
    );
}
