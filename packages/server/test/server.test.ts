import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer, type GameServer } from '../src/server.js';
import { SETTINGS, TestClient, sleep } from './helpers.js';

let server: GameServer | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) if (c.ws.readyState === c.ws.OPEN) await c.close();
  await server?.close();
  server = null;
});

async function boot(opts: Partial<Parameters<typeof startServer>[0]> = {}) {
  server = await startServer({ port: 0, graceMs: 150, ...opts });
  return server.port;
}
async function client(port: number, name: string, resume?: { room: string; token: string }) {
  const c = await TestClient.connect(port, name, resume);
  clients.push(c);
  return c;
}

/** Two humans in a room, game started. */
async function twoPlayerGame(port: number, settings = SETTINGS) {
  const a = await client(port, 'Ana');
  a.send({ t: 'create', settings });
  await a.next((m) => m.t === 'room');
  const b = await client(port, 'Beto');
  b.send({ t: 'join', room: a.room });
  await b.next((m) => m.t === 'room' && m.you === 1);
  b.send({ t: 'ready', ready: true });
  await a.next((m) => m.t === 'room' && m.room.seats[1]!.ready);
  a.send({ t: 'start' });
  await a.next((m) => m.t === 'state');
  await b.next((m) => m.t === 'state');
  return { a, b };
}

describe('lobby', () => {
  it('creates a room with a code, lets a friend join, and starts', async () => {
    const port = await boot();
    const { a, b } = await twoPlayerGame(port);
    expect(a.room).toMatch(/^[A-Z2-9]{6}$/);
    expect(a.state!.you).not.toBe(b.state!.you);
    expect(a.state!.meta.active).toBe(a.state!.you);
  });

  it('refuses unknown codes, full rooms and starting with open seats', async () => {
    const port = await boot();
    const a = await client(port, 'Ana');
    a.send({ t: 'join', room: 'ZZZZZZ' });
    expect(await a.next((m) => m.t === 'error')).toMatchObject({ code: 'NO_ROOM' });
    a.send({ t: 'create', settings: SETTINGS });
    await a.next((m) => m.t === 'room');
    a.send({ t: 'start' });
    expect(await a.next((m) => m.t === 'error' && m.code === 'SEATS_OPEN')).toBeTruthy();
    await client(port, 'B').then((b) => b.send({ t: 'join', room: a.room }));
    const c = await client(port, 'C');
    c.send({ t: 'join', room: a.room });
    expect(await c.next((m) => m.t === 'error')).toMatchObject({ code: 'ROOM_FULL' });
  });

  it('fills empty seats with bots: the human plays, the bots answer', async () => {
    const port = await boot();
    const a = await client(port, 'Ana');
    a.send({ t: 'create', settings: { ...SETTINGS, players: 3, fillWithBots: true } });
    await a.next((m) => m.t === 'room');
    a.send({ t: 'start' });
    await a.next((m) => m.t === 'state');
    const ack = await a.cmd({ c: 'endTurn' });
    expect(ack).toMatchObject({ ok: true });
    await a.next((m) => m.t === 'patch' && m.patch.meta?.round === 2);
    expect(a.state!.meta.active).toBe(a.state!.you);
  });
});

describe('playing online', () => {
  it('only the active player can act; ending the turn passes it on', async () => {
    const port = await boot();
    const { a, b } = await twoPlayerGame(port);
    expect(await b.cmd({ c: 'endTurn' })).toMatchObject({ ok: false, code: 'NOT_YOUR_TURN' });
    expect(await a.cmd({ c: 'endTurn' })).toMatchObject({ ok: true });
    await b.next((m) => m.t === 'patch' && m.patch.meta?.active === b.state!.you);
    expect(b.state!.meta.active).toBe(b.state!.you);
  });

  it('moves a unit by its opaque id and the server validates the path', async () => {
    const port = await boot();
    const { a } = await twoPlayerGame(port);
    const inf = a.state!.view.ownUnits[0]!;
    expect(inf.id).toMatch(/^k[0-9a-f]{10}$/); // not the sequential real id
    const { x, y } = inf.position;
    expect(await a.cmd({ c: 'move', unit: inf.id, path: [{ x: x + 5, y }] })).toMatchObject({ ok: false, code: 'NOT_ADJACENT' });
    expect(await a.cmd({ c: 'move', unit: 'u1', path: [{ x, y }] })).toMatchObject({ ok: false, code: 'UNKNOWN_UNIT' });
    const view = a.state!.view;
    const target = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]
      .map(([dx, dy]) => ({ x: x + dx!, y: y + dy! }))
      .find((c) => { const t = view.terrain[c.y * view.width + c.x]; return t !== undefined && t >= 2 && t < 255; })!;
    expect(await a.cmd({ c: 'move', unit: inf.id, path: [target] })).toMatchObject({ ok: true });
    await a.next((m) => m.t === 'patch');
    expect(a.state!.view.ownUnits.find((u) => u.id === inf.id)!.position).toEqual(target);
  });

  it('never sends a player what their fog hides', async () => {
    const port = await boot();
    const { a, b } = await twoPlayerGame(port);
    const bothSee = (c: TestClient) => c.state!.view.foreignUnits.length;
    // Capitals are far apart: at the start nobody sees the other's units or cities.
    expect(bothSee(a)).toBe(0);
    expect(bothSee(b)).toBe(0);
    expect(a.state!.view.knownCities.every((k) => k.owner !== b.state!.you)).toBe(true);
    const unknown = (c: TestClient) => c.state!.view.terrain.filter((t) => t === 255).length;
    expect(unknown(a)).toBeGreaterThan(a.state!.view.terrain.length / 2);
    // B's own unit ids are never in A's messages.
    const bIds = new Set(b.state!.view.ownUnits.map((u) => u.id));
    expect(a.inbox.some((m) => [...bIds].some((id) => JSON.stringify(m).includes(id)))).toBe(false);
  });
});

describe('resilience', () => {
  it('a disconnected player gets their seat back with the token', async () => {
    const port = await boot();
    const { a, b } = await twoPlayerGame(port);
    const token = b.token, room = b.room, me = b.state!.you;
    await b.close();
    const again = await client(port, 'Beto', { room, token });
    const st = await again.next((m) => m.t === 'state');
    expect(st.t === 'state' && st.state.you).toBe(me);
    void a;
  });

  it('the bot plays the turn of a player who left (after the grace period)', async () => {
    const port = await boot({ graceMs: 150 });
    const { a, b } = await twoPlayerGame(port);
    await b.close();
    await a.cmd({ c: 'endTurn' });
    // B is away: after 150 ms the bot plays B's turn and it's A's turn again.
    await a.next((m) => m.t === 'patch' && m.patch.meta?.round === 2, 4000);
    expect(a.state!.meta.active).toBe(a.state!.you);
  });

  it('the turn clock ends the turn of a player who runs out of time', async () => {
    const port = await boot();
    const { a, b } = await twoPlayerGame(port, { ...SETTINGS, turnSeconds: 1 });
    expect(a.state!.meta.deadline).not.toBeNull();
    await b.next((m) => m.t === 'patch' && m.patch.meta?.active === b.state!.you, 4000);
    expect(b.state!.meta.active).toBe(b.state!.you);
  });

  it('rooms survive a server restart (saved to disk)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-test-'));
    try {
      let port = await boot({ dataDir: dir });
      const { a } = await twoPlayerGame(port);
      await a.cmd({ c: 'endTurn' });
      const room = a.room, token = a.token, me = a.state!.you;
      await sleep(1200); // let the throttled save happen
      for (const c of clients.splice(0)) await c.close();
      await server!.close();
      port = await boot({ dataDir: dir });
      const back = await client(port, 'Ana', { room, token });
      const st = await back.next((m) => m.t === 'state');
      expect(st.t === 'state' && st.state.you).toBe(me);
      expect(st.t === 'state' && st.state.meta.active).not.toBe(me); // it's still B's turn
    } finally {
      for (const c of clients.splice(0)) await c.close();
      await server?.close();
      server = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed messages and anything before the hello', async () => {
    const port = await boot();
    const a = await client(port, 'Ana');
    a.ws.send('{oops');
    expect(await a.next((m) => m.t === 'error')).toMatchObject({ code: 'BAD_MESSAGE' });
    a.send({ t: 'cmd', id: 1, cmd: { c: 'production', city: 'c1', unitType: 'death_star' } });
    expect(await a.next((m) => m.t === 'error' && m.code === 'BAD_MESSAGE')).toBeTruthy();
  });
});
