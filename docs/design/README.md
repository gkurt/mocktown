# Mocktown — Design Documents

Mocktown records the outbound traffic of an application, turns it into stateful mock
services, and provides a sealed sandbox where coding agents can run freely without any
risk of touching staging or production.

These documents are deliberately split by subsystem. **Read only the file relevant to
your task** — each file is self-contained and cross-links where context is needed.

| File | Read when working on… |
|---|---|
| [01-product.md](01-product.md) | Positioning, competitive landscape, what we deliberately don't build |
| [02-architecture.md](02-architecture.md) | Daemon, API, process model, tech stack decisions |
| [03-capture.md](03-capture.md) | Traffic recording, the proxy engine, TLS/CA handling |
| [04-sandbox.md](04-sandbox.md) | Container mode, egress guarantees, DNS, in-sandbox browsers |
| [05-redirection.md](05-redirection.md) | Env-var mode, endpoint knowledge base, the seal/certification loop |
| [06-emulation.md](06-emulation.md) | Service providers, emulate integration, generated long-tail mocks |
| [07-issues-agent-loop.md](07-issues-agent-loop.md) | Issue taxonomy, drift handling, agent-facing surfaces (MCP/skills) |
| [08-projects-config.md](08-projects-config.md) | Project model, config layering, storage layout |
| [09-gui-plugins.md](09-gui-plugins.md) | GUI shell, state viewers, the panels plugin model |
| [10-security.md](10-security.md) | Secrets scrubbing, threat model, signing/distribution |
| [11-roadmap.md](11-roadmap.md) | Phasing and what ships in which milestone |
| [12-scenario-controls.md](12-scenario-controls.md) | Knobs, auth profiles, seed/reset/session state lifecycle |

## Conventions

- Each file opens with a **Status** line (`Draft` / `Agreed` / `Implemented`) and a
  one-paragraph summary. A status may carry a qualifier naming what is *not* yet built —
  a partially-built document must say so rather than round up to `Implemented`.
- Decisions are recorded inline as `**Decision:**` blocks with the alternatives that
  were considered and rejected. Change a decision by editing the block, not by
  appending contradictions.
- Terminology is defined once, in [01-product.md](01-product.md#glossary), and used
  consistently everywhere else.
