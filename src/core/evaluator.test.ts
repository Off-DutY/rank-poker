import { describe, expect, it } from 'vitest';
import { categoryOf, evaluate5, evaluateBest } from './evaluator';

const h = (s: string) => s.split(' ');
const cat = (s: string) => categoryOf(evaluate5(h(s)));

describe('evaluate5 categories', () => {
  it.each([
    ['2s 5h 9d Jc Kh', 0],
    ['2s 2h 9d Jc Kh', 1],
    ['2s 2h 9d 9c Kh', 2],
    ['2s 2h 2d Jc Kh', 3],
    ['5s 6h 7d 8c 9h', 4],
    ['As 2h 3d 4c 5h', 4],
    ['Ts Jh Qd Kc Ah', 4],
    ['2h 5h 9h Jh Kh', 5],
    ['2s 2h 2d Kc Kh', 6],
    ['2s 2h 2d 2c Kh', 7],
    ['5h 6h 7h 8h 9h', 8],
    ['Ah 2h 3h 4h 5h', 8],
  ])('%s -> category %i', (hand, expected) => {
    expect(cat(hand)).toBe(expected);
  });

  it('does not treat a wrap-around as a straight', () => {
    expect(cat('Qs Kh Ad 2c 3h')).toBe(0);
  });
});

describe('evaluate5 ordering', () => {
  const cmp = (a: string, b: string) => Math.sign(evaluate5(h(a)) - evaluate5(h(b)));

  it('wheel is the lowest straight', () => {
    expect(cmp('As 2h 3d 4c 5h', '2s 3h 4d 5c 6h')).toBe(-1);
  });
  it('wheel straight flush is lower than 6-high straight flush', () => {
    expect(cmp('Ah 2h 3h 4h 5h', '2s 3s 4s 5s 6s')).toBe(-1);
  });
  it('compares kickers on a pair', () => {
    expect(cmp('9s 9h Ad 5c 3h', '9d 9c Kd Qc Jh')).toBe(1);
  });
  it('compares the second pair on two pair', () => {
    expect(cmp('Ks Kh 4d 4c 2h', 'Kd Kc 3d 3s Ah')).toBe(1);
  });
  it('compares the trip value first on a full house', () => {
    expect(cmp('3s 3h 3d 2c 2h', '2s 2d 2c As Ah')).toBe(1);
  });
  it('ignores suits: same values are a tie', () => {
    expect(cmp('As Kh 9d 5c 3h', 'Ad Kc 9s 5h 3c')).toBe(0);
  });
  it('flush compares all 5 cards', () => {
    expect(cmp('Ah Jh 9h 5h 3h', 'Ad Jd 9d 5d 2d')).toBe(1);
  });
});

describe('evaluateBest', () => {
  it('finds the best 5 of 7', () => {
    // Board makes a straight 5-9; the hole cards add a flush.
    const score = evaluateBest(h('Ah Kh 5h 6h 7c 8d 2h'));
    expect(categoryOf(score)).toBe(5);
  });
  it('plays the board when hole cards do not help', () => {
    const a = evaluateBest(h('2c 3d Ts Js Qs Ks As'));
    const b = evaluateBest(h('4c 7d Ts Js Qs Ks As'));
    expect(a).toBe(b);
    expect(categoryOf(a)).toBe(8);
  });
  it('rejects fewer than 5 cards', () => {
    expect(() => evaluateBest(h('As Kd'))).toThrow();
  });
});
