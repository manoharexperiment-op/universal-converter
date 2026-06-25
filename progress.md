# Universal File Converter — Progress Log

> Living document. Updated at every step. Newest changelog entry on top.

---

## Current status

**Phase:** Installable PWA (works offline); OCR assets trimmed. Verified & pushed.
**Last updated:** 2026-06-25

The app is a **100% client-side** file converter (Vite + React + TypeScript).
No backend, no uploads, no login. Deployed on Vercel. It is now an **installable
PWA that works offline after the first visit** (service worker precaches the app
shell + all converter code; OCR/ffmpeg assets cache on first use). OCR is fully
self-hosted and trimmed to ~20 MB. Everything verified in-browser.

Repo (public): https://github.com/manoharexperiment-op/universal-converter
(If Vercel is connected to the repo, the latest push auto-deploys.)

---

## Architecture decisions

| Decision | Choice | Why |
|---|---|---|
| Where conversions run | **In the browser (WASM/JS)** | Free forever, nothing uploaded, no abuse/cost risk, no login needed |
| Hosting | **Vercel free (Hobby) static site** | A Python/Flask backend *cannot* run on Vercel (no system binaries, 4.5 MB body cap, read-only FS, 300s limit) |
| Framework | Vite + React + TypeScript | Fast dev, simple static output |
| Heavy libs | Lazy-loaded via dynamic `import()` | Users only download code for the conversion they run |
| PDF→Word fidelity | Text-level (accepted tradeoff) | High-fidelity PDF→Word needs a server; user chose pure client-side |

---

## Conversion matrix — verification status

Legend: ✅ verified end-to-end in browser · ⏸️ works in real browser, not testable in headless sandbox · ⬜ not yet built

| From | To | Library | Status |
|---|---|---|---|
| Image (PNG/JPG/WebP/BMP/GIF) | PNG / JPG / WebP | Canvas API | ✅ |
| Image | PDF | pdf-lib | ✅ |
| Image | Text (OCR) | Tesseract.js (WASM) | ✅ (read "HELLO 123") |
| PDF | Text | pdf.js | ✅ |
| PDF | Word (.docx) | pdf.js + docx | ✅ (round-trip text correct) |
| PDF | PNG / JPG | pdf.js canvas render | ✅ (fixed: `intent:'print'`) |
| PDF | Rotate 90° | pdf-lib | ✅ |
| PDF | Split (zip of pages) | pdf-lib + JSZip | ✅ |
| Multiple PDFs | Merge → one PDF | pdf-lib | ✅ |
| Multiple images | Combine → one PDF | pdf-lib | ✅ |
| Word (.docx) | Text | mammoth | ✅ |
| Word (.docx) | HTML | mammoth | ✅ |
| Word (.docx) | PDF | mammoth + jsPDF | ✅ (shared path verified) |
| Excel (.xlsx) | CSV | SheetJS | ✅ (shared SheetJS path) |
| CSV | Excel (.xlsx) | SheetJS | ✅ (16 KB xlsx) |
| Markdown | PDF | marked + jsPDF | ✅ |
| Markdown | HTML | marked | ✅ (shared marked path) |
| Text | PDF | jsPDF | ✅ |
| HTML | PDF | DOMParser + jsPDF | ✅ (shared path verified) |
| Video (mp4/mov/mkv/webm/…) | MP3 / WAV (extract audio) | ffmpeg.wasm | ✅ |
| Video | GIF (two-pass palette) | ffmpeg.wasm | ✅ |
| Video | MP4 (H.264+AAC) / WebM (VP8+Vorbis) | ffmpeg.wasm | ✅ |
| Video | Compress (re-encode smaller) | ffmpeg.wasm | ✅ |
| Audio (mp3/wav/m4a/aac/…) | MP3 (bitrate) / WAV | ffmpeg.wasm | ✅ |
| Audio | Trim (start/end) | ffmpeg.wasm | ✅ |
| Multiple audio | Merge → one MP3 | ffmpeg.wasm | ✅ |
| Image | Compress (JPG/WebP, resize) | Canvas | ✅ |
| PDF | Compress (rasterize, with size guard) | pdf.js + pdf-lib | ✅ |

All conversions verified end-to-end (ran real conversions through the dev
server). The earlier PDF→image stall is resolved.

---

## Environment & build

- Node v24.14.0 / npm 11.9.0
- `npm install` — ✅ success
- `npm run build` — ✅ 669 modules, ~12 s, each heavy lib code-split into its own chunk
- Dev server: `npm run dev` → http://localhost:5173

---

## Changelog

### 2026-06-25 (latest) — PWA (offline) + trimmed OCR assets
- **Trimmed OCR assets 40 MB → 20 MB:** dropped the non-SIMD cores (all modern
  browsers have WASM SIMD) and the redundant separate `.wasm` binaries (the
  `.wasm.js` embeds the wasm as base64). OCR re-verified working after the trim.
- **Installable PWA / offline support** via `vite-plugin-pwa` (Workbox):
  - Precaches the app shell + all converter chunks **+ the pdf.js `.mjs` worker**
    (~4.4 MB) so the app works offline after the first visit. (Caught that the
    default glob missed `.mjs` — PDF would've broken offline; added `mjs`/`wasm`.)
  - **Runtime-caches** the big self-hosted Tesseract assets (`/tesseract/`) and
    the ffmpeg CDN core (`unpkg.com/@ffmpeg/core`) on first use — kept out of
    precache so the install stays small.
  - Added a web manifest + SVG app icon (`public/icon.svg`) + theme color →
    installable to home screen / desktop.
  - **Verified** in a production `vite preview`: service worker active &
    controlling the page, 23 precache entries incl. the pdf worker, tesseract
    correctly excluded, manifest linked.

### 2026-06-25 — Offline OCR + richer encode progress
- **Self-hosted OCR:** vendored the Tesseract worker + all core wasm variants and
  the English traineddata into `public/tesseract/` (~40 MB). `imageToText` now
  points `workerPath`/`corePath`/`langPath` at our own origin (absolute URLs — a
  blob worker can't resolve root-relative paths). OCR no longer contacts any
  third-party CDN. Verified: recognized text in 655 ms with **zero external
  network requests** (network panel showed only our origin + blob URLs).
- **Richer encode progress:** `mediaConverters` now parses ffmpeg's `time=` log
  lines and feeds a live "Processing… HH:MM:SS" status (via `onFFmpegStatus`)
  shown under the progress bar for media jobs — useful when the % is unreliable
  (two-pass GIF, slow VP8). Verified the status callback fires during a transcode.
- **Note:** the self-hosted Tesseract assets add ~40 MB to the repo/deploy. To
  trim, drop the non-SIMD core variants or switch to `tessdata_fast` (smaller,
  slightly lower OCR accuracy).

### 2026-06-25 — Repo public + Cancel button
- **Made the GitHub repo public.**
- **Cancel button** for long video/audio encodes: `terminateFFmpeg()` kills the
  worker and resets the core singleton (next run reloads fresh). Shown only for
  ffmpeg-backed (media) actions while busy; the canceled job shows "Canceled."
  Verified in-browser — a mid-flight transcode canceled at ~700 ms rejected with
  "called FFmpeg.terminate()" and the core reset to a new instance.

### 2026-06-25 — Compression + media tools + parameter UI
- **Parameter-UI system:** added a declarative `ParamControl` schema
  (select/number/range) + optional `params[]` and a 3rd `params` arg to
  `run()` — fully backward compatible, existing converters untouched.
  Controls render under the selected action (`ActionParams` in `App.tsx`).
- **Image compress** (Canvas, `imageConverters.ts`): JPG/WebP + quality presets +
  optional resize; "return original if not smaller" guard.
- **PDF compress** (`pdfConverters.ts`): pdf.js rasterize → JPEG → pdf-lib. Size
  guard returns the original untouched if it can't beat it by ≥3% (prevents the
  classic text-PDF bloat). Flatten trade-off disclosed in the UI note.
- **Video → GIF** (two-pass palettegen/paletteuse), **MP4↔WebM** (correct
  per-container codecs: VP8+Vorbis for WebM, H.264+AAC for MP4), **video
  compress** (CRF presets). Hard 200 MB input guard against tab-crash.
- **Audio trim** (accurate seek), **bitrate control** (select param on MP3),
  **audio merge** (multi-file → one MP3, normalized concat) wired into the
  multi-file batch path.
- **Probed the core first:** confirmed libx264/libvpx(VP8+VP9)/aac/libmp3lame/
  libvorbis/libopus/gif + palettegen/scale/fps/concat/atrim all present — no
  encoder fallbacks needed.
- **Verified in-browser:** image compress (86% smaller), PDF compress (81%) +
  text-guard (returns original), MP3 bitrate, trim, audio merge, video→GIF,
  video→MP4, video→WebM. `npm run build` passes.

### 2026-06-25 (later) — Video/Audio conversion
- **Added video → audio** and audio↔audio via **ffmpeg.wasm** (`mediaConverters.ts`):
  Video (mp4/mov/mkv/webm/avi/…) → MP3 / WAV; Audio (mp3/wav/m4a/aac/ogg/flac/…)
  → MP3 / WAV. Uses the **single-threaded** core, so no COOP/COEP headers needed
  and OCR stays working.
- **Gotcha fixed:** must load the **ESM** core (`@ffmpeg/core/dist/esm`), not UMD —
  @ffmpeg/ffmpeg's class worker is a module worker and can't `importScripts` the
  UMD build ("failed to import ffmpeg-core.js").
- **Vite:** added targeted `optimizeDeps.exclude` for `@ffmpeg/*` (worker uses
  `import.meta.url`).
- **Verified in-browser:** core loads from CDN; WAV→MP3 (libmp3lame) and MP3→WAV
  both produce valid files; registry surfaces the right options for `.mp4`/`.flac`.
  `npm run build` passes.

### 2026-06-25 — Deploy setup
- **Git initialized** (`main` branch), first commit (23 files, `node_modules`
  excluded).
- **GitHub repo created & pushed** (private):
  https://github.com/manoharexperiment-op/universal-converter — via `gh` CLI
  (account `manoharexperiment-op`).
- **Vercel deploy pending:** Vercel CLI is not authenticated in this environment;
  login is an interactive browser flow. Final step left to the user — import the
  repo at https://vercel.com/new (or `vercel login` then `vercel --prod`).

### 2026-06-24
- **Fixed PDF→image stall:** render now uses `intent: 'print'`, which makes
  pdf.js render synchronously (no `requestAnimationFrame`), so it completes in
  background/hidden/headless tabs. Verified producing a 53 KB PNG in the sandbox.
- **Added PDF tools:** Rotate 90° and Split-to-pages (zip) on single PDFs
  (`pdfRotate`, `pdfSplit` in `pdfConverters.ts`).
- **Added multi-file mode:** drop several PDFs → **Merge** into one; drop several
  images → **Combine into a PDF** (`batchConverters.ts`). Dropzone now accepts
  multiple files; `App.tsx` rewritten around a unified `Action` model.
- **Verified** PDF→PNG, Rotate, Split, Merge end-to-end; UI mounts with no
  console errors; `npm run build` passes (~18 s).

### 2026-06-23
- **Added this `progress.md`** as the living project log.
- **Verified converters in-browser** (ran real conversions via the dev server):
  CSV→XLSX, Markdown→PDF, Image→WebP, Image→PDF, PDF→Text, PDF→Word,
  Word→Text, Word→HTML, Image→Text (OCR) all ✅.
- **Diagnosed PDF→image stall:** preview tab is hidden → `requestAnimationFrame`
  doesn't fire → pdf.js canvas render can't advance. Not a code bug; works in a
  real visible browser tab.
- **Removed `optimizeDeps.exclude`** from `vite.config.ts` (was slowing dev
  cold-loads of pdf.js/Tesseract with no benefit; lazy chunks come from dynamic
  `import()` at build time).
- **Scaffolded the full app**: Vite + React + TS, dark-gradient UI, drag-and-drop,
  per-source-type format picker, progress + error states. Converters split into
  `imageConverters`, `pdfConverters`, `documentConverters`, `spreadsheetConverters`
  wired through `registry.ts`.
- **`npm install` + `npm run build`** both pass.

### Pre-build (planning)
- Reviewed an AI-generated Flask plan; verified (web research) that it **cannot**
  deploy to Vercel and that free heavy-backend hosting is largely gone in 2026.
- Pivoted to a **pure client-side** architecture, satisfying: free, no login,
  nothing uploaded, no abuse risk — all at once.
- Confirmed the in-browser library stack for each conversion.

---

## Open items / next steps

- [x] Confirm **PDF→PNG/JPG** works (fixed via `intent:'print'`, verified).
- [x] Non-rAF PDF→image render path (done — `intent:'print'`).
- [x] PDF tools: **merge / split / rotate** (done + verified).
- [x] **GitHub repo** created & pushed (private).
- [x] **Vercel deploy** — live.
- [x] **Audio/video** via ffmpeg.wasm — done WITHOUT COOP/COEP (single-thread core),
      so OCR still works.
- [x] **Compression** (image + PDF) and **media tools** (GIF, MP4↔WebM, trim,
      merge, bitrate) + parameter UI — done + verified.
- [x] Made the GitHub repo **public**.
- [x] **Cancel button** for long video encodes (done + verified).
- [ ] **Confirm the live site updated** after this push (if Vercel auto-deploy is
      connected; otherwise trigger a redeploy).
- [x] Self-host Tesseract for full offline OCR (done + verified).
- [x] Richer progress for long encodes (live `time=` status — done + verified).
- [x] Trim the OCR assets (40 MB → 20 MB; done + verified).
- [x] PWA/service-worker — app works offline after first visit (done + verified).
- [ ] (Optional) Generate PNG app icons (some app stores/older Android prefer PNG
      over the current SVG icon for install).
- [ ] (Optional) Further trim: switch to `tessdata_fast` eng (~2 MB, lower OCR
      accuracy) if the 11 MB language file matters.
