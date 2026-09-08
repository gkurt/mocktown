/**
 * The `dirs` block, and the `.mocktown/.gitignore` that makes the default layout work.
 *
 * The ignore test shells out to real git on purpose. The rule it encodes is not obvious
 * — `*` matches at every depth, and git never descends into an ignored directory — and
 * the failure it prevents is silent: mocks that look committed and are not.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { workspacePaths, committedDirs, DEFAULT_DIRS } = await import('#src/config/paths.ts');
const { renderLocalIgnore, localIgnoreMisses } = await import('#src/config/ignore.ts');

describe('dirs', () => {
  test('defaults put everything under .mocktown/', () => {
    const paths = workspacePaths('/repo');
    expect(paths.mocksDir).toBe('/repo/.mocktown/mocks');
    expect(paths.issuesDir).toBe('/repo/.mocktown/issues');
    expect(paths.panelsDir).toBe('/repo/.mocktown/panels');
    expect(DEFAULT_DIRS.mocks).toBe('.mocktown/mocks');
  });

  test('a configured directory is honoured', () => {
    expect(workspacePaths('/repo', { mocks: 'test/mocks' }).mocksDir).toBe('/repo/test/mocks');
  });

  test('mocktown.json and .env.mocktown stay at the root', () => {
    const paths = workspacePaths('/repo', { mocks: 'anywhere' });
    expect(paths.projectFile).toBe('/repo/mocktown.json');
    expect(paths.envFile).toBe('/repo/.env.mocktown');
  });

  // `mocktown.json` arrives with a clone and a mock module is imported, so a path that
  // climbs out of the workspace is a traversal with execution on the end of it.
  test('a directory that escapes the workspace is refused', () => {
    expect(() => workspacePaths('/repo', { mocks: '../../.ssh' })).toThrow('must stay inside the workspace');
    expect(() => workspacePaths('/repo', { mocks: '/etc' })).toThrow('must stay inside the workspace');
  });
});

describe('.mocktown/.gitignore', () => {
  test('git tracks the mocks and ignores the rest', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'mocktown-ignore-'));
    await Bun.$`git init -q ${repo}`.quiet();

    const paths = workspacePaths(repo);
    mkdirSync(join(paths.mocksDir, 'svc'), { recursive: true });
    mkdirSync(paths.panelsDir, { recursive: true });
    mkdirSync(paths.issuesDir, { recursive: true });
    writeFileSync(join(paths.mocksDir, 'svc', 'index.ts'), 'export default {};\n');
    writeFileSync(join(paths.panelsDir, 'state.html'), '<p>state</p>\n');
    writeFileSync(join(paths.issuesDir, 'iss_1.json'), '{}\n');
    writeFileSync(paths.localConfig, '{}\n');
    writeFileSync(paths.localIgnore, renderLocalIgnore(paths.localDir, committedDirs(paths)));

    const status = await Bun.$`git -C ${repo} status --porcelain --untracked-files=all`.text();
    const seen = status
      .split('\n')
      .filter(Boolean)
      .map((line) => line.slice(3));

    expect(seen).toContain('.mocktown/mocks/svc/index.ts');
    // Hand-authored like the mocks, and swept into the ignore only because it shares a parent.
    expect(seen).toContain('.mocktown/panels/state.html');
    expect(seen).toContain('.mocktown/.gitignore');
    expect(seen.some((path) => path.includes('issues'))).toBe(false);
    expect(seen.some((path) => path.includes('config.local.json'))).toBe(false);
  }, 20_000);

  test('a mocks directory outside .mocktown needs no line, and is not reported missing', () => {
    const paths = workspacePaths('/repo', { mocks: 'mocks', panels: 'panels' });
    const rendered = renderLocalIgnore(paths.localDir, committedDirs(paths));
    expect(rendered).not.toContain('!/mocks/');
    expect(rendered).not.toContain('!/panels/');
    expect(localIgnoreMisses('/repo/.mocktown/.gitignore', paths.localDir, committedDirs(paths))).toEqual([]);
  });

  test('a moved directory inside .mocktown is reported until the line is there', () => {
    const paths = workspacePaths('/repo', { mocks: '.mocktown/handwritten' });
    expect(localIgnoreMisses('/repo/.mocktown/.gitignore', paths.localDir, committedDirs(paths))).toEqual(['handwritten', 'panels']);
    expect(renderLocalIgnore(paths.localDir, committedDirs(paths))).toContain('!/handwritten/');
  });
});
