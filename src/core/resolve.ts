import type { Rng } from './cards';

/** Player identifier. */
export type PlayerId = string;

/** A persistence bid. A higher amount wins; on equal amounts the earlier submission wins. */
export interface Bid {
  /** Persistence amount, 0..1. */
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
 * Converts picks to a full permutation of ranks 1..n (spec 6.2). There is no fill to the nearest free rank.
 * 1. A player without a valid pick gets a random pick 1..n and no bid.
 * 2. Sort all players by pick, smallest first.
 * 3. Inside 1 pick, the weaker bid comes first, so the strongest bid gets the largest rank of the group.
 * 4. The position in the sorted list is the rank.
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
  const want = new Map<PlayerId, number>();
  for (const id of order) {
    const r = picks[id];
    want.set(id, r != null && Number.isInteger(r) && r >= 1 && r <= n ? r : 1 + rng.int(n));
  }
  const sorted = order
    .slice()
    .sort((a, b) => want.get(a)! - want.get(b)! || compareBids(bidOf(b), bidOf(a), seat.get(b)!, seat.get(a)!));
  return Object.fromEntries(sorted.map((id, i) => [id, i + 1]));
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
