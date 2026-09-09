import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * No stylesheet in this build may reach off the machine.
 *
 * DialKit's stylesheet opens with `@import url(https://fonts.googleapis.com/…)` for Geist
 * Mono, and this shell may not make that request: it is served under a CSP with no external
 * origin in it (gui/serve.ts), so the fetch is refused and logged on every page load — and a
 * tool whose whole premise is that nothing leaves the machine silently has no business
 * asking Google for a font. The controls fall back to `monospace`, which is the stack the
 * rest of the shell uses anyway.
 *
 * Written as a policy rather than as a patch for one package, so the next dependency that
 * ships a remote `@import` is caught by the build instead of by a CSP refusal in the console.
 */
const localFontsOnly = {
  name: 'mocktown:local-fonts-only',
  enforce: 'pre' as const,
  transform(code: string, id: string) {
    if (!id.split('?')[0]?.endsWith('.css')) return null;
    const stripped = code.replace(/@import\s+url\(\s*['"]?https?:\/\/[^)]*\)\s*;/g, '');
    if (stripped === code) return null;
    console.info(`[mocktown] dropped a remote @import from ${id}`);
    return { code: stripped, map: null };
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), localFontsOnly],
  // The shell imports `mocktown/contract` for its types, and that package addresses its own
  // files through subpath imports (`#src/...`). Resolving a linked workspace package's
  // `imports` field is not something to leave to bundler resolution order, so it is spelled
  // out here.
  resolve: {
    alias: [{ find: /^#src\//, replacement: `${join(here, '..', 'mocktown', 'src')}/` }],
  },
  // The daemon always serves the shell at the origin root, and absolute asset paths are
  // what keep a deep SPA route ('/issues/…') from asking for assets under itself.
  base: '/',
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
  server: { port: 4599 },
});
