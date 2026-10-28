import type { Coord } from '../grid/coords.js';
import type { CityId, PlayerId, UnitId } from '../shared/ids.js';
import { err, ok, type Result } from '../shared/result.js';
import type { Rng } from '../shared/rng.js';
import type { Unit } from '../units/unit.js';
import { UNIT_TYPES, type TargetClass, type UnitTypeId } from '../units/unit-types.js';
import type { PlayerFogMap } from '../visibility/fog-of-war.js';
import type { WorldState } from '../world/world-state.js';

/**
 * Attack effectiveness: multiplier on the attacker's attack value per target class.
 * 0 = this weapon cannot engage that kind of target at all.
 * This is the "advanced rock-paper-scissors" of the design doc in one table.
 */
type Row = Readonly<Record<TargetClass, number>>;
const row = (soft: number, armored: number, air: number, naval_light: number, naval_heavy: number, submarine: number): Row =>
  ({ soft, armored, air, naval_light, naval_heavy, submarine });

export const EFFECTIVENESS: Readonly<Record<UnitTypeId, Row>> = {
  //                          soft armor  air  nLight nHeavy  sub
  recon:            row(0.8, 0.3, 0,   0,   0,   0),
  infantry:         row(1.0, 0.5, 0,   0,   0,   0),
  mech_infantry:    row(1.1, 0.8, 0.2, 0,   0,   0),
  heavy_tank:       row(1.2, 1.2, 0,   0.3, 0.2, 0),
  artillery:        row(1.3, 1.0, 0,   0.8, 0.6, 0),
  anti_air:         row(0.6, 0.3, 2.0, 0,   0,   0),
  corvette:         row(0.5, 0.3, 0.3, 1.0, 0.5, 0.6),
  destroyer:        row(0.6, 0.5, 0.6, 1.2, 0.8, 1.5),
  missile_cruiser:  row(1.0, 0.8, 1.5, 1.1, 1.0, 0.5),
  submarine:        row(0,   0,   0,   1.2, 2.5, 0.5),
  battleship:       row(1.3, 1.1, 0.4, 1.2, 1.2, 0),
  carrier:          row(0,   0,   0.3, 0.2, 0.1, 0),
  transport:        row(0,   0,   0,   0,   0,   0),
  recon_drone:      row(0,   0,   0,   0,   0,   0),
  fighter:          row(0.3, 0.2, 1.6, 0.3, 0.2, 0),
  cas:              row(1.4, 1.5, 0.2, 0.6, 0.5, 0),
  strategic_bomber: row(1.0, 0.8, 0,   0.8, 1.0, 0),
  awacs:            row(0,   0,   0,   0,   0,   0),
};

/** Damage dealt when attack and defense strengths are equal. */
export const BASE_DAMAGE = 4;
/** Damage scale for anti-air interception (a snap shot, weaker than a full attack). */
export const INTERCEPT_DAMAGE = 3;
/**
 * Damage grows sub-linearly with the attack/defense ratio, so a superior unit wins
 * clearly without one-shotting everything: 2x the strength = 1.5x the damage.
 */
export const RATIO_EXPONENT = 0.6;

const damage = (base: number, attack: number, defense: number) =>
  attack <= 0 ? 0 : base * Math.pow(attack / defense, RATIO_EXPONENT);
/** Random spread applied to every damage roll (±15%). */
export const DAMAGE_SPREAD = 0.15;
/** Land units fighting from one of their own cities. */
export const CITY_DEFENSE_BONUS = 0.25;
/** Attacking straight off a transport (amphibious assault). */
export const AMPHIBIOUS_PENALTY = 0.25;

export type AttackError =
  | 'UNKNOWN_UNIT'
  | 'NOT_YOUR_UNIT'
  | 'NO_WEAPONS'
  | 'ALREADY_ATTACKED'
  | 'NO_MOVES_LEFT'
  | 'MOVED_BEFORE_FIRING'
  | 'OUT_OF_RANGE'
  | 'NO_TARGET'
  | 'CANNOT_ENGAGE'
  | 'CARRIED';

export interface AttackPlan {
  readonly attacker: Unit;
  /** null when a bomber strikes an empty enemy city. */
  readonly defender: Unit | null;
  readonly target: Coord;
  readonly distance: number;
  /** City struck by a strategic bomber, if any. */
  readonly bombCity: CityId | null;
}

export interface Forecast {
  /** Expected damage to the defender (before the ±spread roll). */
  readonly damageToDefender: number;
  /** Expected counter-fire damage, 0 if the defender cannot shoot back. */
  readonly damageToAttacker: number;
  readonly defenderCanCounter: boolean;
  /** Expected flak damage from enemy air defenses covering the target. */
  readonly interceptionDamage: number;
}

/** Strength scales with remaining health, but a damaged unit keeps half its punch. */
const healthFactor = (u: Unit) => 0.5 + 0.5 * (u.hp / u.def.maxHp);

function defenseStrength(world: WorldState, u: Unit): number {
  const def = u.def;
  let m = u.defenseModifier;
  if (def.domain === 'land' && u.carriedBy === null) {
    m += world.grid.defAt(u.position).defenseBonus[def.movementClass] ?? 0;
    if (world.cityAt(u.position)?.owner === u.owner) m += CITY_DEFENSE_BONUS;
  }
  return Math.max(0.5, def.defense) * m * healthFactor(u);
}

function attackStrength(attacker: Unit, targetClass: TargetClass): number {
  let s = attacker.def.attack * EFFECTIVENESS[attacker.type][targetClass] * healthFactor(attacker);
  if (attacker.carriedBy !== null) s *= 1 - AMPHIBIOUS_PENALTY;
  return s;
}

const inRange = (u: Unit, d: number) => {
  const r = u.def.attackRange ?? { min: 1, max: 1 };
  return d >= r.min && d <= r.max;
};

/**
 * Validate an attack and choose the defender: the unit on the target tile that
 * holds best against this particular attacker (as in the original, the strongest
 * defender meets the assault). Only units the attacker's side has detected count:
 * nobody can shoot at what they cannot see.
 */
export function planAttack(
  world: WorldState,
  fog: PlayerFogMap,
  player: PlayerId,
  attackerId: UnitId,
  target: Coord,
): Result<AttackPlan, AttackError> {
  const attacker = world.unit(attackerId);
  if (!attacker) return err('UNKNOWN_UNIT', `no unit ${attackerId}`);
  if (attacker.owner !== player) return err('NOT_YOUR_UNIT', 'you can only command your own units');
  const def = attacker.def;
  if (def.attack <= 0) return err('NO_WEAPONS', `${def.name} is unarmed`);
  if (attacker.attackedThisTurn) return err('ALREADY_ATTACKED', 'this unit already attacked this turn');
  if (attacker.movesLeft <= 0) return err('NO_MOVES_LEFT', 'no movement points left to attack');
  if (def.indirectFire && attacker.movedThisTurn) {
    return err('MOVED_BEFORE_FIRING', `${def.name} cannot move and fire in the same turn`);
  }
  if (attacker.carriedBy !== null && def.domain !== 'land') return err('CARRIED', 'launch the unit first');
  if (!world.grid.inBounds(target)) return err('OUT_OF_RANGE', 'target is off the map');

  const distance = world.grid.distance(attacker.position, target);
  if (!inRange(attacker, distance)) return err('OUT_OF_RANGE', `target is ${distance} tiles away`);

  const enemies = world
    .unitsAt(target)
    .filter((u) => u.owner !== player && u.carriedBy === null && fog.detectedUnits.has(u.id));
  const city = world.cityAt(target);
  const bombCity = def.id === 'strategic_bomber' && city && city.owner !== null && city.owner !== player ? city.id : null;

  if (enemies.length === 0) {
    if (bombCity) return ok({ attacker, defender: null, target, distance, bombCity });
    return err('NO_TARGET', 'no known enemy on that tile');
  }
  const engageable = enemies.filter((u) => EFFECTIVENESS[attacker.type][u.def.targetClass] > 0);
  if (engageable.length === 0) return err('CANNOT_ENGAGE', `${def.name} cannot engage those units`);

  const ratio = (u: Unit) => defenseStrength(world, u) / Math.max(0.01, attackStrength(attacker, u.def.targetClass));
  const defender = engageable.reduce((best, u) => (ratio(u) > ratio(best) ? u : best));
  return ok({ attacker, defender, target, distance, bombCity });
}

/** Enemy air-defense units that can fire on an aircraft attacking `target`. */
function interceptors(world: WorldState, attacker: Unit, target: Coord): Unit[] {
  if (attacker.def.domain !== 'air') return [];
  return [...world.allUnits()].filter(
    (u) =>
      u.owner !== attacker.owner &&
      u.carriedBy === null &&
      (u.def.airInterceptRange ?? 0) > 0 &&
      world.grid.distance(u.position, target) <= u.def.airInterceptRange!,
  );
}

/** Expected outcome, shown to the player before committing. Pure: no dice rolled. */
export function forecastAttack(world: WorldState, plan: AttackPlan): Forecast {
  const { attacker, defender, distance } = plan;
  const flak = interceptors(world, attacker, plan.target).reduce(
    (sum, aa) => sum + damage(INTERCEPT_DAMAGE, attackStrength(aa, 'air'), defenseStrength(world, attacker)),
    0,
  );
  if (!defender) return { damageToDefender: 0, damageToAttacker: 0, defenderCanCounter: false, interceptionDamage: flak };

  const dmg = damage(BASE_DAMAGE, attackStrength(attacker, defender.def.targetClass), defenseStrength(world, defender));
  // Aircraft only dogfight back against other aircraft; they don't strafe the AA
  // battery or ship that is shooting at them.
  const canCounter =
    (defender.def.domain !== 'air' || attacker.def.domain === 'air') &&
    defender.def.attack > 0 &&
    EFFECTIVENESS[defender.type][attacker.def.targetClass] > 0 &&
    inRange(defender, distance) &&
    !defender.def.indirectFire;
  let counter = 0;
  if (canCounter) {
    // The defender shoots back with whatever health it has left.
    const hpAfter = Math.max(0, defender.hp - dmg);
    const factorNow = healthFactor(defender);
    const factorAfter = 0.5 + 0.5 * (hpAfter / defender.def.maxHp);
    if (hpAfter > 0) {
      counter = damage(
        BASE_DAMAGE,
        attackStrength(defender, attacker.def.targetClass) * (factorAfter / factorNow),
        defenseStrength(world, attacker),
      );
    }
  }
  return { damageToDefender: dmg, damageToAttacker: counter, defenderCanCounter: canCounter, interceptionDamage: flak };
}

export interface CombatResult {
  readonly attacker: UnitId;
  readonly attackerType: UnitTypeId;
  readonly defender: UnitId | null;
  readonly defenderType: UnitTypeId | null;
  readonly defenderOwner: PlayerId | null;
  readonly target: Coord;
  readonly damageToDefender: number;
  readonly damageToAttacker: number;
  readonly interceptionDamage: number;
  readonly defenderDestroyed: boolean;
  readonly attackerDestroyed: boolean;
  /** Everything removed from the board, cargo included. */
  readonly lost: UnitId[];
  readonly cityBombed: CityId | null;
}

const roll = (rng: Rng, expected: number) =>
  Math.max(0, Math.round(expected * (1 - DAMAGE_SPREAD + rng.next() * 2 * DAMAGE_SPREAD)));

/**
 * Resolve a validated attack: flak first (an aircraft shot down never reaches the
 * target), then the strike, then counter-fire from the surviving defender.
 */
export function resolveAttack(world: WorldState, plan: AttackPlan, rng: Rng): CombatResult {
  const { attacker, defender } = plan;
  const lost: UnitId[] = [];
  const attackerType = attacker.type;

  let interception = 0;
  for (const aa of interceptors(world, attacker, plan.target)) {
    const d = roll(rng, damage(INTERCEPT_DAMAGE, attackStrength(aa, 'air'), defenseStrength(world, attacker)));
    interception += d;
    if (attacker.takeDamage(d)) break;
  }
  if (attacker.isDestroyed) {
    lost.push(...world.removeUnit(attacker.id));
    return {
      attacker: attacker.id, attackerType, defender: defender?.id ?? null, defenderType: defender?.type ?? null,
      defenderOwner: defender?.owner ?? null, target: plan.target, damageToDefender: 0, damageToAttacker: 0,
      interceptionDamage: interception, defenderDestroyed: false, attackerDestroyed: true, lost, cityBombed: null,
    };
  }

  const forecast = forecastAttack(world, plan);
  let toDefender = 0;
  let toAttacker = 0;
  let defenderDestroyed = false;
  if (defender) {
    toDefender = roll(rng, forecast.damageToDefender);
    defenderDestroyed = defender.takeDamage(toDefender);
    if (!defenderDestroyed && forecast.defenderCanCounter) {
      // Recompute with the defender's actual remaining health.
      const live = forecastAttack(world, { ...plan, attacker: defender, defender: attacker });
      toAttacker = roll(rng, live.damageToDefender);
      attacker.takeDamage(toAttacker);
    }
  }

  let cityBombed: CityId | null = null;
  if (plan.bombCity) {
    world.city(plan.bombCity)!.applyStrategicBombing();
    cityBombed = plan.bombCity;
  }

  attacker.markAttacked();
  attacker.spendForAttack();
  if (attacker.silentRunning) attacker.setSilentRunning(false); // firing gives the sub away

  const defenderOwner = defender?.owner ?? null;
  if (defender && defenderDestroyed) lost.push(...world.removeUnit(defender.id));
  const attackerDestroyed = attacker.isDestroyed;
  if (attackerDestroyed) lost.push(...world.removeUnit(attacker.id));

  return {
    attacker: attacker.id, attackerType, defender: defender?.id ?? null, defenderType: defender?.type ?? null,
    defenderOwner, target: plan.target, damageToDefender: toDefender, damageToAttacker: toAttacker,
    interceptionDamage: interception, defenderDestroyed, attackerDestroyed, lost, cityBombed,
  };
}

export const canEverAttack = (type: UnitTypeId) => UNIT_TYPES[type].attack > 0;
