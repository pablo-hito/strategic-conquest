import type { CitySpecialization, UnitTypeId } from '@sc/core';

export type PersonalityId = 'conquistador' | 'blitz' | 'fortress' | 'admiral';

/** Desired army composition: relative weights, not counts. */
export type Mix = Partial<Record<UnitTypeId, number>>;

export interface Personality {
  readonly id: PersonalityId;
  /** Name shown to the player at the end of the game ("the bot played as..."). */
  readonly label: string;
  /** Rounds spent mostly expanding before arming in earnest (unless attacked first). */
  readonly expandUntil: number;
  /** Production while grabbing neutral cities. */
  readonly expandMix: Mix;
  /** Production once the map is claimed or the enemy is known. */
  readonly warMix: Mix;
  /** Land units kept inside each city (front-line cities get one more). */
  readonly garrison: number;
  /**
   * 'raids': every transport sails as soon as it has a load, to its own nearest
   * objective (constant pressure). 'massed': the force gathers at a staging port and
   * lands all at once on one target (the surprise attack).
   */
  readonly strikeStyle: 'raids' | 'massed';
  /** Combat land units gathered before launching a massed offensive. */
  readonly strikeSize: number;
  /** An attack is taken when damage dealt ≥ this × damage taken (lower = bolder). */
  readonly attackEdge: number;
  /** City specializations it develops, in order, once it has enough cities. */
  readonly specializations: readonly CitySpecialization[];
  /** Recon drones kept in the air to find islands and the enemy. */
  readonly drones: number;
}

export const PERSONALITIES: Readonly<Record<PersonalityId, Personality>> = {
  // Grabs as much land as possible, as fast as possible; fights with numbers.
  conquistador: {
    id: 'conquistador',
    label: 'Conquistador (expansión rápida)',
    expandUntil: 45,
    expandMix: { infantry: 6, transport: 2, recon_drone: 1, destroyer: 1 },
    warMix: { infantry: 4, mech_infantry: 2, heavy_tank: 3, transport: 2, destroyer: 2, fighter: 2 },
    garrison: 1,
    strikeStyle: 'raids',
    strikeSize: 3,
    attackEdge: 1.0,
    specializations: ['naval_yard', 'industrial_hub'],
    drones: 2,
  },
  // Arms early and goes for the throat: armor + close air support in one big landing.
  blitz: {
    id: 'blitz',
    label: 'Relámpago (ataque temprano)',
    expandUntil: 30,
    expandMix: { infantry: 5, transport: 2, recon_drone: 1, heavy_tank: 1 },
    warMix: { heavy_tank: 4, mech_infantry: 3, infantry: 2, cas: 2, fighter: 1, transport: 2, destroyer: 1 },
    garrison: 1,
    strikeStyle: 'massed',
    strikeSize: 6,
    attackEdge: 0.9,
    specializations: ['industrial_hub', 'air_base'],
    drones: 1,
  },
  // Holds every city tightly, then strikes late with a heavy, combined force.
  fortress: {
    id: 'fortress',
    label: 'Fortaleza (defensa y golpe tardío)',
    expandUntil: 40,
    expandMix: { infantry: 6, transport: 2, recon_drone: 1, anti_air: 1 },
    warMix: { infantry: 3, heavy_tank: 4, artillery: 1, anti_air: 1, fighter: 2, strategic_bomber: 1, transport: 2, destroyer: 1 },
    garrison: 2,
    strikeStyle: 'massed',
    strikeSize: 8,
    attackEdge: 1.2,
    specializations: ['industrial_hub', 'naval_yard', 'air_base'],
    drones: 1,
  },
  // Rules the sea: hunts transports, bombards coasts, lands where defenses are thin.
  admiral: {
    id: 'admiral',
    label: 'Almirante (dominio naval)',
    expandUntil: 35,
    expandMix: { infantry: 5, transport: 2, destroyer: 2, recon_drone: 1 },
    warMix: { infantry: 3, heavy_tank: 3, transport: 2, destroyer: 3, submarine: 2, battleship: 1, carrier: 1, fighter: 2 },
    garrison: 1,
    strikeStyle: 'raids',
    strikeSize: 3,
    attackEdge: 1.0,
    specializations: ['naval_yard', 'naval_yard', 'air_base'],
    drones: 2,
  },
};

export const PERSONALITY_IDS = Object.keys(PERSONALITIES) as PersonalityId[];
