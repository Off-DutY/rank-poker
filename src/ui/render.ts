import type { Card } from '../core/cards';
import type { NotifyStyle, PlayerId, PrivateState, PublicState, PublicSwapRequest, Seat } from '../core/engine';

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
const ROUND_NAMES = ['', '翻牌前', '翻牌', '轉牌', '河牌'];
const STAGE_NAMES: Record<string, string> = { PICK: '選名次', PERSIST: '執著度對決', SWAP: '交換名次' };

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
        : pub.phase === 'MATCH_END'
          ? '本場結束'
          : `第 ${pub.handNo} 局・${ROUND_NAMES[pub.round]}・${STAGE_NAMES[pub.phase]}`;
  // In the showdown, the score changes only after the reveal ends, so it does not spoil the result.
  const late = pub.phase === 'SHOWDOWN' ? ` late" style="--done:${revealEnd(pub.seats.length)}s` : '';
  return `<div class="hdr-row"><div class="room">房號 <b>${code}</b></div>
    <div class="step">${step}</div>
    <div class="score${late}"><span class="win">勝 ${pub.score.wins}</span> / <span class="lose">敗 ${pub.score.losses}</span></div></div>
    ${stepper(pub)}`;
}

/** Renders the hand progress: 4 rounds and the showdown. Empty outside a hand. */
function stepper(pub: PublicState): string {
  if (pub.phase === 'LOBBY' || pub.phase === 'MATCH_END') return '';
  const current = pub.phase === 'SHOWDOWN' ? 5 : pub.round;
  const names = [...ROUND_NAMES.slice(1), '攤牌'];
  const steps = names.map((label, i) => {
    const n = i + 1;
    const cls = n < current ? 'done' : n === current ? 'now' : '';
    return `<li class="${cls}"><span class="dot"></span><span class="txt">${label}</span></li>`;
  });
  return `<ol class="stepper">${steps.join('')}</ol>`;
}

/** Renders the lobby: player list, settings and the start button. */
export function lobby(ctx: Ctx, url: string): string {
  const { pub, isHost } = ctx;
  const n = pub.seats.length;
  const modes: [string, string, string][] = [
    ['budget', '預算制', '每局 100 單位，衝突與挑戰共用；可以挑戰'],
    ['free', '無代價', '執著度不消耗；不能挑戰'],
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
      ${n < 3 ? '<p class="hint">至少需要 3 位玩家。</p>' : ''}
    </section>
    <section class="panel">
      <h2>房間設定</h2>
      <div class="label">執著度模式</div>
      <div class="modes">${modes
        .map(
          ([m, label, desc]) => `<button class="mode${pub.settings.persistenceMode === m ? ' on' : ''}" data-act="mode" data-mode="${m}" ${isHost ? '' : 'disabled'}>
            <b>${label}</b><small>${desc}</small></button>`,
        )
        .join('')}</div>
      <div class="label">交換階段長度</div>
      <select data-act="swapSeconds" ${isHost ? '' : 'disabled'}>${swapOptions
        .map((s) => `<option value="${s}"${pub.settings.swapSeconds === s ? ' selected' : ''}>${s === 0 ? '不交換' : `${s} 秒`}</option>`)
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
      <div class="toggles">
        ${toggle('sound', '音效', pub.settings.sound, isHost)}
        ${toggle('vibrate', '震動', pub.settings.vibrate, isHost)}
      </div>
      <p class="hint">震動只在支援的手機有效（iPhone 不支援）。音效需要先點過畫面才會播放。</p>
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

function toggle(key: string, label: string, on: boolean, enabled: boolean): string {
  return `<button class="mode${on ? ' on' : ''}" data-act="toggle" data-key="${key}" data-on="${on ? 1 : 0}" ${enabled ? '' : 'disabled'}>
    <b>${label}</b><small>${on ? '開' : '關'}</small></button>`;
}

function seatItem(ctx: Ctx, s: Seat): string {
  const tags = [s.id === ctx.pub.hostId ? '<span class="tag">房主</span>' : '', s.id === ctx.me ? '<span class="tag me">你</span>' : '', s.connected ? '' : '<span class="tag off">離線</span>'];
  return `<li>${esc(s.name)} ${tags.join('')}</li>`;
}

/** Renders the cards: board and own hole cards. */
export function cards(ctx: Ctx): string {
  const board = Array.from({ length: 5 }, (_, i) => card(ctx.pub.board[i] ?? null)).join('');
  const hole = ctx.priv.hole ? ctx.priv.hole.map(card).join('') : card(null) + card(null);
  const budget =
    ctx.priv.budget == null
      ? ''
      : `<div class="budget" title="剩餘執著度"><div style="width:${Math.round(ctx.priv.budget * 100)}%"></div></div>`;
  return `<div class="board">${board}</div>
    <div class="mine"><div class="hole">${hole}</div><div class="mine-side"><span class="label">你的手牌</span>${budget}</div></div>`;
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
      small = `<small class="prev" title="上一輪名次">前 ${last} <b class="rise-mark">↑+${badge.pick - last}</b></small>`;
    } else if (last != null) {
      small = `<small class="prev" title="上一輪名次">前 ${last}</small>`;
    }
  } else if (badge.kind === 'trail') {
    const ranks = [...(ctx.pub.history[id] ?? []), ctx.pub.ranks[id]].filter((r) => r != null);
    if (ranks.length > 1) small = `<small class="prev" title="名次歷程">${ranks.join('→')}</small>`;
  }
  const tag = attrs ? 'button' : 'span';
  return `<${tag} class="${classes.filter(Boolean).join(' ')}" data-pid="${id}" ${attrs}>${nameOf(ctx.pub, id)}${small}</${tag}>`;
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
  return `<div class="duel">${side(a)}<div class="vs">⇄</div>${side(b)}</div>`;
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
        : `<button class="primary big" data-act="lock" ${myPick?.rank == null ? 'disabled' : ''}>鎖定名次</button>`
      : '<p class="hint center">名次衝突：相關玩家正在表達執著度…</p>';
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
  won: '挑戰成功，已交換',
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
    <p class="hint">點選其他玩家，提出交換名次。</p>
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
    body = `<b>${other}</b> 想和你交換名次${duel(ctx, r.from, r.to, pub.ranks[r.to]!)}
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
    const detail = `<table class="rivals"><thead><tr><th>搶這個名次的玩家</th><th>前幾輪名次</th></tr></thead><tbody>${rows}</tbody></table>`;
    return { key: `c${pub.handNo}-${pub.round}`, title: `${ids.length} 人搶同一個名次`, deadline: pub.deadline, contested: rank, detail };
  }
  const r = pub.swap?.requests.find((x) => x.status === 'challenge' && (x.from === me || x.to === me) && !x.submitted.includes(me));
  if (r) {
    const other = nameOf(pub, r.from === me ? r.to : r.from);
    const title = r.from === me ? `挑戰 ${other}：搶下對方的名次` : `${other} 向你挑戰：守住你的名次`;
    const contested = pub.ranks[r.to]!;
    return { key: `s${pub.handNo}-${pub.round}-${r.id}`, title, deadline: r.deadline, contested, detail: duel(ctx, r.from, r.to, contested) };
  }
  return null;
}

/** Renders the persistence window. The slider has no scale and no numbers. */
export function persistWindow(ctx: Ctx, p: PersistPrompt): string {
  const budget =
    ctx.priv.budget == null
      ? ''
      : `<div class="label">剩餘執著度</div><div class="budget big"><div style="width:${Math.round(ctx.priv.budget * 100)}%"></div></div>`;
  return `<div class="modal"><div class="dialog">
    <h2>${p.title}</h2>
    ${countdown(p.deadline, 10_000)}
    <div class="contest"><span class="label">爭奪的名次</span><div class="contest-rank">${p.contested}${rankHint(p.contested, ctx.pub.seats.length)}</div>
      <span class="label">1 最小 · ${ctx.pub.seats.length} 最大</span></div>
    ${p.detail}
    <p class="hint">你有多執著？往右拉越執著。${ctx.priv.budget == null ? '' : '投入的量會從預算扣除，輸了也一樣。'}</p>
    <div class="slider-wrap"><span>放手</span><input type="range" min="0" max="1000" step="1" data-act="slider"><span>死守</span></div>
    ${budget}
    <button class="primary big" data-act="persist">送出</button>
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
  const nextLabel = pub.matchOver ? '查看結果' : '下一局';
  const done = `style="--done:${revealEnd(ids.length)}s"`;
  return `<div class="result-slot" ${done}><div class="result pending">比對中…</div>
      <div class="result final ${sd.success ? 'ok' : 'bad'}">${sd.success ? '成功！排序完全正確' : '失敗，排序有錯'}</div></div>
    <div class="board">${pub.board.map(card).join('')}</div>
    <table class="showdown"><thead><tr><th>名次</th><th>玩家</th><th>手牌</th><th>牌型</th><th>正解</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <div class="after-reveal" ${done}>
    ${historyTable(ctx)}
    ${isHost ? `<button class="primary big" data-act="next">${nextLabel}</button>` : '<p class="hint center">等待房主繼續…</p>'}</div>`;
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
  const head = ROUND_NAMES.slice(1, rounds + 1).map((name) => `<th>${name}</th>`).join('');
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
  return `<section class="history"><div class="label">各輪名次（每輪交換結束後）</div>
    <table><thead><tr><th>玩家</th>${head}</tr></thead><tbody>${rows}</tbody></table></section>`;
}

/** Renders the end of the match. */
export function matchEnd(ctx: Ctx): string {
  const { pub, isHost } = ctx;
  const won = pub.score.wins > pub.score.losses;
  return `<div class="result ${won ? 'ok' : 'bad'} huge">${won ? '全隊勝利' : '全隊落敗'}</div>
    <p class="center">勝 ${pub.score.wins} / 敗 ${pub.score.losses}</p>
    ${isHost ? '<button class="primary big" data-act="next">再玩一場</button>' : '<p class="hint center">等待房主開新的一場…</p>'}`;
}
