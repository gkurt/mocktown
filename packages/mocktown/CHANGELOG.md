## mocktown@0.2.0

### Added

- **A dark scheme in the GUI.** `theme` in the shell's header picks `system`, `light` or
  `dark`; `system` is the default and follows the OS. The choice is remembered and applies
  before the first paint. Panels follow the shell — the scheme is passed in their query
  string alongside the project.
- **Real dials for scenario knobs.** A knob whose schema declares a range is now a slider,
  a boolean is a switch, and one with a fixed set of values is a select — picked from the
  knob's own schema, so a mock gains a proper control by declaring one. Project settings
  are a form with each setting's description under its control, instead of a table with an
  input in one column.

### Changed

- **Clicking a row in Issues or Services opens a drawer** rather than unfolding the detail
  underneath the table, so the list stays where it was while you read.
- **Dashboard widgets have a fixed height and scroll inside themselves**, so one busy
  service no longer decides the height of the page.
- **Scrollable areas fade at the edge you can still scroll toward**, and their scrollbar
  stays out of the way until you reach for it.

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
