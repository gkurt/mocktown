// The front door offers ALPN ['h2','http/1.1'] so h2 clients stay on h2 (03-capture.md
// defers only HTTP/3). Mockttp picks the cert per-connection via SNICallback, so ALPN
// has to survive that path.

import type net from 'node:net';
import tls from 'node:tls';
import { generateCACertificate } from 'mockttp';

const leaf = await generateCACertificate({ subject: { commonName: 'localhost' } });
const ctx = tls.createSecureContext({ cert: leaf.cert, key: leaf.key });

for (const [name, opts] of [
  ['ALPN on server options', { cert: leaf.cert, key: leaf.key, ALPNProtocols: ['h2', 'http/1.1'] }],
  ["ALPN + SNICallback (Mockttp's)", { ALPNProtocols: ['h2', 'http/1.1'], SNICallback: (_n: string, cb: any) => cb(null, ctx) }],
] as [string, tls.TlsOptions][]) {
  const server = tls.createServer(opts, (s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  const chosen = await new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve('TIMEOUT'), 4000);
    const c = tls.connect(
      { port, host: '127.0.0.1', servername: 'localhost', rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] },
      () => {
        clearTimeout(t);
        const p = c.alpnProtocol;
        c.destroy();
        resolve(String(p));
      },
    );
    c.on('error', (e) => {
      clearTimeout(t);
      resolve(`ERROR ${e.message}`);
    });
  });
  console.log(`  ${chosen === 'h2' ? 'PASS' : 'FAIL'}  ${name.padEnd(32)} negotiated=${chosen}`);
  server.close();
}
process.exit(0);
