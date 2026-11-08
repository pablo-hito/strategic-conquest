import {
  PROTOCOL_VERSION,
  applyPatch,
  type Command,
  type MoveSummary,
  type OnlineView,
  type RoomInfo,
  type RoomSettings,
  type ServerMessage,
} from '@sc/protocol/client';
import type { TurnEvent } from '@sc/core';

const RESUME_KEY = 'strategic-conquest:online';

export interface ResumeInfo {
  readonly room: string;
  readonly token: string;
  readonly name: string;
}

export type Ack = { ok: true; events: TurnEvent[]; outcome?: MoveSummary } | { ok: false; code: string; message: string };

export interface LinkEvents {
  room(room: RoomInfo, you: number): void;
  /** New full state or patch applied; events are the ones this player may hear. */
  state(state: OnlineView, events: TurnEvent[]): void;
  error(code: string, message: string): void;
  status(connected: boolean): void;
}

/** WebSocket URL of the game server this page was served from, if any. */
export function serverUrl(): string | null {
  if (!location.protocol.startsWith('http')) return null;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** Is a game server answering on this page's origin? (False inside the artifact viewer.) */
export async function serverAvailable(): Promise<boolean> {
  if (!serverUrl()) return false;
  try {
    const r = await fetch('/health', { cache: 'no-store' });
    return r.ok && (await r.json()).ok === true;
  } catch {
    return false;
  }
}

export function savedResume(): ResumeInfo | null {
  try {
    const raw = localStorage.getItem(RESUME_KEY);
    return raw ? (JSON.parse(raw) as ResumeInfo) : null;
  } catch {
    return null;
  }
}

function storeResume(r: ResumeInfo | null): void {
  try {
    if (r) localStorage.setItem(RESUME_KEY, JSON.stringify(r));
    else localStorage.removeItem(RESUME_KEY);
  } catch {
    /* storage unavailable: reconnecting needs the room code again */
  }
}

/**
 * Connection to the game server. Reconnects by itself (with backoff) and reclaims
 * the seat with the saved token; commands are promises resolved by the server's ack.
 */
export class ServerLink {
  private ws: WebSocket | null = null;
  private token = '';
  private roomCode = '';
  private nextId = 1;
  private readonly pending = new Map<number, (a: Ack) => void>();
  private retry = 0;
  private closedByUser = false;
  state: OnlineView | null = null;
  room: RoomInfo | null = null;
  /** Actions waiting for the server's welcome. */
  private queue: (() => void)[] = [];
  private triedResume = false;
  seat = -1;
  connected = false;

  constructor(
    private readonly url: string,
    private name: string,
    private readonly on: LinkEvents,
    resume?: ResumeInfo,
  ) {
    if (resume) {
      this.token = resume.token;
      this.roomCode = resume.room;
    }
    this.open();
  }

  private open(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.triedResume = !!(this.token && this.roomCode);
      this.send({
        t: 'hello',
        v: PROTOCOL_VERSION,
        name: this.name,
        ...(this.token && this.roomCode ? { resume: { room: this.roomCode, token: this.token } } : {}),
      });
    };
    ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)) as ServerMessage);
    ws.onclose = () => {
      this.connected = false;
      this.on.status(false);
      for (const [, resolve] of this.pending) resolve({ ok: false, code: 'DISCONNECTED', message: 'Se cortó la conexión.' });
      this.pending.clear();
      if (this.closedByUser) return;
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  private receive(m: ServerMessage): void {
    switch (m.t) {
      case 'welcome':
        // A resume the server didn't honour (room gone): forget it.
        if (this.triedResume && m.token !== this.token) {
          storeResume(null);
          this.roomCode = '';
        }
        this.token = m.token;
        this.connected = true;
        this.on.status(true);
        for (const fn of this.queue.splice(0)) fn();
        break;
      case 'room':
        this.room = m.room;
        this.seat = m.you;
        this.roomCode = m.room.code;
        storeResume({ room: m.room.code, token: this.token, name: this.name });
        this.on.room(m.room, m.you);
        break;
      case 'state':
        this.state = m.state;
        this.on.state(m.state, []);
        break;
      case 'patch':
        if (!this.state) return;
        this.state = applyPatch(this.state, m.patch);
        this.on.state(this.state, m.events);
        break;
      case 'ack': {
        const resolve = this.pending.get(m.id);
        this.pending.delete(m.id);
        resolve?.(m.ok ? { ok: true, events: m.events, ...(m.outcome ? { outcome: m.outcome } : {}) } : { ok: false, code: m.code, message: m.message });
        break;
      }
      case 'error':
        this.on.error(m.code, m.message);
        break;
      case 'pong':
        break;
    }
  }

  private send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Run once the server has welcomed us (immediately if it already has). */
  whenReady(fn: () => void): void {
    if (this.connected) fn();
    else this.queue.push(fn);
  }

  createRoom(settings: RoomSettings): void {
    this.whenReady(() => this.send({ t: 'create', settings }));
  }

  joinRoom(code: string): void {
    this.whenReady(() => this.send({ t: 'join', room: code.trim().toUpperCase() }));
  }

  setReady(ready: boolean): void {
    this.send({ t: 'ready', ready });
  }

  start(): void {
    this.send({ t: 'start' });
  }

  command(cmd: Command): Promise<Ack> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return resolve({ ok: false, code: 'DISCONNECTED', message: 'Sin conexión con el servidor.' });
      this.pending.set(id, resolve);
      this.send({ t: 'cmd', id, cmd });
    });
  }

  /** Leave the room for good (forget the resume token). */
  leave(): void {
    this.send({ t: 'leave' });
    storeResume(null);
    this.state = null;
    this.room = null;
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}
