import { describe, expect, it } from 'vitest';
import { seededRng } from '../core/cards';
import { type Action, type GameState, type PlayerAction, createGame, publicView, reduce } from '../core/engine';
import { rankChanges } from './render';

function play(steps: [string, PlayerAction][]): GameState {
  let s = createGame('A', 'A');
  const rng = seededRng(1);
  const all: [string, PlayerAction][] = [
    ['B', { type: 'join', name: 'B' }],
    ['C', { type: 'join', name: 'C' }],
    ['A', { type: 'settings', settings: { introSeconds: 0 } }],
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
      title: '名次確定：選擇 → 結果',
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
    expect(rc.title).toBe('翻牌前 → 翻牌 的名次變化');
    expect(rc.rows).toEqual([
      { id: 'C', from: 3, to: 1 },
      { id: 'B', from: 2, to: 2 },
      { id: 'A', from: 1, to: 3 },
    ]);
  });
});
