import type { Coord, TileIndex } from '../grid/coords.js';
import { truthKnowledge } from '../movement/map-knowledge.js';
import { isRefuelPoint } from '../movement/step-rules.js';
import type { CityId, PlayerId, UnitId } from '../shared/ids.js';
import type { CombatResult } from '../combat/combat-rules.js';
import type { UnitTypeId } from '../units/unit-types.js';
import type { WorldState } from '../world/world-state.js';
import { hasRoomFor, isBesieged, landStackAt, stackLimitAt } from '../cities/siege.js';
import { UNIT_TYPES } from '../units/unit-types.js';

/**
 * Upkeep: a player can sustain at most ARMY_BASE + ARMY_PER_CITY × cities units.
 * At or above it, cities pause production (progress is kept) until losses or new
 * cities make room. Keeps late-game armies from snowballing into the hundreds.
 */
export const ARMY_BASE = 6;
export const ARMY_PER_CITY = 5;

export function armyCap(world: WorldState, player: PlayerId): number {
  return ARMY_BASE + ARMY_PER_CITY * world.citiesOf(player).length;
}

/**
 * Over the limit (after losing cities) the army can't be fed: each turn a third of
 * the excess deserts, cheapest and most battered units first. A side that shrinks
 * can't keep the army it had when it was big.
 */
export const DESERTION_SHARE = 1 / 3;

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
  /** Production paused this turn because the army is at its upkeep limit. */
  | { type: 'army_at_limit'; audience: PlayerId; units: number; cap: number }
  /** Units lost to desertion because the army is over its upkeep limit. */
  | { type: 'units_deserted'; audience: PlayerId; units: UnitId[]; unitTypes: UnitTypeId[]; over: number }
  /** The city could not produce: besieged, or no room for one more land unit. */
  | { type: 'production_blocked'; audience: PlayerId; city: CityId; reason: 'besieged' | 'city_full' }
  /** Sent to the captor and to the previous owner (an owner always learns it lost a city). */
  | { type: 'city_captured'; audience: PlayerId; city: CityId; by: PlayerId; from: PlayerId | null; aircraftLost?: number }
  | { type: 'player_eliminated'; audience: 'all'; player: PlayerId }
  | { type: 'match_won'; audience: 'all'; player: PlayerId; reason: 'city_share' | 'last_standing' };

/**
 * Start of a player's turn (classic sequential mode), in this order:
 *  1. cities produce, so new units can act right away;
 *  2. units reset movement and dig in if they stayed put;
 *  3. units resting in an own city (or aircraft on a carrier) repair and refuel.
 */
export function beginPlayerTurn(world: WorldState, player: PlayerId, productionBonus = 0): TurnEvent[] {
  const events: TurnEvent[] = [];
  // Difficulty handicap: a bonus of 0.25 grants one extra production tick every 4
  // rounds (deterministic, so replays and saves stay exact).
  const extraTick = productionBonus > 0 && Math.floor(world.turn * productionBonus) > Math.floor((world.turn - 1) * productionBonus);

  const cap = armyCap(world, player);
  desert(world, player, cap, events);
  let units = world.unitsOf(player).length;
  const atLimit = units >= cap;
  if (atLimit && world.citiesOf(player).length > 0) {
    events.push({ type: 'army_at_limit', audience: player, units, cap });
  }

  const besieged = new Set(world.citiesOf(player).filter((c) => isBesieged(world, c)).map((c) => c.id));
  for (const city of world.citiesOf(player)) {
    if (atLimit || units >= cap) {
      city.tickPortTimer();
      continue;
    }
    if (besieged.has(city.id)) {
      city.tickPortTimer();
      events.push({ type: 'production_blocked', audience: player, city: city.id, reason: 'besieged' });
      continue;
    }
    const order = city.production;
    const isLand = !!order && UNIT_TYPES[order.unit].domain === 'land';
    if (isLand && !hasRoomFor(world, player, city.position) && (city.turnsRemaining() ?? 0) <= 1) {
      // Finished but nowhere to put it: wait (progress kept) until the garrison moves out.
      city.tickPortTimer();
      events.push({ type: 'production_blocked', audience: player, city: city.id, reason: 'city_full' });
      continue;
    }
    const produced = [city.tickProduction()];
    // The difficulty's extra tick only when the result still fits (army and city).
    if (extraTick && units + 1 < cap && !(isLand && produced[0] && landRoomLeft(world, player, city.position) <= 1)) {
      produced.push(city.tickProduction(false));
    }
    for (const type of produced) {
      if (!type) continue;
      units++;
      const unit = world.spawnUnit(type, player, city.position);
      events.push({
        type: 'unit_produced',
        audience: player,
        city: city.id,
        unit: unit.id,
        unitType: type,
        at: city.position,
      });
    }
  }

  for (const unit of world.unitsOf(player)) {
    unit.startTurn();
    const city = world.cityAt(unit.position);
    if (city?.owner === player) {
      if (!besieged.has(city.id)) unit.repair(CITY_REPAIR_PER_TURN);
      unit.refuel();
    } else if (unit.carriedBy !== null && unit.def.domain === 'air') {
      unit.repair(CARRIER_REPAIR_PER_TURN);
      unit.refuel();
    }
  }

  return events;
}

function landRoomLeft(world: WorldState, player: PlayerId, c: Coord): number {
  return stackLimitAt(world, c) - landStackAt(world, player, c);
}

function desert(world: WorldState, player: PlayerId, cap: number, events: TurnEvent[]): void {
  const all = world.unitsOf(player);
  const over = all.length - cap;
  if (over <= 0 || world.citiesOf(player).length === 0) return;
  // Never a loaded transport or carrier (its cargo would go down with it).
  const candidates = all
    .filter((u) => u.cargo.length === 0)
    .sort((a, b) => a.def.buildTurns - b.def.buildTurns || a.hp / a.def.maxHp - b.hp / b.def.maxHp);
  const leaving = candidates.slice(0, Math.ceil(over * DESERTION_SHARE));
  if (leaving.length === 0) return;
  for (const u of leaving) world.removeUnit(u.id);
  events.push({ type: 'units_deserted', audience: player, units: leaving.map((u) => u.id), unitTypes: leaving.map((u) => u.type), over });
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
    return world.unitsAt(c).some((u) => u.owner !== player && u.carriedBy === null && u.def.domain !== 'air');
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
