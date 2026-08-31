# Spike 05 — the scrubber

Answers: *can the scrubbing 10-security.md requires actually be built — structured
placeholders, consistent within a session, re-injectable on replay — without destroying the
corpus that mocks are generated from?*

**Read [FINDINGS.md](FINDINGS.md).** Short version: yes, 14/14 against a real captured
corpus, with four design corrections along the way and two findings about capture.

## Running it

```bash
node capture.mjs     # records 9 real SDK exchanges through the front door into corpus.raw.json
bun run spike.ts     # the 14-check matrix
```

`capture.mjs` runs under Node because the front door is a Node sidecar (spike 01), and
re-execs itself with `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY` and `NODE_USE_ENV_PROXY` set —
`mocktown record -- <cmd>` in miniature.

## Layout

| File | What it is |
|---|---|
| `scrubber.ts` | The scrubber: structural pass, value pass, placeholder registry, `reinject()`, `audit()`. |
| `capture.mjs` | Records the corpus: real SDKs → real TLS → MITM → emulate. |
| `spike.ts` | The matrix, including a leak detector that scans the scrubbed output for every known secret. |
| `seeds.yaml` | Seed data for the emulate upstreams. |

`corpus.raw.json` and `secrets.json` are generated and gitignored — they hold unscrubbed
exchanges, which is precisely what the product must never write.
