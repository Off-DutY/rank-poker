import { beforeEach, describe, expect, it } from 'vitest';
import { seededRng } from './cards';
import { evaluateBest } from './evaluator';
import {
  type Action,
  type GameState,
  type PlayerAction,
  RULES,
  type Settings,
  cleanName,
  createGame,
  joinRejection,
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
    t.act('P0', { type: 'settings', settings: { swapSeconds: 999, persistenceMode: 'free' } });
    expect(t.s.settings).toMatchObject({ swapSeconds: 180, persistenceMode: 'free' });
    t.act('P0', { type: 'settings', settings: { introSeconds: 99, notifyStyle: 'nope' as never, sound: true } });
    expect(t.s.settings).toMatchObject({ introSeconds: 5, notifyStyle: 'banner', sound: true });
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
    expect(t.s.picks.P0).toEqual({ rank: 3, locked: true });
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

  it('on timeout, locks current picks and gives free ranks to the rest', () => {
    t.act('P0', { type: 'pick', rank: 4 });
    t.act('P1', { type: 'pick', rank: 1 });
    t.advance(RULES.pickMs);
    expect(t.s.phase).toBe('PICK');
    t.advance(RULES.graceMs);
    expect(t.s.phase).toBe('SWAP');
    expect(t.s.ranks.P0).toBe(4);
    expect(t.s.ranks.P1).toBe(1);
    expect([t.s.ranks.P2, t.s.ranks.P3].sort()).toEqual([2, 3]);
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
    expect(t.s.picks.P0).toEqual({ rank: 4, locked: false });
  });
});

describe('conflict (budget mode)', () => {
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

  it('resolves by bid strength and charges every bidder', () => {
    t.act('P0', { type: 'persist', value: 0.1 });
    t.act('P1', { type: 'persist', value: 0.5 });
    expect(t.act('P1', { type: 'persist', value: 1 })).toBe(false);
    t.act('P2', { type: 'persist', value: 0.3 });
    expect(t.s.phase).toBe('SWAP');
    // P1 wins rank 2. P2 (30) takes the nearest free rank: 1 and 3 tie, so 1. P0 takes 3.
    expect(t.s.ranks).toEqual({ P1: 2, P2: 1, P0: 3, P3: 4 });
    expect(t.s.budgets).toMatchObject({ P0: 90, P1: 50, P2: 70, P3: 100 });
  });

  it('treats a missing bid as 0 at the deadline', () => {
    t.act('P2', { type: 'persist', value: 0 });
    t.advance(RULES.persistMs + RULES.graceMs);
    expect(t.s.phase).toBe('SWAP');
    // P2 bid 0 before the deadline, so P2 beats the 0-bids at the deadline.
    expect(t.s.ranks.P2).toBe(2);
  });

  it('clamps bad slider values', () => {
    t.act('P0', { type: 'persist', value: 5 });
    t.act('P1', { type: 'persist', value: Number.NaN });
    expect(t.s.budgets.P0).toBe(0);
    expect(t.s.budgets.P1).toBe(100);
  });

  it('spends from the remaining budget, so later bids get smaller', () => {
    t.act('P0', { type: 'persist', value: 0.5 });
    expect(t.s.budgets.P0).toBe(50);
    expect(privateView(t.s, 'P0').budget).toBe(0.5);
  });
});

describe('conflict (free mode)', () => {
  it('does not charge anything', () => {
    const t = new Table(3, { persistenceMode: 'free' });
    t.act('P0', { type: 'start' });
    t.pickAll({ P0: 1, P1: 1, P2: 3 });
    t.act('P0', { type: 'persist', value: 1 });
    t.act('P1', { type: 'persist', value: 0.2 });
    expect(t.s.ranks).toEqual({ P0: 1, P1: 2, P2: 3 });
    expect(privateView(t.s, 'P0').budget).toBeNull();
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

  it('swaps ranks when the target accepts', () => {
    t.act('P0', { type: 'swapRequest', targetId: 'P3' });
    expect(t.act('P0', { type: 'swapRespond', requestId: req().id, accept: true })).toBe(false);
    t.act('P3', { type: 'swapRespond', requestId: req().id, accept: true });
    expect(req().status).toBe('accepted');
    expect(t.s.ranks).toMatchObject({ P0: 4, P3: 1 });
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
    expect(t.s.ranks).toMatchObject({ P0: 4, P3: 1 });
    expect(t.s.budgets).toMatchObject({ P0: 40, P3: 60 });
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

  it('has no challenge in free mode', () => {
    const f = new Table(3, { persistenceMode: 'free' });
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

describe('showdown and match', () => {
  it('plays 4 rounds, scores the hand and ends the match at 3 wins or losses', () => {
    const t = new Table(3);
    t.act('P0', { type: 'start' });
    let hands = 0;
    while (t.s.phase !== 'MATCH_END' && hands < 10) {
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
    expect(t.s.phase).toBe('MATCH_END');
    expect(Math.max(t.s.score.wins, t.s.score.losses)).toBe(3);
    expect(hands).toBe(t.s.score.wins + t.s.score.losses);
    t.act('P0', { type: 'next' });
    expect(t.s.phase).toBe('LOBBY');
    expect(t.ids).toEqual(['P0', 'P1', 'P2']);
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
    expect(t.s.startsAt).toBe(t.now + 3_000);
    expect(t.s.deadline).toBe(t.now + 3_000 + RULES.pickMs);
    expect(t.act('P1', { type: 'pick', rank: 1 })).toBe(false);
    t.now += 3_000;
    expect(t.act('P1', { type: 'pick', rank: 1 })).toBe(true);
  });

  it('adds the intro to the conflict and swap phases too', () => {
    const t = new Table(3, { introSeconds: 2 });
    t.act('P0', { type: 'start' });
    t.now += 2_000;
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

  it('adds the board reveal time to the intro of rounds 2-4 only', () => {
    const t = new Table(3, { introSeconds: 2, swapSeconds: 0 });
    t.act('P0', { type: 'start' });
    expect(t.s.startsAt).toBe(t.now + 2_000);
    t.now += 2_000;
    t.pickAll({ P0: 1, P1: 2, P2: 3 });
    expect(t.s.round).toBe(2);
    expect(t.s.startsAt).toBe(t.now + 2_000 + RULES.boardRevealMs);
  });

  it('does not let a timeout fire during the intro', () => {
    const t = new Table(3, { introSeconds: 5 });
    t.act('P0', { type: 'start' });
    t.advance(RULES.pickMs + RULES.graceMs);
    expect(t.s.phase).toBe('PICK');
    t.advance(5_000);
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
    expect(t.s.history).toEqual({ P0: [3], P1: [2], P2: [1] });
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
