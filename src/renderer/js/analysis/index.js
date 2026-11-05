/**
 * Analysis entry point used by the review screen.
 *
 *   const a = startAnalysis(game, timeline, (state) => render(state));
 *   state = {
 *     status: 'running' | 'done' | 'error',
 *     stage: 'quick' | 'deep',   // quick pass (depth 12) then deep pass (depth 20)
 *     progress: 0..1 of the current stage, message?, engine?,
 *     result: classifyGame(...)   // see classify.js
 *   }
 *   a.dispose();                   // stop listening (analysis keeps caching)
 *   a.bestLine(fen, opts)          // engine best line for the Best branch
 *
 * In Electron, Stockfish runs in the main process (src/main/analysis-service.js).
 * In a plain browser (UI development) the mock analyzer is used instead.
 */
import { classifyGame } from './classify.js';
import { mockAnalyze } from './mock-analyzer.js';
import { OPENINGS } from '../../data/openings.js';

const api = window.chessApi;

export function startAnalysis(game, timeline, onUpdate) {
  if (!api?.startAnalysis) return startMock(timeline, onUpdate);

  const total = timeline.fens.length;
  const positions = new Array(total);
  let status = 'running';
  let message = null;
  let engine = null;
  let stage = 'quick';
  let progress = 0;
  let raf = 0;

  const emit = () => {
    if (raf) return;
    // timer, not requestAnimationFrame: rAF is paused while the window is hidden
    raf = setTimeout(() => {
      raf = 0;
      onUpdate({
        status,
        message,
        engine,
        stage,
        progress,
        result: classifyGame(timeline, positions, OPENINGS),
      });
    }, 60);
  };

  const lineListeners = new Map();
  const off = api.onAnalysis((kind, p) => {
    if (kind === 'line') {
      lineListeners.get(p.requestId)?.(p);
      return;
    }
    if (p.gameId !== game.id) return;
    if (kind === 'position') {
      positions[p.index] = p.result;
      stage = p.stage;
      progress = p.completed / p.total;
    } else if (kind === 'progress') {
      stage = p.stage;
      progress = p.completed / p.total;
    } else if (kind === 'done') {
      p.positions.forEach((r, i) => { positions[i] = r; });
      status = 'done';
      engine = p.engine;
    } else if (kind === 'error') {
      status = 'error';
      message = p.message;
    }
    emit();
  });

  emit();
  api.startAnalysis(game.id).catch((err) => {
    status = 'error';
    message = err.message;
    emit();
  });

  return {
    dispose() {
      off();
      clearTimeout(raf);
    },
    /** Engine line; onStep({moves, done}) is called as it grows. */
    async bestLine(fen, opts, onStep) {
      const requestId = Math.random().toString(36).slice(2);
      if (onStep) lineListeners.set(requestId, onStep);
      try {
        return await api.bestLine(fen, { ...opts, gameId: game.id, requestId });
      } finally {
        lineListeners.delete(requestId);
      }
    },
    prefetchLines: (items, front = false) => api.prefetchLines?.(game.id, items, { front }),
  };
}

function startMock(timeline, onUpdate) {
  const r = mockAnalyze(timeline);
  queueMicrotask(() => onUpdate({ status: 'done', progress: 1, engine: 'Mock', result: { ...r, accuracy: { w: null, b: null }, complete: true } }));
  return {
    dispose() {},
    async bestLine() { return { moves: [], finalScore: null }; },
    prefetchLines() {},
  };
}
