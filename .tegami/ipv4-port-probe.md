---
packages:
  mocktown: patch
---

### Fixed

- The daemon starts on hosts without IPv6 (containers, some CI), where every port used to be reported as taken.
