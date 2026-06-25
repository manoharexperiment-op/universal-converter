# Universal File Converter

A free, login-free file converter that runs **100% in your browser**. Files are
never uploaded — every conversion happens on your own device using WebAssembly
and JavaScript. That means it's private by design, costs nothing to host, and
can't be abused (each visitor uses their own CPU).

## Conversions

| From | To |
|---|---|
| Images (PNG / JPG / WebP / BMP / GIF) | PNG, JPG, WebP, PDF, **Text (OCR)** |
| PDF | PNG, JPG, Text, **Word (.docx)** |
| Word (.docx) | PDF, Text, HTML |
| Excel (.xlsx) | CSV |
| CSV | Excel (.xlsx) |
| Markdown | PDF, HTML |
| Text | PDF |
| HTML | PDF |

**Fidelity note:** the "office" conversions (PDF→Word, Word→PDF, HTML→PDF) are
intentionally *text-level* — they preserve text and headings but flatten complex
tables, columns, and exact styling. This is the tradeoff for running fully
in-browser with no server. Image, PDF↔image, OCR, and spreadsheet conversions
are full quality.

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

## Deploy to Vercel (free)

This is a static site, so Vercel's **free Hobby tier** hosts it indefinitely —
no paid plan or backend required.

1. Push this folder to a GitHub repo.
2. In Vercel, **Add New → Project** and import the repo.
3. Vercel auto-detects Vite. Accept the defaults:
   - Build command: `npm run build`
   - Output directory: `dist`
4. Deploy. Every `git push` redeploys automatically.

> Vercel's free tier is for non-commercial use. If you later monetize the site
> or exceed ~100 GB/month bandwidth, upgrade to Pro.

## Architecture notes

- **No backend.** Pure static `dist/` output.
- **Lazy loading.** Each heavy library (pdf.js, Tesseract, mammoth, SheetJS,
  docx, jsPDF, JSZip) is loaded with dynamic `import()`, so a user only
  downloads the code for the conversion they actually run.
- **OCR** uses Tesseract.js; the English language data (~few MB) downloads on
  first use, then is cached by the browser.

### Adding audio/video later (optional)

`ffmpeg.wasm` can convert audio/video fully in-browser, but its multi-threaded
build needs cross-origin isolation. If you add it, create `vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

⚠️ Enabling `require-corp` can break Tesseract.js's default CDN asset loading, so
if you add these headers you must also **self-host** the Tesseract core/worker/
language files (set `corePath`, `workerPath`, `langPath` in the OCR call) and add
the same headers to `vite.config.ts`'s dev server. Don't add them until you need
ffmpeg.

## Project structure

```
src/
├── App.tsx                  # UI: dropzone, format picker, progress
├── converters/
│   ├── registry.ts          # source type -> available conversions
│   ├── imageConverters.ts   # image formats, image->PDF, OCR
│   ├── pdfConverters.ts     # PDF -> image / text / Word
│   ├── documentConverters.ts# Word/Markdown/HTML/Text -> PDF/HTML
│   └── spreadsheetConverters.ts # xlsx <-> csv
└── lib/                     # download, string, pdf.js worker helpers
```

To add a conversion: write the function in the relevant `converters/*` file and
register it under the right source type in `registry.ts`.
