import QRCode from 'qrcode';
import { type LockEnd, type NotifyStyle, type PublicState, RULES } from '../core/engine';
import type { Session } from '../net/session';
import { boardBurst, captureChips, createAnnouncer, dealCards, flashChips, hypeChip, playChipMoves, pop } from './effects';
import { type Announcement, diffEvents } from './events';
import { setMusic, unlockAudio } from './sound';
import { type Ctx, betLabelHtml, cards, guessView, header, historyTable, lobby, rankChangeHtml, persistPrompt, settingsPanel, persistWindow, pickLadder, showdownView, swapView } from './render';
import { audioPrefs, roomUrl, saveAudioPrefs } from './room';

const REJECT_TEXT: Record<string, string> = {
  full: '房間已滿（13 人）。',
  started: '遊戲已經開始，無法中途加入。',
  version: '你的網頁版本和房主不同，請重新整理。',
};

const NO_HOST_HINT_MS = 15_000;
/** Titles of the big board reveal, by round. */
const BOARD_TITLES: Record<number, string> = { 2: '翻牌！', 3: '轉牌！', 4: '河牌！' };

/** Returns the big reveal title of a round. After a skipped round, it names both rounds, for example "翻牌＋轉牌！". */
function boardTitle(pub: PublicState): string | null {
  const title = BOARD_TITLES[pub.round];
  if (!title) return null;
  const skipped = pub.settings.skipRound === pub.round - 1 ? BOARD_TITLES[pub.round - 1] : undefined;
  return skipped ? `${skipped.slice(0, -1)}＋${title}` : title;
}
const REFRESH_MS = 100;

/**
 * Mounts the game UI for a session and keeps it in sync.
 * Each area re-renders only when its HTML changes, so inputs keep focus and the slider keeps its drag.
 */
export function mountGame(root: HTMLElement, session: Session, code: string): void {
  root.innerHTML =
    '<header id="hdr"></header><div id="ticker"></div><main id="main"></main><div id="announce" aria-live="polite"></div><div id="overlay"></div><aside id="handref" class="handref"></aside>';
  const handref = root.querySelector<HTMLElement>('#handref')!;
  handref.innerHTML = settingsPanel();
  const hdr = root.querySelector<HTMLElement>('#hdr')!;
  // Sound, music and vibration belong to this player only, so they live in the side panel, not in the room settings.
  const audio = audioPrefs();
  const audioCtl = root.querySelector<HTMLElement>('#audio')!;
  const renderAudio = () => {
    const btn = (key: 'sound' | 'music' | 'vibrate', on: string, off: string) =>
      `<button class="${audio[key] ? 'on' : ''}" data-act="audio" data-key="${key}" aria-pressed="${audio[key]}">${audio[key] ? on : off}</button>`;
    audioCtl.innerHTML = btn('sound', '🔊 音效', '🔇 音效') + btn('music', '🎵 音樂', '🎵 音樂關') + btn('vibrate', '📳 震動', '📴 震動');
  };
  renderAudio();
  setMusic(audio.music);
  const announcer = createAnnouncer(root.querySelector<HTMLElement>('#announce')!, root.querySelector<HTMLElement>('#ticker')!, () =>
    session.hostNow(),
  );
  // What the screen showed last time. Effects play only for the parts that changed.
  const fx = {
    phase: '',
    hand: 0,
    /** The hand whose own hole cards already played the big reveal. */
    holeHand: 0,
    board: 0,
    locked: new Set<string>(),
    picks: {} as Record<string, number | null>,
    ranks: {} as Record<string, number>,
    hype: {} as Record<string, number>,
    /** Local times of recent hype clicks per player. Faster clicks give a stronger effect. */
    hypeTimes: {} as Record<string, number[]>,
  };
  let lastPub: PublicState | null = null;
  /**
   * New cards held back until `at` (host time), so the announcement shows before the reveal.
   * `shown` is the number of board cards to keep; `hole` hides the own hole cards (new hand).
   */
  const reveal = { at: 0, shown: 0, hand: 0, round: 0, hole: false };
  const main = root.querySelector<HTMLElement>('#main')!;
  const overlay = root.querySelector<HTMLElement>('#overlay')!;
  const url = roomUrl(code);
  const startedAt = Date.now();
  const ui = { slider: 0, promptKey: '' };
  /** Shows the betting word for the current slider position in the persistence window. */
  const showBet = () => {
    const el = root.querySelector<HTMLElement>('.bet-label');
    if (!el) return;
    const html = betLabelHtml(ui.slider);
    if (el.innerHTML === html) return;
    el.innerHTML = html;
    pop(el.firstElementChild);
  };
  const lastHtml = new WeakMap<HTMLElement, string>();

  const qr = document.createElement('canvas');
  qr.className = 'qr';
  void QRCode.toCanvas(qr, url, { width: 180, margin: 1 }).catch(() => qr.remove());

  const set = (el: HTMLElement, html: string): boolean => {
    if (lastHtml.get(el) === html) return false;
    lastHtml.set(el, html);
    el.innerHTML = html;
    return true;
  };

  const render = () => {
    const v = session.view;
    if (session.status === 'rejected') {
      set(hdr, '');
      set(overlay, '');
      set(main, message('無法加入', REJECT_TEXT[session.reason ?? ''] ?? '房主拒絕了連線。'));
      return;
    }
    if (session.status === 'closed') {
      set(overlay, '');
      set(main, message('連線結束', session.reason === 'host-left' ? '房主已離線，遊戲結束。' : '你已離開房間。'));
      return;
    }
    if (!v) {
      const slow = Date.now() - startedAt > NO_HOST_HINT_MS;
      set(main, message('連線中…', slow ? '還找不到房主。請確認連結正確，且房主的網頁仍然開著。部分公司或行動網路無法建立 P2P 連線。' : '正在尋找房主。'));
      return;
    }
    const now0 = session.hostNow();
    // New board cards stay hidden until their reveal time: first the rank results, then the big reveal.
    const hold = reveal.at > now0 && reveal.hand === v.pub.handNo && reveal.round === v.pub.round;
    const shown: PublicState = hold ? { ...v.pub, board: v.pub.board.slice(0, reveal.shown) } : v.pub;
    const priv = hold && reveal.hole ? { ...v.priv, hole: null } : v.priv;
    const ctx: Ctx = { me: session.me, isHost: session.isHost, pub: shown, priv };
    set(hdr, header(ctx, code));
    const now = session.hostNow();
    // During the intro pause the host ignores actions, so the controls look paused too.
    const inIntro = v.pub.startsAt != null && now < v.pub.startsAt;
    // With a popup style the panel is in the popup only; the ticker-only style shows it on the table.
    const changes = inIntro && v.pub.settings.notifyStyle === 'ticker' ? rankChangeHtml(v.pub, session.me) : '';
    const body =
      v.pub.phase === 'LOBBY'
        ? lobby(ctx, url)
        : v.pub.phase === 'SHOWDOWN'
          ? showdownView(ctx)
          : v.pub.phase === 'GUESS'
            ? cards(ctx) + guessView(ctx) + historyTable(ctx)
            : cards(ctx) + changes + (v.pub.phase === 'SWAP' ? swapView(ctx, now) : pickLadder(ctx)) + historyTable(ctx);
    const before = captureChips(main);
    if (set(main, body)) playEffects(shown, before);
    main.classList.toggle('intro', inIntro);
    const slot = main.querySelector('#qr-slot');
    if (slot && !slot.contains(qr)) slot.append(qr);

    // The persistence window opens when the intro ends, so players see the whole 10 seconds.
    const prompt = inIntro ? null : persistPrompt(ctx);
    if (prompt && prompt.key !== ui.promptKey) {
      ui.promptKey = prompt.key;
      ui.slider = 0;
    }
    if (set(overlay, prompt ? persistWindow(ctx, prompt) : '')) {
      const slider = overlay.querySelector<HTMLInputElement>('input[type=range]');
      if (slider) slider.value = String(Math.round(ui.slider * 1000));
      showBet();
    }
    updateCountdowns();
  };

  const playEffects = (pub: PublicState, before: Map<string, DOMRect>) => {
    if (pub.phase !== fx.phase) {
      main.classList.remove('phase-in');
      void main.offsetWidth;
      main.classList.add('phase-in');
    }
    playChipMoves(main, before);
    const atTable = pub.phase === 'PICK' || pub.phase === 'PERSIST' || pub.phase === 'SWAP';
    const hole = [...main.querySelectorAll('.hole .card')];
    if (atTable && pub.handNo !== fx.hand) dealCards(main.querySelectorAll('.board .card'), 300);
    if (atTable && pub.handNo !== fx.holeHand && hole.length && !hole[0]!.classList.contains('back')) {
      // The own hole cards show face up for the first time in this hand: big reveal, then they land in the hand area.
      // With round 1 skipped, the flop comes with them in the same reveal.
      const board = [...main.querySelectorAll('.board .card')].slice(0, pub.board.length);
      const title = board.length ? '你的手牌＋翻牌' : '你的手牌';
      boardBurst(root, title, [...hole, ...board].map((c) => c.outerHTML));
      dealCards(hole, 1_500);
      fx.holeHand = pub.handNo;
    } else if (atTable && pub.board.length > fx.board) {
      // Only the newly revealed cards; the slots after them are still card backs.
      const fresh = [...main.querySelectorAll('.board .card')].slice(fx.board, pub.board.length);
      // The flop and the turn get a big center effect; the cards land on the table after it.
      const title = boardTitle(pub);
      if (title) boardBurst(root, title, fresh.map((c) => c.outerHTML));
      dealCards(fresh, title ? 1_500 : 0);
    }
    if (pub.phase === 'PICK' && fx.phase === 'PICK') {
      // A player picked a larger rank than before: flash that chip.
      const raised = Object.entries(pub.picks)
        .filter(([id, p]) => p.rank != null && p.rank !== fx.picks[id] && p.rank > (pub.history[id]?.at(-1) ?? Infinity))
        .map(([id]) => id);
      flashChips(main, raised, 'rise-pop');
      // A player keeps clicking the own rank: show the excitement to everyone.
      const t = performance.now();
      for (const [id, p] of Object.entries(pub.picks)) {
        if (p.hype <= (fx.hype[id] ?? 0)) continue;
        const times = (fx.hypeTimes[id] ?? []).filter((x) => t - x < 2_000);
        times.push(t);
        fx.hypeTimes[id] = times;
        hypeChip(main, root, id, times.length >= 8 ? 3 : times.length >= 4 ? 2 : 1);
      }
    }
    if (pub.phase === 'SWAP' && fx.phase === 'SWAP') {
      const swapped = Object.keys(pub.ranks).filter((id) => fx.ranks[id] != null && fx.ranks[id] !== pub.ranks[id]);
      flashChips(main, swapped, 'swapped');
    }
    const locked = new Set(Object.entries(pub.picks).filter(([, p]) => p.locked).map(([id]) => id));
    if (pub.phase === 'PICK') for (const id of locked) if (!fx.locked.has(id)) pop(main.querySelector(`.ladder [data-pid="${id}"]`));
    fx.phase = pub.phase;
    fx.hand = atTable ? pub.handNo : fx.hand;
    fx.board = pub.board.length;
    fx.locked = locked;
    fx.picks = Object.fromEntries(Object.entries(pub.picks).map(([id, p]) => [id, p.rank]));
    fx.ranks = { ...pub.ranks };
    fx.hype = Object.fromEntries(Object.entries(pub.picks).map(([id, p]) => [id, p.hype]));
  };

  const updateCountdowns = () => {
    const now = session.hostNow();
    for (const el of root.querySelectorAll<HTMLElement>('.countdown')) {
      const left = Math.max(0, Number(el.dataset.deadline) - now);
      const total = Number(el.dataset.total) || 1;
      // Time above the phase length is the intro pause: the countdown has not started yet.
      const waiting = left > total;
      el.querySelector<HTMLElement>('.bar')!.style.width = `${Math.min(100, (left / total) * 100)}%`;
      el.querySelector<HTMLElement>('.secs')!.textContent = waiting
        ? `${Math.ceil(total / 1000)} 秒・${Math.ceil((left - total) / 1000)} 秒後開始`
        : `${Math.ceil(left / 1000)}`;
      el.classList.toggle('waiting', waiting);
      el.classList.toggle('urgent', !waiting && left < 5_000);
    }
  };

  root.addEventListener('click', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-act]');
    if (!el || (el as HTMLButtonElement).disabled) return;
    const d = el.dataset;
    switch (d.act) {
      case 'handref': {
        const open = handref.classList.toggle('open');
        handref.querySelector('.handref-tab')!.setAttribute('aria-expanded', String(open));
        break;
      }
      case 'copy':
        void navigator.clipboard?.writeText(url).then(
          () => (el.textContent = '已複製'),
          () => root.querySelector<HTMLInputElement>('.link')?.select(),
        );
        break;
      case 'mode':
        session.act({ type: 'settings', settings: { challenge: d.mode === 'on' } });
        break;
      case 'audio':
        if (d.key === 'sound' || d.key === 'music' || d.key === 'vibrate') {
          audio[d.key] = !audio[d.key];
          saveAudioPrefs(audio);
          renderAudio();
          unlockAudio();
          setMusic(audio.music);
        }
        break;
      case 'preview':
        previewNotify();
        break;
      case 'addBot':
        session.act({ type: 'addBot' });
        break;
      case 'removeBot':
        session.act({ type: 'removeBot', targetId: d.target! });
        break;
      case 'start':
      case 'lock':
      case 'unlock':
      case 'next':
      case 'lobby':
        session.act({ type: d.act });
        break;
      case 'pick':
        session.act({ type: 'pick', rank: Number(d.rank) });
        break;
      case 'guess':
        session.act({ type: 'guessVote', category: Number(d.cat) });
        break;
      case 'swapReq':
        session.act({ type: 'swapRequest', targetId: d.target! });
        break;
      case 'swapResp':
        session.act({ type: 'swapRespond', requestId: Number(d.req), accept: d.accept === '1' });
        break;
      case 'challenge':
        session.act({ type: 'swapChallenge', requestId: Number(d.req) });
        break;
      case 'done':
        session.act({ type: 'swapDone', done: d.done === '1' });
        break;
      case 'persist':
        session.act({ type: 'persist', value: ui.slider });
        (el as HTMLButtonElement).disabled = true;
        break;
    }
  });

  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement;
    if (el.dataset.act === 'slider') {
      ui.slider = Number(el.value) / 1000;
      showBet();
    }
  });

  root.addEventListener('change', (e) => {
    const el = e.target as HTMLSelectElement;
    const act = el.dataset.act;
    if (act === 'swapSeconds' || act === 'introSeconds' || act === 'holeCards' || act === 'skipRound') session.act({ type: 'settings', settings: { [act]: Number(el.value) } });
    if (act === 'notifyStyle') session.act({ type: 'settings', settings: { notifyStyle: el.value as NotifyStyle } });
    if (act === 'lockEnd') session.act({ type: 'settings', settings: { lockEnd: el.value as LockEnd } });
    if (act === 'finalGuess') session.act({ type: 'settings', settings: { finalGuess: el.value === '1' } });
  });

  const notifyOptions = (pub: PublicState) => ({
    style: pub.settings.notifyStyle,
    sound: audio.sound,
    vibrate: audio.vibrate,
  });

  /** Shows a sample phase start with the current settings, on this device only. */
  const previewNotify = () => {
    const pub = session.view?.pub;
    if (!pub) return;
    const sample: Announcement[] = [
      { kind: 'conflict', title: '衝突結果', lines: ['玩家B：選 2 → 移到 1'] },
      { kind: 'info', title: '翻牌：發出 3 張公牌', lines: ['重新選擇順位'] },
    ];
    const intro = pub.settings.introSeconds;
    announcer.push(sample, intro > 0 ? session.hostNow() + intro * 1000 : null, notifyOptions(pub), true);
  };

  session.subscribe(() => {
    const pub = session.view?.pub ?? null;
    if (pub && pub !== lastPub) {
      const items = diffEvents(lastPub, pub, session.me);
      // A new intro pause means a timed phase starts: keep its announcements up until the timer starts.
      const until = pub.startsAt != null && pub.startsAt !== lastPub?.startsAt && pub.startsAt > session.hostNow() ? pub.startsAt : null;
      // New board cards play the big reveal first; the announcement waits until it ends.
      const newCards = until != null && lastPub != null && pub.board.length > lastPub.board.length && BOARD_TITLES[pub.round] != null;
      // A new hand deals the hole cards with the same order: announcement first, then the reveal.
      const newHand = until != null && pub.phase === 'PICK' && pub.round === 1 && pub.handNo !== lastPub?.handNo;
      const extra = until != null ? rankChangeHtml(pub, session.me) : '';
      if (newCards || newHand) {
        // Order: announcement (with rank results) first, then the big reveal in the last part of the intro.
        reveal.at = pub.startsAt! - RULES.boardRevealMs;
        reveal.shown = newHand ? 0 : lastPub!.board.length;
        reveal.hole = newHand;
        reveal.hand = pub.handNo;
        reveal.round = pub.round;
      }
      const announceUntil = newCards || newHand ? Math.max(session.hostNow(), reveal.at) : until;
      if (items.length) announcer.push(items, announceUntil, notifyOptions(pub), false, extra);
      lastPub = pub;
    }
    render();
  });
  // Browsers allow sound only after a user gesture.
  root.addEventListener('pointerdown', unlockAudio);
  // Re-render on a timer too: countdowns move, and some buttons depend on the time.
  setInterval(render, REFRESH_MS);
  window.addEventListener('pagehide', () => session.close());
  render();
}

function message(title: string, body: string): string {
  return `<section class="panel message"><h2>${title}</h2><p>${body}</p><a class="button" href="${location.pathname}">回首頁</a></section>`;
}
