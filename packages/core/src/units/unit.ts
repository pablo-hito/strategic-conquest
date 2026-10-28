import { cloneState } from '../shared/clone.js';
import type { Coord } from '../grid/coords.js';
import { IMPASSABLE } from '../grid/terrain.js';
import type { PlayerId, UnitId } from '../shared/ids.js';
import { err, invariant, ok, type Result } from '../shared/result.js';
import { UNIT_TYPES, type UnitTypeDef, type UnitTypeId } from './unit-types.js';

export const ENTRENCH_STEP = 0.2;
export const ENTRENCH_MAX_LEVEL = 3; // +60%
export const OUT_OF_SUPPLY_GRACE_TURNS = 3;
export const OUT_OF_SUPPLY_PENALTY = 0.25;

/** Plain, serializable state: what is persisted and diffed for WebSocket deltas. */
export interface UnitState {
  readonly id: UnitId;
  readonly type: UnitTypeId;
  readonly owner: PlayerId;
  position: Coord;
  hp: number;
  movesLeft: number;
  /** null for units that do not use fuel. */
  fuel: number | null;
  entrenchment: number;
  movedThisTurn: boolean;
  attackedThisTurn: boolean;
  carriedBy: UnitId | null;
  cargo: UnitId[];
  silentRunning: boolean;
  turnsOutOfSupply: number;
}

export type UnitError =
  | 'IMPASSABLE'
  | 'NO_MOVES_LEFT'
  | 'NOT_STEALTH_CAPABLE'
  | 'CARGO_NOT_ACCEPTED'
  | 'CARGO_FULL'
  | 'NOT_CARRYING'
  | 'ALREADY_CARRIED';

/**
 * Unit aggregate root. Holds rules that only need the unit itself (movement points,
 * fuel, entrenchment, damage, cargo bookkeeping). Rules that need the map or other
 * players (pathing, combat, detection) live in domain services.
 */
export class Unit {
  private constructor(private readonly s: UnitState) {}

  static create(id: UnitId, type: UnitTypeId, owner: PlayerId, position: Coord): Unit {
    const def = UNIT_TYPES[type];
    return new Unit({
      id,
      type,
      owner,
      position: { ...position },
      hp: def.maxHp,
      movesLeft: def.moves,
      fuel: def.fuel ?? null,
      entrenchment: 0,
      movedThisTurn: false,
      attackedThisTurn: false,
      carriedBy: null,
      cargo: [],
      silentRunning: false,
      turnsOutOfSupply: 0,
    });
  }

  static fromSnapshot(s: UnitState): Unit {
    invariant(UNIT_TYPES[s.type] !== undefined, `unknown unit type ${s.type}`);
    return new Unit(cloneState(s));
  }

  toSnapshot(): UnitState {
    return cloneState(this.s);
  }

  get id() { return this.s.id; }
  get type() { return this.s.type; }
  get owner() { return this.s.owner; }
  get position(): Coord { return this.s.position; }
  get hp() { return this.s.hp; }
  get movesLeft() { return this.s.movesLeft; }
  get fuel() { return this.s.fuel; }
  get entrenchment() { return this.s.entrenchment; }
  get carriedBy() { return this.s.carriedBy; }
  get cargo(): readonly UnitId[] { return this.s.cargo; }
  get silentRunning() { return this.s.silentRunning; }
  get turnsOutOfSupply() { return this.s.turnsOutOfSupply; }
  get movedThisTurn() { return this.s.movedThisTurn; }
  get attackedThisTurn() { return this.s.attackedThisTurn; }
  get def(): UnitTypeDef { return UNIT_TYPES[this.s.type]; }

  /** Silent running halves movement (rounded down, never below 1). */
  get maxMoves(): number {
    const base = this.def.moves;
    return this.s.silentRunning ? Math.max(1, Math.floor(base / 2)) : base;
  }

  /** Hidden from normal sight; only adjacency or sonar can reveal it. */
  get isStealthed(): boolean {
    return !!this.def.stealth && this.s.silentRunning;
  }

  get isDestroyed(): boolean {
    return this.s.hp <= 0;
  }

  get isOutOfSupply(): boolean {
    return this.s.turnsOutOfSupply > OUT_OF_SUPPLY_GRACE_TURNS;
  }

  /** Multiplier on defense from entrenchment and supply (terrain is applied by combat). */
  get defenseModifier(): number {
    let m = 1 + this.s.entrenchment * ENTRENCH_STEP;
    if (this.isOutOfSupply) m -= OUT_OF_SUPPLY_PENALTY;
    return m;
  }

  /**
   * Called for every unit of the active player at turn start. A unit that spent the
   * whole previous turn still digs in one more level.
   */
  startTurn(): void {
    const stayedPut = !this.s.movedThisTurn && !this.s.attackedThisTurn && this.s.carriedBy === null;
    if (this.def.canEntrench && stayedPut) {
      this.s.entrenchment = Math.min(ENTRENCH_MAX_LEVEL, this.s.entrenchment + 1);
    }
    this.s.movesLeft = this.maxMoves;
    this.s.movedThisTurn = false;
    this.s.attackedThisTurn = false;
  }

  /**
   * A unit that has not moved yet may always take one step into passable terrain
   * even if it costs more than its MP (otherwise 1-MP infantry could never climb a
   * hill). The step then consumes every remaining point.
   */
  canAfford(cost: number): boolean {
    if (cost === IMPASSABLE || this.s.movesLeft <= 0) return false;
    return cost <= this.s.movesLeft || this.s.movesLeft === this.maxMoves;
  }

  /** Apply one already-validated step (adjacency/terrain checked by MovementService). */
  stepTo(to: Coord, cost: number): Result<void, UnitError> {
    if (cost === IMPASSABLE) return err('IMPASSABLE', 'terrain cannot be entered');
    if (!this.canAfford(cost)) return err('NO_MOVES_LEFT', 'not enough movement points');
    this.s.movesLeft = Math.max(0, this.s.movesLeft - cost);
    this.s.position = { ...to };
    this.s.movedThisTurn = true;
    this.s.entrenchment = 0;
    if (this.s.fuel !== null) this.s.fuel -= 1;
    return ok(undefined);
  }

  /** Actions that end the unit's turn (capture, boarding). */
  exhaustMoves(): void {
    this.s.movesLeft = 0;
  }

  /** Cargo follows its carrier without spending its own movement. */
  syncPositionWithCarrier(to: Coord): void {
    this.s.position = { ...to };
  }

  /** Fuel-bearing units with an empty tank crash unless they are on a base. */
  get isOutOfFuel(): boolean {
    return this.s.fuel !== null && this.s.fuel <= 0;
  }

  /**
   * Aircraft that end the turn in the air spend their unused movement loitering, so a
   * plane can't hover forever by not moving: its range is fuel / moves turns aloft.
   */
  burnLoiterFuel(): void {
    if (this.s.fuel !== null) this.s.fuel = Math.max(0, this.s.fuel - this.s.movesLeft);
    this.s.movesLeft = 0;
  }

  refuel(): void {
    if (this.def.fuel !== undefined) this.s.fuel = this.def.fuel;
  }

  markAttacked(): void {
    this.s.attackedThisTurn = true;
    this.s.entrenchment = 0;
    // Indirect-fire units cannot move after firing.
    if (this.def.indirectFire) this.s.movesLeft = 0;
  }

  /** Returns true if the unit was destroyed. */
  takeDamage(amount: number): boolean {
    invariant(amount >= 0, 'damage must be non-negative');
    this.s.hp = Math.max(0, this.s.hp - amount);
    return this.isDestroyed;
  }

  repair(amount: number): void {
    this.s.hp = Math.min(this.def.maxHp, this.s.hp + amount);
  }

  setSilentRunning(on: boolean): Result<void, UnitError> {
    if (!this.def.stealth) return err('NOT_STEALTH_CAPABLE', `${this.def.name} cannot run silent`);
    this.s.silentRunning = on;
    this.s.movesLeft = Math.min(this.s.movesLeft, this.maxMoves);
    return ok(undefined);
  }

  setSupplied(supplied: boolean): void {
    this.s.turnsOutOfSupply = supplied ? 0 : this.s.turnsOutOfSupply + 1;
  }

  // ─── Cargo (both sides are updated by WorldState.load/unload) ────────────────

  canCarry(other: Unit): Result<void, UnitError> {
    const spec = this.def.cargo;
    if (!spec || !spec.accepts.includes(other.def.domain)) {
      return err('CARGO_NOT_ACCEPTED', `${this.def.name} cannot carry ${other.def.name}`);
    }
    if (other.carriedBy !== null) return err('ALREADY_CARRIED', `${other.def.name} is already aboard`);
    if (this.s.cargo.length >= spec.slots) return err('CARGO_FULL', `${this.def.name} is full`);
    return ok(undefined);
  }

  /** @internal use WorldState.load */
  _addCargo(id: UnitId): void {
    this.s.cargo.push(id);
  }

  /** @internal use WorldState.unload */
  _removeCargo(id: UnitId): boolean {
    const i = this.s.cargo.indexOf(id);
    if (i < 0) return false;
    this.s.cargo.splice(i, 1);
    return true;
  }

  /** @internal use WorldState.load/unload */
  _setCarrier(id: UnitId | null): void {
    this.s.carriedBy = id;
    if (id !== null) this.s.entrenchment = 0;
  }
}
