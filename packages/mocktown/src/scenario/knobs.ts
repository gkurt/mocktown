/**
 * Knobs — 12-scenario-controls.md.
 *
 * A knob is declared by the generated mock as a Zod schema plus a default and a one-line
 * description, so the GUI can auto-render its form with no per-mock UI work. Values are
 * *project state*, not config: they live in SQLite, take effect immediately, and every
 * change is journaled — which is what keeps a run replayable, since reproducing it means
 * replaying its knob events too.
 *
 * Resolution order, lowest to highest: manifest default, stored project value, profile
 * override. Profile overrides come last because a profile is a whole world of data and
 * should win over a dial someone left turned.
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { KnobManifest } from "../mocks/types.ts";
import { id } from "../util/id.ts";

export interface ResolvedKnob {
  key: string;
  description: string;
  jsonSchema: unknown;
  default: unknown;
  value: unknown;
}

function storedValues(db: Db, service: string): Record<string, unknown> {
  const rows = db.select().from(schema.knobValues).where(eq(schema.knobValues.service, service)).all();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function profileOverrides(db: Db, service: string, profile: string): Record<string, unknown> {
  const row = db.select().from(schema.profiles).where(eq(schema.profiles.name, profile)).get();
  return (row?.knobOverrides?.[service] as Record<string, unknown> | undefined) ?? {};
}

/** The effective values a mock handler receives in `ctx.knobs`. */
export function effectiveKnobs(db: Db, manifest: KnobManifest | undefined, service: string, profile: string): Record<string, unknown> {
  const stored = storedValues(db, service);
  const overrides = profileOverrides(db, service, profile);
  const out: Record<string, unknown> = {};

  for (const [key, definition] of Object.entries(manifest ?? {})) {
    out[key] = overrides[key] ?? stored[key] ?? definition.default;
  }
  // A stored value for a knob the manifest no longer declares still reaches the handler:
  // an agent mid-refactor should see its own leftovers rather than have them vanish.
  for (const [key, value] of Object.entries(stored)) if (!(key in out)) out[key] = value;
  return out;
}

export function describeKnobs(db: Db, manifest: KnobManifest | undefined, service: string, profile: string): ResolvedKnob[] {
  const effective = effectiveKnobs(db, manifest, service, profile);
  return Object.entries(manifest ?? {}).map(([key, definition]) => ({
    key,
    description: definition.description,
    // The GUI renders the form from this, so it has to be JSON Schema and not a Zod object.
    jsonSchema: z.toJSONSchema(definition.schema, { io: "input", unrepresentable: "any" }),
    default: definition.default,
    value: effective[key],
  }));
}

export interface KnobSetResult {
  applied: Record<string, unknown>;
  rejected: { key: string; reason: string }[];
}

/**
 * Setting a knob is a journaled state event: immediate, recorded, replayable. Values are
 * validated against the mock's own schema, so a knob cannot be set to something the
 * handler will then crash on.
 */
export function setKnobs(
  db: Db,
  manifest: KnobManifest | undefined,
  service: string,
  values: Record<string, unknown>,
  sessionId: string,
): KnobSetResult {
  const applied: Record<string, unknown> = {};
  const rejected: { key: string; reason: string }[] = [];

  for (const [key, raw] of Object.entries(values)) {
    const definition = manifest?.[key];
    if (!definition) {
      rejected.push({ key, reason: `the ${service} mock declares no knob named "${key}"` });
      continue;
    }
    const parsed = definition.schema.safeParse(raw);
    if (!parsed.success) {
      rejected.push({ key, reason: z.prettifyError(parsed.error) });
      continue;
    }

    db.insert(schema.knobValues)
      .values({ service, key, value: parsed.data })
      .onConflictDoUpdate({
        target: [schema.knobValues.service, schema.knobValues.key],
        set: { value: parsed.data, updatedAt: new Date().toISOString() },
      })
      .run();
    applied[key] = parsed.data;
  }

  if (Object.keys(applied).length > 0) {
    db.insert(schema.journal)
      .values({ id: id("jrn"), sessionId, kind: "knob-set", service, payload: applied })
      .run();
  }

  return { applied, rejected };
}

/** Knob values survive a state reset unless the caller asks otherwise: they are a dial
 *  a human turned, not data the app created. */
export function clearKnobs(db: Db, service?: string): void {
  if (service) db.delete(schema.knobValues).where(eq(schema.knobValues.service, service)).run();
  else db.delete(schema.knobValues).run();
}

export function knobValue(db: Db, service: string, key: string): unknown {
  return db.select().from(schema.knobValues)
    .where(and(eq(schema.knobValues.service, service), eq(schema.knobValues.key, key)))
    .get()?.value;
}
