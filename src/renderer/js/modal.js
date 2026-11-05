/** Small modal dialogs (chess.com-style dark cards). */
import { escapeHtml } from './util.js';

/**
 * Opens a modal and returns { el, close }. `onClose` runs when it's closed by
 * Esc, the ✕ button or a click on the backdrop.
 */
export function openModal({ title, body, className = '', onClose }) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal ${className}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <header class="modal-head">
        <h2>${escapeHtml(title)}</h2>
        <button class="icon-btn modal-x" aria-label="Close">✕</button>
      </header>
      <div class="modal-body">${body}</div>
    </div>`;
  document.body.appendChild(wrap);
  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    wrap.remove();
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('keydown', onKey, true);
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.modal-x').onclick = close;
  return { el: wrap.querySelector('.modal'), close };
}

/** Promise<boolean>: a confirmation with Cancel / confirm buttons. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    let answered = false;
    const { el, close } = openModal({
      title,
      className: 'modal-confirm',
      body: `<p class="confirm-msg">${message}</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok">${escapeHtml(confirmLabel)}</button>
        </div>`,
      onClose: () => { if (!answered) resolve(false); },
    });
    el.querySelector('[data-act="ok"]').focus();
    el.querySelector('.modal-actions').onclick = (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (!act) return;
      answered = true;
      resolve(act === 'ok');
      close();
    };
  });
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
