/**
 * The one place a Mocktown procedure is defined. Everything else in this spike —
 * the HTTP API, the OpenAPI document, the typed client, the CLI, the MCP server —
 * is derived from this file and nothing else.
 *
 * Two real procedures from the API sketch in docs/design/02-architecture.md:
 *   GET /services        — the service registry
 *   PUT /services/{id}   — provider assignment
 */
import { oc } from "@orpc/contract";
import { z } from "zod";

// ── Domain schemas (08-projects-config.md's service registry) ──────────────────
export const ProviderRef = z
  .union([
    z.templateLiteral(["emulator:", z.string()]),
    z.templateLiteral(["generated:", z.string()]),
    z.literal("passthrough"),
    z.literal("record"),
    z.literal("deny"),
  ])
  .describe("How the front door routes this hostname (03-capture.md)");

export const Service = z.object({
  id: z.string().describe("Hostname or logical service id, e.g. api.stripe.com"),
  provider: ProviderRef,
  seed: z.string().optional().describe("Path to a seed file, relative to the repo root"),
  lastSeenAt: z.iso.datetime().nullable().describe("When traffic for this service was last observed"),
});
export type Service = z.infer<typeof Service>;

// ── Procedures ────────────────────────────────────────────────────────────────
export const contract = {
  services: {
    list: oc
      .route({ method: "GET", path: "/services", summary: "List the project's service registry" })
      .input(z.object({
        project: z.string().describe("Resolved project name (08-projects-config.md)"),
        provider: ProviderRef.optional().describe("Filter to one provider kind"),
      }))
      .output(z.object({ project: z.string(), services: z.array(Service) })),

    set: oc
      .route({ method: "PUT", path: "/services/{id}", summary: "Assign a provider to a service" })
      .input(z.object({
        project: z.string(),
        id: z.string().describe("Hostname or logical service id"),
        provider: ProviderRef,
        seed: z.string().optional(),
      }))
      .output(z.object({ project: z.string(), service: Service })),
  },
};
