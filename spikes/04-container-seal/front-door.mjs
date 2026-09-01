/**
 * The front door, as it runs inside the sealed sandbox.
 *
 * Node, because the proxy is a Node sidecar (spike 01). It listens on 443 and 80 so that
 * DNS-overridden hostnames reach it without any client configuration at all — inside the
 * namespace there is no "direct", which is 04-sandbox.md's whole point.
 *
 * Every unknown host is denied and the attempt is recorded as a wall-hit, because
 * "every escape attempt is evidence".
 */

import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import * as mockttp from 'mockttp';

const ca = { cert: readFileSync('/ca/ca.pem', 'utf8'), key: readFileSync('/ca/ca.key', 'utf8') };
const MOCKED_HOSTS = ['api.stripe.com', 'api.github.com'];
const wallHits = [];

const proxy = mockttp.getLocal({ https: ca });
await proxy.start(443);

// Mocked services: served from inside the boundary, TLS terminated with the project CA.
for (const host of MOCKED_HOSTS) {
  await proxy.forAnyRequest().forHost(host).always().thenJson(200, { mocked: true, host });
}

// The deny wall. Everything not explicitly mocked is refused, and the full request is
// filed as an issue (07-issues-agent-loop.md).
await proxy
  .forAnyRequest()
  .always()
  .thenCallback((req) => {
    const hit = { at: new Date().toISOString(), method: req.method, url: req.url, host: req.headers.host ?? null };
    wallHits.push(hit);
    writeFileSync('/out/wall-hits.json', JSON.stringify(wallHits, null, 2));
    console.log(`WALL-HIT ${hit.method} ${hit.url}`);
    return {
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'unknown-host', issue: 'wall-hit filed', host: hit.host }),
    };
  });

// A tiny control surface so the test harness can read the wall-hit log from outside.
http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(wallHits));
  })
  .listen(9100, '0.0.0.0');

console.log('front door listening on 443 (proxy+direct) and 9100 (wall-hit log)');
