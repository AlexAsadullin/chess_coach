/**
 * Board sounds — deliberately simple: one wooden "move" knock for every move
 * (captures, checks and castling included; those are shown visually with a
 * red flash on the board instead), and a softer knock when stepping back.
 *
 * Real recordings of wood ("Impact Sounds" by Kenney, CC0 — see
 * assets/sounds/LICENSE.txt), played quietly through a gentle low-pass filter
 * so they sound like felted pieces on a wooden board.
 */
import { SOUND_DATA } from '../vendor/sound-data.js';

const MOVES = ['move-1', 'move-2', 'move-3']; // three takes, so repeats don't sound robotic

class SoundPlayer {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.loading = null;
    this.enabled = true;
    this.volume = 0.6; // 0..1, from Settings
    this.lastMove = -1;
  }

  /** Apply settings: { enabled, volume (0-100) }. */
  configure({ enabled, volume } = {}) {
    if (enabled !== undefined) this.enabled = Boolean(enabled);
    if (volume !== undefined) this.volume = Math.max(0, Math.min(1, Number(volume) / 100));
    if (this.master) this.master.gain.value = this.#gain();
  }

  get muted() {
    return !this.enabled;
  }

  #gain() {
    return 0.55 * this.volume; // recordings are normalised loud; keep everything soft
  }

  #ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.filter = this.ctx.createBiquadFilter(); // takes the hard "click" off
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 2600;
      this.filter.Q.value = 0.5;
      this.master = this.ctx.createGain();
      this.master.gain.value = this.#gain();
      this.filter.connect(this.master).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /** Decode the sounds once (call early so the first move isn't silent). */
  preload() {
    if (this.loading) return this.loading;
    const ctx = this.#ensureContext();
    this.loading = Promise.all(Object.entries(SOUND_DATA).map(async ([name, b64]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      this.buffers.set(name, await ctx.decodeAudioData(bytes.buffer));
    })).catch(() => {});
    return this.loading;
  }

  #play(name, gain = 1) {
    const buf = this.buffers.get(name);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.filter);
    src.start();
  }

  #randomMove() {
    let i;
    do i = Math.floor(Math.random() * MOVES.length); while (i === this.lastMove && MOVES.length > 1);
    this.lastMove = i;
    return MOVES[i];
  }

  /** name: 'move' (any move) | 'back' (stepping back to a previous move) */
  async play(name) {
    if (!this.enabled || this.volume <= 0) return;
    try {
      this.#ensureContext();
      await this.preload();
      if (name === 'back') this.#play('back', 0.75);
      else this.#play(this.#randomMove());
    } catch { /* audio unavailable */ }
  }
}

export const sounds = new SoundPlayer();
