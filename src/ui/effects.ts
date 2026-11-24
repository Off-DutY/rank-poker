import type { NotifyStyle } from '../core/engine';
import type { Announcement, AnnouncementKind } from './events';
import { esc } from './render';
import { playCue, vibrateCue } from './sound';

/** True when the user asks the system for less motion. Announcements still show, without animation. */
export const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const BASE_MS = 1_300;
const PER_LINE_MS = 450;
const MAX_MS = 4_000;
const MIN_INTRO_MS = 800;
/** Maximum waiting pages. Older ones are dropped, so the screen never shows stale news. */
const MAX_WAITING = 2;
const KIND_RANK: Record<AnnouncementKind, number> = { info: 0, swap: 1, result: 2, conflict: 3 };

/** How to show announcements. Comes from the room settings. */
export interface NotifyOptions {
  style: NotifyStyle;
  sound: boolean;
  vibrate: boolean;
}

/** One screen of announcements: all events from 1 state change. */
interface Page {
  items: Announcement[];
  /** Trusted HTML built by the app (for example the rank change panel), shown under the text. */
  extraHtml: string;
  /** Host time when the intro pause ends, or null when no timed phase starts. */
  until: number | null;
  opts: NotifyOptions;
}

/**
 * Shows announcements in the style that the host chose, and keeps the newest one in the ticker line.
 * A page that starts a timed phase replaces whatever shows now, and stays until the intro pause ends,
 * so the countdown starts only after players read it.
 * The popup never catches clicks.
 */
export function createAnnouncer(
  popup: HTMLElement,
  ticker: HTMLElement,
  hostNow: () => number,
): { push(items: Announcement[], until: number | null, opts: NotifyOptions, preview?: boolean, extraHtml?: string): void } {
  const queue: Page[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const hide = () => {
    popup.className = '';
    popup.innerHTML = '';
  };

  const show = (page: Page) => {
    const { items, until, opts, extraHtml } = page;
    const kind = items.reduce<AnnouncementKind>((k, a) => (KIND_RANK[a.kind] > KIND_RANK[k] ? a.kind : k), 'info');
    if (opts.sound) playCue(kind);
    if (opts.vibrate) vibrateCue(kind);
    const lines = items.reduce((n, a) => n + 1 + a.lines.length, 0);
    const ms = until != null ? Math.max(MIN_INTRO_MS, until - hostNow()) : Math.min(MAX_MS, BASE_MS + PER_LINE_MS * lines) / (queue.length ? 2 : 1);
    if (opts.style !== 'ticker') {
      // Full screen is for phase starts only. Other news uses the banner, so it does not hide the game.
      const style = opts.style === 'fullscreen' && until == null ? 'banner' : opts.style;
      const blocks = items
        .map((a) => {
          const ul = a.lines.length ? `<ul>${a.lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '';
          return `<section class="${a.kind}"><b>${esc(a.title)}</b>${ul}</section>`;
        })
        .join('');
      const bar = until != null ? `<div class="intro-bar"><div style="animation-duration:${ms}ms"></div></div><small>倒數即將開始</small>` : '';
      popup.innerHTML = `<div class="announce-card ${kind}">${blocks}${extraHtml}${bar}</div>`;
      popup.className = `style-${style}`;
      void popup.offsetWidth; // Restart the CSS animation.
      popup.classList.add('show');
    }
    timer = setTimeout(() => {
      timer = null;
      hide();
      setTimeout(pump, 150);
    }, ms);
  };

  const pump = () => {
    if (timer) return;
    const page = queue.shift();
    if (page) show(page);
  };

  return {
    push(items, until, opts, preview = false, extraHtml = '') {
      const latest = items.at(-1);
      if (!latest) return;
      if (!preview) {
        // The ticker always shows the newest event at once, even when the popup is busy. A preview is not news.
        ticker.innerHTML = `<span class="tick-kind ${latest.kind}"></span>${esc([latest.title, latest.lines[0]].filter(Boolean).join('：'))}`;
        ticker.classList.remove('flash');
        void ticker.offsetWidth;
        ticker.classList.add('flash');
      }
      const page: Page = { items, until, opts, extraHtml };
      if (until != null) {
        // A phase start is the most important news: drop older pages and show it now.
        queue.length = 0;
        if (timer) clearTimeout(timer);
        timer = null;
        show(page);
        return;
      }
      queue.push(page);
      queue.splice(0, Math.max(0, queue.length - MAX_WAITING));
      pump();
    },
  };
}

/** Returns the screen position of every player chip, keyed by player ID. */
export function captureChips(root: HTMLElement): Map<string, DOMRect> {
  const map = new Map<string, DOMRect>();
  for (const el of root.querySelectorAll<HTMLElement>('.ladder [data-pid], .unpicked [data-pid]')) {
    map.set(el.dataset.pid!, el.getBoundingClientRect());
  }
  return map;
}

/** Slides each chip from its old position to its new one (FLIP animation). */
export function playChipMoves(root: HTMLElement, before: Map<string, DOMRect>): void {
  if (reducedMotion()) return;
  for (const el of root.querySelectorAll<HTMLElement>('.ladder [data-pid], .unpicked [data-pid]')) {
    const old = before.get(el.dataset.pid!);
    if (!old) continue;
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (Math.abs(dx) + Math.abs(dy) < 2) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 550,
      easing: 'cubic-bezier(.2,.8,.2,1)',
    });
  }
}

/** Plays the deal animation on cards, one after another. */
export function dealCards(cards: Iterable<Element>, startDelayMs = 0): void {
  if (reducedMotion()) return;
  let i = 0;
  for (const el of cards) {
    (el as HTMLElement).style.animationDelay = `${startDelayMs + i * 140}ms`;
    el.classList.add('deal');
    i++;
  }
}

/** Plays a short bounce on an element. */
export function pop(el: Element | null): void {
  if (!el || reducedMotion()) return;
  el.classList.remove('pop');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('pop');
}

const BURST_MS = 1_900;

/**
 * Shows new board cards large in the middle of the screen, flipping in with a shine, then fades out.
 * Used for the flop and the turn. It never catches clicks.
 */
export function boardBurst(host: HTMLElement, title: string, cardsHtml: string[]): void {
  if (reducedMotion()) return;
  const el = document.createElement('div');
  el.className = 'burst';
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="burst-title">${esc(title)}</div><div class="burst-cards">${cardsHtml
    .map((c, i) => `<div class="burst-slot" style="animation-delay:${200 + i * 180}ms">${c}</div>`)
    .join('')}</div>`;
  host.append(el);
  setTimeout(() => el.remove(), BURST_MS);
}

/** Plays a one-time effect class on the chips of the given players. */
export function flashChips(root: HTMLElement, ids: Iterable<string>, cls: string): void {
  if (reducedMotion()) return;
  for (const id of ids) {
    const el = root.querySelector(`.ladder [data-pid="${id}"]`);
    if (!el) continue;
    el.classList.remove(cls);
    void (el as HTMLElement).offsetWidth;
    el.classList.add(cls);
  }
}
