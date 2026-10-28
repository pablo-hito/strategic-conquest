import type { Coord, TileIndex } from '../grid/coords.js';
import { MinHeap } from '../shared/min-heap.js';
import type { Unit } from '../units/unit.js';
import type { MapKnowledge } from './map-knowledge.js';
import { checkStep, type StepKind } from './step-rules.js';

export interface PathStep {
  readonly coord: Coord;
  /** 0 = this turn, 1 = next turn, ... */
  readonly turn: number;
  readonly kind: StepKind;
}

export interface PlannedPath {
  readonly steps: PathStep[];
  /** Turns needed to complete the path (1 = arrives this turn). */
  readonly turns: number;
}

/**
 * Turn-aware search state. Movement is not a plain sum of costs because of the
 * minimum-move rule (a fresh unit can always take one step, spending all its MP),
 * so we track (turn, MP used this turn) and order states by g = turn * M + used.
 * A smaller g always dominates (fewer turns, or more MP left), so Dijkstra/A* stay
 * correct on it.
 */
interface Node {
  readonly idx: TileIndex;
  readonly turn: number;
  readonly used: number;
  readonly flights: number;
  readonly kind: StepKind;
  readonly prev: Node | null;
}

const gOf = (n: Node, M: number) => n.turn * M + n.used;

function advance(turn: number, used: number, cost: number, M: number): { turn: number; used: number } {
  if (used + cost <= M) return { turn, used: used + cost };
  if (used === 0) return { turn, used: M }; // fresh unit: minimum-move rule
  return { turn: turn + 1, used: Math.min(cost, M) };
}

function startNode(k: MapKnowledge, unit: Unit): Node {
  const M = unit.maxMoves;
  return {
    idx: k.grid.index(unit.position),
    turn: 0,
    used: M - unit.movesLeft,
    flights: 0,
    kind: 'move',
    prev: null,
  };
}

/** Successors of a node; boarding ends a unit's move, so board nodes are leaves. */
function* successors(k: MapKnowledge, unit: Unit, n: Node): Generator<Node> {
  if (n.kind === 'board' && n.prev !== null) return;
  const M = unit.maxMoves;
  const fuel = unit.fuel;
  const here = k.grid.coordOf(n.idx);
  for (const next of k.grid.neighbors(here)) {
    const r = checkStep(k, unit, here, next);
    if (!r.ok) continue;
    if (fuel !== null && n.flights + 1 > fuel) continue;
    const { turn, used } = advance(n.turn, n.used, r.value.cost, M);
    yield { idx: k.grid.index(next), turn, used, flights: n.flights + 1, kind: r.value.kind, prev: n };
  }
}

function toPath(k: MapKnowledge, end: Node): PlannedPath {
  const steps: PathStep[] = [];
  for (let n: Node | null = end; n?.prev; n = n.prev) {
    steps.push({ coord: k.grid.coordOf(n.idx), turn: n.turn, kind: n.kind });
  }
  steps.reverse();
  return { steps, turns: (steps.at(-1)?.turn ?? 0) + 1 };
}

/**
 * Cheapest path (fewest turns, then most MP left) from the unit to `goal`, possibly
 * spanning several turns. Aircraft paths are capped by remaining fuel.
 * Returns null if unreachable with what `k` knows.
 */
export function findPath(k: MapKnowledge, unit: Unit, goal: Coord): PlannedPath | null {
  const { grid } = k;
  if (!grid.inBounds(goal)) return null;
  const M = unit.maxMoves;
  const goalIdx = grid.index(goal);
  const start = startNode(k, unit);
  if (start.idx === goalIdx) return { steps: [], turns: 0 };

  const best = new Map<TileIndex, number>([[start.idx, gOf(start, M)]]);
  const open = new MinHeap<Node>();
  open.push(gOf(start, M) + grid.distance(unit.position, goal), start);

  for (let n = open.pop(); n; n = open.pop()) {
    if (n.idx === goalIdx) return toPath(k, n);
    if (gOf(n, M) > (best.get(n.idx) ?? Infinity)) continue;
    for (const s of successors(k, unit, n)) {
      const g = gOf(s, M);
      if (g >= (best.get(s.idx) ?? Infinity)) continue;
      best.set(s.idx, g);
      open.push(g + grid.distance(grid.coordOf(s.idx), goal), s);
    }
  }
  return null;
}

export interface ReachableTile {
  readonly coord: Coord;
  /** MP left after arriving. */
  readonly movesLeft: number;
  readonly kind: StepKind;
}

/** Every tile the unit can reach this turn (the movement overlay). */
export function reachableThisTurn(k: MapKnowledge, unit: Unit): Map<TileIndex, ReachableTile> {
  const out = new Map<TileIndex, ReachableTile>();
  if (unit.movesLeft <= 0) return out;
  const M = unit.maxMoves;
  const start = startNode(k, unit);
  const best = new Map<TileIndex, number>([[start.idx, gOf(start, M)]]);
  const open = new MinHeap<Node>();
  open.push(gOf(start, M), start);

  for (let n = open.pop(); n; n = open.pop()) {
    if (gOf(n, M) > (best.get(n.idx) ?? Infinity)) continue;
    if (n.prev) out.set(n.idx, { coord: k.grid.coordOf(n.idx), movesLeft: M - n.used, kind: n.kind });
    for (const s of successors(k, unit, n)) {
      if (s.turn > 0) continue;
      const g = gOf(s, M);
      if (g >= (best.get(s.idx) ?? Infinity)) continue;
      best.set(s.idx, g);
      open.push(g, s);
    }
  }
  return out;
}
