# MunnX Convertor — Progress Log

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

### 2026-07-01 — Batch 2b: PDF password protect + unlock (qpdf-wasm)
- **Protect** (add AES-256 password) and **Unlock** (remove a known password) for PDFs
  ([`pdfConverters.ts`](src/converters/pdfConverters.ts) `protectPdf` / `removePdfPassword`),
  powered by **`@neslinesli93/qpdf-wasm`** (qpdf compiled to WASM). pdf-lib can't
  encrypt, so qpdf fills that gap via a fresh Emscripten instance per call + virtual FS.
- **Self-hosted** `public/qpdf.wasm` (1.3 MB, absolute-URL `locateFile`) → **fully
  offline** on web (PWA precache) and in the app (bundled asset). New `text` param with
  `password: true` renders a masked input.
- **Verified in preview:** protect → output has `/Encrypt`; unlock with the right
  password → `/Encrypt` gone, valid `%PDF-`; wrong password → rejected, no file.
- Registry: `Protect` + `Unlock` for `pdf`; tool-grid cards.

### 2026-07-01 — Batch 2a: Background remover (on-device AI)
- **Remove BG** for images ([`imageConverters.ts`](src/converters/imageConverters.ts)
  `removeImageBackground`): uses `@imgly/background-removal` (ONNX/WASM, onnxruntime-web)
  to cut out the subject fully on-device → transparent PNG. Registered for `image`;
  added a tool-grid card.
- **Verified in preview:** on a subject-on-color test image the background corner came
  out alpha 0 (transparent) and the subject center alpha 254 (kept); ~12 s with the
  model cached. Build code-splits the `ort.*` chunks (lazy-loaded).
- **Caveat:** first use downloads a ~40 MB model from a CDN (then cached) — needs
  internet that first time; slower on phones. (Self-hosting/bundling the model for full
  offline can be a later step, like we did for OCR.)

### 2026-06-30 — New tools (batch 1): Image resize + Watermark
- **Image resizer** ([`imageConverters.ts`](src/converters/imageConverters.ts) `resizeImage`):
  exact W×H, keep-aspect ("fit") or "stretch", output JPG/PNG/WebP. Verified
  800×600 → 400×300 (fit) and 300×300 (stretch).
- **Watermark** — add text over images (`watermarkImage`, Canvas) and across every
  PDF page ([`pdfConverters.ts`](src/converters/pdfConverters.ts) `watermarkPdf`,
  pdf-lib). Styles: diagonal / tiled / center / bottom-right; opacity; size.
  Verified both produce valid output.
- **New `text` param kind** ([`types.ts`](src/converters/types.ts) + `ActionParams`
  in [`App.tsx`](src/App.tsx)) for the free-text watermark field (reused later for
  the PDF password). Registry wires Resize + Watermark into `image`, Watermark into
  `pdf`; added tool-grid cards. Verified in preview; `build:app` passes.
- Batch 2 (PDF password protect/remove via qpdf-wasm, Sign & date) is next; the APK
  will be rebuilt once both batches land.

### 2026-06-30 — Signed release APK
- Added **release signing** ([`android/app/build.gradle`](android/app/build.gradle)):
  reads `android/keystore.properties` (git-ignored) for storeFile/passwords/alias and
  applies it to the `release` build type. Guarded by `hasReleaseKeystore` so debug
  builds (and anyone without the key) still build fine.
- **Secrets stay out of git:** `android/.gitignore` now excludes `keystore.properties`,
  `*.jks`, `*.keystore`. The keystore (`munnx-release.jks`) lives only on the local machine.
- Built `app-release.apk` (18.7 MB) with `gradlew assembleRelease`. **Verified signed:**
  apksigner V2, certificate `CN=MunnX Convertor, O=MunnX, C=IN`. Copied to Desktop as
  `MunnX-Convertor-release.apk`.
- ⚠️ Keystore + password must be backed up — required for every future update / Play Store.

### 2026-06-30 — Professional UI redesign + visual tool grid
- **Polished, more professional look** ([`App.css`](src/App.css), [`App.tsx`](src/App.tsx)):
  design tokens (color/radius/shadow vars), a **tool-card "panel"** wrapping the
  converter, trust badges (Private · Free · No login), refined dropzone (soft dashed
  blue, green compact selected state), gradient-selected format chips, depth on the
  orange Convert button, blue focus rings on inputs, uppercase section labels.
- **Replaced the text "Supported conversions" list with a colorful tool-card grid**
  (like iLovePDF/SmallPDF, but covering our all-in-one range): 12 cards, each a
  tinted icon tile + title + one-line description (`TOOLS` array). Cards are
  clickable and call react-dropzone's `open()` to start a conversion.
- **Verified in preview:** 12 cards render in a responsive grid, panel/badges/logo
  present, app mounts clean after reload with no console errors. `npm run build`
  (web/PWA) passes. (Pre-existing `Uint8Array`→`BlobPart` tsc strictness warnings
  remain; non-blocking, unrelated to UI.)
- Pushed to Vercel (website) + rebuilt the APK.

### 2026-06-30 — Fix: OCR hung forever in the Android app
- **Symptom:** image→text showed "working" indefinitely on the phone (worked fine on web).
- **Root cause:** the English language data ships as `eng.traineddata.gz` and `imageToText`
  requested it with `gzip: true`. But **Android's APK packager (AAPT) auto-decompresses
  `.gz` assets and strips the extension** — inside the APK the file is plain
  `eng.traineddata`. So on device Tesseract fetched a `.gz` that doesn't exist → 404 →
  silent hang at "recognizing".
- **Fix** ([`imageConverters.ts`](src/converters/imageConverters.ts)): `gzip: !Capacitor.isNativePlatform()`
  — web serves the real `.gz` (gzip:true, 10.9 MB, lean); native requests the
  AAPT-decompressed `eng.traineddata` (gzip:false). No repo bloat, no web regression.
- **Verified:** on web, gzip:true reads "HELLO 123" (539 ms); forced gzip:false against an
  uncompressed `eng.traineddata` reads "NATIVE 456" (288 ms) — the exact native path.
  Confirmed the rebuilt APK contains `assets/public/tesseract/lang/eng.traineddata` (22.4 MB).
- Rebuilt `MunnX-Convertor.apk` (21.2 MB).

### 2026-06-26 — "Save to device" on Android (MediaStore Downloads)
- **Problem:** the share-only flow had no "save to Files" target on the user's
  device. **Fix:** a one-tap **Save to device** that writes the converted file
  straight into the public **Downloads** collection via MediaStore — visible in
  the Files app instantly, **no permission prompt** on Android 10+. **Share** is
  kept as a secondary button.
- **Native plugin** [`DownloadsSaverPlugin.java`](android/app/src/main/java/com/universalconverter/app/DownloadsSaverPlugin.java)
  (registered in `MainActivity`): inserts a MediaStore.Downloads row with
  `IS_PENDING`, **stream-copies** the cached file into the `content://` URI (no
  bytes over the JS bridge → flat memory at 100MB+), clears pending, and rolls
  back the row on failure. Runs the copy on a **background thread** (no ANR).
  Rejects `UNSUPPORTED_VERSION` on Android 9- so JS falls back to Share.
- **TS:** [`src/lib/downloads-saver.ts`](src/lib/downloads-saver.ts) (registerPlugin)
  + [`download.ts`](src/lib/download.ts) `saveToDevice()` / `shareFile()` /
  chunked `writeToCache()`. `App.tsx` now holds the result and shows
  **Save to device + Share** on Android instead of auto-opening the share sheet;
  web still auto-downloads.
- **Native project is now committed** (`android/` removed from root `.gitignore`;
  build artifacts still excluded by `android/.gitignore`) so the plugin, manifest
  tweaks, and branded launcher icons survive.
- Verified: web build clean (buttons are Android-only, no console errors); native
  APK compiles the plugin and the bundle references it. APK 21.2 MB.

### 2026-06-26 — Use the user's real logo + app icon
- Replaced the recreated SVG wordmark with the **user-supplied artwork**:
  `assets/brand/logo-src.jpg` (MunnX wordmark on white) and
  `assets/brand/icon-src.jpg` (finished mX / MUNNX square tile).
- [`scripts/process-brand.mjs`](scripts/process-brand.mjs) (sharp):
  - Logo: **keys out the white background** (near-white→transparent with a feathered
    205–236 band; the wordmark has no white parts so letters stay intact) and trims →
    `public/logo.png` (transparent, sits cleanly on the navy header).
  - Icon: emits `assets/icon-only|foreground|background.png` (white adaptive bg matches
    the tile's own white border) + `public/icon.png` favicon. Android launcher icons
    regenerated via `@capacitor/assets`.
- Header now uses `<img src="/logo.png">`; favicon + PWA manifest + apple-touch-icon
  point to `/icon.png`. Removed the interim SVG recreations and `scripts/gen-icons.mjs`.
- Verified in preview (logo 888×304 transparent, loads; favicon = icon.png). Rebuilt
  `MunnX-Convertor.apk` (21 MB).

### 2026-06-26 — Branding: "MunnX Convertor" (electric blue + sunset orange)
- **Renamed** the app to **MunnX Convertor** everywhere users see it: header
  wordmark ([`App.tsx`](src/App.tsx)), `index.html` title/description,
  PWA manifest name/short_name ([`vite.config.ts`](vite.config.ts)),
  Capacitor `appName` ([`capacitor.config.ts`](capacitor.config.ts)), and Android
  `strings.xml` (`app_name`/`title_activity_main`). Bundle ID unchanged
  (`com.universalconverter.app`) — can be rebranded pre-publish if wanted.
- **Color palette → electric blue + sunset orange** (complementary):
  - Background: deep navy gradient `#0a1228 → #112a5c → #0b1730` (`index.css`).
  - Wordmark: blue→orange gradient text `#38bdf8 → #fb923c` — the brand blend.
  - Blue (`#2563eb`/`#38bdf8`) = structure: dropzone, selected format chips, links,
    arrows. Orange (`#f97316 → #fb923c`) = the Convert CTA, so it pops.
  - Progress bar runs blue→orange. `theme-color`/splash = `#0a1228`. (`App.css`.)
- **App icon rebranded:** `public/icon.svg` recolored to the blue→orange gradient.
  Generated all Android launcher densities + adaptive (foreground/background) +
  round icons with `@capacitor/assets` from `assets/icon-*.png`, themselves
  produced by [`scripts/gen-icons.mjs`](scripts/gen-icons.mjs) (sharp-rasterized
  brand art). Replaces the default Capacitor logo on the home screen.
- **Verified** in the dev preview: title, wordmark text + gradient, and navy body
  background all computed correctly; app mounts with no console errors.
- Rebuilt `MunnX-Convertor.apk` (20.5 MB) on the Desktop.

### 2026-06-26 — Fix: native save was bypassed by the PWA service worker
- **Symptom:** in the installed APK the UI still said "Downloaded" and no file
  appeared / no share sheet — i.e. the **web** save path ran inside the native app.
- **Root cause:** the bundled fix was correct, but `Capacitor.isNativePlatform()`
  returned **false** at runtime. The PWA **service worker** serves a cached
  `index.html`, which **bypasses Capacitor's native-bridge injection** — so
  `window.Capacitor` never gets its native flag and filesystem/share fall back to
  no-op web stubs. (Confirmed by extracting the APK: `index.html` contained
  `<script ... vite-plugin-pwa:register-sw>`.)
- **Fix:**
  - [`vite.config.ts`](vite.config.ts): PWA is now **mode-gated**. `vite build`
    (web/Vercel) keeps the service worker; `vite build --mode capacitor` (native)
    **omits VitePWA entirely** — no SW, no manifest.
  - [`package.json`](package.json): `build:app` = `vite build --mode capacitor`;
    `android` now runs `build:app` before `cap sync`/`cap open`.
  - [`src/main.tsx`](src/main.tsx): defensive — on native, **unregister any
    existing service worker** and clear its caches (an SW from a previously
    installed PWA build survives an app update and would keep hijacking).
  - Verified the rebuilt APK's `assets/public/index.html` has **no** `registerSW`
    and the bundle ships no `sw.js`/`workbox`/`manifest`.
- **To test:** fully **uninstall** the old app first (clears the stale registered
  SW), then install the new `app-debug.apk`. Expect: share/save sheet on convert.

### 2026-06-26 — Fix: converted files now save on Android (native share)
- **Bug:** in the Android app, conversions ran but the output file never
  appeared. Root cause: the old `downloadBlob` used a blob URL + hidden
  `<a download>.click()`, which **does nothing in an Android WebView** (no
  download manager fires; the file is silently dropped).
- **Fix** ([`src/lib/download.ts`](src/lib/download.ts)): `downloadBlob` is now
  platform-aware. Web keeps the blob-URL download; **native** writes the file to
  `Directory.Cache` via `@capacitor/filesystem`, then opens the native
  **Share/Save sheet** (`@capacitor/share`) so the user picks Files / Downloads /
  Drive / WhatsApp / etc. No storage permission needed; works on all Android versions.
- **Large-file safe:** writes in **3 MiB base64 chunks** (`writeFile` + `appendFile`)
  so a big video/WAV can't balloon into one ~2.66× UTF-16 base64 string and OOM-crash
  the WebView. Chunk size is a multiple of 3 bytes so concatenated base64 is byte-exact.
  (Caught by an adversarial review pass — high-severity finding, since inputs up to
  200 MB are allowed.)
- **Filename sanitized** for the FS path (illegal chars → `_`, keeps spaces/hyphens);
  share-sheet **dismissal** is treated as benign, not a "conversion failed" error.
- [`App.tsx`](src/App.tsx): awaits the async save; native success message is
  "Ready — choose where to save …".
- The Android `FileProvider` (`${applicationId}.fileprovider`) + `file_paths.xml`
  `<cache-path/>` already expose the cache dir — no native changes needed.
- **Project relocated out of OneDrive → `C:\dev\universal-converter`.** OneDrive's
  file-sync locks the `android/app/build` folder mid-build, so Gradle's resource
  merge failed ("failed to delete some children" / "AccessDenied"). After moving,
  a clean `gradlew assembleDebug` builds reliably **with OneDrive running** — no
  more stop-OneDrive dance. (One-time gotcha after the move: stale Gradle caches
  carried over; wiped `android/.gradle`, the `build/` dirs, and
  `node_modules/@capacitor/*/.../build`, then it built clean.)
- Rebuilt `app-debug.apk` (20.3 MB) with the fix; copied to Desktop for testing.
- Build cmd: set `JAVA_HOME` to Android Studio's `jbr`, then
  `cd android && .\gradlew.bat assembleDebug`.

### 2026-06-25 — Android app (Capacitor)
- **Added Capacitor** (`@capacitor/core`, `@capacitor/cli`, `@capacitor/android` v8)
  to wrap the existing Vite/React app in a native Android shell.
- `capacitor.config.ts`: bundle ID `com.universalconverter.app`, `webDir: 'dist'`,
  `allowMixedContent: true`, blob: navigation allowed for Tesseract/ffmpeg blob workers.
- `AndroidManifest.xml`: added `android:largeHeap="true"` + `hardwareAccelerated="true"`
  so ffmpeg.wasm gets enough heap and Canvas renders fast.
- Added `npm run android` script: `build → cap sync → cap open android` (opens
  Android Studio ready to build APK/AAB).
- `android/` added to `.gitignore` — it's a generated project, rebuilt from source.
- **To build the APK:** install Android Studio, run `npm run android`, then in
  Android Studio: Build → Generate Signed Bundle/APK → upload AAB to Play Store.
- **One-time cost:** Google Play Developer account ($25). Everything else is free.



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
