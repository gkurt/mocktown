## mocktown@0.1.0

### Added

First release. Mocktown records an app's outbound traffic, serves it back as stateful
mocks, and keeps those mocks alive as the real services change.

- **Record.** `mocktown record -- <cmd>` runs your app through a capture proxy and writes
  every exchange to a corpus. Secrets are scrubbed *before* anything reaches disk, so the
  corpus you can browse is the corpus that exists. Browsers, HAR imports and WebSockets are
  covered too, and the recorder filters the browser's own vendor traffic out of the corpus.
- **Mock.** `mocktown mocks scaffold` turns the corpus into a brief and a module stub for a
  coding agent to fill in — mocks are stateful modules, not verbatim replay. `mocktown
  skills install` gives the agent the prompt pack for the job.
- **Never reach production by accident.** In serve mode anything without a mock hits a deny
  wall and becomes a self-contained issue in the queue, rather than quietly reaching the
  real API.
- **Seal.** `mocktown sandbox up` builds a network whose only route out is the front door;
  `mocktown seal verify` runs your flows inside it and stamps the result, exiting non-zero
  when the verdict is anything but sealed — so it works as a CI step.
- **Drift watch.** Opt in and Mocktown re-records your flows against the real services and
  files issues for what diverged.
- **Four surfaces, one daemon.** A CLI, a local HTTP API, an MCP server and a GUI — the
  shell ships with the package, so `mocktown ui` works on a fresh install.

Mocktown runs on Bun, and needs a real `node` on the PATH for the capture proxy.
