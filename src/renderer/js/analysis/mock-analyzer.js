/**
 * NOT a chess algorithm. Placeholder data used only when the renderer runs in
 * a plain browser (no Electron / Stockfish), for UI development.
 */
import { Chess } from '../../vendor/chess.js';

const BOOK_PLIES = 6;
const ROTATION = [
  'best', 'excellent', 'good', 'inaccuracy', 'best', 'mistake', 'great',
  'blunder', 'brilliant', 'good', 'miss', 'best', 'forced',
]; // odd length, so both White and Black get every classification

// eval swing (pawns) for the side that moved
const SWING = {
  book: 0.1, brilliant: 1.6, great: 1.2, best: 0.25, excellent: 0.1, good: -0.15,
  forced: 0, inaccuracy: -0.7, mistake: -1.6, miss: -1.2, blunder: -3.2,
};

const KEEP_PLAYED = new Set(['book', 'best', 'brilliant', 'great', 'forced']);

export function mockAnalyze(timeline) {
  const moves = [];
  let cp = 30; // white starts slightly better, like a real engine
  timeline.moves.forEach((mv, i) => {
    const classification = i < BOOK_PLIES ? 'book' : ROTATION[(i - BOOK_PLIES) % ROTATION.length];
    const sign = mv.color === 'w' ? 1 : -1;
    cp = Math.max(-1500, Math.min(1500, cp + sign * SWING[classification] * 100));
    let evalAfter = { cp: Math.round(cp) };
    if (mv.san.endsWith('#')) evalAfter = { mate: 0, winner: mv.color };

    let bestMove = { from: mv.from, to: mv.to, promotion: mv.promotion, san: mv.san, uci: mv.from + mv.to + (mv.promotion || '') };
    if (!KEEP_PLAYED.has(classification)) {
      const alt = pickAlternative(timeline.fens[i], mv);
      if (alt) bestMove = alt;
    }
    moves.push({ classification, evalAfter, bestMove, bestPv: [bestMove.uci], opening: null });
  });
  return { source: 'mock', initialEval: { cp: 30 }, moves };
}

/** Some other legal move (prefer captures/checks) so "Best" shows something. */
function pickAlternative(fen, played) {
  const chess = new Chess(fen);
  const legal = chess.moves({ verbose: true }).filter((m) => m.san !== played.san);
  if (!legal.length) return null;
  legal.sort((a, b) => score(b) - score(a));
  const m = legal[0];
  return { from: m.from, to: m.to, promotion: m.promotion, san: m.san, uci: m.from + m.to + (m.promotion || '') };
}

function score(m) {
  return (m.san.includes('#') ? 100 : 0) + (m.san.includes('+') ? 10 : 0) + (m.captured ? 5 : 0);
}
