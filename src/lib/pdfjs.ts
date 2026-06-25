import * as pdfjsLib from 'pdfjs-dist';
// Vite bundles the worker and gives us a URL to it (the `?url` suffix). This
// keeps the converter fully self-contained / offline — no CDN dependency.
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

// This module is only ever reached via dynamic import() from the PDF
// converters, so the (large) pdf.js bundle is lazy-loaded on first use.
export default pdfjsLib;
