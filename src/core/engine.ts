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
  budgetPerHand: 100,
  winTarget: 3,
  loseTarget: 3,
  maxSwapSeconds: 180,
  maxIntroSeconds: 5,
  maxNameLength: 12,
} as const;

/** How persistence is paid for. */
export type PersistenceMode = 'budget' | 'free';

/** How players see announcements. */
export type NotifyStyle = 'fullscreen' | 'banner' | 'toast' | 'ticker';

/** Room settings that the host can change in the lobby. */
export interface Settings {
  persistenceMode: PersistenceMode;
  /** Length of the swap phase in seconds. 0 skips the swap phase. */
  swapSeconds: number;
  /** Pause before each timed phase starts, for the announcement. 0 starts the timer at once. */
  introSeconds: number;
  notifyStyle: NotifyStyle;
  sound: boolean;
  vibrate: boolean;
}

const NOTIFY_STYLES: readonly NotifyStyle[] = ['fullscreen', 'banner', 'toast', 'ticker'];

/** Game phase. Deal, resolve and reveal are instant and have no phase of their own. */
export type Phase = 'LOBBY' | 'PICK' | 'PERSIST' | 'SWAP' | 'SHOWDOWN' | 'MATCH_END';

/** A player seat. */
export interface Seat {
  id: PlayerId;
  name: string;
  connected: boolean;
}

/** A player's choice in the pick phase. */
export interface Pick {
  rank: number | null;
  locked: boolean;
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
  hole: [Card, Card];
  score: number;
  category: string;
}

/** Result of a hand. */
export interface Showdown {
  entries: Record<PlayerId, ShowdownEntry>;
  ranks: Record<PlayerId, number>;
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
  hole: Record<PlayerId, [Card, Card]>;
  fullBoard: Card[];
  board: Card[];
  budgets: Record<PlayerId, number>;
  picks: Record<PlayerId, Pick>;
  ranks: Record<PlayerId, number>;
  /** Final rank of each player at the end of each finished round in this hand. Index 0 is round 1. */
  history: Record<PlayerId, number[]>;
  /** Players in the current conflict, with their bids. Set only in PERSIST. */
  conflict: { participants: PlayerId[]; bids: Record<PlayerId, Bid> } | null;
  swap: { requests: SwapRequest[]; done: Record<PlayerId, boolean>; nextId: number } | null;
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
  | { type: 'next' };

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
    settings: { persistenceMode: 'budget', swapSeconds: 60, introSeconds: 3, notifyStyle: 'banner', sound: false, vibrate: false },
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
    budgets: {},
    picks: {},
    ranks: {},
    history: {},
    conflict: null,
    swap: null,
    showdown: null,
  };
}

/** Returns why a player cannot join, or null when the join is allowed. Known players can always rejoin. */
export function joinRejection(state: GameState, id: PlayerId): JoinRejection | null {
  if (state.seats.some((s) => s.id === id)) return null;
  if (state.phase !== 'LOBBY') return 'started';
  if (state.seats.length >= RULES.maxPlayers) return 'full';
  return null;
}

/** Returns true when the match has reached the win or loss target. */
export function isMatchOver(state: GameState): boolean {
  return state.score.wins >= RULES.winTarget || state.score.losses >= RULES.loseTarget;
}

/**
 * Returns the time when the host must send the next tick, or null when no timer is running.
 * The time includes the grace period.
 */
export function nextDeadline(state: GameState): number | null {
  const times: number[] = [];
  if (state.deadline != null && (state.phase === 'PICK' || state.phase === 'PERSIST' || state.phase === 'SWAP')) {
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
      return pick(s, a.id, a.rank);
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
    case 'next':
      return isHost && next(s, now, rng);
  }
}

function join(s: GameState, id: PlayerId, name: string): boolean {
  const seat = s.seats.find((x) => x.id === id);
  if (seat) {
    seat.connected = true;
    if (s.phase === 'LOBBY') seat.name = cleanName(name);
    return true;
  }
  if (joinRejection(s, id)) return false;
  s.seats.push({ id, name: cleanName(name), connected: true });
  return true;
}

function updateSettings(s: GameState, patch: Partial<Settings>): boolean {
  if (patch.persistenceMode === 'budget' || patch.persistenceMode === 'free') {
    s.settings.persistenceMode = patch.persistenceMode;
  }
  if (typeof patch.swapSeconds === 'number' && Number.isFinite(patch.swapSeconds)) {
    s.settings.swapSeconds = Math.min(RULES.maxSwapSeconds, Math.max(0, Math.round(patch.swapSeconds)));
  }
  if (typeof patch.introSeconds === 'number' && Number.isFinite(patch.introSeconds)) {
    s.settings.introSeconds = Math.min(RULES.maxIntroSeconds, Math.max(0, Math.round(patch.introSeconds)));
  }
  if (patch.notifyStyle && NOTIFY_STYLES.includes(patch.notifyStyle)) s.settings.notifyStyle = patch.notifyStyle;
  if (typeof patch.sound === 'boolean') s.settings.sound = patch.sound;
  if (typeof patch.vibrate === 'boolean') s.settings.vibrate = patch.vibrate;
  return true;
}

/** Starts the intro pause of a timed phase and returns the time when the phase timer starts. */
function startTimer(s: GameState, now: number): number {
  s.startsAt = now + s.settings.introSeconds * 1000;
  return s.startsAt;
}

function deal(s: GameState, now: number, rng: Rng): void {
  const deck = shuffle(newDeck(), rng);
  s.handNo += 1;
  s.hole = {};
  for (const seat of s.seats) s.hole[seat.id] = [deck.pop()!, deck.pop()!];
  s.fullBoard = deck.splice(-5);
  s.board = [];
  s.budgets = Object.fromEntries(s.seats.map((x) => [x.id, RULES.budgetPerHand]));
  s.ranks = {};
  s.history = {};
  s.showdown = null;
  s.round = 1;
  startPick(s, now);
}

function startPick(s: GameState, now: number): void {
  s.phase = 'PICK';
  s.picks = Object.fromEntries(s.seats.map((x) => [x.id, { rank: s.ranks[x.id] ?? null, locked: false }]));
  s.conflict = null;
  s.swap = null;
  s.deadline = startTimer(s, now) + RULES.pickMs;
}

function pick(s: GameState, id: PlayerId, rank: number): boolean {
  const p = s.picks[id];
  if (s.phase !== 'PICK' || !p || p.locked) return false;
  if (!Number.isInteger(rank) || rank < 1 || rank > s.seats.length) return false;
  p.rank = rank;
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

/** Records a bid and charges the budget. `value` is the slider position 0..1. */
function placeBid(s: GameState, id: PlayerId, value: number, now: number): Bid {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  if (s.settings.persistenceMode === 'free') return { amount: v, at: now };
  const amount = v * (s.budgets[id] ?? 0);
  s.budgets[id] = (s.budgets[id] ?? 0) - amount;
  return { amount, at: now };
}

function persist(s: GameState, id: PlayerId, value: number, now: number, rng: Rng): boolean {
  if (s.phase === 'PERSIST') {
    const c = s.conflict!;
    if (!c.participants.includes(id) || c.bids[id]) return false;
    c.bids[id] = placeBid(s, id, value, now);
    if (c.participants.every((p) => c.bids[p])) finishPersist(s, now, rng);
    return true;
  }
  if (s.phase === 'SWAP') {
    const r = s.swap!.requests.find((x) => x.status === 'challenge' && (x.from === id || x.to === id));
    if (!r || r.bids[id]) return false;
    r.bids[id] = placeBid(s, id, value, now);
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

/** Moves a pending request to deciding (budget mode) or declined (free mode). */
function decline(s: GameState, r: SwapRequest, now: number): void {
  if (s.settings.persistenceMode === 'budget') {
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

function exchange(s: GameState, r: SwapRequest): void {
  const a = s.ranks[r.from]!;
  s.ranks[r.from] = s.ranks[r.to]!;
  s.ranks[r.to] = a;
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
  if (s.round < 4) {
    s.round += 1;
    s.board = s.fullBoard.slice(0, s.round + 1);
    startPick(s, now);
    return;
  }
  showdown(s);
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
  const success = isCorrectOrder(s.ranks, strengths);
  if (success) s.score.wins += 1;
  else s.score.losses += 1;
  s.showdown = { entries, ranks: { ...s.ranks }, success };
  s.phase = 'SHOWDOWN';
  s.deadline = null;
  s.startsAt = null;
}

function next(s: GameState, now: number, rng: Rng): boolean {
  if (s.phase === 'SHOWDOWN') {
    if (isMatchOver(s)) s.phase = 'MATCH_END';
    else deal(s, now, rng);
    return true;
  }
  if (s.phase === 'MATCH_END') {
    const fresh = createGame(s.hostId, '');
    fresh.settings = s.settings;
    fresh.seats = s.seats.filter((x) => x.connected);
    Object.assign(s, fresh);
    return true;
  }
  return false;
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
  }
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
  showdown: Showdown | null;
  matchOver: boolean;
}

/** State that only 1 player can see. */
export interface PrivateState {
  hole: [Card, Card] | null;
  /** Remaining budget as a ratio 0..1, or null in free mode. The UI shows it as a bar only. */
  budget: number | null;
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
    showdown: s.showdown && structuredClone(s.showdown),
    matchOver: isMatchOver(s),
  };
}

/** Returns the state that only the given player can see. */
export function privateView(s: GameState, id: PlayerId): PrivateState {
  const hole = s.phase === 'LOBBY' ? null : (s.hole[id] ?? null);
  const budget =
    s.settings.persistenceMode === 'budget' && s.budgets[id] != null ? s.budgets[id]! / RULES.budgetPerHand : null;
  return { hole: hole && [hole[0], hole[1]], budget };
}
