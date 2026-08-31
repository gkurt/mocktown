#!/usr/bin/env bun
/**
 * The CLI, generated entirely from the contract. No command is written by hand:
 * add a procedure and its command appears, with flags, help text and validation.
 *
 * Honours 02-architecture.md's output contract: every command supports `--json`,
 * and the human rendering is a projection of the same data, never richer.
 * Honours 08-projects-config.md: the resolved project is the first line of output.
 */
import { Command, Option } from "commander";
import { createORPCClient } from "@orpc/client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { z } from "zod";
import { contract } from "./contract.ts";
import { walkContract, type ProcedureInfo } from "./walk.ts";

const BASE = process.env.MOCKTOWN_API ?? "http://127.0.0.1:4499/api/v1";
const TOKEN = process.env.MOCKTOWN_TOKEN;
const link = new OpenAPILink(contract, {
  url: BASE,
  headers: () => (TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
});
const client: any = createORPCClient(link);

/** Zod object -> commander options. One flag per top-level input field. */
function addOptions(cmd: Command, schema: z.ZodType) {
  const shape = (schema as any)?._zod?.def?.shape;
  if (!shape) return;
  for (const [name, field] of Object.entries<any>(shape)) {
    const optional = field?.safeParse?.(undefined)?.success ?? false;
    const description = field?._zod?.def?.description ?? field?.description ?? "";
    const flag = `--${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())} <value>`;
    cmd.addOption(optional ? new Option(flag, description) : new Option(flag, description).makeOptionMandatory());
  }
}

function resolveClient(path: string[]) {
  return path.reduce<any>((node, key) => node[key], client);
}

/** Human rendering: a projection of the JSON, never richer than it. */
function render(result: unknown) {
  if (result && typeof result === "object" && "project" in result) {
    console.log(`project: ${(result as any).project}`);
  }
  const rows = (result as any)?.services ?? (result as any)?.service ? [(result as any).service ?? null].filter(Boolean) : null;
  const list = (result as any)?.services ?? rows;
  if (Array.isArray(list)) {
    for (const s of list) console.log(`  ${String(s.id).padEnd(24)} ${String(s.provider).padEnd(20)} ${s.lastSeenAt ?? "never seen"}`);
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

const program = new Command("mocktown").description("Mocktown CLI (generated from the oRPC contract)");

for (const proc of walkContract(contract) as ProcedureInfo[]) {
  // services.list -> `mocktown services list`
  let parent = program;
  for (const segment of proc.path.slice(0, -1)) {
    parent = parent.commands.find((c) => c.name() === segment) ?? parent.command(segment);
  }
  const cmd = parent.command(proc.path.at(-1)!).description(proc.summary ?? "");
  addOptions(cmd, proc.inputSchema);
  cmd.option("--json", "Emit the raw API response");
  cmd.action(async (opts) => {
    const { json, ...input } = opts;
    try {
      const result = await resolveClient(proc.path)(input);
      if (json) console.log(JSON.stringify(result));
      else render(result);
    } catch (e: any) {
      console.error(`error: ${e?.message ?? e}`);
      process.exit(1);
    }
  });
}

await program.parseAsync(process.argv);
