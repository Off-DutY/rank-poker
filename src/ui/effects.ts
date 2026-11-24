import type { Announcement } from './events';
import { esc } from './render';

/** True when the user asks the system for less motion. Announcements still show, without animation. */
export const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

const BASE_MS = 1_300;
const PER_LINE_MS = 450;
const MAX_MS = 4_000;
/** Maximum waiting announcements. Older ones are dropped, so the banner never shows stale news. */
const MAX_WAITING = 2;

/**
 * Shows announcements one after another in a banner, and keeps the latest one in the ticker line.
 * The banner does not catch clicks, so it never blocks the game.
 */
export function createAnnouncer(banner: HTMLElement, ticker: HTMLElement): { push(items: Announcement[]): void } {
  const queue: Announcement[] = [];
  let busy = false;

  const pump = () => {
    if (busy) return;
    const a = queue.shift();
    if (!a) return;
    busy = true;
    const lines = a.lines.map((l) => `<li>${esc(l)}</li>`).join('');
    banner.innerHTML = `<div class="announce-card ${a.kind}"><b>${esc(a.title)}</b>${lines ? `<ul>${lines}</ul>` : ''}</div>`;
    banner.classList.remove('show');
    void banner.offsetWidth; // Restart the CSS animation.
    banner.classList.add('show');
    const full = Math.min(MAX_MS, BASE_MS + PER_LINE_MS * a.lines.length);
    // Show the banner for a shorter time when more news waits.
    const ms = queue.length > 0 ? full / 2 : full;
    setTimeout(() => {
      banner.classList.remove('show');
      setTimeout(() => {
        busy = false;
        pump();
      }, 200);
    }, ms);
  };

  return {
    push(items) {
      const latest = items.at(-1);
      if (!latest) return;
      // The ticker always shows the newest event at once, even when the banner is busy.
      ticker.innerHTML = `<span class="tick-kind ${latest.kind}"></span>${esc([latest.title, latest.lines[0]].filter(Boolean).join('：'))}`;
      ticker.classList.remove('flash');
      void ticker.offsetWidth;
      ticker.classList.add('flash');
      queue.push(...items);
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
