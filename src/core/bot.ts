import { type Card, type Rng, newDeck } from './cards';
import { type PlayerAction, type PlayerId, type PublicState, lockedRanks } from './engine';
import { evaluateBest } from './evaluator';

/**
 * Work budget per strength estimate: random deals x players. More deals give a steadier estimate but cost more time.
 * 1 800 gives 300 deals at 6 players and about 140 deals at 13 players (about 60 ms with 3 hole cards).
 */
const WORK = 1_800;

/**
 * Estimates the expected rank (1 = weakest, n = strongest) of a hand among n players.
 * Uses only the own hole cards and the visible board: the other hands and the hidden board are random.
 */
export function estimateRank(hole: readonly Card[], board: readonly Card[], n: number, holeCards: number, rng: Rng, samples = Math.round(WORK / Math.max(6, n))): number {
  const known = new Set([...hole, ...board]);
  const deck = newDeck().filter((c) => !known.has(c));
  const need = (n - 1) * holeCards + (5 - board.length);
  let total = 0;
  for (let k = 0; k < samples; k++) {
    // Partial Fisher-Yates: the last `need` cards of the deck become a random draw.
    for (let i = deck.length - 1; i >= deck.length - need; i--) {
      const j = rng.int(i + 1);
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    const drawn = deck.slice(deck.length - need);
    const fullBoard = [...board, ...drawn.slice(0, 5 - board.length)];
    const mine = evaluateBest([...hole, ...fullBoard]);
    let rank = 1;
    for (let p = 0; p < n - 1; p++) {
      const start = 5 - board.length + p * holeCards;
      const other = evaluateBest([...drawn.slice(start, start + holeCards), ...fullBoard]);
      // A tie counts as half a place, so equal hands meet in the middle.
      rank += other < mine ? 1 : other === mine ? 0.5 : 0;
    }
    total += rank;
  }
  return total / samples;
}

/** How much a bot wants to keep or take a rank: 1 when the rank equals its estimate, 0 when it is 2 or more away. */
function closeness(rank: number, estimate: number): number {
  return Math.max(0, 1 - Math.abs(rank - estimate) / 2);
}

/**
 * How much a bot wants to sort high in a conflict group (spec 6.2): a stronger bid gets a larger rank.
 * 0.5 when the estimate equals the contested rank, 1 when it is 1 or more above, 0 when it is 1 or more below.
 */
function upward(rank: number, estimate: number): number {
  return Math.min(1, Math.max(0, (estimate - rank + 1) / 2));
}

/**
 * Returns the next action of a computer player, or null when it has nothing to do now.
 * The decision uses only what a human player in the same seat can see, plus the strength estimate.
 */
export function botAction(pub: PublicState, me: PlayerId, estimate: number): PlayerAction | null {
  const n = pub.seats.length;
  if (pub.phase === 'PICK') {
    const mine = pub.picks[me];
    if (!mine || mine.locked) return null;
    // The free rank nearest to the estimate. Ranks locked by other players are not free.
    const taken = new Set(Object.entries(pub.picks).filter(([id, p]) => id !== me && p.locked).map(([, p]) => p.rank));
    const free = Array.from({ length: n }, (_, i) => i + 1).filter((r) => !taken.has(r));
    const target = (free.length ? free : [Math.round(estimate)]).reduce((a, b) => (Math.abs(b - estimate) < Math.abs(a - estimate) ? b : a));
    return mine.rank === target ? { type: 'lock' } : { type: 'pick', rank: target };
  }
  if (pub.phase === 'PERSIST') {
    const c = pub.conflict;
    if (!c || !c.participants.includes(me) || c.submitted.includes(me)) return null;
    return { type: 'persist', value: (upward(pub.picks[me]?.rank ?? 0, estimate)) };
  }
  if (pub.phase === 'SWAP' && pub.swap) {
    const myRank = pub.ranks[me]!;
    const reqs = pub.swap.requests;
    const challenge = reqs.find((r) => r.status === 'challenge' && (r.from === me || r.to === me) && !r.submitted.includes(me));
    if (challenge) return { type: 'persist', value: (closeness(challenge.to === me ? myRank : pub.ranks[challenge.to]!, estimate)) };
    const asked = reqs.find((r) => r.status === 'pending' && r.to === me);
    if (asked) {
      // Accepting shifts this bot 1 rank toward the requester's old rank. Accept when that is nearer to the estimate.
      const next = myRank + Math.sign(pub.ranks[asked.from]! - myRank);
      const accept = Math.abs(next - estimate) < Math.abs(myRank - estimate);
      return { type: 'swapRespond', requestId: asked.id, accept };
    }
    const busy = (id: PlayerId) => reqs.some((r) => (r.status === 'pending' || r.status === 'deciding' || r.status === 'challenge') && (r.from === id || r.to === id));
    const locked = lockedRanks(n, pub.settings.lockEnd);
    if (busy(me)) return null;
    // A locked rank cannot move: nothing to do in this swap phase.
    if (locked.includes(myRank)) return pub.swap.done[me] ? null : { type: 'swapDone', done: true };
    // Ask once per round for the rank nearest to the estimate, when it is at least 1 away.
    const want = Math.min(n, Math.max(1, Math.round(estimate)));
    const holder = Object.keys(pub.ranks).find((id) => pub.ranks[id] === want);
    const askedBefore = reqs.some((r) => (r.from === me && r.to === holder) || (r.from === holder && r.to === me));
    if (holder && holder !== me && !locked.includes(want) && Math.abs(myRank - estimate) >= 1 && !askedBefore && !busy(holder)) {
      return { type: 'swapRequest', targetId: holder };
    }
    return pub.swap.done[me] ? null : { type: 'swapDone', done: true };
  }
  if (pub.phase === 'GUESS' && pub.guess) {
    const g = pub.guess;
    if (me === g.target || g.votes[me] != null) return null;
    // Bots follow the humans: wait until every human voter has voted, then vote for their top category.
    const humans = pub.seats.filter((x) => !x.bot && x.connected && x.id !== g.target);
    if (humans.some((x) => g.votes[x.id] == null)) return null;
    const count = new Map<number, number>();
    for (const x of humans) count.set(g.votes[x.id]!, (count.get(g.votes[x.id]!) ?? 0) + 1);
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    // With no human voter, guess 2 pair (category 2), a common category for the strongest of several hands.
    return { type: 'guessVote', category: top ? top[0] : 2 };
  }
  return null;
}
