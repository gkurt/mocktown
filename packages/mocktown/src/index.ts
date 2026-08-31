/**
 * The package's public surface. Generated mocks import from `mocktown/mock`; everything
 * else here exists for tests and for embedding the daemon in another Bun process.
 */
export { contract } from "./contract/index.ts";
export { walkContract, inputShape, type ProcedureInfo } from "./contract/walk.ts";
export { startDaemon, readDaemonState, openapi } from "./daemon/server.ts";
export { ProjectRuntime, runtimeFor, shutdownAllRuntimes } from "./daemon/runtime.ts";
export { resolveProject, type ResolvedProject } from "./config/project.ts";
export { Scrubber, type Exchange } from "./scrub/scrubber.ts";
export { DEFAULT_RULES, rulesFromConfig, type ScrubRule } from "./scrub/rules.ts";
export { defineMock } from "./mocks/types.ts";
export type { MockModule, MockRoute, MockCtx, MockRequest, MockResponse, KnobManifest, StateStore } from "./mocks/types.ts";
