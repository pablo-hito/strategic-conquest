import {
  Match,
  STACK_LIMIT_CITY,
  STACK_LIMIT_FIELD,
  UNIT_TYPES,
  hasRoomFor,
  PlayerId,
  WorldState,
  buildPlayerView,
  findPath,
  forecastAttack,
  planAttack,
  fogKnowledge,
  generateMap,
  reachableThisTurn,
  type CityId,
  type CombatResult,
  type Forecast,
  type CitySpecialization,
  type Coord,
  type IslandDensity,
  type MapSize,
  type MatchSnapshot,
  type MoveOutcome,
  type PlannedPath,
  type PathStep,
  type PlayerView,
  type ReachableTile,
  type TileIndex,
  type TurnEvent,
  type Unit,
  type UnitId,
  type UnitTypeId,
} from '@sc/core';
import { botPersonality, playBotTurn } from '@sc/ai';
import { STOP_TEXT, UNIT_NAME, playerName } from './labels.js';

export interface AssaultPlan {
  /** Tile to attack from. */
  readonly approach: Coord;
  readonly path: readonly PathStep[];
  /** Expected outcome from that tile. */
  readonly forecast: Forecast;
  readonly score: number;
}

/** 'bots': player 1 is you, everyone else is the computer. 'hotseat': all humans. */
export type GameMode = 'bots' | 'hotseat' | 'online';

/** How much faster the computer's cities produce (it never sees more than you). */
export type Difficulty = 'normal' | 'hard' | 'brutal';
export const DIFFICULTY_BONUS: Record<Difficulty, number> = { normal: 0, hard: 0.25, brutal: 0.5 };

export interface NewGameOptions {
  /** A preset size, or any custom width × height. */
  readonly size: MapSize | { readonly width: number; readonly height: number };
  readonly density: IslandDensity;
  readonly players: number;
  readonly seed: string;
  readonly mode?: GameMode;
  readonly difficulty?: Difficulty;
}

export type Tone = 'info' | 'good' | 'warn' | 'bad';

export interface LogEntry {
  readonly round: number;
  readonly audience: PlayerId | 'all';
  readonly text: string;
  readonly tone: Tone;
  /** Where it happened, when it has a place on the map ("Ver" button). */
  readonly at?: Coord;
}

export interface SavedSession {
  readonly version: 1;
  readonly options: NewGameOptions;
  readonly match: MatchSnapshot;
  readonly log: LogEntry[];
  readonly orders: [UnitId, Coord][];
  readonly awaitingHandoff: boolean;
}

/**
 * Local hot-seat game: several humans share one screen. Wraps the authoritative
 * Match exactly like the server will, and only ever shows the active player their
 * own PlayerView, so the fog of war holds even on a shared screen (the handoff
 * screen hides the map between turns).
 */
export class GameSession {
  readonly log: LogEntry[] = [];
  /** Standing go-to orders, resumed at the start of the owner's turn. */
  readonly orders = new Map<UnitId, Coord>();
  /** Units the player chose to leave alone this turn (skipped by "next unit"). */
  readonly skipped = new Set<UnitId>();
  awaitingHandoff = false;
  protected cachedView: PlayerView | null = null;
  /** Players the computer controls. */
  readonly bots: ReadonlySet<PlayerId>;

  protected constructor(
    readonly options: NewGameOptions,
    /** The authoritative match locally; online, a "shadow" rebuilt from the server's view. */
    public match: Match,
  ) {
    this.bots = new Set(options.mode === 'bots' ? match.order.slice(1) : []);
  }

  static create(options: NewGameOptions): GameSession {
    const players = Array.from({ length: options.players }, (_, i) => PlayerId(`p${i + 1}`));
    const map = generateMap({ size: options.size, density: options.density, seed: options.seed }, players);
    const bonus = DIFFICULTY_BONUS[options.difficulty ?? 'normal'];
    const handicap = options.mode === 'bots' && bonus > 0 ? Object.fromEntries(players.slice(1).map((p) => [p, bonus])) : {};
    const { match, report } = Match.start(map.world, players, undefined, options.seed, handicap);
    const s = new GameSession(options, match);
    s.push('all', `Mapa "${options.seed}": ${map.report.cities} ciudades en ${map.report.islands} islas.`, 'info');
    s.pushEvents(report.events);
    return s;
  }

  static restore(saved: SavedSession): GameSession {
    const s = new GameSession(saved.options, Match.fromSnapshot(saved.match));
    s.log.push(...saved.log);
    for (const [id, c] of saved.orders) s.orders.set(id, c);
    s.awaitingHandoff = saved.awaitingHandoff;
    return s;
  }

  save(): SavedSession {
    return {
      version: 1,
      options: this.options,
      match: this.match.toSnapshot(),
      log: this.log.slice(-200),
      orders: [...this.orders],
      awaitingHandoff: this.awaitingHandoff,
    };
  }

  // ─── Read model ─────────────────────────────────────────────────────────────

  get world() { return this.match.world; }
  get players(): readonly PlayerId[] { return this.match.order; }
  /**
   * Whose eyes the screen shows. Against the computer it is always the human (even
   * while the bots play or after one wins), so a bot's view never leaks; between
   * humans it follows the turn (the handoff screen hides the switch).
   */
  get viewer(): PlayerId {
    if (this.bots.size > 0) return this.players.find((p) => !this.bots.has(p))!;
    return this.match.activePlayer ?? this.match.winner ?? this.players[0]!;
  }

  /** Cities on the whole map (online, the server says: the client doesn't see them all). */
  totalCities(): number {
    return [...this.world.allCities()].length;
  }

  /** Short label for a unit id: "#12" locally, the last characters of an opaque id online. */
  unitTag(id: string): string {
    return /^u\d+$/.test(id) ? id.replace('u', '#') : `#${id.slice(-3)}`;
  }

  playerIndex(p: PlayerId): number {
    return this.players.indexOf(p);
  }

  nameOf(p: PlayerId): string {
    return `${playerName(this.playerIndex(p))}${this.bots.has(p) ? ' (bot)' : ''}`;
  }

  /** Humans sharing the screen: the handoff screen only matters with more than one. */
  get humanCount(): number {
    return this.players.length - this.bots.size;
  }

  /** What the active player is allowed to see, rebuilt only when state changes. */
  view(): PlayerView {
    if (!this.cachedView) this.cachedView = buildPlayerView(this.world, this.match.fogs.get(this.viewer)!);
    return this.cachedView;
  }

  invalidate(): void {
    this.cachedView = null;
  }

  ownUnit(id: UnitId): Unit | undefined {
    const u = this.world.unit(id);
    return u && u.owner === this.viewer ? u : undefined;
  }

  /**
   * Cities the viewer can see are besieged (enemy units on half the tiles around and
   * none of the owner's outside), judged only from what the viewer sees.
   */
  besiegedTiles(): Set<TileIndex> {
    const v = this.view();
    const { grid } = this.world;
    const owners = new Map<TileIndex, Set<PlayerId>>();
    const put = (c: Coord, owner: PlayerId) => {
      const i = grid.index(c);
      (owners.get(i) ?? owners.set(i, new Set()).get(i)!).add(owner);
    };
    for (const u of v.ownUnits) if (u.carriedBy === null && UNIT_TYPES[u.type].domain !== 'air') put(u.position, u.owner);
    for (const u of v.foreignUnits) if (UNIT_TYPES[u.type].domain !== 'air') put(u.position, u.owner);
    const out = new Set<TileIndex>();
    for (const c of [...v.ownCities, ...v.knownCities]) {
      if (!c.owner) continue;
      const around = grid.neighbors(c.position);
      let enemy = 0;
      let relieved = false;
      for (const n of around) {
        const here = owners.get(grid.index(n));
        if (!here) continue;
        if (here.has(c.owner)) relieved = true;
        else enemy++;
      }
      if (!relieved && enemy * 2 >= around.length) out.add(grid.index(c.position));
    }
    return out;
  }

  /** Why a land unit can't end on `goal`, if the tile is full (stacking limit). */
  protected fullTileMessage(unit: Unit, goal: Coord): string | null {
    if (unit.def.domain !== 'land' || !this.world.grid.isLand(goal) || hasRoomFor(this.world, this.viewer, goal)) return null;
    return `Casilla llena: entran ${STACK_LIMIT_CITY} unidades de tierra en una ciudad y ${STACK_LIMIT_FIELD} en el campo.`;
  }

  /** Own units on a tile: top-level first, then cargo. */
  ownUnitsAt(c: Coord): Unit[] {
    return this.world
      .unitsAt(c)
      .filter((u) => u.owner === this.viewer)
      .sort((a, b) => Number(a.carriedBy !== null) - Number(b.carriedBy !== null));
  }

  reachable(id: UnitId): Map<TileIndex, ReachableTile> {
    const unit = this.ownUnit(id);
    if (!unit) return new Map();
    return reachableThisTurn(fogKnowledge(this.world, this.match.fogs.get(this.viewer)!), unit);
  }

  plan(id: UnitId, goal: Coord): PlannedPath | null {
    const unit = this.ownUnit(id);
    if (!unit) return null;
    return findPath(fogKnowledge(this.world, this.match.fogs.get(this.viewer)!), unit, goal);
  }

  /** Tiles the unit can attack right now, from where it stands. */
  attackTargets(id: UnitId): Set<TileIndex> {
    const out = new Set<TileIndex>();
    const unit = this.ownUnit(id);
    if (!unit || unit.def.attack <= 0 || unit.attackedThisTurn || unit.movesLeft <= 0) return out;
    const fog = this.match.fogs.get(this.viewer)!;
    const reach = unit.def.attackRange?.max ?? 1;
    const { grid } = this.world;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const c = { x: unit.position.x + dx, y: unit.position.y + dy };
        if (!grid.inBounds(c)) continue;
        if (planAttack(this.world, fog, this.viewer, id, c).ok) out.add(grid.index(c));
      }
    }
    return out;
  }

  /**
   * Enemies the unit can't hit from where it stands but can reach and hit this turn
   * (move next to them, then attack). Cheap check: no forecast.
   */
  assaultTargets(id: UnitId): Set<TileIndex> {
    const out = new Set<TileIndex>();
    const unit = this.ownUnit(id);
    if (!unit || unit.def.attack <= 0 || unit.attackedThisTurn || unit.def.indirectFire) return out;
    const direct = this.attackTargets(id);
    const reach = this.reachable(id);
    const { grid } = this.world;
    const fog = this.match.fogs.get(this.viewer)!;
    const range = unit.def.attackRange ?? { min: 1, max: 1 };
    for (const e of this.view().foreignUnits) {
      const i = grid.index(e.position);
      if (direct.has(i)) continue;
      if (grid.distance(unit.position, e.position) > unit.movesLeft + range.max) continue;
      const canStand = [...reach.values()].some((r) => {
        const d = grid.distance(r.coord, e.position);
        return r.movesLeft >= 1 && (r.kind === 'move' || r.kind === 'disembark') && d >= range.min && d <= range.max &&
          fog.isExplored(grid.index(r.coord));
      });
      if (canStand) out.add(i);
    }
    return out;
  }

  private assaultCache = new Map<string, AssaultPlan | null>();

  /**
   * Best way to move-and-attack `target` this turn: every tile in range that the unit
   * can reach with movement to spare is tried on a copy of the world (so the real game
   * is untouched), and the one with the best expected exchange wins.
   */
  assaultPlan(id: UnitId, target: Coord): AssaultPlan | null {
    const unit = this.ownUnit(id);
    if (!unit) return null;
    const key = `${id}:${unit.position.x},${unit.position.y}:${unit.movesLeft}:${target.x},${target.y}:${this.match.round}:${this.log.length}`;
    if (this.assaultCache.has(key)) return this.assaultCache.get(key)!;
    const { grid } = this.world;
    const range = unit.def.attackRange ?? { min: 1, max: 1 };
    // Only spots (and routes) over known terrain: through the fog the planner assumes
    // the cheapest ground, and a hill revealed on the way would leave no MP to attack.
    const fogMap = this.match.fogs.get(this.viewer)!;
    const known = (c: Coord) => fogMap.isExplored(grid.index(c));
    const spots = [...this.reachable(id).values()].filter((r) => {
      const d = grid.distance(r.coord, target);
      return r.movesLeft >= 1 && (r.kind === 'move' || r.kind === 'disembark') && d >= range.min && d <= range.max && known(r.coord);
    });
    let best: AssaultPlan | null = null;
    if (spots.length > 0) {
      const sandbox = WorldState.fromSnapshot(this.world.toSnapshot());
      const ghost = sandbox.unit(id)!;
      const fog = this.match.fogs.get(this.viewer)!;
      for (const spot of spots) {
        if (ghost.carriedBy) sandbox.unload(ghost.carriedBy, id);
        sandbox.stepUnit(id, spot.coord, 0); // teleport: only the position matters here
        const p = planAttack(sandbox, fog, this.viewer, id, target);
        if (!p.ok) continue;
        const f = forecastAttack(sandbox, p.value);
        const score = f.damageToDefender - f.damageToAttacker - f.interceptionDamage;
        const path = this.plan(id, spot.coord);
        if (!path || !path.steps.every((st) => known(st.coord))) continue;
        const better = !best || score > best.score + 0.01 || (Math.abs(score - best.score) <= 0.01 && path.steps.length < best.path.length);
        if (better) best = { approach: spot.coord, path: path.steps, forecast: f, score };
      }
    }
    this.assaultCache.set(key, best);
    if (this.assaultCache.size > 200) this.assaultCache.clear();
    return best;
  }

  /** Move to the best spot and attack, as one command. */
  assault(id: UnitId, target: Coord): string | null {
    const plan = this.assaultPlan(id, target);
    if (!plan) return 'No hay forma de atacar ese objetivo este turno.';
    const moved = this.moveTo(id, plan.approach);
    if (moved) return moved;
    const u = this.ownUnit(id);
    if (!u) return null; // lost on the way (it is in the log)
    if (u.position.x !== plan.approach.x || u.position.y !== plan.approach.y) {
      return 'El avance se detuvo antes de llegar: no hubo ataque.';
    }
    return this.attack(id, target);
  }

  /** Expected outcome of attacking `target`, or null if the attack isn't possible. */
  forecast(id: UnitId, target: Coord): Forecast | null {
    const fog = this.match.fogs.get(this.viewer)!;
    const p = planAttack(this.world, fog, this.viewer, id, target);
    return p.ok ? forecastAttack(this.world, p.value) : null;
  }

  /** Result of the player's latest attack (for the UI's explosion and damage numbers). */
  lastCombat: CombatResult | null = null;

  attack(id: UnitId, target: Coord): string | null {
    const r = this.match.attack(this.viewer, id, target);
    this.invalidate();
    if (!r.ok) return r.error.message;
    this.orders.delete(id);
    this.lastCombat = r.value.result;
    this.pushEvents(r.value.events);
    return null;
  }

  // ─── Joint assault and loading ──────────────────────────────────────────────

  /**
   * Own units that can strike `target` right now without moving, best first: those
   * that take no return fire (artillery, ships shelling from range), then by damage.
   * Attacks the forecast says would kill the attacker are left out.
   */
  strikersAt(target: Coord): { unit: Unit; forecast: Forecast }[] {
    const out: { unit: Unit; forecast: Forecast }[] = [];
    for (const u of this.world.unitsOf(this.viewer)) {
      if (u.def.attack <= 0 || u.attackedThisTurn || u.movesLeft <= 0) continue;
      if (this.world.grid.distance(u.position, target) > (u.def.attackRange?.max ?? 1)) continue;
      const f = this.forecast(u.id, target);
      if (!f || f.damageToDefender <= 0) continue;
      if (f.damageToAttacker + f.interceptionDamage >= u.hp) continue;
      out.push({ unit: u, forecast: f });
    }
    return out.sort(
      (a, b) =>
        Number(a.forecast.defenderCanCounter) - Number(b.forecast.defenderCanCounter) ||
        b.forecast.damageToDefender - a.forecast.damageToDefender,
    );
  }

  /** Visible enemy ground or sea units on a tile (what stands between us and a city). */
  protected enemySurfaceAt(c: Coord): boolean {
    return this.view().foreignUnits.some((u) => u.position.x === c.x && u.position.y === c.y && UNIT_TYPES[u.type].domain !== 'air');
  }

  /** An own unit next to `target` that can walk in and take the city there. */
  protected capturerFor(target: Coord): Unit | undefined {
    const city = this.world.cityAt(target);
    if (!city || city.owner === this.viewer) return undefined;
    return this.world
      .unitsOf(this.viewer)
      .find((u) => u.def.canCaptureCities && u.movesLeft > 0 && this.world.grid.distance(u.position, target) === 1);
  }

  /**
   * Every unit in range strikes the target, best first, re-planning after each blow,
   * until nothing is left there or nobody can hit it without dying. If it was a city
   * and it is now empty, a unit next to it walks in and takes it.
   */
  jointAssault(target: Coord): string {
    let attacks = 0;
    for (let guard = 0; guard < 40; guard++) {
      if (!this.view().foreignUnits.some((u) => u.position.x === target.x && u.position.y === target.y)) break;
      const best = this.strikersAt(target)[0];
      if (!best) break;
      if (this.attack(best.unit.id, target)) break;
      attacks++;
    }
    if (attacks === 0) return 'Ninguna unidad puede atacar ese objetivo sin moverse (o sería suicida).';
    let taken = false;
    if (!this.enemySurfaceAt(target)) {
      const c = this.capturerFor(target);
      if (c && !this.moveTo(c.id, target)) taken = this.world.cityAt(target)?.owner === this.viewer;
    }
    const cleared = !this.view().foreignUnits.some((u) => u.position.x === target.x && u.position.y === target.y);
    return `Asalto conjunto: ${attacks} ${attacks === 1 ? 'ataque' : 'ataques'}. ${taken ? 'Ciudad tomada.' : cleared ? 'Objetivo destruido.' : 'El objetivo resiste.'}`;
  }

  /** Transports with room for `u` on its tile or next to it (nearest first). */
  transportsFor(u: Unit): Unit[] {
    return this.world
      .unitsOf(this.viewer)
      .filter((t) => t.id !== u.carriedBy && t.def.cargo?.accepts.includes(u.def.domain) && t.freeCapacity >= u.def.size && this.world.grid.distance(t.position, u.position) <= 1)
      .sort((a, b) => this.world.grid.distance(a.position, u.position) - this.world.grid.distance(b.position, u.position));
  }

  /** Land units that could get on `carrier` now: on its tile or right next to it. */
  loadCandidates(carrier: Unit): Unit[] {
    if (!carrier.def.cargo) return [];
    return this.world
      .unitsOf(this.viewer)
      .filter(
        (u) =>
          u.carriedBy === null &&
          u.movesLeft > 0 &&
          carrier.def.cargo!.accepts.includes(u.def.domain) &&
          u.def.domain !== 'air' &&
          this.world.grid.distance(u.position, carrier.position) <= 1,
      )
      .sort((a, b) => this.world.grid.distance(a.position, carrier.position) - this.world.grid.distance(b.position, carrier.position) || b.def.size - a.def.size);
  }

  /** Put one unit aboard `carrier` (stepping onto it first if it is next door). */
  protected boardOne(u: Unit, carrier: Unit): boolean {
    if (this.world.grid.distance(u.position, carrier.position) === 1) {
      const r = this.match.move(this.viewer, u.id, [carrier.position]);
      if (!r.ok) return false;
      this.pushEvents(r.value.events);
      if (u.carriedBy === carrier.id) return true; // stepped straight aboard at sea
    }
    return this.match.board(this.viewer, u.id, carrier.id).ok;
  }

  /** Load every unit that fits aboard `carrierId`. */
  loadAll(carrierId: UnitId): string {
    const carrier = this.ownUnit(carrierId);
    if (!carrier?.def.cargo?.accepts.includes('land')) return 'Esta unidad no lleva tropas.';
    let n = 0;
    for (const u of this.loadCandidates(carrier)) {
      if (carrier.freeCapacity < u.def.size) continue;
      if (this.boardOne(u, carrier)) {
        n++;
        this.orders.delete(u.id);
      }
    }
    this.invalidate();
    return n ? `Subieron ${n} ${n === 1 ? 'unidad' : 'unidades'} (carga ${carrier.cargoLoad}/${carrier.def.cargo.capacity}).` : 'No hay tropas para subir: tienen que estar en la casilla del transporte o al lado, con movimiento.';
  }

  /** Put a land unit aboard the nearest transport with room. */
  embark(id: UnitId): string {
    const u = this.ownUnit(id);
    if (!u || u.def.domain !== 'land') return 'Sólo las tropas de tierra embarcan.';
    const t = this.transportsFor(u)[0];
    if (!t) return 'No hay un transporte con lugar en la casilla ni al lado.';
    const ok = this.boardOne(u, t);
    this.invalidate();
    if (ok) this.orders.delete(id);
    return ok ? `Embarcó en el transporte (carga ${t.cargoLoad}/${t.def.cargo!.capacity}).` : 'No pudo embarcar.';
  }

  /**
   * Own units still waiting for orders this turn, in the order the player should
   * handle them: transports first (their cargo moves with them), then other ships,
   * aircraft, and land units. Troops riding a transport out at sea are left alone;
   * they only come up when their transport is next to land and they could disembark.
   */
  idleUnits(): Unit[] {
    const { grid } = this.world;
    const fog = this.match.fogs.get(this.viewer)!;
    const rank = (u: Unit) =>
      u.def.cargo?.accepts.includes('land') ? 0 : u.def.domain === 'sea' ? 1 : u.def.domain === 'air' ? 2 : 3;
    const besideLand = (c: Coord) =>
      grid.neighbors(c).some((n) => fog.isExplored(grid.index(n)) && grid.isLand(n) && this.world.cityAt(n)?.owner !== this.viewer);
    return this.world
      .unitsOf(this.viewer)
      .filter((u) => u.movesLeft > 0 && !this.skipped.has(u.id) && !this.orders.has(u.id))
      .filter((u) => u.carriedBy === null || (u.def.domain === 'land' && besideLand(u.position) && !this.world.cityAt(u.position)))
      .sort((a, b) => rank(a) - rank(b));
  }

  /** Next unit to handle, after `after` in the same order. */
  /**
   * The idle unit closest to `from`, skipping `exclude` (units already passed over in
   * this round of "next"). Keeps the player working in one area of the map instead of
   * jumping across it. Ties go to the usual order (transports first).
   */
  nearestIdleUnit(from: Coord, exclude: ReadonlySet<UnitId> = new Set()): Unit | undefined {
    let best: Unit | undefined;
    let bestD = Infinity;
    for (const u of this.idleUnits()) {
      if (exclude.has(u.id)) continue;
      const d = this.world.grid.distance(from, u.position);
      if (d < bestD) [best, bestD] = [u, d];
    }
    return best;
  }

  nextIdleUnit(after?: UnitId): Unit | undefined {
    const units = this.idleUnits();
    if (units.length === 0) return undefined;
    const i = after ? units.findIndex((u) => u.id === after) : -1;
    return units[(i + 1) % units.length];
  }

  // ─── Commands ───────────────────────────────────────────────────────────────

  /**
   * Move toward `goal`: executes this turn's part of the planned path and keeps a
   * go-to order for the rest. Returns a short status for the UI.
   */
  moveTo(id: UnitId, goal: Coord): string | null {
    const unit = this.ownUnit(id);
    if (!unit) return null;
    const full = this.fullTileMessage(unit, goal);
    if (full) return full;
    const plan = this.plan(id, goal);
    if (!plan || plan.steps.length === 0) return 'No hay camino conocido hasta ahí.';
    this.orders.delete(id);
    this.skipped.delete(id);
    const now = plan.steps.filter((s) => s.turn === 0).map((s) => s.coord);
    if (now.length === 0) {
      this.orders.set(id, goal);
      return `Orden guardada: llega en ${plan.turns - 1} turno(s).`;
    }
    const r = this.match.move(this.viewer, id, now);
    this.invalidate();
    if (!r.ok) return `Movimiento rechazado: ${r.error.message}`;
    this.reportMove(unit, r.value);
    const arrived = r.value.position.x === goal.x && r.value.position.y === goal.y;
    if (!arrived && r.value.stoppedBy === 'COMPLETED' && this.world.unit(id)) this.orders.set(id, goal);
    if (!arrived && r.value.stoppedBy === 'NO_MOVES_LEFT' && this.world.unit(id)) this.orders.set(id, goal);
    return null;
  }

  setProduction(city: CityId, unit: UnitTypeId): string | null {
    const r = this.match.setProduction(this.viewer, city, unit);
    return r.ok ? null : r.error.message;
  }

  setSpecialization(city: CityId, spec: CitySpecialization): string | null {
    const r = this.match.setSpecialization(this.viewer, city, spec);
    this.invalidate();
    return r.ok ? null : r.error.message;
  }

  setSilentRunning(id: UnitId, on: boolean): string | null {
    const r = this.match.setSilentRunning(this.viewer, id, on);
    this.invalidate();
    return r.ok ? null : r.error.message;
  }

  disband(id: UnitId): string | null {
    const unit = this.ownUnit(id);
    const r = this.match.disband(this.viewer, id);
    this.invalidate();
    if (!r.ok) return r.error.code === 'CARRYING_UNITS' ? 'Primero desembarcá las unidades que lleva a bordo.' : r.error.message;
    this.orders.delete(id);
    if (unit) this.push(this.viewer, `Disolviste ${UNIT_NAME[unit.type]}.`, 'info');
    return null;
  }

  skip(id: UnitId): void {
    this.skipped.add(id);
  }

  cancelOrder(id: UnitId): void {
    this.orders.delete(id);
  }

  /**
   * End the human's turn. By default the computer players then play right away; the
   * UI passes `runBots: false` and steps them with playNextBot() so it can show
   * progress between bots instead of freezing.
   */
  endTurn(opts: { runBots?: boolean } = {}): void {
    const r = this.match.endTurn(this.viewer);
    if (!r.ok) return;
    this.skipped.clear();
    this.pushEvents(r.value.events);
    this.invalidate();
    if (this.bots.size > 0) this.openRivalReport();
    if (opts.runBots === false) return;
    while (this.botToPlay) this.playNextBot();
    this.handOver();
  }

  /** The computer player whose turn it is, if any. */
  get botToPlay(): PlayerId | null {
    const p = this.match.activePlayer;
    return p && this.bots.has(p) && this.match.status === 'playing' ? p : null;
  }

  playNextBot(): void {
    const p = this.botToPlay;
    if (!p) return;
    this.pushEvents(playBotTurn(this.match, p).events);
    const r = this.match.endTurn(p);
    if (r.ok) this.pushEvents(r.value.events);
    this.invalidate();
  }

  /** After the bots: hide the map for the next human, or (alone) start their turn. */
  handOver(): void {
    if (this.match.status !== 'playing') return;
    if (this.humanCount > 1) this.awaitingHandoff = true;
    else this.beginTurn();
  }

  /** What happened to you while the computer played (built when its turns end). */
  rivalReport: LogEntry[] = [];
  private reportFrom = 0;
  private knownBefore = new Set<string>();

  /** Called when the human ends a turn against the computer: start collecting. */
  protected openRivalReport(): void {
    this.reportFrom = this.log.length;
    this.knownBefore = new Set(this.view().foreignUnits.map((u) => u.id));
  }

  /** Called when the human's next turn starts: keep what concerns them, plus new contacts. */
  protected closeRivalReport(): void {
    const me = this.viewer;
    const items = this.log
      .slice(this.reportFrom)
      .filter((e) => (e.audience === me || e.audience === 'all') && (e.at || e.tone !== 'info'));
    const produced = this.log.slice(this.reportFrom).filter((e) => e.audience === me && / completó /.test(e.text)).length;
    this.invalidate();
    const contacts = this.view().foreignUnits.filter((u) => !this.knownBefore.has(u.id));
    const byType = new Map<UnitTypeId, typeof contacts>();
    for (const u of contacts) byType.set(u.type, [...(byType.get(u.type) ?? []), u]);
    for (const [type, list] of byType) {
      items.push({
        round: this.match.round,
        audience: me,
        text: `Nuevo contacto: ${list.length > 1 ? `${list.length} × ` : ''}${UNIT_NAME[type]} de ${this.nameOf(list[0]!.owner)}.`,
        tone: 'warn',
        at: list[0]!.position,
      });
    }
    if (produced > 0) items.push({ round: this.match.round, audience: me, text: `Tus ciudades completaron ${produced} unidad${produced === 1 ? '' : 'es'}.`, tone: 'info' });
    this.rivalReport = items;
  }

  /** How the computer played, revealed at the end of the game. */
  botStyle(p: PlayerId): string {
    return botPersonality(this.match, p).label;
  }

  /** The next player took the seat: resume their standing orders. */
  beginTurn(): void {
    this.awaitingHandoff = false;
    if (this.bots.size > 0) this.closeRivalReport();
    for (const [id, goal] of [...this.orders]) {
      const unit = this.world.unit(id);
      if (!unit) {
        this.orders.delete(id);
        continue;
      }
      if (unit.owner !== this.viewer) continue;
      this.moveTo(id, goal);
      if (this.match.status !== 'playing') break;
    }
    this.invalidate();
  }

  // ─── Log ────────────────────────────────────────────────────────────────────

  visibleLog(): LogEntry[] {
    return this.log.filter((e) => e.audience === 'all' || e.audience === this.viewer);
  }

  protected push(audience: PlayerId | 'all', text: string, tone: Tone, at?: Coord): void {
    this.log.push({ round: this.match.round, audience, text, tone, ...(at ? { at: { ...at } } : {}) });
  }

  private unitLabel(type: UnitTypeId, id: UnitId): string {
    return `${UNIT_NAME[type]} ${this.unitTag(id)}`;
  }

  private pushCombat(audience: PlayerId, r: CombatResult): void {
    const att = UNIT_NAME[r.attackerType];
    const def = r.defenderType ? UNIT_NAME[r.defenderType] : null;
    const attacking = r.defenderOwner !== audience;
    const flak = r.interceptionDamage ? ` El fuego antiaéreo le hizo −${r.interceptionDamage}.` : '';
    if (attacking) {
      let text = def
        ? `${att} atacó ${def}: −${r.damageToDefender}${r.defenderDestroyed ? ' (destruido)' : ''}${r.damageToAttacker ? `, recibió −${r.damageToAttacker}` : ''}.`
        : `${att} bombardeó la ciudad.`;
      if (r.cityBombed && def) text += ' La ciudad quedó bombardeada.';
      if (r.attackerDestroyed) text += ` Perdiste tu ${att}.`;
      this.push(audience, text + flak, r.attackerDestroyed ? 'bad' : r.defenderDestroyed ? 'good' : 'info', r.target);
    } else {
      const text = `${att} enemigo atacó tu ${def}: −${r.damageToDefender}${r.defenderDestroyed ? ' (destruido)' : ''}${r.attackerDestroyed ? `. El atacante fue destruido` : ''}.`;
      this.push(audience, text, r.defenderDestroyed ? 'bad' : 'warn', r.target);
    }
  }

  private reportMove(unit: Unit, out: MoveOutcome & { events: TurnEvent[] }): void {
    const me = this.viewer;
    if (out.stoppedBy === 'CRASHED') {
      this.orders.delete(unit.id);
      this.push(me, `${this.unitLabel(unit.type, unit.id)} ${STOP_TEXT.CRASHED}`, 'bad');
    } else if (out.stoppedBy === 'CONTACT') {
      this.orders.delete(unit.id);
      this.push(me, STOP_TEXT.CONTACT!, 'warn');
    } else if (out.stoppedBy === 'BLOCKED') {
      this.orders.delete(unit.id);
      // Say what actually stopped the unit: newly revealed terrain is the usual cause.
      const why =
        out.blockedBy === 'ENEMY_PRESENT' ? 'Un enemigo oculto en la niebla cortó el camino.'
          : out.blockedBy === 'IMPASSABLE' ? 'El terreno recién descubierto no se puede cruzar: la ruta se cortó.'
          : out.blockedBy === 'CITY_NOT_OWNED' ? 'Una ciudad ajena cortó el camino.'
          : out.blockedBy === 'STACK_FULL' ? 'El camino pasa por una casilla llena de tropas propias.'
          : 'El camino quedó bloqueado.';
      this.push(me, `${UNIT_NAME[unit.type]}: ${why}`, 'warn');
    }
    this.pushEvents(out.events);
  }

  private readonly blockedSeen = new Map<string, number>();

  protected pushEvents(events: readonly TurnEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'unit_produced': {
          const city = this.world.city(e.city);
          this.push(e.audience, `${city?.name ?? 'Una ciudad'} completó ${UNIT_NAME[e.unitType]}.`, 'info');
          break;
        }
        case 'aircraft_crashed':
          this.push(e.audience, `${this.unitLabel(e.unitType, e.unit)} ${STOP_TEXT.CRASHED}`, 'bad');
          break;
        case 'aircraft_landed':
          this.push(e.audience, `Un avión aterrizó en su portaaviones.`, 'info');
          break;
        case 'out_of_supply':
          this.push(e.audience, `Una unidad está sin suministro (${e.turns} turno${e.turns === 1 ? '' : 's'}).`, 'warn');
          break;
        case 'army_at_limit':
          this.push(e.audience, `Ejército al límite (${e.units}/${e.cap}): las ciudades no producen hasta que haya lugar. Más ciudades sostienen más unidades.`, 'warn');
          break;
        case 'units_deserted': {
          const n = e.units.length;
          this.push(e.audience, `Desertaron ${n} unidad${n === 1 ? '' : 'es'} (${e.unitTypes.map((t) => UNIT_NAME[t]).join(', ')}): el ejército supera en ${e.over} lo que sus ciudades pueden sostener.`, 'bad');
          break;
        }
        case 'production_blocked': {
          // Once per blockage, not every turn it lasts.
          const key = `${e.city}:${e.reason}`;
          const last = this.blockedSeen.get(key);
          this.blockedSeen.set(key, this.match.round);
          if (last !== undefined && last >= this.match.round - 1) break;
          const city = this.world.city(e.city);
          const name = city?.name ?? 'Una ciudad';
          if (e.reason === 'besieged') this.push(e.audience, `${name} está sitiada: no produce ni repara hasta romper el cerco.`, 'bad', city?.position);
          else this.push(e.audience, `${name} terminó una unidad pero está llena (${STACK_LIMIT_CITY} de tierra): sacá tropas para que salga.`, 'warn', city?.position);
          break;
        }
        case 'city_captured': {
          const city = this.world.city(e.city);
          const name = city?.name ?? 'una ciudad';
          if (e.audience === e.by) this.push(e.audience, `Capturaste ${name}.`, 'good', city?.position);
          else {
            const planes = e.aircraftLost ? ` Perdiste ${e.aircraftLost} ${e.aircraftLost === 1 ? 'aeronave estacionada' : 'aeronaves estacionadas'} ahí.` : '';
            this.push(e.audience, `${this.nameOf(e.by)} te capturó ${name}.${planes}`, 'bad', city?.position);
          }
          break;
        }
        case 'combat':
          this.pushCombat(e.audience, e.result);
          break;
        case 'player_eliminated':
          this.push('all', `${this.nameOf(e.player)} fue eliminado.`, 'bad');
          break;
        case 'match_won':
          this.push(
            'all',
            `${this.nameOf(e.player)} gana la partida ${e.reason === 'city_share' ? 'por control de ciudades' : 'por ser el último en pie'}.`,
            'good',
          );
          break;
      }
    }
  }
}
