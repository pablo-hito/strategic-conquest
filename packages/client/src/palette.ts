import type { Terrain } from '@sc/core';

/**
 * Canvas colors. The page chrome uses the same values through CSS tokens in style.css;
 * canvas can't read CSS variables cheaply per tile, so they are mirrored here.
 */
export const TERRAIN_COLOR: Record<Terrain, string> = {
  deep_ocean: '#0e2740',
  shallow_water: '#17466a',
  plains: '#3f5a3a',
  forest: '#2a4a31',
  hills: '#66603f',
  mountains: '#7d776b',
};

export const TERRAIN_DETAIL: Record<Terrain, string> = {
  deep_ocean: '#13304d',
  shallow_water: '#22587f',
  plains: '#4b6845',
  forest: '#3b6443',
  hills: '#8a8158',
  mountains: '#b2ab9c',
};

export const UNEXPLORED = '#05080c';
export const FOG_VEIL = 'rgba(4, 8, 13, 0.58)';
export const COAST = 'rgba(140, 200, 220, 0.35)';
export const GRID = 'rgba(160, 190, 210, 0.06)';
export const NEUTRAL = '#8b97a3';
export const INK = '#d7e2ea';
export const INK_DIM = '#7d8d99';
export const REACH = 'rgba(64, 214, 232, 0.16)';
export const REACH_SPECIAL = 'rgba(244, 177, 61, 0.22)';
export const TARGET = '#ff5a5a';
export const PATH = '#40d6e8';
export const PATH_LATER = 'rgba(64, 214, 232, 0.45)';

/** Faction colors: distinct hues at similar lightness so none dominates. */
export const FACTION = ['#40d6e8', '#f4b13d', '#e8618c', '#9bd85a', '#a98bf5', '#f07c4f'];
