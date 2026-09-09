/**
 * The colour scheme setting.
 *
 * `system` is the default and stays a choice rather than a starting point: it is the absence
 * of the `data-theme` attribute, so the palette's `light-dark()` tokens follow
 * `prefers-color-scheme` with nothing in the way. `light` and `dark` pin it.
 *
 * The value is read back out of the DOM rather than kept in a module variable, because
 * public/theme.js has already applied it by the time this module loads and one of the two
 * would otherwise be lying.
 */
import { useSyncExternalStore } from 'react';

export type Scheme = 'system' | 'light' | 'dark';

const KEY = 'mocktown:scheme';

export const SCHEMES: Scheme[] = ['system', 'light', 'dark'];

const read = (): Scheme => {
  const applied = document.documentElement.dataset.theme;
  return applied === 'light' || applied === 'dark' ? applied : 'system';
};

const watchers = new Set<() => void>();

export function setScheme(scheme: Scheme): void {
  if (scheme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = scheme;

  try {
    if (scheme === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, scheme);
  } catch {
    // The scheme still applies to this page; it just will not survive a reload.
  }

  for (const watch of watchers) watch();
}

const subscribe = (watch: () => void) => {
  watchers.add(watch);
  return () => void watchers.delete(watch);
};

export const useScheme = (): Scheme => useSyncExternalStore(subscribe, read, () => 'system');
