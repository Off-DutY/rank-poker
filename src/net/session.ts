import { botAction, estimateRank } from '../core/bot';
import type { Rng } from '../core/cards';
import {
  type GameState,
  type PlayerAction,
  type PlayerId,
  type PrivateState,
  type PublicState,
  createGame,
  joinRejection,
  nextDeadline,
  privateView,
  publicView,
  reduce,
} from '../core/engine';
import { type ClientMsg, type HostMsg, PROTOCOL_VERSION, parseClientMsg, parseHostMsg } from './protocol';
import type { Clock, Transport } from './transport';

/** A computer player waits at least this long before each action, like a person who thinks. */
const BOT_MIN_MS = 1_200;
/** Random extra wait on top of {@link BOT_MIN_MS}. */
const BOT_SPREAD_MS = 2_500;

/** Connection status of a session. */
export type SessionStatus = 'connecting' | 'joined' | 'rejected' | 'closed';

/** What the UI sees: the same interface for the host and for other players. */
export interface Session {
  readonly me: PlayerId;
  readonly isHost: boolean;
  readonly status: SessionStatus;
  /** Reason for 'rejected' status. */
  readonly reason: string | null;
  readonly view: { pub: PublicState; priv: PrivateState } | null;
  /** Current time on the host clock. Use it for countdowns. */
  hostNow(): number;
  act(a: Exclude<PlayerAction, { type: 'join' }>): void;
  /** Calls `cb` after every change. Returns an unsubscribe function. */
  subscribe(cb: () => void): () => void;
  close(): void;
}

abstract class BaseSession {
  status: SessionStatus = 'connecting';
  reason: string | null = null;
  view: { pub: PublicState; priv: PrivateState } | null = null;
  private listeners = new Set<() => void>();

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  protected emit(): void {
    for (const cb of this.listeners) cb();
  }
}

/**
 * Host side (spec 5.3). Holds the full state, runs timers, validates actions and broadcasts views.
 */
export class HostSession extends BaseSession implements Session {
  readonly isHost = true;
  private state: GameState;
  private peerToPlayer = new Map<string, PlayerId>();
  private timer: unknown = null;
  /** Pending action timer of each computer player. */
  private botTimers = new Map<PlayerId, unknown>();
  /** Strength estimate of each computer player, valid for 1 round (`key` = hand and round). */
  private botEstimates = new Map<PlayerId, { key: string; value: number }>();

  constructor(
    readonly me: PlayerId,
    name: string,
    private transport: Transport,
    private clock: Clock,
    private rng: Rng,
  ) {
    super();
    this.state = createGame(me, name);
    this.status = 'joined';
    transport.onMessage((raw, peerId) => this.onMessage(raw, peerId));
    transport.onPeerLeave((peerId) => this.onPeerLeave(peerId));
    this.publish();
  }

  /** Full state. For tests and debugging only. */
  get fullState(): GameState {
    return this.state;
  }

  hostNow(): number {
    return this.clock.now();
  }

  act(a: Exclude<PlayerAction, { type: 'join' }>): void {
    this.dispatch({ ...a, id: this.me });
  }

  close(): void {
    this.clock.clearTimeout(this.timer);
    for (const t of this.botTimers.values()) this.clock.clearTimeout(t);
    this.botTimers.clear();
    this.status = 'closed';
    this.transport.leave();
    this.emit();
  }

  private dispatch(action: Parameters<typeof reduce>[1]): boolean {
    const next = reduce(this.state, action, this.clock.now(), this.rng);
    if (next === this.state) return false;
    this.state = next;
    this.schedule();
    this.publish();
    return true;
  }

  private schedule(): void {
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    const at = nextDeadline(this.state);
    if (at == null) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      if (!this.dispatch({ type: 'tick' })) this.schedule();
    }, Math.max(0, at - this.clock.now()));
  }

  private publish(): void {
    for (const [peerId, playerId] of this.peerToPlayer) this.sendState(peerId, playerId);
    this.view = { pub: publicView(this.state), priv: privateView(this.state, this.me) };
    this.emit();
    this.driveBots();
  }

  /** Schedules the next action of every computer player that has something to do and no pending action. */
  private driveBots(): void {
    if (this.status === 'closed') return;
    for (const seat of this.state.seats) {
      if (!seat.bot || this.botTimers.has(seat.id)) continue;
      // Without an estimate for this round, assume there is work: the timer computes it, so bots do not all compute at once.
      if (this.hasEstimate(seat.id) && !this.botDecide(seat.id)) continue;
      // Actions before the intro pause ends are ignored, so wait for it too.
      const wait = Math.max(0, (this.state.startsAt ?? 0) - this.clock.now()) + BOT_MIN_MS + this.rng.int(BOT_SPREAD_MS);
      const handle = this.clock.setTimeout(() => {
        this.botTimers.delete(seat.id);
        // Decide again: the state may have changed during the wait.
        const a = this.botDecide(seat.id);
        // A rejected action (for example during the intro pause) tries again; no action waits for the next change.
        if (a && !this.dispatch({ ...a, id: seat.id })) this.driveBots();
      }, wait);
      this.botTimers.set(seat.id, handle);
    }
  }

  private hasEstimate(id: PlayerId): boolean {
    return this.botEstimates.get(id)?.key === `${this.state.handNo}-${this.state.round}`;
  }

  /** Returns what a computer player wants to do now. It sees only the views a human in that seat gets. */
  private botDecide(id: PlayerId): PlayerAction | null {
    const pub = publicView(this.state);
    const priv = privateView(this.state, id);
    if (!priv.hole) return null;
    const key = `${pub.handNo}-${pub.round}`;
    let est = this.botEstimates.get(id);
    if (est?.key !== key) {
      est = { key, value: estimateRank(priv.hole, pub.board, pub.seats.length, pub.settings.holeCards, this.rng) };
      this.botEstimates.set(id, est);
    }
    return botAction(pub, id, est.value);
  }

  private sendState(peerId: string, playerId: PlayerId): void {
    this.send(peerId, {
      v: PROTOCOL_VERSION,
      type: 'state',
      pub: publicView(this.state),
      priv: privateView(this.state, playerId),
      hostNow: this.clock.now(),
    });
  }

  private send(peerId: string, msg: HostMsg): void {
    this.transport.send(peerId, msg);
  }

  private onMessage(raw: unknown, peerId: string): void {
    const msg = parseClientMsg(raw);
    if (msg === 'version') {
      this.send(peerId, { v: PROTOCOL_VERSION, type: 'rejected', reason: 'version' });
      return;
    }
    if (!msg) return;
    if (msg.type === 'ping') {
      this.send(peerId, { v: PROTOCOL_VERSION, type: 'pong', t0: msg.t0, hostNow: this.clock.now() });
      return;
    }
    if (msg.type === 'join') {
      this.onJoin(peerId, msg);
      return;
    }
    // Identity comes from the connection, never from the message (spec 8.3).
    const playerId = this.peerToPlayer.get(peerId);
    if (!playerId) return;
    const { v: _v, ...action } = msg;
    this.dispatch({ ...action, id: playerId });
  }

  private onJoin(peerId: string, msg: Extract<ClientMsg, { type: 'join' }>): void {
    if (msg.playerId === this.me) return;
    const rejection = joinRejection(this.state, msg.playerId);
    if (rejection) {
      this.send(peerId, { v: PROTOCOL_VERSION, type: 'rejected', reason: rejection });
      return;
    }
    // A rejoin from a new connection replaces the old connection.
    for (const [p, id] of this.peerToPlayer) if (id === msg.playerId) this.peerToPlayer.delete(p);
    this.peerToPlayer.set(peerId, msg.playerId);
    if (!this.dispatch({ type: 'join', id: msg.playerId, name: msg.name })) this.sendState(peerId, msg.playerId);
  }

  private onPeerLeave(peerId: string): void {
    const playerId = this.peerToPlayer.get(peerId);
    if (!playerId) return;
    this.peerToPlayer.delete(peerId);
    this.dispatch({ type: 'leave', id: playerId });
  }
}

const PING_COUNT = 5;
const PING_GAP_MS = 200;

/**
 * Player side. Finds the host, sends actions and keeps a clock offset to the host (spec 9).
 */
export class ClientSession extends BaseSession implements Session {
  readonly isHost = false;
  private hostPeer: string | null = null;
  private offset = 0;
  private bestRtt = Number.POSITIVE_INFINITY;
  private pingsSent = 0;

  constructor(
    readonly me: PlayerId,
    name: string,
    private transport: Transport,
    private clock: Clock,
  ) {
    super();
    transport.onPeerJoin((peerId) => this.send(peerId, { v: PROTOCOL_VERSION, type: 'join', playerId: me, name }));
    transport.onMessage((raw, peerId) => this.onMessage(raw, peerId));
    transport.onPeerLeave((peerId) => {
      if (peerId !== this.hostPeer) return;
      this.status = 'closed';
      this.reason = 'host-left';
      this.emit();
    });
  }

  hostNow(): number {
    return this.clock.now() + this.offset;
  }

  act(a: Exclude<PlayerAction, { type: 'join' }>): void {
    if (this.hostPeer && this.status === 'joined') this.send(this.hostPeer, { v: PROTOCOL_VERSION, ...a });
  }

  close(): void {
    this.status = 'closed';
    this.transport.leave();
    this.emit();
  }

  private send(peerId: string, msg: ClientMsg): void {
    this.transport.send(peerId, msg);
  }

  private onMessage(raw: unknown, peerId: string): void {
    if (this.status === 'closed' || this.status === 'rejected') return;
    const msg = parseHostMsg(raw);
    if (!msg) return;
    // The first peer that sends a host message is the host. Ignore all other peers after that.
    if (this.hostPeer && peerId !== this.hostPeer) return;
    if (msg.type === 'rejected') {
      this.status = 'rejected';
      this.reason = msg.reason;
      this.emit();
      return;
    }
    this.hostPeer = peerId;
    if (msg.type === 'pong') {
      const rtt = this.clock.now() - msg.t0;
      if (rtt < this.bestRtt) {
        this.bestRtt = rtt;
        this.offset = msg.hostNow - (msg.t0 + rtt / 2);
      }
      this.emit();
      return;
    }
    if (this.bestRtt === Number.POSITIVE_INFINITY) this.offset = msg.hostNow - this.clock.now();
    this.status = 'joined';
    this.view = { pub: msg.pub, priv: msg.priv };
    if (this.pingsSent === 0) this.pingLoop();
    this.emit();
  }

  private pingLoop(): void {
    if (this.pingsSent >= PING_COUNT || !this.hostPeer || this.status !== 'joined') return;
    this.pingsSent++;
    this.send(this.hostPeer, { v: PROTOCOL_VERSION, type: 'ping', t0: this.clock.now() });
    this.clock.setTimeout(() => this.pingLoop(), PING_GAP_MS);
  }
}
