import {
  TERRAINS,
  TileVisibility,
  UNIT_TYPES,
  UNKNOWN_TERRAIN,
  type Coord,
  type PathStep,
  type PlayerId,
  type PlayerView,
  type ReachableTile,
  type TileIndex,
  type UnitDomain,
  type UnitTypeId,
} from '@sc/core';
import { UNIT_CODE } from './labels.js';
import {
  COAST,
  FACTION,
  FOG_VEIL,
  GRID,
  INK,
  INK_DIM,
  NEUTRAL,
  PATH,
  PATH_LATER,
  REACH,
  REACH_SPECIAL,
  TERRAIN_COLOR,
  TERRAIN_DETAIL,
  UNEXPLORED,
} from './palette.js';

export interface Overlay {
  readonly selectedUnit?: { id: string; at: Coord } | undefined;
  readonly selectedTile?: Coord | undefined;
  readonly reach?: ReadonlyMap<TileIndex, ReachableTile> | undefined;
  readonly path?: readonly PathStep[] | undefined;
  readonly hover?: Coord | undefined;
}

export interface Camera {
  /** Tile coordinate at the top-left corner of the canvas. */
  x: number;
  y: number;
  /** Pixels per tile. */
  zoom: number;
}

export const MIN_ZOOM = 8;
export const MAX_ZOOM = 56;

interface Token {
  type: UnitTypeId;
  owner: PlayerId;
  hp: number;
  ghost: boolean;
  spent: boolean;
  cargo: number;
  stealth: boolean;
}

/** Draws a PlayerView on a 2D canvas. Knows nothing about rules, only about what it is shown. */
export class MapRenderer {
  readonly ctx: CanvasRenderingContext2D;
  readonly camera: Camera = { x: 0, y: 0, zoom: 26 };
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  constructor(
    readonly canvas: HTMLCanvasElement,
    private readonly factionOf: (p: PlayerId | null) => string,
  ) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
  }

  get viewportTiles(): { w: number; h: number } {
    return { w: this.cssW / this.camera.zoom, h: this.cssH / this.camera.zoom };
  }

  screenToTile(px: number, py: number): Coord {
    return {
      x: Math.floor(this.camera.x + px / this.camera.zoom),
      y: Math.floor(this.camera.y + py / this.camera.zoom),
    };
  }

  centerOn(c: Coord): void {
    const { w, h } = this.viewportTiles;
    this.camera.x = c.x + 0.5 - w / 2;
    this.camera.y = c.y + 0.5 - h / 2;
  }

  /** Zoom keeping the tile under (px, py) fixed on screen. */
  zoomAt(factor: number, px: number, py: number): void {
    const cam = this.camera;
    const before = { x: cam.x + px / cam.zoom, y: cam.y + py / cam.zoom };
    cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * factor));
    cam.x = before.x - px / cam.zoom;
    cam.y = before.y - py / cam.zoom;
  }

  clamp(width: number, height: number): void {
    const { w, h } = this.viewportTiles;
    const cam = this.camera;
    cam.x = Math.max(-w / 2, Math.min(width - w / 2, cam.x));
    cam.y = Math.max(-h / 2, Math.min(height - h / 2, cam.y));
  }

  draw(view: PlayerView, overlay: Overlay, time: number): void {
    const { ctx, camera: cam } = this;
    const z = cam.zoom;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = UNEXPLORED;
    ctx.fillRect(0, 0, this.cssW, this.cssH);

    const x0 = Math.max(0, Math.floor(cam.x));
    const y0 = Math.max(0, Math.floor(cam.y));
    const x1 = Math.min(view.width - 1, Math.ceil(cam.x + this.cssW / z));
    const y1 = Math.min(view.height - 1, Math.ceil(cam.y + this.cssH / z));
    const sx = (x: number) => (x - cam.x) * z;
    const sy = (y: number) => (y - cam.y) * z;
    const terrainAt = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= view.width || y >= view.height) return UNKNOWN_TERRAIN;
      return view.terrain[y * view.width + x]!;
    };
    const isWaterCode = (code: number) => code === 0 || code === 1;

    // Terrain
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const code = terrainAt(x, y);
        if (code === UNKNOWN_TERRAIN) continue;
        const t = TERRAINS[code]!;
        const px = sx(x);
        const py = sy(y);
        ctx.fillStyle = TERRAIN_COLOR[t];
        ctx.fillRect(px, py, z + 0.5, z + 0.5);
        if (z >= 14) this.drawTerrainDetail(t, px, py, z, x, y);
      }
    }

    // Coastlines: land edges that face water.
    ctx.strokeStyle = COAST;
    ctx.lineWidth = Math.max(1, z / 18);
    ctx.beginPath();
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const code = terrainAt(x, y);
        if (code === UNKNOWN_TERRAIN || isWaterCode(code)) continue;
        const px = sx(x);
        const py = sy(y);
        const n = terrainAt(x, y - 1), s = terrainAt(x, y + 1), w = terrainAt(x - 1, y), e = terrainAt(x + 1, y);
        if (isWaterCode(n)) { ctx.moveTo(px, py); ctx.lineTo(px + z, py); }
        if (isWaterCode(s)) { ctx.moveTo(px, py + z); ctx.lineTo(px + z, py + z); }
        if (isWaterCode(w)) { ctx.moveTo(px, py); ctx.lineTo(px, py + z); }
        if (isWaterCode(e)) { ctx.moveTo(px + z, py); ctx.lineTo(px + z, py + z); }
      }
    }
    ctx.stroke();

    // Grid
    if (z >= 22) {
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1 + 1; x++) { ctx.moveTo(sx(x), sy(y0)); ctx.lineTo(sx(x), sy(y1 + 1)); }
      for (let y = y0; y <= y1 + 1; y++) { ctx.moveTo(sx(x0), sy(y)); ctx.lineTo(sx(x1 + 1), sy(y)); }
      ctx.stroke();
    }

    // Movement overlay (under fog veil so it reads as "projected on the terrain")
    if (overlay.reach) {
      for (const [i, r] of overlay.reach) {
        const x = i % view.width, y = Math.floor(i / view.width);
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        ctx.fillStyle = r.kind === 'move' || r.kind === 'disembark' ? REACH : REACH_SPECIAL;
        ctx.fillRect(sx(x) + 1, sy(y) + 1, z - 2, z - 2);
      }
    }

    // Cities
    const cityOwner = new Map<number, PlayerId | null>();
    for (const c of view.ownCities) cityOwner.set(c.position.y * view.width + c.position.x, c.owner);
    for (const c of view.knownCities) cityOwner.set(c.position.y * view.width + c.position.x, c.owner);
    for (const [i, owner] of cityOwner) {
      const x = i % view.width, y = Math.floor(i / view.width);
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      this.drawCity(sx(x), sy(y), z, owner);
    }

    // Fog veil over remembered tiles
    ctx.fillStyle = FOG_VEIL;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (view.visibility[y * view.width + x] === TileVisibility.Fogged) ctx.fillRect(sx(x), sy(y), z + 0.5, z + 0.5);
      }
    }

    // Units (top-level only: cargo is drawn as a badge on its carrier)
    const stacks = new Map<number, Token[]>();
    const add = (c: Coord, t: Token) => {
      const i = c.y * view.width + c.x;
      const list = stacks.get(i);
      if (list) list.push(t);
      else stacks.set(i, [t]);
    };
    for (const u of view.ownUnits) {
      if (u.carriedBy !== null) continue;
      add(u.position, {
        type: u.type, owner: u.owner, hp: u.hp, ghost: false,
        spent: u.movesLeft <= 0, cargo: u.cargo.length, stealth: u.silentRunning,
      });
    }
    for (const u of view.foreignUnits) {
      add(u.position, { type: u.type, owner: u.owner, hp: u.hp, ghost: false, spent: false, cargo: 0, stealth: false });
    }
    for (const g of view.ghosts) {
      add(g.position, { type: g.type, owner: g.owner, hp: UNIT_TYPES[g.type].maxHp, ghost: true, spent: false, cargo: 0, stealth: false });
    }
    for (const [i, tokens] of stacks) {
      const x = i % view.width, y = Math.floor(i / view.width);
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      // The strongest defender is the one shown on top of the stack.
      tokens.sort((a, b) => UNIT_TYPES[b.type].defense - UNIT_TYPES[a.type].defense);
      this.drawToken(sx(x), sy(y), z, tokens[0]!, tokens.length);
      // Garrisoned city: keep the city readable by framing the whole tile.
      if (cityOwner.has(i)) {
        ctx.strokeStyle = this.factionOf(cityOwner.get(i)!);
        ctx.lineWidth = Math.max(1.5, z / 16);
        ctx.setLineDash([z / 5, z / 8]);
        ctx.strokeRect(sx(x) + 1, sy(y) + 1, z - 2, z - 2);
        ctx.setLineDash([]);
      }
    }

    // Planned path
    if (overlay.path && overlay.path.length > 0 && overlay.selectedUnit) this.drawPath(overlay.selectedUnit.at, overlay.path);

    // Hover + selection
    if (overlay.hover) {
      ctx.strokeStyle = 'rgba(215, 226, 234, 0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx(overlay.hover.x) + 0.5, sy(overlay.hover.y) + 0.5, z - 1, z - 1);
    }
    const sel = overlay.selectedUnit?.at ?? overlay.selectedTile;
    if (sel) {
      const pulse = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.5 : (Math.sin(time / 260) + 1) / 2;
      ctx.strokeStyle = `rgba(64, 214, 232, ${0.55 + pulse * 0.45})`;
      ctx.lineWidth = 2;
      const pad = 1 + pulse * 2;
      const px = sx(sel.x), py = sy(sel.y);
      const len = z * 0.3;
      ctx.beginPath();
      // corner brackets, like a targeting reticle
      for (const [cx, cy, dx, dy] of [[px - pad, py - pad, 1, 1], [px + z + pad, py - pad, -1, 1], [px - pad, py + z + pad, 1, -1], [px + z + pad, py + z + pad, -1, -1]] as const) {
        ctx.moveTo(cx, cy + dy * len); ctx.lineTo(cx, cy); ctx.lineTo(cx + dx * len, cy);
      }
      ctx.stroke();
    }
  }

  private drawTerrainDetail(t: (typeof TERRAINS)[number], px: number, py: number, z: number, x: number, y: number): void {
    const ctx = this.ctx;
    const h = hash(x, y);
    ctx.strokeStyle = TERRAIN_DETAIL[t];
    ctx.fillStyle = TERRAIN_DETAIL[t];
    ctx.lineWidth = Math.max(1, z / 22);
    switch (t) {
      case 'forest': {
        for (let k = 0; k < 3; k++) {
          const cx = px + z * (0.25 + 0.25 * k + ((h >> (k * 3)) & 3) * 0.03);
          const cy = py + z * (0.35 + (((h >> (k * 5)) & 3) * 0.12));
          ctx.beginPath();
          ctx.moveTo(cx, cy - z * 0.16);
          ctx.lineTo(cx - z * 0.1, cy + z * 0.08);
          ctx.lineTo(cx + z * 0.1, cy + z * 0.08);
          ctx.closePath();
          ctx.fill();
        }
        break;
      }
      case 'hills': {
        ctx.beginPath();
        ctx.arc(px + z * 0.35, py + z * 0.7, z * 0.2, Math.PI, 0);
        ctx.arc(px + z * 0.68, py + z * 0.62, z * 0.16, Math.PI, 0);
        ctx.stroke();
        break;
      }
      case 'mountains': {
        ctx.beginPath();
        ctx.moveTo(px + z * 0.12, py + z * 0.8);
        ctx.lineTo(px + z * 0.42, py + z * 0.22);
        ctx.lineTo(px + z * 0.6, py + z * 0.52);
        ctx.lineTo(px + z * 0.72, py + z * 0.36);
        ctx.lineTo(px + z * 0.9, py + z * 0.8);
        ctx.stroke();
        break;
      }
      case 'deep_ocean':
      case 'shallow_water': {
        if ((h & 7) !== 0) break;
        ctx.beginPath();
        ctx.moveTo(px + z * 0.25, py + z * 0.55);
        ctx.quadraticCurveTo(px + z * 0.4, py + z * 0.42, px + z * 0.55, py + z * 0.55);
        ctx.stroke();
        break;
      }
      case 'plains':
        if ((h & 3) === 0) ctx.fillRect(px + z * 0.5, py + z * 0.5, Math.max(1, z / 16), Math.max(1, z / 16));
        break;
    }
  }

  private drawCity(px: number, py: number, z: number, owner: PlayerId | null): void {
    const ctx = this.ctx;
    const color = this.factionOf(owner);
    const m = z * 0.12;
    ctx.fillStyle = '#0a1018';
    ctx.fillRect(px + m, py + m, z - 2 * m, z - 2 * m);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, z / 14);
    ctx.strokeRect(px + m, py + m, z - 2 * m, z - 2 * m);
    // skyline glyph
    ctx.fillStyle = color;
    const b = py + z - m * 2.2;
    const w = (z - 4 * m) / 5;
    const heights = [0.3, 0.55, 0.4, 0.65, 0.35];
    heights.forEach((hh, k) => {
      const hgt = (z - 4 * m) * hh;
      ctx.fillRect(px + 2 * m + k * w + 0.5, b - hgt, w - 1, hgt);
    });
  }

  private drawToken(px: number, py: number, z: number, t: Token, count: number): void {
    const ctx = this.ctx;
    const color = this.factionOf(t.owner);
    const domain: UnitDomain = UNIT_TYPES[t.type].domain;
    const cx = px + z / 2, cy = py + z / 2;
    const r = z * 0.38;
    ctx.save();
    ctx.globalAlpha = t.ghost ? 0.4 : t.spent ? 0.6 : 1;
    ctx.beginPath();
    // Shape encodes the domain: square = land, hull = sea, diamond = air.
    if (domain === 'land') ctx.rect(cx - r, cy - r * 0.8, 2 * r, 1.6 * r);
    else if (domain === 'sea') {
      ctx.moveTo(cx - r, cy - r * 0.55);
      ctx.lineTo(cx + r * 0.7, cy - r * 0.55);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx + r * 0.7, cy + r * 0.55);
      ctx.lineTo(cx - r, cy + r * 0.55);
      ctx.closePath();
    } else {
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
    }
    ctx.fillStyle = '#081019';
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, z / 14);
    ctx.strokeStyle = color;
    if (t.ghost || t.stealth) ctx.setLineDash([z / 8, z / 10]);
    ctx.stroke();
    ctx.setLineDash([]);

    if (z >= 16) {
      ctx.fillStyle = t.ghost ? INK_DIM : INK;
      ctx.font = `600 ${Math.max(7, Math.round(z * (UNIT_CODE[t.type].length > 2 ? 0.27 : 0.32)))}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t.ghost ? '?' : UNIT_CODE[t.type], cx, cy + 0.5);
    }

    // HP bar when damaged
    const maxHp = UNIT_TYPES[t.type].maxHp;
    if (!t.ghost && t.hp < maxHp && z >= 14) {
      const bw = z * 0.7, bh = Math.max(2, z / 14);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(cx - bw / 2, py + z - bh - 1, bw, bh);
      const f = t.hp / maxHp;
      ctx.fillStyle = f > 0.5 ? '#9bd85a' : f > 0.25 ? '#f4b13d' : '#e8618c';
      ctx.fillRect(cx - bw / 2, py + z - bh - 1, bw * f, bh);
    }

    // Stack / cargo badges
    const badge = (text: string, bx: number, by: number) => {
      const s = Math.max(9, z * 0.34);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(bx, by, s / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#081019';
      ctx.font = `700 ${Math.round(s * 0.7)}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx, by + 0.5);
    };
    if (z >= 18 && count > 1) badge(String(count), px + z * 0.86, py + z * 0.14);
    if (z >= 18 && t.cargo > 0) badge(`+${t.cargo}`, px + z * 0.14, py + z * 0.14);
    ctx.restore();
  }

  private drawPath(from: Coord, steps: readonly PathStep[]): void {
    const { ctx, camera: cam } = this;
    const z = cam.zoom;
    const cx = (c: Coord) => (c.x + 0.5 - cam.x) * z;
    const cy = (c: Coord) => (c.y + 0.5 - cam.y) * z;
    ctx.lineWidth = Math.max(2, z / 10);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let prev = from;
    for (const s of steps) {
      ctx.strokeStyle = s.turn === 0 ? PATH : PATH_LATER;
      ctx.setLineDash(s.turn === 0 ? [] : [z / 6, z / 6]);
      ctx.beginPath();
      ctx.moveTo(cx(prev), cy(prev));
      ctx.lineTo(cx(s.coord), cy(s.coord));
      ctx.stroke();
      prev = s.coord;
    }
    ctx.setLineDash([]);
    // Turn markers where each turn's movement ends.
    steps.forEach((s, i) => {
      const last = i === steps.length - 1 || steps[i + 1]!.turn !== s.turn;
      if (!last) return;
      const rr = Math.max(7, z * 0.26);
      ctx.fillStyle = '#081019';
      ctx.strokeStyle = s.turn === 0 ? PATH : PATH_LATER;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx(s.coord), cy(s.coord), rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.font = `600 ${Math.round(rr * 1.1)}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(s.turn + 1), cx(s.coord), cy(s.coord) + 0.5);
    });
  }
}

/** Minimap: one pixel block per tile, plus the camera rectangle. */
export function drawMinimap(
  canvas: HTMLCanvasElement,
  view: PlayerView,
  camera: Camera,
  viewport: { w: number; h: number },
  factionOf: (p: PlayerId | null) => string,
): void {
  const ctx = canvas.getContext('2d')!;
  const scale = canvas.width / view.width;
  canvas.height = Math.round(view.height * scale);
  ctx.fillStyle = UNEXPLORED;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < view.terrain.length; i++) {
    const code = view.terrain[i]!;
    if (code === UNKNOWN_TERRAIN) continue;
    const x = i % view.width, y = Math.floor(i / view.width);
    ctx.fillStyle = TERRAIN_COLOR[TERRAINS[code]!];
    ctx.fillRect(x * scale, y * scale, Math.ceil(scale), Math.ceil(scale));
    if (view.visibility[i] === TileVisibility.Fogged) {
      ctx.fillStyle = FOG_VEIL;
      ctx.fillRect(x * scale, y * scale, Math.ceil(scale), Math.ceil(scale));
    }
  }
  const dot = Math.max(2, scale * 1.6);
  for (const c of [...view.ownCities, ...view.knownCities]) {
    ctx.fillStyle = factionOf(c.owner);
    ctx.fillRect(c.position.x * scale - dot / 4, c.position.y * scale - dot / 4, dot, dot);
  }
  for (const u of view.foreignUnits) {
    ctx.fillStyle = factionOf(u.owner);
    ctx.fillRect(u.position.x * scale, u.position.y * scale, Math.max(1.5, scale), Math.max(1.5, scale));
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.strokeRect(camera.x * scale + 0.5, camera.y * scale + 0.5, viewport.w * scale, viewport.h * scale);
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

export const neutralColor = NEUTRAL;
export const factionColors = FACTION;
