/**
 * Turns raw Stockfish output into chess.com-style move classifications.
 *
 * Core idea (chess.com "expected points"): convert every evaluation into the
 * mover's expected score E ∈ [0,1] and grade a move by how much E it gives
 * up compared with the engine's best move:
 *   best ≈0 · excellent ≤.02 · good ≤.05 · inaccuracy ≤.10 · mistake ≤.20 · blunder >.20
 * Special rules on top: book, forced, brilliant, great, miss.
 *
 * Pure module (no DOM) so it is unit-tested in Node.
 */
import { Chess } from '../../vendor/chess.js';

const K = 0.00368208; // lichess win-probability curve
export const THRESHOLDS = { best: 0.005, excellent: 0.02, good: 0.05, inaccuracy: 0.10, mistake: 0.20 };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export const epd = (fen) => fen.split(' ').slice(0, 4).join(' ');
const sideToMove = (fen) => fen.split(' ')[1];
const uciOf = (mv) => mv.from + mv.to + (mv.promotion || '');

/** Engine score (side-to-move POV) → white POV. */
export function toWhite(score, fen) {
  if (!score) return null;
  const s = sideToMove(fen) === 'w' ? 1 : -1;
  return score.mate !== undefined ? { mate: s * score.mate } : { cp: s * score.cp };
}

/** Expected score in [0,1] for `color` from a white-POV evaluation. */
export function expected(ev, color) {
  if (!ev) return null;
  let w;
  if (ev.draw) w = 0.5;
  else if (ev.winner) w = ev.winner === 'w' ? 1 : 0;
  else if (ev.mate !== undefined) w = ev.mate > 0 ? 1 : ev.mate < 0 ? 0 : 0.5;
  else w = 1 / (1 + Math.exp(-K * ev.cp));
  return color === 'w' ? w : 1 - w;
}

/** lichess per-move accuracy from win% before/after (0..100). */
export function moveAccuracy(winBefore, winAfter) {
  const a = 103.1668 * Math.exp(-0.04354 * Math.max(0, winBefore - winAfter)) - 3.1669;
  return Math.max(0, Math.min(100, a));
}

function material(chess, color) {
  let sum = 0;
  for (const row of chess.board()) {
    for (const sq of row) if (sq) sum += (sq.color === color ? 1 : -1) * VALUE[sq.type];
  }
  return sum;
}

/** Terminal evaluation (white POV) if the game is over in this position. */
function terminalEval(fen) {
  const c = new Chess(fen);
  if (c.isCheckmate()) return { mate: 0, winner: sideToMove(fen) === 'w' ? 'b' : 'w' };
  if (c.isDraw() || c.isStalemate()) return { draw: true };
  return null;
}

/**
 * How much material does `move` give up on purpose? Follows the engine's best
 * reply line after the move. Returns the largest material deficit (vs. before
 * the move) after any opponent reply, the deficit at the end of the horizon,
 * and whether the opponent's first reply is a capture.
 */
function sacrifice(fenBefore, move, pvAfter, horizon) {
  const none = { firstReplyCaptures: false, takesMovedPiece: false, newCapture: false, maxDown: 0, endDown: 0 };
  if (!pvAfter?.length) return none;
  const color = move.color;
  const c = new Chess(fenBefore);
  const m0 = material(c, color);
  c.move({ from: move.from, to: move.to, promotion: move.promotion });
  let min = material(c, color);
  let firstReplyCaptures = false;
  let takesMovedPiece = false;
  let newCapture = false;
  for (let i = 0; i < Math.min(horizon, pvAfter.length); i++) {
    const u = pvAfter[i];
    let mv;
    try { mv = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { break; }
    if (i === 0) {
      firstReplyCaptures = Boolean(mv.captured);
      takesMovedPiece = firstReplyCaptures && mv.to === move.to; // the piece that just moved is taken
      newCapture = firstReplyCaptures && !couldAlreadyCapture(fenBefore, mv);
    }
    if (i % 2 === 0) min = Math.min(min, material(c, color)); // after opponent replies
  }
  return { firstReplyCaptures, takesMovedPiece, newCapture, maxDown: m0 - min, endDown: m0 - material(c, color) };
}

/**
 * Was this capture already available before the move (i.e. the piece was
 * already hanging, so leaving it there is no sacrifice)? Checked by letting
 * the opponent move in the position before the move ("null move").
 */
function couldAlreadyCapture(fenBefore, reply) {
  const f = fenBefore.split(' ');
  f[1] = f[1] === 'w' ? 'b' : 'w';
  f[3] = '-';
  try {
    const c = new Chess(f.join(' '));
    return c.moves({ verbose: true }).some((m) => m.from === reply.from && m.to === reply.to && m.captured);
  } catch {
    return false; // mover was in check: the null-move position is illegal
  }
}

/**
 * Brilliant rules, calibrated to make brilliants ~60% rarer than the first
 * version: on 160 real games at club level (10,318 moves) the first version
 * gave 41 brilliants, these give 17 (−59%). A brilliant must
 *   - be the best or nearly best move,
 *   - give up at least a minor piece (3 pawn units),
 *   - make that piece capturable by the move itself (a piece that was
 *     already hanging doesn't count; discovered sacrifices do),
 *   - leave the mover in a good position, with no other clearly winning move.
 */
export const BRILLIANT_RULES = {
  maxLoss: 0.02,           // expected points the move may lose vs. the best move
  minPlayed: 0.5,          // mover's expected score after the move
  maxAlt: 0.9,             // no other move scored this well (otherwise the sacrifice wasn't needed)
  minSacrifice: 3,         // at least a minor piece (pawn units)
  newCapture: true,        // the move created the capture (piece was not already hanging)
  movedPieceTaken: false,  // (stricter option, unused) only count the moved piece being taken
  minStillDown: -Infinity, // (stricter option, unused) material still missing at the end of the horizon
  horizon: 6,              // half-moves of the engine line to look at
};
/** The first version's rules, kept for comparison/tests. */
export const BRILLIANT_RULES_V1 = {
  maxLoss: 0.02, minPlayed: 0.5, maxAlt: 0.9, minSacrifice: 2, newCapture: false, movedPieceTaken: false, minStillDown: -Infinity, horizon: 6,
};

/**
 * @param timeline   from buildTimeline(): {fens, moves}
 * @param positions  per position (index = ply): {depth, lines:[{move, score, pv}]} | undefined
 * @param openings   map epd -> [eco, name] | 0
 * @returns {{moves: Array, initialEval, accuracy: {w,b}, complete: boolean}}
 */
export function classifyGame(timeline, positions, openings = {}, { brilliant = BRILLIANT_RULES } = {}) {
  const { fens, moves } = timeline;
  const n = moves.length;

  const evalAt = (i) => {
    const t = terminalEval(fens[i]);
    if (t) return t;
    const top = positions[i]?.lines?.[0];
    return top ? toWhite(top.score, fens[i]) : null;
  };
  const evals = fens.map((_, i) => evalAt(i));

  const out = [];
  let inBook = true;
  let opening = null;
  const acc = { w: [], b: [] };

  for (let i = 1; i <= n; i++) {
    const mv = moves[i - 1];
    const color = mv.color;
    const fenBefore = fens[i - 1];
    const before = positions[i - 1];
    const lines = before?.lines || [];
    const top = lines[0];
    const uci = uciOf(mv);
    const entry = {
      classification: null,
      evalAfter: evals[i],
      bestMove: null,
      bestPv: top?.pv || [],
      loss: null,
      accuracy: null,
      opening: null,
    };

    // best move in the position before this move
    if (top) {
      try {
        const c = new Chess(fenBefore);
        const bm = c.move({ from: top.move.slice(0, 2), to: top.move.slice(2, 4), promotion: top.move[4] });
        entry.bestMove = { from: bm.from, to: bm.to, promotion: bm.promotion, san: bm.san, uci: top.move };
      } catch { /* engine gave an unexpected move */ }
    }

    // book: consecutive positions from the start that appear in the opening db
    if (inBook && epd(fens[i]) in openings) {
      const o = openings[epd(fens[i])];
      if (o) opening = { eco: o[0], name: o[1] };
    } else {
      inBook = false;
    }
    entry.opening = opening;

    if (!top && !terminalEval(fenBefore)) {
      if (inBook) entry.classification = 'book';
      out.push(entry); // still waiting for engine data
      continue;
    }
    const evAfter = evals[i];
    if (!evAfter) {
      if (inBook) entry.classification = 'book';
      out.push(entry);
      continue;
    }

    const eBest = expected(toWhite(top.score, fenBefore), color);
    const same = lines.find((l) => l.move === uci);
    // prefer the score from the same search when the played move was one of the lines
    const ePlayed = terminalEval(fens[i]) ? expected(evAfter, color)
      : same ? expected(toWhite(same.score, fenBefore), color) : expected(evAfter, color);
    const loss = Math.max(0, eBest - ePlayed);
    entry.loss = loss;
    entry.accuracy = moveAccuracy(eBest * 100, ePlayed * 100);
    acc[color].push(entry.accuracy);

    const isTop = top.move === uci;
    let cls;
    if (isTop || loss <= THRESHOLDS.best) cls = 'best';
    else if (loss <= THRESHOLDS.excellent) cls = 'excellent';
    else if (loss <= THRESHOLDS.good) cls = 'good';
    else if (loss <= THRESHOLDS.inaccuracy) cls = 'inaccuracy';
    else if (loss <= THRESHOLDS.mistake) cls = 'mistake';
    else cls = 'blunder';

    // best alternative that is NOT the played move (for great / brilliant)
    const alts = lines.filter((l) => l.move !== uci).map((l) => expected(toWhite(l.score, fenBefore), color));
    const eAlt = alts.length ? Math.max(...alts) : null;

    // BRILLIANT: (near) best move that sacrifices material, not losing after,
    // and there was no other completely winning option.
    const sac = loss <= brilliant.maxLoss && ePlayed >= brilliant.minPlayed && (eAlt === null || eAlt < brilliant.maxAlt)
      ? sacrifice(fenBefore, mv, positions[i]?.lines?.[0]?.pv, brilliant.horizon) : null;
    if (sac && sac.firstReplyCaptures && (!brilliant.movedPieceTaken || sac.takesMovedPiece)
        && (!brilliant.newCapture || sac.newCapture)
        && sac.maxDown >= brilliant.minSacrifice && sac.endDown >= brilliant.minStillDown) {
      cls = 'brilliant';
    } else if (cls === 'best' && eAlt !== null && ePlayed - eAlt >= 0.15 && ePlayed >= 0.4) {
      // GREAT: the only good move (2nd best is much worse); obvious recaptures excluded
      const prev = moves[i - 2];
      const recapture = prev?.captured && mv.captured && prev.to === mv.to;
      if (!recapture) cls = 'great';
    }

    // MISS: opponent just erred, the mover had a big chance and let it go
    if ((cls === 'mistake' || cls === 'blunder' || cls === 'inaccuracy') && i >= 2) {
      const prevLoss = out[i - 2]?.loss;
      const ePrev = expected(evals[i - 2], color); // mover's E before the opponent's error
      if (prevLoss !== null && prevLoss >= THRESHOLDS.inaccuracy && ePrev !== null
          && eBest - ePrev >= 0.10 && loss >= THRESHOLDS.inaccuracy && ePlayed >= ePrev - 0.03) {
        cls = 'miss';
      }
    }

    if (new Chess(fenBefore).moves().length === 1) cls = 'forced';
    if (inBook) cls = 'book';
    entry.classification = cls;
    out.push(entry);
  }

  const summary = (arr) => {
    if (!arr.length) return null;
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const harmonic = arr.length / arr.reduce((a, b) => a + 1 / Math.max(1, b), 0);
    return (mean + harmonic) / 2;
  };

  return {
    moves: out,
    initialEval: evals[0] || { cp: 0 },
    accuracy: { w: summary(acc.w), b: summary(acc.b) },
    complete: out.every((m) => m.classification),
  };
}
