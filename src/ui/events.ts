import { type PlayerId, type PublicState, boardSize } from '../core/engine';
import { ROUND_NAMES as ROUND_LABEL } from './render';

/** Kind of announcement. Sets the color of the banner. */
export type AnnouncementKind = 'info' | 'conflict' | 'swap' | 'result';

/** A short message that tells players what just happened. */
export interface Announcement {
  kind: AnnouncementKind;
  title: string;
  lines: string[];
}

const ROUND_TEXT: Record<number, string> = {
  2: '翻牌：發出 3 張公牌',
  3: '轉牌：發出第 4 張公牌',
  4: '河牌：發出第 5 張公牌',
};

/**
 * Compares 2 public states and returns what happened between them, in display order.
 * The text never contains hidden data: it uses only public state.
 */
export function diffEvents(prev: PublicState | null, next: PublicState, me: PlayerId): Announcement[] {
  if (!prev) return [];
  const out: Announcement[] = [];
  const name = (id: PlayerId) => (id === me ? '你' : (next.seats.find((s) => s.id === id)?.name ?? '?'));
  const sameHand = prev.handNo === next.handNo;

  if (prev.phase === 'LOBBY' && next.phase === 'LOBBY') {
    for (const s of next.seats) {
      if (!prev.seats.some((p) => p.id === s.id)) out.push({ kind: 'info', title: `${name(s.id)} 加入房間`, lines: [] });
    }
    return out;
  }

  // Pick phase ended with a conflict.
  if (prev.phase === 'PICK' && next.phase === 'PERSIST' && next.conflict) {
    const byRank = new Map<number, PlayerId[]>();
    for (const id of next.conflict.participants) {
      const r = next.picks[id]!.rank!;
      byRank.set(r, [...(byRank.get(r) ?? []), id]);
    }
    const lines = [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([r, ids]) => `順位 ${r}：${ids.map(name).join('、')} 爭奪`);
    out.push({ kind: 'conflict', title: '順位衝突！', lines: [...lines, '相關玩家表達執著度…'] });
  }

  // Picks were resolved into ranks.
  const resolved = (prev.phase === 'PICK' || prev.phase === 'PERSIST') && sameHand && (next.phase !== prev.phase || next.round !== prev.round) && next.phase !== 'PERSIST';
  if (resolved) {
    const moved: string[] = [];
    const ids = next.seats.map((s) => s.id).sort((a, b) => (next.ranks[a] ?? 0) - (next.ranks[b] ?? 0));
    for (const id of ids) {
      const pick = prev.picks[id]?.rank ?? null;
      const rank = next.ranks[id];
      if (rank == null) continue;
      if (pick == null) moved.push(`${name(id)}：沒有選擇，隨機給 ${rank}`);
      else if (pick !== rank) moved.push(`${name(id)}：選 ${pick} → 移到 ${rank}`);
    }
    const hadConflict = prev.phase === 'PERSIST';
    const lines = moved.length ? moved : ['每個人都拿到自己選的順位'];
    if (next.phase === 'SWAP') lines.push(`接下來：交換階段 ${next.settings.swapSeconds} 秒`);
    out.push({ kind: hadConflict ? 'conflict' : 'info', title: hadConflict ? '衝突結果' : '順位確定', lines });
  }

  // Swap requests changed during the swap phase.
  if (prev.swap && next.swap && sameHand && prev.round === next.round) {
    for (const r of next.swap.requests) {
      const before = prev.swap.requests.find((x) => x.id === r.id);
      if (before?.status === r.status) continue;
      const a = name(r.from);
      const b = name(r.to);
      if (!before) out.push({ kind: 'swap', title: `${a} 向 ${b} 提出交換`, lines: [`${prev.ranks[r.from]} ⇄ ${prev.ranks[r.to]}`] });
      else if (r.status === 'accepted') out.push({ kind: 'swap', title: `${a} ⇄ ${b} 交換順位`, lines: [`${a} → ${next.ranks[r.from]}`, `${b} → ${next.ranks[r.to]}`] });
      else if (r.status === 'deciding' || r.status === 'declined') out.push({ kind: 'swap', title: `${b} 拒絕交換`, lines: [] });
      else if (r.status === 'challenge') out.push({ kind: 'conflict', title: `${a} 向 ${b} 發起挑戰！`, lines: [`爭奪順位 ${next.ranks[r.to]}`] });
      else if (r.status === 'won') out.push({ kind: 'conflict', title: `${a} 挑戰成功`, lines: [`${a} 搶下順位 ${next.ranks[r.from]}`, `${b} 移到 ${next.ranks[r.to]}`] });
      else if (r.status === 'lost') out.push({ kind: 'conflict', title: `${b} 守住順位 ${next.ranks[r.to]}`, lines: [`${a} 挑戰失敗`] });
    }
  }

  // Swap phase ended. A challenge can finish in the same step, so report rank changes here too.
  if (prev.phase === 'SWAP' && next.phase !== 'SWAP' && sameHand) {
    const final = Object.fromEntries(next.seats.map((s) => [s.id, next.history[s.id]?.at(-1)]));
    const changed = next.seats
      .filter((s) => final[s.id] != null && final[s.id] !== prev.ranks[s.id])
      .map((s) => `${name(s.id)}：${prev.ranks[s.id]} → ${final[s.id]}`);
    out.push({ kind: 'swap', title: '交換階段結束', lines: changed });
  }

  if (next.phase === 'PICK' && next.handNo > prev.handNo) {
    const lines = [`每人發 ${next.settings.holeCards} 張手牌`];
    if (next.round > 1) lines.push(`跳過翻牌前：同時發出 ${boardSize(next.round)} 張公牌`);
    out.push({ kind: 'info', title: `第 ${next.handNo} 局開始`, lines: [...lines, `${ROUND_LABEL[next.round]}：選擇順位`] });
  } else if (next.phase === 'PICK' && sameHand && next.round > prev.round) {
    if (next.round === prev.round + 1) {
      out.push({ kind: 'info', title: ROUND_TEXT[next.round] ?? `第 ${next.round} 輪`, lines: ['重新選擇順位'] });
    } else {
      // A skipped round: its cards come together with this round.
      const added = boardSize(next.round) - boardSize(prev.round);
      const skipped = ROUND_LABEL[prev.round + 1];
      out.push({ kind: 'info', title: `${ROUND_LABEL[next.round]}：一次發出 ${added} 張公牌`, lines: [`跳過${skipped}`, '重新選擇順位'] });
    }
  }

  if (next.phase === 'SHOWDOWN' && prev.phase !== 'SHOWDOWN') {
    out.push({ kind: 'result', title: '攤牌！', lines: ['公開所有手牌，從順位 1 開始比對'] });
  }
  if (next.phase === 'MATCH_END' && prev.phase !== 'MATCH_END') out.push({ kind: 'result', title: '本場結束', lines: [] });
  if (next.phase === 'LOBBY' && prev.phase !== 'LOBBY') out.push({ kind: 'info', title: '回到大廳', lines: ['房主可以開始新的一場'] });
  return out;
}
