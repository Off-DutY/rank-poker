import { type Card, rankValue, suitOf } from './cards';

/** Hand category names, indexed by category (0 = high card .. 8 = straight flush). */
export const CATEGORY_NAMES = ['高牌', '一對', '兩對', '三條', '順子', '同花', '葫蘆', '四條', '同花順'] as const;

const BASE = 16;
const CATEGORY_WEIGHT = BASE ** 5;

/** Returns the hand category (0..8) of an encoded hand score. */
export function categoryOf(score: number): number {
  return Math.floor(score / CATEGORY_WEIGHT);
}

function encode(category: number, kickers: number[]): number {
  let score = category * CATEGORY_WEIGHT;
  for (let i = 0; i < 5; i++) score += (kickers[i] ?? 0) * BASE ** (4 - i);
  return score;
}

/** Returns the straight high card (5..14) of 5 distinct sorted-desc values, or 0 if not a straight. */
function straightHigh(desc: number[]): number {
  if (desc.length !== 5) return 0;
  if (desc[0]! - desc[4]! === 4) return desc[0]!;
  // A-2-3-4-5: the ace plays low, so the high card is 5.
  if (desc[0] === 14 && desc[1] === 5 && desc[4] === 2) return 5;
  return 0;
}

/** Scores exactly 5 cards. A higher score is a stronger hand. Equal scores are a tie. */
export function evaluate5(cards: readonly Card[]): number {
  const values = cards.map(rankValue);
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Groups sorted by count desc, then value desc. Example: full house -> [[K,3],[4,2]].
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const ordered = groups.map(([v]) => v);
  const flush = cards.every((c) => suitOf(c) === suitOf(cards[0]!));
  const high = straightHigh(ordered);
  const shape = groups.map(([, n]) => n).join('');

  if (high && flush) return encode(8, [high]);
  if (shape === '41') return encode(7, ordered);
  if (shape === '32') return encode(6, ordered);
  if (flush) return encode(5, ordered);
  if (high) return encode(4, [high]);
  if (shape === '311') return encode(3, ordered);
  if (shape === '221') return encode(2, ordered);
  if (shape === '2111') return encode(1, ordered);
  return encode(0, ordered);
}

/** Scores the best 5-card hand from 5 to 7 cards. */
export function evaluateBest(cards: readonly Card[]): number {
  if (cards.length < 5) throw new Error(`need at least 5 cards, got ${cards.length}`);
  let best = -1;
  const n = cards.length;
  const pick: Card[] = [];
  const walk = (start: number) => {
    if (pick.length === 5) {
      best = Math.max(best, evaluate5(pick));
      return;
    }
    for (let i = start; i <= n - (5 - pick.length); i++) {
      pick.push(cards[i]!);
      walk(i + 1);
      pick.pop();
    }
  };
  walk(0);
  return best;
}
