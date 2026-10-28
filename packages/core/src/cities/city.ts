import { cloneState } from '../shared/clone.js';
import type { Coord } from '../grid/coords.js';
import type { CityId, PlayerId } from '../shared/ids.js';
import { err, ok, type Result } from '../shared/result.js';
import { UNIT_TYPES, type UnitTypeId } from '../units/unit-types.js';
import { SPECIALIZATIONS, type CitySpecialization, type SpecializationDef } from './specialization.js';

export const PORT_DISABLED_TURNS_ON_BOMBING = 2;
/** Unit a freshly captured city starts building, as in the original game. */
export const DEFAULT_PRODUCTION: UnitTypeId = 'infantry';

export interface ProductionOrder {
  unit: UnitTypeId;
  /** Turns already invested. */
  progress: number;
}

export interface CityState {
  readonly id: CityId;
  readonly name: string;
  readonly position: Coord;
  /** Fixed at map generation: a land tile touching water. */
  readonly isCoastal: boolean;
  owner: PlayerId | null;
  specialization: CitySpecialization;
  production: ProductionOrder | null;
  /** While > 0 the port cannot launch ships (strategic bombing). */
  portDisabledTurns: number;
}

export type CityError =
  | 'NEUTRAL_CITY'
  | 'REQUIRES_COAST'
  | 'REQUIRES_SPECIALIZATION'
  | 'ALREADY_SPECIALIZED';

/**
 * City aggregate. There is no currency: a city invests one "turn" per game turn into
 * its current order, and the unit appears when progress reaches its build time.
 * Production repeats the same unit until the owner changes it.
 */
export class City {
  private constructor(private readonly s: CityState) {}

  static create(id: CityId, name: string, position: Coord, isCoastal: boolean): City {
    return new City({
      id,
      name,
      position: { ...position },
      isCoastal,
      owner: null,
      specialization: 'none',
      production: null,
      portDisabledTurns: 0,
    });
  }

  static fromSnapshot(s: CityState): City {
    return new City(cloneState(s));
  }

  toSnapshot(): CityState {
    return cloneState(this.s);
  }

  get id() { return this.s.id; }
  get name() { return this.s.name; }
  get position(): Coord { return this.s.position; }
  get isCoastal() { return this.s.isCoastal; }
  get owner() { return this.s.owner; }
  get specialization() { return this.s.specialization; }
  get specializationDef(): SpecializationDef { return SPECIALIZATIONS[this.s.specialization]; }
  get production(): Readonly<ProductionOrder> | null { return this.s.production; }
  get portDisabledTurns() { return this.s.portDisabledTurns; }
  get isNeutral() { return this.s.owner === null; }
  get isPortOperational() { return this.s.isCoastal && this.s.portDisabledTurns === 0; }

  buildTurnsFor(unit: UnitTypeId): number {
    const base = UNIT_TYPES[unit].buildTurns;
    return Math.max(1, Math.ceil(base * this.specializationDef.buildTimeFactor(unit)));
  }

  turnsRemaining(): number | null {
    if (!this.s.production) return null;
    return Math.max(0, this.buildTurnsFor(this.s.production.unit) - this.s.production.progress);
  }

  canProduce(unit: UnitTypeId): Result<void, CityError> {
    if (this.isNeutral) return err('NEUTRAL_CITY', 'neutral cities do not produce');
    const def = UNIT_TYPES[unit];
    if (def.domain === 'sea' && !this.s.isCoastal) {
      return err('REQUIRES_COAST', `${def.name} needs a coastal city`);
    }
    if (def.requiresSpecialization && def.requiresSpecialization !== this.s.specialization) {
      return err('REQUIRES_SPECIALIZATION', `${def.name} needs a ${def.requiresSpecialization}`);
    }
    return ok(undefined);
  }

  /** Switching to a different unit discards progress; re-selecting the same one keeps it. */
  setProduction(unit: UnitTypeId): Result<void, CityError> {
    const check = this.canProduce(unit);
    if (!check.ok) return check;
    if (this.s.production?.unit !== unit) this.s.production = { unit, progress: 0 };
    return ok(undefined);
  }

  setSpecialization(spec: CitySpecialization): Result<void, CityError> {
    if (this.isNeutral) return err('NEUTRAL_CITY', 'capture the city first');
    if (spec === 'naval_yard' && !this.s.isCoastal) {
      return err('REQUIRES_COAST', 'a naval yard needs a coastal city');
    }
    if (this.s.specialization !== 'none' && spec !== 'none') {
      return err('ALREADY_SPECIALIZED', 'reset to none before choosing another focus');
    }
    this.s.specialization = spec;
    // Retooling: keep the order only if it is still legal, and lose its progress.
    if (this.s.production) {
      const unit = this.s.production.unit;
      this.s.production = this.canProduce(unit).ok ? { unit, progress: 0 } : null;
    }
    return ok(undefined);
  }

  /**
   * Advance production one turn. Returns the unit type completed this turn, if any.
   * Ships stall (without losing progress) while the port is disabled.
   */
  tickProduction(): UnitTypeId | null {
    let completed: UnitTypeId | null = null;
    const order = this.s.production;
    if (order && !this.isNeutral) {
      const stalled = UNIT_TYPES[order.unit].domain === 'sea' && !this.isPortOperational;
      if (!stalled) {
        order.progress += 1;
        if (order.progress >= this.buildTurnsFor(order.unit)) {
          order.progress = 0;
          completed = order.unit;
        }
      }
    }
    if (this.s.portDisabledTurns > 0) this.s.portDisabledTurns -= 1;
    return completed;
  }

  /** Ownership change: production restarts from scratch, specialization survives. */
  capture(newOwner: PlayerId): void {
    this.s.owner = newOwner;
    this.s.production = { unit: DEFAULT_PRODUCTION, progress: 0 };
    this.s.portDisabledTurns = 0;
  }

  /** Strategic bomber hit: halve invested progress and shut the port for 2 turns. */
  applyStrategicBombing(): void {
    if (this.s.production) this.s.production.progress = Math.floor(this.s.production.progress / 2);
    if (this.s.isCoastal) {
      this.s.portDisabledTurns = Math.max(this.s.portDisabledTurns, PORT_DISABLED_TURNS_ON_BOMBING);
    }
  }
}
