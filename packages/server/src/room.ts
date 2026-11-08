import {
  Match,
  PlayerId,
  buildPlayerView,
  generateMap,
  type CityId,
  type MatchSnapshot,
  type TurnEvent,
} from '@sc/core';
import { playBotTurn } from '@sc/ai';
import {
  diffView,
  isEmptyPatch,
  type Command,
  type MoveSummary,
  type OnlineView,
  type RoomInfo,
  type RoomSettings,
  type SeatInfo,
  type SeatKind,
  type ServerMessage,
} from '@sc/protocol';
import { IdMask } from './ids.js';
import { eventsFor, maskView } from './masking.js';

const DIFFICULTY_BONUS = { normal: 0, hard: 0.25, brutal: 0.5 } as const;

export interface Seat {
  readonly index: number;
  readonly player: PlayerId;
  kind: SeatKind;
  name: string;
  /** Secret that lets a client reclaim this seat after a disconnect. */
  token: string | null;
  ready: boolean;
  connected: boolean;
}

export interface RoomSnapshot {
  readonly code: string;
  readonly settings: RoomSettings;
  readonly status: RoomInfo['status'];
  readonly host: number;
  readonly seats: Seat[];
  readonly match: MatchSnapshot | null;
  readonly masks: [string, [string, string][]][];
  readonly deadline: number | null;
  readonly createdAt: number;
}

export interface RoomHooks {
  /** Deliver a message to whoever sits in `seat` (no-op if nobody is connected). */
  send(seat: number, msg: ServerMessage): void;
  /** Something worth saving happened. */
  changed(): void;
  /** Grace period before the bot plays a disconnected player's turn. */
  readonly graceMs: number;
  now(): number;
}

export type RoomError = { code: string; message: string };

/**
 * One game room: lobby, then an authoritative Match. Clients only ever receive
 * their own masked PlayerView (as patches) and the events meant for them.
 */
export class Room {
  status: RoomInfo['status'] = 'lobby';
  match: Match | null = null;
  deadline: number | null = null;
  readonly masks = new Map<PlayerId, IdMask>();
  private readonly lastSent = new Map<number, OnlineView>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private takeover: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly code: string,
    readonly settings: RoomSettings,
    public host: number,
    readonly seats: Seat[],
    private readonly hooks: RoomHooks,
    readonly createdAt: number,
  ) {}

  static create(code: string, settings: RoomSettings, hooks: RoomHooks): Room {
    const seats: Seat[] = Array.from({ length: settings.players }, (_, i) => ({
      index: i,
      player: PlayerId(`p${i + 1}`),
      kind: 'open',
      name: `Jugador ${i + 1}`,
      token: null,
      ready: false,
      connected: false,
    }));
    return new Room(code, settings, 0, seats, hooks, hooks.now());
  }

  // ─── Lobby ──────────────────────────────────────────────────────────────────

  /** Take a free seat (or the seat this token already owns). */
  join(name: string, token: string): number | RoomError {
    const mine = this.seats.find((s) => s.token === token);
    if (mine) {
      mine.connected = true;
      mine.name = name;
      this.afterSeatChange(mine.index);
      return mine.index;
    }
    if (this.status !== 'lobby') return { code: 'GAME_STARTED', message: 'La partida ya empezó.' };
    const free = this.seats.find((s) => s.kind === 'open');
    if (!free) return { code: 'ROOM_FULL', message: 'La sala está llena.' };
    free.kind = 'human';
    free.name = name;
    free.token = token;
    free.connected = true;
    free.ready = false;
    if (!this.seats.some((s) => s.kind === 'human' && s.index !== free.index)) this.host = free.index;
    this.broadcastRoom();
    this.hooks.changed();
    return free.index;
  }

  /** Leaving the lobby frees the seat; leaving a game just disconnects. */
  leave(seat: number): void {
    const s = this.seats[seat];
    if (!s) return;
    if (this.status === 'lobby') {
      Object.assign(s, { kind: 'open', name: `Jugador ${seat + 1}`, token: null, ready: false, connected: false });
      const next = this.seats.find((x) => x.kind === 'human');
      if (next) this.host = next.index;
      this.broadcastRoom();
      this.hooks.changed();
    } else this.disconnect(seat);
  }

  setReady(seat: number, ready: boolean): void {
    const s = this.seats[seat];
    if (!s || this.status !== 'lobby') return;
    s.ready = ready;
    this.broadcastRoom();
  }

  start(bySeat: number): RoomError | null {
    if (this.status !== 'lobby') return { code: 'GAME_STARTED', message: 'La partida ya empezó.' };
    if (bySeat !== this.host) return { code: 'NOT_HOST', message: 'Sólo quien creó la sala puede empezar.' };
    const humans = this.seats.filter((s) => s.kind === 'human');
    if (humans.some((s) => !s.ready && s.index !== this.host)) {
      return { code: 'NOT_READY', message: 'Hay jugadores que todavía no están listos.' };
    }
    const open = this.seats.filter((s) => s.kind === 'open');
    if (open.length > 0 && !this.settings.fillWithBots) {
      return { code: 'SEATS_OPEN', message: 'Faltan jugadores (o activá completar con bots).' };
    }
    for (const s of open) Object.assign(s, { kind: 'bot', name: `Bot ${s.index + 1}` });

    const players = this.seats.map((s) => s.player);
    const seed = this.settings.seed || this.code;
    let map;
    try {
      map = generateMap({ size: this.settings.size, density: this.settings.density, seed }, players);
    } catch {
      for (const s of open) Object.assign(s, { kind: 'open', name: `Jugador ${s.index + 1}` });
      return { code: 'MAP_TOO_SMALL', message: 'El mapa es demasiado chico para tantos jugadores.' };
    }
    const bonus = DIFFICULTY_BONUS[this.settings.difficulty];
    const handicap = Object.fromEntries(this.seats.filter((s) => s.kind === 'bot' && bonus > 0).map((s) => [s.player, bonus]));
    this.match = Match.start(map.world, players, undefined, seed, handicap).match;
    for (const p of players) this.masks.set(p, new IdMask());
    this.status = 'playing';
    this.broadcastRoom();
    for (const s of this.seats) if (s.kind === 'human') this.sendFullState(s.index);
    this.continueTurns([]);
    return null;
  }

  // ─── Connections ────────────────────────────────────────────────────────────

  disconnect(seat: number): void {
    const s = this.seats[seat];
    if (!s) return;
    s.connected = false;
    this.lastSent.delete(seat);
    this.broadcastRoom();
    if (this.status === 'playing' && this.match?.activePlayer === s.player) this.armTakeover();
  }

  /** A client got its seat back: full state, and cancel any pending bot takeover. */
  reconnect(seat: number): void {
    const s = this.seats[seat];
    if (!s) return;
    s.connected = true;
    if (this.match?.activePlayer === s.player && this.takeover) {
      clearTimeout(this.takeover);
      this.takeover = null;
    }
    this.broadcastRoom();
    if (this.status !== 'lobby') this.sendFullState(seat);
  }

  // ─── Commands ───────────────────────────────────────────────────────────────

  command(seat: number, id: number, cmd: Command): void {
    const s = this.seats[seat];
    const m = this.match;
    const nack = (code: string, message: string) => this.hooks.send(seat, { t: 'ack', id, ok: false, code, message });
    if (!s || !m || this.status !== 'playing') return nack('NO_GAME', 'No hay partida en curso.');
    if (m.activePlayer !== s.player) return nack('NOT_YOUR_TURN', 'Esperá tu turno.');
    const mask = this.masks.get(s.player)!;
    const unit = (opaque: string) => mask.toReal(opaque);

    let events: TurnEvent[] = [];
    let outcome: MoveSummary | undefined;
    let error: { code: string; message: string } | null = null;
    switch (cmd.c) {
      case 'move': {
        const u = unit(cmd.unit);
        const r = u ? m.move(s.player, u, cmd.path) : null;
        if (!r) error = { code: 'UNKNOWN_UNIT', message: 'Unidad desconocida.' };
        else if (!r.ok) error = r.error;
        else {
          events = r.value.events;
          outcome = { stoppedBy: r.value.stoppedBy, ...(r.value.blockedBy ? { blockedBy: r.value.blockedBy } : {}) };
        }
        break;
      }
      case 'attack': {
        const u = unit(cmd.unit);
        const r = u ? m.attack(s.player, u, cmd.target) : null;
        if (!r) error = { code: 'UNKNOWN_UNIT', message: 'Unidad desconocida.' };
        else if (!r.ok) error = r.error;
        else events = r.value.events;
        break;
      }
      case 'production': {
        const r = m.setProduction(s.player, cmd.city as CityId, cmd.unitType);
        if (!r.ok) error = r.error;
        break;
      }
      case 'specialize': {
        const r = m.setSpecialization(s.player, cmd.city as CityId, cmd.spec);
        if (!r.ok) error = r.error;
        break;
      }
      case 'silent': {
        const u = unit(cmd.unit);
        const r = u ? m.setSilentRunning(s.player, u, cmd.on) : null;
        if (!r) error = { code: 'UNKNOWN_UNIT', message: 'Unidad desconocida.' };
        else if (!r.ok) error = r.error;
        break;
      }
      case 'board': {
        const u = unit(cmd.unit), c = unit(cmd.carrier);
        const r = u && c ? m.board(s.player, u, c) : null;
        if (!r) error = { code: 'UNKNOWN_UNIT', message: 'Unidad desconocida.' };
        else if (!r.ok) error = r.error;
        break;
      }
      case 'disband': {
        const u = unit(cmd.unit);
        const r = u ? m.disband(s.player, u) : null;
        if (!r) error = { code: 'UNKNOWN_UNIT', message: 'Unidad desconocida.' };
        else if (!r.ok) error = r.error;
        break;
      }
      case 'endTurn': {
        const r = m.endTurn(s.player);
        if (!r.ok) error = r.error;
        else events = r.value.events;
        break;
      }
    }
    if (error) return nack(error.code, error.message);

    // The mover hears its events in the ack; everyone else in their patch.
    this.hooks.send(seat, { t: 'ack', id, ok: true, events: eventsFor(events, s.player, mask), ...(outcome ? { outcome } : {}) });
    if (cmd.c === 'endTurn') this.continueTurns(events, seat);
    else this.pushPatches(events, seat);
    this.hooks.changed();
  }

  // ─── Turn flow ──────────────────────────────────────────────────────────────

  /**
   * After a turn change: computer seats (and humans the bot stands in for) play
   * until a connected human is up; then that human's clock starts.
   */
  private continueTurns(events: TurnEvent[], ackedSeat?: number): void {
    const m = this.match!;
    const all = [...events];
    for (let guard = 0; guard < this.seats.length * 2 && m.status === 'playing'; guard++) {
      const seat = this.seatOf(m.activePlayer!);
      if (seat.kind === 'human') break;
      all.push(...this.botPlays(seat));
    }
    this.clearTimers();
    if (m.status === 'finished') {
      this.status = 'finished';
      this.deadline = null;
      this.broadcastRoom();
    } else {
      const seat = this.seatOf(m.activePlayer!);
      this.deadline = this.settings.turnSeconds > 0 ? this.hooks.now() + this.settings.turnSeconds * 1000 : null;
      if (this.deadline !== null) this.timer = setTimeout(() => this.onDeadline(), this.deadline - this.hooks.now());
      if (!seat.connected) this.armTakeover();
    }
    this.pushPatches(all, ackedSeat);
    this.hooks.changed();
  }

  /** The bot plays one turn for `seat` and ends it. */
  private botPlays(seat: Seat): TurnEvent[] {
    const m = this.match!;
    const events = [...playBotTurn(m, seat.player).events];
    const r = m.endTurn(seat.player);
    if (r.ok) events.push(...r.value.events);
    return events;
  }

  /** Clock ran out: a present player's turn just ends; an absent one's is played by the bot. */
  private onDeadline(): void {
    this.timer = null;
    const m = this.match;
    if (!m || m.status !== 'playing') return;
    const seat = this.seatOf(m.activePlayer!);
    if (seat.kind !== 'human') return;
    let events: TurnEvent[];
    if (seat.connected) {
      const r = m.endTurn(seat.player);
      events = r.ok ? r.value.events : [];
    } else events = this.botPlays(seat);
    this.continueTurns(events);
  }

  private armTakeover(): void {
    if (this.takeover) return;
    this.takeover = setTimeout(() => {
      this.takeover = null;
      const m = this.match;
      if (!m || m.status !== 'playing') return;
      const seat = this.seatOf(m.activePlayer!);
      if (seat.kind === 'human' && !seat.connected) this.continueTurns(this.botPlays(seat));
    }, this.hooks.graceMs);
  }

  private clearTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.takeover) clearTimeout(this.takeover);
    this.timer = null;
    this.takeover = null;
  }

  dispose(): void {
    this.clearTimers();
  }

  // ─── Views ──────────────────────────────────────────────────────────────────

  private seatOf(p: PlayerId): Seat {
    return this.seats.find((s) => s.player === p)!;
  }

  private onlineView(seat: Seat): OnlineView {
    const m = this.match!;
    const mask = this.masks.get(seat.player)!;
    return {
      you: seat.player,
      meta: {
        round: m.round,
        active: m.activePlayer,
        status: m.status,
        winner: m.winner,
        deadline: this.deadline,
        totalCities: [...m.world.allCities()].length,
      },
      view: maskView(buildPlayerView(m.world, m.fogs.get(seat.player)!), mask),
    };
  }

  sendFullState(seat: number): void {
    const s = this.seats[seat];
    if (!s || !this.match || s.kind !== 'human') return;
    const state = this.onlineView(s);
    this.lastSent.set(seat, state);
    this.hooks.send(seat, { t: 'state', state });
  }

  /** Send every connected human what changed for them, with the events they may hear. */
  private pushPatches(events: readonly TurnEvent[], skipEventsFor?: number): void {
    for (const s of this.seats) {
      if (s.kind !== 'human' || !s.connected) continue;
      const prev = this.lastSent.get(s.index);
      if (!prev) {
        this.sendFullState(s.index);
        continue;
      }
      const next = this.onlineView(s);
      const patch = diffView(prev, next);
      const evs = s.index === skipEventsFor ? [] : eventsFor(events, s.player, this.masks.get(s.player)!);
      if (isEmptyPatch(patch) && evs.length === 0) continue;
      this.lastSent.set(s.index, next);
      this.hooks.send(s.index, { t: 'patch', patch, events: evs });
    }
  }

  // ─── Room info and persistence ──────────────────────────────────────────────

  info(): RoomInfo {
    const m = this.match;
    const seats: SeatInfo[] = this.seats.map((s) => ({
      index: s.index,
      player: s.player,
      name: s.name,
      kind: s.kind,
      connected: s.kind === 'bot' || s.connected,
      ready: s.ready,
      alive: m ? m.alivePlayers.includes(s.player) : true,
      botStandIn: s.kind === 'human' && !s.connected && this.status === 'playing',
    }));
    return { code: this.code, settings: this.settings, status: this.status, seats, host: this.host };
  }

  broadcastRoom(): void {
    const room = this.info();
    for (const s of this.seats) if (s.kind === 'human' && s.connected) this.hooks.send(s.index, { t: 'room', room, you: s.index });
  }

  private afterSeatChange(seat: number): void {
    this.broadcastRoom();
    if (this.status !== 'lobby') this.reconnect(seat);
  }

  snapshot(): RoomSnapshot {
    return {
      code: this.code,
      settings: this.settings,
      status: this.status,
      host: this.host,
      seats: this.seats.map((s) => ({ ...s, connected: false })),
      match: this.match ? this.match.toSnapshot() : null,
      masks: [...this.masks].map(([p, m]) => [p, m.entries()]),
      deadline: this.deadline,
      createdAt: this.createdAt,
    };
  }

  static restore(s: RoomSnapshot, hooks: RoomHooks): Room {
    const r = new Room(s.code, s.settings, s.host, s.seats.map((x) => ({ ...x, connected: false })), hooks, s.createdAt);
    r.status = s.status;
    r.match = s.match ? Match.fromSnapshot(s.match) : null;
    for (const [p, entries] of s.masks) r.masks.set(PlayerId(p), new IdMask(entries));
    return r;
  }

  /** After a restore: restart the clock (nobody is connected yet, so the bot may step in). */
  resume(): void {
    if (this.match && this.status === 'playing') this.continueTurns([]);
  }
}
