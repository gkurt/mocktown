#!/usr/bin/env python3
"""
Spike 01 — the minimum edits that make Mockttp usable under Bun.

Both are upstream-fixable and neither changes behaviour under Node. Both have been
drafted as PRs in upstream/ (unfiled); the two defects that are NOT fixable from
userland are drafted there as Bun bug reports instead — see FINDINGS.md.

Note the SECLEVEL guard below sniffs `process.versions.bun`, while the upstream PR
feature-detects instead (Bun reports process.versions.openssl === '1.1.0', so version
checks get the wrong answer). Identical behaviour here; the PR's version is the one
that generalises. This patches compiled dist/, hence the simpler form.

Idempotent: re-running is a no-op. Run after every `bun install`.
"""
import subprocess, sys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]

def find(rel):
    hits = sorted(ROOT.glob(f"node_modules/.bun/node_modules/{rel}"))
    if not hits:
        sys.exit(f"could not find {rel} — run `bun install` first")
    return hits[0]

def patch(path, old, new, label):
    s = path.read_text()
    if new in s:
        print(f"  already applied: {label}")
        return
    if old not in s:
        sys.exit(f"  ANCHOR MISSING for {label} in {path} — dependency version changed, re-verify the spike")
    path.write_text(s.replace(old, new, 1))
    print(f"  applied: {label}")

# ── 1. httpolyglot: net.Server constructor listener is invisible to emit('connection')
# Bun does not register the callback passed to net.Server's constructor as a real
# 'connection' event listener. Every MITM proxy re-injects the tunnelled socket after
# CONNECT via server.emit('connection', socket); under Bun that silently does nothing,
# so TLS handshakes hang forever with no error.
patch(
    find("@httptoolkit/httpolyglot/dist/index.js"),
    "        super((socket) => this.connectionListener(socket));",
    "        // BUN COMPAT: Bun doesn't register net.Server's constructor listener as a real\n"
    "        // 'connection' listener, so server.emit('connection', socket) — how a MITM proxy\n"
    "        // re-injects a tunnelled socket after CONNECT — silently does nothing.\n"
    "        super();\n"
    "        this.on('connection', (socket) => this.connectionListener(socket));",
    "httpolyglot: register connection listener explicitly",
)

# ── 2. mockttp: '@SECLEVEL=0' is an OpenSSL-only cipher-string directive
# Appended whenever certificate checks are relaxed (ignoreHostHttpsErrors), which is
# exactly the case when recording against staging hosts with self-signed certs.
# BoringSSL (Bun) rejects it outright: SSL routines:OPENSSL_internal:INVALID_COMMAND.
# Dropping it costs only tolerance for legacy/weak upstream ciphers.
patch(
    find("mockttp/dist/rules/passthrough-handling.js"),
    "            ...(!strictHttpsChecks\n                ? ['@SECLEVEL=0']\n                : [])",
    "            // BUN COMPAT: BoringSSL has no @SECLEVEL directive and rejects the whole\n"
    "            // cipher string. Costs only legacy-cipher tolerance on relaxed connections.\n"
    "            ...(!strictHttpsChecks && !process.versions.bun\n                ? ['@SECLEVEL=0']\n                : [])",
    "mockttp: drop @SECLEVEL=0 under Bun",
)
print("done")
