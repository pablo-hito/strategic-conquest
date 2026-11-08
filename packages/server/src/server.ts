import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { parseClientMessage, type ClientMessage, type ServerMessage } from '@sc/protocol';
import { newToken, roomCode } from './ids.js';
import { Room, type RoomSnapshot } from './room.js';

export interface ServerOptions {
  readonly port: number;
  readonly host?: string;
  /** Where rooms are saved (one JSON file each). Omit to keep everything in memory. */
  readonly dataDir?: string;
  /** HTML file served at "/" (the game client). */
  readonly clientFile?: string;
  /** Grace period before the bot plays a disconnected player's turn. */
  readonly graceMs?: number;
  /** Finished or abandoned rooms are dropped after this long. */
  readonly roomTtlMs?: number;
  readonly log?: (msg: string) => void;
}

interface Conn {
  readonly ws: WebSocket;
  name: string | null;
  token: string | null;
  room: Room | null;
  seat: number;
  alive: boolean;
  /** Token bucket for rate limiting. */
  budget: number;
  last: number;
}

const MAX_MSGS_PER_SEC = 25;

export interface GameServer {
  readonly port: number;
  readonly rooms: ReadonlyMap<string, Room>;
  close(): Promise<void>;
}

/**
 * HTTP + WebSocket game server. HTTP serves the client page and a health check;
 * the game itself runs over a WebSocket at /ws with the messages of @sc/protocol.
 */
export function startServer(opts: ServerOptions): Promise<GameServer> {
  const log = opts.log ?? (() => {});
  const rooms = new Map<string, Room>();
  const conns = new Set<Conn>();
  const graceMs = opts.graceMs ?? 20_000;
  const roomsDir = opts.dataDir ? join(opts.dataDir, 'rooms') : null;
  if (roomsDir) mkdirSync(roomsDir, { recursive: true });

  // Saving is throttled: many commands per second must not mean many writes.
  const dirty = new Set<Room>();
  const flush = () => {
    if (!roomsDir) return dirty.clear();
    for (const r of dirty) {
      const file = join(roomsDir, `${r.code}.json`);
      writeFileSync(`${file}.tmp`, JSON.stringify(r.snapshot()));
      renameSync(`${file}.tmp`, file); // atomic replace
    }
    dirty.clear();
  };
  const flushTimer = setInterval(flush, 1000);

  const hooksFor = (getRoom: () => Room) => ({
    graceMs,
    now: () => Date.now(),
    changed: () => dirty.add(getRoom()),
    send: (seat: number, msg: ServerMessage) => {
      const room = getRoom();
      for (const c of conns) if (c.room === room && c.seat === seat) send(c, msg);
    },
  });

  // Restore saved rooms.
  if (roomsDir) {
    for (const f of readdirSync(roomsDir).filter((f) => f.endsWith('.json'))) {
      try {
        const snap = JSON.parse(readFileSync(join(roomsDir, f), 'utf8')) as RoomSnapshot;
        let room!: Room;
        room = Room.restore(snap, hooksFor(() => room));
        rooms.set(room.code, room);
        room.resume();
      } catch (e) {
        log(`could not restore ${f}: ${String(e)}`);
      }
    }
    if (rooms.size) log(`restored ${rooms.size} room(s)`);
  }

  function send(c: Conn, msg: ServerMessage): void {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(msg));
  }
  const fail = (c: Conn, code: string, message: string) => send(c, { t: 'error', code, message });

  function onMessage(c: Conn, raw: string): void {
    // Rate limit: a steady flow is fine, a flood is cut.
    const now = Date.now();
    c.budget = Math.min(MAX_MSGS_PER_SEC, c.budget + ((now - c.last) / 1000) * MAX_MSGS_PER_SEC);
    c.last = now;
    if (c.budget < 1) return fail(c, 'RATE_LIMIT', 'Demasiados mensajes.');
    c.budget -= 1;

    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return fail(c, 'BAD_MESSAGE', parsed.error);
    const msg: ClientMessage = parsed.msg;
    if (msg.t !== 'hello' && !c.token) return fail(c, 'HELLO_FIRST', 'Falta el saludo inicial.');

    switch (msg.t) {
      case 'hello': {
        c.name = msg.name;
        if (msg.resume) {
          const room = rooms.get(msg.resume.room);
          const seat = room?.seats.find((s) => s.token === msg.resume!.token);
          if (room && seat) {
            c.token = msg.resume.token;
            send(c, { t: 'welcome', token: c.token, name: c.name });
            attach(c, room, seat.index);
            return;
          }
        }
        c.token = newToken();
        send(c, { t: 'welcome', token: c.token, name: c.name });
        return;
      }
      case 'create': {
        detach(c);
        let code = roomCode();
        while (rooms.has(code)) code = roomCode();
        let room!: Room;
        room = Room.create(code, msg.settings, hooksFor(() => room));
        rooms.set(code, room);
        log(`room ${code} created`);
        const seat = room.join(c.name!, c.token!);
        if (typeof seat === 'number') attach(c, room, seat, false);
        return;
      }
      case 'join': {
        const room = rooms.get(msg.room.toUpperCase());
        if (!room) return fail(c, 'NO_ROOM', 'No existe una sala con ese código.');
        detach(c);
        const seat = room.join(c.name!, c.token!);
        if (typeof seat !== 'number') return fail(c, seat.code, seat.message);
        attach(c, room, seat, false);
        // Rejoining a running game by code: the state sent during join() went out
        // before this connection was attached, so send it again now.
        if (room.status !== 'lobby') room.sendFullState(seat);
        return;
      }
      case 'ready':
        c.room?.setReady(c.seat, msg.ready);
        return;
      case 'start': {
        const err = c.room?.start(c.seat);
        if (err) fail(c, err.code, err.message);
        return;
      }
      case 'leave':
        if (c.room) c.room.leave(c.seat);
        c.room = null;
        return;
      case 'cmd':
        if (!c.room) return fail(c, 'NO_ROOM', 'No estás en una sala.');
        c.room.command(c.seat, msg.id, msg.cmd);
        return;
      case 'ping':
        send(c, { t: 'pong' });
        return;
    }
  }

  /** Bind a connection to a seat; any other connection on that seat is dropped. */
  function attach(c: Conn, room: Room, seat: number, reconnect = true): void {
    for (const other of conns) {
      if (other !== c && other.room === room && other.seat === seat) {
        other.room = null;
        other.ws.close(4000, 'replaced by a newer connection');
      }
    }
    c.room = room;
    c.seat = seat;
    send(c, { t: 'room', room: room.info(), you: seat });
    if (reconnect) room.reconnect(seat);
  }

  function detach(c: Conn): void {
    if (c.room) c.room.leave(c.seat);
    c.room = null;
  }

  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: conns.size }));
      return;
    }
    if ((req.url === '/' || req.url?.startsWith('/?')) && opts.clientFile && existsSync(opts.clientFile)) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      });
      res.end(readFileSync(opts.clientFile));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 32 * 1024 });
  wss.on('connection', (ws) => {
    const c: Conn = { ws, name: null, token: null, room: null, seat: -1, alive: true, budget: MAX_MSGS_PER_SEC, last: Date.now() };
    conns.add(c);
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (data) => onMessage(c, data.toString()));
    ws.on('close', () => {
      conns.delete(c);
      if (c.room) c.room.disconnect(c.seat);
    });
  });

  // Heartbeat: drop connections that stopped answering (half-open sockets).
  const heartbeat = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) {
        c.ws.terminate();
        continue;
      }
      c.alive = false;
      c.ws.ping();
    }
  }, 30_000);

  // Housekeeping: forget finished rooms after a while, and empty lobbies.
  const ttl = opts.roomTtlMs ?? 24 * 3600 * 1000;
  const sweeper = setInterval(() => {
    for (const [code, room] of rooms) {
      const occupied = [...conns].some((c) => c.room === room);
      const expired = Date.now() - room.createdAt > ttl;
      if (!occupied && (room.status === 'finished' || (room.status === 'lobby' && expired))) {
        room.dispose();
        rooms.delete(code);
        if (roomsDir && existsSync(join(roomsDir, `${code}.json`))) unlinkSync(join(roomsDir, `${code}.json`));
      }
    }
  }, 60_000);

  return new Promise((resolve) => {
    http.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      const addr = http.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      log(`listening on :${port}`);
      resolve({
        port,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(flushTimer);
            clearInterval(heartbeat);
            clearInterval(sweeper);
            flush();
            for (const r of rooms.values()) r.dispose();
            for (const c of conns) c.ws.terminate();
            wss.close();
            http.close(() => done());
          }),
      });
    });
  });
}
