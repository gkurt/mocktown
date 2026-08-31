# Spike 02 — oRPC on Bun

Answers: *does oRPC's `OpenAPIHandler` plus static file serving run on `Bun.serve` with no
web framework, and can one contract really drive the HTTP API, the CLI, and MCP?*

**Read [FINDINGS.md](FINDINGS.md).** Short version: yes, 10/10, no patches — and we write
the contract walk ourselves (161 lines) rather than taking either candidate adapter.

## Running it

```bash
bun run spike.ts        # the 10-test matrix
bunx tsc --noEmit       # type safety, including the deliberate-error check
```

To poke at it by hand:

```bash
bun run serve.ts
```

then, in another shell:

```bash
MOCKTOWN_API=http://127.0.0.1:4499/api/v1 MOCKTOWN_TOKEN=spike-session-token bun run cli.ts services list --project acme-api
```

## Layout

| File | What it is |
|---|---|
| `contract.ts` | The two procedures, defined once. Everything else is derived from this. |
| `server.ts` | `OpenAPIHandler` + static files + bearer token, all on one `Bun.serve`. |
| `walk.ts` | The contract traversal. The only place that touches oRPC internals. |
| `cli.ts` | The CLI, generated from the walk. No command written by hand. |
| `mcp.ts` | The MCP server, generated from the same walk. |
| `spike.ts` | The matrix. Runs all ten checks and prints PASS/FAIL. |
| `type-safety-check.ts` | Deliberate type errors that `tsc` must report. Compile-time only. |
