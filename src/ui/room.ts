import { cryptoRng } from '../core/cards';

/** Crockford Base32 without I, L, O, U (spec 5.2). */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 5;

/** Returns a new random room code. */
export function newRoomCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[cryptoRng.int(ALPHABET.length)];
  return s;
}

/** Returns the room code from a URL hash, or null when the hash is not a valid code. */
export function parseRoomCode(hash: string): string | null {
  const code = hash.replace(/^#/, '').trim().toUpperCase();
  return code.length === CODE_LENGTH && [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}

/** Returns the join URL for a room code. */
export function roomUrl(code: string): string {
  return `${location.origin}${location.pathname}#${code}`;
}

// Storage can be missing or throw (private mode, blocked site data). The game still works without it.
function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string): void {
  try {
    storage().setItem(key, value);
  } catch {
    // Ignore: the value is a convenience only.
  }
}

const session = () => sessionStorage;
const local = () => localStorage;

/**
 * Returns this tab's player ID. It is kept in sessionStorage, so each tab is a separate player
 * and a page refresh keeps the same seat (spec 10).
 */
export function playerId(): string {
  let id = read(session, 'rp.playerId');
  if (!id) {
    id = Array.from({ length: 16 }, () => ALPHABET[cryptoRng.int(ALPHABET.length)]).join('');
    write(session, 'rp.playerId', id);
  }
  return id;
}

/** Returns the last used name. */
export function savedName(): string {
  return read(local, 'rp.name') ?? '';
}

/** Saves the name for next time. */
export function saveName(name: string): void {
  write(local, 'rp.name', name);
}

/** Marks this tab as the host of a room. */
export function markHost(code: string): void {
  write(session, 'rp.hostRoom', code);
}

/** Returns true when this tab created the room. After a refresh the host state is gone (spec 10). */
export function wasHost(code: string): boolean {
  return read(session, 'rp.hostRoom') === code;
}
