---
packages:
  - mocktown: patch
---

### Fixed

- **A recorded service could reach the real upstream while `serve --sealed` claimed to be
  mocking it.** The recorder pins every host it observes to `record`, and that pin survived
  into serve mode — so a service you had just written a mock for was forwarded to the real
  API, with `mocktown mocks verify` still passing because it replays against the provider
  and never crosses the front door. A running provider now outranks a pin nobody committed
  to `mocktown.json`, a discovered pin with no provider is denied under seal, and any host
  still reaching a real upstream is named in `mocktown serve start`'s warnings.
- **A generated mock whose `seed()` threw took `serve start` down** with
  `error: Internal server error` and nothing written anywhere. A throwing seed is now a load
  failure like a module that will not import: that one service is denied with the reason in
  `mocktown providers list`, and every other mock keeps serving.
- **Unexpected daemon errors reported nothing at all.** The API turned any unexpected throw
  into a bare `Internal server error` with no message and no log line. Messages now reach
  the caller and stacks reach the daemon's stderr; deliberate failures keep their own codes.
- **Every generated CLI flag had lost its help text.** Zod 4 keeps `.describe()` text in a
  registry rather than on the schema definition, so the flag generator was reading a field
  that is always empty. Flags document themselves again, and a flag whose value is a union
  now lists the forms it accepts — `--provider` says `generated:<name>` instead of failing
  with a bare validation error.
