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
  type Terrain,
  type TileIndex,
  type UnitTypeId,
} from '@sc/core';
import { drawUnitIcon } from './icons.js';
import {
  ACTIVE,
  SELECT,
  FOG_RGB,
  INK,
  INK_DARK,
  LAND,
  PATH,
  PATH_LATER,
  READY_DOT,
  REACH,
  REACH_EDGE,
  REACH_SPECIAL,
  TARGET,
  TERRAIN_COLOR,
  UNEXPLORED,
  WATER,
} from './palette.js';

export interface Overlay {
  readonly selectedUnit?: { id: string; at: Coord } | undefined;
  readonly selectedTile?: Coord | undefined;
  readonly reach?: ReadonlyMap<TileIndex, ReachableTile> | undefined;
  readonly targets?: ReadonlySet<TileIndex> | undefined;
  /** Enemies reachable to attack after moving this turn (dashed reticle). */
  readonly assaults?: ReadonlySet<TileIndex> | undefined;
  readonly path?: readonly PathStep[] | undefined;
  readonly hover?: Coord | undefined;
  /** Besieged cities (tile indices): red siege ring. */
  readonly besieged?: ReadonlySet<TileIndex> | undefined;
}

export interface Camera {
  /** Tile coordinate at the top-left corner of the canvas. */
  x: number;
  y: number;
  /** Pixels per tile. */
  zoom: number;
}

export const MIN_ZOOM = 10;
export const MAX_ZOOM = 64;

/** Terrain is pre-painted at this resolution in square chunks of CHUNK tiles. */
const TILE_PX = 32;
const CHUNK = 16;
const MAX_CACHED_CHUNKS = 48;

const STEP_MS = 70;
const BLAST_MS = 750;

interface Token {
  id: string;
  type: UnitTypeId;
  owner: PlayerId;
  hp: number;
  ghost: boolean;
  own: boolean;
  spent: boolean;
  cargo: number;
  stealth: boolean;
}

interface MoveAnim {
  unitId: string;
  token: Token;
  points: Coord[];
  start: number;
}

interface Blast {
  at: Coord;
  start: number;
  label: string;
  big: boolean;
}

const isWaterCode = (code: number) => code === 0 || code === 1;

/** Draws a PlayerView on a 2D canvas. Knows nothing about rules, only what it is shown. */
export class MapRenderer {
  readonly ctx: CanvasRenderingContext2D;
  readonly camera: Camera = { x: 0, y: 0, zoom: 34 };
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;
  private readonly chunks = new Map<string, { canvas: HTMLCanvasElement; sig: number }>();
  private chunkView: PlayerView | null = null;
  private readonly fogCanvas = document.createElement('canvas');
  private fogView: PlayerView | null = null;
  private moves: MoveAnim[] = [];
  private blasts: Blast[] = [];

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

  /** True while something is animating (the caller keeps redrawing). */
  get animating(): boolean {
    return this.moves.length > 0 || this.blasts.length > 0;
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

  /** Slide a unit along the path it just moved (it is hidden at its new tile meanwhile). */
  animateMove(unitId: string, type: UnitTypeId, owner: PlayerId, from: Coord, steps: readonly Coord[], now: number): void {
    if (steps.length === 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const token: Token = { id: unitId, type, owner, hp: UNIT_TYPES[type].maxHp, ghost: false, own: true, spent: false, cargo: 0, stealth: false };
    this.moves = this.moves.filter((m) => m.unitId !== unitId);
    this.moves.push({ unitId, token, points: [from, ...steps], start: now });
  }

  /** Explosion and floating damage number at a tile. */
  blast(at: Coord, label: string, big: boolean, now: number): void {
    this.blasts.push({ at, start: now, label, big });
  }

  draw(view: PlayerView, overlay: Overlay, time: number): void {
    const { ctx, camera: cam } = this;
    const z = cam.zoom;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = UNEXPLORED;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    if (this.chunkView && (this.chunkView.width !== view.width || this.chunkView.height !== view.height)) this.chunks.clear();
    this.chunkView = view;

    const x0 = Math.max(0, Math.floor(cam.x));
    const y0 = Math.max(0, Math.floor(cam.y));
    const x1 = Math.min(view.width - 1, Math.ceil(cam.x + this.cssW / z));
    const y1 = Math.min(view.height - 1, Math.ceil(cam.y + this.cssH / z));
    const sx = (x: number) => (x - cam.x) * z;
    const sy = (y: number) => (y - cam.y) * z;
    const inView = (x: number, y: number) => x >= x0 && x <= x1 && y >= y0 && y <= y1;

    // 1. Terrain chunks
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (let cy = Math.floor(y0 / CHUNK); cy <= Math.floor(y1 / CHUNK); cy++) {
      for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) {
        const chunk = this.chunk(view, cx, cy);
        ctx.drawImage(chunk, sx(cx * CHUNK), sy(cy * CHUNK), CHUNK * z + 0.5, CHUNK * z + 0.5);
      }
    }

    // 2. Movement range: tinted tiles with an outline around the reachable area.
    if (overlay.reach && overlay.reach.size > 0) {
      for (const [i, r] of overlay.reach) {
        const x = i % view.width, y = Math.floor(i / view.width);
        if (!inView(x, y)) continue;
        ctx.fillStyle = r.kind === 'move' || r.kind === 'disembark' ? REACH : REACH_SPECIAL;
        ctx.fillRect(sx(x), sy(y), z, z);
      }
      ctx.strokeStyle = REACH_EDGE;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      const has = (x: number, y: number) => overlay.reach!.has(y * view.width + x) || (overlay.selectedUnit && overlay.selectedUnit.at.x === x && overlay.selectedUnit.at.y === y);
      for (const [i] of overlay.reach) {
        const x = i % view.width, y = Math.floor(i / view.width);
        if (!inView(x, y)) continue;
        const px = sx(x), py = sy(y);
        if (!has(x, y - 1)) { ctx.moveTo(px, py); ctx.lineTo(px + z, py); }
        if (!has(x, y + 1)) { ctx.moveTo(px, py + z); ctx.lineTo(px + z, py + z); }
        if (!has(x - 1, y)) { ctx.moveTo(px, py); ctx.lineTo(px, py + z); }
        if (!has(x + 1, y)) { ctx.moveTo(px + z, py); ctx.lineTo(px + z, py + z); }
      }
      ctx.stroke();
    }

    // 3. Cities
    const cityOwner = new Map<number, PlayerId | null>();
    for (const c of view.knownCities) cityOwner.set(c.position.y * view.width + c.position.x, c.owner);
    for (const c of view.ownCities) cityOwner.set(c.position.y * view.width + c.position.x, c.owner);
    for (const [i, owner] of cityOwner) {
      const x = i % view.width, y = Math.floor(i / view.width);
      if (inView(x, y)) this.drawCity(sx(x), sy(y), z, owner, x, y);
    }

    // 4. Fog of war, with soft edges (a 1-px-per-tile mask scaled up smoothly).
    this.drawFog(view, sx(0), sy(0), z);

    // 5. Units: top-level only (cargo shows as a badge on its carrier).
    const animating = new Set(this.moves.map((m) => m.unitId));
    const stacks = new Map<number, Token[]>();
    const add = (c: Coord, t: Token) => {
      if (animating.has(t.id)) return;
      const i = c.y * view.width + c.x;
      const list = stacks.get(i);
      if (list) list.push(t);
      else stacks.set(i, [t]);
    };
    for (const u of view.ownUnits) {
      if (u.carriedBy !== null) continue;
      add(u.position, {
        id: u.id, type: u.type, owner: u.owner, hp: u.hp, ghost: false, own: true,
        spent: u.movesLeft <= 0, cargo: u.cargo.length, stealth: u.silentRunning,
      });
    }
    for (const u of view.foreignUnits) {
      add(u.position, { id: u.id, type: u.type, owner: u.owner, hp: u.hp, ghost: false, own: false, spent: false, cargo: 0, stealth: false });
    }
    for (const g of view.ghosts) {
      add(g.position, { id: g.id, type: g.type, owner: g.owner, hp: UNIT_TYPES[g.type].maxHp, ghost: true, own: false, spent: false, cargo: 0, stealth: false });
    }
    const selectedAt = overlay.selectedUnit?.at;
    for (const [i, tokens] of stacks) {
      const x = i % view.width, y = Math.floor(i / view.width);
      if (!inView(x, y)) continue;
      // The selected unit is shown on top of its stack; otherwise the strongest defender.
      tokens.sort((a, b) =>
        Number(b.id === overlay.selectedUnit?.id) - Number(a.id === overlay.selectedUnit?.id) ||
        UNIT_TYPES[b.type].defense - UNIT_TYPES[a.type].defense,
      );
      const isSelected = !!selectedAt && selectedAt.x === x && selectedAt.y === y;
      this.drawToken(sx(x) + z / 2, sy(y) + z / 2, z, tokens[0]!, tokens.length, isSelected, time);
      // A garrisoned city stays readable: its banner and walls frame the counter.
      if (cityOwner.has(i)) this.drawCityFrame(sx(x), sy(y), z, cityOwner.get(i)!);
    }

    // Selected unit: a thick blinking magenta frame, a bit larger than the tile and
    // drawn over counters and city walls so nothing covers it.
    if (selectedAt && inView(selectedAt.x, selectedAt.y) && !animating.has(overlay.selectedUnit!.id)) {
      const ctx = this.ctx;
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const on = still || time % 800 < 520;
      const grow = z * 0.14;
      const px = sx(selectedAt.x) - grow, py = sy(selectedAt.y) - grow, size = z + 2 * grow;
      ctx.save();
      ctx.globalAlpha = on ? 1 : 0.35;
      ctx.shadowColor = SELECT;
      ctx.shadowBlur = on ? z * 0.5 : 0;
      ctx.strokeStyle = SELECT;
      ctx.lineWidth = Math.max(3, z / 7);
      ctx.beginPath();
      ctx.roundRect(px, py, size, size, z * 0.18);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, z / 20);
      ctx.beginPath();
      ctx.roundRect(px + z * 0.09, py + z * 0.09, size - z * 0.18, size - z * 0.18, z * 0.12);
      ctx.stroke();
      ctx.restore();
    }

    // Siege ring: a dashed red ring with spikes around every besieged city.
    if (overlay.besieged?.size) {
      const ctx = this.ctx;
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 82, 82, 0.9)';
      ctx.lineWidth = Math.max(1.5, z / 14);
      ctx.setLineDash([z * 0.12, z * 0.08]);
      ctx.lineDashOffset = -time / 120;
      for (const i of overlay.besieged) {
        const x = i % view.width, y = Math.floor(i / view.width);
        if (!inView(x, y)) continue;
        const cx = sx(x) + z / 2, cy = sy(y) + z / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, z * 0.62, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 6. Attack targets: pulsing red reticles (solid: in range now; dashed: move first).
    for (const [set, dashed] of [[overlay.targets, false], [overlay.assaults, true]] as const) {
      if (!set) continue;
      const pulse = (Math.sin(time / 180) + 1) / 2;
      ctx.strokeStyle = TARGET;
      ctx.lineWidth = 2;
      ctx.globalAlpha = dashed ? 0.75 : 1;
      ctx.setLineDash(dashed ? [z * 0.12, z * 0.1] : []);
      for (const i of set) {
        const x = i % view.width, y = Math.floor(i / view.width);
        if (!inView(x, y)) continue;
        const cx = sx(x) + z / 2, cy = sy(y) + z / 2;
        const r = z * (0.5 + pulse * 0.06);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        for (const a of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
          ctx.moveTo(cx + Math.cos(a) * (r - z * 0.16), cy + Math.sin(a) * (r - z * 0.16));
          ctx.lineTo(cx + Math.cos(a) * (r + z * 0.12), cy + Math.sin(a) * (r + z * 0.12));
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
    }

    // 7. Planned path
    if (overlay.path && overlay.path.length > 0 && overlay.selectedUnit) this.drawPath(overlay.selectedUnit.at, overlay.path);

    // 8. Animations
    this.drawMoves(time);
    this.drawBlasts(time);

    // 9. Hover and selected tile
    if (overlay.hover && inView(overlay.hover.x, overlay.hover.y)) {
      ctx.strokeStyle = 'rgba(230, 238, 244, 0.6)';
      ctx.lineWidth = 1;
      ctx.strokeRect(sx(overlay.hover.x) + 0.5, sy(overlay.hover.y) + 0.5, z - 1, z - 1);
    }
    if (overlay.selectedTile) {
      const px = sx(overlay.selectedTile.x), py = sy(overlay.selectedTile.y);
      ctx.strokeStyle = SELECT;
      ctx.lineWidth = Math.max(2, z / 12);
      ctx.strokeRect(px + 1, py + 1, z - 2, z - 2);
    }
  }

  // ─── Terrain ────────────────────────────────────────────────────────────────

  /** Chunk canvas, repainted when the number of explored tiles in it changes. */
  private chunk(view: PlayerView, cx: number, cy: number): HTMLCanvasElement {
    const key = `${cx},${cy}`;
    let sig = 0;
    for (let y = cy * CHUNK - 1; y <= cy * CHUNK + CHUNK; y++) {
      for (let x = cx * CHUNK - 1; x <= cx * CHUNK + CHUNK; x++) {
        if (x >= 0 && y >= 0 && x < view.width && y < view.height && view.terrain[y * view.width + x] !== UNKNOWN_TERRAIN) sig++;
      }
    }
    const hit = this.chunks.get(key);
    if (hit && hit.sig === sig) {
      this.chunks.delete(key); // LRU: move to the end
      this.chunks.set(key, hit);
      return hit.canvas;
    }
    const canvas = hit?.canvas ?? document.createElement('canvas');
    canvas.width = CHUNK * TILE_PX;
    canvas.height = CHUNK * TILE_PX;
    paintChunk(canvas.getContext('2d')!, view, cx * CHUNK, cy * CHUNK);
    this.chunks.delete(key);
    this.chunks.set(key, { canvas, sig });
    while (this.chunks.size > MAX_CACHED_CHUNKS) this.chunks.delete(this.chunks.keys().next().value!);
    return canvas;
  }

  private drawFog(view: PlayerView, ox: number, oy: number, z: number): void {
    if (this.fogView !== view) {
      this.fogView = view;
      const c = this.fogCanvas;
      c.width = view.width;
      c.height = view.height;
      const fctx = c.getContext('2d')!;
      const img = fctx.createImageData(view.width, view.height);
      for (let i = 0; i < view.visibility.length; i++) {
        const v = view.visibility[i]!;
        img.data[i * 4] = FOG_RGB[0];
        img.data[i * 4 + 1] = FOG_RGB[1];
        img.data[i * 4 + 2] = FOG_RGB[2];
        img.data[i * 4 + 3] = v === TileVisibility.Unexplored ? 255 : v === TileVisibility.Fogged ? 120 : 0;
      }
      fctx.putImageData(img, 0, 0);
    }
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    // Smoothing blends neighbouring tiles' fog: soft edges at no cost.
    ctx.drawImage(this.fogCanvas, ox, oy, view.width * z, view.height * z);
  }

  // ─── Cities and units ───────────────────────────────────────────────────────

  private drawCity(px: number, py: number, z: number, owner: PlayerId | null, tx: number, ty: number): void {
    const ctx = this.ctx;
    const color = this.factionOf(owner);
    const h = hash(tx, ty);
    // Walls / plate
    ctx.save();
    ctx.fillStyle = 'rgba(8, 14, 20, 0.78)';
    ctx.beginPath();
    ctx.roundRect(px + z * 0.06, py + z * 0.14, z * 0.88, z * 0.8, z * 0.12);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, z / 16);
    ctx.stroke();
    // Skyline: buildings with lit windows
    const base = py + z * 0.86;
    const widths = [0.16, 0.13, 0.2, 0.14, 0.17];
    let x = px + z * 0.12;
    widths.forEach((w, k) => {
      const height = z * (0.25 + (((h >> (k * 3)) & 7) / 7) * 0.4);
      ctx.fillStyle = k % 2 ? '#2a3a4a' : '#344758';
      ctx.fillRect(x, base - height, z * w - 1, height);
      if (z >= 22) {
        ctx.fillStyle = owner ? color : 'rgba(255, 230, 160, 0.7)';
        for (let wy = base - height + z * 0.06; wy < base - z * 0.06; wy += z * 0.1) {
          if (((h >> ((k + Math.round(wy)) % 13)) & 1) === 0) ctx.fillRect(x + z * 0.03, wy, Math.max(1, z * 0.035), Math.max(1, z * 0.035));
        }
      }
      x += z * w;
    });
    // Banner
    ctx.fillStyle = color;
    ctx.fillRect(px + z * 0.06, py + z * 0.14, z * 0.88, Math.max(2, z * 0.07));
    ctx.restore();
  }

  private drawCityFrame(px: number, py: number, z: number, owner: PlayerId | null): void {
    const ctx = this.ctx;
    const color = this.factionOf(owner);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1.5, z / 16);
    ctx.beginPath();
    ctx.roundRect(px + 1.5, py + 1.5, z - 3, z - 3, z * 0.14);
    ctx.stroke();
    // Little tower in the corner: "this is a city".
    const s = Math.max(6, z * 0.26);
    const bx = px + z - s - 1, by = py + z - s - 1;
    ctx.fillStyle = 'rgba(8, 14, 20, 0.9)';
    ctx.fillRect(bx - 1, by - 1, s + 2, s + 2);
    ctx.fillStyle = color;
    ctx.fillRect(bx + s * 0.1, by + s * 0.35, s * 0.25, s * 0.6);
    ctx.fillRect(bx + s * 0.4, by + s * 0.1, s * 0.22, s * 0.85);
    ctx.fillRect(bx + s * 0.68, by + s * 0.5, s * 0.22, s * 0.45);
    ctx.restore();
  }

  private drawToken(cx: number, cy: number, z: number, t: Token, count: number, selected: boolean, time: number): void {
    const ctx = this.ctx;
    const color = this.factionOf(t.owner);
    const domain = UNIT_TYPES[t.type].domain;
    const w = z * 0.84;
    const h = domain === 'sea' ? z * 0.6 : domain === 'air' ? z * 0.8 : z * 0.72;
    ctx.save();
    ctx.globalAlpha = t.ghost ? 0.45 : 1;

    if (selected) {
      // The whole tile blinks magenta with a white frame, under the counter: visible
      // on any terrain and next to any faction color.
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const on = still || time % 800 < 520;
      const px = cx - z / 2, py = cy - z / 2;
      const lw = Math.max(2, z / 10);
      ctx.save();
      ctx.fillStyle = SELECT;
      ctx.globalAlpha = on ? 0.62 : 0.18;
      ctx.fillRect(px, py, z, z);
      ctx.globalAlpha = on ? 1 : 0.45;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = lw;
      ctx.strokeRect(px + lw / 2, py + lw / 2, z - lw, z - lw);
      ctx.restore();
      // Chevron above, outlined so it reads over the tile above too.
      const bob = still ? 0 : Math.sin(time / 160) * z * 0.06;
      const ay = cy - z * 0.8 + bob;
      ctx.beginPath();
      ctx.moveTo(cx - z * 0.18, ay - z * 0.16);
      ctx.lineTo(cx + z * 0.18, ay - z * 0.16);
      ctx.lineTo(cx, ay + z * 0.05);
      ctx.closePath();
      ctx.fillStyle = SELECT;
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = Math.max(1, z / 24);
      ctx.stroke();
    }

    // Counter plate: rounded square (land), hull pill (sea), disc (air).
    ctx.beginPath();
    if (domain === 'air') ctx.arc(cx, cy, h / 2, 0, Math.PI * 2);
    else ctx.roundRect(cx - w / 2, cy - h / 2, w, h, domain === 'sea' ? h / 2 : z * 0.12);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = z * 0.12;
    ctx.shadowOffsetY = z * 0.05;
    if (t.ghost) {
      ctx.fillStyle = 'rgba(8, 14, 20, 0.6)';
    } else {
      const g = ctx.createLinearGradient(cx, cy - h / 2, cx, cy + h / 2);
      g.addColorStop(0, shade(color, 0.25));
      g.addColorStop(1, shade(color, -0.2));
      ctx.fillStyle = g;
    }
    ctx.fill();
    ctx.restore();
    ctx.lineWidth = Math.max(1, z / 22);
    ctx.strokeStyle = t.ghost ? color : 'rgba(0, 0, 0, 0.55)';
    if (t.ghost || t.stealth) ctx.setLineDash([z / 9, z / 12]);
    ctx.stroke();
    ctx.setLineDash([]);

    drawUnitIcon(ctx, t.type, cx, cy + (domain === 'sea' ? z * 0.02 : 0), h * (domain === 'air' ? 0.66 : 0.72), t.ghost ? color : INK_DARK);

    // Spent own units are dimmed; ready ones carry a bright dot.
    if (t.own && t.spent) {
      ctx.fillStyle = 'rgba(4, 8, 13, 0.5)';
      ctx.beginPath();
      if (domain === 'air') ctx.arc(cx, cy, h / 2, 0, Math.PI * 2);
      else ctx.roundRect(cx - w / 2, cy - h / 2, w, h, domain === 'sea' ? h / 2 : z * 0.12);
      ctx.fill();
    } else if (t.own && z >= 16) {
      ctx.fillStyle = READY_DOT;
      ctx.beginPath();
      ctx.arc(cx - w / 2 + z * 0.08, cy - h / 2 + z * 0.08, Math.max(2, z * 0.07), 0, Math.PI * 2);
      ctx.fill();
    }

    // Health bar when damaged
    const maxHp = UNIT_TYPES[t.type].maxHp;
    if (!t.ghost && t.hp < maxHp && z >= 14) {
      const bw = z * 0.72, bh = Math.max(2, z / 14);
      const by = cy + h / 2 + z * 0.04;
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(cx - bw / 2, by, bw, bh);
      const f = t.hp / maxHp;
      ctx.fillStyle = f > 0.5 ? '#7dff9a' : f > 0.25 ? '#ffc04a' : '#ff5a6e';
      ctx.fillRect(cx - bw / 2, by, bw * f, bh);
    }

    const badge = (text: string, bx: number, by: number, bg: string) => {
      const s = Math.max(10, z * 0.32);
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.roundRect(bx - s * 0.6, by - s / 2, s * 1.2, s, s / 2);
      ctx.fill();
      ctx.fillStyle = INK_DARK;
      ctx.font = `700 ${Math.round(s * 0.66)}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, bx, by + 0.5);
    };
    if (z >= 18 && count > 1) badge(String(count), cx + w / 2, cy - h / 2, INK);
    if (z >= 18 && t.cargo > 0) badge(`+${t.cargo}`, cx + w / 2, cy + h / 2, ACTIVE);
    ctx.restore();
  }

  private drawPath(from: Coord, steps: readonly PathStep[]): void {
    const { ctx, camera: cam } = this;
    const z = cam.zoom;
    const cx = (c: Coord) => (c.x + 0.5 - cam.x) * z;
    const cy = (c: Coord) => (c.y + 0.5 - cam.y) * z;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Glow underlay, then the line itself (solid this turn, dashed later turns).
    for (const pass of [0, 1]) {
      let prev = from;
      for (const s of steps) {
        ctx.strokeStyle = pass === 0 ? 'rgba(0,0,0,0.5)' : s.turn === 0 ? PATH : PATH_LATER;
        ctx.lineWidth = pass === 0 ? Math.max(5, z / 5) : Math.max(2.5, z / 11);
        ctx.setLineDash(s.turn === 0 || pass === 0 ? [] : [z / 6, z / 7]);
        ctx.beginPath();
        ctx.moveTo(cx(prev), cy(prev));
        ctx.lineTo(cx(s.coord), cy(s.coord));
        ctx.stroke();
        prev = s.coord;
      }
    }
    ctx.setLineDash([]);
    steps.forEach((s, i) => {
      const last = i === steps.length - 1 || steps[i + 1]!.turn !== s.turn;
      if (!last) return;
      const rr = Math.max(8, z * 0.26);
      ctx.fillStyle = INK_DARK;
      ctx.strokeStyle = s.turn === 0 ? PATH : PATH_LATER;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx(s.coord), cy(s.coord), rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.font = `600 ${Math.round(rr * 1.05)}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(s.turn + 1), cx(s.coord), cy(s.coord) + 0.5);
    });
    ctx.restore();
  }

  private drawMoves(time: number): void {
    const z = this.camera.zoom;
    this.moves = this.moves.filter((m) => time - m.start < (m.points.length - 1) * STEP_MS + 30);
    for (const m of this.moves) {
      // rAF timestamps can be slightly older than the moment the move was queued.
      const f = Math.max(0, Math.min(m.points.length - 1, (time - m.start) / STEP_MS));
      const i = Math.floor(f);
      const a = m.points[i]!, b = m.points[Math.min(i + 1, m.points.length - 1)]!;
      const t = f - i;
      const x = (a.x + (b.x - a.x) * t + 0.5 - this.camera.x) * z;
      const y = (a.y + (b.y - a.y) * t + 0.5 - this.camera.y) * z;
      this.drawToken(x, y, z, m.token, 1, false, time);
    }
  }

  private drawBlasts(time: number): void {
    const { ctx, camera: cam } = this;
    const z = cam.zoom;
    this.blasts = this.blasts.filter((b) => time - b.start < BLAST_MS);
    for (const b of this.blasts) {
      const t = Math.max(0, (time - b.start) / BLAST_MS);
      const cx = (b.at.x + 0.5 - cam.x) * z, cy = (b.at.y + 0.5 - cam.y) * z;
      ctx.save();
      // Flash and shockwave
      ctx.globalAlpha = Math.max(0, 1 - t * 1.6);
      const r = z * (0.3 + t * (b.big ? 1.1 : 0.7));
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, '#fff6d0');
      g.addColorStop(0.4, '#ffae3d');
      g.addColorStop(1, 'rgba(255, 80, 40, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      // Sparks
      ctx.globalAlpha = Math.max(0, 1 - t);
      ctx.fillStyle = '#ffd27a';
      for (let k = 0; k < 10; k++) {
        const ang = (k / 10) * Math.PI * 2 + (b.at.x * 7 + b.at.y) * 0.3;
        const d = z * (0.2 + t * 0.9);
        ctx.fillRect(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d, Math.max(1.5, z / 20), Math.max(1.5, z / 20));
      }
      // Floating damage number
      ctx.globalAlpha = Math.max(0, 1 - t * t);
      ctx.fillStyle = '#ff6b6b';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.font = `700 ${Math.round(Math.max(13, z * 0.42))}px "IBM Plex Mono", ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ty = cy - z * 0.5 - t * z * 0.7;
      ctx.strokeText(b.label, cx, ty);
      ctx.fillText(b.label, cx, ty);
      ctx.restore();
    }
  }
}

// ─── Terrain painting (static per explored state, cached in chunks) ─────────────

function paintChunk(ctx: CanvasRenderingContext2D, view: PlayerView, ox: number, oy: number): void {
  const T = TILE_PX;
  ctx.clearRect(0, 0, CHUNK * T, CHUNK * T);
  const code = (x: number, y: number) =>
    x < 0 || y < 0 || x >= view.width || y >= view.height ? UNKNOWN_TERRAIN : view.terrain[y * view.width + x]!;
  const terrain = (x: number, y: number): Terrain | null => {
    const c = code(x, y);
    return c === UNKNOWN_TERRAIN ? null : TERRAINS[c]!;
  };
  const isLand = (x: number, y: number) => {
    const c = code(x, y);
    return c !== UNKNOWN_TERRAIN && !isWaterCode(c);
  };
  const px = (x: number) => (x - ox) * T;
  const py = (y: number) => (y - oy) * T;
  const range = (f: (x: number, y: number) => void) => {
    for (let y = oy - 1; y <= oy + CHUNK; y++) for (let x = ox - 1; x <= ox + CHUNK; x++) f(x, y);
  };
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]] as const;

  // Water (explored tiles of any kind get water underneath, so coasts blend).
  range((x, y) => {
    const t = terrain(x, y);
    if (!t) return;
    const h = hash(x, y);
    const deep = t === 'deep_ocean';
    ctx.fillStyle = deep ? ((h & 3) === 0 ? WATER.deepLight : WATER.deep) : (h & 3) === 0 ? WATER.shallowLight : WATER.shallow;
    ctx.fillRect(px(x) - 0.5, py(y) - 0.5, T + 1, T + 1);
    if (isWaterCode(code(x, y)) && (h & 7) < 2) {
      ctx.strokeStyle = WATER.wave;
      ctx.lineWidth = 1.5;
      const wx = px(x) + ((h >> 4) & 15), wy = py(y) + ((h >> 8) & 15) + 6;
      ctx.beginPath();
      ctx.moveTo(wx, wy);
      ctx.quadraticCurveTo(wx + 5, wy - 4, wx + 10, wy);
      ctx.quadraticCurveTo(wx + 15, wy + 4, wx + 20, wy);
      ctx.stroke();
    }
  });

  // Land blobs: a disc per tile plus bridges to land neighbors give rounded coasts.
  const blob = (x: number, y: number, r: number, width: number, color: string) => {
    const cx = px(x) + T / 2, cy = py(y) + T / 2;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(cx, cy, r * T, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = width * T;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [dx, dy] of DIRS) {
      if (!isLand(x + dx, y + dy)) continue;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + dx * T, cy + dy * T);
    }
    ctx.stroke();
  };
  // Surf, then beach, then the terrain itself.
  range((x, y) => isLand(x, y) && blob(x, y, 0.74, 1.48, WATER.foam));
  range((x, y) => isLand(x, y) && blob(x, y, 0.68, 1.36, LAND.sand));
  range((x, y) => {
    const t = terrain(x, y);
    if (!t || !isLand(x, y)) return;
    const base = t === 'plains' ? ((hash(x, y) & 1) ? LAND.plains : LAND.plainsLight) : TERRAIN_COLOR[t];
    blob(x, y, 0.6, 1.2, base);
  });

  // Details
  range((x, y) => {
    const t = terrain(x, y);
    if (!t || !isLand(x, y)) return;
    const h = hash(x, y);
    const X = px(x), Y = py(y);
    switch (t) {
      case 'plains':
        ctx.fillStyle = LAND.grass;
        for (let k = 0; k < 5; k++) {
          const gx = X + 6 + ((h >> (k * 4)) & 15) * 1.3, gy = Y + 6 + ((h >> (k * 4 + 2)) & 15) * 1.3;
          ctx.fillRect(gx, gy, 2, 3);
        }
        break;
      case 'forest':
        for (let k = 0; k < 5; k++) {
          const tx = X + 7 + ((h >> (k * 5)) & 15) * 1.15, ty = Y + 8 + ((h >> (k * 5 + 3)) & 15) * 1.0;
          const r = 5 + ((h >> (k * 2)) & 3);
          ctx.fillStyle = 'rgba(0,0,0,0.25)';
          ctx.beginPath();
          ctx.arc(tx + 2, ty + 3, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = LAND.canopy;
          ctx.beginPath();
          ctx.arc(tx, ty, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = LAND.canopyLight;
          ctx.beginPath();
          ctx.arc(tx - r * 0.3, ty - r * 0.3, r * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      case 'hills':
        for (const [hx, hy, s] of [[0.32, 0.62, 0.3], [0.66, 0.5, 0.26]] as const) {
          const cx = X + hx * T, cy = Y + hy * T, r = s * T;
          ctx.fillStyle = LAND.hillsShade;
          ctx.beginPath();
          ctx.ellipse(cx + 2, cy + 2, r, r * 0.7, 0, Math.PI, 0);
          ctx.fill();
          ctx.fillStyle = LAND.hillsLight;
          ctx.beginPath();
          ctx.ellipse(cx, cy, r, r * 0.7, 0, Math.PI, 0);
          ctx.fill();
        }
        break;
      case 'mountains': {
        const peak = (cx: number, base: number, w: number, hgt: number) => {
          ctx.fillStyle = LAND.rockDark;
          ctx.beginPath();
          ctx.moveTo(cx - w, base);
          ctx.lineTo(cx, base - hgt);
          ctx.lineTo(cx + w, base);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = LAND.rockLight;
          ctx.beginPath();
          ctx.moveTo(cx - w, base);
          ctx.lineTo(cx, base - hgt);
          ctx.lineTo(cx - w * 0.15, base);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = LAND.snow;
          ctx.beginPath();
          ctx.moveTo(cx - w * 0.3, base - hgt * 0.7);
          ctx.lineTo(cx, base - hgt);
          ctx.lineTo(cx + w * 0.3, base - hgt * 0.7);
          ctx.closePath();
          ctx.fill();
        };
        peak(X + T * 0.62, Y + T * 0.85, T * 0.3, T * 0.62);
        peak(X + T * 0.34, Y + T * 0.9, T * 0.26, T * 0.5);
        break;
      }
    }
  });
}

/** Minimap: one block per tile, cities, visible enemies and the camera frame. */
export function drawMinimap(
  canvas: HTMLCanvasElement,
  view: PlayerView,
  camera: Camera,
  viewport: { w: number; h: number },
  factionOf: (p: PlayerId | null) => string,
): void {
  const ctx = canvas.getContext('2d')!;
  const scale = Math.min(canvas.width / view.width, canvas.height / view.height);
  const ox = (canvas.width - view.width * scale) / 2;
  const oy = (canvas.height - view.height * scale) / 2;
  ctx.fillStyle = UNEXPLORED;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < view.terrain.length; i++) {
    const code = view.terrain[i]!;
    if (code === UNKNOWN_TERRAIN) continue;
    const x = i % view.width, y = Math.floor(i / view.width);
    ctx.fillStyle = TERRAIN_COLOR[TERRAINS[code]!];
    ctx.fillRect(ox + x * scale, oy + y * scale, Math.ceil(scale), Math.ceil(scale));
    if (view.visibility[i] === TileVisibility.Fogged) {
      ctx.fillStyle = 'rgba(4, 8, 13, 0.45)';
      ctx.fillRect(ox + x * scale, oy + y * scale, Math.ceil(scale), Math.ceil(scale));
    }
  }
  const dot = Math.max(3, scale * 1.8);
  for (const c of [...view.ownCities, ...view.knownCities]) {
    ctx.fillStyle = factionOf(c.owner);
    ctx.fillRect(ox + c.position.x * scale - dot / 3, oy + c.position.y * scale - dot / 3, dot, dot);
  }
  for (const u of view.foreignUnits) {
    ctx.fillStyle = factionOf(u.owner);
    ctx.fillRect(ox + u.position.x * scale, oy + u.position.y * scale, Math.max(2, scale), Math.max(2, scale));
  }
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1;
  ctx.strokeRect(ox + camera.x * scale + 0.5, oy + camera.y * scale + 0.5, viewport.w * scale, viewport.h * scale);
  canvas.dataset.ox = String(ox);
  canvas.dataset.oy = String(oy);
  canvas.dataset.scale = String(scale);
}

function hash(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Lighten (amount > 0) or darken a #rrggbb color. */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(amount >= 0 ? v + (255 - v) * amount : v * (1 + amount));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}
