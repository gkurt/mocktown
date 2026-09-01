/**
 * The devcontainer half of 04-sandbox.md's image-composition question.
 *
 * > Leaning: ship both a base image and a devcontainer *feature*. The phase-0 spike built
 * > the two-image form; the devcontainer feature is untested.
 *
 * Both now exist, and they share one mechanism. The base image
 * ([images.ts](images.ts)) is for people who want Mocktown to own the image; the feature
 * is for people who already have a devcontainer and want the boundary added to it. The
 * feature contributes the *trust store* half; the sealed network and its resolver are
 * contributed by `runArgs` plus an `initializeCommand` that brings the relay up before the
 * container is created. Neither half is sufficient alone — a container with our CA but no
 * sealed network is an ordinary container.
 *
 * The feature is generated into the workspace rather than fetched from a registry: it
 * carries the *project's* CA, which is per-project by design (10-security.md), so there is
 * nothing generic to publish. The certificate travels as a base64 option — a certificate
 * is public, the private key never leaves the host.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CA_PATH_IN_IMAGE, CHROMIUM_PATH, nssTrustScript, SYSTEM_BUNDLE } from '#src/sandbox/images.ts';

export interface DevcontainerInputs {
  project: string;
  caCert: string;
  browser: boolean;
  /** Names of the sealed network and the relay's address, from a running sandbox. */
  network: string;
  relayIp: string;
}

export interface DevcontainerArtifacts {
  files: string[];
  /** The fragment to merge into an existing `devcontainer.json`. */
  fragment: Record<string, unknown>;
}

const FEATURE_DIR = 'mocktown-feature';

function featureJson(browser: boolean) {
  return {
    id: 'mocktown',
    version: '1.0.0',
    name: 'Mocktown sealed sandbox',
    description: "Trusts the project's Mocktown CA inside the container, so unmodified code reaches mocked services with TLS verified.",
    options: {
      cacert: { type: 'string', default: '', description: "Base64 of the project's CA certificate (public; the key stays on the host)." },
      installbrowser: {
        type: 'boolean',
        default: browser,
        description: 'Install headless Chromium, so browser tests run inside the boundary too.',
      },
    },
  };
}

/**
 * Deliberately dependency-free shell: a feature runs during image build, on whatever base
 * the user brought, where nothing may be installed yet.
 */
function installScript(): string {
  return `#!/usr/bin/env sh
set -eu

CERT="\${CACERT:-\${cacert:-}}"
BROWSER="\${INSTALLBROWSER:-\${installbrowser:-false}}"

if [ -z "$CERT" ]; then
  echo "mocktown: no CA certificate was passed to the feature; the container would not trust the front door." >&2
  exit 1
fi

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y --no-install-recommends "$@"
    rm -rf /var/lib/apt/lists/*
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache "$@"
  elif command -v microdnf >/dev/null 2>&1; then
    microdnf install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y "$@"
  else
    echo "mocktown: no supported package manager in this image" >&2
    exit 1
  fi
}

install_packages ca-certificates curl

mkdir -p "$(dirname ${CA_PATH_IN_IMAGE})"
echo "$CERT" | base64 -d > ${CA_PATH_IN_IMAGE}
update-ca-certificates 2>/dev/null || update-ca-trust extract

if [ "$BROWSER" = "true" ]; then
  # Chromium keeps its own NSS trust store and ignores the system one, so the same
  # certificate goes in there too — for root and for the user the devcontainer runs as,
  # since the browser reads whichever $HOME is in effect.
  if command -v apk >/dev/null 2>&1; then install_packages chromium nss-tools; else install_packages chromium libnss3-tools; fi
  for home in /root "\${_REMOTE_USER_HOME:-}"; do
    [ -n "$home" ] || continue
    ${nssTrustScript('"$home"')}
    [ "$home" = /root ] || chown -R "\${_REMOTE_USER:-root}" "$home/.pki"
  done
fi

echo "mocktown: CA installed at ${CA_PATH_IN_IMAGE}"
`;
}

export function renderDevcontainer(inputs: DevcontainerInputs): { files: Record<string, string>; fragment: Record<string, unknown> } {
  const encoded = Buffer.from(inputs.caCert, 'utf8').toString('base64');

  return {
    files: {
      [`${FEATURE_DIR}/devcontainer-feature.json`]: `${JSON.stringify(featureJson(inputs.browser), null, 2)}\n`,
      [`${FEATURE_DIR}/install.sh`]: installScript(),
    },
    fragment: {
      features: {
        [`./${FEATURE_DIR}`]: { cacert: encoded, installbrowser: inputs.browser },
      },
      // The network has to exist before the container is created, and only the daemon can
      // create it — so the devcontainer asks Mocktown for it rather than the other way round.
      initializeCommand: `mocktown sandbox up --project ${inputs.project}`,
      runArgs: ['--network', inputs.network, '--dns', inputs.relayIp],
      containerEnv: {
        NODE_EXTRA_CA_CERTS: CA_PATH_IN_IMAGE,
        REQUESTS_CA_BUNDLE: SYSTEM_BUNDLE,
        SSL_CERT_FILE: SYSTEM_BUNDLE,
        CURL_CA_BUNDLE: SYSTEM_BUNDLE,
        DENO_CERT: CA_PATH_IN_IMAGE,
        MOCKTOWN_SANDBOX: '1',
        ...(inputs.browser
          ? {
              CHROME_PATH: CHROMIUM_PATH,
              PUPPETEER_EXECUTABLE_PATH: CHROMIUM_PATH,
              PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: CHROMIUM_PATH,
              AGENT_BROWSER_EXECUTABLE_PATH: CHROMIUM_PATH,
            }
          : {}),
      },
    },
  };
}

export function writeDevcontainer(workspace: string, inputs: DevcontainerInputs): DevcontainerArtifacts {
  const { files, fragment } = renderDevcontainer(inputs);
  const root = join(workspace, '.devcontainer');
  const written: string[] = [];

  for (const [relative, contents] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents, { mode: relative.endsWith('.sh') ? 0o755 : 0o644 });
    written.push(path);
  }

  // The fragment is written beside the feature rather than merged into an existing
  // devcontainer.json: merging someone's editor configuration by machine is how a tool
  // loses their trust.
  const fragmentPath = join(root, 'mocktown.devcontainer.json');
  writeFileSync(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
  written.push(fragmentPath);

  return { files: written, fragment };
}
