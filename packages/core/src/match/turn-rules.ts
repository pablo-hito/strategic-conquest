import type { Coord, TileIndex } from '../grid/coords.js';
import { truthKnowledge } from '../movement/map-knowledge.js';
import { isRefuelPoint } from '../movement/step-rules.js';
import type { CityId, PlayerId, UnitId } from '../shared/ids.js';
import type { CombatResult } from '../combat/combat-rules.js';
import type { UnitTypeId } from '../units/unit-types.js';
import type { WorldState } from '../world/world-state.js';

/** HP restored per turn to units resting in an own city. */
export const CITY_REPAIR_PER_TURN = 2;
/** HP restored per turn to aircraft parked aboard an own carrier. */
export const CARRIER_REPAIR_PER_TURN = 1;

/**
 * Something that happened during turn processing. `audience` says who may be told:
 * the server must not forward a player's private events to opponents.
 */
export type TurnEvent =
  | { type: 'unit_produced'; audience: PlayerId; city: CityId; unit: UnitId; unitType: UnitTypeId; at: Coord }
  | { type: 'aircraft_crashed'; audience: PlayerId; unit: UnitId; unitType: UnitTypeId; at: Coord }
  | { type: 'aircraft_landed'; audience: PlayerId; unit: UnitId; carrier: UnitId }
  | { type: 'out_of_supply'; audience: PlayerId; unit: UnitId; turns: number }
  /** Sent to both sides of a fight: the defender always learns it was hit and by what. */
  | { type: 'combat'; audience: PlayerId; result: CombatResult }
  /** Sent to the captor and to the previous owner (an owner always learns it lost a city). */
  | { type: 'city_captured'; audience: PlayerId; city: CityId; by: PlayerId; from: PlayerId | null }
  | { type: 'player_eliminated'; audience: 'all'; player: PlayerId }
  | { type: 'match_won'; audience: 'all'; player: PlayerId; reason: 'city_share' | 'last_standing' };

/**
 * Start of a player's turn (classic sequential mode), in this order:
 *  1. cities produce, so new units can act right away;
 *  2. units reset movement and dig in if they stayed put;
 *  3. units resting in an own city (or aircraft on a carrier) repair and refuel.
 */
export function beginPlayerTurn(world: WorldState, player: PlayerId): TurnEvent[] {
  const events: TurnEvent[] = [];

  for (const city of world.citiesOf(player)) {
    const produced = city.tickProduction();
    if (!produced) continue;
    const unit = world.spawnUnit(produced, player, city.position);
    events.push({
      type: 'unit_produced',
      audience: player,
      city: city.id,
      unit: unit.id,
      unitType: produced,
      at: city.position,
    });
  }

  for (const unit of world.unitsOf(player)) {
    unit.startTurn();
    const city = world.cityAt(unit.position);
    if (city?.owner === player) {
      unit.repair(CITY_REPAIR_PER_TURN);
      unit.refuel();
    } else if (unit.carriedBy !== null && unit.def.domain === 'air') {
      unit.repair(CARRIER_REPAIR_PER_TURN);
      unit.refuel();
    }
  }

  return events;
}

/**
 * End of a player's turn:
 *  1. aircraft over an own carrier with room land on it (become cargo, refueled);
 *  2. aircraft still airborne burn their unused moves; at 0 fuel they crash;
 *  3. land units update their out-of-supply counter.
 */
export function endPlayerTurn(world: WorldState, player: PlayerId): TurnEvent[] {
  const events: TurnEvent[] = [];
  const truth = truthKnowledge(world);

  for (const unit of world.unitsOf(player)) {
    if (unit.def.domain !== 'air' || unit.carriedBy !== null) continue;
    const city = world.cityAt(unit.position);
    if (city?.owner === player) continue;

    const carrier = world
      .unitsAt(unit.position)
      .find((c) => c.owner === player && c.def.cargo?.accepts.includes('air') && c.canCarry(unit).ok);
    if (carrier) {
      world.load(carrier.id, unit.id);
      unit.refuel();
      events.push({ type: 'aircraft_landed', audience: player, unit: unit.id, carrier: carrier.id });
      continue;
    }

    unit.burnLoiterFuel();
    if (unit.isOutOfFuel && !isRefuelPoint(truth, unit, unit.position)) {
      events.push({
        type: 'aircraft_crashed',
        audience: player,
        unit: unit.id,
        unitType: unit.type,
        at: unit.position,
      });
      world.removeUnit(unit.id);
    }
  }

  const supplied = suppliedLand(world, player);
  for (const unit of world.unitsOf(player)) {
    if (unit.def.domain !== 'land') continue;
    const inSupply = unit.carriedBy !== null || supplied.has(world.grid.index(unit.position));
    unit.setSupplied(inSupply);
    // Reported every turn while cut off, so the player is warned during the grace period.
    if (!inSupply) {
      events.push({ type: 'out_of_supply', audience: player, unit: unit.id, turns: unit.turnsOutOfSupply });
    }
  }

  return events;
}

/**
 * Land tiles connected to one of the player's cities by an overland path that does
 * not cross enemy units or foreign cities. A unit there is "in supply".
 * Units aboard transports are supplied by sea and handled by the caller.
 */
export function suppliedLand(world: WorldState, player: PlayerId): Set<TileIndex> {
  const { grid } = world;
  const seen = new Set<TileIndex>();
  const queue: Coord[] = [];
  for (const city of world.citiesOf(player)) {
    seen.add(grid.index(city.position));
    queue.push(city.position);
  }
  const blocked = (c: Coord) => {
    const city = world.cityAt(c);
    if (city && city.owner !== player) return true;
    return world.unitsAt(c).some((u) => u.owner !== player && u.carriedBy === null);
  };
  for (let head = 0; head < queue.length; head++) {
    for (const n of grid.neighbors(queue[head]!)) {
      const i = grid.index(n);
      if (seen.has(i) || !grid.isLand(n) || blocked(n)) continue;
      seen.add(i);
      queue.push(n);
    }
  }
  return seen;
}
