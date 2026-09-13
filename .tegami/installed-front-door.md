---
packages:
  mocktown: patch
---

### Fixed

- **The front door starts when mocktown is installed as a dependency.** Node refuses to
  strip types from TypeScript under `node_modules`, so running the CLI from a project's own
  `node_modules` failed at `serve start` with
  `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` and no proxy at all. The sidecar the front
  door spawns now ships compiled. This never affected a clone of the repo, which is why it
  went unnoticed.
