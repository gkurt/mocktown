/**
 * The sealed sandbox — 04-sandbox.md's core promise: an agent running inside it
 * *physically cannot* reach staging or production, because isolation is enforced below
 * the process where no app or agent behaviour can undo it.
 *
 * **Decision: the front door stays on the host; the sandbox reaches it through a relay.**
 * Spike 04 ran a second, containerised proxy inside the sealed network. Shipping that
 * would mean two front doors with two rule sets, and traffic from the sandbox would not
 * land in the same corpus, the same issue queue or the same providers as traffic from a
 * recorded child process. Instead the sealed network's single route out is a relay
 * container running dnsmasq (catch-all) and socat (80/443 → the host front door). The
 * relay terminates nothing and decides nothing: routing, recording, scrubbing, providers
 * and the issue engine are all still the daemon's, so a sandboxed request is
 * indistinguishable from a host one once it arrives.
 *
 * The topology, and why each piece is load-bearing:
 *
 *   ┌── sealed network (--internal: no route out, no NAT) ────────────┐
 *   │  app container            relay container                        │
 *   │  · no proxy env vars      · dnsmasq  address=/#/<relay>          │
 *   │  · CA in trust store      · socat 80,443 → host front door       │
 *   │  · --dns <relay>          └── also on the egress network ────────┼──▶ host
 *   └──────────────────────────────────────────────────────────────────┘
 *
 * The asymmetry is the design: only the relay has a second interface, and the only traffic
 * that crosses it *outwards* is ports 80 and 443 to one fixed address. Published ports
 * cross it inwards, which is a different direction and not the one the guarantee is about.
 * `mocktown sandbox verify` is what proves this on a given host rather than asserting it
 * here.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { ContainerEngine } from '#src/sandbox/engine.ts';
import {
  DEFAULT_SANDBOX_BASE,
  imageTag,
  parsePortMapping,
  relayCommand,
  relayDockerfile,
  sandboxDockerfile,
  writeBuildContext,
} from '#src/sandbox/images.ts';

export type SandboxMode = 'sealed' | 'record';

/**
 * Candidate subnets, tried in order. The relay's address has to be known *before* the
 * container starts — it is both the DNS server the app is given and the address dnsmasq
 * answers every query with — so the network is created with a fixed subnet rather than
 * letting the engine allocate and then inspecting.
 */
const SUBNETS = ['10.77.0.0/24', '10.78.0.0/24', '10.79.0.0/24', '10.80.0.0/24'];

const SandboxState = z.object({
  mode: z.enum(['sealed', 'record']),
  subnet: z.string(),
  relayIp: z.string(),
  frontDoorPort: z.number().int(),
  image: z.string(),
  browser: z.boolean(),
  workspace: z.string().nullable(),
  startedAt: z.string(),
});
export type SandboxState = z.infer<typeof SandboxState>;

export interface SandboxConfig {
  /** Base image the app layer is built on; `auto` picks a sane default. */
  image: string;
  browser: boolean;
  /** Host port publications for the app container, e.g. `3000:3000`. */
  ports: string[];
}

export interface SandboxOptions {
  project: string;
  workspace: string | null;
  dataDir: string;
  /** Read on demand: the CA is generated lazily and only the image build needs it. */
  loadCaCert: () => Promise<string>;
  config: SandboxConfig;
}

export interface SandboxStatus {
  engine: string | null;
  running: boolean;
  mode: SandboxMode | null;
  container: string | null;
  network: string | null;
  relayIp: string | null;
  frontDoorPort: number | null;
  image: string | null;
  browser: boolean;
  workspace: string | null;
  warnings: string[];
}

/** Engine object names are shared across daemon restarts, so they are derived, not stored. */
function names(project: string) {
  const slug = project.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  return {
    sealed: `mocktown-${slug}-sealed`,
    egress: `mocktown-${slug}-egress`,
    relay: `mocktown-${slug}-relay`,
    app: `mocktown-${slug}-app`,
  };
}

export class Sandbox {
  private readonly options: SandboxOptions;
  private readonly names: ReturnType<typeof names>;
  private readonly stateFile: string;

  constructor(options: SandboxOptions) {
    this.options = options;
    this.names = names(options.project);
    this.stateFile = join(options.dataDir, 'sandbox.json');
  }

  get containerName(): string {
    return this.names.app;
  }

  /**
   * Bring the boundary up. `frontDoorPort` is the port the daemon's front door is
   * *currently* listening on — the sandbox is useless without one, so the caller starts
   * record or serve mode first and passes the port it got.
   */
  async up(opts: { mode: SandboxMode; frontDoorPort: number; rebuild?: boolean }): Promise<SandboxStatus> {
    const engine = await requireEngine();
    await this.down();

    const { image, relay } = await this.ensureImages(engine, opts.rebuild ?? false);
    const ports = this.options.config.ports.map(parsePortMapping);
    const { subnet, relayIp, appIp } = await this.createNetworks(engine);

    // The relay is created on the *egress* network and then joined to the sealed one.
    // Order matters: published ports are set up at creation, and a container created on an
    // `--internal` network has no route for the engine's proxy to publish through.
    // `host-gateway` is how it reaches the front door on Linux; Docker Desktop defines the
    // name already, and redefining it there is harmless.
    await engine.run([
      'run',
      '-d',
      '--name',
      this.names.relay,
      '--label',
      `mocktown.project=${this.options.project}`,
      '--network',
      this.names.egress,
      '--add-host',
      'host.docker.internal:host-gateway',
      ...ports.flatMap((port) => ['-p', `${port.host}:${port.container}`]),
      relay,
      ...relayCommand(relayIp, `host.docker.internal:${opts.frontDoorPort}`, appIp, ports),
    ]);
    await engine.run(['network', 'connect', '--ip', relayIp, this.names.sealed, this.names.relay]);
    await this.waitForRelay(engine, opts.frontDoorPort);

    await engine.run([
      'run',
      '-d',
      '--name',
      this.names.app,
      '--label',
      `mocktown.project=${this.options.project}`,
      '--network',
      this.names.sealed,
      '--ip',
      appIp,
      // The whole seal in one flag pair: no route off this network, and every hostname
      // resolves to the relay.
      '--dns',
      relayIp,
      ...(this.options.workspace ? ['-v', `${this.options.workspace}:/workspace`, '-w', '/workspace'] : []),
      image,
      // Nothing is run for the user: the container is a place to exec into, so its own
      // process must not be able to fail and take the boundary down with it.
      'tail',
      '-f',
      '/dev/null',
    ]);

    const state: SandboxState = {
      mode: opts.mode,
      subnet,
      relayIp,
      frontDoorPort: opts.frontDoorPort,
      image,
      browser: this.options.config.browser,
      workspace: this.options.workspace,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    return this.status();
  }

  async down(): Promise<{ removed: string[] }> {
    const engine = await ContainerEngine.detect();
    if (!engine) return { removed: [] };

    const removed: string[] = [];
    for (const container of [this.names.app, this.names.relay]) {
      if (await engine.containerRunning(container)) removed.push(container);
      await engine.removeContainer(container);
    }
    for (const network of [this.names.sealed, this.names.egress]) await engine.removeNetwork(network);
    rmSync(this.stateFile, { force: true });
    return { removed };
  }

  async status(): Promise<SandboxStatus> {
    const engine = await ContainerEngine.detect();
    const state = this.readState();
    const idle: SandboxStatus = {
      engine: engine?.bin ?? null,
      running: false,
      mode: null,
      container: null,
      network: null,
      relayIp: null,
      frontDoorPort: null,
      image: null,
      browser: false,
      workspace: null,
      warnings: engine ? [] : ['No container engine found. Install Docker or Podman — without one the sandbox guarantee is unavailable.'],
    };
    if (!engine || !state) return idle;

    const [app, relay] = await Promise.all([engine.containerRunning(this.names.app), engine.containerRunning(this.names.relay)]);
    if (!app && !relay) return idle;

    return {
      engine: engine.bin,
      running: app && relay,
      mode: state.mode,
      container: this.names.app,
      network: this.names.sealed,
      relayIp: state.relayIp,
      frontDoorPort: state.frontDoorPort,
      image: state.image,
      browser: state.browser,
      workspace: state.workspace,
      warnings: [
        ...(app && !relay
          ? [
              'The relay container is gone but the app container is still up. Nothing can leave the sandbox, ' +
                'but nothing can reach a mock either — run `mocktown sandbox down` and bring it up again.',
            ]
          : []),
        ...(relay && !app ? ['The app container is not running. `mocktown sandbox up` again to recreate it.'] : []),
      ],
    };
  }

  /** Run a command inside the boundary — the surface an agent's flows and tests use. */
  async exec(script: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const engine = await requireEngine();
    if (!(await engine.containerRunning(this.names.app))) {
      throw new Error('the sandbox is not running — start it with `mocktown sandbox up`');
    }
    const result = await engine.shell(this.names.app, script, this.options.workspace ? '/workspace' : undefined);
    return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
  }

  readState(): SandboxState | null {
    if (!existsSync(this.stateFile)) return null;
    const parsed = SandboxState.safeParse(JSON.parse(readFileSync(this.stateFile, 'utf8')));
    return parsed.success ? parsed.data : null;
  }

  // ── Construction ────────────────────────────────────────────────────────────

  private async ensureImages(engine: ContainerEngine, rebuild: boolean): Promise<{ image: string; relay: string }> {
    const caCert = await this.options.loadCaCert();
    const context = writeBuildContext(join(this.options.dataDir, 'sandbox-build'), caCert);

    const relayFile = relayDockerfile();
    const relay = imageTag('relay', relayFile);
    if (rebuild || !(await engine.imageExists(relay))) await engine.build(relay, relayFile, context);

    const base = this.options.config.image === 'auto' ? DEFAULT_SANDBOX_BASE : this.options.config.image;
    const appFile = sandboxDockerfile({ base, browser: this.options.config.browser });
    // The certificate is part of the image's identity even though it is not in the
    // Dockerfile text: regenerating the project CA has to produce a different image.
    const image = imageTag(`sandbox-${this.options.project.toLowerCase().replace(/[^a-z0-9_.-]/g, '-')}`, appFile, caCert);
    if (rebuild || !(await engine.imageExists(image))) await engine.build(image, appFile, context);

    return { image, relay };
  }

  /**
   * `--internal` is the namespace guarantee: the engine installs no route out and no NAT,
   * which is what makes raw sockets fail rather than merely discouraging them (spike 04).
   * IPv6 is deliberately not enabled on it — 04-sandbox.md names IPv6 as the classic leak,
   * and a network with no IPv6 at all cannot leak over it.
   */
  private async createNetworks(engine: ContainerEngine): Promise<{ subnet: string; relayIp: string; appIp: string }> {
    await engine.removeNetwork(this.names.sealed);
    await engine.removeNetwork(this.names.egress);

    let lastError = '';
    for (const subnet of SUBNETS) {
      const created = await engine.run(
        ['network', 'create', '--internal', '--subnet', subnet, '--label', `mocktown.project=${this.options.project}`, this.names.sealed],
        { allowFail: true },
      );
      if (created.code === 0) {
        await engine.run(['network', 'create', '--label', `mocktown.project=${this.options.project}`, this.names.egress]);
        return { subnet, relayIp: addressIn(subnet, 2), appIp: addressIn(subnet, 3) };
      }
      lastError = created.stderr.trim();
    }
    throw new Error(`could not create the sealed network on any of ${SUBNETS.join(', ')}: ${lastError}`);
  }

  /**
   * Readiness is proved from inside the relay, in both directions: its own forwarder is
   * listening, and the front door is actually reachable across the egress interface. A
   * relay that is up but cannot reach the front door turns every request in the sandbox
   * into an unexplained connection reset.
   */
  private async waitForRelay(engine: ContainerEngine, frontDoorPort: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    let detail = 'no attempt made';
    while (Date.now() < deadline) {
      const listening = await engine.exec(this.names.relay, ['nc', '-z', '127.0.0.1', '443']);
      const upstream = await engine.exec(this.names.relay, ['nc', '-z', 'host.docker.internal', String(frontDoorPort)]);
      if (listening.code === 0 && upstream.code === 0) return;
      detail =
        listening.code !== 0 ? 'the relay is not listening on 443' : `the relay cannot reach the front door on port ${frontDoorPort}`;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`the sandbox relay never became ready: ${detail}\n${await engine.logs(this.names.relay)}`);
  }
}

/**
 * `.0` is the network and `.1` the gateway, so the relay takes `.2` and the app `.3`.
 * Both are fixed rather than allocated: the relay's address is baked into the app's
 * resolver configuration *and* into dnsmasq's answers, and the relay forwards published
 * ports to the app before the app exists.
 */
export function addressIn(subnet: string, host: number): string {
  const [base] = subnet.split('/');
  const octets = base!.split('.');
  octets[3] = String(host);
  return octets.join('.');
}

async function requireEngine(): Promise<ContainerEngine> {
  const engine = await ContainerEngine.detect();
  if (engine) return engine;
  throw new Error(
    'no container engine found. The sandbox is the only mode that enforces the no-egress guarantee below the process, ' +
      'so it needs Docker or Podman installed. Everything else Mocktown does works without one.',
  );
}
