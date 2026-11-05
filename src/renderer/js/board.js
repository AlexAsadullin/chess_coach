/**
 * Lightweight DOM chessboard (chess.com "green" theme). Pieces keep their
 * DOM element across renders, so moving between plies slides them with a
 * very short CSS transition.
 */
import { PIECE_SETS } from '../vendor/piece-sets.js';
import { classificationIcon } from './icons.js';

/** Piece sets offered in Settings (keys of PIECE_SETS). */
export const PIECE_SET_NAMES = { cburnett: 'Classic', neo: 'Neo', chessnut: 'Chessnut', merida: 'Merida' };

const urlCache = {};
function pieceUrls(set) {
  if (!urlCache[set]) {
    const svgs = PIECE_SETS[set] || PIECE_SETS.cburnett;
    urlCache[set] = Object.fromEntries(Object.entries(svgs).map(([k, svg]) => [k, `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`]));
  }
  return urlCache[set];
}
export const pieceImage = (set, code) => pieceUrls(set)[code];

let pieceSet = 'cburnett';
/** Called by Settings; boards pick it up on their next render. */
export function setPieceSet(name) {
  pieceSet = PIECE_SETS[name] ? name : 'cburnett';
}
const FILES = 'abcdefgh';

export class Board {
  constructor(root) {
    this.root = root;
    this.orientation = 'w';
    this.pieceEls = new Map();
    root.classList.add('board');
    root.innerHTML = `
      <div class="board-squares"></div>
      <div class="board-highlights"></div>
      <div class="board-flash"></div>
      <div class="board-pieces"></div>
      <svg class="board-arrows" viewBox="0 0 800 800"></svg>
      <div class="board-badges"></div>`;
    this.squaresEl = root.querySelector('.board-squares');
    this.hlEl = root.querySelector('.board-highlights');
    this.flashEl = root.querySelector('.board-flash');
    this.piecesEl = root.querySelector('.board-pieces');
    this.arrowsEl = root.querySelector('.board-arrows');
    this.badgesEl = root.querySelector('.board-badges');
    this.#drawSquares();
  }

  setOrientation(color) {
    if (color === this.orientation) return;
    this.orientation = color;
    this.#drawSquares();
    this.root.classList.add('no-anim');
    if (this.last) this.render(this.last);
    void this.root.offsetWidth; // flush styles so the flip is instant
    this.root.classList.remove('no-anim');
  }

  /** Grid coordinates (0..7) for a square in the current orientation. */
  #xy(square) {
    const f = FILES.indexOf(square[0]);
    const r = Number(square[1]);
    return this.orientation === 'w' ? [f, 8 - r] : [7 - f, r - 1];
  }

  #drawSquares() {
    let html = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const f = this.orientation === 'w' ? x : 7 - x;
        const r = this.orientation === 'w' ? 8 - y : y + 1;
        const light = (f + r) % 2 === 1;
        let coords = '';
        if (x === 0) coords += `<span class="coord rank">${r}</span>`;
        if (y === 7) coords += `<span class="coord file">${FILES[f]}</span>`;
        html += `<div class="sq ${light ? 'light' : 'dark'}">${coords}</div>`;
      }
    }
    this.squaresEl.innerHTML = html;
  }

  /**
   * @param {{pieces: Array<{id,type,color,square}>, lastMove?: {from,to},
   *          badge?: {square, kind}, arrows?: Array<{from,to,color,knight?}>}} state
   */
  render(state) {
    this.last = state;
    // a red flash belongs to the move that caused it: clear it when the position changes
    const moveKey = state.lastMove ? `${state.lastMove.from}${state.lastMove.to}${state.pieces.length}` : 'start';
    if (moveKey !== this.moveKey) {
      this.moveKey = moveKey;
      this.flashEl.innerHTML = '';
    }
    // highlights
    this.hlEl.innerHTML = '';
    if (state.lastMove) {
      for (const sq of [state.lastMove.from, state.lastMove.to]) {
        this.hlEl.appendChild(this.#cell('hl', sq));
      }
    }
    // pieces
    const seen = new Set();
    for (const p of state.pieces) {
      seen.add(p.id);
      let el = this.pieceEls.get(p.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'piece';
        this.piecesEl.appendChild(el);
        this.pieceEls.set(p.id, el);
        el.style.transition = 'none';
        requestAnimationFrame(() => { el.style.transition = ''; });
      }
      const code = p.color + p.type;
      if (el.dataset.code !== `${pieceSet}:${code}`) {
        el.dataset.code = `${pieceSet}:${code}`;
        el.style.backgroundImage = pieceUrls(pieceSet)[code];
      }
      const [x, y] = this.#xy(p.square);
      el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
    }
    for (const [id, el] of this.pieceEls) {
      if (!seen.has(id)) {
        el.remove();
        this.pieceEls.delete(id);
      }
    }
    // badge: only touch the DOM when it actually changes, so it never flickers
    // while the analysis streams in or the same position is re-rendered
    const badgeKey = state.badge ? `${state.badge.square}:${state.badge.kind}:${this.orientation}` : '';
    if (badgeKey !== this.badgeKey) {
      this.badgeKey = badgeKey;
      this.badgesEl.innerHTML = '';
      if (state.badge) {
        const b = this.#cell('badge', state.badge.square);
        b.innerHTML = classificationIcon(state.badge.kind, 100);
        this.badgesEl.appendChild(b);
      }
    }
    // arrows
    this.arrowsEl.innerHTML = (state.arrows || []).map((a) => this.#arrow(a)).join('');
  }

  /**
   * Briefly mark squares in red under the pieces (captures and checks):
   * fades in fast, holds, fades out (~1.5 s, CSS animation). A new flash
   * replaces the previous one.
   */
  flash(squares) {
    this.flashEl.innerHTML = '';
    for (const sq of new Set(squares)) {
      const el = this.#cell('flash', sq);
      el.addEventListener('animationend', () => el.remove());
      this.flashEl.appendChild(el);
    }
  }

  #cell(cls, square) {
    const el = document.createElement('div');
    el.className = cls;
    const [x, y] = this.#xy(square);
    el.style.transform = `translate(${x * 100}%, ${y * 100}%)`;
    return el;
  }

  #arrow({ from, to, color = 'rgba(129,182,76,.85)', knight }) {
    const c = (sq) => {
      const [x, y] = this.#xy(sq);
      return [x * 100 + 50, y * 100 + 50];
    };
    const [x1, y1] = c(from);
    const [x2, y2] = c(to);
    const pts = [[x1, y1]];
    if (knight) {
      // L-shape like chess.com: long leg first
      if (Math.abs(x2 - x1) > Math.abs(y2 - y1)) pts.push([x2, y1]);
      else pts.push([x1, y2]);
    }
    pts.push([x2, y2]);
    // shorten the last segment so the head ends inside the target square
    const [px, py] = pts[pts.length - 2];
    const len = Math.hypot(x2 - px, y2 - py);
    const ux = (x2 - px) / len;
    const uy = (y2 - py) / len;
    const head = 38;
    const tipX = x2 - ux * 8;
    const tipY = y2 - uy * 8;
    const baseX = tipX - ux * head;
    const baseY = tipY - uy * head;
    const start = pts[0];
    const sx = knight ? start[0] : start[0] + ux * 22;
    const sy = knight ? start[1] : start[1] + uy * 22;
    const line = [[sx, sy], ...pts.slice(1, -1), [baseX, baseY]].map((p) => p.join(',')).join(' ');
    const nx = -uy * 26;
    const ny = ux * 26;
    return `<g opacity="1"><polyline points="${line}" fill="none" stroke="${color}" stroke-width="20" stroke-linejoin="miter"/>
      <polygon points="${tipX},${tipY} ${baseX + nx},${baseY + ny} ${baseX - nx},${baseY - ny}" fill="${color}"/></g>`;
  }
}
