import { type Card, type Rng, newDeck, shuffle } from './cards';
import { CATEGORY_NAMES, categoryOf, evaluateBest } from './evaluator';
import { type Bid, type PlayerId, assignRanks, compareBids, findConflicts, isCorrectOrder } from './resolve';

export type { PlayerId } from './resolve';

/** Fixed game rules (spec 4). Times are in milliseconds. */
export const RULES = {
  minPlayers: 3,
  maxPlayers: 13,
  pickMs: 20_000,
  persistMs: 10_000,
  respondMs: 10_000,
  challengeDecideMs: 5_000,
  /** Actions that arrive up to this long after a deadline still count (spec 9). */
  graceMs: 300,
  maxSwapSeconds: 180,
  /** Length of the final challenge vote. */
  guessMs: 30_000,
  maxIntroSeconds: 5,
  /** Extra intro time when cards are dealt or revealed (every round), for the big reveal effect. Only when the intro is on. */
  boardRevealMs: 2_000,
  maxNameLength: 12,
  /** Minimum time between 2 counted clicks on the own current rank. The host drops faster clicks. */
  hypeMs: 150,
} as const;

/** Which end of the ranks is locked in the swap phase: none, the smallest ranks, or the largest ranks. */
export type LockEnd = 'none' | 'low' | 'high';

const LOCK_ENDS: readonly LockEnd[] = ['none', 'low', 'high'];

/**
 * Returns the locked ranks for n players: ceil(n / 4) ranks at the chosen end.
 * Holders of these ranks cannot send or receive swap requests.
 */
export function lockedRanks(n: number, lockEnd: LockEnd): number[] {
  const k = Math.ceil(n / 4);
  if (lockEnd === 'low') return Array.from({ length: k }, (_, i) => i + 1);
  if (lockEnd === 'high') return Array.from({ length: k }, (_, i) => n - k + 1 + i);
  return [];
}

/** How players see announcements. */
export type NotifyStyle = 'fullscreen' | 'banner' | 'toast' | 'ticker';

/** Room settings that the host can change in the lobby. */
export interface Settings {
  /** True when a requester may challenge a declined swap request with persistence. */
  challenge: boolean;
  /** Length of the swap phase in seconds. 0 skips the swap phase. */
  swapSeconds: number;
  /** Pause before each timed phase starts, for the announcement. 0 starts the timer at once. */
  introSeconds: number;
  notifyStyle: NotifyStyle;
  /** Hole cards per player: 2 or 3. Strength is the best 5 of all hole and board cards. */
  holeCards: number;
  /** Round (1..3) that every hand skips; its cards come with the next round. 0 skips nothing. */
  skipRound: number;
  /** Ranks at this end are locked in every swap phase. */
  lockEnd: LockEnd;
  /**
   * True adds the final challenge before the showdown: the other players vote on the hand category
   * of the player with the largest rank. A wrong guess fails the hand.
   */
  finalGuess: boolean;
}

/** Returns the rounds (1..4) that a hand plays with the given settings, in order. */
export function playedRounds(settings: { skipRound: number }): number[] {
  return [1, 2, 3, 4].filter((r) => r !== settings.skipRound);
}

/** Returns the number of board cards that show in a round: 0, 3, 4 or 5. */
export function boardSize(round: number): number {
  return round <= 1 ? 0 : round + 1;
}

const NOTIFY_STYLES: readonly NotifyStyle[] = ['fullscreen', 'banner', 'toast', 'ticker'];

/** Game phase. Deal, resolve and reveal are instant and have no phase of their own. */
export type Phase = 'LOBBY' | 'PICK' | 'PERSIST' | 'SWAP' | 'GUESS' | 'SHOWDOWN';

/** A player seat. */
export interface Seat {
  id: PlayerId;
  name: string;
  connected: boolean;
  /** True for a computer player. The host browser plays it with public and own private data only. */
  bot?: boolean;
}

/** Prefix of computer player IDs. */
export const BOT_ID_PREFIX = 'bot-';

/** A player's choice in the pick phase. */
export interface Pick {
  rank: number | null;
  locked: boolean;
  /** Clicks on the same rank again in this round. Other players see it as excitement. A new rank resets it. */
  hype: number;
  /** Host time of the last counted hype click. */
  hypeAt: number;
}

/**
 * Swap request status.
 * Active: pending (target decides), deciding (requester may challenge), challenge (both bid).
 * Final: accepted, declined, won (requester won the challenge), lost, expired.
 */
export type SwapStatus = 'pending' | 'deciding' | 'challenge' | 'accepted' | 'declined' | 'won' | 'lost' | 'expired';

/** A swap request between 2 players. */
export interface SwapRequest {
  id: number;
  from: PlayerId;
  to: PlayerId;
  status: SwapStatus;
  /** Deadline of the current status, or null for final statuses. */
  deadline: number | null;
  bids: Record<PlayerId, Bid>;
}

/** Hand result of 1 player at showdown. */
export interface ShowdownEntry {
  hole: Card[];
  score: number;
  category: string;
}

/** The final challenge vote: the other players guess the hand category (index in CATEGORY_NAMES) of `target`. */
export interface Guess {
  target: PlayerId;
  votes: Record<PlayerId, number>;
}

/** Result of the final challenge. */
export interface GuessResult extends Guess {
  /** The category with the most votes, or null when no vote came in or the top votes tie. */
  answer: number | null;
  /** The real category of the target. */
  actual: number;
  correct: boolean;
}

/** Result of a hand. */
export interface Showdown {
  entries: Record<PlayerId, ShowdownEntry>;
  ranks: Record<PlayerId, number>;
  /** True when the rank order is correct. */
  orderOk: boolean;
  /** The final challenge result, or null when the final challenge is off. */
  guess: GuessResult | null;
  /** True when the order is correct and, with the final challenge on, the guess is correct. */
  success: boolean;
}

/** Full game state. Only the host holds it. Use {@link publicView} and {@link privateView} to share it. */
export interface GameState {
  phase: Phase;
  settings: Settings;
  hostId: PlayerId;
  seats: Seat[];
  handNo: number;
  round: number;
  score: { wins: number; losses: number };
  /** Phase deadline for PICK and PERSIST; swap end time for SWAP; otherwise null. */
  deadline: number | null;
  /** End of the intro pause of the current timed phase. Player actions wait until then. */
  startsAt: number | null;
  hole: Record<PlayerId, Card[]>;
  fullBoard: Card[];
  board: Card[];
  picks: Record<PlayerId, Pick>;
  ranks: Record<PlayerId, number>;
  /** Final rank of each player at the end of each finished round in this hand. Index 0 is round 1. */
  history: Record<PlayerId, number[]>;
  /** Players in the current conflict, with their bids. Set only in PERSIST. */
  conflict: { participants: PlayerId[]; bids: Record<PlayerId, Bid> } | null;
  swap: { requests: SwapRequest[]; done: Record<PlayerId, boolean>; nextId: number } | null;
  /** The final challenge vote. Set only in GUESS. */
  guess: Guess | null;
  showdown: Showdown | null;
}

/** An action sent by a player. The host fills in `id` from the connection, never from the message. */
export type PlayerAction =
  | { type: 'join'; name: string }
  | { type: 'leave' }
  | { type: 'settings'; settings: Partial<Settings> }
  | { type: 'start' }
  | { type: 'pick'; rank: number }
  | { type: 'lock' }
  | { type: 'unlock' }
  | { type: 'persist'; value: number }
  | { type: 'swapRequest'; targetId: PlayerId }
  | { type: 'swapRespond'; requestId: number; accept: boolean }
  | { type: 'swapChallenge'; requestId: number }
  | { type: 'swapDone'; done: boolean }
  /** In GUESS, every player except the target: votes for a hand category (0..8). A new vote replaces the old one. */
  | { type: 'guessVote'; category: number }
  /** Host only, in the showdown: deals the next hand. */
  | { type: 'next' }
  /** Host only, in the showdown: sends all players back to the lobby. */
  | { type: 'lobby' }
  /** Host only, in the lobby: adds a computer player. */
  | { type: 'addBot' }
  /** Host only, in the lobby: removes a computer player. */
  | { type: 'removeBot'; targetId: PlayerId };

/** An action for the reducer: a player action with its sender, or a timer tick. */
export type Action = (PlayerAction & { id: PlayerId }) | { type: 'tick' };

/** Reason why a player cannot join. */
export type JoinRejection = 'full' | 'started';

const ACTIVE: ReadonlySet<SwapStatus> = new Set(['pending', 'deciding', 'challenge']);

/** Actions that wait for the intro pause to end. */
const TIMED_ACTIONS: ReadonlySet<string> = new Set([
  'pick',
  'lock',
  'unlock',
  'persist',
  'swapRequest',
  'swapRespond',
  'swapChallenge',
  'swapDone',
  'guessVote',
]);

/** Returns a cleaned player name: no control characters, trimmed, at most 12 characters. */
export function cleanName(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return [...s].slice(0, RULES.maxNameLength).join('') || '玩家';
}

/** Creates a new room state in the lobby with the host seated. */
export function createGame(hostId: PlayerId, hostName: string): GameState {
  return {
    phase: 'LOBBY',
    settings: { challenge: true, swapSeconds: 60, introSeconds: 3, notifyStyle: 'banner', holeCards: 2, skipRound: 0, lockEnd: 'none', finalGuess: false },
    hostId,
    seats: [{ id: hostId, name: cleanName(hostName), connected: true }],
    handNo: 0,
    round: 0,
    score: { wins: 0, losses: 0 },
    deadline: null,
    startsAt: null,
    hole: {},
    fullBoard: [],
    board: [],
    picks: {},
    ranks: {},
    history: {},
    conflict: null,
    swap: null,
    guess: null,
    showdown: null,
  };
}

/** Returns why a player cannot join, or null when the join is allowed. Known players can always rejoin. */
export function joinRejection(state: GameState, id: PlayerId): JoinRejection | null {
  // Nobody can take over a computer seat by sending its ID.
  if (id.startsWith(BOT_ID_PREFIX)) return 'full';
  if (state.seats.some((s) => s.id === id)) return null;
  if (state.phase !== 'LOBBY') return 'started';
  if (state.seats.length >= RULES.maxPlayers) return 'full';
  return null;
}

/**
 * Returns the time when the host must send the next tick, or null when no timer is running.
 * The time includes the grace period.
 */
export function nextDeadline(state: GameState): number | null {
  const times: number[] = [];
  if (state.deadline != null && (state.phase === 'PICK' || state.phase === 'PERSIST' || state.phase === 'SWAP' || state.phase === 'GUESS')) {
    times.push(state.deadline);
  }
  for (const r of state.swap?.requests ?? []) if (r.deadline != null) times.push(r.deadline);
  return times.length ? Math.min(...times) + RULES.graceMs : null;
}

/**
 * Applies an action and returns the new state.
 * Returns the same object when the action is not valid, so callers can skip the broadcast.
 */
export function reduce(state: GameState, action: Action, now: number, rng: Rng): GameState {
  const s = structuredClone(state);
  const ok = apply(s, action, now, rng);
  return ok ? s : state;
}

function apply(s: GameState, a: Action, now: number, rng: Rng): boolean {
  if (a.type === 'tick') return tick(s, now, rng);
  const seat = s.seats.find((x) => x.id === a.id);
  if (a.type === 'join') return join(s, a.id, a.name);
  if (!seat) return false;
  const isHost = a.id === s.hostId;
  if (TIMED_ACTIONS.has(a.type) && s.startsAt != null && now < s.startsAt) return false;

  switch (a.type) {
    case 'leave':
      if (s.phase === 'LOBBY' && !isHost) s.seats = s.seats.filter((x) => x.id !== a.id);
      else seat.connected = false;
      return true;
    case 'settings':
      return isHost && s.phase === 'LOBBY' && updateSettings(s, a.settings);
    case 'start':
      if (!isHost || s.phase !== 'LOBBY' || s.seats.length < RULES.minPlayers) return false;
      s.score = { wins: 0, losses: 0 };
      s.handNo = 0;
      deal(s, now, rng);
      return true;
    case 'pick':
      return pick(s, a.id, a.rank, now);
    case 'lock':
      return lock(s, a.id, now, rng);
    case 'unlock':
      return unlock(s, a.id);
    case 'persist':
      return persist(s, a.id, a.value, now, rng);
    case 'swapRequest':
      return swapRequest(s, a.id, a.targetId, now);
    case 'swapRespond':
      return swapRespond(s, a.id, a.requestId, a.accept, now);
    case 'swapChallenge':
      return swapChallenge(s, a.id, a.requestId, now);
    case 'swapDone':
      if (s.phase !== 'SWAP' || !s.swap) return false;
      s.swap.done[a.id] = Boolean(a.done);
      checkSwapEnd(s, now);
      return true;
    case 'guessVote':
      return guessVote(s, a.id, a.category);
    case 'addBot':
      return isHost && s.phase === 'LOBBY' && addBot(s);
    case 'removeBot': {
      if (!isHost || s.phase !== 'LOBBY') return false;
      const before = s.seats.length;
      s.seats = s.seats.filter((x) => !(x.bot && x.id === a.targetId));
      return s.seats.length !== before;
    }
    case 'next':
      if (!isHost || s.phase !== 'SHOWDOWN') return false;
      deal(s, now, rng);
      return true;
    case 'lobby':
      return isHost && backToLobby(s);
  }
}

function join(s: GameState, id: PlayerId, name: string): boolean {
  const seat = s.seats.find((x) => x.id === id);
  if (seat?.bot) return false;
  if (seat) {
    seat.connected = true;
    if (s.phase === 'LOBBY') seat.name = cleanName(name);
    return true;
  }
  if (joinRejection(s, id)) return false;
  s.seats.push({ id, name: cleanName(name), connected: true });
  return true;
}

/** Adds a computer player with the smallest free number, for example "電腦 1". */
function addBot(s: GameState): boolean {
  if (s.seats.length >= RULES.maxPlayers) return false;
  let n = 1;
  while (s.seats.some((x) => x.id === `${BOT_ID_PREFIX}${n}`)) n++;
  s.seats.push({ id: `${BOT_ID_PREFIX}${n}`, name: `電腦 ${n}`, connected: true, bot: true });
  return true;
}

function updateSettings(s: GameState, patch: Partial<Settings>): boolean {
  if (typeof patch.challenge === 'boolean') s.settings.challenge = patch.challenge;
  if (typeof patch.swapSeconds === 'number' && Number.isFinite(patch.swapSeconds)) {
    s.settings.swapSeconds = Math.min(RULES.maxSwapSeconds, Math.max(0, Math.round(patch.swapSeconds)));
  }
  if (typeof patch.introSeconds === 'number' && Number.isFinite(patch.introSeconds)) {
    s.settings.introSeconds = Math.min(RULES.maxIntroSeconds, Math.max(0, Math.round(patch.introSeconds)));
  }
  if (patch.notifyStyle && NOTIFY_STYLES.includes(patch.notifyStyle)) s.settings.notifyStyle = patch.notifyStyle;
  if (patch.holeCards === 2 || patch.holeCards === 3) s.settings.holeCards = patch.holeCards;
  if (patch.skipRound === 0 || patch.skipRound === 1 || patch.skipRound === 2 || patch.skipRound === 3) s.settings.skipRound = patch.skipRound;
  if (patch.lockEnd && LOCK_ENDS.includes(patch.lockEnd)) s.settings.lockEnd = patch.lockEnd;
  if (typeof patch.finalGuess === 'boolean') s.settings.finalGuess = patch.finalGuess;
  return true;
}

/** Starts the intro pause of a timed phase and returns the time when the phase timer starts. */
function startTimer(s: GameState, now: number, revealMs = 0): number {
  const intro = s.settings.introSeconds * 1000;
  s.startsAt = now + (intro > 0 ? intro + revealMs : 0);
  return s.startsAt;
}

function deal(s: GameState, now: number, rng: Rng): void {
  const deck = shuffle(newDeck(), rng);
  s.handNo += 1;
  s.hole = {};
  // 13 players x 3 hole cards + 5 board cards = 44, so the deck is always large enough.
  for (const seat of s.seats) s.hole[seat.id] = deck.splice(-s.settings.holeCards);
  s.fullBoard = deck.splice(-5);
  s.ranks = {};
  s.history = {};
  s.guess = null;
  s.showdown = null;
  s.round = playedRounds(s.settings)[0]!;
  s.board = s.fullBoard.slice(0, boardSize(s.round));
  startPick(s, now);
}

function startPick(s: GameState, now: number): void {
  s.phase = 'PICK';
  s.picks = Object.fromEntries(s.seats.map((x) => [x.id, { rank: s.ranks[x.id] ?? null, locked: false, hype: 0, hypeAt: 0 }]));
  s.conflict = null;
  s.swap = null;
  // Every round deals or reveals cards (hole cards, flop, turn, river): give the big reveal its own time.
  s.deadline = startTimer(s, now, RULES.boardRevealMs) + RULES.pickMs;
}

/** Sets the pick. A click on the current rank again counts as hype, at most once per {@link RULES.hypeMs}. */
function pick(s: GameState, id: PlayerId, rank: number, now: number): boolean {
  const p = s.picks[id];
  if (s.phase !== 'PICK' || !p || p.locked) return false;
  if (!Number.isInteger(rank) || rank < 1 || rank > s.seats.length) return false;
  if (p.rank === rank) {
    if (now - p.hypeAt < RULES.hypeMs) return false;
    p.hype += 1;
    p.hypeAt = now;
    return true;
  }
  p.rank = rank;
  p.hype = 0;
  return true;
}

function lock(s: GameState, id: PlayerId, now: number, rng: Rng): boolean {
  const p = s.picks[id];
  if (s.phase !== 'PICK' || !p || p.locked || p.rank == null) return false;
  p.locked = true;
  if (Object.values(s.picks).every((x) => x.locked)) finishPick(s, now, rng);
  return true;
}

/** Unlocks a pick. Possible only while the pick phase runs, which means at least 1 player has not locked. */
function unlock(s: GameState, id: PlayerId): boolean {
  const p = s.picks[id];
  if (s.phase !== 'PICK' || !p || !p.locked) return false;
  p.locked = false;
  return true;
}

function finishPick(s: GameState, now: number, rng: Rng): void {
  for (const p of Object.values(s.picks)) p.locked = p.rank != null;
  const order = s.seats.map((x) => x.id);
  const participants = findConflicts(order, pickedRanks(s));
  if (participants.length === 0) {
    applyRanks(s, assignRanks(order, pickedRanks(s), {}, rng), now);
    return;
  }
  s.phase = 'PERSIST';
  s.conflict = { participants, bids: {} };
  s.deadline = startTimer(s, now) + RULES.persistMs;
}

function pickedRanks(s: GameState): Record<PlayerId, number | null> {
  return Object.fromEntries(Object.entries(s.picks).map(([id, p]) => [id, p.rank]));
}

/** Records a bid. `value` is the slider position 0..1. A bid costs nothing. */
function placeBid(value: number, now: number): Bid {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return { amount: v, at: now };
}

function persist(s: GameState, id: PlayerId, value: number, now: number, rng: Rng): boolean {
  if (s.phase === 'PERSIST') {
    const c = s.conflict!;
    if (!c.participants.includes(id) || c.bids[id]) return false;
    c.bids[id] = placeBid(value, now);
    if (c.participants.every((p) => c.bids[p])) finishPersist(s, now, rng);
    return true;
  }
  if (s.phase === 'SWAP') {
    const r = s.swap!.requests.find((x) => x.status === 'challenge' && (x.from === id || x.to === id));
    if (!r || r.bids[id]) return false;
    r.bids[id] = placeBid(value, now);
    if (r.bids[r.from] && r.bids[r.to]) {
      finishChallenge(s, r, now);
      checkSwapEnd(s, now);
    }
    return true;
  }
  return false;
}

function finishPersist(s: GameState, now: number, rng: Rng): void {
  const c = s.conflict!;
  const at = s.deadline ?? now;
  for (const id of c.participants) c.bids[id] ??= { amount: 0, at };
  const order = s.seats.map((x) => x.id);
  applyRanks(s, assignRanks(order, pickedRanks(s), c.bids, rng), now);
}

function applyRanks(s: GameState, ranks: Record<PlayerId, number>, now: number): void {
  s.ranks = ranks;
  s.conflict = null;
  if (s.settings.swapSeconds <= 0) {
    advanceRound(s, now);
    return;
  }
  s.phase = 'SWAP';
  s.swap = { requests: [], done: {}, nextId: 1 };
  s.deadline = startTimer(s, now) + s.settings.swapSeconds * 1000;
}

function isBusy(s: GameState, id: PlayerId): boolean {
  return s.swap!.requests.some((r) => ACTIVE.has(r.status) && (r.from === id || r.to === id));
}

function swapRequest(s: GameState, id: PlayerId, targetId: PlayerId, now: number): boolean {
  if (s.phase !== 'SWAP' || !s.swap || now >= s.deadline!) return false;
  if (id === targetId || !s.seats.some((x) => x.id === targetId)) return false;
  if (isBusy(s, id) || isBusy(s, targetId)) return false;
  const locked = lockedRanks(s.seats.length, s.settings.lockEnd);
  if (locked.includes(s.ranks[id]!) || locked.includes(s.ranks[targetId]!)) return false;
  const samePair = (r: SwapRequest) => (r.from === id && r.to === targetId) || (r.from === targetId && r.to === id);
  if (s.swap.requests.some(samePair)) return false;
  s.swap.requests.push({ id: s.swap.nextId++, from: id, to: targetId, status: 'pending', deadline: now + RULES.respondMs, bids: {} });
  return true;
}

function findRequest(s: GameState, requestId: number): SwapRequest | undefined {
  return s.phase === 'SWAP' ? s.swap?.requests.find((r) => r.id === requestId) : undefined;
}

function swapRespond(s: GameState, id: PlayerId, requestId: number, accept: boolean, now: number): boolean {
  const r = findRequest(s, requestId);
  if (!r || r.status !== 'pending' || r.to !== id) return false;
  if (accept) {
    exchange(s, r);
    r.status = 'accepted';
    r.deadline = null;
  } else {
    decline(s, r, now);
  }
  checkSwapEnd(s, now);
  return true;
}

/** Moves a pending request to deciding (challenge on) or declined (challenge off). */
function decline(s: GameState, r: SwapRequest, now: number): void {
  if (s.settings.challenge) {
    r.status = 'deciding';
    r.deadline = now + RULES.challengeDecideMs;
  } else {
    r.status = 'declined';
    r.deadline = null;
  }
}

function swapChallenge(s: GameState, id: PlayerId, requestId: number, now: number): boolean {
  const r = findRequest(s, requestId);
  if (!r || r.status !== 'deciding' || r.from !== id) return false;
  r.status = 'challenge';
  r.deadline = now + RULES.persistMs;
  return true;
}

function finishChallenge(s: GameState, r: SwapRequest, now: number): void {
  const at = r.deadline ?? now;
  r.bids[r.from] ??= { amount: 0, at };
  r.bids[r.to] ??= { amount: 0, at };
  // The requester wins only when the bid is stronger. Seat order does not help the requester.
  const fromWins = compareBids(r.bids[r.from]!, r.bids[r.to]!, 0, 0) < 0;
  if (fromWins) exchange(s, r);
  r.status = fromWins ? 'won' : 'lost';
  r.deadline = null;
}

/**
 * Moves the requester to the target rank. Players between the 2 ranks, the target included,
 * shift 1 rank toward the requester's old rank. Example: B at 2 takes 5, so 3..5 become 2..4.
 */
function exchange(s: GameState, r: SwapRequest): void {
  const from = s.ranks[r.from]!;
  const to = s.ranks[r.to]!;
  const step = from < to ? -1 : 1;
  for (const id of Object.keys(s.ranks)) {
    const x = s.ranks[id]!;
    if (id !== r.from && x >= Math.min(from, to) && x <= Math.max(from, to)) s.ranks[id] = x + step;
  }
  s.ranks[r.from] = to;
}

function checkSwapEnd(s: GameState, now: number): void {
  if (s.phase !== 'SWAP' || !s.swap) return;
  const timeUp = now >= s.deadline! + RULES.graceMs;
  if (timeUp) {
    for (const r of s.swap.requests) {
      if (r.status === 'pending' || r.status === 'deciding') {
        r.status = 'expired';
        r.deadline = null;
      }
    }
  }
  const connected = s.seats.filter((x) => x.connected);
  const allDone = connected.length > 0 && connected.every((x) => s.swap!.done[x.id]);
  const active = s.swap.requests.some((r) => ACTIVE.has(r.status));
  if ((timeUp || allDone) && !active) advanceRound(s, now);
}

function advanceRound(s: GameState, now: number): void {
  s.swap = null;
  for (const seat of s.seats) (s.history[seat.id] ??= []).push(s.ranks[seat.id]!);
  const next = playedRounds(s.settings).find((r) => r > s.round);
  if (next != null) {
    s.round = next;
    s.board = s.fullBoard.slice(0, boardSize(s.round));
    startPick(s, now);
    return;
  }
  if (s.settings.finalGuess) startGuess(s, now);
  else showdown(s);
}

/** Starts the final challenge vote on the hand category of the player with the largest rank. */
function startGuess(s: GameState, now: number): void {
  const n = s.seats.length;
  s.phase = 'GUESS';
  s.guess = { target: s.seats.find((x) => s.ranks[x.id] === n)!.id, votes: {} };
  s.deadline = startTimer(s, now) + RULES.guessMs;
}

function guessVote(s: GameState, id: PlayerId, category: number): boolean {
  const g = s.guess;
  if (s.phase !== 'GUESS' || !g || id === g.target) return false;
  if (!Number.isInteger(category) || category < 0 || category >= CATEGORY_NAMES.length) return false;
  g.votes[id] = category;
  const voters = s.seats.filter((x) => x.connected && x.id !== g.target);
  if (voters.every((x) => g.votes[x.id] != null)) showdown(s);
  return true;
}

/** Returns the category with the most votes, or null when there is no vote or the top votes tie. */
function tally(votes: Record<PlayerId, number>): number | null {
  const count = new Map<number, number>();
  for (const c of Object.values(votes)) count.set(c, (count.get(c) ?? 0) + 1);
  const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0 || (sorted.length > 1 && sorted[0]![1] === sorted[1]![1])) return null;
  return sorted[0]![0];
}

function showdown(s: GameState): void {
  s.board = s.fullBoard.slice();
  const entries: Record<PlayerId, ShowdownEntry> = {};
  for (const seat of s.seats) {
    const hole = s.hole[seat.id]!;
    const score = evaluateBest([...hole, ...s.board]);
    entries[seat.id] = { hole, score, category: CATEGORY_NAMES[categoryOf(score)]! };
  }
  const strengths = Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, e.score]));
  const orderOk = isCorrectOrder(s.ranks, strengths);
  let guess: GuessResult | null = null;
  if (s.guess) {
    const answer = tally(s.guess.votes);
    const actual = categoryOf(entries[s.guess.target]!.score);
    guess = { ...s.guess, answer, actual, correct: answer === actual };
  }
  const success = orderOk && (guess?.correct ?? true);
  if (success) s.score.wins += 1;
  else s.score.losses += 1;
  s.showdown = { entries, ranks: { ...s.ranks }, orderOk, guess, success };
  s.guess = null;
  s.phase = 'SHOWDOWN';
  s.deadline = null;
  s.startsAt = null;
}

/** Moves all connected players back to the lobby. Settings stay; the score resets when the host starts again. */
function backToLobby(s: GameState): boolean {
  if (s.phase !== 'SHOWDOWN') return false;
  const fresh = createGame(s.hostId, '');
  fresh.settings = s.settings;
  fresh.seats = s.seats.filter((x) => x.connected);
  fresh.score = s.score;
  Object.assign(s, fresh);
  return true;
}

function tick(s: GameState, now: number, rng: Rng): boolean {
  const expired = (d: number | null) => d != null && now >= d + RULES.graceMs;
  const before = JSON.stringify(s);
  if (s.phase === 'PICK' && expired(s.deadline)) finishPick(s, now, rng);
  else if (s.phase === 'PERSIST' && expired(s.deadline)) finishPersist(s, now, rng);
  else if (s.phase === 'SWAP' && s.swap) {
    for (const r of s.swap.requests) {
      if (!expired(r.deadline)) continue;
      if (r.status === 'pending') decline(s, r, now);
      else if (r.status === 'deciding') {
        r.status = 'declined';
        r.deadline = null;
      } else if (r.status === 'challenge') finishChallenge(s, r, now);
    }
    checkSwapEnd(s, now);
  } else if (s.phase === 'GUESS' && expired(s.deadline)) showdown(s);
  return JSON.stringify(s) !== before;
}

// ---------------------------------------------------------------------------
// Views shared over the network
// ---------------------------------------------------------------------------

/** Swap request as other players see it. Bid amounts are hidden. */
export interface PublicSwapRequest {
  id: number;
  from: PlayerId;
  to: PlayerId;
  status: SwapStatus;
  deadline: number | null;
  submitted: PlayerId[];
}

/** State that every player can see. Contains no hole cards before showdown and no bid amounts. */
export interface PublicState {
  phase: Phase;
  settings: Settings;
  hostId: PlayerId;
  seats: Seat[];
  handNo: number;
  round: number;
  score: { wins: number; losses: number };
  deadline: number | null;
  startsAt: number | null;
  board: Card[];
  picks: Record<PlayerId, Pick>;
  ranks: Record<PlayerId, number>;
  /** Final rank of each player per finished round in this hand. */
  history: Record<PlayerId, number[]>;
  conflict: { participants: PlayerId[]; submitted: PlayerId[] } | null;
  swap: { requests: PublicSwapRequest[]; done: Record<PlayerId, boolean> } | null;
  /** The final challenge vote. Votes are public, so players can agree on 1 answer. */
  guess: Guess | null;
  showdown: Showdown | null;
}

/** State that only 1 player can see. */
export interface PrivateState {
  hole: Card[] | null;
}

/** Returns the state that every player can see. */
export function publicView(s: GameState): PublicState {
  return {
    phase: s.phase,
    settings: { ...s.settings },
    hostId: s.hostId,
    seats: s.seats.map((x) => ({ ...x })),
    handNo: s.handNo,
    round: s.round,
    score: { ...s.score },
    deadline: s.deadline,
    startsAt: s.startsAt,
    board: s.board.slice(),
    picks: structuredClone(s.picks),
    ranks: { ...s.ranks },
    history: structuredClone(s.history),
    conflict: s.conflict && { participants: s.conflict.participants.slice(), submitted: Object.keys(s.conflict.bids) },
    swap: s.swap && {
      done: { ...s.swap.done },
      requests: s.swap.requests.map((r) => ({
        id: r.id,
        from: r.from,
        to: r.to,
        status: r.status,
        deadline: r.deadline,
        submitted: Object.keys(r.bids),
      })),
    },
    guess: s.guess && structuredClone(s.guess),
    showdown: s.showdown && structuredClone(s.showdown),
  };
}

/** Returns the state that only the given player can see. */
export function privateView(s: GameState, id: PlayerId): PrivateState {
  const hole = s.phase === 'LOBBY' ? null : (s.hole[id] ?? null);
  return { hole: hole && hole.slice() };
}
