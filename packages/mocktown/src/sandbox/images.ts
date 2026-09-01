/**
 * The two images the sandbox is made of, generated rather than checked in so the CA they
 * trust is the *project's* CA and nothing else.
 *
 * **The relay carries no CA and no key.** It forwards bytes; the front door on the host
 * terminates TLS, exactly as it does for a recorded child process. Spike 04 mounted the
 * CA private key into its front-door container because the proxy ran there; keeping the
 * proxy on the host removes that mount, so 10-security.md's blast radius shrinks rather
 * than grows when the sandbox is in use.
 *
 * The app image is where 04-sandbox.md's "TLS just works" is solved at build time: the
 * certificate goes into the system trust store plus every per-runtime knob, so unmodified
 * code inside the sandbox reaches the mocks with TLS verified — no `-k`, no proxy
 * variables, no Mocktown code in the image at all.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Pinned: an image that silently moves underneath a seal stamp makes the stamp a lie. */
export const RELAY_BASE = 'alpine:3.21';
export const DEFAULT_SANDBOX_BASE = 'node:22-bookworm-slim';

/**
 * Images are tagged by what is *in* them, not by a version we remember to bump. A
 * generated Dockerfile that changes — a new package, a regenerated CA — produces a new
 * tag, so `ensureImages` rebuilds without being told to. The alternative bit us during
 * development: a fixed tag silently kept serving an image built before the Chromium trust
 * store was added, and the sandbox looked broken rather than stale.
 */
export function imageTag(name: string, ...contents: string[]): string {
  const digest = createHash('sha256').update(contents.join('\u0000')).digest('hex').slice(0, 12);
  return `mocktown/${name}:${digest}`;
}

export const CA_PATH_IN_IMAGE = '/usr/local/share/ca-certificates/mocktown-ca.crt';
export const SYSTEM_BUNDLE = '/etc/ssl/certs/ca-certificates.crt';
export const CHROMIUM_PATH = '/usr/bin/chromium';

/**
 * dnsmasq answers every name with the relay's own address and socat forwards 80/443 to
 * the front door. Nothing else is installed, and nothing is baked in: the entrypoint is
 * passed at run time so the image holds no addresses and can be shared across projects.
 */
export function relayDockerfile(): string {
  return [
    `FROM ${RELAY_BASE}`,
    '# dnsmasq is the catch-all resolver; socat is the only route off the sealed network.',
    'RUN apk add --no-cache dnsmasq socat',
    'EXPOSE 53/udp 80 443',
  ].join('\n');
}

/**
 * The relay's command. `address=/#/<self>` is dnsmasq's catch-all, and it is the whole
 * point: with a per-host alias list an unknown hostname returns NXDOMAIN and the app
 * reports a DNS failure, whereas the catch-all sends it to the deny wall where it becomes
 * a filed issue with the full request (04-sandbox.md, spike 04).
 *
 * `--local=/#/` matters as much as the catch-all, for the same reason. `--address` only
 * defines an A record, so with no upstream to ask, dnsmasq REFUSES the AAAA half of every
 * lookup — and musl (Alpine, and everything built on it) treats a refusal on either half as
 * a hard failure, so every hostname becomes "bad address". `--local` makes dnsmasq
 * authoritative for the same catch-all domain, which turns that refusal into an empty
 * answer. The sealed network has no IPv6 at all, so empty is the honest reply; glibc merely
 * happens to tolerate the refusal, which is why this only shows up on some base images.
 * `--filter-AAAA` does not fix it — it strips AAAA records from answers dnsmasq already
 * has, and here there is no answer to strip.
 *
 * The 443 forwarder runs in the foreground, so if it dies the container dies with it. A
 * relay that stays up with a dead forwarder would look healthy while every request in the
 * sandbox failed.
 *
 * Published ports arrive here too, and they have to: a container on an `--internal`
 * network cannot publish a port at all, because there is no route for the engine's proxy
 * to reach it. So the relay — which is on both networks — publishes them and forwards each
 * one *inwards* to the app. Inbound only; nothing about it lets the app start a connection
 * outwards, which is the direction the guarantee is about (04-sandbox.md).
 */
export function relayCommand(selfIp: string, frontDoor: string, appIp: string, ports: PortMapping[] = []): string[] {
  return [
    'sh',
    '-c',
    [
      'set -e',
      `dnsmasq --no-daemon --no-resolv --local=/#/ --address=/#/${selfIp} &`,
      `socat TCP-LISTEN:80,fork,reuseaddr TCP:${frontDoor} &`,
      ...ports.map((port) => `socat TCP-LISTEN:${port.container},fork,reuseaddr TCP:${appIp}:${port.container} &`),
      `exec socat TCP-LISTEN:443,fork,reuseaddr TCP:${frontDoor}`,
    ].join('\n'),
  ];
}

export interface PortMapping {
  host: number;
  container: number;
}

/** `"3000"` and `"8080:3000"` are both accepted; anything else is a configuration error. */
export function parsePortMapping(spec: string): PortMapping {
  const [left, right] = spec.split(':');
  const host = Number(left);
  const container = right === undefined ? host : Number(right);
  if (!Number.isInteger(host) || !Number.isInteger(container) || host < 1 || container < 1) {
    throw new Error(`"${spec}" is not a port mapping — use "3000" or "8080:3000"`);
  }
  return { host, container };
}

export interface SandboxImageOptions {
  base: string;
  /** Headless Chromium, so an agent testing a web app browses *inside* the boundary. */
  browser: boolean;
}

/**
 * Add the CA to a home directory's NSS database — Chromium's trust store on Linux. The
 * database may not exist yet (`-N`) and may already hold the certificate from an earlier
 * build (`-A` replaces), so both are tolerated; only a genuinely failed import is fatal.
 */
export function nssTrustScript(home: string): string {
  return [
    `mkdir -p ${home}/.pki/nssdb`,
    `certutil -d sql:${home}/.pki/nssdb -N --empty-password 2>/dev/null || true`,
    `certutil -d sql:${home}/.pki/nssdb -A -t "C,," -n mocktown -i ${CA_PATH_IN_IMAGE}`,
  ].join(' \\\n && ');
}

export function sandboxDockerfile(options: SandboxImageOptions): string {
  const packages = ['ca-certificates', 'curl', 'python3'];
  // Chromium does not read the system store: it has its own NSS database, and without
  // `certutil` to populate it every mocked page is a full-screen certificate warning.
  const apt = [...packages, 'dnsutils', ...(options.browser ? ['chromium', 'libnss3-tools'] : [])];
  const apk = [...packages, 'bind-tools', ...(options.browser ? ['chromium', 'nss-tools'] : [])];

  return [
    `FROM ${options.base}`,
    'USER root',
    "# The base image is the user's choice, so the package manager has to be discovered",
    '# rather than assumed — Debian, Alpine and RPM bases all appear in real devcontainers.',
    'RUN set -eu; \\',
    `    if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends ${apt.join(' ')} && rm -rf /var/lib/apt/lists/*; \\`,
    `    elif command -v apk >/dev/null 2>&1; then apk add --no-cache ${apk.join(' ')}; \\`,
    `    elif command -v microdnf >/dev/null 2>&1; then microdnf install -y ${apt.join(' ')}; \\`,
    `    elif command -v dnf >/dev/null 2>&1; then dnf install -y ${apt.join(' ')}; \\`,
    '    else echo "no supported package manager in this base image" >&2; exit 1; fi',
    '',
    '# 04-sandbox.md: the project CA in the system store *and* every per-runtime knob, at',
    '# build time. Only the certificate is copied — the private key never leaves the host.',
    `COPY ca.pem ${CA_PATH_IN_IMAGE}`,
    'RUN update-ca-certificates || update-ca-trust extract',
    `ENV NODE_EXTRA_CA_CERTS=${CA_PATH_IN_IMAGE} \\`,
    `    REQUESTS_CA_BUNDLE=${SYSTEM_BUNDLE} \\`,
    `    SSL_CERT_FILE=${SYSTEM_BUNDLE} \\`,
    `    CURL_CA_BUNDLE=${SYSTEM_BUNDLE} \\`,
    `    DENO_CERT=${CA_PATH_IN_IMAGE} \\`,
    '    MOCKTOWN_SANDBOX=1',
    ...(options.browser
      ? [
          '# The browser half of "TLS just works": Chromium trusts its own NSS database and',
          '# nothing else, so the same certificate is added there too.',
          `RUN ${nssTrustScript('/root')}`,
          '# Playwright and Puppeteer both take an executable path from the environment, so a',
          '# browser test written for a laptop runs unchanged inside the boundary.',
          `ENV CHROME_PATH=${CHROMIUM_PATH} \\`,
          `    PUPPETEER_EXECUTABLE_PATH=${CHROMIUM_PATH} \\`,
          `    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=${CHROMIUM_PATH}`,
        ]
      : []),
    '',
    '# No proxy variables, deliberately. Inside the sandbox interception is DNS-level, so',
    '# the app is unmodified code — which is what makes a seal run evidence rather than a',
    '# test of our own environment setup (05-redirection.md).',
    'WORKDIR /workspace',
  ].join('\n');
}

/**
 * The build context: a directory holding the certificate and nothing else. The project CA
 * directory itself is never used as a context — it also contains the private key, and a
 * build context is uploaded wholesale to the engine daemon.
 */
export function writeBuildContext(dir: string, caCert: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ca.pem'), caCert);
  return dir;
}
