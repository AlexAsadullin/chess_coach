/**
 * Evaluation graph. X = plies, Y = evaluation as winning chances.
 * The area ABOVE the curve is White, BELOW is Black: the more White is
 * winning, the lower the curve sits and the bigger the white area.
 */
import { CLASSIFICATIONS } from './icons.js';
import { escapeHtml } from './util.js';

const MARKED = new Set(['brilliant', 'great', 'miss', 'mistake', 'blunder']);

/**
 * @param {HTMLElement} el
 * @param {{evals: Array<object|null>, kinds: Array<string|null>, labels: string[],
 *          current: number, toWhitePct: (ev)=>number, format: (ev)=>string,
 *          onSelect: (ply:number)=>void}} opts
 *   evals[i] / labels[i] / kinds[i] describe the position after ply i (i = 0 is the start).
 */
export function renderEvalChart(el, opts) {
  const { evals, kinds, labels, current, toWhitePct, format, onSelect } = opts;
  const W = Math.max(280, el.clientWidth || 600);
  const H = 170;
  const padX = 0;
  const n = evals.length - 1;
  const x = (i) => padX + (n ? (i / n) * (W - 2 * padX) : 0);
  let last = 50;
  const pct = evals.map((ev) => {
    if (ev) last = toWhitePct(ev);
    return last;
  });
  const y = (p) => (p / 100) * H;
  const pts = pct.map((p, i) => [x(i), y(p)]);
  const curve = pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('');
  const whiteArea = `M0,0 L${x(0)},${pts[0][1]} ${curve.slice(1).replace(/M/g, 'L')} L${x(n)},0 Z`;

  const marks = kinds.map((k, i) => {
    if (!k || !MARKED.has(k)) return '';
    const [px, py] = pts[i];
    return `<circle cx="${px}" cy="${py}" r="4.5" fill="${CLASSIFICATIONS[k].color}" stroke="#262421" stroke-width="1.5"/>`;
  }).join('');

  const step = n ? (W - 2 * padX) / n : W;
  const hits = evals.map((_, i) => {
    const title = `${labels[i]}${evals[i] ? `  ${format(evals[i])}` : ''}${kinds[i] ? ` · ${CLASSIFICATIONS[kinds[i]].label}` : ''}`;
    return `<rect class="hit" data-ply="${i}" x="${x(i) - step / 2}" y="0" width="${step}" height="${H}"><title>${escapeHtml(title)}</title></rect>`;
  }).join('');

  el.innerHTML = `
    <svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" class="eval-chart-svg" role="img" aria-label="Evaluation graph">
      <rect width="${W}" height="${H}" fill="#2b2926"/>
      <path d="${whiteArea}" fill="#f4f4f2"/>
      <line x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}" stroke="#8b8987" stroke-width="1" stroke-dasharray="4 4" opacity=".7"/>
      <path d="${curve}" fill="none" stroke="#a0a09c" stroke-width="1.5"/>
      <line x1="${x(current)}" y1="0" x2="${x(current)}" y2="${H}" stroke="#81b64c" stroke-width="2"/>
      ${marks}
      <circle cx="${pts[current][0]}" cy="${pts[current][1]}" r="5" fill="#81b64c" stroke="#fff" stroke-width="2"/>
      <g class="hits" fill="transparent">${hits}</g>
    </svg>
    <div class="eval-chart-legend">
      <span><i class="sw sw-w"></i>White</span>
      <span class="hint">Click the graph to jump to a move</span>
      <span><i class="sw sw-b"></i>Black</span>
    </div>`;
  el.querySelector('.hits').onclick = (e) => {
    const r = e.target.closest('[data-ply]');
    if (r) onSelect(Number(r.dataset.ply));
  };
}
