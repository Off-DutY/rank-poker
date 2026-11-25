import { describe, expect, it } from 'vitest';
import { seededRng } from './cards';
import { assignRanks, findConflicts, isCorrectOrder } from './resolve';

const rng = seededRng(1);
const isPermutation = (ranks: Record<string, number>, n: number) =>
  Object.values(ranks).sort((a, b) => a - b).join() === Array.from({ length: n }, (_, i) => i + 1).join();

describe('findConflicts', () => {
  it('returns only players that share a rank', () => {
    expect(findConflicts(['A', 'B', 'C', 'D'], { A: 2, B: 2, C: 3, D: null })).toEqual(['A', 'B']);
  });
  it('ignores players without a pick', () => {
    expect(findConflicts(['A', 'B'], { A: null, B: null })).toEqual([]);
  });
});

describe('assignRanks', () => {
  it('keeps distinct picks unchanged', () => {
    const r = assignRanks(['A', 'B', 'C'], { A: 3, B: 1, C: 2 }, {}, rng);
    expect(r).toEqual({ A: 3, B: 1, C: 2 });
  });

  it('matches the spec 6.2 example', () => {
    const r = assignRanks(
      ['A', 'B', 'C', 'D', 'E'],
      { A: 3, B: 3, C: 3, D: 5, E: 1 },
      { A: { amount: 80, at: 1 }, B: { amount: 10, at: 1 }, C: { amount: 40, at: 1 } },
      rng,
    );
    expect(r).toEqual({ E: 1, B: 2, C: 3, A: 4, D: 5 });
  });

  it('breaks equal amounts by earlier submission', () => {
    const r = assignRanks(['A', 'B', 'C'], { A: 2, B: 2, C: 3 }, { A: { amount: 5, at: 20 }, B: { amount: 5, at: 10 } }, rng);
    expect(r.B).toBe(2);
    expect(r.A).toBe(1);
  });

  it('breaks full ties by seat order', () => {
    const r = assignRanks(['A', 'B', 'C'], { A: 3, B: 3, C: 1 }, {}, rng);
    expect(r).toEqual({ A: 3, B: 2, C: 1 });
  });

  it('orders a group from the weakest bid to the strongest bid', () => {
    const r = assignRanks(['A', 'B', 'C'], { A: 2, B: 2, C: 2 }, { A: { amount: 3, at: 0 }, B: { amount: 2, at: 0 }, C: { amount: 1, at: 0 } }, rng);
    expect(r).toEqual({ C: 1, B: 2, A: 3 });
  });

  it('does not keep the contested rank for the winner', () => {
    // A wins rank 1, but B sorts before A, so A gets 2. There is no fill to the nearest free rank.
    const r = assignRanks(['A', 'B', 'C', 'D'], { A: 1, B: 1, C: 4, D: 3 }, { A: { amount: 9, at: 0 }, B: { amount: 1, at: 0 } }, rng);
    expect(r).toEqual({ B: 1, A: 2, D: 3, C: 4 });
  });

  it('sorts by pick, then by bid inside each pick', () => {
    const r = assignRanks(
      ['A', 'B', 'C', 'D', 'E'],
      { A: 3, B: 3, C: 5, D: 5, E: 1 },
      { A: { amount: 9, at: 0 }, B: { amount: 1, at: 0 }, C: { amount: 9, at: 0 }, D: { amount: 5, at: 0 } },
      rng,
    );
    expect(r).toEqual({ A: 3, C: 5, E: 1, D: 4, B: 2 });
  });

  it('handles everyone on the same rank', () => {
    const order = ['A', 'B', 'C', 'D', 'E', 'F'];
    const picks = Object.fromEntries(order.map((id) => [id, 6]));
    const bids = Object.fromEntries(order.map((id, i) => [id, { amount: 10 - i, at: 0 }]));
    const r = assignRanks(order, picks, bids, rng);
    expect(r).toEqual({ A: 6, B: 5, C: 4, D: 3, E: 2, F: 1 });
  });

  it('gives a random pick to players without a pick', () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 40; seed++) {
      const r = assignRanks(['A', 'B', 'C', 'D'], { A: 2, B: null, C: 2, D: null }, {}, seededRng(seed));
      expect(r.A).toBeGreaterThan(r.C!);
      expect(isPermutation(r, 4)).toBe(true);
      seen.add(r.B!);
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('treats out-of-range picks as no pick', () => {
    const r = assignRanks(['A', 'B', 'C'], { A: 0, B: 9, C: 1.5 }, {}, rng);
    expect(isPermutation(r, 3)).toBe(true);
  });

  it('always returns a permutation (random fuzz)', () => {
    const fuzz = seededRng(42);
    for (let t = 0; t < 500; t++) {
      const n = 3 + fuzz.int(11);
      const order = Array.from({ length: n }, (_, i) => `P${i}`);
      const picks = Object.fromEntries(order.map((id) => [id, fuzz.int(5) === 0 ? null : 1 + fuzz.int(n)]));
      const bids = Object.fromEntries(order.map((id) => [id, { amount: fuzz.int(100), at: fuzz.int(3) }]));
      expect(isPermutation(assignRanks(order, picks, bids, fuzz), n)).toBe(true);
    }
  });
});

describe('isCorrectOrder', () => {
  it('accepts ascending strength', () => {
    expect(isCorrectOrder({ A: 1, B: 2, C: 3 }, { A: 10, B: 20, C: 30 })).toBe(true);
  });
  it('rejects an inversion', () => {
    expect(isCorrectOrder({ A: 1, B: 2, C: 3 }, { A: 10, B: 30, C: 20 })).toBe(false);
  });
  it('accepts tied hands in either order', () => {
    expect(isCorrectOrder({ A: 1, B: 2, C: 3 }, { A: 10, B: 20, C: 20 })).toBe(true);
    expect(isCorrectOrder({ A: 1, C: 2, B: 3 }, { A: 10, B: 20, C: 20 })).toBe(true);
  });
});
