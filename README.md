# MunnX Convertor

A free, login-free file converter that runs **100% in your browser**. Files are
never uploaded, every conversion happens on your own device using WebAssembly
and JavaScript. That means it is private by design, costs nothing to host, and
cannot be abused, since each visitor uses their own CPU.

Live at [converter.munnxglobal.com](https://converter.munnxglobal.com). Also
ships as an Android app via Capacitor.

## What it does

**Photos and images**
Convert (PNG / JPG / WebP), compress, resize, watermark, remove the background
on-device, sign and date, combine into a PDF, read text out with OCR, read a QR
code, view hidden metadata including GPS, strip that metadata losslessly, and
make a picture look like it was scanned.

**PDF**
To Word, Excel, images or text. Organise pages (delete, reorder, rotate,
duplicate, insert other files anywhere). Split, rotate, compress, watermark,
password protect and unlock, remove watermark layers, type text anywhere, fill
real form fields, sign and date, and make it look scanned.

**Video** (see [VIDEO_PROCESSING.md](VIDEO_PROCESSING.md))
Convert to MP4, WebM or GIF. Trim, crop, resize, rotate, flip, change speed,
reverse, split into parts, and join several clips together. Adjust volume, fade,
even out levels, mute, replace the audio, or extract it. Compress, burn in
subtitles, add text, add a moving watermark. Grab a frame, generate a thumbnail,
or just inspect the file's details. Several edits can be stacked and run in one
pass.

**Audio**: MP3, WAV, trim, join.
**Documents**: Word, Markdown, HTML and text to PDF or HTML.
**Spreadsheets**: Excel to CSV and back.
**Extras**: QR code maker, unit converter including Indian land measures.

Several files can be dropped at once and pushed through the same tool, with a
queue showing each file's progress and letting you skip, retry or stop.

**Fidelity note:** the office conversions (PDF to Word, Word to PDF, HTML to
PDF) are text-level. They rebuild headings and paragraphs but flatten complex
tables, columns and exact styling. That is the tradeoff for running fully
in-browser with no server. Image, PDF to image, OCR and spreadsheet conversions
are full quality.

## Browser limits worth knowing

Everything runs on the visitor's own machine, inside a 32-bit WebAssembly heap.

- Video and audio inputs are capped at **200 MB**.
- Video encoding runs at roughly **5 to 10 times real time**, so a one-minute
  clip takes several minutes. There is a cancel button.
- Reversing a video holds every frame in memory, so it is limited to **60
  seconds**.
- Batches process one file at a time, on purpose. Decoding several videos at
  once exhausts the heap and kills the tab.
- Subtitles can be burned in Latin, Devanagari, Bengali, Tamil, Telugu and
  Arabic. Chinese, Japanese and Korean are not bundled, since one CJK font is
  larger than all the others combined; text in those scripts produces a warning
  rather than silently disappearing.

## Run it locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install      # first time only
npm run dev      # start the dev server -> http://localhost:5173
```

Use it from your phone or another device on the same Wi-Fi:

```bash
npm run dev -- --host
```

Build the optimized production version and preview it exactly as it will be
served live:

```bash
npm run build    # outputs to dist/
npm run preview
```

**Always run `npm run build` before pushing.** Vercel runs that, not
`build:app`, and the PWA plugin fails the build outright if a precached asset
exceeds its size limit. That once left the live site several releases behind
without anything obviously breaking.

## Android app

```bash
npm run build:app   # vite build --mode capacitor (PWA disabled)
npx cap sync android
```

Then build from Android Studio, or with Gradle directly. The PWA service worker
must stay off in this mode: it intercepts requests before Capacitor's native
bridge is injected, which silently breaks saving files to the device.

## Deploy

A static site, so Vercel's free tier hosts it indefinitely. Push to the repo and
it redeploys. `npm run build` produces `dist/`.

## Architecture notes

- **No backend.** Pure static `dist/` output. Nothing is uploaded, ever.
- **Lazy loading.** Every heavy library (pdf.js, Tesseract, ffmpeg, onnxruntime,
  mammoth, SheetJS, docx, jsPDF, JSZip) loads through a dynamic `import()`, so a
  visitor only downloads code for the tool they actually use.
- **Self-hosted engines.** ffmpeg, Tesseract, qpdf, the background-removal model
  and the subtitle fonts are all served from this origin rather than a CDN, so
  the app works offline after first use. They are runtime-cached, not
  precached, since most visitors never touch them.
- **Single-threaded ffmpeg** on purpose. The multi-threaded build needs
  `SharedArrayBuffer`, which needs COOP/COEP headers, which break the OCR
  worker.

## Project structure

```
src/
  App.tsx              dropzone, tool picker, progress, results
  converters/
    registry.ts        source type -> available tools
    imageConverters.ts image formats, OCR, background removal
    pdfConverters.ts   PDF conversions, passwords, stamping
    pdfPages.ts        page organiser
    videoTools.ts      the registry's view of the video engine
    videoPipeline.ts   steps for the multi-step editor
    batchQueue.ts      observable processing queue
    scanEffect.ts      the scanned look
  video/               the video engine (see VIDEO_PROCESSING.md)
  lib/                 download, strings, pdf.js worker, page ranges
```

To add a conversion: write the function in the relevant `converters/*` file and
register it under the right source type in `registry.ts`. For video, see the
last section of [VIDEO_PROCESSING.md](VIDEO_PROCESSING.md).

## A note on verifying changes

Most of the hard bugs in this project returned a success code while doing
nothing: subtitles that drew no pixels, a merge that produced a playable file
with garbled frames, a split whose parts reported the wrong length. **Check the
output, not the exit code.** Measure dimensions, durations or pixels.
