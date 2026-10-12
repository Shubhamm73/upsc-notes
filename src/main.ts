// Fonts for the 6 note styles, Latin only, bundled so they work offline.
import '@fontsource/atkinson-hyperlegible/latin-400.css';
import '@fontsource/atkinson-hyperlegible/latin-700.css';
import '@fontsource/source-serif-4/latin-600.css';
import '@fontsource/literata/latin-600.css';
import '@fontsource/public-sans/latin-400.css';
import '@fontsource/public-sans/latin-700.css';
import '@fontsource/eb-garamond/latin-600.css';
import '@fontsource/libre-franklin/latin-400.css';
import '@fontsource/libre-franklin/latin-700.css';
import '@fontsource/ibm-plex-serif/latin-600.css';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-700.css';
import '@fontsource/caveat/latin-700.css';
import '@fontsource/nunito/latin-400.css';
import '@fontsource/nunito/latin-700.css';
import '@fontsource/fraunces/latin-600.css';
import { applyAppearance } from './lib/prefs';
import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { startApp } from './app';

applyAppearance();

let onNeedRefresh: (() => void) | null = null;
let pending = false;

const updateSW = registerSW({
  onNeedRefresh() {
    if (onNeedRefresh) onNeedRefresh();
    else pending = true;
  }
});

startApp(document.getElementById('app')!, {
  onUpdate(cb) {
    onNeedRefresh = cb;
    if (pending) cb();
  },
  applyUpdate() {
    void updateSW(true);
  }
});
