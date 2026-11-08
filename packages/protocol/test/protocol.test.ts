import { describe, expect, it } from 'vitest';
import { Match, PlayerId, buildPlayerView, generateMap } from '@sc/core';
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, applyPatch, diffView, isEmptyPatch, parseClientMessage, type OnlineView } from '../src/index.js';

describe('parseClientMessage', () => {
  it('accepts well-formed messages', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, name: 'Ana' })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ t: 'cmd', id: 3, cmd: { c: 'move', unit: 'x7', path: [{ x: 1, y: 2 }] } })).ok).toBe(true);
    expect(parseClientMessage(JSON.stringify({ t: 'create', settings: { players: 2, size: { width: 50, height: 30 }, density: 'normal', difficulty: 'hard', turnSeconds: 120, fillWithBots: true } })).ok).toBe(true);
  });

  it('rejects garbage, wrong versions, bad values and oversized frames', () => {
    expect(parseClientMessage('not json').ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: 'hello', v: 999, name: 'Ana' })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: 'cmd', id: 1, cmd: { c: 'production', city: 'c1', unitType: 'death_star' } })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: 'create', settings: { players: 9, size: 'small', density: 'normal', difficulty: 'hard', turnSeconds: 0, fillWithBots: true } })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: 'hello', v: 1, name: 'x'.repeat(MAX_MESSAGE_BYTES) })).ok).toBe(false);
    expect(parseClientMessage(JSON.stringify({ t: 'nope' })).ok).toBe(false);
  });
});

describe('view patches', () => {
  it('diff + apply reproduces the next view exactly, and only sends what changed', () => {
    const players = [PlayerId('p1'), PlayerId('p2')];
    const map = generateMap({ size: 'small', density: 'normal', seed: 'patch' }, players);
    const { match } = Match.start(map.world, players);
    const snap = (): OnlineView => ({
      you: players[0]!,
      meta: { round: match.round, active: match.activePlayer, status: 'playing', winner: null, deadline: null, totalCities: 0 },
      view: buildPlayerView(match.world, match.fogs.get(players[0]!)!),
    });
    const before = snap();
    expect(isEmptyPatch(diffView(before, snap()))).toBe(true);

    const inf = match.world.unitsOf(players[0]!)[0]!;
    const step = match.world.grid.neighbors(inf.position).find((c) => match.world.grid.isLand(c) && !match.world.cityAt(c))!;
    match.move(players[0]!, inf.id, [step]);
    match.endTurn(players[0]!);
    const after = snap();

    const patch = diffView(before, after);
    expect(applyPatch(before, patch)).toEqual(after);
    expect(patch.ownCities).toBeUndefined(); // unchanged lists are not resent
    expect(JSON.stringify(patch).length).toBeLessThan(JSON.stringify(after).length / 3);
  });
});
