// WebSocket check, deliberately run under Node even when the proxy runs under Bun:
// Bun ships its own `ws` shim (exports `Server`, not `WebSocketServer`) whose client
// ignores `agent`/`rejectUnauthorized`, so a Bun-side client would test Bun's WebSocket
// implementation rather than the front door's ability to proxy WebSockets.
//
// argv: <proxyUrl> <caPath> <upstreamPort>

import { readFileSync } from 'node:fs';
import https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { WebSocket, WebSocketServer } from 'ws';

const [proxyUrl, caPath, upstreamPortArg] = process.argv.slice(2);
const ca = readFileSync(caPath);

// Upstream WSS server (also under Node, for the same reason).
const key = readFileSync(new URL('./out/upstream.key', import.meta.url));
const cert = readFileSync(new URL('./out/upstream.pem', import.meta.url));
const upstream = https.createServer({ key, cert });
const wss = new WebSocketServer({ server: upstream });
wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
await new Promise((r) => upstream.listen(Number(upstreamPortArg), '127.0.0.1', r));

const agent = new HttpsProxyAgent(proxyUrl, { ca });
const result = await new Promise((resolve) => {
  const t = setTimeout(() => resolve('TIMEOUT'), 12000);
  const ws = new WebSocket(`wss://localhost:${upstreamPortArg}/socket`, { agent, ca, rejectUnauthorized: false });
  ws.on('open', () => ws.send('ping'));
  ws.on('message', (m) => {
    clearTimeout(t);
    ws.close();
    resolve(m.toString());
  });
  ws.on('error', (e) => {
    clearTimeout(t);
    resolve(`ERROR ${e.message}`);
  });
});

console.log(JSON.stringify({ result }));
wss.close();
upstream.close();
process.exit(0);
