/**
 * Path shortening in the human rendering. The prefix guard is the part worth pinning: a
 * home of `/Users/ann` must not claim `/Users/annex`, and a sibling account's path has to
 * survive untouched.
 */
import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';

const { tilde, renderResult } = await import('#src/cli/render.ts');

const HOME = homedir();

describe('tilde', () => {
  test('shortens a path under the home directory', () => {
    expect(tilde(`  data dir ${HOME}/Library/Application Support/mocktown/main`)).toBe(
      '  data dir ~/Library/Application Support/mocktown/main',
    );
  });

  test('leaves a sibling directory sharing the prefix alone', () => {
    expect(tilde(`${HOME}2/Work/repo`)).toBe(`${HOME}2/Work/repo`);
  });

  test('shortens every occurrence in one line', () => {
    expect(tilde(`${HOME}/a -> ${HOME}/b`)).toBe('~/a -> ~/b');
  });

  test('leaves paths outside home alone', () => {
    expect(tilde('/opt/homebrew/bin/mocktown')).toBe('/opt/homebrew/bin/mocktown');
  });
});

describe('renderResult', () => {
  test('shortens paths in a rendered listing', () => {
    const lines = renderResult(['project', 'list'], {
      project: 'demo',
      default: 'main',
      projects: [
        {
          name: 'demo',
          dataDir: `${HOME}/Library/Application Support/mocktown/demo`,
          workspace: `${HOME}/Work/demo`,
          workspaceExists: true,
        },
      ],
    });

    expect(lines.join('\n')).toContain('~/Library/Application Support/mocktown/demo');
    expect(lines.join('\n')).toContain('~/Work/demo');
    expect(lines.join('\n')).not.toContain(HOME);
  });

  test('leaves shell-pasteable output alone, tilde and all', () => {
    const lines = renderResult(['env', 'get'], {
      project: 'demo',
      variables: { NODE_EXTRA_CA_CERTS: `${HOME}/Library/Application Support/mocktown/demo/ca.pem` },
      report: [],
      agentTasks: [],
      written: [],
      notes: [],
    });

    // A `~` inside the quotes shellAssignment adds is a literal no shell expands.
    expect(lines.join('\n')).toContain(`${HOME}/Library/Application Support/mocktown/demo/ca.pem`);
    expect(lines.join('\n')).not.toContain('~/');
  });

  test('marks a workspace that is gone', () => {
    const lines = renderResult(['project', 'list'], {
      project: 'demo',
      default: 'main',
      projects: [{ name: 'demo', dataDir: `${HOME}/data`, workspace: `${HOME}/Work/gone`, workspaceExists: false }],
    });

    expect(lines.join('\n')).toContain('~/Work/gone (gone)');
  });
});
