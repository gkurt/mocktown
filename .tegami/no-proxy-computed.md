---
packages:
  - mocktown: minor
---

### Added

- **`noProxy` in `mocktown.json`** — the hosts the app reaches itself, never through the
  front door. Every entry is a hole, and a host listed there can never be recorded, so the
  list is the project's own statement rather than a default.

### Changed

- **`NO_PROXY` is computed from the project instead of being a fixed list.** `127.0.0.1`
  and `::1` are unconditional — a recorded service is always a hostname, so a loopback
  literal can never shadow one — and the blanket `localhost` entry is dropped as soon as a
  registered service sits under that suffix. A `.localhost` upstream is recordable now.
- **`mocktown record start` and `serve start` report what the bypass list costs.** Dropping
  the blanket entry sends a service the app reaches as `localhost:<port>` by name into the
  front door, and an entry that still shadows a registered service means that service
  cannot be captured however the run is configured. Both are stated, not assumed harmless.

### Fixed

- **A `.localhost` upstream recorded nothing, silently.** The blanket `localhost` entry
  took every `*.localhost` name with it, so a service could look perfectly wired up and
  never reach the front door. Where the collision is genuinely unresolvable — under
  portless the TLD *has* to bypass — it is named rather than hidden.
- **A denied request for a loopback name was filed as a missing third-party dependency.**
  It is reported as the app's own service now, with `noProxy` as the fix, so the issue does
  not send an agent off to write a mock for the app's own API. It is still a denial: nothing
  reaches an upstream that the seal did not allow.
