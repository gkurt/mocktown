# Fix the issue backlog

Every request the front door or a mock could not serve cleanly is an issue. An issue is
self-contained: it carries the scrubbed request, the nearest matching behavior and why it
did not match, a suggested resolution, and links to the files and corpus rows you need.
You should not need any other context.

An issue with fewer links than you expected may have had one stripped: a link is removed when
the recording it named was deleted from the corpus, because a link that resolves to nothing
is worse than none. The scrubbed request the issue carries inline is still the evidence.

Anything you write into a mock while working the queue is bound by
[house-rules.md](house-rules.md). Read it first.

## Working the queue

```bash
mocktown issues list --status outstanding     # the queue: open plus reopened
mocktown issues list --batch <id>             # one run's set, or --service / --type
mocktown issues get --id <issue>              # the full item
mocktown issues resolve --id <issue>          # replays the trigger; only a pass closes it
```

**Ask for `outstanding`, not `open`.** A resolve whose verification fails leaves the issue
`reopened`, and the four literal statuses filter by equality — so `--status open` answers a
narrower question than the one you have, and after a fixing pass it hides exactly the
issues that still need you. `outstanding` is open-or-reopened. `verifying` is the in-flight
state while a resolve runs.

Resolution replays against a **running** provider, so `mocktown serve start` has to be up
first — without it `issues resolve` aborts rather than reporting a pass it did not get.

Issues also exist as JSON under `.mocktown/issues/` if you prefer files to commands.

## Watching for new issues

Issues land while something is driving the app — your test run, a recorded flow, a seal run
— not in a batch at the end. The feed parks until one is filed, so there is nothing to poll:

```bash
mocktown feed --follow --kind issue --json
```

One JSON line per event, and `ref` is the issue id — `issues get --id <ref>` is the next
step. Run it in the background and fix issues as they arrive rather than waiting for the run
to finish.

- **The feed is a bounded window, not a log.** A watcher that falls behind is told so with
  `gap: true`, having missed events in between. `issues list --status outstanding` stays the
  queue of record; the feed only tells you when to look.
- **Resolutions arrive on the same kind.** Closing an issue publishes an `issue` event too,
  so a watcher sees its own fixes come back. Key off `ref`, not off an event arriving.

## What each type asks for

| Type | What to do |
|---|---|
| `unknown-service` | Decide what the host is: `emulator:<name>` if it is one of the fourteen emulated services (house rule 2 — check this first), `record` to capture it, `generated:<host>` to hand-write a mock, or `passthrough` to allow it out — explicitly, never silently. |
| `unmatched-request` | Serve the method and path template from the generated mock, using the linked corpus rows. The diagnosis carries `nearest`: the closest declared routes with their scores and why each one lost. **Read them before you write.** If one is genuinely the same endpoint with too narrow a template, widen it; if it is a different endpoint that merely looks similar, add a route of its own. The score measures string similarity, not sameness — `clustering/search` scores high against `clustering/graph` and is a different endpoint. |
| `handler-error` | A route matched and its handler threw. The diagnosis names the route under `matched` and carries the message. Fix the handler; do not add a route. |
| `state-violation` | A replay found stateful incoherence — something created was not readable back. Move the entity into `ctx.state`. |
| `redirect-gap` | An SDK is not pointed at its mock. Apply the EKB recipe: env var, constructor option, or code patch — [apply-redirects.md](apply-redirects.md) is the whole job. |
| `pinned-client` | Out of scope by design. Surface it; do not try to defeat the pinning. |
| `provider-drift` | The real API moved. Patch the provider, and leave the diff for a human to review. |
| `undeclared-service` | Traffic reached a host that is not in mocktown.json. Add it with a provider, so the decision is committed rather than rediscovered. |

## Rules

- **Resolution is verified, not asserted.** `issues resolve` replays the triggering
  requests against your patch; a failing replay reopens the issue with the diff attached.
- **Batch coherently.** Issues from one run share a `batchId`; fix the batch, then verify
  once.
- **Never auto-commit.** Changes to committed artifacts — generated mocks, `.env.mocktown`,
  patches to the user's own app — go through normal review. Mocktown does not commit.
