---
packages:
  mocktown: minor
---

### Changed

- `issues resolve` no longer refuses to close an issue whose route has no recording. It sends the issue's own request (reads only) to the mock, reopens the issue if the route is still unserved, and otherwise closes it as unverified with a note saying so.
- `mocks verify` says "nothing was verified" when the local corpus has no recordings, instead of `0/0 replayed exchanges matched`.
