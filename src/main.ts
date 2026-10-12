import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/source-serif-4/600.css';
import './styles.css';
import { registerSW } from 'virtual:pwa-register';
import { startApp } from './app';

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
