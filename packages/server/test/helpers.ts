import WebSocket from 'ws';
import { PROTOCOL_VERSION, applyPatch, type OnlineView, type RoomSettings, type ServerMessage } from '@sc/protocol';

export const SETTINGS: RoomSettings = {
  players: 2,
  size: 'small',
  density: 'normal',
  difficulty: 'normal',
  turnSeconds: 0,
  fillWithBots: false,
  seed: 'online-test',
};

/** A scripted client: keeps the latest state (patches applied) and every message. */
export class TestClient {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];
  state: OnlineView | null = null;
  token = '';
  seat = -1;
  room = '';
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];

  private constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const m = JSON.parse(data.toString()) as ServerMessage;
      this.inbox.push(m);
      if (m.t === 'welcome') this.token = m.token;
      if (m.t === 'room') {
        this.seat = m.you;
        this.room = m.room.code;
      }
      if (m.t === 'state') this.state = m.state;
      if (m.t === 'patch' && this.state) this.state = applyPatch(this.state, m.patch);
      for (const w of [...this.waiters]) {
        if (w.pred(m)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          this.used.add(this.inbox.length - 1);
          w.resolve(m);
          return;
        }
      }
    });
  }

  static async connect(port: number, name: string, resume?: { room: string; token: string }): Promise<TestClient> {
    const c = new TestClient(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => c.ws.once('open', r));
    c.send({ t: 'hello', v: PROTOCOL_VERSION, name, ...(resume ? { resume } : {}) });
    await c.next((m) => m.t === 'welcome');
    return c;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  /** Indexes of inbox messages already handed to a waiter. */
  private readonly used = new Set<number>();

  /** Resolves with the first not-yet-used message (already received or future) matching `pred`. */
  next(pred: (m: ServerMessage) => boolean, timeoutMs = 5000): Promise<ServerMessage> {
    const i = this.inbox.findIndex((m, k) => !this.used.has(k) && pred(m));
    if (i >= 0) {
      this.used.add(i);
      return Promise.resolve(this.inbox[i]!);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout waiting for message')), timeoutMs);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }

  private cmdId = 0;
  async cmd(cmd: unknown): Promise<ServerMessage> {
    const id = ++this.cmdId;
    this.send({ t: 'cmd', id, cmd });
    return this.next((m) => m.t === 'ack' && m.id === id);
  }

  close(): Promise<void> {
    return new Promise((r) => {
      this.ws.once('close', () => r());
      this.ws.close();
    });
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
