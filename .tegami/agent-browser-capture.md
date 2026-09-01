---
packages:
  - mocktown: minor
---

### Added

- **A browser driven by an agent records without extra wiring.** `agent-browser` (and
  Playwright, and Puppeteer) already take the proxy from `HTTP_PROXY`/`NO_PROXY`, but Chrome's
  verifier reads none of the CA variables the launch wrapper sets, so every navigation died on
  `ERR_CERT_AUTHORITY_INVALID`. The recorded env and `.env.mocktown` now also carry
  `MOCKTOWN_CA_SPKI` — the project CA's public key — and `AGENT_BROWSER_ARGS` with the
  `--ignore-certificate-errors-spki-list` flag already assembled. `mocktown record --
  agent-browser open <url>` works as it stands.
- **`record-flow`**, a new prompt pack (`mocktown skills get --name record-flow`): how to
  drive a flow into the corpus, either with a driver's own browser under the recorded env or
  by attaching one to `mocktown browser launch --debug-port 0` over CDP.
- The sandbox image and devcontainer set `AGENT_BROWSER_EXECUTABLE_PATH` alongside the
  Playwright and Puppeteer ones, so an in-sandbox flow starts the image's trusted Chromium
  rather than trying to download a browser on a sealed network.

### Changed

- Chrome's captive-portal probe (`connectivitycheck.gstatic.com/generate_204` and the two
  hosts it shares with real content) is filtered as client-runtime noise. On a headless run
  that navigated nowhere else it was the entire corpus.
- The CA fingerprint covers every certificate in the PEM rather than the first, so a project
  behind stable names trusts both its issuers instead of erroring on one.

Trust stays narrow: the flag names one key for one process. `--ignore-https-errors` accepts
any certificate at all and would turn the one signal that says the front door is working into
silence.
