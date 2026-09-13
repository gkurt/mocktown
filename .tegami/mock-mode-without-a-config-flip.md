---
packages:
  mocktown: minor
---

### Added

- **`mocktown record --live <host>`** sends the named hosts to the real service for that
  session only, whatever the registry says. This is how you re-record a service that already
  has a mock, which is otherwise denied during a record run.

### Changed

- **`mocktown serve` serves every generated mock, whatever the registry pins.** A host set to
  `record` that has a mock in `.mocktown/mocks/` is now served from it, so running an app
  against its mocks no longer means editing `mocktown.json` first and putting it back
  afterwards. A host with no mock is unchanged: it still reaches the real service and is
  still named at startup. Use `passthrough` for a host a served run must genuinely reach —
  it is honoured in both modes.

### Fixed

- **`mocktown serve start` no longer fails with "The socket connection was closed
  unexpectedly"** when no daemon is already running. The daemon the CLI started was being
  killed by its own output having nowhere to go. It now logs to a file beside `daemon.json`,
  and a start that fails reports the tail of it instead of asking you to run it again to see
  why.
- **A long-running daemon no longer grows on every routing change.** Each re-applied routing
  table held on to the previous one's front-door channels, which also surfaced as a
  `MaxListenersExceededWarning` once a project had enough services.
