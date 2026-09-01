---
packages:
  - mocktown: minor
---

### Added

- `mocktown browser launch --debug-port <port>` publishes a Chrome DevTools Protocol
  endpoint so Playwright or Puppeteer can drive the recorded window instead of launching an
  unrecorded one of its own. Pass `0` for an ephemeral port; the resolved
  `webSocketDebuggerUrl` comes back on the response. Off by default — the endpoint drives the
  browser with no further authentication.

### Documentation

- The launched browser (capture ladder rung 2) is documented in the README, including what a
  cooperatively-proxied window does *not* capture: loopback, cached and service-worker
  responses, non-HTTP protocols, managed proxy policy, and pinned endpoints.
