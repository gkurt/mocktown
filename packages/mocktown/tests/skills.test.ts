/**
 * The shipped skill pack.
 *
 * A skill is a directory now, not a string, and the two ways it can rot are both silent:
 * SKILL.md routing to a file that is not there, and a file in the directory that SKILL.md
 * never mentions — an agent invoked with that argument reads nothing and improvises. Both
 * are checked here, along with the frontmatter, which agent hosts validate against a fixed
 * set of keys and reject outright when it carries anything else.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { SKILLS, SKILL_ENTRY, exportSkill, findSkill, skillFile, skillTopics } = await import('#src/skills/index.ts');

/** What Anthropic's own skill validator accepts. `version` is not among them. */
const ALLOWED_FRONTMATTER = new Set(['name', 'description', 'license', 'allowed-tools', 'metadata', 'compatibility']);

describe('the mocktown pack', () => {
  const skill = findSkill('mocktown')!;

  test('is the one skill shipped, and its identity comes from SKILL.md', () => {
    expect(SKILLS).toHaveLength(1);
    const entry = skillFile(skill)!.text;
    expect(entry.startsWith('---\n')).toBe(true);
    expect(entry).toContain(`name: ${skill.name}`);
    expect(entry).toContain(`version: ${skill.version}`);
  });

  // The failure this catches is silent at the install end: `skills add` parses the
  // frontmatter as real YAML and skips a skill whose SKILL.md it cannot read, so a
  // description carrying an unquoted `: ` installs as nothing at all.
  test('the frontmatter is YAML an agent host will accept', () => {
    const block = /^---\n([\s\S]*?)\n---/.exec(skillFile(skill)!.text)![1]!;
    const parsed = Bun.YAML.parse(block) as Record<string, unknown>;

    expect(Object.keys(parsed).filter((key) => !ALLOWED_FRONTMATTER.has(key))).toEqual([]);
    expect(parsed.name).toBe(skill.name);
    expect(parsed.description).toBe(skill.summary);
    // The version has to live somewhere, and `metadata` is the allowed home for it.
    expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('every argument SKILL.md routes to is a file, and every file is routed to', () => {
    const entry = skillFile(skill)!.text;
    const linked = new Set([...entry.matchAll(/\(([\w-]+\.md)\)/g)].map((m) => m[1]));
    const shipped = new Set(skill.files.map((f) => f.path).filter((path) => path !== SKILL_ENTRY));

    expect([...linked].filter((path) => !shipped.has(path!))).toEqual([]);
    expect([...shipped].filter((path) => !linked.has(path))).toEqual([]);
  });

  test('an argument resolves with or without the extension, and a wrong one does not', () => {
    expect(skillTopics(skill)).toContain('generate-mock');
    expect(skillFile(skill, 'generate-mock')?.path).toBe('generate-mock.md');
    expect(skillFile(skill, 'generate-mock.md')?.path).toBe('generate-mock.md');
    // No argument is the entry: that is what makes SKILL.md the router.
    expect(skillFile(skill)?.path).toBe(SKILL_ENTRY);
    expect(skillFile(skill, 'no-such-job')).toBeUndefined();
  });

  // The house rules were pasted into two packs before this restructure. One copy is the
  // point of a directory, so the jobs that need them link rather than repeat them.
  test('the house rules are written once and linked from the jobs that bind to them', () => {
    const bodies = skill.files.filter((f) => f.path !== 'house-rules.md');
    expect(
      bodies
        .filter((f) => f.text.includes('house-rules.md'))
        .map((f) => f.path)
        .sort(),
    ).toEqual([SKILL_ENTRY, 'fix-issues.md', 'generate-mock.md']);
    expect(bodies.filter((f) => f.text.includes('Never invent auth-shaped fields'))).toEqual([]);
  });
});

describe('export', () => {
  test('lands as <container>/<name>/SKILL.md, which is what an installer discovers', () => {
    const container = mkdtempSync(join(tmpdir(), 'mocktown-skills-'));
    const skill = findSkill('mocktown')!;
    const { dir, files } = exportSkill(container, skill);

    expect(dir).toBe(join(container, 'mocktown'));
    expect(files).toHaveLength(skill.files.length);
    expect(readFileSync(join(dir, SKILL_ENTRY), 'utf8')).toContain('name: mocktown');
    // Newline-terminated, so a frontmatter parser and an editor both see a normal file.
    for (const file of files) expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true);
  });
});
