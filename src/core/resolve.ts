import type { Rng } from './cards';

/** Player identifier. */
export type PlayerId = string;

/** A persistence bid. A higher amount wins; on equal amounts the earlier submission wins. */
export interface Bid {
  /** Persistence amount. Budget units in budget mode, 0..1 in free mode. */
  amount: number;
  /** Submission time in milliseconds (host clock). */
  at: number;
}

/**
 * Compares 2 bids for sorting, strongest first.
 * Order: amount desc, then submission time asc, then seat order asc.
 */
export function compareBids(a: Bid, b: Bid, seatA: number, seatB: number): number {
  return b.amount - a.amount || a.at - b.at || seatA - seatB;
}

/** Returns the players whose rank is also chosen by at least 1 other player, in seat order. */
export function findConflicts(order: readonly PlayerId[], picks: Readonly<Record<PlayerId, number | null>>): PlayerId[] {
  const count = new Map<number, number>();
  for (const id of order) {
    const r = picks[id];
    if (r != null) count.set(r, (count.get(r) ?? 0) + 1);
  }
  return order.filter((id) => {
    const r = picks[id];
    return r != null && count.get(r)! > 1;
  });
}

/**
 * Converts picks to a full permutation of ranks 1..n (spec 6.2).
 * 1. A rank with 1 player goes to that player.
 * 2. A conflicted rank goes to its strongest bid.
 * 3. Losers, strongest bid first, take the nearest free rank; on equal distance, the smaller rank.
 * 4. Players without a pick take random free ranks.
 * @param order Seat order. Also the final tie-break for bids.
 * @param picks Locked rank per player, or null when the player did not pick.
 * @param bids Bids of the conflicted players. A missing bid counts as amount 0 at time +Infinity.
 */
export function assignRanks(
  order: readonly PlayerId[],
  picks: Readonly<Record<PlayerId, number | null>>,
  bids: Readonly<Record<PlayerId, Bid>>,
  rng: Rng,
): Record<PlayerId, number> {
  const n = order.length;
  const seat = new Map(order.map((id, i) => [id, i]));
  const bidOf = (id: PlayerId): Bid => bids[id] ?? { amount: 0, at: Number.POSITIVE_INFINITY };
  const byStrength = (a: PlayerId, b: PlayerId) => compareBids(bidOf(a), bidOf(b), seat.get(a)!, seat.get(b)!);

  const result: Record<PlayerId, number> = {};
  const taken = new Set<number>();
  const byRank = new Map<number, PlayerId[]>();
  const unpicked: PlayerId[] = [];

  for (const id of order) {
    const r = picks[id];
    if (r == null || r < 1 || r > n || !Number.isInteger(r)) unpicked.push(id);
    else byRank.set(r, [...(byRank.get(r) ?? []), id]);
  }

  const losers: PlayerId[] = [];
  for (const [r, ids] of byRank) {
    const [winner, ...rest] = ids.sort(byStrength);
    result[winner!] = r;
    taken.add(r);
    losers.push(...rest);
  }

  losers.sort(byStrength);
  for (const id of losers) {
    const want = picks[id]!;
    for (let d = 1; d < n; d++) {
      const lower = want - d;
      const upper = want + d;
      const r = lower >= 1 && !taken.has(lower) ? lower : upper <= n && !taken.has(upper) ? upper : 0;
      if (r) {
        result[id] = r;
        taken.add(r);
        break;
      }
    }
  }

  const free: number[] = [];
  for (let r = 1; r <= n; r++) if (!taken.has(r)) free.push(r);
  for (const id of unpicked) {
    const i = rng.int(free.length);
    result[id] = free.splice(i, 1)[0]!;
  }
  return result;
}

/**
 * Returns true when the ranks match hand strength order (spec 3.5).
 * For any 2 players: a lower rank must not have a strictly stronger hand. Equal hands may be in any order.
 */
export function isCorrectOrder(
  ranks: Readonly<Record<PlayerId, number>>,
  strengths: Readonly<Record<PlayerId, number>>,
): boolean {
  const ids = Object.keys(ranks).sort((a, b) => ranks[a]! - ranks[b]!);
  for (let i = 1; i < ids.length; i++) {
    if (strengths[ids[i - 1]!]! > strengths[ids[i]!]!) return false;
  }
  return true;
}
