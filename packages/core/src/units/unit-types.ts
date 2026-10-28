import type { MovementClass } from '../grid/terrain.js';
import type { CitySpecialization } from '../cities/specialization.js';

export type UnitDomain = 'land' | 'sea' | 'air';

/**
 * What a unit *is* when it gets shot at. The phase-3 damage matrix is indexed by
 * (attacker type x target class), so this is declared now to keep the catalog stable.
 */
export type TargetClass =
  | 'soft' // infantry, recon, artillery crews
  | 'armored'
  | 'air'
  | 'naval_light'
  | 'naval_heavy'
  | 'submarine';

export const UNIT_TYPE_IDS = [
  // land
  'recon',
  'infantry',
  'mech_infantry',
  'heavy_tank',
  'artillery',
  'anti_air',
  // sea
  'corvette',
  'destroyer',
  'missile_cruiser',
  'submarine',
  'battleship',
  'carrier',
  'transport',
  // air
  'recon_drone',
  'fighter',
  'cas',
  'strategic_bomber',
  'awacs',
] as const;
export type UnitTypeId = (typeof UNIT_TYPE_IDS)[number];

export interface CargoSpec {
  readonly slots: number;
  readonly accepts: readonly UnitDomain[];
}

export interface UnitTypeDef {
  readonly id: UnitTypeId;
  readonly name: string;
  readonly domain: UnitDomain;
  readonly movementClass: MovementClass;
  /** Movement points per turn. */
  readonly moves: number;
  /** Base vision radius in tiles. */
  readonly vision: number;
  /** Observer eye height above ground for line of sight. */
  readonly eyeHeight: number;
  readonly maxHp: number;
  readonly attack: number;
  readonly defense: number;
  readonly targetClass: TargetClass;
  /** Turns of city production at base rate (the game has no currency). */
  readonly buildTurns: number;
  /** Min/max attack range. Omitted = melee (range 1). */
  readonly attackRange?: { readonly min: number; readonly max: number };
  /** Indirect fire: cannot move and fire in the same turn. */
  readonly indirectFire?: boolean;
  /** Fuel in tiles of flight; must land on a city/carrier before reaching 0. */
  readonly fuel?: number;
  readonly cargo?: CargoSpec;
  readonly canCaptureCities?: boolean;
  /** Can dig in when it does not move (+20% defense per turn up to the cap). */
  readonly canEntrench?: boolean;
  /** Submarines: hidden unless detected by adjacency or sonar. */
  readonly stealth?: boolean;
  /** Detects stealth units in this radius (no line of sight needed underwater). */
  readonly sonarRange?: number;
  /** Shoots down aircraft entering this radius. */
  readonly airInterceptRange?: number;
  readonly requiresSpecialization?: CitySpecialization;
}

const LAND_EYE = 0.5;
const SEA_EYE = 0.5;
const AIR_EYE = 6;

export const UNIT_TYPES: Readonly<Record<UnitTypeId, UnitTypeDef>> = {
  // ─── Land ───────────────────────────────────────────────────────────────────
  recon: {
    id: 'recon', name: 'Light Recon', domain: 'land', movementClass: 'wheeled',
    moves: 3, vision: 3, eyeHeight: LAND_EYE, maxHp: 6, attack: 1, defense: 1,
    targetClass: 'soft', buildTurns: 3,
  },
  infantry: {
    id: 'infantry', name: 'Infantry', domain: 'land', movementClass: 'foot',
    moves: 1, vision: 1, eyeHeight: LAND_EYE, maxHp: 10, attack: 2, defense: 2,
    targetClass: 'soft', buildTurns: 4, canCaptureCities: true, canEntrench: true,
  },
  mech_infantry: {
    id: 'mech_infantry', name: 'Mechanized Infantry', domain: 'land', movementClass: 'tracked',
    moves: 2, vision: 1, eyeHeight: LAND_EYE, maxHp: 10, attack: 3, defense: 3,
    targetClass: 'armored', buildTurns: 6, canCaptureCities: true, canEntrench: true,
  },
  heavy_tank: {
    id: 'heavy_tank', name: 'Heavy Tank', domain: 'land', movementClass: 'tracked',
    moves: 2, vision: 1, eyeHeight: LAND_EYE, maxHp: 12, attack: 6, defense: 4,
    targetClass: 'armored', buildTurns: 8,
  },
  artillery: {
    id: 'artillery', name: 'Mobile Artillery', domain: 'land', movementClass: 'tracked',
    moves: 1, vision: 1, eyeHeight: LAND_EYE, maxHp: 8, attack: 6, defense: 1,
    targetClass: 'soft', buildTurns: 8, attackRange: { min: 2, max: 3 }, indirectFire: true,
  },
  anti_air: {
    id: 'anti_air', name: 'Anti-Air', domain: 'land', movementClass: 'wheeled',
    moves: 2, vision: 2, eyeHeight: LAND_EYE, maxHp: 8, attack: 2, defense: 2,
    targetClass: 'armored', buildTurns: 6, airInterceptRange: 2,
  },

  // ─── Sea ────────────────────────────────────────────────────────────────────
  corvette: {
    id: 'corvette', name: 'Corvette', domain: 'sea', movementClass: 'naval',
    moves: 5, vision: 2, eyeHeight: SEA_EYE, maxHp: 6, attack: 2, defense: 2,
    targetClass: 'naval_light', buildTurns: 5,
  },
  destroyer: {
    id: 'destroyer', name: 'Destroyer', domain: 'sea', movementClass: 'naval',
    moves: 4, vision: 2, eyeHeight: SEA_EYE, maxHp: 10, attack: 4, defense: 3,
    targetClass: 'naval_light', buildTurns: 10, sonarRange: 2,
  },
  missile_cruiser: {
    id: 'missile_cruiser', name: 'Missile Cruiser', domain: 'sea', movementClass: 'naval_heavy',
    moves: 3, vision: 3, eyeHeight: SEA_EYE, maxHp: 14, attack: 6, defense: 5,
    targetClass: 'naval_heavy', buildTurns: 16, attackRange: { min: 1, max: 4 },
    airInterceptRange: 3, requiresSpecialization: 'naval_yard',
  },
  submarine: {
    id: 'submarine', name: 'Attack Submarine', domain: 'sea', movementClass: 'naval',
    moves: 3, vision: 1, eyeHeight: SEA_EYE, maxHp: 8, attack: 7, defense: 2,
    targetClass: 'submarine', buildTurns: 12, stealth: true,
  },
  battleship: {
    id: 'battleship', name: 'Battleship', domain: 'sea', movementClass: 'naval_heavy',
    moves: 3, vision: 2, eyeHeight: SEA_EYE, maxHp: 20, attack: 8, defense: 7,
    targetClass: 'naval_heavy', buildTurns: 20, attackRange: { min: 1, max: 3 },
    requiresSpecialization: 'naval_yard',
  },
  carrier: {
    id: 'carrier', name: 'Aircraft Carrier', domain: 'sea', movementClass: 'naval_heavy',
    moves: 3, vision: 2, eyeHeight: SEA_EYE, maxHp: 16, attack: 1, defense: 4,
    targetClass: 'naval_heavy', buildTurns: 20, cargo: { slots: 3, accepts: ['air'] },
    requiresSpecialization: 'naval_yard',
  },
  transport: {
    id: 'transport', name: 'Amphibious Transport', domain: 'sea', movementClass: 'naval',
    moves: 3, vision: 2, eyeHeight: SEA_EYE, maxHp: 8, attack: 0, defense: 1,
    targetClass: 'naval_light', buildTurns: 8, cargo: { slots: 3, accepts: ['land'] },
  },

  // ─── Air ────────────────────────────────────────────────────────────────────
  recon_drone: {
    id: 'recon_drone', name: 'Recon Drone', domain: 'air', movementClass: 'air',
    moves: 10, vision: 4, eyeHeight: AIR_EYE, maxHp: 3, attack: 0, defense: 0,
    targetClass: 'air', buildTurns: 4, fuel: 30,
  },
  fighter: {
    id: 'fighter', name: 'Air Superiority Fighter', domain: 'air', movementClass: 'air',
    moves: 10, vision: 2, eyeHeight: AIR_EYE, maxHp: 8, attack: 5, defense: 4,
    targetClass: 'air', buildTurns: 8, fuel: 20,
  },
  cas: {
    id: 'cas', name: 'Close Air Support', domain: 'air', movementClass: 'air',
    moves: 8, vision: 2, eyeHeight: AIR_EYE, maxHp: 8, attack: 7, defense: 2,
    targetClass: 'air', buildTurns: 10, fuel: 16,
  },
  strategic_bomber: {
    id: 'strategic_bomber', name: 'Strategic Bomber', domain: 'air', movementClass: 'air',
    moves: 6, vision: 2, eyeHeight: AIR_EYE, maxHp: 12, attack: 8, defense: 2,
    targetClass: 'air', buildTurns: 15, fuel: 30, requiresSpecialization: 'air_base',
  },
  awacs: {
    id: 'awacs', name: 'AWACS', domain: 'air', movementClass: 'air',
    moves: 6, vision: 8, eyeHeight: 10, maxHp: 6, attack: 0, defense: 1,
    targetClass: 'air', buildTurns: 14, fuel: 24, requiresSpecialization: 'air_base',
  },
};

export function unitType(id: UnitTypeId): UnitTypeDef {
  return UNIT_TYPES[id];
}
