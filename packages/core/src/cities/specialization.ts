import type { UnitTypeId } from '../units/unit-types.js';

export const CITY_SPECIALIZATIONS = ['none', 'industrial_hub', 'naval_yard', 'air_base'] as const;
export type CitySpecialization = (typeof CITY_SPECIALIZATIONS)[number];

const INDUSTRIAL_UNITS: ReadonlySet<UnitTypeId> = new Set([
  'mech_infantry',
  'heavy_tank',
  'artillery',
  'anti_air',
]);

export interface SpecializationDef {
  readonly id: CitySpecialization;
  /** Multiplier applied to a unit's base build turns (rounded up, min 1). */
  buildTimeFactor(unit: UnitTypeId): number;
  /** Aircraft parked here (carriers give 3); 0 = no limit enforced. */
  readonly hangarSlots: number;
  /** Extra radius around the city in which aircraft are refueled. */
  readonly refuelRadius: number;
  /** Vision radius the city itself provides to its owner. */
  readonly vision: number;
}

export const SPECIALIZATIONS: Readonly<Record<CitySpecialization, SpecializationDef>> = {
  none: { id: 'none', buildTimeFactor: () => 1, hangarSlots: 4, refuelRadius: 0, vision: 2 },
  industrial_hub: {
    id: 'industrial_hub',
    buildTimeFactor: (u) => (INDUSTRIAL_UNITS.has(u) ? 0.75 : 1),
    hangarSlots: 4,
    refuelRadius: 0,
    vision: 2,
  },
  naval_yard: { id: 'naval_yard', buildTimeFactor: () => 1, hangarSlots: 4, refuelRadius: 0, vision: 3 },
  air_base: {
    id: 'air_base',
    buildTimeFactor: (u) => (u === 'fighter' || u === 'cas' ? 0.8 : 1),
    hangarSlots: 10,
    refuelRadius: 1,
    vision: 3,
  },
};
