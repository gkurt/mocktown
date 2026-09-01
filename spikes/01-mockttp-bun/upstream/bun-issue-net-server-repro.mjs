// Repro: net.Server's constructor callback is not registered as a 'connection'
// listener, so server.emit('connection', socket) never reaches it.
//
//   node net-server-repro.mjs
//   bun  net-server-repro.mjs
import net from 'node:net';

const runtime = process.versions.bun ? `bun  ${process.versions.bun}` : `node ${process.versions.node}`;
console.log(`\n  ${runtime}\n`);

// 1. Is the constructor callback visible as a 'connection' listener?
const viaFactory = net.createServer(() => {});
console.log(`  net.createServer(fn).listeners('connection').length  = ${viaFactory.listeners('connection').length}`);

class Subclass extends net.Server {
  constructor() {
    super(() => {});
  }
}
console.log(`  subclass super(fn)   .listeners('connection').length  = ${new Subclass().listeners('connection').length}`);

// 2. Does a genuine inbound connection reach it? (yes, on both runtimes)
// 3. Does a re-emitted socket reach it?  (no, on Bun)
let viaAccept = 0;
let viaEmit = 0;

const target = net.createServer(() => {
  viaEmit++;
});
await new Promise((r) => target.listen(0, '127.0.0.1', r));

// Stands in for a proxy's CONNECT handler: it accepts the socket itself, then hands
// it back to `target` to be re-sniffed and routed.
const tunnel = net.createServer((socket) => {
  viaAccept++;
  target.emit('connection', socket);
});
await new Promise((r) => tunnel.listen(0, '127.0.0.1', r));

const client = net.connect(tunnel.address().port, '127.0.0.1');
await new Promise((r) => client.on('connect', r));
await new Promise((r) => setTimeout(r, 150));

console.log(`\n  genuine inbound connection reached the callback : ${viaAccept === 1}`);
console.log(`  re-emitted socket reached the callback         : ${viaEmit === 1}`);
console.log();

client.destroy();
tunnel.close();
target.close();
process.exit(0);
