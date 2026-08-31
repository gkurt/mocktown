// Bun's builtin `ws` module shadows the npm package unconditionally — from any context,
// including files inside the project where the real package is installed. The builtin
// lacks `PerMessageDeflate` and `extension`, and its constructor rejects
// `new WebSocket(null, …)` — the socket-wrapping form Mockttp uses to proxy an
// already-upgraded WebSocket (websocket-step-impls.js:createWebSocketFromStream).
//
// A Bun.plugin onResolve({filter:/^ws$/}) preload does NOT override it, and Bun's own
// require.resolve("ws") returns the string "ws" rather than a path.
const { createRequire } = require("node:module");
const mockttpFile = require.resolve("mockttp").replace(/dist\/main\.js$/, "dist/rules/websockets/websocket-step-impls.js");

for (const [label, base] of [["from this file", __filename], ["from mockttp's own file", mockttpFile]]) {
  const req = createRequire(base);
  let resolved; try { resolved = req.resolve("ws"); } catch (e) { resolved = "ERR " + e.message; }
  const m = req("ws");
  const real = "PerMessageDeflate" in m && "extension" in m;
  console.log(`  ${real ? "PASS" : "FAIL"}  ${label.padEnd(24)} resolved=${resolved.length > 55 ? "…" + resolved.slice(-42) : resolved}  realNpmWs=${real}`);
}
