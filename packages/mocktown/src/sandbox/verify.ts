/**
 * Sandbox certification — spike 04, shipped as a product command.
 *
 * The spike's central lesson is the reason this is a feature rather than a one-off test:
 * *"every escape attempt failed" is worthless on its own, because a broken script fails
 * too.* So the same attempts run first on an ordinary network, and the seal is judged
 * against that baseline. Running it on the user's own host is the only way to know their
 * engine, their kernel and their network stack behave the way ours did.
 *
 * It is also how the one open item from phase 0 gets closed on any given machine
 * (04-sandbox.md): IPv6 is only *proven* sealed if the control could reach IPv6 in the
 * first place. When it could not, this reports INCONCLUSIVE — never a pass. Reporting it
 * green would be exactly the "classic leak" the design doc warns about, found later in
 * production instead of now.
 */
import { ContainerEngine } from '#src/sandbox/engine.ts';
import type { Sandbox } from '#src/sandbox/sandbox.ts';

export type CheckStatus = 'pass' | 'fail' | 'inconclusive' | 'skipped';

export interface SealCheck {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface SandboxVerifyResult {
  ok: boolean;
  checks: SealCheck[];
  /** The host used for the deny-wall probe, so the caller can confirm the issue landed. */
  probedHost: string | null;
}

/** A hostname nobody owns and no provider serves: the deny wall's input. */
const PROBE_HOST = 'escape-probe.invalid.mocktown';

/** ULA subnet for the control network, so the IPv6 attempts have a source address. */
const CONTROL_ULA = 'fd00:c0de::/64';

/**
 * The attempts, at the layer where cooperation ends: raw TCP and UDP to hard-coded
 * addresses — no DNS, no proxy, no hostname, nothing an app could be persuaded to
 * configure. Carried as a string so it ships inside the compiled binary.
 */
const ESCAPE_ATTEMPTS = `
import json, socket
TIMEOUT = 4

def tcp(host, port):
    try:
        socket.create_connection((host, port), timeout=TIMEOUT).close()
        return {"escaped": True, "detail": "connected"}
    except Exception as e:
        return {"escaped": False, "detail": "%s: %s" % (type(e).__name__, e)}

def udp(host, port, payload):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(TIMEOUT)
        s.sendto(payload, (host, port))
        data, _ = s.recvfrom(512)
        s.close()
        return {"escaped": True, "detail": "got %d bytes back" % len(data)}
    except Exception as e:
        return {"escaped": False, "detail": "%s: %s" % (type(e).__name__, e)}

def tcp6(host, port):
    try:
        s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
        s.settimeout(TIMEOUT)
        s.connect((host, port, 0, 0))
        s.close()
        return {"escaped": True, "detail": "connected over IPv6"}
    except Exception as e:
        return {"escaped": False, "detail": "%s: %s" % (type(e).__name__, e)}

DNS_QUERY = b"\\xab\\xcd\\x01\\x00\\x00\\x01\\x00\\x00\\x00\\x00\\x00\\x00\\x07example\\x03com\\x00\\x00\\x01\\x00\\x01"

print(json.dumps({
    "tcp_cloudflare_dns_443":  tcp("1.1.1.1", 443),
    "tcp_google_dns_443":      tcp("8.8.8.8", 443),
    "tcp_cloudflare_http_80":  tcp("1.1.1.1", 80),
    "udp_google_dns_53":       udp("8.8.8.8", 53, DNS_QUERY),
    "tcp6_cloudflare_dns_443": tcp6("2606:4700:4700::1111", 443),
    "tcp6_google_dns_443":     tcp6("2001:4860:4860::8888", 443),
}))
`.trim();

type Attempts = Record<string, { escaped: boolean; detail: string }>;

export async function verifySandbox(sandbox: Sandbox, options: { mode: 'sealed' | 'record'; image: string }): Promise<SandboxVerifyResult> {
  const engine = await ContainerEngine.detect();
  if (!engine) {
    return {
      ok: false,
      checks: [{ name: 'container engine', status: 'fail', detail: 'no container engine is installed' }],
      probedHost: null,
    };
  }

  const state = sandbox.readState();
  if (!state || !(await engine.containerRunning(sandbox.containerName))) {
    return {
      ok: false,
      checks: [{ name: 'sandbox is running', status: 'fail', detail: 'bring it up first with `mocktown sandbox up`' }],
      probedHost: null,
    };
  }

  const checks: SealCheck[] = [];
  const control = await runControl(engine, options.image);
  checks.push(control.check);

  // 1. DNS: every hostname, known or not, resolves to the relay. A per-host alias list
  //    would answer NXDOMAIN for the unknown one, and the escape would look like a bug
  //    in the app rather than evidence (04-sandbox.md).
  const known = await sandbox.exec(`getent hosts api.stripe.com | awk '{print $1}' | head -1`);
  const unknown = await sandbox.exec(`getent hosts ${PROBE_HOST} | awk '{print $1}' | head -1`);
  const resolvedKnown = known.stdout.trim();
  const resolvedUnknown = unknown.stdout.trim();
  checks.push({
    name: 'DNS override sends every hostname to the front door',
    status: resolvedKnown === state.relayIp && resolvedUnknown === state.relayIp ? 'pass' : 'fail',
    detail: `api.stripe.com=${resolvedKnown || 'unresolved'} unknown=${resolvedUnknown || 'unresolved'} relay=${state.relayIp}`,
  });

  // 2. The wall answers, and it answers over TLS the sandbox already trusts. `curl` with
  //    no `-k` and no proxy variables is the whole "unmodified code" claim in one probe.
  if (options.mode === 'sealed') {
    const probe = await sandbox.exec(`curl -sS --max-time 15 -w '\\n%{http_code}' https://${PROBE_HOST}/steal 2>&1 || true`);
    const lines = probe.stdout.trim().split('\n');
    const status = lines.pop()?.trim();
    const body = lines.join('');
    checks.push({
      name: 'Unknown host is denied by the front door, with TLS trusted',
      status: status === '502' && body.includes('mocktown_denied') ? 'pass' : 'fail',
      detail: `status=${status ?? 'none'} ${body.slice(0, 80)}`,
    });
  } else {
    checks.push({
      name: 'Unknown host is denied by the front door, with TLS trusted',
      status: 'skipped',
      detail: 'the sandbox is in record mode, where an unknown host is new evidence and gets recorded rather than denied',
    });
  }

  // 3. The test the guarantee actually rests on.
  const sealed = readAttempts(await sandbox.exec(`python3 - <<'PY'\n${ESCAPE_ATTEMPTS}\nPY`));
  const ipv4 = Object.entries(sealed).filter(([name]) => !name.startsWith('tcp6'));
  const escaped = ipv4.filter(([, attempt]) => attempt.escaped);
  checks.push({
    name: 'Raw-socket escape attempts all fail',
    status: ipv4.length === 0 ? 'fail' : escaped.length === 0 ? 'pass' : 'fail',
    detail:
      ipv4.length === 0
        ? 'the escape attempts could not be run inside the sandbox'
        : `${ipv4.length} attempts, ${escaped.length} escaped${escaped.length ? `: ${escaped.map(([name]) => name).join(', ')}` : ''}`,
  });

  // 4. IPv6 — only meaningful against a control that could actually reach IPv6.
  const v6 = Object.entries(sealed).filter(([name]) => name.startsWith('tcp6'));
  const v6Blocked = v6.length > 0 && v6.every(([, attempt]) => !attempt.escaped);
  checks.push({
    name: 'IPv6 egress is namespaced identically to IPv4',
    status: !control.ipv6Reachable ? 'inconclusive' : v6Blocked ? 'pass' : 'fail',
    detail: control.ipv6Reachable
      ? v6.map(([name, attempt]) => `${name}=${attempt.escaped ? 'ESCAPED' : 'blocked'}`).join(' ')
      : `blocked when sealed, but this host has no IPv6 egress to leak (${control.ipv6Detail}), so the seal is untested for IPv6`,
  });

  // 5. The relay's second interface must not become a bridge for the app.
  const gateway = state.relayIp.replace(/\.\d+$/, '.1');
  const viaRelay = await sandbox.exec(
    `python3 -c "import socket
try:
    socket.create_connection(('${gateway}', 443), timeout=3); print('reachable')
except Exception: print('blocked')"`,
  );
  checks.push({
    name: "App cannot route via the relay's egress interface",
    status: viaRelay.stdout.includes('blocked') ? 'pass' : 'fail',
    detail: `app -> ${gateway}:443 = ${viaRelay.stdout.trim() || viaRelay.stderr.trim().slice(0, 60)}`,
  });

  return { ok: checks.every((c) => c.status !== 'fail'), checks, probedHost: options.mode === 'sealed' ? PROBE_HOST : null };
}

/**
 * The negative control: the same image, the same script, an ordinary network. Without it
 * every result below is unfalsifiable. The control network is created with IPv6 where the
 * engine allows it, because the IPv6 half of the seal cannot be judged otherwise — that
 * is the phase-3 follow-up 04-sandbox.md asks for by name.
 */
async function runControl(
  engine: ContainerEngine,
  image: string,
): Promise<{ check: SealCheck; ipv6Reachable: boolean; ipv6Detail: string }> {
  const network = 'mocktown-seal-control';
  const container = 'mocktown-seal-control';
  await engine.removeContainer(container);
  await engine.removeNetwork(network);

  // A ULA subnet, so the control has an IPv6 address to try egress from at all.
  let ipv6 = true;
  let created = await engine.run(['network', 'create', '--ipv6', '--subnet', CONTROL_ULA, network], { allowFail: true });
  let ipv6Detail = '';
  if (created.code !== 0) {
    ipv6 = false;
    ipv6Detail = `the engine refused an IPv6 network: ${created.stderr.trim().slice(0, 120)}`;
    created = await engine.run(['network', 'create', network], { allowFail: true });
  }
  if (created.code !== 0) {
    return {
      check: {
        name: 'Negative control: the same attempts escape when unsealed',
        status: 'fail',
        detail: created.stderr.trim().slice(0, 160),
      },
      ipv6Reachable: false,
      ipv6Detail: ipv6Detail || 'the control network could not be created',
    };
  }

  try {
    await engine.run(['run', '-d', '--name', container, '--network', network, image, 'tail', '-f', '/dev/null']);
    const attempts = readAttempts(await engine.shell(container, `python3 - <<'PY'\n${ESCAPE_ATTEMPTS}\nPY`));
    const entries = Object.entries(attempts);
    const escaped = entries.filter(([, attempt]) => attempt.escaped);
    const ipv4Escaped = escaped.filter(([name]) => !name.startsWith('tcp6'));
    const ipv6Escaped = escaped.filter(([name]) => name.startsWith('tcp6'));

    return {
      check: {
        name: 'Negative control: the same attempts escape when unsealed',
        status: ipv4Escaped.length > 0 ? 'pass' : 'fail',
        detail:
          entries.length === 0
            ? 'the escape attempts could not be run on the control network'
            : `${escaped.length}/${entries.length} escaped unsealed (IPv4 ${ipv4Escaped.length}, IPv6 ${ipv6Escaped.length}) — proves the attempts are real`,
      },
      ipv6Reachable: ipv6Escaped.length > 0,
      ipv6Detail: ipv6Escaped.length > 0 ? '' : ipv6 ? 'the control container could not reach IPv6 either' : ipv6Detail,
    };
  } finally {
    await engine.removeContainer(container);
    await engine.removeNetwork(network);
  }
}

function readAttempts(result: { stdout: string }): Attempts {
  try {
    return JSON.parse(result.stdout.trim().slice(result.stdout.indexOf('{'))) as Attempts;
  } catch {
    return {};
  }
}
