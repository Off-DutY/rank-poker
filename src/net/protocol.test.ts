import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, parseClientMsg } from './protocol';

describe('parseClientMsg', () => {
  const v = PROTOCOL_VERSION;

  it('passes the final challenge vote and the special challenge settings', () => {
    expect(parseClientMsg({ v, type: 'guessVote', category: 3 })).toEqual({ v, type: 'guessVote', category: 3 });
    expect(parseClientMsg({ v, type: 'guessVote', category: '3' })).toBeNull();
    expect(parseClientMsg({ v, type: 'settings', settings: { lockEnd: 'high', finalGuess: true, x: 1 } })).toEqual({
      v,
      type: 'settings',
      settings: { lockEnd: 'high', finalGuess: true },
    });
  });
});
