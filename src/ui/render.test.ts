import { describe, expect, it } from 'vitest';
import { seededRng } from '../core/cards';
import { type Action, type GameState, type PlayerAction, createGame, publicView, reduce } from '../core/engine';
import { betLabel, rankChanges } from './render';

function play(steps: [string, PlayerAction][], skipRound = 0): GameState {
  let s = createGame('A', 'A');
  const rng = seededRng(1);
  const all: [string, PlayerAction][] = [
    ['B', { type: 'join', name: 'B' }],
    ['C', { type: 'join', name: 'C' }],
    ['A', { type: 'settings', settings: { introSeconds: 0, skipRound } }],
    ['A', { type: 'start' }],
    ...steps,
  ];
  for (const [id, a] of all) s = reduce(s, { ...a, id } as Action, 1_000, rng);
  return s;
}
const pickAll = (r: Record<string, number>): [string, PlayerAction][] =>
  Object.entries(r).flatMap(([id, rank]) => [
    [id, { type: 'pick', rank }],
    [id, { type: 'lock' }],
  ]);
const doneAll: [string, PlayerAction][] = ['A', 'B', 'C'].map((id) => [id, { type: 'swapDone', done: true }]);

describe('rankChanges', () => {
  it('shows nothing in round 1 picking', () => {
    expect(rankChanges(publicView(play([])))).toBeNull();
  });

  it('compares picks with assigned ranks in the swap intro', () => {
    const s = play([...pickAll({ A: 2, B: 2, C: 3 }), ['A', { type: 'persist', value: 1 }], ['B', { type: 'persist', value: 0 }]]);
    expect(rankChanges(publicView(s))).toEqual({
      title: '順位確定：選擇 → 結果',
      rows: [
        { id: 'B', from: 2, to: 1 },
        { id: 'A', from: 2, to: 2 },
        { id: 'C', from: 3, to: 3 },
      ],
    });
  });

  it('compares the last 2 finished rounds in a pick intro', () => {
    const s = play([...pickAll({ A: 1, B: 2, C: 3 }), ...doneAll, ...pickAll({ A: 3, B: 2, C: 1 }), ...doneAll]);
    const rc = rankChanges(publicView(s))!;
    expect(rc.title).toBe('翻牌前 → 翻牌 的順位變化');
    expect(rc.rows).toEqual([
      { id: 'C', from: 3, to: 1 },
      { id: 'B', from: 2, to: 2 },
      { id: 'A', from: 1, to: 3 },
    ]);
  });

  it('names the played rounds when a round is skipped', () => {
    const one = play([...pickAll({ A: 1, B: 2, C: 3 }), ...doneAll], 2);
    expect(rankChanges(publicView(one))!.title).toBe('翻牌前的最終順位');
    const two = play([...pickAll({ A: 1, B: 2, C: 3 }), ...doneAll, ...pickAll({ A: 1, B: 2, C: 3 }), ...doneAll], 2);
    expect(rankChanges(publicView(two))!.title).toBe('翻牌前 → 轉牌 的順位變化');
  });
});

describe('betLabel', () => {
  it('names the slider position with a betting word: fold at 0, all-in only at the end', () => {
    expect([0, 0.1, 0.4, 0.8, 0.999, 1].map((v) => betLabel(v).text)).toEqual(['蓋牌', '跟注', '加注', '再加注', '再加注', 'All-in！']);
  });
});
