/**
 * The front door failing to start has to be a named error, not a dead daemon. The proxy is
 * Mockttp in a Node sidecar (02-architecture.md); on a machine with only Bun the spawn
 * fails with ENOENT, an `error` event that used to go unhandled and take the daemon with
 * it — the CLI saw a closed socket and nothing else.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '.tmp-frontdoor');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { FrontDoor } = await import('#src/frontdoor/controller.ts');
const { ensureProjectCa } = await import('#src/frontdoor/ca.ts');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('a missing Node binary', () => {
  test('is reported by name and leaves the front door restartable', async () => {
    const ca = await ensureProjectCa('frontdoor-test');
    const door = new FrontDoor({ ca, nodePath: '/nonexistent/mocktown-test/node' });
    await expect(door.start()).rejects.toThrow(/nonexistent\/mocktown-test\/node.*MOCKTOWN_NODE/);
    // A failed spawn must not be mistaken for a running child, or the next start is refused.
    expect(door.isRunning).toBe(false);
    await door.stop();
  });
});
