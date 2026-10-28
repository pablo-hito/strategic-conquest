import {
  Match,
  PlayerId,
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
  type PlayerView,
  type ReachableTile,
  type TileIndex,
  type TurnEvent,
  type Unit,
  type UnitId,
  type UnitTypeId,
} from '@sc/core';
import { playBotTurn } from '@sc/ai';
import { STOP_TEXT, UNIT_NAME, playerName } from './labels.js';

/** 'bots': player 1 is you, everyone else is the computer. 'hotseat': all humans. */
export type GameMode = 'bots' | 'hotseat';

export interface NewGameOptions {
  readonly size: MapSize;
  readonly density: IslandDensity;
  readonly players: number;
  readonly seed: string;
  readonly mode?: GameMode;
}

export type Tone = 'info' | 'good' | 'warn' | 'bad';

export interface LogEntry {
  readonly round: number;
  readonly audience: PlayerId | 'all';
  readonly text: string;
  readonly tone: Tone;
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
  private cachedView: PlayerView | null = null;
  /** Players the computer controls. */
  readonly bots: ReadonlySet<PlayerId>;

  private constructor(
    readonly options: NewGameOptions,
    readonly match: Match,
  ) {
    this.bots = new Set(options.mode === 'bots' ? match.order.slice(1) : []);
  }

  static create(options: NewGameOptions): GameSession {
    const players = Array.from({ length: options.players }, (_, i) => PlayerId(`p${i + 1}`));
    const map = generateMap({ size: options.size, density: options.density, seed: options.seed }, players);
    const { match, report } = Match.start(map.world, players, undefined, options.seed);
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
  get viewer(): PlayerId { return this.match.activePlayer ?? this.match.winner ?? this.players[0]!; }

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

  /** Expected outcome of attacking `target`, or null if the attack isn't possible. */
  forecast(id: UnitId, target: Coord): Forecast | null {
    const fog = this.match.fogs.get(this.viewer)!;
    const p = planAttack(this.world, fog, this.viewer, id, target);
    return p.ok ? forecastAttack(this.world, p.value) : null;
  }

  attack(id: UnitId, target: Coord): string | null {
    const r = this.match.attack(this.viewer, id, target);
    this.invalidate();
    if (!r.ok) return r.error.message;
    this.orders.delete(id);
    this.pushEvents(r.value.events);
    return null;
  }

  /** Next own unit that can still act this turn, cycling after `after`. */
  nextIdleUnit(after?: UnitId): Unit | undefined {
    const units = this.world
      .unitsOf(this.viewer)
      .filter((u) => u.movesLeft > 0 && !this.skipped.has(u.id) && !this.orders.has(u.id));
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

  skip(id: UnitId): void {
    this.skipped.add(id);
  }

  cancelOrder(id: UnitId): void {
    this.orders.delete(id);
  }

  endTurn(): void {
    const r = this.match.endTurn(this.viewer);
    if (!r.ok) return;
    this.skipped.clear();
    this.pushEvents(r.value.events);
    this.runBots();
    this.invalidate();
    if (this.match.status !== 'playing') return;
    // Alone against the computer there is nobody to hide the map from.
    if (this.humanCount > 1) this.awaitingHandoff = true;
    else this.beginTurn();
  }

  /** Let every computer player whose turn comes up play it, until a human is next. */
  private runBots(): void {
    for (let guard = 0; guard < this.players.length; guard++) {
      const p = this.match.activePlayer;
      if (!p || !this.bots.has(p) || this.match.status !== 'playing') return;
      this.pushEvents(playBotTurn(this.match, p).events);
      const r = this.match.endTurn(p);
      if (r.ok) this.pushEvents(r.value.events);
    }
  }

  /** The next player took the seat: resume their standing orders. */
  beginTurn(): void {
    this.awaitingHandoff = false;
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

  private push(audience: PlayerId | 'all', text: string, tone: Tone): void {
    this.log.push({ round: this.match.round, audience, text, tone });
  }

  private unitLabel(type: UnitTypeId, id: UnitId): string {
    return `${UNIT_NAME[type]} ${id.replace(/^u/, '#')}`;
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
      this.push(audience, text + flak, r.attackerDestroyed ? 'bad' : r.defenderDestroyed ? 'good' : 'info');
    } else {
      const text = `${att} enemigo atacó tu ${def}: −${r.damageToDefender}${r.defenderDestroyed ? ' (destruido)' : ''}${r.attackerDestroyed ? `. El atacante fue destruido` : ''}.`;
      this.push(audience, text, r.defenderDestroyed ? 'bad' : 'warn');
    }
  }

  private reportMove(unit: Unit, out: MoveOutcome & { events: TurnEvent[] }): void {
    const me = this.viewer;
    if (out.stoppedBy === 'CRASHED') {
      this.orders.delete(unit.id);
      this.push(me, `${this.unitLabel(unit.type, unit.id)} ${STOP_TEXT.CRASHED}`, 'bad');
    } else if (out.stoppedBy === 'CONTACT' || out.stoppedBy === 'BLOCKED') {
      this.orders.delete(unit.id);
      this.push(me, STOP_TEXT[out.stoppedBy]!, 'warn');
    }
    this.pushEvents(out.events);
  }

  private pushEvents(events: readonly TurnEvent[]): void {
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
        case 'city_captured': {
          const city = this.world.city(e.city);
          const name = city?.name ?? 'una ciudad';
          if (e.audience === e.by) this.push(e.audience, `Capturaste ${name}.`, 'good');
          else this.push(e.audience, `${this.nameOf(e.by)} te capturó ${name}.`, 'bad');
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
