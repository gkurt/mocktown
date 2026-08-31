/**
 * HAR import — rung 4 of 03-capture.md's escalation ladder: the escape hatch for traffic
 * only observable with another tool (Charles, Proxyman, mitmproxy, DevTools).
 *
 * "Imported exchanges run through the same scrubber and land in the same corpus" — so
 * this module only translates the format. Everything else is `Recorder`'s job, which is
 * what keeps a HAR-sourced row indistinguishable from a front-door one downstream.
 */
import { z } from "zod";
import type { CapturedExchange } from "../frontdoor/controller.ts";

const HarHeader = z.object({ name: z.string(), value: z.string() });
const HarPostData = z.object({ mimeType: z.string().optional(), text: z.string().optional() });

const HarEntry = z.object({
  startedDateTime: z.string().optional(),
  time: z.number().optional(),
  request: z.object({
    method: z.string(),
    url: z.string(),
    headers: z.array(HarHeader).default([]),
    postData: HarPostData.optional(),
  }),
  response: z.object({
    status: z.number(),
    headers: z.array(HarHeader).default([]),
    content: z.object({
      mimeType: z.string().optional(),
      text: z.string().optional(),
      encoding: z.string().optional(),
    }).default({}),
  }),
});

export const HarFile = z.object({ log: z.object({ entries: z.array(HarEntry).default([]) }) });

function headers(list: { name: string; value: string }[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const { name, value } of list) {
    // HAR keeps pseudo-headers from h2 captures; they are transport framing, not headers.
    if (name.startsWith(":")) continue;
    const key = name.toLowerCase();
    const existing = out[key];
    if (existing === undefined) out[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
  }
  return out;
}

export interface HarParseResult {
  exchanges: CapturedExchange[];
  /** Entries we could not use, with the reason — an import must never silently drop traffic. */
  skipped: { url: string; reason: string }[];
}

export function parseHar(text: string): HarParseResult {
  const parsed = HarFile.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`not a valid HAR file: ${z.prettifyError(parsed.error)}`);

  const exchanges: CapturedExchange[] = [];
  const skipped: { url: string; reason: string }[] = [];

  parsed.data.log.entries.forEach((entry, index) => {
    const url = entry.request.url;
    if (!/^https?:/i.test(url)) { skipped.push({ url, reason: "not an HTTP(S) request" }); return; }

    const content = entry.response.content;
    let responseBody = content.text ?? "";
    if (content.encoding === "base64" && responseBody) {
      const decoded = Buffer.from(responseBody, "base64");
      // A binary body cannot be scrubbed by pattern, and storing it unscrubbed would
      // break the promise that nothing unscrubbed reaches disk. Record the shape only.
      if (decoded.includes(0)) { skipped.push({ url, reason: "binary response body" }); return; }
      responseBody = decoded.toString("utf8");
    }

    exchanges.push({
      id: `har-${index}`,
      method: entry.request.method,
      url,
      statusCode: entry.response.status,
      requestHeaders: headers(entry.request.headers),
      responseHeaders: headers(entry.response.headers),
      requestBody: entry.request.postData?.text ?? "",
      responseBody,
      durationMs: entry.time !== undefined ? Math.round(entry.time) : null,
      mode: "record",
    });
  });

  return { exchanges, skipped };
}
