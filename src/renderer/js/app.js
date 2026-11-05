import { api } from './api.js';
import { LibraryView } from './library.js';
import { ReviewView } from './review.js';
import { toast } from './util.js';
import { loadSettings } from './settings.js';
import { sounds } from './sounds.js';

const root = document.getElementById('app');
let review = null;

const library = new LibraryView(root, { onOpen: openGame });

async function openGame(id) {
  try {
    const game = await api.getGame(id);
    await api.touchGame(id);
    review?.close();
    review = new ReviewView(root, { onBack: showLibrary });
    await review.open(game);
  } catch (err) {
    console.error(err);
    toast(`Could not open the game: ${err.message}`, 'error');
    showLibrary();
  }
}

function showLibrary() {
  review?.close();
  review = null;
  library.show();
}

// Drag & drop a file anywhere in the window.
window.addEventListener('dragover', (e) => {
  e.preventDefault();
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) document.body.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  if (e.dataTransfer?.files?.length) library.importDropped(e.dataTransfer.files);
});

api.onOpenGame(openGame);
window.__chessApp = { openGame, showLibrary }; // for debugging / smoke tests
loadSettings().catch((err) => console.error('settings', err)).finally(() => {
  showLibrary();
  sounds.preload();
});
