import type { JoinRejection, PlayerAction, PlayerId, PrivateState, PublicState } from '../core/engine';

/** Protocol version. Players with a different version cannot join (spec 8). */
export const PROTOCOL_VERSION = 7;

/** Message from a player to the host. */
export type ClientMsg =
  | { v: number; type: 'join'; playerId: PlayerId; name: string }
  | { v: number; type: 'ping'; t0: number }
  | ({ v: number } & Exclude<PlayerAction, { type: 'join' }>);

/** Message from the host to a player. */
export type HostMsg =
  | { v: number; type: 'state'; pub: PublicState; priv: PrivateState; hostNow: number }
  | { v: number; type: 'pong'; t0: number; hostNow: number }
  | { v: number; type: 'rejected'; reason: JoinRejection | 'version' };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown, max = 64): x is string => typeof x === 'string' && x.length > 0 && x.length <= max;

/**
 * Validates a raw message from a player (trust boundary).
 * Returns the message, 'version' when the protocol version differs, or null when the shape is not valid.
 */
export function parseClientMsg(raw: unknown): ClientMsg | 'version' | null {
  if (!isObj(raw)) return null;
  if (raw.v !== PROTOCOL_VERSION) return 'version';
  const v = PROTOCOL_VERSION;
  switch (raw.type) {
    case 'join':
      return isStr(raw.playerId) && typeof raw.name === 'string' && raw.name.length <= 64
        ? { v, type: 'join', playerId: raw.playerId, name: raw.name }
        : null;
    case 'ping':
      return isNum(raw.t0) ? { v, type: 'ping', t0: raw.t0 } : null;
    case 'leave':
    case 'start':
    case 'lock':
    case 'unlock':
    case 'next':
    case 'lobby':
      return { v, type: raw.type };
    case 'settings': {
      if (!isObj(raw.settings)) return null;
      const s = raw.settings;
      const settings: Record<string, unknown> = {};
      if (typeof s.challenge === 'boolean') settings.challenge = s.challenge;
      if (isNum(s.swapSeconds)) settings.swapSeconds = s.swapSeconds;
      if (isNum(s.introSeconds)) settings.introSeconds = s.introSeconds;
      if (typeof s.notifyStyle === 'string') settings.notifyStyle = s.notifyStyle;
      if (typeof s.sound === 'boolean') settings.sound = s.sound;
      if (typeof s.vibrate === 'boolean') settings.vibrate = s.vibrate;
      if (isNum(s.holeCards)) settings.holeCards = s.holeCards;
      if (isNum(s.skipRound)) settings.skipRound = s.skipRound;
      return { v, type: 'settings', settings };
    }
    case 'pick':
      return isNum(raw.rank) ? { v, type: 'pick', rank: raw.rank } : null;
    case 'persist':
      return isNum(raw.value) ? { v, type: 'persist', value: raw.value } : null;
    case 'swapRequest':
      return isStr(raw.targetId) ? { v, type: 'swapRequest', targetId: raw.targetId } : null;
    case 'swapRespond':
      return isNum(raw.requestId) && typeof raw.accept === 'boolean'
        ? { v, type: 'swapRespond', requestId: raw.requestId, accept: raw.accept }
        : null;
    case 'swapChallenge':
      return isNum(raw.requestId) ? { v, type: 'swapChallenge', requestId: raw.requestId } : null;
    case 'swapDone':
      return typeof raw.done === 'boolean' ? { v, type: 'swapDone', done: raw.done } : null;
    default:
      return null;
  }
}

/** Validates a raw message from the host. Only checks the envelope; the host is trusted (spec 11). */
export function parseHostMsg(raw: unknown): HostMsg | null {
  if (!isObj(raw) || raw.v !== PROTOCOL_VERSION) return null;
  if (raw.type === 'state' && isObj(raw.pub) && isObj(raw.priv) && isNum(raw.hostNow)) return raw as HostMsg;
  if (raw.type === 'pong' && isNum(raw.t0) && isNum(raw.hostNow)) return raw as HostMsg;
  if (raw.type === 'rejected' && typeof raw.reason === 'string') return raw as HostMsg;
  return null;
}
