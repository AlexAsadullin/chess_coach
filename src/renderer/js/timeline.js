/**
 * Replays a game once and records, for every ply, the FEN and the set of
 * pieces with stable ids — so the board can animate pieces sliding (not
 * re-rendering) when moving between plies.
 */
import { Chess } from '../vendor/chess.js';

/** @returns {{fens: string[], moves: object[], pieces: Array<Array<{id,type,color,square}>>}} */
export function buildTimeline(game) {
  const chess = game.startFen ? new Chess(game.startFen) : new Chess();
  const fens = [chess.fen()];
  const moves = [];
  let pieces = initialPieces(chess);
  const states = [pieces];
  for (const san of game.sans) {
    const mv = chess.move(san);
    moves.push(mv);
    fens.push(chess.fen());
    pieces = applyMove(pieces, mv);
    states.push(pieces);
  }
  return { fens, moves, pieces: states };
}

export function initialPieces(chess) {
  const out = [];
  let n = 0;
  for (const row of chess.board()) {
    for (const sq of row) {
      if (sq) out.push({ id: `p${n++}`, type: sq.type, color: sq.color, square: sq.square });
    }
  }
  return out;
}

/** Pure: returns a new piece list after a chess.js verbose move. */
export function applyMove(pieces, mv) {
  let next = pieces.map((p) => ({ ...p }));
  let capturedSq = null;
  if (mv.flags.includes('e')) capturedSq = mv.to[0] + mv.from[1];
  else if (mv.captured) capturedSq = mv.to;
  if (capturedSq) next = next.filter((p) => p.square !== capturedSq);

  const mover = next.find((p) => p.square === mv.from);
  if (mover) {
    mover.square = mv.to;
    if (mv.promotion) mover.type = mv.promotion;
  }
  const rank = mv.from[1];
  if (mv.flags.includes('k')) moveRook(next, `h${rank}`, `f${rank}`);
  if (mv.flags.includes('q')) moveRook(next, `a${rank}`, `d${rank}`);
  return next;
}

function moveRook(pieces, from, to) {
  const r = pieces.find((p) => p.square === from);
  if (r) r.square = to;
}
