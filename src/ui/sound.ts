import type { AnnouncementKind } from './events';

type Note = { freq: number; at: number; len: number; type?: OscillatorType };

/** Short synthesized cues. No audio files: tones are made by Web Audio at play time. */
const CUES: Record<AnnouncementKind, Note[]> = {
  info: [
    { freq: 660, at: 0, len: 0.12 },
    { freq: 880, at: 0.12, len: 0.18 },
  ],
  conflict: [
    { freq: 220, at: 0, len: 0.14, type: 'square' },
    { freq: 220, at: 0.2, len: 0.14, type: 'square' },
  ],
  swap: [{ freq: 520, at: 0, len: 0.12, type: 'triangle' }],
  result: [
    { freq: 523, at: 0, len: 0.12 },
    { freq: 659, at: 0.12, len: 0.12 },
    { freq: 784, at: 0.24, len: 0.25 },
  ],
};

const VIBRATION: Record<AnnouncementKind, number[]> = {
  info: [60],
  conflict: [80, 60, 80],
  swap: [40],
  result: [100, 50, 100, 50, 200],
};

let ctx: AudioContext | null = null;

/**
 * Prepares audio. Browsers allow sound only after a user gesture, so call this from a click or tap.
 */
export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null; // No Web Audio: cues stay silent.
  }
}

/** Plays the cue for an announcement kind. Does nothing when audio is not unlocked. */
export function playCue(kind: AnnouncementKind): void {
  if (!ctx || ctx.state !== 'running') return;
  const t0 = ctx.currentTime;
  for (const n of CUES[kind]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = n.type ?? 'sine';
    osc.frequency.value = n.freq;
    gain.gain.setValueAtTime(0.0001, t0 + n.at);
    gain.gain.exponentialRampToValueAtTime(0.18, t0 + n.at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + n.at);
    osc.stop(t0 + n.at + n.len + 0.02);
  }
}

/** Vibrates the device for an announcement kind. Many devices (for example iPhone) ignore it. */
export function vibrateCue(kind: AnnouncementKind): void {
  try {
    navigator.vibrate?.(VIBRATION[kind]);
  } catch {
    // Ignore: vibration is optional.
  }
}
