import type { Card } from '../core/cards';
import { type NotifyStyle, type PlayerId, type PrivateState, type PublicState, type PublicSwapRequest, type Seat, playedRounds } from '../core/engine';

/** Escapes text for HTML. All player-provided text must go through it (spec 11). */
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const SUIT_SYMBOL: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

/** Renders 1 card, or a card back when `card` is null. */
export function card(c: Card | null): string {
  if (!c) return '<span class="card back"></span>';
  const rank = c[0] === 'T' ? '10' : c[0]!;
  const red = c[1] === 'h' || c[1] === 'd';
  return `<span class="card${red ? ' red' : ''}">${rank}<small>${SUIT_SYMBOL[c[1]!]}</small></span>`;
}

/** Context for rendering: the views plus who is looking. */
export interface Ctx {
  me: PlayerId;
  isHost: boolean;
  pub: PublicState;
  priv: PrivateState;
}

const nameOf = (pub: PublicState, id: PlayerId) => esc(pub.seats.find((s) => s.id === id)?.name ?? '?');
/** Round names by round number (1..4). */
export const ROUND_NAMES = ['', '翻牌前', '翻牌', '轉牌', '河牌'];
const STAGE_NAMES: Record<string, string> = { PICK: '選順位', PERSIST: '籌碼對決', SWAP: '交換順位' };

/** Seconds between 2 rows in the showdown reveal. */
export const REVEAL_STEP_S = 0.8;

/** Returns the time in seconds when the showdown reveal ends, for `n` players. */
export function revealEnd(n: number): number {
  return n * REVEAL_STEP_S + 0.6;
}

/** Renders a countdown bar. The app fills in the time every frame. */
export function countdown(deadline: number | null, totalMs: number): string {
  if (deadline == null) return '';
  return `<div class="countdown" data-deadline="${deadline}" data-total="${totalMs}"><div class="bar"></div><span class="secs"></span></div>`;
}

/** Renders the header: room code, score and the current step. */
export function header(ctx: Ctx, code: string): string {
  const { pub } = ctx;
  const step =
    pub.phase === 'LOBBY'
      ? '等待玩家'
      : pub.phase === 'SHOWDOWN'
        ? `第 ${pub.handNo} 局・攤牌`
        : `第 ${pub.handNo} 局・${ROUND_NAMES[pub.round]}・${STAGE_NAMES[pub.phase]}`;
  // In the showdown, the score changes only after the reveal ends, so it does not spoil the result.
  const late = pub.phase === 'SHOWDOWN' ? ` late" style="--done:${revealEnd(pub.seats.length)}s` : '';
  return `<div class="hdr-row"><div class="room">房號 <b>${code}</b></div>
    <div class="step">${step}</div>
    <div class="score${late}"><span class="win">勝 ${pub.score.wins}</span> / <span class="lose">敗 ${pub.score.losses}</span></div></div>
    ${stepper(pub)}`;
}

/** Renders the hand progress: the played rounds and the showdown. Empty outside a hand. */
function stepper(pub: PublicState): string {
  if (pub.phase === 'LOBBY') return '';
  const current = pub.phase === 'SHOWDOWN' ? 5 : pub.round;
  const steps = [...playedRounds(pub.settings), 5].map((n) => {
    const cls = n < current ? 'done' : n === current ? 'now' : '';
    return `<li class="${cls}"><span class="dot"></span><span class="txt">${n === 5 ? '攤牌' : ROUND_NAMES[n]}</span></li>`;
  });
  return `<ol class="stepper">${steps.join('')}</ol>`;
}

/** Renders the lobby: player list, settings and the start button. */
export function lobby(ctx: Ctx, url: string): string {
  const { pub, isHost } = ctx;
  const n = pub.seats.length;
  const modes: [string, string, string][] = [
    ['on', '可以挑戰', '交換被拒絕時，可以用籌碼挑戰'],
    ['off', '不能挑戰', '交換被拒絕就結束'],
  ];
  const swapOptions = [0, 30, 60, 90, 120, 180];
  return `
    <section class="panel">
      <h2>邀請玩家</h2>
      <div class="link-row"><input class="link" readonly value="${esc(url)}"><button data-act="copy">複製</button></div>
      <div id="qr-slot"></div>
    </section>
    <section class="panel">
      <h2>玩家 ${n} / 13</h2>
      <ul class="seats">${pub.seats.map((s) => seatItem(ctx, s)).join('')}</ul>
      ${n < 3 ? '<p class="hint">至少需要 3 位玩家。人數不夠時，可以加入電腦玩家。</p>' : ''}
      ${isHost ? `<button data-act="addBot" ${n >= 13 ? 'disabled' : ''}>＋ 加入電腦玩家</button>` : ''}
    </section>
    <section class="panel">
      <h2>房間設定</h2>
      <div class="label">挑戰（籌碼不消耗）</div>
      <div class="modes">${modes
        .map(
          ([m, label, desc]) => `<button class="mode${(pub.settings.challenge ? 'on' : 'off') === m ? ' on' : ''}" data-act="mode" data-mode="${m}" ${isHost ? '' : 'disabled'}>
            <b>${label}</b><small>${desc}</small></button>`,
        )
        .join('')}</div>
      <div class="label">交換階段長度</div>
      <select data-act="swapSeconds" ${isHost ? '' : 'disabled'}>${swapOptions
        .map((s) => `<option value="${s}"${pub.settings.swapSeconds === s ? ' selected' : ''}>${s === 0 ? '不交換' : `${s} 秒`}</option>`)
        .join('')}</select>
    </section>
    <section class="panel">
      <h2>特殊玩法</h2>
      <div class="label">手牌張數（用全部手牌與公牌中最好的 5 張比大小）</div>
      <select data-act="holeCards" ${isHost ? '' : 'disabled'}>${[2, 3]
        .map((v) => `<option value="${v}"${pub.settings.holeCards === v ? ' selected' : ''}>${v} 張</option>`)
        .join('')}</select>
      <div class="label">跳過回合（該回合的牌併入下一回合一起發）</div>
      <select data-act="skipRound" ${isHost ? '' : 'disabled'}>${[0, 1, 2, 3]
        .map((v) => `<option value="${v}"${pub.settings.skipRound === v ? ' selected' : ''}>${v === 0 ? '不跳過' : `跳過第 ${v} 輪（${ROUND_NAMES[v]}）`}</option>`)
        .join('')}</select>
    </section>
    <section class="panel">
      <h2>提示方式</h2>
      <div class="label">提示樣式</div>
      <select data-act="notifyStyle" ${isHost ? '' : 'disabled'}>${NOTIFY_OPTIONS.map(
        ([v, label]) => `<option value="${v}"${pub.settings.notifyStyle === v ? ' selected' : ''}>${label}</option>`,
      ).join('')}</select>
      <div class="label">過場時間（提示期間暫停倒數）</div>
      <select data-act="introSeconds" ${isHost ? '' : 'disabled'}>${[0, 2, 3, 5]
        .map((v) => `<option value="${v}"${pub.settings.introSeconds === v ? ' selected' : ''}>${v === 0 ? '不暫停（提示與倒數同時開始）' : `${v} 秒`}</option>`)
        .join('')}</select>
      <p class="hint">音效、音樂與震動由每位玩家自己用左下角的按鈕開關。震動只在支援的手機有效（iPhone 不支援）。</p>
      <button data-act="preview">在我的裝置預覽提示</button>
    </section>
    ${isHost ? `<button class="primary big" data-act="start" ${n < 3 ? 'disabled' : ''}>開始遊戲</button>` : '<p class="hint center">等待房主開始遊戲…</p>'}`;
}

const NOTIFY_OPTIONS: [NotifyStyle, string][] = [
  ['fullscreen', '全螢幕過場：每個階段開始時蓋住畫面'],
  ['banner', '上方橫幅'],
  ['toast', '底部提示條'],
  ['ticker', '只顯示文字列：不跳出視窗'],
];

function seatItem(ctx: Ctx, s: Seat): string {
  const tags = [
    s.id === ctx.pub.hostId ? '<span class="tag">房主</span>' : '',
    s.id === ctx.me ? '<span class="tag me">你</span>' : '',
    s.bot ? '<span class="tag bot">電腦</span>' : '',
    s.connected ? '' : '<span class="tag off">離線</span>',
  ];
  const remove = s.bot && ctx.isHost && ctx.pub.phase === 'LOBBY' ? ` <button class="remove-bot" data-act="removeBot" data-target="${esc(s.id)}" aria-label="移除 ${esc(s.name)}">✕</button>` : '';
  return `<li>${esc(s.name)} ${tags.join('')}${remove}</li>`;
}

/** Renders the cards: board and own hole cards. */
export function cards(ctx: Ctx): string {
  const board = Array.from({ length: 5 }, (_, i) => card(ctx.pub.board[i] ?? null)).join('');
  const hole = holeHtml(ctx);
  return `<div class="board">${board}</div>
    <div class="mine"><div class="hole">${hole}</div><div class="mine-side"><span class="label">你的手牌</span></div></div>`;
}

/** Renders the own hole cards, or card backs (one per hole card) when they are hidden. */
function holeHtml(ctx: Ctx): string {
  return (ctx.priv.hole ?? Array<null>(ctx.pub.settings.holeCards).fill(null)).map(card).join('');
}

/** Returns the "smallest" / "largest" hint for a rank, or an empty string. */
function rankHint(r: number, n: number): string {
  return r === n ? '<small>最大</small>' : r === 1 ? '<small>最小</small>' : '';
}

/** Returns the player's rank at the end of the previous round, or null in round 1. */
function lastRank(pub: PublicState, id: PlayerId): number | null {
  return pub.history[id]?.at(-1) ?? null;
}

/** Renders the player's ranks of the finished rounds in this hand, for example "3→1". */
function trail(pub: PublicState, id: PlayerId): string {
  const h = pub.history[id] ?? [];
  return h.length ? h.join('→') : '—';
}

/** What a chip shows next to the name. */
type ChipBadge =
  | { kind: 'none' }
  /** The previous round rank. With `pick` larger than it, the chip marks the rise. */
  | { kind: 'last'; pick: number | null }
  /** Ranks of the finished rounds, then the current rank. */
  | { kind: 'trail' };

function chip(ctx: Ctx, id: PlayerId, extra = '', attrs = '', badge: ChipBadge = { kind: 'none' }): string {
  const seat = ctx.pub.seats.find((s) => s.id === id);
  const classes = ['chip', id === ctx.me ? 'me' : '', seat?.connected === false ? 'off' : '', extra];
  let small = '';
  if (badge.kind === 'last') {
    const last = lastRank(ctx.pub, id);
    if (last != null && badge.pick != null && badge.pick > last) {
      classes.push('rise');
      small = `<small class="prev" title="上一輪順位">前 ${last} <b class="rise-mark">↑+${badge.pick - last}</b></small>`;
    } else if (last != null) {
      small = `<small class="prev" title="上一輪順位">前 ${last}</small>`;
    }
  } else if (badge.kind === 'trail') {
    const ranks = [...(ctx.pub.history[id] ?? []), ctx.pub.ranks[id]].filter((r) => r != null);
    if (ranks.length > 1) small = `<small class="prev" title="順位歷程">${ranks.join('→')}</small>`;
  }
  const tag = attrs ? 'button' : 'span';
  // The hype count is in the markup, so a hype click changes the page and the app plays the effect.
  const hype = badge.kind === 'last' ? ` data-hype="${ctx.pub.picks[id]?.hype ?? 0}"` : '';
  return `<${tag} class="${classes.filter(Boolean).join(' ')}" data-pid="${id}"${hype} ${attrs}>${nameOf(ctx.pub, id)}${small}</${tag}>`;
}

/**
 * Renders 2 players side by side with their current rank and rank trail.
 * `focus` is the rank being fought for; it gets the strong highlight.
 */
function duel(ctx: Ctx, a: PlayerId, b: PlayerId, focus: number): string {
  const n = ctx.pub.seats.length;
  const side = (id: PlayerId) => {
    const r = ctx.pub.ranks[id]!;
    return `<div class="side${r === focus ? ' focus' : ''}">
      <div class="who">${id === ctx.me ? '你' : nameOf(ctx.pub, id)}</div>
      <div class="big-rank">${r}${rankHint(r, n)}</div>
      <div class="trail">歷程 ${trail(ctx.pub, id)}</div></div>`;
  };
  return `<div class="duel">${side(a)}<div class="vs">→</div>${side(b)}</div>`;
}

/** Renders the rank ladder for PICK and PERSIST: who picked which rank. */
export function pickLadder(ctx: Ctx): string {
  const { pub, me } = ctx;
  const n = pub.seats.length;
  const myPick = pub.picks[me];
  const canPick = pub.phase === 'PICK' && myPick && !myPick.locked;
  const conflicted = new Set(pub.conflict?.participants.map((id) => pub.picks[id]?.rank) ?? []);
  const rows: string[] = [];
  for (let r = 1; r <= n; r++) {
    const ids = pub.seats.filter((s) => pub.picks[s.id]?.rank === r).map((s) => s.id);
    const chips = ids
      .map((id) => {
        const p = pub.picks[id]!;
        const done = pub.conflict?.submitted.includes(id);
        return chip(ctx, id, (p.locked ? 'locked' : '') + (done ? ' done' : ''), '', { kind: 'last', pick: p.rank });
      })
      .join('');
    const cls = ['rung', myPick?.rank === r ? 'mine' : '', conflicted.has(r) ? 'conflict' : ''].filter(Boolean).join(' ');
    rows.push(`<button class="${cls}" data-act="pick" data-rank="${r}" ${canPick ? '' : 'disabled'}>
      <span class="num">${r}${rankHint(r, n)}</span>
      <span class="chips">${chips}</span></button>`);
  }
  const unpicked = pub.seats.filter((s) => pub.picks[s.id]?.rank == null).map((s) => chip(ctx, s.id, '', '', { kind: 'last', pick: null }));
  const footer =
    pub.phase === 'PICK'
      ? myPick?.locked
        ? '<p class="hint center">已鎖定，等待其他玩家…</p><button class="big" data-act="unlock">解除鎖定</button>'
        : `<button class="primary big" data-act="lock" ${myPick?.rank == null ? 'disabled' : ''}>鎖定順位</button>`
      : '<p class="hint center">順位衝突：相關玩家正在下注籌碼…</p>';
  return `${countdown(pub.deadline, pub.phase === 'PICK' ? 20_000 : 10_000)}
    <div class="ladder">${rows.join('')}</div>
    ${unpicked.length ? `<div class="unpicked"><span class="label">尚未選擇</span>${unpicked.join('')}</div>` : ''}
    ${footer}`;
}

const ACTIVE = new Set(['pending', 'deciding', 'challenge']);
const STATUS_TEXT: Record<string, string> = {
  pending: '等待回應',
  deciding: '已拒絕，請求者考慮挑戰',
  challenge: '挑戰中',
  accepted: '同意交換',
  declined: '拒絕交換',
  won: '挑戰成功，已移動',
  lost: '挑戰失敗',
  expired: '時間到，取消',
};

function busy(pub: PublicState, id: PlayerId): boolean {
  return pub.swap?.requests.some((r) => ACTIVE.has(r.status) && (r.from === id || r.to === id)) ?? false;
}

/** Renders the swap phase: ladder with request buttons, own requests and the log. */
export function swapView(ctx: Ctx, now: number): string {
  const { pub, me } = ctx;
  const swap = pub.swap!;
  const n = pub.seats.length;
  const timeLeft = pub.deadline != null && now < pub.deadline;
  const usedPair = (id: PlayerId) => swap.requests.some((r) => (r.from === me && r.to === id) || (r.from === id && r.to === me));
  const iAmBusy = busy(pub, me);
  const rows: string[] = [];
  for (let r = 1; r <= n; r++) {
    const id = pub.seats.find((s) => pub.ranks[s.id] === r)?.id;
    if (!id) continue;
    const can = id !== me && timeLeft && !iAmBusy && !busy(pub, id) && !usedPair(id);
    const extra = (busy(pub, id) ? 'busy' : '') + (swap.done[id] ? ' done' : '');
    const c = can
      ? chip(ctx, id, extra, `data-act="swapReq" data-target="${id}"`, { kind: 'trail' })
      : chip(ctx, id, extra, '', { kind: 'trail' });
    rows.push(`<div class="rung${id === me ? ' mine' : ''}"><span class="num">${r}${rankHint(r, n)}</span><span class="chips">${c}</span></div>`);
  }
  const mine = swap.requests.filter((r) => ACTIVE.has(r.status) && (r.from === me || r.to === me)).map((r) => myRequest(ctx, r));
  const log = swap.requests
    .slice()
    .reverse()
    .map((r) => `<li>${nameOf(pub, r.from)} → ${nameOf(pub, r.to)}：${STATUS_TEXT[r.status]}</li>`)
    .join('');
  const done = swap.done[me];
  return `${countdown(pub.deadline, pub.settings.swapSeconds * 1000)}
    <p class="hint">點選其他玩家，請求移到對方的順位。中間的玩家依序遞補。</p>
    ${mine.join('')}
    <div class="ladder">${rows.join('')}</div>
    <button class="${done ? '' : 'primary '}big" data-act="done" data-done="${done ? 0 : 1}">${done ? '取消完成' : '完成交換'}</button>
    ${log ? `<ul class="log">${log}</ul>` : ''}`;
}

function myRequest(ctx: Ctx, r: PublicSwapRequest): string {
  const { pub, me } = ctx;
  const other = nameOf(pub, r.from === me ? r.to : r.from);
  let body = '';
  if (r.status === 'pending' && r.to === me) {
    body = `<b>${other}</b> 想移到你的順位，你和中間的玩家各移 1 位遞補${duel(ctx, r.from, r.to, pub.ranks[r.to]!)}
      <div class="row"><button class="primary" data-act="swapResp" data-req="${r.id}" data-accept="1">同意</button>
      <button data-act="swapResp" data-req="${r.id}" data-accept="0">拒絕</button></div>`;
  } else if (r.status === 'pending') {
    body = `等待 <b>${other}</b> 回應…${duel(ctx, r.from, r.to, pub.ranks[r.to]!)}`;
  } else if (r.status === 'deciding' && r.from === me) {
    body = `<b>${other}</b> 拒絕了。要發起挑戰嗎？${duel(ctx, r.from, r.to, pub.ranks[r.to]!)}
      <div class="row"><button class="primary" data-act="challenge" data-req="${r.id}">挑戰</button></div>`;
  } else if (r.status === 'deciding') {
    body = `你拒絕了 <b>${other}</b>，對方可能發起挑戰…`;
  } else {
    body = `與 <b>${other}</b> 的挑戰進行中…`;
  }
  return `<div class="request">${countdown(r.deadline, r.status === 'deciding' ? 5_000 : 10_000)}${body}</div>`;
}

/** Describes the persistence window this player must answer now, or null. */
export interface PersistPrompt {
  key: string;
  title: string;
  deadline: number | null;
  /** The rank being fought for. */
  contested: number;
  /** HTML that shows the players involved. */
  detail: string;
}

/** Returns the open persistence window for this player, if any. */
export function persistPrompt(ctx: Ctx): PersistPrompt | null {
  const { pub, me } = ctx;
  if (pub.phase === 'PERSIST' && pub.conflict?.participants.includes(me) && !pub.conflict.submitted.includes(me)) {
    const rank = pub.picks[me]!.rank!;
    const ids = pub.conflict.participants.filter((id) => pub.picks[id]?.rank === rank);
    const rows = ids
      .map((id) => `<tr${id === me ? ' class="me"' : ''}><td>${id === me ? '你' : nameOf(pub, id)}</td><td>${trail(pub, id)}</td></tr>`)
      .join('');
    const detail = `<table class="rivals"><thead><tr><th>搶這個順位的玩家</th><th>前幾輪順位</th></tr></thead><tbody>${rows}</tbody></table>`;
    return { key: `c${pub.handNo}-${pub.round}`, title: `${ids.length} 人搶同一個順位`, deadline: pub.deadline, contested: rank, detail };
  }
  const r = pub.swap?.requests.find((x) => x.status === 'challenge' && (x.from === me || x.to === me) && !x.submitted.includes(me));
  if (r) {
    const other = nameOf(pub, r.from === me ? r.to : r.from);
    const title = r.from === me ? `挑戰 ${other}：搶下對方的順位` : `${other} 向你挑戰：守住你的順位`;
    const contested = pub.ranks[r.to]!;
    return { key: `s${pub.handNo}-${pub.round}-${r.id}`, title, deadline: r.deadline, contested, detail: duel(ctx, r.from, r.to, contested) };
  }
  return null;
}

/**
 * Returns the betting word for a slider position 0..1: fold at 0, all-in at 1, and call, raise, re-raise between.
 * The window shows only this word, never a number.
 */
export function betLabel(value: number): { text: string; cls: string } {
  if (value <= 0) return { text: '蓋牌', cls: 'fold' };
  if (value >= 1) return { text: 'All-in！', cls: 'allin' };
  if (value < 1 / 3) return { text: '跟注', cls: 'call' };
  if (value < 2 / 3) return { text: '加注', cls: 'raise' };
  return { text: '再加注', cls: 'reraise' };
}

/** Renders the bet label for a slider position. */
export function betLabelHtml(value: number): string {
  const b = betLabel(value);
  return `<span class="${b.cls}">${b.text}</span>`;
}

/** Renders the persistence window. The slider has no scale and no numbers; a betting word shows the size. */
export function persistWindow(ctx: Ctx, p: PersistPrompt): string {
  return `<div class="modal"><div class="dialog">
    <h2>${p.title}</h2>
    ${countdown(p.deadline, 10_000)}
    <div class="dialog-cards" aria-label="公牌與你的手牌">
      <div class="board">${Array.from({ length: 5 }, (_, i) => card(ctx.pub.board[i] ?? null)).join('')}</div>
      <div class="hole"><span class="label">你的手牌</span>${holeHtml(ctx)}</div>
    </div>
    <div class="contest"><span class="label">爭奪的順位</span><div class="contest-rank">${p.contested}${rankHint(p.contested, ctx.pub.seats.length)}</div>
      <span class="label">1 最小 · ${ctx.pub.seats.length} 最大</span></div>
    ${p.detail}
    <p class="hint">你要下多少注？往右拉注碼越大，拉到底就是 All-in。籌碼不消耗。</p>
    <div class="bet-label" aria-live="polite">${betLabelHtml(0)}</div>
    <div class="slider-wrap"><span>蓋牌</span><input type="range" min="0" max="1000" step="1" data-act="slider" aria-label="下注大小"><span>All-in</span></div>
    <button class="primary big" data-act="persist">下注</button>
  </div></div>`;
}

/** Renders the showdown: true order, picks and the result. */
export function showdownView(ctx: Ctx): string {
  const { pub, isHost } = ctx;
  const sd = pub.showdown!;
  const ids = pub.seats.map((s) => s.id).filter((id) => sd.entries[id]);
  const byRank = ids.slice().sort((a, b) => sd.ranks[a]! - sd.ranks[b]!);
  const rows = byRank
    .map((id, i) => {
      const e = sd.entries[id]!;
      // Valid ranks for a player: after all weaker hands, up to the last equal hand.
      const weaker = ids.filter((x) => sd.entries[x]!.score < e.score).length;
      const notStronger = ids.filter((x) => sd.entries[x]!.score <= e.score).length;
      const r = sd.ranks[id]!;
      const ok = r > weaker && r <= notStronger;
      const truth = weaker + 1 === notStronger ? `${notStronger}` : `${weaker + 1}–${notStronger}`;
      // Rank and name show at once. Cards, hand and verdict open row by row, from rank 1 up.
      return `<tr class="${ok ? 'ok' : 'bad'}${id === ctx.me ? ' me' : ''}" style="--i:${i}"><td class="num rank-cell">${r}${rankHint(r, ids.length)}</td><td>${nameOf(pub, id)}</td>
        <td class="hand reveal flip">${e.hole.map(card).join('')}</td><td class="reveal">${e.category}</td><td class="num reveal">${truth}</td><td class="reveal verdict">${ok ? '✓' : '✗'}</td></tr>`;
    })
    .join('');
  const done = `style="--done:${revealEnd(ids.length)}s"`;
  return `<div class="result-slot" ${done}><div class="result pending">比對中…</div>
      <div class="result final ${sd.success ? 'ok' : 'bad'}">${sd.success ? '成功！排序完全正確' : '失敗，排序有錯'}</div></div>
    <div class="board">${pub.board.map(card).join('')}</div>
    <table class="showdown"><thead><tr><th>順位</th><th>玩家</th><th>手牌</th><th>牌型</th><th>正解</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <div class="after-reveal" ${done}>
    ${historyTable(ctx)}
    ${isHost ? '<div class="end-actions"><button class="primary big" data-act="next">下一局</button><button class="big" data-act="lobby">全員回到大廳</button></div>' : '<p class="hint center">等待房主決定：下一局或回到大廳…</p>'}</div>`;
}

/**
 * Renders each player's final rank per finished round of this hand.
 * Rows follow the latest rank, smallest first. Arrows show the change from the previous round.
 */
export function historyTable(ctx: Ctx): string {
  const { pub, me } = ctx;
  const rounds = Math.max(0, ...Object.values(pub.history).map((h) => h.length));
  if (rounds === 0) return '';
  const latest = (id: PlayerId) => pub.history[id]![rounds - 1] ?? Number.MAX_SAFE_INTEGER;
  const ids = pub.seats.map((s) => s.id).filter((id) => pub.history[id]).sort((a, b) => latest(a) - latest(b));
  // History index i belongs to the i-th played round; a skipped round has no column.
  const head = playedRounds(pub.settings)
    .slice(0, rounds)
    .map((r) => `<th>${ROUND_NAMES[r]}</th>`)
    .join('');
  const rows = ids
    .map((id) => {
      const h = pub.history[id]!;
      const cells = h
        .map((r, i) => {
          const prev = h[i - 1];
          const arrow = prev == null || prev === r ? '' : r > prev ? '<small class="up">↑</small>' : '<small class="down">↓</small>';
          return `<td class="num">${r}${arrow}</td>`;
        })
        .join('');
      return `<tr${id === me ? ' class="me"' : ''}><td>${nameOf(pub, id)}</td>${cells}</tr>`;
    })
    .join('');
  return `<section class="history"><div class="label">各輪順位（每輪交換結束後）</div>
    <table><thead><tr><th>玩家</th>${head}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

/** One player's rank before and after a step. `from` is null when there is nothing to compare. */
export interface RankChange {
  id: PlayerId;
  from: number | null;
  to: number;
}

/**
 * Returns the rank changes to show during an intro pause, or null when there is nothing to show.
 * Swap intro: the picked rank against the assigned rank.
 * Pick intro (round 2+): the rank at the end of the round before the last one against the last round.
 */
export function rankChanges(pub: PublicState): { title: string; rows: RankChange[] } | null {
  const ids = pub.seats.map((s) => s.id);
  let title: string;
  let rows: RankChange[];
  if (pub.phase === 'SWAP') {
    title = '順位確定：選擇 → 結果';
    rows = ids.filter((id) => pub.ranks[id] != null).map((id) => ({ id, from: pub.picks[id]?.rank ?? null, to: pub.ranks[id]! }));
  } else if (pub.phase === 'PICK' && playedRounds(pub.settings).indexOf(pub.round) >= 1) {
    const played = playedRounds(pub.settings);
    const i = played.indexOf(pub.round);
    const prevName = ROUND_NAMES[played[i - 1]!];
    title = i >= 2 ? `${ROUND_NAMES[played[i - 2]!]} → ${prevName} 的順位變化` : `${prevName}的最終順位`;
    rows = ids
      .filter((id) => pub.history[id]?.length)
      .map((id) => {
        const h = pub.history[id]!;
        return { id, from: h.length >= 2 ? h[h.length - 2]! : null, to: h[h.length - 1]! };
      });
  } else {
    return null;
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.to - b.to);
  return { title, rows };
}

/** Returns the "smallest" / "largest" label placed before a rank, or an empty string. */
function rankPrefix(r: number, n: number): string {
  return r === n ? '<small class="rc-hint">最大</small>' : r === 1 ? '<small class="rc-hint">最小</small>' : '';
}

/**
 * Renders the rank change panel for the intro pause.
 * Rows first stand in their old order with the old rank, then all move at once to the new order
 * and show the new rank (CSS only: each row knows its old index `--a` and new index `--b`).
 */
export function rankChangeHtml(pub: PublicState, me: PlayerId): string {
  const rc = rankChanges(pub);
  if (!rc) return '';
  const n = pub.seats.length;
  // Old order: by old rank; equal old ranks (a conflict) keep the new order among them.
  const oldOrder = rc.rows.slice().sort((x, y) => (x.from ?? x.to) - (y.from ?? y.to) || x.to - y.to);
  const rows = rc.rows
    .map((r, b) => {
      const a = oldOrder.indexOf(r);
      const moved = r.from != null && r.from !== r.to;
      const dir = !moved ? '' : r.to > r.from! ? 'up' : 'down';
      const arrow = dir === 'up' ? `↑${r.to - r.from!}` : dir === 'down' ? `↓${r.from! - r.to}` : '';
      const old = r.from == null ? '' : `<span class="rc-old${moved ? ' moved' : ''}">${rankPrefix(r.from, n)}${r.from}</span>`;
      const same = r.from != null && !moved ? '<small class="rc-same">不變</small>' : '';
      return `<li class="rc-row ${dir}${r.id === me ? ' me' : ''}${r.from == null ? ' fresh' : ''}" style="--a:${a};--b:${b}">
        <span class="rc-name">${r.id === me ? '你' : nameOf(pub, r.id)}</span>
        <span class="rc-ranks">${old}<span class="rc-new">${rankPrefix(r.to, n)}<b class="rc-to">${r.to}</b></span>${same}</span>
        <span class="rc-arrow">${arrow}</span></li>`;
    })
    .join('');
  return `<section class="rank-change"><div class="rc-title">${rc.title}</div><ol>${rows}</ol></section>`;
}

/** Hand categories from strongest to weakest, with 1 example hand each. Names match `CATEGORY_NAMES`. */
const HAND_RANKS: [name: string, example: Card[], note: string][] = [
  ['同花順', ['As', 'Ks', 'Qs', 'Js', 'Ts'], '同花色的順子。A 到 10 是最大的皇家同花順'],
  ['四條', ['9c', '9d', '9h', '9s', 'Kd'], '4 張同點數'],
  ['葫蘆', ['Qh', 'Qd', 'Qs', '7c', '7h'], '三條 + 一對'],
  ['同花', ['Kh', 'Th', '8h', '5h', '2h'], '5 張同花色'],
  ['順子', ['9d', '8c', '7s', '6h', '5d'], '5 張連續點數。A-2-3-4-5 是最小的順子'],
  ['三條', ['7s', '7h', '7d', 'Kc', '2s'], '3 張同點數'],
  ['兩對', ['Jc', 'Jd', '4s', '4h', 'Ac'], '2 組對子'],
  ['一對', ['Ts', 'Th', 'Ad', '8c', '3s'], '2 張同點數'],
  ['高牌', ['Ac', 'Jd', '8s', '5h', '3c'], '以上都不是，比最大的單張'],
];

/** Renders the side panel with the hand categories. Players open and close it at any time. */
export function handRankPanel(): string {
  const rows = HAND_RANKS.map(
    ([name, ex, note], i) =>
      `<li><div class="hr-head"><b>${HAND_RANKS.length - i}. ${name}</b><span class="hr-cards">${ex.map(card).join('')}</span></div><small>${note}</small></li>`,
  ).join('');
  return `<button class="handref-tab" data-act="handref" aria-expanded="false" aria-controls="handref-body">牌型</button>
    <div class="handref-body" id="handref-body"><div class="handref-top"><b>牌型大小（大 → 小）</b><button class="handref-close" data-act="handref" aria-label="收合">✕</button></div>
    <ol>${rows}</ol><p class="hint">同牌型時比點數；用全部手牌與公牌中最好的 5 張。</p></div>`;
}
