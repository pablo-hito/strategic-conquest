import type { CityId, CitySpecialization, Coord, PlayerId, PlayerView, TurnEvent, UnitId, UnitTypeId } from '@sc/core';
import type { Command, OnlineView, RoomInfo } from '@sc/protocol/client';
import { UNIT_NAME } from './labels.js';
import type { Ack, ServerLink } from './net.js';
import { GameSession, type NewGameOptions, type SavedSession } from './session.js';
import { buildShadowMatch, seatName } from './shadow.js';

export type OnlineUpdate = 'state' | 'turn-started';

/**
 * The GameSession the UI already knows, playing against a server. Planning (routes,
 * reach, forecasts, move-and-attack) runs on a shadow match rebuilt from the
 * player's own view; every command goes to the server, which answers with an ack
 * and then patches. The UI is told through `onUpdate` when the picture changes.
 */
export class OnlineSession extends GameSession {
  /** Commands in flight: the UI waits instead of acting on a stale picture. */
  busy = 0;
  onUpdate: (kind: OnlineUpdate) => void = () => {};
  onError: (message: string) => void = () => {};
  private serverState: OnlineView;

  private constructor(
    options: NewGameOptions,
    state: OnlineView,
    public room: RoomInfo,
    readonly link: ServerLink,
  ) {
    super(options, buildShadowMatch(state, room.seats));
    this.serverState = state;
  }

  static fromServer(link: ServerLink, state: OnlineView, room: RoomInfo): OnlineSession {
    const s = room.settings;
    const options: NewGameOptions = {
      size: s.size,
      density: s.density,
      players: s.players,
      seed: s.seed || room.code,
      mode: 'online',
      difficulty: s.difficulty,
    };
    const session = new OnlineSession(options, state, room, link);
    session.push('all', `Partida en línea, sala ${room.code}.`, 'info');
    return session;
  }

  // ─── Read model ─────────────────────────────────────────────────────────────

  override get viewer(): PlayerId {
    return this.serverState.you;
  }

  override nameOf(p: PlayerId): string {
    return seatName(this.room.seats, p);
  }

  override get humanCount(): number {
    return 1; // each player has their own screen: no handoff
  }

  override get botToPlay(): PlayerId | null {
    return null; // the server plays the bots
  }

  override view(): PlayerView {
    return this.serverState.view;
  }

  override totalCities(): number {
    return this.serverState.meta.totalCities;
  }

  get isMyTurn(): boolean {
    return this.serverState.meta.active === this.viewer && this.serverState.meta.status === 'playing';
  }

  get deadline(): number | null {
    return this.serverState.meta.deadline;
  }

  override save(): SavedSession {
    throw new Error('online games are saved on the server');
  }

  // ─── Server updates ─────────────────────────────────────────────────────────

  /** A new state from the server (full or patched), with the events this player may hear. */
  applyServerState(state: OnlineView, events: readonly TurnEvent[]): void {
    const wasMyTurn = this.isMyTurn;
    this.serverState = state;
    this.match = buildShadowMatch(state, this.room.seats);
    this.invalidate();
    this.pushEvents(events);
    if (!wasMyTurn && this.isMyTurn) {
      this.closeRivalReport();
      this.onUpdate('turn-started');
      void this.runOrders();
    } else this.onUpdate('state');
  }

  updateRoom(room: RoomInfo): void {
    this.room = room;
  }

  // ─── Commands (sent to the server) ──────────────────────────────────────────

  /** `quiet`: a refusal is an expected outcome (e.g. the target is already gone), not an error to show. */
  private async send(cmd: Command, quiet = false): Promise<Ack> {
    this.busy++;
    try {
      const ack = await this.link.command(cmd);
      if (!ack.ok) {
        if (!quiet) this.onError(ack.message);
      } else this.pushEvents(ack.events);
      return ack;
    } finally {
      this.busy--;
    }
  }

  override moveTo(id: UnitId, goal: Coord): string | null {
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
    const longTrip = plan.steps.some((s) => s.turn > 0);
    void this.send({ c: 'move', unit: id, path: now }).then((ack) => {
      if (!ack.ok) return;
      const stop = ack.outcome?.stoppedBy;
      if (stop === 'CONTACT') this.push(this.viewer, 'Contacto: enemigo a la vista. Movimiento detenido.', 'warn');
      else if (stop === 'BLOCKED') this.push(this.viewer, `${UNIT_NAME[unit.type]}: el camino quedó bloqueado.`, 'warn');
      else if (longTrip && (stop === 'COMPLETED' || stop === 'NO_MOVES_LEFT')) this.orders.set(id, goal);
    });
    return null;
  }

  override attack(id: UnitId, target: Coord): string | null {
    void this.send({ c: 'attack', unit: id, target }).then((ack) => this.rememberCombat(id, ack));
    this.orders.delete(id);
    return null;
  }

  override assault(id: UnitId, target: Coord): string | null {
    const plan = this.assaultPlan(id, target);
    if (!plan) return 'No hay forma de atacar ese objetivo este turno.';
    const path = plan.path.filter((s) => s.turn === 0).map((s) => s.coord);
    void (async () => {
      const moved = await this.send({ c: 'move', unit: id, path });
      if (!moved.ok) return;
      if (moved.outcome && moved.outcome.stoppedBy !== 'COMPLETED') {
        this.onError('El avance se detuvo antes de llegar: no hubo ataque.');
        return;
      }
      this.rememberCombat(id, await this.send({ c: 'attack', unit: id, target }));
    })();
    return null;
  }

  /**
   * Online: the strike order is planned once from what we see; each blow goes to the
   * server in turn, and the first refusal (target gone, nothing left to hit) ends it.
   */
  override jointAssault(target: Coord): string {
    const order = this.strikersAt(target).map((x) => x.unit.id);
    if (order.length === 0) return 'Ninguna unidad puede atacar ese objetivo sin moverse (o sería suicida).';
    const city = this.world.cityAt(target);
    const capturers = this.world
      .unitsOf(this.viewer)
      .filter((u) => u.def.canCaptureCities && u.movesLeft > 0 && this.world.grid.distance(u.position, target) === 1)
      .map((u) => u.id);
    void (async () => {
      let n = 0;
      for (const id of order) {
        const ack = await this.send({ c: 'attack', unit: id, target }, true);
        if (!ack.ok) break;
        n++;
        this.rememberCombat(id, ack);
        this.orders.delete(id);
      }
      let taken = false;
      if (city && city.owner !== this.viewer) {
        for (const id of capturers) {
          const ack = await this.send({ c: 'move', unit: id, path: [target] }, true);
          if (ack.ok) {
            taken = ack.outcome?.stoppedBy === 'CAPTURED';
            break;
          }
        }
      }
      this.push(this.viewer, `Asalto conjunto: ${n} ${n === 1 ? 'ataque' : 'ataques'}.${taken ? ' Ciudad tomada.' : ''}`, 'info');
    })();
    return 'Asalto conjunto en curso…';
  }

  override loadAll(carrierId: UnitId): string {
    const carrier = this.ownUnit(carrierId);
    if (!carrier?.def.cargo?.accepts.includes('land')) return 'Esta unidad no lleva tropas.';
    let room = carrier.freeCapacity;
    const picked = this.loadCandidates(carrier).filter((u) => (u.def.size <= room ? ((room -= u.def.size), true) : false));
    if (picked.length === 0) return 'No hay tropas para subir: tienen que estar en la casilla del transporte o al lado, con movimiento.';
    void (async () => {
      for (const u of picked) await this.boardRemote(u.id, u.position, carrier.id, carrier.position);
    })();
    for (const u of picked) this.orders.delete(u.id);
    return `Subiendo ${picked.length} ${picked.length === 1 ? 'unidad' : 'unidades'}…`;
  }

  override embark(id: UnitId): string {
    const u = this.ownUnit(id);
    if (!u || u.def.domain !== 'land') return 'Sólo las tropas de tierra embarcan.';
    const t = this.transportsFor(u)[0];
    if (!t) return 'No hay un transporte con lugar en la casilla ni al lado.';
    void this.boardRemote(u.id, u.position, t.id, t.position);
    this.orders.delete(id);
    return 'Embarcando…';
  }

  private async boardRemote(unit: UnitId, at: Coord, carrier: UnitId, carrierAt: Coord): Promise<void> {
    if (at.x !== carrierAt.x || at.y !== carrierAt.y) {
      const moved = await this.send({ c: 'move', unit, path: [carrierAt] });
      if (!moved.ok || moved.outcome?.stoppedBy === 'BOARDED') return; // aboard already (at sea)
    }
    await this.send({ c: 'board', unit, carrier });
  }

  private rememberCombat(id: UnitId, ack: Ack): void {
    if (!ack.ok) return;
    const combat = ack.events.find((e) => e.type === 'combat' && e.result.attacker === id);
    this.lastCombat = combat && combat.type === 'combat' ? combat.result : null;
  }

  override setProduction(city: CityId, unit: UnitTypeId): string | null {
    void this.send({ c: 'production', city, unitType: unit });
    return null;
  }

  override setSpecialization(city: CityId, spec: CitySpecialization): string | null {
    void this.send({ c: 'specialize', city, spec });
    return null;
  }

  override setSilentRunning(id: UnitId, on: boolean): string | null {
    void this.send({ c: 'silent', unit: id, on });
    return null;
  }

  override disband(id: UnitId): string | null {
    const unit = this.ownUnit(id);
    if (unit?.cargo.length) return 'Primero desembarcá las unidades que lleva a bordo.';
    void this.send({ c: 'disband', unit: id }).then((ack) => {
      if (ack.ok && unit) this.push(this.viewer, `Disolviste ${UNIT_NAME[unit.type]}.`, 'info');
    });
    this.orders.delete(id);
    return null;
  }

  override endTurn(): void {
    if (!this.isMyTurn) return;
    this.skipped.clear();
    this.openRivalReport();
    void this.send({ c: 'endTurn' });
  }

  override beginTurn(): void {
    /* turns start when the server says so (see applyServerState) */
  }

  /** Standing go-to orders, one move at a time (each waits for the server). */
  private async runOrders(): Promise<void> {
    for (const [id, goal] of [...this.orders]) {
      if (!this.isMyTurn) return;
      if (!this.ownUnit(id)) {
        this.orders.delete(id);
        continue;
      }
      const msg = this.moveTo(id, goal);
      if (msg) this.orders.delete(id);
      while (this.busy > 0) await new Promise((r) => setTimeout(r, 20));
    }
  }
}
