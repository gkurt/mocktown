/**
 * The container runtime, behind one seam.
 *
 * 04-sandbox.md's decision is that "container" means *any network boundary Mocktown
 * owns* — the primary target is an OCI image, but the same layer has to be attachable to
 * sandboxes users already have (E2B, Daytona, plain docker/podman, CI runners). So every
 * container operation in the codebase goes through this file, and nothing above it knows
 * which CLI is installed.
 *
 * Podman is accepted on its CLI compatibility, not on a claim of equivalence: spike 04
 * tested Docker only, and `--internal` is a Docker concept the podman network driver
 * implements separately. `mocktown sandbox verify` is what settles the question on a
 * given host — it runs the escape attempts against a negative control rather than
 * trusting either CLI's flags.
 */
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class EngineError extends Error {
  readonly result: RunResult;
  constructor(message: string, result: RunResult) {
    super(message);
    this.result = result;
  }
}

const CANDIDATES = ['docker', 'podman'] as const;

export class ContainerEngine {
  readonly bin: string;

  private constructor(bin: string) {
    this.bin = bin;
  }

  /** The engine, or `null` when none is installed — a missing runtime is a report, not a crash. */
  static async detect(): Promise<ContainerEngine | null> {
    const preferred = process.env.MOCKTOWN_CONTAINER_ENGINE;
    for (const bin of preferred ? [preferred] : CANDIDATES) {
      const probe = await exec(bin, ['version', '--format', '{{.Server.Version}}']);
      if (probe.code === 0) return new ContainerEngine(bin);
    }
    return null;
  }

  async run(args: string[], options: { input?: string; allowFail?: boolean } = {}): Promise<RunResult> {
    const result = await exec(this.bin, args, options.input);
    if (result.code !== 0 && !options.allowFail) {
      throw new EngineError(
        `${this.bin} ${args.slice(0, 3).join(' ')} failed (${result.code}): ${result.stderr.trim().slice(0, 400)}`,
        result,
      );
    }
    return result;
  }

  async imageExists(tag: string): Promise<boolean> {
    return (await this.run(['image', 'inspect', tag], { allowFail: true })).code === 0;
  }

  /** Build from a Dockerfile held in memory: the images are generated, never checked in. */
  async build(tag: string, dockerfile: string, context: string): Promise<RunResult> {
    return this.run(['build', '-t', tag, '-f', '-', context], { input: dockerfile });
  }

  async networkExists(name: string): Promise<boolean> {
    return (await this.run(['network', 'inspect', name], { allowFail: true })).code === 0;
  }

  async removeNetwork(name: string): Promise<void> {
    await this.run(['network', 'rm', name], { allowFail: true });
  }

  async removeContainer(name: string): Promise<void> {
    await this.run(['rm', '-f', name], { allowFail: true });
  }

  async containerRunning(name: string): Promise<boolean> {
    const result = await this.run(['inspect', '-f', '{{.State.Running}}', name], { allowFail: true });
    return result.code === 0 && result.stdout.trim() === 'true';
  }

  async exec(container: string, command: string[], options: { allowFail?: boolean; workdir?: string } = {}): Promise<RunResult> {
    const args = ['exec', ...(options.workdir ? ['-w', options.workdir] : []), container, ...command];
    return this.run(args, { allowFail: options.allowFail ?? true });
  }

  /** `sh -c` inside the sandbox: what a flow, a test command or an agent actually runs. */
  async shell(container: string, script: string, workdir?: string): Promise<RunResult> {
    return this.exec(container, ['sh', '-lc', script], { workdir, allowFail: true });
  }

  async logs(name: string, tail = 50): Promise<string> {
    const result = await this.run(['logs', '--tail', String(tail), name], { allowFail: true });
    return `${result.stdout}${result.stderr}`;
  }
}

function exec(bin: string, args: string[], input?: string): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: 127, stdout: '', stderr: String(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }));
    child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin?.end(input);
  });
}
