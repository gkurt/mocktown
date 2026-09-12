# House rules

1. **Never invent auth-shaped fields.** Credentials appear in the corpus as
   `{{secret:<kind>#<n>}}` placeholders. Accept a credential of that shape; if a
   response must contain one, use `ctx.fakeSecret(kind)`. Never hard-code a real-looking
   key of your own, and never require a specific credential value.
2. **Check for a shipped emulator before you write a line.** Mocktown wraps `emulate`, so
   fourteen well-known services already have a stateful implementation you would otherwise
   be reimplementing by hand: `github`, `google`, `slack`, `okta`, `clerk`, `apple`,
   `microsoft`, `stripe`, `aws`, `vercel`, `linear`, `twilio`, `resend`,
   `mongoatlas`. Point a host at one with `mocktown services set --id <host> --provider
   emulator:<name>`. The host is whatever the registry key says — nothing is bound to a
   canonical hostname — so `accounts.google.com`, `api.github.com` and a self-hosted Okta
   on a company domain are all just keys. Two things decide whether it fits:
   - **The OAuth ones present a consent *picker* over seeded users, not a login form.** You
     proceed by POSTing `login=<user>` to the authorize callback. An unattended run that
     waits for a password prompt hangs on an HTML page.
   - **An emulator emulates the vendor, so it only fits where the app talks to the vendor.**
     If sign-in goes through a broker — Auth0, WorkOS, or the app's own `/auth/login` —
     that broker is what the browser calls, and the corpus will show the vendor appearing
     only as the broker's upstream, or not at all. Mock what the app actually calls;
     an emulator one layer further out never receives a request.
3. **The corpus is a sample of the contract, not a script to replay.** The recordings show
   what the service *did*, not the whole of what it must do. Implement the contract they
   imply: a route observed with one id works for any id, a list observed with three
   entries works for none or thirty, and a status observed once is a branch, not a fixture.
4. **Correct the schema rather than contorting the mock — in `schema.overrides.ts`, never
   in `schema.ts`.** `mocktown mocks schema --service <s>` drafts response schemas from
   *every* recording of a route into `schema.ts`, and verification checks your mock against
   those schemas rather than against the recordings. The corpus is evidence, not a permanent
   oracle: when a recording is a poor witness — a scrubbed number that reads as a string, an
   object keyed by data, a field that happened to be null throughout — overrule it and say
   why on the line.

   `schema.ts` is rewritten on every run; `schema.overrides.ts` is written once and applied
   on top. An edit made in the draft is gone at the next capture.

   ```ts
   // schema.overrides.ts
   import { retype, z, type SchemaOverrides } from 'mocktown/mock';
   import type Schemas from './schema.ts';

   export default {
     'GET /v1/things/{thingId}': {
       200: (current) => current.extend({ count: z.number() }), // scrubbed; the draft says string
       500: z.object({ Error: z.string() }),                    // a status the corpus never caught
     },
     // `.extend` reaches the top level only; `retype` reaches any depth, and takes the paths
     // `--check` and verify failures print at you.
     'GET /v1/things': {
       200: (current) => retype(current, { 'data[].tokenUsage.inputTokens': z.number() }),
     },
   } satisfies SchemaOverrides<typeof Schemas>;
   ```

   Patch with a function: it says the one thing you know and keeps following the corpus for
   every field it does not mention, so a field the API adds later arrives on its own. Replace
   outright only when the draft is wrong end to end. `retype` preserves the draft's
   optionality — that is a fact about the capture, not the type you are correcting — and a
   route key that no longer exists fails to load rather than silently ceasing to apply.
   `--check` marks the differences your overrides caused, which is what makes a correction
   free to keep.

5. **Prefer widening a matcher over duplicating a route.** Two routes that differ only by
   an optional query parameter or a header are one route — and two that differ only by an
   identifier are one parameterised route: `/things/abc` and `/things/def` are
   `/things/{thingId}`. Collapse them; you do not need to ask. Path templating in the
   corpus is a best effort, and it misses composite keys, prefixed ids
   (`channels/dm-01H…`) and anything URL-encoded, so expect to finish the job by hand.
6. **Never hard-code an identifier from the corpus.** A recorded id is one real org's
   data. It also appears in two forms that do not agree — raw in a request path, and a
   `{{secret:…}}` placeholder in a response body — so copying either one produces a mock
   that contradicts itself. Mint your own in `seed` with `state.nextId` / `ctx.prng`,
   and keep them referentially consistent: what a route returns must match the id its path
   was given.
7. **CORS preflight is answered for you.** The mock host replies to `OPTIONS` by
   reflecting the request's origin and allowing credentials, and puts those headers on
   every other response too. Do not write `OPTIONS` routes — declare one only if this
   service does something unusual at preflight, in which case your explicit route wins.
8. **State fidelity over verbatim replay.** The bar is *emulator, not stub*. If the corpus
   shows `POST /x` followed by `GET /x/{id}`, the created entity must be readable back.
   Keep it in `ctx.state`, which is per (service, profile) and survives across requests —
   never in a module-level variable, which does not survive a reset.
9. **Every new mock adds its EKB entry.** Declare in `ekb` how a client is pointed at this
   service — an env var, an SDK constructor option, or a code patch. Without it
   `mocktown env` cannot cover the service and the seal cannot certify it.
10. **Seed data per auth profile**, with `default` and `empty-org` at minimum. `default`
   is informed by recorded traffic; `empty-org` is synthesized and has nothing at all.
11. **Prefer profile variation over knob flips** for data-shape scenarios. "Empty vs.
   populated" is a profile. Knobs are for cross-cutting dials — latency, error injection,
   volume scaling — and for overrides a human wants to turn while watching the app.
12. **All randomness goes through `ctx.prng`.** `Math.random()`, `Date.now()` and
   `crypto.randomUUID()` break the determinism contract: same seed + same knobs + same
   profile + same request sequence must produce byte-identical responses.
13. **A WebSocket channel is declared in `sockets`, not faked with a route.** The corpus
   holds one whole transcript per channel, written from the client's point of view, and a
   channel the mock does not declare is rejected at the handshake — which is deliberate: a
   socket that connects and then says nothing is the hardest mock bug to diagnose. State
   that must outlive the connection goes in `ctx.state`; state that must not goes in
   `ctx.connection`.
14. **Never delete recordings to make a check pass.** `mocktown recordings delete` exists
   to prune noise and to remove a capture that should not be on disk — not to resolve a
   failure. Deleting the recordings a mock fails verification against makes `mocktown mocks
   verify` pass by having nothing left to replay, and closes an issue by destroying its
   evidence. Both read as green and neither is. If the corpus is a poor witness, rule 4 is
   the answer: correct the schema in `schema.overrides.ts` and say why. And never run `mocktown project remove` —
   that is a human's decision about their machine, not a step in any job here.
15. **Do not write routes for gRPC methods.** They are recorded as opaque HTTP/2 and cannot
   be served by a generated mock — `Bun.serve` does not accept HTTP/2 connections, and
   gRPC needs it plus trailers. Point the service at `record`, or run a real gRPC test
   double and register its host as `passthrough`.
16. **`record` and `passthrough` are not interchangeable.** While recording they route
   identically, so the difference only shows under `mocktown serve`: a `record` host that
   has a generated mock is served from it, and `passthrough` always goes out. Write
   `passthrough` for a host a served run must genuinely reach, and `record` only for one
   you mean to capture. To take a mocked host live for a single run, use `mocktown record
   --live <host>` rather than editing the registry and putting it back.
