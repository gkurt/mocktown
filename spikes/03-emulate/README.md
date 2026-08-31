# Spike 03 — emulate as managed child processes

Answers: *can `vercel-labs/emulate` be driven as a managed child process — start, stop,
seed — with real vendor SDKs pointed at it and OAuth working end to end?*

**Read [FINDINGS.md](FINDINGS.md).** Short version: yes, 7/8. The one failure is real —
emulate binds every network interface, exposing mock services (and OAuth token issuance)
to the LAN.

## Running it

```bash
bun run spike.ts                  # the 8-test matrix
bun run programmatic-check.ts     # the in-process alternative, recorded but not adopted
```

## Layout

| File | What it is |
|---|---|
| `provider.ts` | The wrapper. Everything emulate-shaped lives here: CLI invocation, port-run allocation, stdout parsing, lifecycle. Callers see `start()` / `stop()` / `baseUrlFor()`. |
| `spike.ts` | The matrix: seeding, real Stripe SDK, real Octokit, OAuth end to end, binding, lifecycle, restart reproducibility. |
| `seeds.yaml` | Committed seed data, in the shape a project would ship. |
| `programmatic-check.ts` | Verifies emulate's `createEmulator` API works under Bun and that `reset()` restores seeded state. |
