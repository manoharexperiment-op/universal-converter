/**
 * Applying a new deploy means reloading the page, which would throw away a
 * conversion that is part-way through. A long video encode can take minutes, so
 * the reload waits until the app is idle rather than interrupting.
 */
let apply: (() => void) | null = null;
let converting = false;

/** Told by the UI whenever a conversion starts or finishes. */
export function setConverting(value: boolean): void {
  converting = value;
  if (!converting) flush();
}

/** A newer build is ready to take over. */
export function queueUpdate(fn: () => void): void {
  apply = fn;
  flush();
}

function flush(): void {
  if (converting || !apply) return;
  const fn = apply;
  apply = null;
  // Let the current task finish before the page goes away.
  setTimeout(fn, 0);
}

/**
 * Keep an open tab on the current deploy. The service worker already claims the
 * page as soon as it activates, but claiming does not re-run the JavaScript that
 * is already loaded, so without this a returning visitor keeps the previous
 * build until they happen to reload twice.
 */
export function watchForNewVersion(): void {
  if (!('serviceWorker' in navigator)) return;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    queueUpdate(() => window.location.reload());
  });

  navigator.serviceWorker.ready
    .then((reg) => {
      const check = () => {
        void reg.update().catch(() => {
          /* offline, or the server is unreachable; try again later */
        });
      };
      // A tab can sit open for days, so poll, and check again when the user
      // comes back to it.
      setInterval(check, 60 * 60 * 1000);
      window.addEventListener('focus', check);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) check();
      });
    })
    .catch(() => {
      /* no service worker on this build */
    });
}
