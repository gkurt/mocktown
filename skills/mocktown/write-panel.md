# Write a panel

A panel is **one self-contained HTML file plus a small manifest** in
`.mocktown/panels/`. There is no SDK, no build step and no plugin API — the shell lists
panels and iframes them, and a panel reads the same public API every other client reads
(09-gui-plugins.md). This is deliberately the artifact you are best at producing.

```jsonc
// .mocktown/panels/stripe-state.json
{ "name": "Stripe state", "service": "api.stripe.com", "entry": "stripe-state.html" }
```

## The three conventions

1. **The daemon injects your credentials.** `<meta name="mocktown-boot">` carries
   `{ apiBase, token, project }`. Read it, never hard-code anything:

   ```js
   const boot = JSON.parse(document.querySelector('meta[name="mocktown-boot"]').content);
   const response = await fetch(`${boot.apiBase}/state?project=${encodeURIComponent(project)}`, {
     headers: { authorization: `Bearer ${boot.token}` },
   });
   ```

2. **The shell passes the project in the query string**, so prefer
   `new URLSearchParams(location.search).get('project') ?? boot.project`. Every API call
   takes `project`.

3. **It passes its colour scheme there too** — `scheme` is `system`, `light` or `dark`.
   Declare `color-scheme: light dark` and pin it when the shell has been pinned; `system`
   needs nothing, because that is what the declaration already does:

   ```js
   const scheme = new URLSearchParams(location.search).get('scheme');
   if (scheme === 'light' || scheme === 'dark') document.documentElement.style.colorScheme = scheme;
   ```

   A panel is an iframe and `color-scheme` does not cross that boundary, so a panel that
   skips this is a white rectangle in a dark shell.

Start from the shipped example rather than a blank file: `mocktown panels list` shows the
built-in `provider-state` panel and the path to it. Copying it into
`.mocktown/panels/` overrides the built-in of the same name.

## Rules

- **No external resources of any kind.** A panel is served under
  `default-src 'none'; connect-src 'self'` — no CDN script, no web font, no remote image.
  Not a style preference: the data you can read is scrubbed third-party traffic, and an
  image URL exfiltrates as well as a `fetch` does. Inline your CSS and JS.
- **Take your colours from the scheme, not from a palette.** `light-dark()`, the system
  colours (`Canvas`, `CanvasText`) and `color-mix(… currentColor …)` all follow the scheme
  above on their own. A hard-coded `#fff` is a panel that only works in one of the two.
- **Render API data as text, never as markup.** Everything you display came from a third
  party's response. Build nodes and set `textContent`; do not concatenate response values
  into `innerHTML`.
- **Read, do not write.** Panels are for seeing into state. A panel that POSTs a mutation is
  a capability the CLI already has, with none of its confirmations.
- **Fetch nothing you were not asked for.** State can be large: `GET /state` gives counts
  per service, and `GET /state/{service}?collection=<name>` gives entries. Load entries when
  the reader opens them.
- **Fail visibly.** If a call fails, show the status and the path. A panel that renders an
  empty table on error is worse than one that says what broke.
- **Check your manifest is usable**: `mocktown panels list` reports every manifest it could
  not read, and why.
- **Look at it before you call it done.** `mocktown ui` opens the shell that lists and
  iframes your panel — a panel is a document, and reading the source is not the same as
  seeing what it renders against real state.
