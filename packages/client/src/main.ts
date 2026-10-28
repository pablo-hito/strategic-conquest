import {
  UNIT_TYPES,
  UNIT_TYPE_IDS,
  CITY_SPECIALIZATIONS,
  TERRAINS,
  UNKNOWN_TERRAIN,
  type City,
  type Coord,
  type MapSize,
  type IslandDensity,
  type PlannedPath,
  type PlayerId,
  type ReachableTile,
  type TileIndex,
  type Unit,
  type UnitId,
  type CityId,
  type UnitTypeId,
} from '@sc/core';
import { SPECIALIZATION_NAME, TERRAIN_NAME, UNIT_CODE, UNIT_NAME, playerName } from './labels.js';
import { FACTION, NEUTRAL } from './palette.js';
import { MapRenderer, drawMinimap, type Camera } from './renderer.js';
import { GameSession, type NewGameOptions, type SavedSession } from './session.js';

const SAVE_KEY = 'strategic-conquest:save:v1';
const SEED_WORDS = ['tidewater', 'basalt', 'meridian', 'coral', 'halcyon', 'riptide', 'atoll', 'monsoon', 'saltmarsh', 'longitude', 'fathom', 'leeward'];

type Selection = { kind: 'unit'; id: UnitId } | { kind: 'city'; id: CityId } | { kind: 'tile'; at: Coord } | null;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const randomSeed = () => `${SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)]}-${Math.floor(Math.random() * 900 + 100)}`;
const sameCoord = (a: Coord, b: Coord) => a.x === b.x && a.y === b.y;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.innerHTML = html;
  return e;
}

class App {
  session!: GameSession;
  private sel: Selection = null;
  private hover: Coord | undefined;
  private reach: Map<TileIndex, ReachableTile> | undefined;
  private targets: Set<TileIndex> | undefined;
  private path: PlannedPath | null = null;
  private pathKey = '';
  private cameras = new Map<PlayerId, Camera>();
  private dirty = true;
  private toastTimer = 0;

  private readonly root = el('div', { class: 'app' });
  private readonly bar = el('header', { class: 'bar' });
  private readonly stage = el('main', { class: 'stage' });
  private readonly canvas = el('canvas', { id: 'map', 'aria-label': 'Mapa táctico' });
  private readonly status = el('div', { class: 'status', 'aria-live': 'polite' });
  private readonly toastEl = el('div', { class: 'toast', role: 'status' });
  private readonly side = el('aside', { class: 'side' });
  private readonly selPanel = el('section', { class: 'panel', id: 'selection' });
  private readonly mapPanel = el('section', { class: 'panel' });
  private readonly minimap = el('canvas', { id: 'minimap', width: '288', 'aria-label': 'Minimapa' });
  private readonly logPanel = el('section', { class: 'panel' });
  private readonly keysPanel = el('section', { class: 'panel' });
  private readonly overlay = el('div', { class: 'overlay' });
  private readonly renderer: MapRenderer;

  constructor() {
    this.toastEl.hidden = true;
    this.overlay.hidden = true;
    this.stage.append(this.canvas, this.status, this.toastEl, this.zoomButtons());
    this.mapPanel.append(el('h2', {}, 'Plano estratégico'), this.minimap);
    this.keysPanel.innerHTML = `<h2>Controles</h2><dl class="keys">
      <dt>Clic</dt><dd>Seleccionar · mover · atacar (objetivo en rojo)</dd>
      <dt>Arrastrar</dt><dd>Desplazar mapa · rueda: zoom</dd>
      <dt>N</dt><dd>Siguiente unidad disponible</dd>
      <dt>Espacio</dt><dd>Dejar la unidad quieta este turno</dd>
      <dt>S</dt><dd>Modo silencioso (submarinos)</dd>
      <dt>C</dt><dd>Centrar en la selección</dd>
      <dt>Esc</dt><dd>Deseleccionar</dd>
      <dt>Enter</dt><dd>Fin de turno</dd></dl>`;
    this.side.append(this.selPanel, this.mapPanel, this.logPanel, this.keysPanel);
    this.root.append(this.bar, this.stage, this.side);
    document.body.append(this.root, this.overlay);
    this.renderer = new MapRenderer(this.canvas, (p) => this.factionOf(p));
    this.bindInput();
    new ResizeObserver(() => {
      this.renderer.resize();
      this.dirty = true;
    }).observe(this.canvas);
    requestAnimationFrame((t) => this.frame(t));
  }

  // ─── Game lifecycle ────────────────────────────────────────────────────────

  start(saved?: SavedSession | null): void {
    try {
      this.session = saved?.version === 1 ? GameSession.restore(saved) : GameSession.create(this.defaultOptions());
    } catch {
      this.session = GameSession.create(this.defaultOptions());
    }
    this.cameras.clear();
    this.sel = null;
    this.focusViewer();
    this.refresh();
  }

  newGame(options: NewGameOptions): void {
    this.session = GameSession.create(options);
    this.cameras.clear();
    this.sel = null;
    this.focusViewer();
    this.refresh();
  }

  private defaultOptions(): NewGameOptions {
    return { size: 'small', density: 'normal', players: 2, seed: randomSeed() };
  }

  private focusViewer(): void {
    const p = this.session.viewer;
    const saved = this.cameras.get(p);
    if (saved) {
      Object.assign(this.renderer.camera, saved);
      return;
    }
    this.renderer.resize();
    const capital = this.session.world.citiesOf(p)[0] ?? this.session.world.unitsOf(p)[0];
    if (capital) this.renderer.centerOn(capital.position);
  }

  private factionOf(p: PlayerId | null): string {
    if (!p) return NEUTRAL;
    return FACTION[this.session.playerIndex(p)] ?? NEUTRAL;
  }

  /** Re-derive everything after a state change. */
  private refresh(): void {
    this.session.invalidate();
    this.recomputeReach();
    this.path = null;
    this.pathKey = '';
    this.updateHoverPath();
    this.renderBar();
    this.renderSelection();
    this.renderLog();
    this.renderOverlay();
    this.persist();
    this.dirty = true;
  }

  private persist(): void {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.session.save()));
    } catch {
      /* storage unavailable: the game still works, it just won't resume */
    }
  }

  // ─── Selection & commands ──────────────────────────────────────────────────

  private selectedUnit(): Unit | undefined {
    return this.sel?.kind === 'unit' ? this.session.ownUnit(this.sel.id) : undefined;
  }

  private recomputeReach(): void {
    const u = this.selectedUnit();
    this.reach = u ? this.session.reachable(u.id) : undefined;
    this.targets = u ? this.session.attackTargets(u.id) : undefined;
  }

  private select(sel: Selection, center = false): void {
    this.sel = sel;
    this.recomputeReach();
    this.path = null;
    this.pathKey = '';
    this.updateHoverPath();
    this.renderSelection();
    if (center) {
      const at = this.selectionCoord();
      if (at && !this.onScreen(at)) this.renderer.centerOn(at);
    }
    this.dirty = true;
  }

  private selectionCoord(): Coord | undefined {
    if (!this.sel) return undefined;
    if (this.sel.kind === 'unit') return this.session.ownUnit(this.sel.id)?.position;
    if (this.sel.kind === 'city') return this.session.world.city(this.sel.id)?.position;
    return this.sel.at;
  }

  private onScreen(c: Coord): boolean {
    const cam = this.renderer.camera;
    const { w, h } = this.renderer.viewportTiles;
    return c.x >= cam.x + 1 && c.y >= cam.y + 1 && c.x <= cam.x + w - 2 && c.y <= cam.y + h - 2;
  }

  private clickTile(t: Coord): void {
    const s = this.session;
    if (!s.world.grid.inBounds(t) || s.match.status !== 'playing') return;
    const unit = this.selectedUnit();
    if (unit && this.targets?.has(s.world.grid.index(t))) {
      const msg = s.attack(unit.id, t);
      if (msg) this.toast(msg);
      this.afterAction(unit.id);
      return;
    }
    if (unit && !sameCoord(unit.position, t)) {
      const plan = s.plan(unit.id, t);
      if (plan && plan.steps.length > 0) {
        const msg = s.moveTo(unit.id, t);
        if (msg) this.toast(msg);
        this.afterAction(unit.id);
        return;
      }
    }

    const own = s.ownUnitsAt(t);
    const city = s.world.cityAt(t);
    const ownCity = city?.owner === s.viewer ? city : undefined;
    if (own.length > 0) {
      const cur = this.sel?.kind === 'unit' ? own.findIndex((u) => u.id === (this.sel as { id: UnitId }).id) : -1;
      if (cur === own.length - 1 && ownCity) return this.select({ kind: 'city', id: ownCity.id });
      return this.select({ kind: 'unit', id: own[(cur + 1) % own.length]!.id });
    }
    if (ownCity) return this.select({ kind: 'city', id: ownCity.id });
    if (unit && this.hasForeignUnit(t)) {
      this.toast(unit.attackedThisTurn ? 'Esta unidad ya atacó este turno.' : unit.def.attack <= 0 ? 'Esta unidad no tiene armas.' : 'Fuera de alcance o no puede atacar ese objetivo: acercate primero.');
    }
    this.select({ kind: 'tile', at: t });
  }

  private hasForeignUnit(t: Coord): boolean {
    return this.session.view().foreignUnits.some((u) => sameCoord(u.position, t));
  }

  /** After moving: stay on the unit if it can still act, else hand over to the next one. */
  private afterAction(id: UnitId): void {
    this.refresh();
    const u = this.session.ownUnit(id);
    if (this.session.match.status !== 'playing') return;
    if (u && u.movesLeft > 0 && !this.session.orders.has(id)) return this.select({ kind: 'unit', id });
    const next = this.session.nextIdleUnit(id);
    this.select(next ? { kind: 'unit', id: next.id } : u ? { kind: 'unit', id } : null, true);
  }

  private nextUnit(): void {
    const cur = this.sel?.kind === 'unit' ? this.sel.id : undefined;
    const next = this.session.nextIdleUnit(cur);
    if (next) this.select({ kind: 'unit', id: next.id }, true);
    else this.toast('No quedan unidades por mover. Enter termina el turno.');
  }

  private skipUnit(): void {
    const u = this.selectedUnit();
    if (!u) return;
    this.session.skip(u.id);
    this.nextUnit();
  }

  private toggleSilent(): void {
    const u = this.selectedUnit();
    if (!u || !u.def.stealth) return;
    const msg = this.session.setSilentRunning(u.id, !u.silentRunning);
    if (msg) this.toast(msg);
    this.refresh();
  }

  private endTurn(): void {
    if (this.session.match.status !== 'playing') return;
    this.cameras.set(this.session.viewer, { ...this.renderer.camera });
    this.session.endTurn();
    this.sel = null;
    this.refresh();
  }

  private beginTurn(): void {
    this.session.beginTurn();
    this.focusViewer();
    this.refresh();
    const next = this.session.nextIdleUnit();
    if (next) this.select({ kind: 'unit', id: next.id }, true);
  }

  private updateHoverPath(): void {
    const u = this.selectedUnit();
    if (!u || !this.hover || sameCoord(u.position, this.hover)) {
      this.path = null;
      this.pathKey = '';
      return;
    }
    const key = `${u.id}@${this.hover.x},${this.hover.y}:${u.position.x},${u.position.y}:${u.movesLeft}`;
    if (key === this.pathKey) return;
    this.pathKey = key;
    this.path = this.session.plan(u.id, this.hover);
  }

  // ─── Rendering ─────────────────────────────────────────────────────────────

  private frame(time: number): void {
    const view = this.session ? this.session.view() : null;
    if (view && (this.dirty || this.sel) && !this.session.awaitingHandoff) {
      const r = this.renderer;
      r.clamp(view.width, view.height);
      const u = this.selectedUnit();
      r.draw(
        view,
        {
          selectedUnit: u ? { id: u.id, at: u.position } : undefined,
          selectedTile: this.sel && this.sel.kind !== 'unit' ? this.selectionCoord() : undefined,
          reach: this.reach,
          targets: this.targets,
          path: this.path?.steps,
          hover: this.hover,
        },
        time,
      );
      if (this.dirty) {
        drawMinimap(this.minimap, view, r.camera, r.viewportTiles, (p) => this.factionOf(p));
        this.renderStatus();
      }
      this.dirty = false;
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  private renderBar(): void {
    const s = this.session;
    const p = s.viewer;
    const idle = s.world.unitsOf(p).filter((u) => u.movesLeft > 0 && !s.skipped.has(u.id) && !s.orders.has(u.id)).length;
    this.bar.innerHTML = `
      <div class="brand">Strategic <span>Conquest</span></div>
      <div class="readout">
        <span>Ronda <b>${s.match.round}</b></span>
        <span class="chip" style="--faction:${this.factionOf(p)}">${esc(playerName(s.playerIndex(p)))}</span>
        <span>Ciudades <b>${s.world.citiesOf(p).length}</b>/${[...s.world.allCities()].length}</span>
        <span>Por mover <b>${idle}</b></span>
      </div>
      <div class="spacer"></div>
      <div class="actions">
        <button class="btn" id="btn-new" type="button">Nueva partida</button>
        <button class="btn primary" id="btn-end" type="button">Fin de turno <kbd>Enter</kbd></button>
      </div>`;
    this.bar.querySelector('#btn-new')!.addEventListener('click', () => this.showSetup());
    this.bar.querySelector<HTMLButtonElement>('#btn-end')!.addEventListener('click', () => this.endTurn());
  }

  private renderStatus(): void {
    const h = this.hover;
    const view = this.session.view();
    if (!h || h.x < 0 || h.y < 0 || h.x >= view.width || h.y >= view.height) {
      this.status.innerHTML = `<span>Zoom <b>${Math.round(this.renderer.camera.zoom)}px</b></span>`;
      return;
    }
    const i = h.y * view.width + h.x;
    const code = view.terrain[i]!;
    const terrain = code === UNKNOWN_TERRAIN ? 'Sin explorar' : TERRAIN_NAME[TERRAINS[code]!];
    const vis = ['', ' · en niebla', ' · a la vista'][view.visibility[i]!];
    const parts = [`<span>X<b>${String(h.x).padStart(3, '0')}</b> Y<b>${String(h.y).padStart(3, '0')}</b></span>`, `<span><b>${terrain}</b>${vis}</span>`];
    const sel = this.selectedUnit();
    const fc = sel && this.targets?.has(i) ? this.session.forecast(sel.id, h) : null;
    if (fc) {
      const fmt = (n: number) => n.toFixed(1).replace(/\.0$/, '');
      parts.push(`<span class="fc">Ataque: daño estimado <b>−${fmt(fc.damageToDefender)}</b>${fc.defenderCanCounter ? ` · contraataque <b>−${fmt(fc.damageToAttacker)}</b>` : ' · sin contraataque'}${fc.interceptionDamage ? ` · antiaéreo <b>−${fmt(fc.interceptionDamage)}</b>` : ''}</span>`);
    } else if (this.path) {
      parts.push(`<span>Ruta <b>${this.path.steps.length}</b> casillas · llega en <b>${this.path.turns}</b> turno${this.path.turns === 1 ? '' : 's'}</span>`);
    } else if (this.selectedUnit() && !sameCoord(this.selectedUnit()!.position, h)) {
      parts.push('<span>Sin ruta conocida</span>');
    }
    this.status.innerHTML = parts.join('');
  }

  private renderSelection(): void {
    const s = this.session;
    const p = this.selPanel;
    const sel = this.sel;
    if (sel?.kind === 'unit') {
      const u = s.ownUnit(sel.id);
      if (u) return this.renderUnit(u);
    }
    if (sel?.kind === 'city') {
      const c = s.world.city(sel.id);
      if (c && c.owner === s.viewer) return this.renderCity(c);
    }
    if (sel?.kind === 'tile') return this.renderTile(sel.at);

    const units = s.world.unitsOf(s.viewer);
    const idle = units.filter((u) => u.movesLeft > 0 && !s.skipped.has(u.id) && !s.orders.has(u.id));
    p.innerHTML = `<h2>Selección</h2>
      <p class="muted">Elegí una unidad o una ciudad en el mapa. Con una unidad elegida, pasá el cursor para ver la ruta y hacé clic para mover.</p>
      <dl class="stats"><dt>Unidades</dt><dd>${units.length}</dd><dt>Por mover</dt><dd>${idle.length}</dd><dt>Órdenes en curso</dt><dd>${s.orders.size}</dd></dl>
      <div class="row"><button class="btn small" type="button" data-act="next">Siguiente unidad <kbd>N</kbd></button></div>`;
    p.querySelector('[data-act=next]')?.addEventListener('click', () => this.nextUnit());
  }

  private renderUnit(u: Unit): void {
    const s = this.session;
    const def = u.def;
    const color = this.factionOf(u.owner);
    const carrier = u.carriedBy ? s.world.unit(u.carriedBy) : undefined;
    const order = s.orders.get(u.id);
    const hpPct = (u.hp / def.maxHp) * 100;
    const meterColor = hpPct > 50 ? 'var(--good)' : hpPct > 25 ? 'var(--amber)' : 'var(--bad)';
    const cargo = u.cargo.map((id) => s.world.unit(id)!).filter(Boolean);
    const others = s.ownUnitsAt(u.position).filter((o) => o.id !== u.id && o.carriedBy === null);
    const supply = def.domain !== 'land' ? '' : u.turnsOutOfSupply === 0 ? 'Abastecida' : `Aislada ${u.turnsOutOfSupply} turno${u.turnsOutOfSupply === 1 ? '' : 's'}${u.isOutOfSupply ? ' · −25% def.' : ''}`;
    const range = def.attackRange ? `${def.attackRange.min}–${def.attackRange.max}` : '1';

    this.selPanel.innerHTML = `<h2>Unidad seleccionada</h2>
      <div class="title-row"><h3>${UNIT_NAME[u.type]}</h3><span class="code" style="--faction:${color}">${UNIT_CODE[u.type]} ${u.id.replace('u', '#')}</span></div>
      <p class="muted">X${u.position.x} Y${u.position.y}${carrier ? ` · a bordo de ${UNIT_NAME[carrier.type]}` : ''}${u.silentRunning ? ' · en silencio' : ''}</p>
      <dl class="stats">
        <dt>Vida</dt><dd class="meter"><i style="--v:${hpPct}%;--meter:${meterColor}"></i>${u.hp}/${def.maxHp}</dd>
        <dt>Movimiento</dt><dd>${u.movesLeft}/${u.maxMoves} PM</dd>
        ${u.fuel !== null ? `<dt>Combustible</dt><dd class="meter"><i style="--v:${(u.fuel / def.fuel!) * 100}%;--meter:var(--amber)"></i>${u.fuel}/${def.fuel}</dd>` : ''}
        <dt>Ataque · Def.</dt><dd>${def.attack} · ${def.defense}${u.entrenchment ? ` (+${u.entrenchment * 20}% atrinch.)` : ''}</dd>
        <dt>Alcance · Visión</dt><dd>${range} · ${def.vision}</dd>
        ${def.attack > 0 ? `<dt>Ataque</dt><dd>${u.attackedThisTurn ? 'Ya atacó este turno' : this.targets?.size ? `${this.targets.size} objetivo${this.targets.size === 1 ? '' : 's'} a tiro` : 'Sin objetivos a tiro'}</dd>` : ''}
        ${supply ? `<dt>Suministro</dt><dd>${supply}</dd>` : ''}
        ${def.cargo ? `<dt>Carga</dt><dd>${u.cargo.length}/${def.cargo.slots}</dd>` : ''}
      </dl>
      ${order ? `<p class="muted">Orden: ir a X${order.x} Y${order.y}. Sigue sola cada turno.</p>` : ''}
      <div class="row">
        <button class="btn small" type="button" data-act="skip">Quieta <kbd>Espacio</kbd></button>
        <button class="btn small" type="button" data-act="next">Siguiente <kbd>N</kbd></button>
        ${def.stealth ? `<button class="btn small" type="button" data-act="silent">${u.silentRunning ? 'Emerger' : 'Silencio'} <kbd>S</kbd></button>` : ''}
        ${order ? `<button class="btn small" type="button" data-act="cancel">Cancelar orden</button>` : ''}
      </div>
      ${cargo.length ? `<h2>A bordo</h2><ul class="list">${cargo.map((c) => `<li><button type="button" data-unit="${c.id}"><span>${UNIT_NAME[c.type]}</span><span class="tag">${c.movesLeft}/${c.maxMoves} PM</span></button></li>`).join('')}</ul>` : ''}
      ${others.length ? `<h2>En la misma casilla</h2><ul class="list">${others.map((c) => `<li><button type="button" data-unit="${c.id}"><span>${UNIT_NAME[c.type]}</span><span class="tag">${c.movesLeft}/${c.maxMoves} PM</span></button></li>`).join('')}</ul>` : ''}`;

    const q = (a: string) => this.selPanel.querySelector(`[data-act=${a}]`);
    q('skip')?.addEventListener('click', () => this.skipUnit());
    q('next')?.addEventListener('click', () => this.nextUnit());
    q('silent')?.addEventListener('click', () => this.toggleSilent());
    q('cancel')?.addEventListener('click', () => {
      this.session.cancelOrder(u.id);
      this.refresh();
    });
    this.selPanel.querySelectorAll<HTMLButtonElement>('[data-unit]').forEach((b) =>
      b.addEventListener('click', () => this.select({ kind: 'unit', id: b.dataset.unit as UnitId })),
    );
  }

  private renderCity(c: City): void {
    const s = this.session;
    const prod = c.production;
    const total = prod ? c.buildTurnsFor(prod.unit) : 0;
    const groups: [string, UnitTypeId[]][] = [
      ['Tierra', UNIT_TYPE_IDS.filter((t) => UNIT_TYPES[t].domain === 'land')],
      ['Mar', UNIT_TYPE_IDS.filter((t) => UNIT_TYPES[t].domain === 'sea')],
      ['Aire', UNIT_TYPE_IDS.filter((t) => UNIT_TYPES[t].domain === 'air')],
    ];
    const reason = (t: UnitTypeId) => {
      const r = c.canProduce(t);
      if (r.ok) return '';
      return r.error.code === 'REQUIRES_COAST' ? ' (requiere costa)' : ` (requiere ${SPECIALIZATION_NAME[UNIT_TYPES[t].requiresSpecialization!].toLowerCase()})`;
    };
    const options = groups
      .map(([label, ids]) => `<optgroup label="${label}">${ids.map((t) => {
        const why = reason(t);
        return `<option value="${t}" ${prod?.unit === t ? 'selected' : ''} ${why ? 'disabled' : ''}>${UNIT_NAME[t]} · ${c.buildTurnsFor(t)} t${why}</option>`;
      }).join('')}</optgroup>`)
      .join('');
    const specs = CITY_SPECIALIZATIONS.map((sp) => {
      const disabled = (sp === 'naval_yard' && !c.isCoastal) || (c.specialization !== 'none' && sp !== 'none' && sp !== c.specialization);
      return `<option value="${sp}" ${c.specialization === sp ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${SPECIALIZATION_NAME[sp]}</option>`;
    }).join('');
    const here = s.ownUnitsAt(c.position).filter((u) => u.carriedBy === null);

    this.selPanel.innerHTML = `<h2>Ciudad</h2>
      <div class="title-row"><h3>${esc(c.name)}</h3><span class="code" style="--faction:${this.factionOf(c.owner)}">${c.isCoastal ? 'PUERTO' : 'INTERIOR'}</span></div>
      <p class="muted">X${c.position.x} Y${c.position.y}${c.portDisabledTurns ? ` · puerto inutilizado ${c.portDisabledTurns} t` : ''}</p>
      <label class="field" for="prod">Producción
        <select id="prod">${prod ? '' : '<option value="" selected disabled>Elegí una unidad</option>'}${options}</select></label>
      ${prod ? `<dl class="stats"><dt>Progreso</dt><dd class="meter"><i style="--v:${(prod.progress / total) * 100}%;--meter:var(--accent)"></i>${prod.progress}/${total}</dd><dt>Lista en</dt><dd>${total - prod.progress} turno${total - prod.progress === 1 ? '' : 's'}</dd></dl>` : ''}
      <label class="field" for="spec">Especialización
        <select id="spec">${specs}</select></label>
      <p class="muted">Cambiar de unidad o de especialización descarta el progreso. Para pasar de una especialización a otra, primero volvé a "Sin especializar".</p>
      ${here.length ? `<h2>Guarnición</h2><ul class="list">${here.map((u) => `<li><button type="button" data-unit="${u.id}"><span>${UNIT_NAME[u.type]}</span><span class="tag">${u.movesLeft}/${u.maxMoves} PM</span></button></li>`).join('')}</ul>` : ''}`;

    this.selPanel.querySelector<HTMLSelectElement>('#prod')!.addEventListener('change', (e) => {
      const msg = s.setProduction(c.id, (e.target as HTMLSelectElement).value as UnitTypeId);
      if (msg) this.toast(msg);
      this.refresh();
    });
    this.selPanel.querySelector<HTMLSelectElement>('#spec')!.addEventListener('change', (e) => {
      const msg = s.setSpecialization(c.id, (e.target as HTMLSelectElement).value as never);
      if (msg) this.toast(msg);
      this.refresh();
    });
    this.selPanel.querySelectorAll<HTMLButtonElement>('[data-unit]').forEach((b) =>
      b.addEventListener('click', () => this.select({ kind: 'unit', id: b.dataset.unit as UnitId })),
    );
  }

  private renderTile(at: Coord): void {
    const view = this.session.view();
    const i = at.y * view.width + at.x;
    const code = view.terrain[i]!;
    const city = view.knownCities.find((k) => sameCoord(k.position, at));
    const foreign = view.foreignUnits.filter((u) => sameCoord(u.position, at));
    const ghosts = view.ghosts.filter((g) => sameCoord(g.position, at));
    const owner = (p: PlayerId | null) => (p ? playerName(this.session.playerIndex(p)) : 'Neutral');
    this.selPanel.innerHTML = `<h2>Casilla</h2>
      <div class="title-row"><h3>${code === UNKNOWN_TERRAIN ? 'Sin explorar' : TERRAIN_NAME[TERRAINS[code]!]}</h3><span class="code">X${at.x} Y${at.y}</span></div>
      ${city ? `<p class="muted"><b style="color:${this.factionOf(city.owner)}">${esc(city.name)}</b> · ${owner(city.owner)} · vista en la ronda ${city.lastSeenTurn}</p>` : ''}
      ${foreign.length ? `<ul class="list">${foreign.map((u) => `<li><button type="button" disabled><span>${UNIT_NAME[u.type]}</span><span class="tag" style="color:${this.factionOf(u.owner)}">${owner(u.owner)} · ${u.hp}/${UNIT_TYPES[u.type].maxHp}</span></button></li>`).join('')}</ul>` : ''}
      ${ghosts.length ? `<p class="muted">Último avistamiento: ${ghosts.map((g) => `${UNIT_NAME[g.type]} (ronda ${g.lastSeenTurn})`).join(', ')}.</p>` : ''}
      ${code !== UNKNOWN_TERRAIN && !city && !foreign.length && !ghosts.length ? '<p class="muted">Nada a la vista en esta casilla.</p>' : ''}`;
  }

  private renderLog(): void {
    const entries = this.session.visibleLog().slice(-40).reverse();
    this.logPanel.innerHTML = `<h2>Registro táctico</h2><ol class="log">${entries
      .map((e) => `<li data-tone="${e.tone}"><time>R${e.round}</time><span>${esc(e.text)}</span></li>`)
      .join('')}</ol>`;
  }

  private renderOverlay(): void {
    const s = this.session;
    const o = this.overlay;
    if (s.match.status === 'finished') {
      const w = s.match.winner;
      o.className = 'overlay';
      o.hidden = false;
      o.innerHTML = `<div class="sheet handoff" style="--faction:${this.factionOf(w)}">
        <div class="stripe"></div>
        <p class="muted">Partida terminada · ronda ${s.match.round}</p>
        <div class="big">${w ? esc(playerName(s.playerIndex(w))) : 'Empate'}</div>
        <p class="muted">${w ? 'gana la campaña' : 'No quedó nadie en pie.'}</p>
        <div class="row"><button class="btn primary" type="button" data-act="new">Nueva partida</button><button class="btn" type="button" data-act="look">Ver el mapa</button></div></div>`;
      o.querySelector('[data-act=new]')!.addEventListener('click', () => this.showSetup());
      o.querySelector('[data-act=look]')!.addEventListener('click', () => { o.hidden = true; });
      return;
    }
    if (s.awaitingHandoff) {
      const p = s.viewer;
      o.className = 'overlay opaque';
      o.hidden = false;
      o.innerHTML = `<div class="sheet handoff" style="--faction:${this.factionOf(p)}">
        <div class="stripe"></div>
        <p class="muted">Ronda ${s.match.round} · pasá el control</p>
        <div class="big">${esc(playerName(s.playerIndex(p)))}</div>
        <p class="muted">El mapa queda oculto hasta que el jugador correcto esté frente a la pantalla.</p>
        <button class="btn primary" type="button" data-act="begin">Empezar turno</button></div>`;
      const b = o.querySelector<HTMLButtonElement>('[data-act=begin]')!;
      b.addEventListener('click', () => this.beginTurn());
      setTimeout(() => b.focus(), 150);
      return;
    }
    if (!o.dataset.setup) o.hidden = true;
  }

  private showSetup(): void {
    const o = this.overlay;
    const prev = this.session?.options;
    o.className = 'overlay';
    o.hidden = false;
    o.dataset.setup = '1';
    const opt = (v: string, label: string, cur?: string) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${label}</option>`;
    o.innerHTML = `<form class="sheet" id="setup">
      <h2>Nueva partida</h2>
      <p class="muted">Partida local por turnos: los jugadores se turnan frente a esta pantalla. Cada uno ve sólo lo que descubrieron sus unidades.</p>
      <div class="grid2">
        <label class="field" for="size">Tamaño del mapa<select id="size">${opt('small', 'Small · 60×40', prev?.size)}${opt('medium', 'Medium · 100×64', prev?.size)}${opt('huge', 'Huge · 160×100', prev?.size)}</select></label>
        <label class="field" for="density">Densidad de islas<select id="density">${opt('sparse', 'Escasa · 22% tierra', prev?.density)}${opt('normal', 'Normal · 32% tierra', prev?.density ?? 'normal')}${opt('dense', 'Densa · 42% tierra', prev?.density)}</select></label>
        <label class="field" for="players">Jugadores<select id="players">${[2, 3, 4, 5, 6].map((n) => opt(String(n), `${n} jugadores`, String(prev?.players ?? 2))).join('')}</select></label>
        <label class="field" for="seed">Semilla del mapa<input type="text" id="seed" value="${esc(randomSeed())}" autocomplete="off" spellcheck="false" /></label>
      </div>
      <p class="muted">La misma semilla genera siempre el mismo mapa: compartila para jugar la misma geografía.</p>
      <div class="row"><button class="btn primary" type="submit">Generar y jugar</button><button class="btn" type="button" data-act="cancel">Cancelar</button></div>
    </form>`;
    const form = o.querySelector<HTMLFormElement>('#setup')!;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = (id: string) => (form.querySelector(`#${id}`) as HTMLInputElement).value;
      delete o.dataset.setup;
      this.newGame({ size: v('size') as MapSize, density: v('density') as IslandDensity, players: Number(v('players')), seed: v('seed').trim() || randomSeed() });
    });
    o.querySelector('[data-act=cancel]')!.addEventListener('click', () => {
      delete o.dataset.setup;
      o.hidden = true;
      this.renderOverlay();
    });
  }

  private toast(msg: string): void {
    this.toastEl.textContent = msg;
    this.toastEl.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { this.toastEl.hidden = true; }, 3200);
  }

  private zoomButtons(): HTMLElement {
    const box = el('div', { class: 'zoom' });
    const mk = (label: string, f: number, aria: string) => {
      const b = el('button', { type: 'button', 'aria-label': aria }, label);
      b.addEventListener('click', () => {
        const r = this.canvas.getBoundingClientRect();
        this.renderer.zoomAt(f, r.width / 2, r.height / 2);
        this.dirty = true;
      });
      return b;
    };
    box.append(mk('+', 1.25, 'Acercar'), mk('−', 0.8, 'Alejar'));
    return box;
  }

  // ─── Input ─────────────────────────────────────────────────────────────────

  private bindInput(): void {
    const c = this.canvas;
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { x: number; y: number; moved: boolean } | null = null;
    let pinch = 0;
    const local = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (e.button === 2) {
        this.select(null);
        return;
      }
      drag = { ...local(e), moved: false };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      }
    });
    c.addEventListener('pointermove', (e) => {
      const p = local(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pointers.size === 2 && pinch > 0) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        this.renderer.zoomAt(d / pinch, (a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
        pinch = d;
        if (drag) drag.moved = true;
        this.dirty = true;
        return;
      }
      if (drag && (e.buttons & 1 || e.pointerType !== 'mouse')) {
        const dx = p.x - drag.x, dy = p.y - drag.y;
        if (drag.moved || Math.hypot(dx, dy) > 5) {
          drag.moved = true;
          const z = this.renderer.camera.zoom;
          this.renderer.camera.x -= dx / z;
          this.renderer.camera.y -= dy / z;
          drag.x = p.x;
          drag.y = p.y;
          this.dirty = true;
        }
      }
      const t = this.renderer.screenToTile(p.x, p.y);
      if (!this.hover || !sameCoord(this.hover, t)) {
        this.hover = t;
        this.updateHoverPath();
        this.dirty = true;
      }
    });
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
      if (drag && !drag.moved && e.button !== 2 && pointers.size === 0) {
        const p = local(e);
        this.clickTile(this.renderer.screenToTile(p.x, p.y));
      }
      if (pointers.size === 0) drag = null;
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', (e) => {
      pointers.delete(e.pointerId);
      drag = null;
    });
    c.addEventListener('pointerleave', () => {
      this.hover = undefined;
      this.updateHoverPath();
      this.dirty = true;
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e);
      this.renderer.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
      this.dirty = true;
    }, { passive: false });

    this.minimap.addEventListener('click', (e) => {
      const r = this.minimap.getBoundingClientRect();
      const view = this.session.view();
      this.renderer.centerOn({
        x: Math.floor(((e.clientX - r.left) / r.width) * view.width),
        y: Math.floor(((e.clientY - r.top) / r.height) * view.height),
      });
      this.dirty = true;
    });

    window.addEventListener('keydown', (e) => {
      if (!this.overlay.hidden || (e.target as HTMLElement).closest('input, select, textarea')) return;
      const cam = this.renderer.camera;
      const step = 4;
      switch (e.key) {
        case 'Enter':
          // Without this, the same keypress would also activate the handoff button.
          e.preventDefault();
          this.endTurn();
          break;
        case 'n': case 'N': this.nextUnit(); break;
        case ' ': e.preventDefault(); this.skipUnit(); break;
        case 's': case 'S': this.toggleSilent(); break;
        case 'c': case 'C': { const at = this.selectionCoord(); if (at) this.renderer.centerOn(at); break; }
        case 'Escape': this.select(null); break;
        case 'ArrowLeft': cam.x -= step; break;
        case 'ArrowRight': cam.x += step; break;
        case 'ArrowUp': e.preventDefault(); cam.y -= step; break;
        case 'ArrowDown': e.preventDefault(); cam.y += step; break;
        case '+': case '=': this.renderer.zoomAt(1.25, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2); break;
        case '-': this.renderer.zoomAt(0.8, this.canvas.clientWidth / 2, this.canvas.clientHeight / 2); break;
        default: return;
      }
      this.dirty = true;
    });
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

interface HotHook {
  data?: unknown;
  snapshot?: (fn: () => unknown) => void;
  ready?: (fn: (data: unknown) => void) => void;
}

const app = new App();
const hot = (window as unknown as { claude?: { hot?: HotHook } }).claude?.hot;
hot?.snapshot?.(() => app.session?.save());

function loadSaved(data: unknown): SavedSession | null {
  if (data && typeof data === 'object' && (data as SavedSession).version === 1) return data as SavedSession;
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? (JSON.parse(raw) as SavedSession) : null;
  } catch {
    return null;
  }
}

if (hot?.ready) hot.ready((data) => app.start(loadSaved(data)));
else app.start(loadSaved(hot?.data));
