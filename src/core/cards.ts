/** Card ranks from low to high. Index + 2 is the numeric rank (2..14). */
export const RANKS = '23456789TJQKA';

/** Card suits: spades, hearts, diamonds, clubs. */
export const SUITS = 'shdc';

/** A card as a 2-character string: rank character + suit character, for example "As" or "Td". */
export type Card = string;

/** Source of uniform random integers. */
export interface Rng {
  /** Returns a uniform random integer in [0, n). */
  int(n: number): number;
}

/** Returns a new ordered 52-card deck. */
export function newDeck(): Card[] {
  const deck: Card[] = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

/** Returns the numeric rank (2..14) of a card. */
export function rankValue(card: Card): number {
  return RANKS.indexOf(card[0]!) + 2;
}

/** Returns the suit character of a card. */
export function suitOf(card: Card): string {
  return card[1]!;
}

/** Returns a shuffled copy of the array (Fisher-Yates). */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Cryptographically secure RNG. Uses rejection sampling to remove modulo bias. */
export const cryptoRng: Rng = {
  int(n: number): number {
    const limit = Math.floor(0x1_0000_0000 / n) * n;
    const buf = new Uint32Array(1);
    for (;;) {
      crypto.getRandomValues(buf);
      if (buf[0]! < limit) return buf[0]! % n;
    }
  },
};

/** Deterministic RNG (mulberry32) for tests. Do not use for real games. */
export function seededRng(seed: number): Rng {
  let t = seed >>> 0;
  const next = () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  return { int: (n) => Math.floor(next() * n) };
}
