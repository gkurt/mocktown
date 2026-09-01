---
packages:
  - mocktown: minor
---

### Added

- **The corpus no longer records the browser's own traffic.** A recorded browser talks to its
  vendor constantly — component updates, Safe Browsing, sign-in probes, new-tab-page
  furniture, telemetry — and on one measured session that was 17 of the 22 discovered
  services. `browser launch` now passes the flags that switch most of it off at the source and
  starts on `about:blank`; whatever still arrives is dropped from the corpus, from service
  discovery and from the issue queue.
- **`capture` in `mocktown.json`** — `ignore` adds patterns as `host` or `host/path-prefix`,
  `keep` takes a default back for a host or path you really do depend on, and
  `ignoreNoise: false` turns the built-in list off.

Filtering decides what is written down, never what is allowed out: an ignored request in
serve mode still hits the deny wall. Most built-in patterns are path-scoped because the
hostnames are shared — `accounts.google.com/ListAccounts` is noise, a real OAuth flow on the
same host is not. `record stop` reports what was dropped and why, and a session that dropped
more than it kept says so.
