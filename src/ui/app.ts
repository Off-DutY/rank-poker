import QRCode from 'qrcode';
import type { NotifyStyle, PublicState } from '../core/engine';
import type { Session } from '../net/session';
import { captureChips, createAnnouncer, dealCards, playChipMoves, pop } from './effects';
import { type Announcement, diffEvents } from './events';
import { unlockAudio } from './sound';
import { type Ctx, cards, header, historyTable, lobby, matchEnd, persistPrompt, persistWindow, pickLadder, showdownView, swapView } from './render';
import { roomUrl } from './room';

const REJECT_TEXT: Record<string, string> = {
  full: '房間已滿（13 人）。',
  started: '遊戲已經開始，無法中途加入。',
  version: '你的網頁版本和房主不同，請重新整理。',
};

const NO_HOST_HINT_MS = 15_000;
const REFRESH_MS = 100;

/**
 * Mounts the game UI for a session and keeps it in sync.
 * Each area re-renders only when its HTML changes, so inputs keep focus and the slider keeps its drag.
 */
export function mountGame(root: HTMLElement, session: Session, code: string): void {
  root.innerHTML =
    '<header id="hdr"></header><div id="ticker"></div><main id="main"></main><div id="announce" aria-live="polite"></div><div id="overlay"></div>';
  const hdr = root.querySelector<HTMLElement>('#hdr')!;
  const announcer = createAnnouncer(root.querySelector<HTMLElement>('#announce')!, root.querySelector<HTMLElement>('#ticker')!, () =>
    session.hostNow(),
  );
  // What the screen showed last time. Effects play only for the parts that changed.
  const fx = { phase: '', hand: 0, board: 0, locked: new Set<string>() };
  let lastPub: PublicState | null = null;
  const main = root.querySelector<HTMLElement>('#main')!;
  const overlay = root.querySelector<HTMLElement>('#overlay')!;
  const url = roomUrl(code);
  const startedAt = Date.now();
  const ui = { slider: 0, promptKey: '' };
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
    const ctx: Ctx = { me: session.me, isHost: session.isHost, pub: v.pub, priv: v.priv };
    set(hdr, header(ctx, code));
    const now = session.hostNow();
    const body =
      v.pub.phase === 'LOBBY'
        ? lobby(ctx, url)
        : v.pub.phase === 'SHOWDOWN'
          ? showdownView(ctx)
          : v.pub.phase === 'MATCH_END'
            ? matchEnd(ctx)
            : cards(ctx) + (v.pub.phase === 'SWAP' ? swapView(ctx, now) : pickLadder(ctx)) + historyTable(ctx);
    const before = captureChips(main);
    if (set(main, body)) playEffects(v.pub, before);
    // During the intro pause the host ignores actions, so the controls look paused too.
    const inIntro = v.pub.startsAt != null && now < v.pub.startsAt;
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
    if (atTable && pub.handNo !== fx.hand) {
      dealCards(main.querySelectorAll('.hole .card'));
      dealCards(main.querySelectorAll('.board .card'), 300);
    } else if (atTable && pub.board.length > fx.board) {
      dealCards([...main.querySelectorAll('.board .card')].slice(fx.board));
    }
    const locked = new Set(Object.entries(pub.picks).filter(([, p]) => p.locked).map(([id]) => id));
    if (pub.phase === 'PICK') for (const id of locked) if (!fx.locked.has(id)) pop(main.querySelector(`.ladder [data-pid="${id}"]`));
    fx.phase = pub.phase;
    fx.hand = atTable ? pub.handNo : fx.hand;
    fx.board = pub.board.length;
    fx.locked = locked;
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
      case 'copy':
        void navigator.clipboard?.writeText(url).then(
          () => (el.textContent = '已複製'),
          () => root.querySelector<HTMLInputElement>('.link')?.select(),
        );
        break;
      case 'mode':
        session.act({ type: 'settings', settings: { persistenceMode: d.mode === 'free' ? 'free' : 'budget' } });
        break;
      case 'toggle':
        if (d.key === 'sound' || d.key === 'vibrate') session.act({ type: 'settings', settings: { [d.key]: d.on !== '1' } });
        break;
      case 'preview':
        previewNotify();
        break;
      case 'start':
      case 'lock':
      case 'unlock':
      case 'next':
        session.act({ type: d.act });
        break;
      case 'pick':
        session.act({ type: 'pick', rank: Number(d.rank) });
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
    if (el.dataset.act === 'slider') ui.slider = Number(el.value) / 1000;
  });

  root.addEventListener('change', (e) => {
    const el = e.target as HTMLSelectElement;
    const act = el.dataset.act;
    if (act === 'swapSeconds' || act === 'introSeconds') session.act({ type: 'settings', settings: { [act]: Number(el.value) } });
    if (act === 'notifyStyle') session.act({ type: 'settings', settings: { notifyStyle: el.value as NotifyStyle } });
  });

  const notifyOptions = (pub: PublicState) => ({
    style: pub.settings.notifyStyle,
    sound: pub.settings.sound,
    vibrate: pub.settings.vibrate,
  });

  /** Shows a sample phase start with the current settings, on this device only. */
  const previewNotify = () => {
    const pub = session.view?.pub;
    if (!pub) return;
    const sample: Announcement[] = [
      { kind: 'conflict', title: '衝突結果', lines: ['玩家B：選 2 → 移到 1'] },
      { kind: 'info', title: '翻牌：發出 3 張公牌', lines: ['重新選擇名次'] },
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
      if (items.length) announcer.push(items, until, notifyOptions(pub));
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
