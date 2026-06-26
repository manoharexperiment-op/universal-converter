import React from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './App';
import './index.css';

// Defensive: in the native app, make sure no service worker is left controlling
// the WebView. A SW registered by an older PWA-enabled build keeps serving a
// cached index.html that bypasses Capacitor's native-bridge injection, which
// makes isNativePlatform() false and breaks native file saving. The native
// build ships no SW, but an SW from a previous install survives an app update —
// so unregister any that exist and drop their caches.
if (Capacitor.isNativePlatform() && 'serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((r) => r.unregister());
  });
  if (window.caches) {
    caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)));
  }
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
