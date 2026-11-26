import { describe, expect, it } from 'vitest';
import { seededRng } from '../core/cards';
import { type Action, type GameState, type PlayerAction, type Settings, createGame, publicView, reduce } from '../core/engine';
import { diffEvents } from './events';

/** Plays actions on the engine and collects the announcements that P1 would see. */
class Run {
  s: GameState;
  now = 1_000;
  rng = seededRng(5);
  log: string[] = [];

  constructor(settings: Partial<Settings> = {}) {
    this.s = createGame('P0', 'A');
    this.do('P1', { type: 'join', name: 'B' });
    this.do('P2', { type: 'join', name: 'C' });
    this.do('P0', { type: 'settings', settings: { introSeconds: 0, ...settings } });
  }

  do(id: string, a: PlayerAction): void {
    this.step({ ...a, id } as Action);
  }

  tick(ms: number): void {
    this.now += ms;
    this.step({ type: 'tick' });
  }

  private step(a: Action): void {
    const before = publicView(this.s);
    this.s = reduce(this.s, a, this.now, this.rng);
    for (const e of diffEvents(before, publicView(this.s), 'P1')) this.log.push([e.title, ...e.lines].join(' / '));
  }

  pickAll(r: Record<string, number>): void {
    for (const [id, rank] of Object.entries(r)) {
      this.do(id, { type: 'pick', rank });
      this.do(id, { type: 'lock' });
    }
  }
}

describe('diffEvents', () => {
  it('returns nothing without a previous state', () => {
    expect(diffEvents(null, publicView(createGame('P0', 'A')), 'P0')).toEqual([]);
  });

  it('announces joins, the hand start and quiet resolution', () => {
    const r = new Run();
    r.do('P0', { type: 'start' });
    r.pickAll({ P0: 1, P1: 2, P2: 3 });
    expect(r.log).toEqual([
      '你 加入房間',
      'C 加入房間',
      '第 1 局開始 / 每人發 2 張手牌 / 翻牌前：選擇順位',
      '順位確定 / 每個人都拿到自己選的順位 / 接下來：交換階段 60 秒',
    ]);
  });

  it('announces a conflict and how it was resolved', () => {
    const r = new Run();
    r.do('P0', { type: 'start' });
    r.log = [];
    r.pickAll({ P0: 2, P1: 2, P2: 3 });
    r.do('P0', { type: 'persist', value: 1 });
    r.do('P1', { type: 'persist', value: 0.1 });
    expect(r.log).toEqual([
      '順位衝突！ / 順位 2：A、你 爭奪 / 相關玩家下注籌碼…',
      '衝突結果 / 你：選 2 → 移到 1 / 接下來：交換階段 60 秒',
    ]);
  });

  it('announces swap requests, challenges and the next round', () => {
    const r = new Run();
    r.do('P0', { type: 'start' });
    r.pickAll({ P0: 1, P1: 2, P2: 3 });
    r.log = [];
    r.do('P1', { type: 'swapRequest', targetId: 'P2' });
    r.do('P2', { type: 'swapRespond', requestId: 1, accept: false });
    r.do('P1', { type: 'swapChallenge', requestId: 1 });
    r.do('P1', { type: 'persist', value: 1 });
    r.do('P2', { type: 'persist', value: 0 });
    r.do('P0', { type: 'swapRequest', targetId: 'P1' });
    r.do('P1', { type: 'swapRespond', requestId: 2, accept: true });
    for (const id of ['P0', 'P1', 'P2']) r.do(id, { type: 'swapDone', done: true });
    expect(r.log).toEqual([
      '你 向 C 提出交換 / 2 → 3',
      'C 拒絕交換',
      '你 向 C 發起挑戰！ / 爭奪順位 3',
      '你 挑戰成功 / 你 搶下順位 3 / C 移到 2',
      'A 向 你 提出交換 / 1 → 3',
      '你 同意交換 / A 移到 3 / C 移到 1 / 你 移到 2',
      '交換階段結束',
      '翻牌：發出 3 張公牌 / 重新選擇順位',
    ]);
  });

  it('announces the hand start and the dealt cards when a round is skipped', () => {
    const r1 = new Run({ skipRound: 1, holeCards: 3, swapSeconds: 0 });
    r1.do('P0', { type: 'start' });
    expect(r1.log.at(-1)).toBe('第 1 局開始 / 每人發 3 張手牌 / 跳過翻牌前：同時發出 3 張公牌 / 翻牌：選擇順位');
    const r2 = new Run({ skipRound: 2, swapSeconds: 0 });
    r2.do('P0', { type: 'start' });
    r2.pickAll({ P0: 1, P1: 2, P2: 3 });
    expect(r2.log.at(-1)).toBe('轉牌：一次發出 4 張公牌 / 跳過翻牌 / 重新選擇順位');
  });

  it('reports a random rank for a player who did not pick, and the showdown', () => {
    const r = new Run({ swapSeconds: 0 });
    r.do('P0', { type: 'start' });
    r.log = [];
    r.do('P0', { type: 'pick', rank: 1 });
    r.do('P2', { type: 'pick', rank: 3 });
    r.tick(30_000);
    expect(r.log[0]).toBe('順位確定 / 你：沒有選擇，隨機給 2');
    expect(r.log[1]).toBe('翻牌：發出 3 張公牌 / 重新選擇順位');
    for (let i = 0; i < 3; i++) r.pickAll({ P0: 1, P1: 2, P2: 3 });
    expect(r.log.at(-1)).toBe('攤牌！ / 公開所有手牌，從順位 1 開始比對');
  });

  it('announces the final challenge before the showdown', () => {
    const r = new Run({ swapSeconds: 0, finalGuess: true });
    r.do('P0', { type: 'start' });
    for (let i = 0; i < 4; i++) r.pickAll({ P0: 1, P1: 2, P2: 3 });
    expect(r.log.at(-1)).toBe('最終挑戰！ / 猜 C（順位 3）的牌型 / 投票多數決，猜錯算失敗');
    r.do('P0', { type: 'guessVote', category: 1 });
    r.do('P1', { type: 'guessVote', category: 1 });
    expect(r.log.at(-1)).toBe('攤牌！ / 公開所有手牌，從順位 1 開始比對');
  });
});
