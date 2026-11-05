/** Settings state in the UI: loads from the main process and applies it. */
import { api } from './api.js';
import { sounds } from './sounds.js';
import { setPieceSet } from './board.js';

export const BOARD_THEMES = {
  green: { label: 'Green', light: '#ebecd0', dark: '#739552' },
  brown: { label: 'Brown', light: '#edd6b0', dark: '#b88762' },
  blue: { label: 'Blue', light: '#eae9d2', dark: '#4b7399' },
  gray: { label: 'Gray', light: '#e0e0e0', dark: '#9a9a9a' },
};
const ANIMATION_MS = { off: 0, fast: 70, normal: 160 };

let snap = null;
const listeners = new Set();

export function current() {
  return snap?.settings || {
    board: { theme: 'green', pieces: 'cburnett', coordinates: true, animation: 'fast' },
    sound: { enabled: true, volume: 60 },
    analysis: { depth: 20, bestArrow: true, linePlies: 26 },
    ai: { activeKeyId: null },
  };
}

export function snapshot() {
  return snap;
}

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function apply(next) {
  snap = next;
  const s = current();
  const root = document.documentElement;
  const theme = BOARD_THEMES[s.board.theme] || BOARD_THEMES.green;
  root.style.setProperty('--sq-light', theme.light);
  root.style.setProperty('--sq-dark', theme.dark);
  root.style.setProperty('--piece-anim', `${ANIMATION_MS[s.board.animation] ?? 70}ms`);
  root.classList.toggle('no-coords', !s.board.coordinates);
  setPieceSet(s.board.pieces);
  sounds.configure({ enabled: s.sound.enabled, volume: s.sound.volume });
  for (const fn of listeners) fn(s, snap);
}

export async function loadSettings() {
  apply(await api.getSettings());
  api.onSettings?.((next) => apply(next));
}

/** Update some settings, e.g. update({ sound: { volume: 40 } }). */
export async function update(partial) {
  apply(await api.updateSettings(partial));
}

/** Key operations return the new snapshot; apply it right away. */
export async function keyOp(fn) {
  apply(await fn());
}
