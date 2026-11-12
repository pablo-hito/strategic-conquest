import { describe, expect, it } from 'vitest';
import { Grid, Match, PlayerId, WorldState } from '@sc/core';
import { GameSession } from '../src/session.js';

const P1 = PlayerId('p1');
const P2 = PlayerId('p2');

/** A session over a hand-built world (P1 is the human). */
function sessionWith(build: (w: WorldState) => void): GameSession {
  const s = GameSession.create({ size: 'small', density: 'normal', players: 2, seed: 'joint', mode: 'bots', difficulty: 'normal' });
  const w = new WorldState(Grid.fromAscii(['..........', '..........', '..........', '~~~~~~~~~~', '~~~~~~~~~~']));
  build(w);
  const { match } = Match.start(w, [P1, P2], undefined, 'joint');
  (s as unknown as { match: Match }).match = match;
  s.invalidate();
  return s;
}

describe('joint assault', () => {
  it('everyone in range strikes until the city is empty, then a capturer walks in', () => {
    const s = sessionWith((w) => {
      w.foundCity('Home', { x: 0, y: 0 }).capture(P1);
      w.foundCity('Far', { x: 9, y: 0 }).capture(P2);
      const target = w.foundCity('Target', { x: 5, y: 1 });
      target.capture(P2);
      w.spawnUnit('infantry', P2, target.position);
      w.spawnUnit('fighter', P2, target.position); // parked aircraft don't defend
      for (const at of [{ x: 4, y: 0 }, { x: 4, y: 1 }, { x: 4, y: 2 }, { x: 6, y: 0 }]) w.spawnUnit('heavy_tank', P1, at);
      w.spawnUnit('infantry', P1, { x: 6, y: 2 });
    });
    expect(s.viewer).toBe(P1);
    const strikers = s.strikersAt({ x: 5, y: 1 });
    expect(strikers.length).toBeGreaterThanOrEqual(4);
    const msg = s.jointAssault({ x: 5, y: 1 });
    expect(msg).toMatch(/Ciudad tomada/);
    expect(s.world.cityAt({ x: 5, y: 1 })?.owner).toBe(P1);
  });

  it('says so when nobody can strike', () => {
    const s = sessionWith((w) => {
      w.foundCity('Home', { x: 0, y: 0 }).capture(P1);
      w.foundCity('Far', { x: 9, y: 0 }).capture(P2);
      w.spawnUnit('infantry', P2, { x: 8, y: 1 });
      w.spawnUnit('infantry', P1, { x: 1, y: 1 });
    });
    expect(s.jointAssault({ x: 8, y: 1 })).toMatch(/Ninguna unidad/);
  });
});

describe('loading transports', () => {
  it('a transport in port takes the troops on its tile and next to it, as many as fit', () => {
    let tId = '';
    const s = sessionWith((w) => {
      const port = w.foundCity('Port', { x: 4, y: 2 });
      port.capture(P1);
      w.foundCity('Far', { x: 9, y: 0 }).capture(P2);
      tId = w.spawnUnit('transport', P1, port.position).id;
      w.spawnUnit('infantry', P1, port.position);
      w.spawnUnit('heavy_tank', P1, { x: 4, y: 1 });
      w.spawnUnit('infantry', P1, { x: 5, y: 2 });
      w.spawnUnit('heavy_tank', P1, { x: 3, y: 2 }); // 1 + 3 + 1 + 3 > 6: one tank stays
      w.spawnUnit('infantry', P1, { x: 0, y: 0 }); // too far
    });
    const msg = s.loadAll(tId as never);
    const t = s.world.unit(tId as never)!;
    expect(msg).toMatch(/Subieron 3/);
    expect(t.cargoLoad).toBe(5);
  });

  it('a land unit embarks on the transport next to it at sea', () => {
    let infId = '';
    const s = sessionWith((w) => {
      w.foundCity('Home', { x: 0, y: 0 }).capture(P1);
      w.foundCity('Far', { x: 9, y: 0 }).capture(P2);
      w.spawnUnit('transport', P1, { x: 2, y: 3 });
      infId = w.spawnUnit('infantry', P1, { x: 2, y: 2 }).id;
    });
    expect(s.embark(infId as never)).toMatch(/Embarcó/);
    expect(s.world.unit(infId as never)!.carriedBy).not.toBeNull();
  });
});
