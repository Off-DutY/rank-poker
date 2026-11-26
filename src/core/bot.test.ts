import { describe, expect, it } from 'vitest';
import { botAction, estimateRank } from './bot';
import { seededRng } from './cards';
import { type Action, type PlayerAction, createGame, publicView, reduce } from './engine';

describe('estimateRank', () => {
  it('puts a strong hand near the top and a weak hand near the bottom', () => {
    const rng = seededRng(1);
    expect(estimateRank(['As', 'Ah'], [], 6, 2, rng)).toBeGreaterThan(4.5);
    expect(estimateRank(['7c', '2d'], [], 6, 2, rng)).toBeLessThan(3);
  });

  it('uses the board: quads on the board with an ace kicker beat almost everything', () => {
    expect(estimateRank(['Ac', '3d'], ['Ks', 'Kh', 'Kd', 'Kc', '5s'], 4, 2, seededRng(2))).toBeGreaterThan(3.5);
  });
});

describe('botAction', () => {
  /** A 4-seat game in the pick phase of round 1. */
  const game = (steps: [string, PlayerAction][] = []) => {
    let s = createGame('A', 'A');
    const rng = seededRng(1);
    const all: [string, PlayerAction][] = [
      ['A', { type: 'addBot' }],
      ['B', { type: 'join', name: 'B' }],
      ['C', { type: 'join', name: 'C' }],
      ['A', { type: 'settings', settings: { introSeconds: 0 } }],
      ['A', { type: 'start' }],
      ...steps,
    ];
    for (const [id, a] of all) s = reduce(s, { ...a, id } as Action, 1_000, rng);
    return publicView(s);
  };

  it('picks the free rank nearest to the estimate, then locks it', () => {
    const pub = game([
      ['B', { type: 'pick', rank: 3 }],
      ['B', { type: 'lock' }],
    ]);
    expect(botAction(pub, 'bot-1', 3.2)).toEqual({ type: 'pick', rank: 4 });
    expect(botAction(pub, 'bot-1', 1.1)).toEqual({ type: 'pick', rank: 1 });
  });

  it('accepts a swap only when it moves toward the estimate', () => {
    const picks: [string, PlayerAction][] = (
      [
        ['A', 1],
        ['bot-1', 2],
        ['B', 3],
        ['C', 4],
      ] as const
    ).flatMap(([id, rank]) => [
      [id, { type: 'pick', rank }],
      [id, { type: 'lock' }],
    ]);
    const pub = game([...picks, ['C', { type: 'swapRequest', targetId: 'bot-1' }]]);
    expect(botAction(pub, 'bot-1', 3.8)).toEqual({ type: 'swapRespond', requestId: 1, accept: true });
    expect(botAction(pub, 'bot-1', 1.5)).toEqual({ type: 'swapRespond', requestId: 1, accept: false });
  });

  it('does not swap from or to a locked rank', () => {
    const picks: [string, PlayerAction][] = (
      [
        ['A', 1],
        ['bot-1', 4],
        ['B', 2],
        ['C', 3],
      ] as const
    ).flatMap(([id, rank]) => [
      [id, { type: 'pick', rank }],
      [id, { type: 'lock' }],
    ]);
    const pub = game(picks);
    expect(botAction({ ...pub, settings: { ...pub.settings, lockEnd: 'high' } }, 'bot-1', 1)).toEqual({ type: 'swapDone', done: true });
    expect(botAction({ ...pub, settings: { ...pub.settings, lockEnd: 'low' } }, 'bot-1', 1)).toEqual({ type: 'swapDone', done: true });
    expect(botAction(pub, 'bot-1', 1)).toEqual({ type: 'swapRequest', targetId: 'A' });
  });

  it('in the final challenge, waits for the humans and follows their top vote', () => {
    const pub = game();
    const guess = (votes: Record<string, number>) => ({ ...pub, phase: 'GUESS' as const, guess: { target: 'C', votes } });
    expect(botAction(guess({ A: 3 }), 'bot-1', 2)).toBeNull();
    expect(botAction(guess({ A: 3, B: 3 }), 'bot-1', 2)).toEqual({ type: 'guessVote', category: 3 });
    expect(botAction(guess({ A: 3, B: 3, 'bot-1': 3 }), 'bot-1', 2)).toBeNull();
    expect(botAction({ ...guess({}), guess: { target: 'bot-1', votes: {} } }, 'bot-1', 2)).toBeNull();
  });

  it('in a conflict, bids more when its estimate is above the contested rank', () => {
    const picks: [string, PlayerAction][] = (
      [
        ['A', 1],
        ['bot-1', 2],
        ['B', 2],
        ['C', 4],
      ] as const
    ).flatMap(([id, rank]) => [
      [id, { type: 'pick', rank }],
      [id, { type: 'lock' }],
    ]);
    const pub = game(picks);
    expect(pub.phase).toBe('PERSIST');
    const value = (estimate: number) => (botAction(pub, 'bot-1', estimate) as { value: number }).value;
    expect(value(3)).toBeGreaterThan(value(2));
    expect(value(2)).toBeGreaterThan(value(1));
  });
});
