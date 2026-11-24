/** Peer-to-peer message channel. Peers are identified by connection IDs, not player IDs. */
export interface Transport {
  /** Sends a JSON-compatible message to 1 peer. */
  send(peerId: string, msg: unknown): void;
  onMessage(cb: (msg: unknown, peerId: string) => void): void;
  onPeerJoin(cb: (peerId: string) => void): void;
  onPeerLeave(cb: (peerId: string) => void): void;
  /** Disconnects from all peers. */
  leave(): void;
}

/** Timer source. Tests replace it with fake timers. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real clock based on Date.now and setTimeout. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

type Handlers = {
  message: ((msg: unknown, peerId: string) => void)[];
  join: ((peerId: string) => void)[];
  leave: ((peerId: string) => void)[];
};

/**
 * In-memory mesh network for tests and offline demos.
 * Delivery is asynchronous (microtask) and messages are copied, like a real network.
 */
export class MemoryHub {
  private peers = new Map<string, Handlers>();
  private seq = 0;

  /** Adds a new peer to the mesh and returns its transport. */
  connect(): Transport & { peerId: string } {
    const id = `peer${++this.seq}`;
    const h: Handlers = { message: [], join: [], leave: [] };
    const others = [...this.peers.keys()];
    this.peers.set(id, h);
    const later = (fn: () => void) => queueMicrotask(fn);
    for (const other of others) {
      later(() => this.peers.get(other)?.join.forEach((cb) => cb(id)));
      later(() => h.join.forEach((cb) => cb(other)));
    }
    return {
      peerId: id,
      send: (peerId, msg) => {
        const copy = JSON.parse(JSON.stringify(msg)) as unknown;
        later(() => this.peers.get(peerId)?.message.forEach((cb) => cb(copy, id)));
      },
      onMessage: (cb) => h.message.push(cb),
      onPeerJoin: (cb) => h.join.push(cb),
      onPeerLeave: (cb) => h.leave.push(cb),
      leave: () => {
        if (!this.peers.delete(id)) return;
        for (const other of this.peers.keys()) later(() => this.peers.get(other)?.leave.forEach((cb) => cb(id)));
      },
    };
  }
}
