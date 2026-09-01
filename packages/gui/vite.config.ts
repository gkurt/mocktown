import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
