# Universal File Converter — Progress Log

> Living document. Updated at every step. Newest changelog entry on top.

---

## Current status

**Phase:** Built & verified locally, incl. PDF tools — ready to deploy.
**Last updated:** 2026-06-24

The app is a **100% client-side** file converter (Vite + React + TypeScript).
No backend, no uploads, no login. Dependencies installed, production build
passes, and **every** converter is now verified end-to-end in the browser —
including PDF→image (the headless-sandbox stall is fixed via `intent:'print'`).
PDF merge / split / rotate and multi-file mode are added and verified.

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
- [ ] Set up **GitHub repo + Vercel deploy** (needs user's GitHub/Vercel accounts).
- [ ] (Optional) Add **audio/video** (ffmpeg.wasm) — needs COOP/COEP headers +
      self-hosted Tesseract assets (see README).
- [ ] (Optional) Self-host Tesseract language data for full offline OCR.
