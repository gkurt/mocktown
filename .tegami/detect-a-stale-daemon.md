---
packages:
  - mocktown: patch
---

### Fixed

- **A daemon older than the client says so instead of failing as a `TypeError`.** The daemon
  outlives the shell by design, so the one answering may predate the contract the CLI was
  built from — and reading a field it never learned to send surfaced as
  `undefined is not an object` from whichever renderer touched it first, naming nothing.
  `daemon.json` now carries a signature of the contract's shape, every client checks it
  before its first call, and `mocktown daemon status` reports the mismatch with the fix.
  A reworded summary does not invalidate a running daemon; an added or removed field does.
