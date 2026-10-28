import type { CitySpecialization, StopReason, Terrain, UnitTypeId } from '@sc/core';

export const UNIT_NAME: Record<UnitTypeId, string> = {
  recon: 'Reconocimiento',
  infantry: 'Infantería',
  mech_infantry: 'Infantería mecanizada',
  heavy_tank: 'Tanque pesado',
  artillery: 'Artillería',
  anti_air: 'Antiaéreo',
  corvette: 'Corbeta',
  destroyer: 'Destructor',
  missile_cruiser: 'Crucero lanzamisiles',
  submarine: 'Submarino',
  battleship: 'Acorazado',
  carrier: 'Portaaviones',
  transport: 'Transporte',
  recon_drone: 'Dron de reconocimiento',
  fighter: 'Caza',
  cas: 'Apoyo aéreo cercano',
  strategic_bomber: 'Bombardero estratégico',
  awacs: 'AWACS',
};

/** Short NATO-style codes printed on the map tokens. */
export const UNIT_CODE: Record<UnitTypeId, string> = {
  recon: 'REC',
  infantry: 'INF',
  mech_infantry: 'MEC',
  heavy_tank: 'TNK',
  artillery: 'ART',
  anti_air: 'AA',
  corvette: 'CRV',
  destroyer: 'DD',
  missile_cruiser: 'CG',
  submarine: 'SS',
  battleship: 'BB',
  carrier: 'CV',
  transport: 'TR',
  recon_drone: 'UAV',
  fighter: 'FTR',
  cas: 'CAS',
  strategic_bomber: 'BMB',
  awacs: 'AEW',
};

export const TERRAIN_NAME: Record<Terrain, string> = {
  deep_ocean: 'Océano profundo',
  shallow_water: 'Aguas costeras',
  plains: 'Llanura',
  forest: 'Bosque',
  hills: 'Colinas',
  mountains: 'Montañas',
};

export const SPECIALIZATION_NAME: Record<CitySpecialization, string> = {
  none: 'Sin especializar',
  industrial_hub: 'Polo industrial',
  naval_yard: 'Astillero naval',
  air_base: 'Base aérea',
};

export const STOP_TEXT: Partial<Record<StopReason, string>> = {
  CONTACT: 'Contacto: enemigo a la vista. Movimiento detenido.',
  BLOCKED: 'Camino bloqueado por algo oculto en la niebla.',
  CRASHED: 'se estrelló sin combustible.',
};

export const playerName = (index: number) => `Jugador ${index + 1}`;
