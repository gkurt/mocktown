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

const { FrontDoor, sidecarIn } = await import('#src/frontdoor/controller.ts');
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

describe('replacing the rule set', () => {
  /**
   * Mockttp subscribes a channel per matcher, step and completion checker to the one shared
   * admin stream, and disposes only the server's copy — so every re-apply used to pin
   * another set there for good: 87 listeners, then 173, then 259, climbing for the life of
   * the daemon. Flat across applies is the whole claim.
   */
  test("releases the previous set's channels", async () => {
    const ca = await ensureProjectCa('frontdoor-test');
    const door = new FrontDoor({ ca });
    await door.start();
    try {
      const stream = (door as unknown as { proxy: { adminClient: { adminStream: NodeJS.EventEmitter } } }).proxy.adminClient.adminStream;
      // A different signature each pass, or `applyRouting` short-circuits and proves nothing.
      const apply = (pass: number) =>
        door.applyRouting({
          fallthrough: 'deny',
          routes: Array.from({ length: 10 }, (_, i) => ({ host: `h${i}-pass${pass}.example.test`, mode: 'record' as const })),
        });

      await apply(1);
      const afterFirst = stream.listenerCount('finish');
      expect(afterFirst).toBeGreaterThan(10);

      await apply(2);
      await apply(3);
      expect(stream.listenerCount('finish')).toBe(afterFirst);
      expect(stream.listenerCount('error')).toBe(afterFirst - 1);
    } finally {
      await door.stop();
    }
  }, 60_000);
});

describe('which sidecar the front door spawns', () => {
  test('compiled once installed, source in a checkout', () => {
    // Node refuses to type-strip TypeScript under node_modules, so an install that reached
    // for the source could not proxy at all — the whole reason prepack compiles it.
    expect(sidecarIn(join('/app', 'node_modules', 'mocktown', 'src', 'frontdoor'))).toEndWith('sidecar.js');
    expect(sidecarIn(join('/repo', 'packages', 'mocktown', 'src', 'frontdoor'))).toEndWith('sidecar.ts');

    // pnpm puts the real copy two levels of node_modules down; it is still an install.
    expect(sidecarIn(join('/app', 'node_modules', '.pnpm', 'mocktown@0.4.0', 'node_modules', 'mocktown', 'src', 'frontdoor'))).toEndWith(
      'sidecar.js',
    );

    // A checkout that has run `bun pm pack` has a stale sidecar.js beside the source. The
    // rule is where the code lives, not what is lying next to it, so the edit still wins.
    expect(sidecarIn(join('/repo', 'packages', 'mocktown', 'src', 'frontdoor'))).not.toEndWith('sidecar.js');
  });
});
