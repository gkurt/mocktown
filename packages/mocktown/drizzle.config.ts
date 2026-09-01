/**
 * Drizzle Kit config. `dbCredentials.url` points at whichever project the CLI resolved,
 * which is what makes `mocktown studio` open the right database (09-gui-plugins.md).
 */
import { defineConfig } from 'drizzle-kit';
import { projectPaths } from '#src/config/paths.ts';

const project = process.env.MOCKTOWN_PROJECT ?? 'main';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.MOCKTOWN_DB ?? projectPaths(project).db },
});
