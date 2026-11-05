/** Game review screen: eval bar, coach box, board, move navigation, best-line branch. */
import { Chess } from '../vendor/chess.js';
import { Board } from './board.js';
import { buildTimeline, applyMove } from './timeline.js';
import { startAnalysis } from './analysis/index.js';
import { toWhite } from './analysis/classify.js';
import { CLASSIFICATIONS, CLASSIFICATION_ORDER, classificationIcon, UI_ICONS } from './icons.js';
import { escapeHtml, toast } from './util.js';
import { sounds } from './sounds.js';
import { renderEvalChart } from './eval-chart.js';
import { current as settings, update as updateSettings, onSettings } from './settings.js';
import { openSettings } from './settings-view.js';

const ARROW_BEST = 'rgba(129,182,76,.9)';  // green: what should have been played
const ARROW_SHOW = 'rgba(92,139,176,.85)'; // blue: engine suggestion for the side to move

const PLAYED_IS_BEST = new Set(['book', 'best', 'brilliant', 'great', 'forced']);
// length of engine lines (half-moves) comes from Settings → "Best" line length (default 26)
const linePlies = () => settings().analysis.linePlies || 26;

export class ReviewView {
  constructor(root, { onBack }) {
    this.root = root;
    this.onBack = onBack;
    this.onKey = this.onKey.bind(this);
  }

  async open(game) {
    this.game = game;
    this.timeline = buildTimeline(game);
    this.n = this.timeline.moves.length;
    this.ply = 0;
    this.orientation = 'w';
    this.showArrow = false;
    this.branch = null;
    this.state = { status: 'running', progress: 0, result: null };
    this.#layout();
    this.board = new Board(this.root.querySelector('#board'));
    this.#fitBoard();
    this.resizeObs = new ResizeObserver(() => this.#fitBoard());
    this.resizeObs.observe(this.root.querySelector('.board-area'));
    document.addEventListener('keydown', this.onKey);
    this.analysis = startAnalysis(game, this.timeline, (s) => this.#onAnalysis(s));
    this.update();
  }

  close() {
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('mousedown', this.onDocClick);
    this.offSettings?.();
    this.resizeObs?.disconnect();
    this.analysis?.dispose();
  }

  #onAnalysis(s) {
    const wasError = this.state.status === 'error';
    const finished = s.status === 'done' && this.state.status !== 'done' && s.result?.complete;
    if (finished) {
      window.chessApi?.setAnalysisSummary?.(this.game.id, { engine: s.engine, accuracy: s.result.accuracy });
    }
    this.state = s;
    if (s.status === 'error' && !wasError) toast(s.message || 'Analysis failed', 'error');
    this.root.querySelector('.summary').innerHTML = this.#summaryHtml();
    this.root.querySelector('#moveList').innerHTML = this.#moveListHtml();
    this.#renderStatus();
    this.update();
  }

  get #moves() {
    return this.state.result?.moves || [];
  }

  // ---------- navigation ----------
  go(ply, { back = false } = {}) {
    const p = Math.max(0, Math.min(this.n, ply));
    if (p === this.ply && !this.branch) return;
    const backwards = back || (!this.branch && p < this.ply);
    this.ply = p;
    this.branch = null;
    this.update();
    if (backwards) sounds.play('back'); // stepping back: a different, softer knock
    else if (p > 0) this.#announce(this.timeline.moves[p - 1], this.timeline.fens[p]);
  }

  step(delta) {
    if (this.branch) {
      const b = this.branch;
      const idx = b.idx + delta;
      if (idx < 1) {
        this.go(b.basePly, { back: true }); // left of the first line move -> back into the game
        return;
      }
      if (idx > b.moves.length) {
        this.extendLine(); // past the end: offer/calculate more moves
        return;
      }
      const before = b.idx;
      b.idx = Math.max(1, Math.min(b.moves.length, idx));
      this.update();
      if (b.idx < before) sounds.play('back');
      else if (b.idx !== before) this.#announce(b.moves[b.idx - 1], b.fens[b.idx]);
      return;
    }
    this.go(this.ply + delta);
  }

  /**
   * A move just appeared on the board: play the move sound and, for captures
   * and checks, flash the square(s) red under the piece (capture: the square
   * it was taken on; check: the checked king).
   */
  #announce(move, fenAfter) {
    sounds.play('move');
    const squares = [];
    if (move.captured) squares.push(move.to);
    const c = new Chess(fenAfter);
    if (c.inCheck()) {
      const turn = c.turn();
      for (const row of c.board()) for (const p of row) if (p && p.type === 'k' && p.color === turn) squares.push(p.square);
    }
    if (squares.length) this.board.flash(squares);
  }

  /** << : start of the game, or of the engine line when one is open. */
  toStart() {
    const b = this.branch;
    if (!b) return this.go(0);
    if (b.idx === 1) return undefined;
    b.idx = 1;
    this.update();
    return sounds.play('back');
  }

  /** >> : end of the game, or of the engine line when one is open. */
  toEnd() {
    const b = this.branch;
    if (!b) return this.go(this.n);
    if (!b.moves.length || b.idx === b.moves.length) return undefined;
    b.idx = b.moves.length;
    this.update();
    return this.#announce(b.moves[b.idx - 1], b.fens[b.idx]);
  }

  onKey(e) {
    if (e.target instanceof Element && e.target.closest('input, textarea')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const keys = {
      ArrowLeft: () => this.step(-1),
      ArrowRight: () => this.step(1),
      ArrowUp: () => this.toStart(),
      Home: () => this.toStart(),
      ArrowDown: () => this.toEnd(),
      End: () => this.toEnd(),
      f: () => this.flip(),
      Escape: () => {
        if (this.chartOpen) this.toggleChart(false);
        else if (this.branch) this.toggleBest();
        else this.onBack();
      },
    };
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    }
  }

  flip() {
    this.orientation = this.orientation === 'w' ? 'b' : 'w';
    this.board.setOrientation(this.orientation);
    this.root.querySelector('.review').classList.toggle('flipped', this.orientation === 'b');
    this.update();
  }

  // ---------- engine lines ("Best" and "after the mistake") ----------
  toggleBest() {
    if (this.branch) this.closeLine();
    else this.openLine('best');
  }

  closeLine() {
    const back = this.branch.gamePly;
    this.branch = null;
    this.ply = back;
    this.update();
  }

  /**
   * kind 'best':  the engine's best move instead of the game move, then best
   *               play for both sides (what should have happened).
   * kind 'after': from the position after the game move, best play for both
   *               sides (what the mistake allows — why it is bad).
   */
  openLine(kind) {
    const gamePly = this.branch ? this.branch.gamePly : this.ply;
    const info = this.#moves[gamePly - 1];
    if (!info?.bestMove) return;
    let basePly;
    let firstMove = null;
    let preview;
    if (kind === 'best') {
      basePly = gamePly - 1;
      firstMove = info.bestMove.uci;
      preview = info.bestPv.length ? info.bestPv : [firstMove];
    } else {
      if (gamePly >= this.n && !this.#moves[gamePly]?.bestPv?.length) {
        if (new Chess(this.timeline.fens[gamePly]).isGameOver()) return;
      }
      basePly = gamePly;
      preview = this.#moves[gamePly]?.bestPv || [];
    }
    const fen = this.timeline.fens[basePly];
    const plies = linePlies();
    const branch = {
      kind, basePly, gamePly, idx: 1, loading: true, baseFen: fen, steps: [], target: plies,
      preview: preview.slice(0, plies),
    };
    this.#setBranchMoves(branch, fen, branch.preview.map((move) => ({ move })), null);
    this.branch = branch;
    this.update();
    if (branch.moves.length) this.#announce(branch.moves[0], branch.fens[1]);

    const onStep = (p) => {
      if (this.branch !== branch) return;
      const streamed = p.moves;
      // keep showing the (longer) quick preview until the exact line catches up
      const samePrefix = streamed.every((m, i) => branch.preview[i] === m.move);
      const steps = !p.done && samePrefix && streamed.length < branch.preview.length
        ? branch.preview.map((move, i) => streamed[i] || { move })
        : streamed;
      const hadMoves = branch.moves.length;
      this.#setBranchMoves(branch, fen, steps, p.done ? p.finalScore : null);
      if (p.done) branch.steps = streamed;
      branch.computed = streamed.length;
      branch.loading = !p.done;
      branch.idx = Math.max(1, Math.min(branch.idx, branch.moves.length));
      this.update();
      if (!hadMoves && branch.moves.length) this.#announce(branch.moves[0], branch.fens[1]);
    };
    this.analysis.bestLine(fen, { firstMove, plies }, onStep)
      .then((line) => {
        onStep({ ...line, done: true });
        this.#prepareOtherTab(kind, gamePly, plies);
      })
      .catch((err) => {
        if (this.branch !== branch) return;
        branch.loading = false;
        this.update();
        toast(`Could not calculate the line: ${err.message}`, 'error');
      });
  }

  /**
   * When Best is pressed for a move, also prepare the other tab of the SAME
   * move ("Best" ↔ "After …") right after the one on screen, so switching tabs
   * is instant. Nothing is ever calculated for moves the user didn't open.
   */
  #prepareOtherTab(kind, gamePly, plies) {
    if (!this.analysis.prefetchLines) return;
    const info = this.#moves[gamePly - 1];
    if (kind === 'best') {
      if (!new Chess(this.timeline.fens[gamePly]).isGameOver()) this.analysis.prefetchLines([{ fen: this.timeline.fens[gamePly], plies }]);
    } else {
      this.analysis.prefetchLines([{ fen: this.timeline.fens[gamePly - 1], firstMove: info.bestMove.uci, plies }]);
    }
  }

  /** Can the line on screen be continued? (finished, and the game isn't over at its end) */
  #canExtend(b = this.branch) {
    if (!b || b.loading || !b.moves.length) return false;
    return !new Chess(b.fens[b.fens.length - 1]).isGameOver();
  }

  /**
   * "Calculate more": continue the line on screen from its last position by
   * another `linePlies()` half-moves (only when the user asks for it).
   * "Back to game" still returns to the game move, however long the line got.
   */
  extendLine() {
    const b = this.branch;
    if (!this.#canExtend(b)) return;
    const plies = linePlies();
    const startFen = b.fens[b.fens.length - 1];
    const baseSteps = b.steps.slice();
    const firstNew = baseSteps.length + 1;
    Object.assign(b, { loading: true, computed: 0, target: plies });
    this.update();
    const onStep = (p) => {
      if (this.branch !== b) return;
      const hadNew = b.moves.length >= firstNew;
      this.#setBranchMoves(b, b.baseFen, [...baseSteps, ...p.moves], p.done ? p.finalScore : null);
      b.computed = p.moves.length;
      b.loading = !p.done;
      if (p.done) b.steps = [...baseSteps, ...p.moves];
      if (!hadNew && b.moves.length >= firstNew) {
        b.idx = firstNew; // jump to the first new move
        this.#announce(b.moves[b.idx - 1], b.fens[b.idx]);
      }
      this.update();
    };
    this.analysis.bestLine(startFen, { plies }, onStep)
      .then((line) => onStep({ ...line, done: true }))
      .catch((err) => {
        if (this.branch !== b) return;
        b.loading = false;
        this.update();
        toast(`Could not calculate more moves: ${err.message}`, 'error');
      });
  }

  /** steps: [{move, scoreBefore?}] — builds moves, piece states and evals. */
  #setBranchMoves(branch, fen, steps, finalScore) {
    const chess = new Chess(fen);
    const moves = [];
    const fens = [fen];
    for (const s of steps) {
      try {
        moves.push(chess.move({ from: s.move.slice(0, 2), to: s.move.slice(2, 4), promotion: s.move[4] }));
        fens.push(chess.fen());
      } catch {
        break;
      }
    }
    const pieces = [this.timeline.pieces[branch.basePly]];
    moves.forEach((m) => pieces.push(applyMove(pieces[pieces.length - 1], m)));
    // eval after move k = engine score of the position before move k+1
    const evals = [null];
    for (let k = 1; k <= moves.length; k++) {
      const c = new Chess(fens[k]);
      if (c.isCheckmate()) evals.push({ mate: 0, winner: moves[k - 1].color });
      else if (c.isDraw() || c.isStalemate()) evals.push({ draw: true });
      else if (k < moves.length && steps[k]?.scoreBefore) evals.push(toWhite(steps[k].scoreBefore, fens[k]));
      else if (k === moves.length && finalScore) evals.push(toWhite(finalScore, fens[k]));
      else evals.push(null);
    }
    Object.assign(branch, { moves, fens, pieces, evals });
  }

  // ---------- rendering ----------
  #layout() {
    const g = this.game;
    this.root.innerHTML = `
      <div class="review">
        <header class="review-header">
          <button class="btn btn-ghost back-btn" id="backBtn" title="Back to games (Esc)">${UI_ICONS.back}<span>Games</span></button>
          <div class="review-title">
            <span class="title-main">${escapeHtml(g.name)}</span>
            <span class="title-sub">${escapeHtml([g.event, g.date, g.result].filter(Boolean).join(' · '))}</span>
          </div>
          <div class="engine-status" id="engineStatus"></div>
          <button class="icon-btn sound-btn" id="soundBtn"></button>
          <button class="icon-btn sound-btn" id="reviewSettingsBtn" title="Settings">${UI_ICONS.settings}</button>
        </header>

        <div class="review-body">
          <main class="review-main">
            <div class="eval-row">
              <div class="eval-bar" id="evalBar" title="Evaluation">
                <div class="eval-fill"></div>
                <span class="eval-score"></span>
                <span class="eval-mid"></span>
              </div>
              <button class="info-btn" id="chartBtn" title="Evaluation graph" aria-expanded="false">${UI_ICONS.info}</button>
              <div class="eval-chart-pop" id="evalChart" hidden></div>
            </div>

            <div class="coach" id="coach">
              <div class="coach-head"></div>
              <div class="coach-line" hidden></div>
              <div class="coach-text" aria-readonly="true">${UI_ICONS.sparkles}<span>AI explanation of this move will appear here.</span></div>
            </div>

            <div class="board-area">
              <div class="board-stack">
                <div class="player player-top"></div>
                <div id="board"></div>
                <div class="player player-bottom"></div>
              </div>
            </div>

            <nav class="move-nav">
              <button class="nav-arrow nav-jump" id="startBtn" title="To the beginning (↑ / Home)">${UI_ICONS.chevronsLeft}</button>
              <button class="nav-arrow" id="prevBtn" title="Previous move (←)">${UI_ICONS.chevronLeft}</button>
              <div class="nav-moves">
                <button class="nav-move prev" id="navPrev"></button>
                <button class="nav-move current" id="navCur"></button>
                <button class="nav-move next" id="navNext"></button>
              </div>
              <button class="nav-arrow" id="nextBtn" title="Next move (→)">${UI_ICONS.chevronRight}</button>
              <button class="nav-arrow nav-jump" id="endBtn" title="To the end (↓ / End)">${UI_ICONS.chevronsRight}</button>
            </nav>

            <div class="review-actions">
              <button class="btn btn-secondary" id="showBtn" title="Show the best move for the side to move as an arrow">${UI_ICONS.eye}<span>Show best</span></button>
              <button class="btn btn-secondary" id="bestBtn" title="Explore the engine's best line instead of the game move">${UI_ICONS.star}<span>Best</span></button>
              <button class="btn btn-secondary" id="flipBtn" title="Flip board (F)">${UI_ICONS.flip}<span>Flip board</span></button>
            </div>
          </main>

          <aside class="review-side">
            <div class="summary">${this.#summaryHtml()}</div>
            <div class="move-list" id="moveList">${this.#moveListHtml()}</div>
          </aside>
        </div>
      </div>`;

    const $ = (s) => this.root.querySelector(s);
    $('#backBtn').onclick = () => this.onBack();
    $('#prevBtn').onclick = () => this.step(-1);
    $('#nextBtn').onclick = () => this.step(1);
    $('#startBtn').onclick = () => this.toStart();
    $('#endBtn').onclick = () => this.toEnd();
    $('#navPrev').onclick = () => this.step(-1);
    $('#navNext').onclick = () => this.step(1);
    $('#flipBtn').onclick = () => this.flip();
    $('#showBtn').onclick = () => { this.showArrow = !this.showArrow; this.update(); };
    $('#bestBtn').onclick = () => this.toggleBest();
    $('#chartBtn').onclick = (e) => {
      e.stopPropagation();
      this.toggleChart();
    };
    this.onDocClick = (e) => {
      if (this.chartOpen && !e.target.closest('#evalChart, #chartBtn')) this.toggleChart(false);
    };
    document.addEventListener('mousedown', this.onDocClick);
    const soundBtn = $('#soundBtn');
    const paintSound = () => {
      const on = settings().sound.enabled;
      soundBtn.innerHTML = on ? UI_ICONS.volumeOn : UI_ICONS.volumeOff;
      soundBtn.title = on ? 'Sound on' : 'Sound off';
      soundBtn.classList.toggle('off', !on);
    };
    paintSound();
    soundBtn.onclick = async () => {
      await updateSettings({ sound: { enabled: !settings().sound.enabled } });
      sounds.play('move');
    };
    $('#reviewSettingsBtn').onclick = () => openSettings();
    this.offSettings = onSettings(() => {
      paintSound();
      this.update();
    });
    $('#moveList').onclick = (e) => {
      const m = e.target.closest('[data-ply]');
      if (m) this.go(Number(m.dataset.ply));
    };
    $('#coach').addEventListener('click', (e) => {
      const t = e.target.closest('[data-line]');
      if (t && this.branch && t.dataset.line !== this.branch.kind) this.openLine(t.dataset.line);
    });
    $('.coach-line').addEventListener('click', (e) => {
      if (e.target.closest('[data-more]')) this.extendLine();
    });
    $('.coach-line').onclick = (e) => {
      const m = e.target.closest('[data-bidx]');
      if (m && this.branch) {
        this.branch.idx = Number(m.dataset.bidx);
        this.update();
      }
    };
    this.#renderStatus();
  }

  toggleChart(open = !this.chartOpen) {
    this.chartOpen = open;
    const el = this.root.querySelector('#evalChart');
    el.hidden = !open;
    this.root.querySelector('#chartBtn').setAttribute('aria-expanded', String(open));
    this.root.querySelector('#chartBtn').classList.toggle('active', open);
    if (open) this.#renderChart();
  }

  #renderChart() {
    const moves = this.#moves;
    const evals = [this.state.result?.initialEval || null, ...this.timeline.moves.map((_, i) => moves[i]?.evalAfter || null)];
    const kinds = [null, ...this.timeline.moves.map((_, i) => moves[i]?.classification || null)];
    const labels = ['Start', ...this.timeline.moves.map((m, i) => this.#label(m, i + 1))];
    renderEvalChart(this.root.querySelector('#evalChart'), {
      evals,
      kinds,
      labels,
      current: this.branch ? this.branch.gamePly : this.ply,
      toWhitePct: evalToWhitePct,
      format: (ev) => formatEval(ev),
      onSelect: (p) => this.go(p),
    });
  }

  #renderStatus() {
    const el = this.root.querySelector('#engineStatus');
    const s = this.state;
    if (s.status === 'error') {
      el.innerHTML = `<span class="status-chip error" title="${escapeHtml(s.message || '')}">Engine unavailable</span>`;
    } else if (s.status === 'running') {
      const pct = Math.round((s.progress || 0) * 100);
      const label = s.stage === 'deep' ? 'Deep analysis' : 'Analyzing';
      el.innerHTML = `<span class="status-chip running" title="Quick pass first (depth 12), then a deep pass (depth 20) refines every move"><span class="progress"><span style="width:${pct}%"></span></span>${label} ${pct}%</span>`;
    } else {
      el.innerHTML = `<span class="status-chip done">${escapeHtml(s.engine || 'Stockfish')}</span>`;
    }
  }

  #fitBoard() {
    const area = this.root.querySelector('.board-area');
    const stack = this.root.querySelector('.board-stack');
    if (!area || !stack) return;
    const players = [...stack.querySelectorAll('.player')].reduce((h, el) => h + el.offsetHeight, 0);
    const size = Math.max(240, Math.floor(Math.min(area.clientWidth, area.clientHeight - players) / 8) * 8);
    stack.style.width = `${size}px`;
    this.root.querySelector('#board').style.height = `${size}px`;
  }

  #moveNumber(ply, fen0 = this.timeline.fens[0]) {
    const f = fen0.split(' ');
    const startNum = Number(f[5]) || 1;
    const offset = f[1] === 'b' ? 1 : 0;
    return startNum + Math.floor((ply - 1 + offset) / 2);
  }

  #label(mv, ply) {
    return `${this.#moveNumber(ply)}${mv.color === 'w' ? '.' : '...'} ${mv.san}`;
  }

  update() {
    if (this.branch) this.#renderBranch();
    else this.#renderGame();
    if (this.chartOpen) this.#renderChart();
    const $ = (s) => this.root.querySelector(s);
    $('#showBtn').classList.toggle('active', this.showArrow);
    const top = this.orientation === 'w' ? 'b' : 'w';
    this.#renderPlayer($('.player-top'), top);
    this.#renderPlayer($('.player-bottom'), this.orientation);

    const list = $('#moveList');
    list.querySelector('.ml-move.active')?.classList.remove('active');
    const activePly = this.branch ? this.branch.gamePly : this.ply;
    const act = list.querySelector(`[data-ply="${activePly}"]`);
    if (act) {
      act.classList.add('active');
      act.scrollIntoView({ block: 'nearest' });
    } else if (activePly === 0) list.scrollTop = 0;
  }

  #renderGame() {
    const { ply, n, timeline } = this;
    const moves = this.#moves;
    const info = ply > 0 ? moves[ply - 1] : null;
    const kind = info?.classification || null;
    const bestAvailable = Boolean(info?.bestMove) && kind && !PLAYED_IS_BEST.has(kind);
    const lastMove = ply > 0 ? timeline.moves[ply - 1] : null;

    const arrows = [];
    // green arrow: the move that should have been played instead (chess.com style)
    if (bestAvailable && settings().analysis.bestArrow) {
      arrows.push({ ...this.#arrow(info.bestMove, timeline.pieces[ply - 1]), color: ARROW_BEST });
    }
    const nextBest = moves[ply]?.bestMove;
    if (this.showArrow && nextBest) arrows.push({ ...this.#arrow(nextBest, timeline.pieces[ply]), color: ARROW_SHOW });

    this.board.render({
      pieces: timeline.pieces[ply],
      lastMove,
      badge: lastMove && kind ? { square: lastMove.to, kind } : null,
      arrows,
    });

    const evalNow = ply === 0 ? this.state.result?.initialEval : info?.evalAfter;
    this.#renderEval(evalNow);

    // coach
    const head = this.root.querySelector('.coach-head');
    head.className = 'coach-head';
    this.root.querySelector('.coach-line').hidden = true;
    if (ply === 0) {
      head.innerHTML = `<span class="coach-title">Starting position</span><span class="coach-hint">Use → or the arrows below to step through the game.</span>`;
    } else if (!kind) {
      head.innerHTML = `<span class="spinner"></span><span class="coach-title">${escapeHtml(lastMove.san)}</span><span class="coach-hint">Analyzing…</span>`;
    } else {
      const c = CLASSIFICATIONS[kind];
      const extra = kind === 'book' && info.opening
        ? `<span class="coach-hint">${escapeHtml(info.opening.name)}</span>`
        : bestAvailable ? `<span class="coach-hint">Best was <b>${escapeHtml(info.bestMove.san)}</b></span>` : '';
      head.innerHTML = `${classificationIcon(kind, 26)}<span class="coach-title" style="color:${c.color}">${escapeHtml(lastMove.san)} ${c.phrase}</span>${extra}${evalNow ? `<span class="coach-eval">${formatEval(evalNow)}</span>` : ''}`;
    }

    // nav
    const $ = (s) => this.root.querySelector(s);
    const setNav = (el, p, withIcon) => {
      if (p < 1 || p > n) {
        el.innerHTML = '<span class="nav-empty">—</span>';
        el.disabled = true;
        return;
      }
      el.disabled = false;
      const k = moves[p - 1]?.classification;
      el.innerHTML = `${withIcon && k ? classificationIcon(k, 18) : ''}<span>${escapeHtml(this.#label(timeline.moves[p - 1], p))}</span>`;
    };
    setNav($('#navPrev'), ply - 1, true);
    if (ply === 0) {
      $('#navCur').innerHTML = '<span>Start</span>';
      $('#navCur').disabled = true;
    } else setNav($('#navCur'), ply, true);
    setNav($('#navNext'), ply + 1, false);
    $('#prevBtn').disabled = ply === 0;
    $('#nextBtn').disabled = ply === n;
    $('#startBtn').disabled = ply === 0;
    $('#endBtn').disabled = ply === n;
    $('#startBtn').title = 'To the beginning (↑ / Home)';
    $('#endBtn').title = 'To the end (↓ / End)';
    $('#nextBtn').classList.remove('more');
    $('#navNext').title = '';
    const bestBtn = $('#bestBtn');
    bestBtn.disabled = !bestAvailable;
    bestBtn.classList.remove('active');
    bestBtn.querySelector('span').textContent = 'Best';
    $('#showBtn').disabled = !nextBest;
  }

  #renderBranch() {
    const b = this.branch;
    const gameMove = this.timeline.moves[b.gamePly - 1];
    const mv = b.moves[b.idx - 1] || null; // null while an "after" line has no moves yet
    const shownIdx = mv ? b.idx : 0;
    const arrows = [];
    const next = b.moves[shownIdx];
    if (this.showArrow && next) arrows.push({ ...this.#arrow(next, b.pieces[shownIdx]), color: ARROW_SHOW });
    this.board.render({
      pieces: b.pieces[shownIdx],
      lastMove: mv || gameMove,
      badge: mv && b.kind === 'best' && b.idx === 1 ? { square: mv.to, kind: 'best' }
        : !mv ? { square: gameMove.to, kind: this.#moves[b.gamePly - 1].classification } : null,
      arrows,
    });
    // eval: nearest known eval at or before this step
    let ev = null;
    for (let k = shownIdx; k >= 1 && !ev; k--) ev = b.evals[k];
    this.#renderEval(ev || this.#moves[b.gamePly - (b.kind === 'best' ? 2 : 1)]?.evalAfter || this.state.result?.initialEval);

    // coach: tabs to switch between the two lines, then what this step is
    const info = this.#moves[b.gamePly - 1];
    const cls = CLASSIFICATIONS[info.classification];
    const total = b.moves.length;
    const progress = b.loading ? `<span class="spinner" title="Calculating"></span><span class="coach-hint">calculating ${b.computed || 0}/${b.target}…</span>` : '';
    const tabs = `<div class="line-tabs" role="tablist">
        <button class="${b.kind === 'best' ? 'on' : ''}" data-line="best" role="tab">${classificationIcon('best', 16)}Best: ${escapeHtml(info.bestMove.san)}</button>
        <button class="${b.kind === 'after' ? 'on' : ''}" data-line="after" role="tab">${classificationIcon(info.classification, 16)}After ${escapeHtml(gameMove.san)}</button>
      </div>`;
    let title;
    if (!mv) title = `<span class="coach-title">After ${escapeHtml(gameMove.san)}</span>`;
    else if (b.kind === 'best' && b.idx === 1) {
      title = `<span class="coach-title" style="color:${CLASSIFICATIONS.best.color}">${escapeHtml(mv.san)} is best</span><span class="coach-hint">instead of ${escapeHtml(gameMove.san)}</span>`;
    } else {
      const what = b.kind === 'best' ? 'Best line' : `What ${escapeHtml(gameMove.san)} allows`;
      title = `<span class="branch-tag ${b.kind === 'after' ? 'warn' : ''}">${what}</span><span class="coach-title">${escapeHtml(mv.san)}</span><span class="coach-hint">move ${b.idx} of ${total}</span>`;
    }
    const head = this.root.querySelector('.coach-head');
    head.className = 'coach-head branch-mode';
    head.innerHTML = `${tabs}<div class="coach-step">${title}${progress}${ev ? `<span class="coach-eval">${formatEval(ev)}</span>` : ''}</div>`;
    head.querySelector('.line-tabs').style.setProperty('--accent', cls.color);

    const line = this.root.querySelector('.coach-line');
    line.hidden = false;
    line.innerHTML = b.moves.map((m, i) => {
      const ply = b.basePly + i + 1;
      const num = m.color === 'w' || i === 0 ? `<span class="bl-num">${this.#moveNumber(ply)}${m.color === 'w' ? '.' : '...'}</span>` : '';
      return `${num}<button class="bl-move ${i + 1 === b.idx && mv ? 'active' : ''}" data-bidx="${i + 1}">${escapeHtml(m.san)}</button>`;
    }).join('') || '<span class="coach-hint">Waiting for the engine…</span>';
    if (this.#canExtend(b)) line.insertAdjacentHTML('beforeend', `<button class="bl-more" data-more>+ ${linePlies()} more moves</button>`);
    line.querySelector('.bl-move.active')?.scrollIntoView({ block: 'nearest' });

    const $ = (sel) => this.root.querySelector(sel);
    const setNav = (el, html, enabled) => {
      el.innerHTML = html;
      el.disabled = !enabled;
    };
    const lbl = (i) => escapeHtml(this.#label(b.moves[i - 1], b.basePly + i));
    if (shownIdx <= 1) {
      const p = b.basePly;
      setNav($('#navPrev'), p > 0 ? `<span>${escapeHtml(this.#label(this.timeline.moves[p - 1], p))}</span>` : '<span>Start</span>', true);
    } else setNav($('#navPrev'), `<span>${lbl(shownIdx - 1)}</span>`, true);
    setNav($('#navCur'), mv ? `${b.kind === 'best' && b.idx === 1 ? classificationIcon('best', 18) : ''}<span>${lbl(shownIdx)}</span>` : '<span>…</span>', false);
    const canMore = shownIdx >= total && this.#canExtend(b);
    setNav($('#navNext'),
      shownIdx < total ? `<span>${lbl(shownIdx + 1)}</span>`
        : canMore ? `<span class="nav-more">+ Calculate ${linePlies()} more</span>`
          : '<span class="nav-empty">—</span>',
      shownIdx < total || canMore);
    $('#navNext').title = canMore ? `The line ends here. Click to calculate ${linePlies()} more moves.` : '';
    $('#prevBtn').disabled = false;
    $('#nextBtn').disabled = shownIdx >= total && !canMore;
    $('#startBtn').disabled = shownIdx <= 1;
    $('#endBtn').disabled = shownIdx >= total;
    $('#startBtn').title = 'To the first move of this line';
    $('#endBtn').title = 'To the last move of this line';
    $('#nextBtn').classList.toggle('more', canMore);
    const bestBtn = $('#bestBtn');
    bestBtn.disabled = false;
    bestBtn.classList.add('active');
    bestBtn.querySelector('span').textContent = 'Back to game';
    $('#showBtn').disabled = !next;
  }

  #arrow(mv, pieces) {
    const knight = pieces.find((p) => p.square === mv.from)?.type === 'n';
    return { from: mv.from, to: mv.to, knight };
  }

  #renderEval(ev) {
    const bar = this.root.querySelector('#evalBar');
    if (!ev) return; // keep the last known value while analysing
    const whitePct = evalToWhitePct(ev);
    bar.querySelector('.eval-fill').style.width = `${whitePct}%`;
    const score = bar.querySelector('.eval-score');
    score.textContent = formatEval(ev, true);
    const whiteAhead = whitePct >= 50;
    score.classList.toggle('on-white', whiteAhead);
    score.classList.toggle('on-black', !whiteAhead);
  }

  #renderPlayer(el, color) {
    const g = this.game;
    const name = color === 'w' ? g.white : g.black;
    const elo = color === 'w' ? g.whiteElo : g.blackElo;
    const won = (g.result === '1-0' && color === 'w') || (g.result === '0-1' && color === 'b');
    const fen = this.branch ? this.branch.fens[this.branch.idx] : this.timeline.fens[this.ply];
    const atEnd = !this.branch && this.ply === this.n;
    const toMove = !atEnd && fen.split(' ')[1] === color;
    el.innerHTML = `<span class="avatar avatar-${color}"></span><span class="pname">${escapeHtml(name)}</span>${elo ? `<span class="pelo">(${escapeHtml(elo)})</span>` : ''}${won && atEnd ? '<span class="pwin">Winner</span>' : ''}${toMove ? '<span class="tomove" title="To move"></span>' : ''}`;
  }

  #summaryHtml() {
    const moves = this.#moves;
    const counts = { w: {}, b: {} };
    this.timeline.moves.forEach((mv, i) => {
      const k = moves[i]?.classification;
      if (k) counts[mv.color][k] = (counts[mv.color][k] || 0) + 1;
    });
    const acc = this.state?.result?.accuracy || {};
    const done = this.state?.status === 'done';
    const fmt = (a) => (a == null || !done ? '—' : a.toFixed(1));
    const rows = CLASSIFICATION_ORDER.map((k) => {
      const c = CLASSIFICATIONS[k];
      return `<div class="sum-row"><span class="sum-n">${counts.w[k] || 0}</span><span class="sum-label" style="color:${c.color}">${classificationIcon(k, 20)}${c.label}</span><span class="sum-n">${counts.b[k] || 0}</span></div>`;
    }).join('');
    return `<div class="sum-players"><span>${escapeHtml(this.game.white)}</span><span>${escapeHtml(this.game.black)}</span></div>
      <div class="sum-acc"><span class="acc acc-w">${fmt(acc.w)}</span><span class="acc-label">Accuracy</span><span class="acc acc-b">${fmt(acc.b)}</span></div>
      ${rows}`;
  }

  #moveListHtml() {
    const { moves } = this.timeline;
    const info = this.#moves;
    const cells = [];
    let open = false;
    moves.forEach((mv, i) => {
      const ply = i + 1;
      if (mv.color === 'w' || !open) {
        if (open) cells.push('</div>');
        cells.push(`<div class="ml-row"><span class="ml-num">${this.#moveNumber(ply)}.</span>`);
        if (mv.color === 'b') cells.push('<span class="ml-move empty">…</span>');
        open = true;
      }
      const k = info[i]?.classification;
      const icon = k ? classificationIcon(k, 16) : '<span class="pending-dot"></span>';
      const active = !this.branch && ply === this.ply ? ' active' : '';
      cells.push(`<button class="ml-move${active}" data-ply="${ply}" title="${k ? CLASSIFICATIONS[k].label : 'Analyzing…'}">${icon}<span>${escapeHtml(mv.san)}</span></button>`);
    });
    if (open) cells.push('</div>');
    return cells.join('');
  }
}

/** Lichess-style winning-chances curve so ±3 pawns ≈ 75/25 split. */
export function evalToWhitePct(ev) {
  if (!ev) return 50;
  if (ev.draw) return 50;
  if (ev.winner) return ev.winner === 'w' ? 100 : 0;
  if (ev.mate !== undefined) return ev.mate > 0 ? 100 : 0;
  const chances = 2 / (1 + Math.exp(-0.00368208 * ev.cp)) - 1;
  return Math.max(2, Math.min(98, 50 + 50 * chances));
}

export function formatEval(ev, short = false) {
  if (!ev) return '0.0';
  if (ev.draw) return '½-½';
  if (ev.winner) return ev.winner === 'w' ? '1-0' : '0-1';
  if (ev.mate !== undefined) return `${ev.mate > 0 ? '+' : '-'}M${Math.abs(ev.mate)}`;
  const v = ev.cp / 100;
  const s = Math.abs(v) >= 10 && short ? Math.abs(v).toFixed(0) : Math.abs(v).toFixed(1);
  if (v > 0.04) return `+${s}`;
  if (v < -0.04) return `-${s}`;
  return '0.0';
}
