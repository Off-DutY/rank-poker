import { beforeEach, describe, expect, it } from 'vitest';
import { seededRng } from './cards';
import { categoryOf, evaluateBest } from './evaluator';
import {
  type Action,
  type GameState,
  type PlayerAction,
  RULES,
  type Settings,
  cleanName,
  createGame,
  joinRejection,
  lockedRanks,
  nextDeadline,
  privateView,
  publicView,
  reduce,
} from './engine';

/** Small test harness around the reducer with a manual clock. */
class Table {
  s: GameState;
  now = 1_000;
  rng = seededRng(7);

  constructor(n: number, settings: Partial<Settings> = {}) {
    this.s = createGame('P0', 'Host');
    for (let i = 1; i < n; i++) this.act(`P${i}`, { type: 'join', name: `N${i}` });
    // Tests run without the intro pause unless a test sets it.
    this.act('P0', { type: 'settings', settings: { introSeconds: 0, ...settings } });
  }

  get ids() {
    return this.s.seats.map((x) => x.id);
  }

  act(id: string, a: PlayerAction): boolean {
    const before = this.s;
    this.s = reduce(this.s, { ...a, id } as Action, this.now, this.rng);
    return this.s !== before;
  }

  /** Moves the clock and sends a tick, like the host timer does. */
  advance(ms: number): void {
    this.now += ms;
    this.s = reduce(this.s, { type: 'tick' }, this.now, this.rng);
  }

  /** Every player picks and locks the given ranks. */
  pickAll(ranks: Record<string, number>): void {
    for (const [id, r] of Object.entries(ranks)) {
      this.act(id, { type: 'pick', rank: r });
      this.act(id, { type: 'lock' });
    }
  }

  allDone(): void {
    for (const id of this.ids) this.act(id, { type: 'swapDone', done: true });
  }

  /** Plays a round with distinct picks (rank = seat index + 1) and finishes the swap phase. */
  playQuietRound(): void {
    this.pickAll(Object.fromEntries(this.ids.map((id) => [id, this.s.ranks[id] ?? this.ids.indexOf(id) + 1])));
    if (this.s.phase === 'SWAP') this.allDone();
  }
}

describe('lobby', () => {
  it('cleans names', () => {
    expect(cleanName('  a\u0000b  ')).toBe('ab');
    expect(cleanName('')).toBe('玩家');
    expect(cleanName('一二三四五六七八九十一二三')).toHaveLength(12);
  });

  it('caps the room at 13 players', () => {
    const t = new Table(13);
    expect(joinRejection(t.s, 'X')).toBe('full');
    expect(t.act('X', { type: 'join', name: 'x' })).toBe(false);
  });

  it('needs 3 players to start, and only the host can start', () => {
    const t = new Table(2);
    expect(t.act('P0', { type: 'start' })).toBe(false);
    t.act('P2', { type: 'join', name: 'c' });
    expect(t.act('P1', { type: 'start' })).toBe(false);
    expect(t.act('P0', { type: 'start' })).toBe(true);
    expect(t.s.phase).toBe('PICK');
  });

  it('rejects new players after start but lets known players rejoin', () => {
    const t = new Table(3);
    t.act('P0', { type: 'start' });
    expect(joinRejection(t.s, 'X')).toBe('started');
    t.act('P1', { type: 'leave' });
    expect(t.s.seats[1]!.connected).toBe(false);
    expect(t.act('P1', { type: 'join', name: 'new name' })).toBe(true);
    expect(t.s.seats[1]).toMatchObject({ connected: true, name: 'N1' });
  });

  it('removes a seat when a player leaves the lobby', () => {
    const t = new Table(3);
    t.act('P2', { type: 'leave' });
    expect(t.ids).toEqual(['P0', 'P1']);
  });

  it('clamps settings and only accepts them from the host', () => {
    const t = new Table(3);
    expect(t.act('P1', { type: 'settings', settings: { swapSeconds: 5 } })).toBe(false);
    t.act('P0', { type: 'settings', settings: { swapSeconds: 999, challenge: false } });
    expect(t.s.settings).toMatchObject({ swapSeconds: 180, challenge: false });
    t.act('P0', { type: 'settings', settings: { introSeconds: 99, notifyStyle: 'nope' as never } });
    expect(t.s.settings).toMatchObject({ introSeconds: 5, notifyStyle: 'banner' });
    t.act('P0', { type: 'settings', settings: { holeCards: 4, skipRound: 4 } });
    expect(t.s.settings).toMatchObject({ holeCards: 2, skipRound: 0 });
    t.act('P0', { type: 'settings', settings: { holeCards: 3, skipRound: 2 } });
    expect(t.s.settings).toMatchObject({ holeCards: 3, skipRound: 2 });
  });
});

describe('computer players', () => {
  it('lets only the host add and remove them in the lobby', () => {
    const t = new Table(1);
    expect(t.act('P1', { type: 'addBot' })).toBe(false);
    t.act('P0', { type: 'addBot' });
    t.act('P0', { type: 'addBot' });
    expect(t.s.seats.map((x) => [x.id, x.name, x.bot])).toEqual([
      ['P0', 'Host', undefined],
      ['bot-1', '電腦 1', true],
      ['bot-2', '電腦 2', true],
    ]);
    expect(t.act('P0', { type: 'removeBot', targetId: 'P0' })).toBe(false);
    t.act('P0', { type: 'removeBot', targetId: 'bot-1' });
    t.act('P0', { type: 'addBot' });
    expect(t.ids).toEqual(['P0', 'bot-2', 'bot-1']);
    t.act('P0', { type: 'start' });
    expect(t.s.phase).toBe('PICK');
    expect(t.act('P0', { type: 'addBot' })).toBe(false);
  });

  it('stops at 13 seats and never lets a person take a computer seat', () => {
    const t = new Table(12);
    t.act('P0', { type: 'addBot' });
    expect(t.act('P0', { type: 'addBot' })).toBe(false);
    expect(joinRejection(t.s, 'bot-1')).toBe('full');
    expect(t.act('bot-1', { type: 'join', name: 'x' })).toBe(false);
  });
});

describe('deal', () => {
  it('deals 2 unique cards per player and 5 hidden board cards', () => {
    const t = new Table(13);
    t.act('P0', { type: 'start' });
    const cards = [...Object.values(t.s.hole).flat(), ...t.s.fullBoard];
    expect(cards).toHaveLength(31);
    expect(new Set(cards).size).toBe(31);
    expect(t.s.board).toEqual([]);
  });

  it('deals 3 unique hole cards per player when holeCards is 3, and scores the best 5 of 8', () => {
    const t = new Table(13, { holeCards: 3, swapSeconds: 0 });
    t.act('P0', { type: 'start' });
    const cards = [...Object.values(t.s.hole).flat(), ...t.s.fullBoard];
    expect(Object.values(t.s.hole).every((h) => h.length === 3)).toBe(true);
    expect(new Set(cards).size).toBe(44);
    expect(privateView(t.s, 'P1').hole).toHaveLength(3);
    for (let r = 0; r < 4; r++) t.playQuietRound();
    expect(t.s.phase).toBe('SHOWDOWN');
    const e = t.s.showdown!.entries.P1!;
    expect(e.hole).toHaveLength(3);
    expect(e.score).toBe(evaluateBest([...t.s.hole.P1!, ...t.s.fullBoard]));
  });
});

describe('skip round', () => {
  // Rounds played and board size in each, by the skipped round.
  const cases: [skip: number, rounds: number[], boards: number[]][] = [
    [1, [2, 3, 4], [3, 4, 5]],
    [2, [1, 3, 4], [0, 4, 5]],
    [3, [1, 2, 4], [0, 3, 5]],
  ];
  it.each(cases)('skipRound %i plays rounds %j', (skip, rounds, boards) => {
    const t = new Table(3, { skipRound: skip });
    t.act('P0', { type: 'start' });
    rounds.forEach((r, i) => {
      expect(t.s.round).toBe(r);
      expect(t.s.board).toHaveLength(boards[i]!);
      t.playQuietRound();
    });
    expect(t.s.phase).toBe('SHOWDOWN');
    expect(t.s.history.P0).toHaveLength(3);
  });
});

describe('pick phase', () => {
  let t: Table;
  beforeEach(() => {
    t = new Table(4);
    t.act('P0', { type: 'start' });
  });

  it('rejects ranks out of range and changes after lock', () => {
    expect(t.act('P1', { type: 'pick', rank: 0 })).toBe(false);
    expect(t.act('P1', { type: 'pick', rank: 5 })).toBe(false);
    expect(t.act('P1', { type: 'pick', rank: 2.5 })).toBe(false);
    expect(t.act('P1', { type: 'lock' })).toBe(false);
    t.act('P1', { type: 'pick', rank: 2 });
    t.act('P1', { type: 'lock' });
    expect(t.act('P1', { type: 'pick', rank: 3 })).toBe(false);
  });

  it('lets a player unlock and change the pick while others are still picking', () => {
    t.act('P0', { type: 'pick', rank: 1 });
    t.act('P0', { type: 'lock' });
    expect(t.act('P0', { type: 'unlock' })).toBe(true);
    expect(t.act('P0', { type: 'unlock' })).toBe(false);
    expect(t.act('P0', { type: 'pick', rank: 3 })).toBe(true);
    t.act('P0', { type: 'lock' });
    expect(t.s.picks.P0).toMatchObject({ rank: 3, locked: true });
  });

  it('cannot unlock after the last player locks', () => {
    t.pickAll({ P0: 1, P1: 2, P2: 3, P3: 4 });
    expect(t.act('P0', { type: 'unlock' })).toBe(false);
  });

  it('goes to the swap phase when all lock distinct ranks', () => {
    t.pickAll({ P0: 1, P1: 2, P2: 3, P3: 4 });
    expect(t.s.phase).toBe('SWAP');
    expect(t.s.ranks).toEqual({ P0: 1, P1: 2, P2: 3, P3: 4 });
  });

  it('on timeout, locks current picks and gives random picks to the rest', () => {
    t.act('P0', { type: 'pick', rank: 4 });
    t.act('P1', { type: 'pick', rank: 1 });
    t.advance(RULES.pickMs);
    expect(t.s.phase).toBe('PICK');
    t.advance(RULES.graceMs);
    expect(t.s.phase).toBe('SWAP');
    expect(t.s.picks.P0).toMatchObject({ rank: 4, locked: true });
    expect(t.s.ranks.P1).toBeLessThan(t.s.ranks.P0!);
    expect(Object.values(t.s.ranks).sort()).toEqual([1, 2, 3, 4]);
  });

  it('counts clicks on the current rank as hype, at most once per hypeMs, and resets on a new rank', () => {
    t.act('P0', { type: 'pick', rank: 2 });
    expect(t.s.picks.P0!.hype).toBe(0);
    expect(t.act('P0', { type: 'pick', rank: 2 })).toBe(true);
    expect(t.act('P0', { type: 'pick', rank: 2 })).toBe(false);
    t.now += RULES.hypeMs;
    expect(t.act('P0', { type: 'pick', rank: 2 })).toBe(true);
    expect(publicView(t.s).picks.P0!.hype).toBe(2);
    t.act('P0', { type: 'pick', rank: 3 });
    expect(t.s.picks.P0!.hype).toBe(0);
    t.act('P0', { type: 'lock' });
    t.now += RULES.hypeMs;
    expect(t.act('P0', { type: 'pick', rank: 3 })).toBe(false);
  });

  it('accepts actions inside the grace period', () => {
    t.now += RULES.pickMs + RULES.graceMs - 1;
    expect(t.act('P0', { type: 'pick', rank: 1 })).toBe(true);
  });

  it('uses the previous round ranks as the default pick', () => {
    t.pickAll({ P0: 4, P1: 3, P2: 2, P3: 1 });
    t.allDone();
    expect(t.s.round).toBe(2);
    expect(t.s.board).toHaveLength(3);
    expect(t.s.picks.P0).toMatchObject({ rank: 4, locked: false });
  });
});

describe('conflict', () => {
  let t: Table;
  beforeEach(() => {
    t = new Table(4);
    t.act('P0', { type: 'start' });
    t.pickAll({ P0: 2, P1: 2, P2: 2, P3: 4 });
  });

  it('opens the persistence window for the conflicting players only', () => {
    expect(t.s.phase).toBe('PERSIST');
    expect(t.s.conflict!.participants).toEqual(['P0', 'P1', 'P2']);
    expect(t.act('P3', { type: 'persist', value: 1 })).toBe(false);
  });

  it('resolves by bid strength', () => {
    t.act('P0', { type: 'persist', value: 0.1 });
    t.act('P1', { type: 'persist', value: 0.5 });
    expect(t.act('P1', { type: 'persist', value: 1 })).toBe(false);
    t.act('P2', { type: 'persist', value: 0.3 });
    expect(t.s.phase).toBe('SWAP');
    // Rank 2 group sorts from the weakest bid: P0 (0.1), P2 (0.3), P1 (0.5).
    expect(t.s.ranks).toEqual({ P0: 1, P2: 2, P1: 3, P3: 4 });
  });

  it('treats a missing bid as 0 at the deadline', () => {
    t.act('P2', { type: 'persist', value: 0 });
    t.advance(RULES.persistMs + RULES.graceMs);
    expect(t.s.phase).toBe('SWAP');
    // P2 bid 0 before the deadline, so P2 beats the 0-bids at the deadline and gets the largest rank of the group.
    expect(t.s.ranks.P2).toBe(3);
  });

  it('clamps bad slider values', () => {
    t.act('P0', { type: 'persist', value: 5 });
    t.act('P1', { type: 'persist', value: Number.NaN });
    expect(t.s.conflict!.bids.P0!.amount).toBe(1);
    expect(t.s.conflict!.bids.P1!.amount).toBe(0);
  });

  it('does not use up persistence: a full bid is possible again in the next conflict', () => {
    const z = new Table(3, { swapSeconds: 0 });
    z.act('P0', { type: 'start' });
    z.pickAll({ P0: 1, P1: 1, P2: 3 });
    z.act('P0', { type: 'persist', value: 1 });
    z.act('P1', { type: 'persist', value: 0.2 });
    expect(z.s.ranks).toEqual({ P1: 1, P0: 2, P2: 3 });
    z.pickAll({ P0: 3, P1: 3, P2: 1 });
    z.act('P0', { type: 'persist', value: 1 });
    z.act('P1', { type: 'persist', value: 0.9 });
    expect(z.s.ranks).toEqual({ P2: 1, P1: 2, P0: 3 });
    expect(Object.keys(privateView(z.s, 'P0'))).toEqual(['hole']);
  });
});

describe('swap phase', () => {
  let t: Table;
  const req = () => t.s.swap!.requests.at(-1)!;
  beforeEach(() => {
    t = new Table(4);
    t.act('P0', { type: 'start' });
    t.pickAll({ P0: 1, P1: 2, P2: 3, P3: 4 });
  });

  it('moves the requester to the target rank and shifts the players between when the target accepts', () => {
    t.act('P0', { type: 'swapRequest', targetId: 'P3' });
    expect(t.act('P0', { type: 'swapRespond', requestId: req().id, accept: true })).toBe(false);
    t.act('P3', { type: 'swapRespond', requestId: req().id, accept: true });
    expect(req().status).toBe('accepted');
    expect(t.s.ranks).toEqual({ P0: 4, P1: 1, P2: 2, P3: 3 });
  });

  it('shifts the players between down when the requester moves up', () => {
    t.act('P3', { type: 'swapRequest', targetId: 'P1' });
    t.act('P1', { type: 'swapRespond', requestId: req().id, accept: true });
    expect(t.s.ranks).toEqual({ P0: 1, P1: 3, P2: 4, P3: 2 });
  });

  it('allows only 1 active request per player and 1 request per pair', () => {
    t.act('P0', { type: 'swapRequest', targetId: 'P1' });
    expect(t.act('P2', { type: 'swapRequest', targetId: 'P1' })).toBe(false);
    expect(t.act('P0', { type: 'swapRequest', targetId: 'P2' })).toBe(false);
    expect(t.act('P0', { type: 'swapRequest', targetId: 'P0' })).toBe(false);
    t.act('P1', { type: 'swapRespond', requestId: req().id, accept: true });
    expect(t.act('P1', { type: 'swapRequest', targetId: 'P0' })).toBe(false);
    expect(t.act('P1', { type: 'swapRequest', targetId: 'P2' })).toBe(true);
  });

  it('lets the requester challenge after a reject, and the stronger bid wins', () => {
    t.act('P0', { type: 'swapRequest', targetId: 'P3' });
    t.act('P3', { type: 'swapRespond', requestId: req().id, accept: false });
    expect(req().status).toBe('deciding');
    expect(t.act('P3', { type: 'swapChallenge', requestId: req().id })).toBe(false);
    t.act('P0', { type: 'swapChallenge', requestId: req().id });
    t.act('P0', { type: 'persist', value: 0.6 });
    t.act('P3', { type: 'persist', value: 0.4 });
    expect(req().status).toBe('won');
    expect(t.s.ranks).toEqual({ P0: 4, P1: 1, P2: 2, P3: 3 });
  });

  it('keeps ranks when the defender bids the same and earlier', () => {
    t.act('P0', { type: 'swapRequest', targetId: 'P3' });
    t.act('P3', { type: 'swapRespond', requestId: req().id, accept: false });
    t.act('P0', { type: 'swapChallenge', requestId: req().id });
    t.act('P3', { type: 'persist', value: 0.5 });
    t.now += 1;
    t.act('P0', { type: 'persist', value: 0.5 });
    expect(req().status).toBe('lost');
    expect(t.s.ranks).toMatchObject({ P0: 1, P3: 4 });
  });

  it('declines a request that gets no answer, then expires the challenge choice', () => {
    t.act('P0', { type: 'swapRequest', targetId: 'P3' });
    t.advance(RULES.respondMs + RULES.graceMs);
    expect(req().status).toBe('deciding');
    t.advance(RULES.challengeDecideMs + RULES.graceMs);
    expect(req().status).toBe('declined');
  });

  it('has no challenge when the host turns it off', () => {
    const f = new Table(3, { challenge: false });
    f.act('P0', { type: 'start' });
    f.pickAll({ P0: 1, P1: 2, P2: 3 });
    f.act('P0', { type: 'swapRequest', targetId: 'P1' });
    const r = f.s.swap!.requests[0]!;
    f.act('P1', { type: 'swapRespond', requestId: r.id, accept: false });
    expect(f.s.swap!.requests[0]!.status).toBe('declined');
  });

  it('waits for active requests before ending, even when all players are done', () => {
    t.act('P0', { type: 'swapRequest', targetId: 'P1' });
    t.allDone();
    expect(t.s.phase).toBe('SWAP');
    t.act('P1', { type: 'swapRespond', requestId: req().id, accept: false });
    expect(t.s.phase).toBe('SWAP');
    t.act('P0', { type: 'swapChallenge', requestId: req().id });
    t.act('P0', { type: 'persist', value: 0 });
    t.act('P1', { type: 'persist', value: 0 });
    expect(t.s.phase).toBe('PICK');
  });

  it('on timeout, expires waiting requests but lets a running challenge finish', () => {
    t.now += 57_000;
    t.act('P0', { type: 'swapRequest', targetId: 'P1' });
    t.act('P2', { type: 'swapRequest', targetId: 'P3' });
    const [r1, r2] = t.s.swap!.requests;
    t.act('P1', { type: 'swapRespond', requestId: r1!.id, accept: false });
    t.act('P0', { type: 'swapChallenge', requestId: r1!.id });
    t.advance(3_000 + RULES.graceMs);
    expect(t.s.swap!.requests.find((r) => r.id === r2!.id)!.status).toBe('expired');
    expect(t.s.phase).toBe('SWAP');
    t.act('P0', { type: 'persist', value: 1 });
    t.act('P1', { type: 'persist', value: 0 });
    expect(t.s.phase).toBe('PICK');
    expect(t.s.ranks).toMatchObject({ P0: 2, P1: 1 });
  });

  it('rejects new requests after the swap time ends', () => {
    t.now += 60_000;
    expect(t.act('P0', { type: 'swapRequest', targetId: 'P1' })).toBe(false);
  });

  it('ignores disconnected players for the all-done check', () => {
    t.act('P3', { type: 'leave' });
    for (const id of ['P0', 'P1', 'P2']) t.act(id, { type: 'swapDone', done: true });
    expect(t.s.phase).toBe('PICK');
  });

  it('skips the swap phase when swapSeconds is 0', () => {
    const z = new Table(3, { swapSeconds: 0 });
    z.act('P0', { type: 'start' });
    z.pickAll({ P0: 1, P1: 2, P2: 3 });
    expect(z.s.phase).toBe('PICK');
    expect(z.s.round).toBe(2);
  });
});

describe('locked ranks', () => {
  it('locks ceil(n / 4) ranks at the chosen end', () => {
    expect(lockedRanks(3, 'low')).toEqual([1]);
    expect(lockedRanks(4, 'high')).toEqual([4]);
    expect(lockedRanks(5, 'low')).toEqual([1, 2]);
    expect(lockedRanks(8, 'high')).toEqual([7, 8]);
    expect(lockedRanks(9, 'high')).toEqual([7, 8, 9]);
    expect(lockedRanks(8, 'none')).toEqual([]);
  });

  it('blocks swap requests from and to a locked rank', () => {
    const t = new Table(5, { lockEnd: 'high' });
    t.act('P0', { type: 'start' });
    t.pickAll({ P0: 1, P1: 2, P2: 3, P3: 4, P4: 5 });
    expect(t.act('P0', { type: 'swapRequest', targetId: 'P3' })).toBe(false);
    expect(t.act('P4', { type: 'swapRequest', targetId: 'P0' })).toBe(false);
    expect(t.act('P0', { type: 'swapRequest', targetId: 'P2' })).toBe(true);
    t.act('P2', { type: 'swapRespond', requestId: 1, accept: true });
    expect(t.s.ranks).toEqual({ P0: 3, P1: 1, P2: 2, P3: 4, P4: 5 });
  });

  it('accepts only known lock settings', () => {
    const t = new Table(3, { lockEnd: 'low' });
    t.act('P0', { type: 'settings', settings: { lockEnd: 'middle' as never } });
    expect(t.s.settings.lockEnd).toBe('low');
  });
});

describe('final challenge', () => {
  /** Plays a hand with the final challenge on up to the vote. P2 has the largest rank. */
  const toGuess = () => {
    const t = new Table(3, { finalGuess: true });
    t.act('P0', { type: 'start' });
    for (let r = 1; r <= 4; r++) t.playQuietRound();
    return t;
  };
  const actual = (t: Table) => categoryOf(evaluateBest([...t.s.hole.P2!, ...t.s.fullBoard]));
  const ordered = (t: Table) => {
    const score = (id: string) => evaluateBest([...t.s.hole[id]!, ...t.s.fullBoard]);
    return score('P0') <= score('P1') && score('P1') <= score('P2');
  };

  it('starts after the last round and lets only the other players vote', () => {
    const t = toGuess();
    expect(t.s.phase).toBe('GUESS');
    expect(t.s.guess!.target).toBe('P2');
    expect(t.act('P2', { type: 'guessVote', category: 1 })).toBe(false);
    expect(t.act('P0', { type: 'guessVote', category: 9 })).toBe(false);
    expect(t.act('P0', { type: 'guessVote', category: 1 })).toBe(true);
    expect(t.act('P0', { type: 'guessVote', category: 2 })).toBe(true);
    expect(publicView(t.s).guess!.votes).toEqual({ P0: 2 });
  });

  it('goes to the showdown when all voters voted, and a correct guess keeps the order result', () => {
    const t = toGuess();
    const c = actual(t);
    t.act('P0', { type: 'guessVote', category: c });
    t.act('P1', { type: 'guessVote', category: c });
    expect(t.s.phase).toBe('SHOWDOWN');
    expect(t.s.guess).toBeNull();
    expect(t.s.showdown!.guess).toMatchObject({ answer: c, actual: c, correct: true });
    expect(t.s.showdown!.orderOk).toBe(ordered(t));
    expect(t.s.showdown!.success).toBe(ordered(t));
  });

  it('fails the hand when the guess is wrong', () => {
    const t = toGuess();
    const wrong = (actual(t) + 1) % 9;
    t.act('P0', { type: 'guessVote', category: wrong });
    t.act('P1', { type: 'guessVote', category: wrong });
    expect(t.s.showdown!.guess!.correct).toBe(false);
    expect(t.s.showdown!.success).toBe(false);
    expect(t.s.score.losses).toBe(1);
  });

  it('counts a tie or no vote as a wrong guess when time is up', () => {
    const t = toGuess();
    t.act('P0', { type: 'guessVote', category: actual(t) });
    t.act('P1', { type: 'guessVote', category: (actual(t) + 1) % 9 });
    expect(t.s.showdown!.guess!.answer).toBeNull();

    const u = toGuess();
    expect(nextDeadline(u.s)).toBe(u.s.deadline! + RULES.graceMs);
    u.advance(RULES.guessMs + RULES.graceMs);
    expect(u.s.phase).toBe('SHOWDOWN');
    expect(u.s.showdown!.guess).toMatchObject({ votes: {}, answer: null, correct: false });
  });

  it('skips the vote when the final challenge is off', () => {
    const t = new Table(3);
    t.act('P0', { type: 'start' });
    for (let r = 1; r <= 4; r++) t.playQuietRound();
    expect(t.s.phase).toBe('SHOWDOWN');
    expect(t.s.showdown!.guess).toBeNull();
  });
});

describe('showdown and match', () => {
  it('plays 4 rounds per hand and counts wins and losses without an end', () => {
    const t = new Table(3);
    t.act('P0', { type: 'start' });
    let hands = 0;
    while (hands < 6) {
      for (let r = 1; r <= 4; r++) {
        expect(t.s.round).toBe(r);
        expect(t.s.board).toHaveLength([0, 3, 4, 5][r - 1]!);
        t.playQuietRound();
      }
      expect(t.s.phase).toBe('SHOWDOWN');
      expect(t.s.board).toHaveLength(5);
      expect(t.act('P1', { type: 'next' })).toBe(false);
      t.act('P0', { type: 'next' });
      hands++;
    }
    expect(t.s.phase).toBe('PICK');
    expect(t.s.handNo).toBe(7);
    expect(hands).toBe(t.s.score.wins + t.s.score.losses);
  });

  it('lets only the host send everyone back to the lobby after a hand', () => {
    const t = new Table(3);
    t.act('P0', { type: 'start' });
    expect(t.act('P0', { type: 'lobby' })).toBe(false);
    for (let r = 0; r < 4; r++) t.playQuietRound();
    expect(t.s.phase).toBe('SHOWDOWN');
    const score = { ...t.s.score };
    expect(t.act('P1', { type: 'lobby' })).toBe(false);
    expect(t.act('P0', { type: 'lobby' })).toBe(true);
    expect(t.s.phase).toBe('LOBBY');
    expect(t.s.score).toEqual(score);
    expect(t.ids).toEqual(['P0', 'P1', 'P2']);
    t.act('P0', { type: 'start' });
    expect(t.s.score).toEqual({ wins: 0, losses: 0 });
  });

  const playToLastRound = () => {
    const t = new Table(3, { swapSeconds: 0 });
    t.act('P0', { type: 'start' });
    for (let r = 0; r < 3; r++) t.playQuietRound();
    const score = (id: string) => evaluateBest([...t.s.hole[id]!, ...t.s.fullBoard]);
    const sorted = t.ids.slice().sort((a, b) => score(a) - score(b));
    return { t, sorted };
  };

  it('scores a win when ranks follow hand strength', () => {
    const { t, sorted } = playToLastRound();
    t.pickAll(Object.fromEntries(sorted.map((id, i) => [id, i + 1])));
    expect(t.s.phase).toBe('SHOWDOWN');
    expect(t.s.showdown!.success).toBe(true);
    expect(t.s.score).toEqual({ wins: 1, losses: 0 });
  });

  it('scores a loss when the strongest hand has the lowest rank', () => {
    // Seed 7 gives distinct hand strengths. Reverse the true order.
    const { t, sorted } = playToLastRound();
    const e = (id: string) => evaluateBest([...t.s.hole[id]!, ...t.s.fullBoard]);
    expect(e(sorted[0]!)).toBeLessThan(e(sorted[2]!));
    t.pickAll(Object.fromEntries(sorted.map((id, i) => [id, 3 - i])));
    expect(t.s.showdown!.success).toBe(false);
    expect(t.s.score).toEqual({ wins: 0, losses: 1 });
  });
});

describe('intro pause', () => {
  it('starts each timer after the intro and blocks actions until then', () => {
    const t = new Table(3, { introSeconds: 3 });
    t.act('P0', { type: 'start' });
    expect(t.s.startsAt).toBe(t.now + 3_000 + RULES.boardRevealMs);
    expect(t.s.deadline).toBe(t.now + 3_000 + RULES.boardRevealMs + RULES.pickMs);
    expect(t.act('P1', { type: 'pick', rank: 1 })).toBe(false);
    t.now += 3_000 + RULES.boardRevealMs;
    expect(t.act('P1', { type: 'pick', rank: 1 })).toBe(true);
  });

  it('adds the intro to the conflict and swap phases too', () => {
    const t = new Table(3, { introSeconds: 2 });
    t.act('P0', { type: 'start' });
    t.now += 2_000 + RULES.boardRevealMs;
    t.pickAll({ P0: 1, P1: 1, P2: 3 });
    expect(t.s.phase).toBe('PERSIST');
    expect(t.s.deadline).toBe(t.now + 2_000 + RULES.persistMs);
    expect(t.act('P0', { type: 'persist', value: 1 })).toBe(false);
    t.now += 2_000;
    t.act('P0', { type: 'persist', value: 1 });
    t.act('P1', { type: 'persist', value: 0 });
    expect(t.s.phase).toBe('SWAP');
    expect(t.s.deadline).toBe(t.now + 2_000 + 60_000);
    expect(t.act('P0', { type: 'swapDone', done: true })).toBe(false);
  });

  it('adds the card reveal time to the intro of every round', () => {
    const t = new Table(3, { introSeconds: 2, swapSeconds: 0 });
    t.act('P0', { type: 'start' });
    expect(t.s.startsAt).toBe(t.now + 2_000 + RULES.boardRevealMs);
    t.now += 2_000 + RULES.boardRevealMs;
    t.pickAll({ P0: 1, P1: 2, P2: 3 });
    expect(t.s.round).toBe(2);
    expect(t.s.startsAt).toBe(t.now + 2_000 + RULES.boardRevealMs);
  });

  it('does not let a timeout fire during the intro', () => {
    const t = new Table(3, { introSeconds: 5 });
    t.act('P0', { type: 'start' });
    t.advance(RULES.pickMs + RULES.graceMs);
    expect(t.s.phase).toBe('PICK');
    t.advance(5_000 + RULES.boardRevealMs);
    expect(t.s.phase).toBe('SWAP');
  });
});

describe('rank history', () => {
  it('records the final rank of every round, after swaps, and resets each hand', () => {
    const t = new Table(3);
    t.act('P0', { type: 'start' });
    expect(t.s.history).toEqual({});
    t.pickAll({ P0: 1, P1: 2, P2: 3 });
    t.act('P0', { type: 'swapRequest', targetId: 'P2' });
    t.act('P2', { type: 'swapRespond', requestId: 1, accept: true });
    t.allDone();
    expect(t.s.history).toEqual({ P0: [3], P1: [1], P2: [2] });
    expect(publicView(t.s).history).toEqual(t.s.history);
    for (let r = 2; r <= 4; r++) t.playQuietRound();
    expect(t.s.phase).toBe('SHOWDOWN');
    expect(t.s.history.P0).toEqual([3, 3, 3, 3]);
    t.act('P0', { type: 'next' });
    expect(t.s.history).toEqual({});
  });
});

describe('views', () => {
  it('public view hides hole cards, the hidden board and bid amounts', () => {
    const t = new Table(3);
    t.act('P0', { type: 'start' });
    t.pickAll({ P0: 1, P1: 1, P2: 3 });
    t.act('P0', { type: 'persist', value: 0.7 });
    const json = JSON.stringify(publicView(t.s));
    for (const card of [...Object.values(t.s.hole).flat(), ...t.s.fullBoard]) expect(json).not.toContain(`"${card}"`);
    expect(json).not.toContain('70');
    expect(publicView(t.s).conflict).toEqual({ participants: ['P0', 'P1'], submitted: ['P0'] });
  });

  it('private view shows only the own hole cards', () => {
    const t = new Table(3);
    t.act('P0', { type: 'start' });
    expect(privateView(t.s, 'P1').hole).toEqual(t.s.hole.P1);
    expect(privateView(t.s, 'nobody').hole).toBeNull();
  });

  it('nextDeadline includes the grace period and request deadlines', () => {
    const t = new Table(3);
    expect(nextDeadline(t.s)).toBeNull();
    t.act('P0', { type: 'start' });
    expect(nextDeadline(t.s)).toBe(t.now + RULES.pickMs + RULES.graceMs);
    t.pickAll({ P0: 1, P1: 2, P2: 3 });
    t.act('P0', { type: 'swapRequest', targetId: 'P1' });
    expect(nextDeadline(t.s)).toBe(t.now + RULES.respondMs + RULES.graceMs);
  });
});
