import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Pure client-side app — no backend, no env vars, no API.
// Heavy converter libraries (pdf.js, Tesseract, mammoth, SheetJS, etc.) are
// loaded with dynamic import() so they are split into separate chunks and only
// downloaded the first time a user actually performs that kind of conversion.
export default defineConfig({
  plugins: [react()],
  // @ffmpeg/* spawns a worker via `new URL(..., import.meta.url)`; excluding it
  // from esbuild pre-bundling keeps that reference intact. (pdf.js/Tesseract do
  // NOT need this — they pre-bundle fine and load faster when they do.)
  optimizeDeps: {
    exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'],
  },
  build: {
    // These libraries are genuinely large; silence the default 500 kB warning.
    chunkSizeWarningLimit: 2000,
  },
});
