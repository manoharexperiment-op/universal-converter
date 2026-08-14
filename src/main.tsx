import React from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './App';
import { purgeExportCache } from './lib/download';
import { watchForNewVersion } from './lib/appUpdate';
import './index.css';

// Sharing a converted file has to stage a copy in app cache, and the receiving
// app still needs it after we hand it over. Clear last session's leftovers now.
void purgeExportCache();

// Defensive: in the native app, make sure no service worker is left controlling
// the WebView. A SW registered by an older PWA-enabled build keeps serving a
// cached index.html that bypasses Capacitor's native-bridge injection, which
// makes isNativePlatform() false and breaks native file saving. The native
// build ships no SW, but an SW from a previous install survives an app update,
// so unregister any that exist and drop their caches.
if (Capacitor.isNativePlatform() && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => r.unregister());
  });
  if (window.caches) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  }
} else {
  // On the web, pick up a new deploy without waiting for the user to reload
  // twice. Deferred while a conversion is running.
  watchForNewVersion();
}

// Self-heal stale deploys: a lazy-loaded chunk (every converter dynamically
// imports its library) can 404 after a redeploy, because the browser/service-
// worker cache still points at an old hashed filename that no longer exists on
// the server, the "Failed to fetch dynamically imported module" error. Reload
// once to pick up the current build. The sessionStorage guard prevents a loop.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault();
  // Reload at most once per 15 s, prevents an infinite loop if a chunk is
  // genuinely missing, but still self-heals on any later redeploy.
  const last = Number(sessionStorage.getItem('chunkReloadAt') || 0);
  if (Date.now() - last < 15000) return;
  sessionStorage.setItem('chunkReloadAt', String(Date.now()));
  window.location.reload();
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
