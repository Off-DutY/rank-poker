import { joinRoom } from 'trystero';
import type { Transport } from './transport';

const APP_ID = 'rank-poker.v1';

/**
 * Creates a Trystero (Nostr signaling) transport for a room.
 * The room code is also the signaling password, so outsiders cannot read the offers.
 */
export function trysteroTransport(roomCode: string): Transport {
  // identity 'none': each tab is a separate peer, so 1 browser can test many seats.
  const room = joinRoom({ appId: APP_ID, password: roomCode, identity: 'none' }, roomCode);
  const action = room.makeAction<string>('m');
  return {
    send: (peerId, msg) => void action.send(JSON.stringify(msg), { target: peerId }).catch(() => {}),
    onMessage: (cb) =>
      void action.onMessage((data, ctx) => {
        try {
          cb(JSON.parse(data) as unknown, ctx.peerId);
        } catch {
          // Ignore messages that are not JSON.
        }
      }),
    onPeerJoin: (cb) => void room.onPeerJoin(({ peerId }) => cb(peerId)),
    onPeerLeave: (cb) => void room.onPeerLeave(({ peerId }) => cb(peerId)),
    leave: () => void room.leave(),
  };
}
