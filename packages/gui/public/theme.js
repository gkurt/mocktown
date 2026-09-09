/*
 * The stored scheme, applied before the first paint.
 *
 * This is a plain blocking script rather than part of the bundle because the bundle is a
 * module and every module is deferred: by the time it runs the page has already painted
 * once, in whichever scheme the OS prefers, and a reader who chose the other one sees a
 * flash of it on every load. It also cannot be inlined — the shell is served under
 * `script-src 'self'` (gui/serve.ts) — so it is a file in `public/`, copied to the build
 * root and served by the daemon like any other asset.
 *
 * The key and the values are duplicated in src/theme.ts, which owns the setting from there
 * on. Two lines of duplication is the price of running before the bundle exists.
 */
try {
  const stored = localStorage.getItem('mocktown:scheme');
  if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored;
} catch {
  /* Private mode, or storage denied. Following the OS is the right answer anyway. */
}
