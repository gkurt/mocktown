/**
 * `mocktown.json`'s JSON Schema, generated from the Zod schema that already defines it.
 *
 * Every option in that file existed only as a Zod field, so writing one by hand meant
 * knowing the key already — no completion, no hover text, and a typo that surfaced as a
 * parse failure the next time a command ran rather than as a squiggle while typing it. The
 * settings screen answered that for people who open the GUI; this answers it for the editor
 * the file is actually edited in.
 *
 * Generated, never hand-maintained, and deliberately not committed: it describes the
 * *installed* mocktown, so a checked-in copy would go stale against a colleague's version
 * and start reporting valid config as invalid. It is rewritten whenever mocktown touches
 * the workspace, which is what makes a fresh clone's `$schema` resolve after one command.
 */
import { writeFileSync } from 'node:fs';
import * as z from 'zod/v4';
import { ProjectFile } from '#src/config/schema.ts';

/** Where the schema lives, relative to the repo root — the value `$schema` points at. */
export const SCHEMA_REF = '.mocktown/mocktown.schema.json';

export function projectFileJsonSchema(): Record<string, unknown> {
  // `io: 'input'` describes what someone *writes*: a field with a default is optional in the
  // file and present after parsing, and the output view would mark every one of them
  // required — turning an empty, valid `{ "project": "x" }` into a wall of editor errors.
  const schema = z.toJSONSchema(ProjectFile, { io: 'input' });
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'mocktown.json',
    description: 'A mocktown project: which dependencies are mocked, how they are served, and what the capture keeps.',
    ...schema,
  };
}

export function writeProjectFileJsonSchema(path: string): void {
  writeFileSync(path, `${JSON.stringify(projectFileJsonSchema(), null, 2)}\n`);
}
