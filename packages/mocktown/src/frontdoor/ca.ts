/**
 * The per-project root CA — 03-capture.md and 10-security.md.
 *
 * Generated at project creation, private key `0600` in the project data dir, never
 * committed, never shared between projects. The host system trust store is not touched;
 * `mocktown record` injects per-runtime CA env vars instead.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateCACertificate } from "mockttp";
import { projectPaths } from "../config/paths.ts";

export interface ProjectCa {
  cert: string;
  key: string;
  certPath: string;
}

export async function ensureProjectCa(project: string): Promise<ProjectCa> {
  const paths = projectPaths(project);
  if (existsSync(paths.caCert) && existsSync(paths.caKey)) {
    return { cert: readFileSync(paths.caCert, "utf8"), key: readFileSync(paths.caKey, "utf8"), certPath: paths.caCert };
  }
  mkdirSync(paths.ca, { recursive: true, mode: 0o700 });
  const ca = await generateCACertificate({
    subject: { commonName: `Mocktown ${project} CA`, organizationName: "Mocktown" },
  });
  writeFileSync(paths.caCert, ca.cert, { mode: 0o644 });
  writeFileSync(paths.caKey, ca.key, { mode: 0o600 });
  return { cert: ca.cert, key: ca.key, certPath: paths.caCert };
}
