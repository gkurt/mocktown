/**
 * The package's public surface. Generated mocks import from `mocktown/mock`; everything
 * else here exists for tests and for embedding the daemon in another Bun process.
 */

export { type ResolvedProject, resolveProject } from '#src/config/project.ts';
export { contract } from '#src/contract/index.ts';
export { inputShape, type ProcedureInfo, walkContract } from '#src/contract/walk.ts';
export { ProjectRuntime, runtimeFor, shutdownAllRuntimes } from '#src/daemon/runtime.ts';
export { openapi, readDaemonState, startDaemon } from '#src/daemon/server.ts';
export type { KnobManifest, MockCtx, MockModule, MockRequest, MockResponse, MockRoute, StateStore } from '#src/mocks/types.ts';
export { defineMock } from '#src/mocks/types.ts';
export { DEFAULT_RULES, rulesFromConfig, type ScrubRule } from '#src/scrub/rules.ts';
export { type Exchange, Scrubber } from '#src/scrub/scrubber.ts';
