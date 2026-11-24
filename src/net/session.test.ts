import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seededRng } from '../core/cards';
import { RULES } from '../core/engine';
import { PROTOCOL_VERSION } from './protocol';
import { ClientSession, HostSession, type Session } from './session';
import { MemoryHub, type Transport, realClock } from './transport';

const flush = () => vi.advanceTimersByTimeAsync(0);

/** Wraps a transport and records every received message. */
function recording(t: Transport) {
  const received: unknown[] = [];
  t.onMessage((m) => received.push(m));
  return { t, received };
}

describe('host and clients over the memory hub', () => {
  let hub: MemoryHub;
  let host: HostSession;
  let clients: ClientSession[];
  let c1Log: unknown[];

  beforeEach(async () => {
    vi.useFakeTimers();
    hub = new MemoryHub();
    host = new HostSession('H', 'Host', hub.connect(), realClock, seededRng(3));
    host.act({ type: 'settings', settings: { introSeconds: 0 } });
    clients = [];
    for (let i = 1; i <= 3; i++) {
      const rec = recording(hub.connect());
      if (i === 1) c1Log = rec.received;
      clients.push(new ClientSession(`C${i}`, `Client${i}`, rec.t, realClock));
    }
    await flush();
  });

  afterEach(() => vi.useRealTimers());

  const all = (): Session[] => [host, ...clients];

  it('seats every client and ignores joins between clients', () => {
    expect(host.view!.pub.seats.map((s) => s.id)).toEqual(['H', 'C1', 'C2', 'C3']);
    for (const c of clients) {
      expect(c.status).toBe('joined');
      expect(c.view!.pub.hostId).toBe('H');
    }
  });

  it('plays a full hand without leaking other hole cards', async () => {
    host.act({ type: 'start' });
    await flush();
    for (let round = 1; round <= 4; round++) {
      all().forEach((s, i) => {
        s.act({ type: 'pick', rank: i + 1 });
        s.act({ type: 'lock' });
      });
      await flush();
      expect(host.view!.pub.phase).toBe('SWAP');
      all().forEach((s) => s.act({ type: 'swapDone', done: true }));
      await flush();
      if (round < 4) {
        expect(clients[0]!.view!.pub.round).toBe(round + 1);
        expect(clients[0]!.view!.pub.board).toHaveLength(round + 2);
      }
    }
    expect(clients[2]!.view!.pub.phase).toBe('SHOWDOWN');

    // Before showdown, client 1 never received another player's hole cards.
    const full = host.fullState;
    const secret = ['H', 'C2', 'C3'].flatMap((id) => full.hole[id]!);
    const beforeShowdown = c1Log.filter((m) => (m as { pub?: { phase: string } }).pub?.phase !== 'SHOWDOWN');
    const text = JSON.stringify(beforeShowdown);
    for (const card of secret) expect(text).not.toContain(`"${card}"`);
    expect(clients[0]!.view!.priv.hole).toEqual(full.hole.C1);
  });

  it('runs phase timers on the host', async () => {
    host.act({ type: 'start' });
    await flush();
    await vi.advanceTimersByTimeAsync(RULES.pickMs + RULES.graceMs);
    expect(clients[0]!.view!.pub.phase).toBe('SWAP');
    const ranks = Object.values(clients[0]!.view!.pub.ranks).sort();
    expect(ranks).toEqual([1, 2, 3, 4]);
  });

  it('ignores host-only actions from clients', async () => {
    clients[0]!.act({ type: 'start' });
    await flush();
    expect(host.view!.pub.phase).toBe('LOBBY');
  });

  it('takes the player identity from the connection, not the message', async () => {
    host.act({ type: 'start' });
    await flush();
    const spy = hub.connect();
    // A peer without a seat sends an action that claims to be the host.
    spy.send('peer1', { v: PROTOCOL_VERSION, type: 'pick', rank: 2, id: 'H' });
    await flush();
    expect(host.fullState.picks.H!.rank).toBeNull();
  });

  it('rejects late joins and other protocol versions', async () => {
    host.act({ type: 'start' });
    await flush();
    const late = new ClientSession('C9', 'late', hub.connect(), realClock);
    await flush();
    expect(late.status).toBe('rejected');
    expect(late.reason).toBe('started');

    const old = hub.connect();
    const replies: unknown[] = [];
    old.onMessage((m) => replies.push(m));
    old.send('peer1', { v: 999, type: 'join', playerId: 'X', name: 'x' });
    await flush();
    expect(replies).toContainEqual({ v: PROTOCOL_VERSION, type: 'rejected', reason: 'version' });
  });

  it('keeps the seat when a player drops and restores it on rejoin', async () => {
    host.act({ type: 'start' });
    await flush();
    const hole = host.fullState.hole.C2;
    clients[1]!.close();
    await flush();
    expect(host.view!.pub.seats[2]).toMatchObject({ id: 'C2', connected: false });
    const back = new ClientSession('C2', 'Client2', hub.connect(), realClock);
    await flush();
    expect(back.status).toBe('joined');
    expect(back.view!.priv.hole).toEqual(hole);
    expect(host.view!.pub.seats[2]!.connected).toBe(true);
  });

  it('closes clients when the host leaves', async () => {
    host.close();
    await flush();
    for (const c of clients) {
      expect(c.status).toBe('closed');
      expect(c.reason).toBe('host-left');
    }
  });
});
