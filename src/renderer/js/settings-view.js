/** Settings window: board, sound, analysis, AI API keys. */
import { api } from './api.js';
import { openModal, confirmDialog } from './modal.js';
import { BOARD_THEMES, current, snapshot, update, keyOp, onSettings } from './settings.js';
import { sounds } from './sounds.js';
import { escapeHtml, toast } from './util.js';
import { UI_ICONS } from './icons.js';
import { PIECE_SET_NAMES, pieceImage } from './board.js';

export function openSettings() {
  const { el, close } = openModal({ title: 'Settings', className: 'modal-settings', body: '<div class="settings"></div>', onClose: () => off() });
  const root = el.querySelector('.settings');
  const render = () => {
    const s = current();
    const snap = snapshot() || { keys: [], providers: ['OpenAI', 'Anthropic', 'Google', 'Mistral', 'Other'], encrypted: true };
    const seg = (name, value, options) => `<div class="seg" data-setting="${name}">${options.map(([v, label]) =>
      `<button class="${String(v) === String(value) ? 'on' : ''}" data-value="${v}">${label}</button>`).join('')}</div>`;
    const toggle = (name, on) => `<button class="toggle ${on ? 'on' : ''}" data-toggle="${name}" role="switch" aria-checked="${on}"><span></span></button>`;
    root.innerHTML = `
      <section>
        <h3>Board</h3>
        <div class="set-row"><span>Board theme</span>
          <div class="themes">${Object.entries(BOARD_THEMES).map(([k, t]) => `
            <button class="theme ${s.board.theme === k ? 'on' : ''}" data-theme="${k}" title="${t.label}">
              <i style="background:${t.light}"></i><i style="background:${t.dark}"></i><i style="background:${t.dark}"></i><i style="background:${t.light}"></i>
            </button>`).join('')}</div></div>
        <div class="set-row"><span>Pieces</span>
          <div class="piece-sets">${Object.entries(PIECE_SET_NAMES).map(([k, label]) => `
            <button class="piece-set ${s.board.pieces === k ? 'on' : ''}" data-pieces="${k}" title="${label}">
              <span class="ps-preview" style="background:${BOARD_THEMES[s.board.theme]?.light || '#ebecd0'}">
                <i style='background-image:${pieceImage(k, 'wn')}'></i><i style='background-image:${pieceImage(k, 'bq')}'></i>
              </span><small>${label}</small>
            </button>`).join('')}</div></div>
        <div class="set-row"><span>Show coordinates</span>${toggle('board.coordinates', s.board.coordinates)}</div>
        <div class="set-row"><span>Piece animation</span>${seg('board.animation', s.board.animation, [['off', 'Off'], ['fast', 'Fast'], ['normal', 'Normal']])}</div>
        <div class="set-row"><span>Show the best move as a green arrow<small>after inaccuracies, mistakes, misses and blunders</small></span>${toggle('analysis.bestArrow', s.analysis.bestArrow)}</div>
      </section>
      <section>
        <h3>Sound</h3>
        <div class="set-row"><span>Move sounds</span>${toggle('sound.enabled', s.sound.enabled)}</div>
        <div class="set-row"><span>Volume</span><input type="range" min="0" max="100" step="5" value="${s.sound.volume}" id="volume" ${s.sound.enabled ? '' : 'disabled'}><b class="vol-val">${s.sound.volume}%</b></div>
      </section>
      <section>
        <h3>Analysis</h3>
        <div class="set-row"><span>Engine depth<small>Deeper is more accurate but slower. Saved analysis is kept and refined.</small></span>
          ${seg('analysis.depth', s.analysis.depth, [[16, 'Fast · 16'], [20, 'Standard · 20'], [24, 'Deep · 24']])}</div>
        <div class="set-row"><span>"Best" line length<small>Moves calculated when you press Best (each side's move counts as one). At the end of a line you can calculate more.</small></span>
          ${seg('analysis.linePlies', s.analysis.linePlies, [[10, '10'], [16, '16'], [26, '26'], [40, '40'], [60, '60']])}</div>
      </section>
      <section>
        <h3>AI API keys</h3>
        <p class="set-note">For the upcoming AI move explanations. Keys are ${snap.encrypted ? 'encrypted with your system keychain' : '<b>stored without encryption</b> (no system keychain available)'} and never leave this computer.</p>
        <div class="keys">${snap.keys.length ? snap.keys.map((k) => `
          <div class="key-row ${k.active ? 'active' : ''}" data-id="${k.id}">
            <button class="radio ${k.active ? 'on' : ''}" data-key-act="activate" title="${k.active ? 'Active key' : 'Use this key'}" aria-label="Use this key"></button>
            <div class="key-main">
              <input class="key-name" value="${escapeHtml(k.name)}" maxlength="60" aria-label="Key name">
              <span class="key-meta">${escapeHtml(k.provider)} · <code>${escapeHtml(k.preview)}</code>${k.active ? ' · <b>Active</b>' : ''}</span>
            </div>
            <button class="icon-btn" data-key-act="copy" title="Copy key">${UI_ICONS.clipboard}</button>
            <button class="icon-btn danger" data-key-act="delete" title="Delete key">${UI_ICONS.trash}</button>
          </div>`).join('') : '<div class="keys-empty">No keys yet.</div>'}
        </div>
        <form class="key-add" autocomplete="off">
          <input name="name" placeholder="Name (e.g. My OpenAI key)" maxlength="60">
          <select name="provider">${snap.providers.map((p) => `<option>${p}</option>`).join('')}</select>
          <input name="key" type="password" placeholder="Paste API key" spellcheck="false" required>
          <button class="btn btn-primary" type="submit">Add key</button>
        </form>
      </section>`;
    bind();
  };

  const set = (path, value) => {
    const [g, k] = path.split('.');
    return update({ [g]: { [k]: value } });
  };

  const bind = () => {
    root.querySelectorAll('[data-theme]').forEach((b) => { b.onclick = () => set('board.theme', b.dataset.theme); });
    root.querySelectorAll('[data-pieces]').forEach((b) => { b.onclick = () => set('board.pieces', b.dataset.pieces); });
    root.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = () => set(b.dataset.toggle, !b.classList.contains('on'));
    });
    root.querySelectorAll('.seg').forEach((g) => {
      g.onclick = (e) => {
        const b = e.target.closest('[data-value]');
        if (!b) return;
        const v = b.dataset.value;
        set(g.dataset.setting, /^\d+$/.test(v) ? Number(v) : v);
      };
    });
    const vol = root.querySelector('#volume');
    vol.oninput = () => {
      root.querySelector('.vol-val').textContent = `${vol.value}%`;
      sounds.configure({ volume: Number(vol.value) });
    };
    vol.onchange = async () => {
      await set('sound.volume', Number(vol.value));
      sounds.play('move');
    };
    root.querySelectorAll('.key-row').forEach((row) => {
      const id = row.dataset.id;
      const name = row.querySelector('.key-name');
      name.onchange = () => keyOp(() => api.renameKey(id, name.value));
      name.onkeydown = (e) => { if (e.key === 'Enter') name.blur(); };
      row.onclick = async (e) => {
        const act = e.target.closest('[data-key-act]')?.dataset.keyAct;
        if (act === 'activate') await keyOp(() => api.setActiveKey(id));
        if (act === 'copy') toast((await api.copyKey(id)) ? 'Key copied to the clipboard' : 'Could not copy the key', 'info');
        if (act === 'delete') {
          const ok = await confirmDialog({ title: 'Delete API key', message: `Delete the key <b>${escapeHtml(name.value)}</b>? This cannot be undone.`, confirmLabel: 'Delete', danger: true });
          if (ok) await keyOp(() => api.removeKey(id));
        }
      };
    });
    const form = root.querySelector('.key-add');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form));
      try {
        await keyOp(() => api.addKey(data));
        root.querySelector('.key-add').reset();
        toast('Key added');
      } catch (err) {
        toast(String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
      }
    };
  };

  const off = onSettings(() => {
    // keep what the user is typing in the "add key" form
    const form = root.querySelector('.key-add');
    const draft = form ? Object.fromEntries(new FormData(form)) : null;
    render();
    if (draft) for (const [k, v] of Object.entries(draft)) root.querySelector(`.key-add [name="${k}"]`).value = v;
  });
  render();
  return close;
}
