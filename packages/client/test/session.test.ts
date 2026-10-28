import { describe, expect, it } from 'vitest';
import { GameSession } from '../src/session.js';

const opts = { size: 'small', density: 'normal', players: 2, seed: 'session-test' } as const;

/** Simple scripted player: send every idle unit toward the nearest city it doesn't own. */
function playTurn(s: GameSession): void {
  const me = s.viewer;
  for (const city of s.world.citiesOf(me)) if (!city.production) s.setProduction(city.id, 'infantry');
  for (let guard = 0; guard < 50; guard++) {
    const u = s.nextIdleUnit();
    if (!u) break;
    const [target] = s.attackTargets(u.id);
    if (target !== undefined) {
      s.attack(u.id, s.world.grid.coordOf(target));
      if (s.world.unit(u.id)) s.skip(u.id);
      continue;
    }
    const targets = [...s.world.allCities()]
      .filter((c) => c.owner !== me)
      .sort((a, b) => s.world.grid.distance(a.position, u.position) - s.world.grid.distance(b.position, u.position));
    const goal = targets.find((c) => s.plan(u.id, c.position));
    if (!goal) {
      s.skip(u.id);
      continue;
    }
    s.moveTo(u.id, goal.position);
    if (s.world.unit(u.id) && s.world.unit(u.id)!.movesLeft > 0) s.skip(u.id);
  }
  s.endTurn();
  if (s.match.status === 'playing') s.beginTurn();
}

describe('GameSession (hot-seat)', () => {
  it('plays many rounds with orders, captures and production without errors', () => {
    const s = GameSession.create(opts);
    for (let i = 0; i < 60 && s.match.status === 'playing'; i++) playTurn(s);
    expect(s.match.round).toBeGreaterThan(20);
    const captured = s.log.filter((e) => e.text.startsWith('Capturaste'));
    expect(captured.length).toBeGreaterThan(0);
    expect(s.log.some((e) => e.text.includes('completó'))).toBe(true);
  });

  it('only shows each player their own log entries and view', () => {
    const s = GameSession.create(opts);
    for (let i = 0; i < 10; i++) playTurn(s);
    const p1 = s.viewer;
    expect(s.visibleLog().every((e) => e.audience === 'all' || e.audience === p1)).toBe(true);
    expect(s.view().viewer).toBe(p1);
    expect(s.view().ownUnits.every((u) => u.owner === p1)).toBe(true);
  });

  it('keeps multi-turn go-to orders and resumes them on the next turn', () => {
    const s = GameSession.create(opts);
    const inf = s.world.unitsOf(s.viewer)[0]!;
    const far = [...s.world.allCities()]
      .filter((c) => c.owner === null)
      .map((c) => ({ c, plan: s.plan(inf.id, c.position) }))
      .find((x) => x.plan && x.plan.turns >= 3);
    expect(far).toBeDefined();
    s.moveTo(inf.id, far!.c.position);
    expect(s.orders.get(inf.id)).toEqual(far!.c.position);
    const before = { ...inf.position };
    s.endTurn(); s.beginTurn(); // P2
    s.endTurn(); s.beginTurn(); // back to P1: order resumes
    expect(inf.position).not.toEqual(before);
  });

  it('attacks known enemies in range and reports to both players', () => {
    const s = GameSession.create(opts);
    const [p1, p2] = s.players as [typeof s.viewer, typeof s.viewer];
    const inf = s.world.unitsOf(p1)[0]!;
    const spot = s.world.grid
      .neighbors(inf.position)
      .find((c) => s.world.grid.isLand(c) && !s.world.cityAt(c) && s.world.unitsAt(c).length === 0)!;
    const enemy = s.world.spawnUnit('infantry', p2, spot);
    s.match.fogs.get(p1)!.update(s.world);
    s.invalidate();

    expect([...s.attackTargets(inf.id)]).toEqual([s.world.grid.index(spot)]);
    const fc = s.forecast(inf.id, spot)!;
    expect(fc.damageToDefender).toBeGreaterThan(0);
    expect(s.attack(inf.id, spot)).toBeNull();
    expect(s.attackTargets(inf.id).size).toBe(0); // one attack per turn
    expect(s.visibleLog().at(-1)?.text).toMatch(/^Infantería atacó Infantería: −\d+/);
    expect(enemy.hp).toBeLessThan(10);

    s.endTurn();
    s.beginTurn();
    expect(s.viewer).toBe(p2);
    expect(s.visibleLog().some((e) => /enemigo atacó tu Infantería/.test(e.text))).toBe(true);
  });

  it('against the computer: bots play their turns and it is your turn again, no handoff', () => {
    const s = GameSession.create({ ...opts, mode: 'bots', players: 3 });
    const me = s.viewer;
    expect(s.nameOf(s.players[1]!)).toBe('Jugador 2 (bot)');
    for (let i = 0; i < 25; i++) {
      s.endTurn();
      expect(s.awaitingHandoff).toBe(false);
      expect(s.viewer).toBe(me);
    }
    expect(s.match.round).toBe(26);
    // The bots did expand: they own more than their capitals by now.
    const botCities = s.players.slice(1).reduce((n, p) => n + s.world.citiesOf(p).length, 0);
    expect(botCities).toBeGreaterThan(2);
    // And the log only shows the human what the human is allowed to know.
    expect(s.visibleLog().every((e) => e.audience === 'all' || e.audience === me)).toBe(true);
  });

  it('restores the game mode from a save', () => {
    const s = GameSession.create({ ...opts, mode: 'bots' });
    const copy = GameSession.restore(JSON.parse(JSON.stringify(s.save())));
    expect([...copy.bots]).toEqual([...s.bots]);
  });

  it('round-trips through a save', () => {
    const s = GameSession.create(opts);
    for (let i = 0; i < 6; i++) playTurn(s);
    const copy = GameSession.restore(JSON.parse(JSON.stringify(s.save())));
    expect(copy.match.toSnapshot()).toEqual(s.match.toSnapshot());
    expect([...copy.orders]).toEqual([...s.orders]);
    playTurn(copy);
  });

  it('hides the map between turns until the next player takes the seat', () => {
    const s = GameSession.create(opts);
    const p1 = s.viewer;
    s.endTurn();
    expect(s.awaitingHandoff).toBe(true);
    expect(s.viewer).not.toBe(p1);
    s.beginTurn();
    expect(s.awaitingHandoff).toBe(false);
  });
});
