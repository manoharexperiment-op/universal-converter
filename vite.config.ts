import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Pure client-side app — no backend, no env vars, no API.
// Heavy converter libraries (pdf.js, Tesseract, mammoth, SheetJS, etc.) are
// loaded with dynamic import() so they are split into separate chunks and only
// downloaded the first time a user actually performs that kind of conversion.
//
// Build modes:
//   vite build                      → web build (Vercel) — PWA / service worker ON
//   vite build --mode capacitor     → native Android build — PWA / service worker OFF
//
// The service worker MUST be off in the Capacitor build: Capacitor injects its
// native bridge by rewriting the index.html response at load time, but a service
// worker serves index.html from its cache and bypasses that injection. The bridge
// then never loads, Capacitor.isNativePlatform() returns false, and native plugins
// (filesystem/share) silently fall back to no-op web stubs — so converted files
// "download" to nowhere instead of opening the native save sheet.
export default defineConfig(({ mode }) => {
  const isNativeApp = mode === 'capacitor';

  return {
    plugins: [
      react(),
      // PWA is for the web build only — see the note above.
      ...(isNativeApp
        ? []
        : [
            VitePWA({
              registerType: 'autoUpdate',
              injectRegister: 'auto',
              manifest: {
                name: 'MunnX Convertor',
                short_name: 'MunnX',
                description: 'Convert PDF, Word, Excel, images, audio & video — free, no login, 100% in your browser.',
                theme_color: '#0a1228',
                background_color: '#0a1228',
                display: 'standalone',
                start_url: '/',
                icons: [{ src: '/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any' }],
              },
              workbox: {
                // Precache the app shell + all code chunks so the app works offline after
                // the first visit. EXCLUDE the big self-hosted OCR assets — they'd bloat
                // the install; they're runtime-cached on first OCR use instead.
                globPatterns: ['**/*.{js,mjs,css,html,svg,ico,woff2,wasm}'],
                globIgnores: ['**/tesseract/**'],
                maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
                navigateFallback: '/index.html',
                runtimeCaching: [
                  {
                    // Self-hosted Tesseract worker/core/traineddata → cache on first OCR.
                    urlPattern: ({ url }) => url.pathname.startsWith('/tesseract/'),
                    handler: 'CacheFirst',
                    options: {
                      cacheName: 'tesseract-assets',
                      expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 90 },
                      cacheableResponse: { statuses: [0, 200] },
                    },
                  },
                  {
                    // ffmpeg core from CDN → cache on first video/audio use.
                    urlPattern: ({ url }) => url.hostname === 'unpkg.com' && url.pathname.includes('@ffmpeg/core'),
                    handler: 'CacheFirst',
                    options: {
                      cacheName: 'ffmpeg-core',
                      expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 90 },
                      cacheableResponse: { statuses: [0, 200] },
                    },
                  },
                  {
                    // Background-removal model + onnxruntime wasm (too big to precache) →
                    // cache on first use so web works offline afterwards.
                    urlPattern: ({ url }) => url.pathname.startsWith('/ort/') || url.pathname.startsWith('/models/'),
                    handler: 'CacheFirst',
                    options: {
                      cacheName: 'bg-remove-assets',
                      expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 90 },
                      cacheableResponse: { statuses: [0, 200] },
                    },
                  },
                ],
              },
              devOptions: { enabled: false },
            }),
          ]),
    ],
    // @ffmpeg/* spawns a worker via `new URL(..., import.meta.url)`; excluding it
    // from esbuild pre-bundling keeps that reference intact. (pdf.js/Tesseract do
    // NOT need this — they pre-bundle fine and load faster when they do.)
    // Use onnxruntime-web's WASM-only build (13.5 MB simd wasm) instead of the
    // default JSEP/WebGPU build (27 MB wasm). Exact-match regex so the subpath
    // 'onnxruntime-web/wasm' itself isn't re-aliased. Applies to rembg-web too.
    resolve: {
      alias: [{ find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' }],
    },
    optimizeDeps: {
      exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
    },
    build: {
      // These libraries are genuinely large; silence the default 500 kB warning.
      chunkSizeWarningLimit: 2000,
    },
  };
});
