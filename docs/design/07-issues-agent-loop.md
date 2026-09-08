# 07 — Issues & the Agent Loop

**Status:** Implemented — phase 2

The issue engine is what keeps the mock environment *alive*. Every request the front
door can't serve cleanly becomes a typed, self-contained work item that a coding agent
can resolve without access to this design history.

## Issue taxonomy

| Type | Trigger | Typical resolution |
|---|---|---|
| `unknown-service` | Request to a hostname with no registry entry (sealed mode wall-hit) | Register service → record or generate a provider; or allowlist passthrough |
| `unmatched-request` | Known service, but no route matches (new path, verb, or an unmocked socket channel) | Agent extends the generated mock, having read the ranked `nearest` candidates to decide between widening one and adding a route |
| `handler-error` | A route matched exactly and its handler threw | Agent fixes the handler named under `matched` |
| `state-violation` | Replay/test found stateful incoherence (created entity not readable) | Agent adds state backing to the mock |
| `redirect-gap` | Seal run: SDK not pointed at mocks | Env var added / constructor option / code patch ([05-redirection.md](05-redirection.md)) |
| `pinned-client` | TLS interception failed post-MITM | Documented out of scope; surfaced, not auto-resolved |
| `provider-drift` | Recorded real API (re-record run) diverges from current provider behavior | Agent patches provider; humans review the diff |

Each issue carries: the full scrubbed request, the nearest-matching existing behaviors
and *why* each one didn't match (WireMock-style near-miss diagnosis), the suggested
resolution type, and links to the relevant corpus rows. **An issue must be resolvable
by an agent that has read nothing but the issue and the files it links.**

**Diagnosis ranks, it does not rule.** There was a `near-miss` type for a while, assigned
when the closest route's similarity score cleared a threshold, and its resolution was
"widen the existing route rather than adding a second one". A score over path strings
cannot tell one endpoint from two: on the corpus that retired it, seven issues for routes
like `clustering/search` were all told to widen `clustering/graph`, a different endpoint
with a different response. The candidates are now reported ranked, with their scores and
the reasons each lost, and the agent decides. A threshold that is wrong is worse than no
threshold, because it reads as a finding rather than a guess.

## Agent surfaces

1. **MCP server** (same daemon API, [02-architecture.md](02-architecture.md)):
   `list_issues`, `get_issue`, `resolve_issue`, `query_recordings`,
   `get_endpoint_recipe`, `run_seal`, `restart_provider`. This is the primary surface.
2. **Skills / prompt packs**: versioned prompt+house-rules bundles shipped with
   Mocktown for the recurring jobs — *record a flow*, *generate mock from corpus*, *fix
   issue backlog*, *apply redirect recipes*, *write a panel*. House rules live here (never invent auth-shaped
   fields; prefer widening matchers over duplicating routes; every new mock adds its
   EKB entry; state fidelity over verbatim replay; seed data per auth profile with
   `default` + `empty-org` minimum; prefer profile variation over knob flips for
   data-shape scenarios; all randomness via the seeded PRNG —
   [12-scenario-controls.md](12-scenario-controls.md)).
3. **Files**: issues also materialize as JSON under `.mocktown/issues/` in the
   workspace so file-oriented agents (`claude -p`, CI bots) work without MCP.

## Loop mechanics

- Resolution is **incremental and verified**: after an agent patches a mock, the
  daemon replays the triggering request(s) against it; only a passing replay closes
  the issue. Failed verification reopens with the diff attached.
- **Batching**: issues from one run are grouped into a batch so an agent fixes a
  coherent set, then one verification pass runs the whole batch.
- **Watching is the feed, not a second command.** An agent fixing issues as they land
  follows `mocktown feed --follow --kind issue`, whose long poll returns the moment one is
  filed ([09-gui-plugins.md](09-gui-plugins.md)). There is no `issues watch`: following is a
  loop, the feed already is one, and a per-subsystem watch command would reimplement it on
  the CLI alone. The feed is a bounded window, so it wakes an agent — `issues list` stays
  the queue of record.
- **Human review boundary**: agent-proposed changes to *committed* artifacts
  (generated mocks, `.env.mocktown`, code patches in the user's app) go through
  normal VCS review. Mocktown never auto-commits. Runtime-only changes (widened
  matcher in a draft state) may apply immediately but are flagged until committed.
- **Drift watch**: scheduled re-record runs against real APIs diff
  reality vs providers and file `provider-drift` issues — the "mock rotted" problem
  every record/replay tool ignores.

  *Implemented 2026-09-01 in phase 4.* **A drift run is a re-record, not a replay.** The
  tempting implementation is to fire the stored requests at the real service, but the corpus
  holds no credentials — the scrubber removed them before disk
  ([10-security.md](10-security.md)) — so every request would come back 401 and the run would
  report the whole integration as drifted. The only thing that can authenticate against a
  real API is the app, so a run does what the wording above says: run the project's own flows
  with the front door recording, against the real services, in the app's own environment,
  then replay that fresh evidence against the providers and diff. Findings are
  `mock-behind` (reality returns something the mock does not) or `mock-ahead` (the mock still
  returns a field reality dropped).

  Consequences, all of them about not surprising anyone:

  - **Off by default**, and never enabled by a config default: a run spends real money and
    real quota. The daemon's scheduler can also be disabled wholesale, and it is off in tests.
  - **It deliberately overrides the registry** for the services it judges, forcing them to
    `record` for the run. Without that the front door would deny a mocked service —
    correctly — and a drift check could never see reality. The override is scoped to the run
    and named in the run's report.
  - **The scheduler defers to a human.** A tick that finds the project mid-record or
    mid-serve skips rather than yanking the mode out from under whoever is working; a drift
    check is a daily question, not an urgent one.
  - **`ok: false` covers "could not judge", not just "drifted".** A run with no flows
    configured, or no service backed by a provider, reports why and is persisted as a run —
    "found nothing wrong" and "could not look" must not look the same from the outside.

## Anti-goals

- No autonomous background agent inside Mocktown itself. Mocktown produces perfect
  agent food; the user brings their own agent (Claude Code, etc.). This keeps us
  model-agnostic and out of the credentials business.
