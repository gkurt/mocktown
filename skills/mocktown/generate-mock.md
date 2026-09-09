# Generate a mock from the corpus

You are writing a **generated mock**: a plain Bun/TypeScript module that serves one
service well enough that the application under test cannot tell the difference.

## Inputs

```bash
mocktown corpus export --service <service>      # routes, examples, stateful couplings
mocktown recordings routes --service <service>  # the full route surface, one line each
mocktown mocks scaffold --service <service>     # writes .mocktown/mocks/<service>/{index.ts,BRIEF.md}
mocktown mocks schema --service <service>       # drafts schema.ts — the oracle verify judges you against
```

Read `.mocktown/mocks/<service>/BRIEF.md` first. It is the corpus organised by route, with the
create/read couplings already identified.

But read [house-rules.md](house-rules.md) before any of that — all of it, and rule 2 first:
if this service is one of the fourteen mocktown already emulates, the whole job is one
`mocktown services set --provider emulator:<name>` and none of the below applies.

## Shape of the module

```ts
import { defineMock } from "mocktown/mock";
import * as z from 'zod/v4';

export default defineMock({
  service: "<hostname>",
  // `latencyMs` and `errorRate` are built in — declare only dials specific to this service.
  knobs: { <name>: { schema: z.boolean(), default: false, description: "…" } },
  seed: ({ state, profile }) => { /* per-profile fixtures; empty-org gets nothing */ },
  routes: [
    { method: "GET", path: "/v1/things/{thingId}", describe: "…", handler: (req, ctx) => ({ status: 200, body: … }) },
  ],
  // Only when the corpus shows WebSocket channels for this service.
  sockets: [
    {
      path: "/v1/streams/{streamId}",
      describe: "…",
      onOpen: (req, ctx) => ctx.send(JSON.stringify({ type: "hello" })),
      onMessage: (message, req, ctx) => { /* answer what the client sends */ },
    },
  ],
  ekb: [{ rung: 1, envVar: "THINGS_API_URL", note: "…" }],
});
```

`req` gives you `params`, `query`, `headers`, a parsed `body` and `auth`.
`ctx` gives you `profile`, `prng`, `knobs`, `state`, `fakeSecret()` and `signIn()`.
A socket handler's `ctx` adds `send()`, `close()` and `connection`.

## The state store

Every entry is addressed by **collection *and* key** — `set` takes three arguments, not
two. A two-argument `set` is the most common way a mock throws on its very first request.

```ts
state.set(collection, key, value)          // e.g. state.set("invoices", inv.id, inv)
state.get<T>(collection, key)              // T | undefined
state.list<T>(collection)                  // [{ key, value }]
state.delete(collection, key)              // boolean
state.count(collection)                    // number
state.nextId(collection, prefix?)          // monotonic, stable, addressable
```

A throwing `seed()` is not fatal to the daemon, but it does leave your service **denied**
with the reason in `mocktown providers list` — check there first if a mock you just wrote
is not answering.

## Exercising what you declared

A mock is served by the front door, so nothing below answers until providers are up:

```bash
mocktown serve start                        # `--sealed` also brings up the sandbox boundary
mocktown providers list                     # your service, its base URL, and any deny reason
```

Then drive the parts the corpus could not show you. Rules 10 and 11 make you declare
profiles and knobs; a profile you never send a request as, and a knob you never turn, are
the two places a generated mock is most often wrong:

```bash
mocktown profiles session --name empty-org  # a ready-made token, no login UI
mocktown knobs set --service <service> --values '{"latencyMs":250}'
mocktown state list                         # counts per service, per profile
mocktown state get --service <service> --collection invoices
mocktown state reset --service <service>    # drops mutable state and re-applies `seed`
```

`state reset` is what rule 8 means by "does not survive a reset": anything you kept in a
module-level variable instead of `ctx.state` is still there afterwards, which is how a mock
passes a fresh run and fails the second one.

## Done means

```bash
mocktown mocks verify --service <service>   # replays the corpus; must pass
mocktown issues list --service <service> --status outstanding   # must be empty
```

Verification compares **status class and response shape**, not values — returning a
different id than the recording is correct, omitting the `id` field is not. The shape it
compares against is `schema.ts` when one is checked in (rule 4), so a failure that says
your correct response is the wrong type is a line to fix in that file, not in the handler.
