import type { Terrain } from '@sc/core';

/**
 * Canvas colors. The page chrome uses matching CSS tokens in style.css; canvas
 * can't read CSS variables cheaply per tile, so the map's palette lives here.
 */
export const WATER = {
  deep: '#0b2843',
  deepLight: '#0f3456',
  shallow: '#17557d',
  shallowLight: '#1f6b96',
  wave: 'rgba(170, 220, 245, 0.16)',
  foam: 'rgba(225, 245, 255, 0.55)',
};

export const LAND = {
  sand: '#c8b383',
  plains: '#557f45',
  plainsLight: '#668f52',
  grass: '#79a35f',
  forest: '#2f5b34',
  canopy: '#24492a',
  canopyLight: '#3f7646',
  hills: '#7d7448',
  hillsShade: '#5d5634',
  hillsLight: '#9b9061',
  mountains: '#6f6c66',
  rockDark: '#4d4a45',
  rockLight: '#9d9a90',
  snow: '#eef3f6',
};

/** Flat colors per terrain, used by the minimap and as base fills. */
export const TERRAIN_COLOR: Record<Terrain, string> = {
  deep_ocean: WATER.deep,
  shallow_water: WATER.shallow,
  plains: LAND.plains,
  forest: LAND.forest,
  hills: LAND.hills,
  mountains: LAND.mountains,
};

export const UNEXPLORED = '#04070b';
export const FOG_RGB = [4, 8, 13] as const;
export const INK = '#e6eef4';
export const INK_DARK = '#08121b';
export const NEUTRAL = '#9aa6b2';
export const REACH = 'rgba(80, 220, 240, 0.13)';
export const REACH_EDGE = 'rgba(120, 235, 250, 0.55)';
export const REACH_SPECIAL = 'rgba(255, 190, 80, 0.22)';
export const TARGET = '#ff5a5a';
export const PATH = '#5fe3f2';
export const PATH_LATER = 'rgba(95, 227, 242, 0.5)';
export const ACTIVE = '#ffd25c';
export const READY_DOT = '#7dff9a';

/** Faction colors: distinct hues at similar lightness so none dominates. */
export const FACTION = ['#3fc8ff', '#ff9f3d', '#f2648f', '#9de05a', '#b59bff', '#ffd84a'];
