/**
 * Skills / prompt packs — 07-issues-agent-loop.md's second agent surface.
 *
 * "Versioned prompt+house-rules bundles shipped with Mocktown for the three recurring
 * jobs — *generate mock from corpus*, *fix issue backlog*, *apply redirect recipes*.
 * House rules live here."
 *
 * There is one skill, `mocktown`, and the job is its argument: `/mocktown generate-mock`
 * sends the agent to `generate-mock.md`. That is the shape every agent host already
 * expects — `skills/<name>/SKILL.md` plus the files it points at — so the same directory
 * installs with `skills add` (cli/index.ts) and serves over the API unchanged, and the
 * house rules are written once instead of pasted into every job.
 *
 * The pack itself lives at the **repo root**, in `skills/mocktown/` — the layout the open
 * skills ecosystem discovers, so `npx skills add gkurt/mocktown` installs it straight from
 * GitHub with no checkout and no mocktown install. This module is a view onto those files,
 * not their home.
 *
 * The text itself comes from `pack.gen.ts`, which `scripts/gen-skills.mts` writes from
 * those files — inlined rather than read from disk, so the compiled single binary carries
 * the pack without a directory shipped beside it. Generating it is what lets the pack keep
 * the root layout *and* reach a published tarball: a specifier pointing at the repo root
 * leaves the package, and npm cannot carry a path outside the package into the tarball.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { PACK_FILES } from '#src/skills/pack.gen.ts';

/** The file every agent host reads first. The rest of a pack is reached from it. */
export const SKILL_ENTRY = 'SKILL.md';

export interface SkillFile {
  /** Path relative to the skill's own directory. */
  path: string;
  text: string;
}

export interface Skill {
  name: string;
  version: string;
  summary: string;
  /** The whole pack, entry first: a skill is a directory, not a single body. */
  files: SkillFile[];
}

/**
 * SKILL.md's frontmatter is the pack's identity, so name, summary and version are read
 * from the file rather than restated here — a version that disagrees with the installed
 * file is worse than no version at all.
 *
 * Real YAML, not a regex, because an installer parses this file the same way and a
 * frontmatter only *our* reader accepts installs as nothing: a plain scalar containing
 * `: ` is the easy way to write one. Failing here instead means the whole daemon refuses
 * to start, which is the loud end of that trade. `version` is under `metadata` because
 * hosts validate the top-level keys against a fixed set that does not include it.
 */
const Frontmatter = z.object({
  name: z.string(),
  description: z.string(),
  metadata: z.object({ version: z.string() }),
});

function frontmatter(text: string): z.infer<typeof Frontmatter> {
  const block = /^---\n([\s\S]*?)\n---/.exec(text)?.[1];
  if (!block) throw new Error(`skill ${SKILL_ENTRY} has no frontmatter`);
  const parsed = Frontmatter.safeParse(Bun.YAML.parse(block));
  if (!parsed.success) throw new Error(`skill ${SKILL_ENTRY} frontmatter is wrong: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** A name the generator did not write is a bug here, not something to serve as empty. */
function packFile(path: string): string {
  const text = PACK_FILES[path];
  if (text === undefined) throw new Error(`skill pack has no ${path} — run \`bun run gen:skills\``);
  return text;
}

const meta = frontmatter(packFile(SKILL_ENTRY));

export const SKILLS: Skill[] = [
  {
    name: meta.name,
    version: meta.metadata.version,
    summary: meta.description,
    // Entry first, then the jobs in the order SKILL.md routes them, then the shared law.
    files: [
      SKILL_ENTRY,
      'record-flow.md',
      'generate-mock.md',
      'fix-issues.md',
      'apply-redirects.md',
      'write-panel.md',
      'house-rules.md',
    ].map((path) => ({ path, text: packFile(path) })),
  },
];

export function findSkill(name: string): Skill | undefined {
  return SKILLS.find((s) => s.name === name);
}

/** The arguments the skill answers to — every file but the entry, without its extension. */
export function skillTopics(skill: Skill): string[] {
  return skill.files.filter((f) => f.path !== SKILL_ENTRY).map((f) => f.path.replace(/\.md$/, ''));
}

/** No topic means the entry; `generate-mock` and `generate-mock.md` both name the file. */
export function skillFile(skill: Skill, topic?: string | null): SkillFile | undefined {
  if (!topic) return skill.files.find((f) => f.path === SKILL_ENTRY);
  const path = topic.endsWith('.md') ? topic : `${topic}.md`;
  return skill.files.find((f) => f.path === path);
}

/**
 * Write a pack out as `<container>/<name>/…`, which is the layout every skills installer
 * discovers — the container is what gets handed over, not the skill directory itself.
 * Files are newline-terminated because a frontmatter parser on the other side is reading
 * text someone may also open in an editor.
 */
export function exportSkill(container: string, skill: Skill): { dir: string; files: string[] } {
  const dir = join(container, skill.name);
  mkdirSync(dir, { recursive: true });
  const files = skill.files.map((file) => {
    const path = join(dir, file.path);
    writeFileSync(path, file.text.endsWith('\n') ? file.text : `${file.text}\n`);
    return path;
  });
  return { dir, files };
}
