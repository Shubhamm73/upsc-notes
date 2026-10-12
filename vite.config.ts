import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

// Served from https://shubhamm73.github.io/upsc-notes/
export default defineConfig({
  base: '/upsc-notes/',
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version} (${new Date().toISOString().slice(0, 10)})`)
  },
  build: { target: 'es2022', sourcemap: true },
  plugins: [
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icons/*.png', 'favicon.svg'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,woff2,png,svg}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true
      },
      manifest: {
        name: 'UPSC Study Notes',
        short_name: 'UPSC Notes',
        description: 'Offline study notes for UPSC preparation. Everything stays on this device.',
        start_url: '/upsc-notes/',
        scope: '/upsc-notes/',
        display: 'standalone',
        orientation: 'any',
        background_color: '#f5f2ea',
        theme_color: '#2d5b4e',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ]
});
