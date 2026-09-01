/**
 * HAR import — rung 4 of 03-capture.md's escalation ladder: the escape hatch for traffic
 * only observable with another tool (Charles, Proxyman, mitmproxy, DevTools).
 *
 * "Imported exchanges run through the same scrubber and land in the same corpus" — so
 * this module only translates the format. Everything else is `Recorder`'s job, which is
 * what keeps a HAR-sourced row indistinguishable from a front-door one downstream.
 */
import * as z from 'zod/v4';
import type { CapturedExchange } from '#src/frontdoor/controller.ts';

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
    content: z
      .object({
        mimeType: z.string().optional(),
        text: z.string().optional(),
        encoding: z.string().optional(),
      })
      .default({}),
  }),
});

export const HarFile = z.object({ log: z.object({ entries: z.array(HarEntry).default([]) }) });

function headers(list: { name: string; value: string }[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const { name, value } of list) {
    // HAR keeps pseudo-headers from h2 captures; they are transport framing, not headers.
    if (name.startsWith(':')) continue;
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
    if (!/^https?:/i.test(url)) {
      skipped.push({ url, reason: 'not an HTTP(S) request' });
      return;
    }

    const content = entry.response.content;
    let responseBody = content.text ?? '';
    let responseEncoding: 'text' | 'base64' = 'text';
    if (content.encoding === 'base64' && responseBody) {
      const decoded = Buffer.from(responseBody, 'base64');
      // A body that is not valid UTF-8 stays base64 rather than being dropped. It cannot
      // be scrubbed by pattern — the recorder marks that on the row so the corpus is
      // honest about it (10-security.md) — but discarding it lost real traffic, and the
      // front door has been keeping the equivalent since phase 4.
      const text = decoded.toString('utf8');
      if (Buffer.from(text, 'utf8').equals(decoded)) responseBody = text;
      else responseEncoding = 'base64';
    }

    const requestHeaders = headers(entry.request.headers);
    exchanges.push({
      id: `har-${index}`,
      method: entry.request.method,
      url,
      statusCode: entry.response.status,
      requestHeaders,
      responseHeaders: headers(entry.response.headers),
      requestBody: entry.request.postData?.text ?? '',
      responseBody,
      // A HAR's request body is always text — the format has nowhere to put anything else.
      requestEncoding: 'text',
      responseEncoding,
      kind: String(requestHeaders['content-type'] ?? '').startsWith('application/grpc') ? 'grpc' : 'http',
      durationMs: entry.time !== undefined ? Math.round(entry.time) : null,
      mode: 'record',
    });
  });

  return { exchanges, skipped };
}
