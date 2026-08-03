// Tiny static file server for the bundled web app. We serve over http://127.0.0.1
// (not file://) so the app behaves EXACTLY like the web build: absolute asset
// paths (/assets/...) and origin-relative engine paths (/ffmpeg, /ort, /tesseract,
// /models, /qpdf.wasm) all resolve, and web workers / WASM load normally.
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.traineddata': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/** Start the static server for `root`; resolves with the chosen localhost port. */
function startServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        let filePath = path.normalize(path.join(root, urlPath));
        if (!filePath.startsWith(root)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        let exists = fs.existsSync(filePath) && fs.statSync(filePath).isFile();
        if (!exists) {
          // SPA fallback: navigations (no file extension) → index.html
          if (!path.extname(urlPath)) {
            filePath = path.join(root, 'index.html');
            exists = fs.existsSync(filePath);
          }
        }
        if (!exists) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        fs.createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500);
        res.end(String(err));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

module.exports = { startServer };
