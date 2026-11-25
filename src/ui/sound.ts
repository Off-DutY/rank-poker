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
 * Starts the background music when it is on and waits for the unlock.
 */
export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume().then(syncMusic);
    else syncMusic();
  } catch {
    ctx = null; // No Web Audio: cues and music stay silent.
  }
}

// ---------------------------------------------------------------------------
// Background music: a soft lo-fi loop made by Web Audio at play time. No audio files.
// ---------------------------------------------------------------------------

const BEAT = 60 / 84;
const BAR = BEAT * 4;
/** Chord loop as MIDI notes, low to high. The first note is the bass root. Am7, Fmaj7, Cmaj7, G6. */
const CHORDS: number[][] = [
  [45, 57, 60, 64, 67],
  [41, 57, 60, 64, 65],
  [48, 55, 59, 64, 67],
  [43, 55, 59, 62, 64],
];
const MUSIC_VOLUME = 0.05;

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

let musicOn = false;
let music: { out: GainNode; timer: ReturnType<typeof setInterval>; nextBar: number; bar: number } | null = null;

/** Turns the background music on or off. The music starts only after audio is unlocked. */
export function setMusic(on: boolean): void {
  musicOn = on;
  syncMusic();
}

function syncMusic(): void {
  if (musicOn && !music && ctx?.state === 'running') startMusic(ctx);
  if (!musicOn && music) stopMusic();
}

function startMusic(ac: AudioContext): void {
  const out = ac.createGain();
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1800;
  out.gain.setValueAtTime(0.0001, ac.currentTime);
  out.gain.exponentialRampToValueAtTime(MUSIC_VOLUME, ac.currentTime + 2);
  out.connect(filter).connect(ac.destination);
  const m = { out, nextBar: ac.currentTime + 0.1, bar: 0, timer: 0 as unknown as ReturnType<typeof setInterval> };
  // Schedule about 1 second ahead, so a busy page does not cause gaps.
  const pump = () => {
    while (m.nextBar < ac.currentTime + 1) {
      scheduleBar(ac, out, CHORDS[m.bar % CHORDS.length]!, m.nextBar);
      m.nextBar += BAR;
      m.bar++;
    }
  };
  pump();
  m.timer = setInterval(pump, 250);
  music = m;
}

function stopMusic(): void {
  const m = music!;
  music = null;
  clearInterval(m.timer);
  if (!ctx) return;
  const t = ctx.currentTime;
  m.out.gain.cancelScheduledValues(t);
  m.out.gain.setValueAtTime(Math.max(0.0001, m.out.gain.value), t);
  m.out.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
  setTimeout(() => m.out.disconnect(), 800);
}

/** Plays 1 note into the music output with a soft attack and release. */
function tone(ac: AudioContext, out: AudioNode, midi: number, at: number, len: number, vol: number, type: OscillatorType): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = midiHz(midi);
  const attack = Math.min(0.3, len / 3);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(vol, at + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + len + 0.05);
}

/** Schedules 1 bar: a pad on the chord, the bass root on beats 1 and 3, and a few random plucks. */
function scheduleBar(ac: AudioContext, out: AudioNode, chord: number[], at: number): void {
  const [root, ...upper] = chord;
  for (const n of upper) tone(ac, out, n, at, BAR * 0.98, 0.18, 'sine');
  tone(ac, out, root!, at, BEAT * 1.8, 0.5, 'triangle');
  tone(ac, out, root!, at + BEAT * 2, BEAT * 1.8, 0.4, 'triangle');
  for (let i = 0; i < 8; i++) {
    if (Math.random() < 0.55) continue;
    const n = upper[Math.floor(Math.random() * upper.length)]! + 12;
    tone(ac, out, n, at + (i * BEAT) / 2, BEAT * 0.9, 0.12, 'triangle');
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
