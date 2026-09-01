// ROOT CAUSE: net.Server's connection listener — whether passed to the constructor
// (net.createServer(fn)) or subclassed via super(fn), as @httptoolkit/httpolyglot does —
// is not invoked when a socket is fed back in with server.emit('connection', socket).
//
// Node registers that callback as a real 'connection' event listener, so re-emitting
// re-dispatches it. Every MITM proxy relies on this: after CONNECT, the tunnelled socket
// is pushed back through the same port multiplexer to be re-sniffed as TLS.
import net from 'node:net';

let viaConstructor = 0,
  viaOn = 0;

const s1 = net.createServer(() => {
  viaConstructor++;
});
console.log("  net.createServer(fn) registers a 'connection' listener:", s1.listeners('connection').length > 0);
s1.emit('connection', {} as any);
console.log("  constructor listener invoked by emit('connection'):", viaConstructor === 1);

class Sub extends net.Server {
  constructor() {
    super((sock: any) => this.handle(sock));
  }
  handle(_s: any) {
    viaOn++;
  }
}
const s2 = new Sub();
s2.emit('connection', {} as any);
console.log("  subclass super(fn) listener invoked by emit('connection'):", viaOn === 1, "  <-- httpolyglot's pattern");

const s3 = net.createServer();
let viaExplicitOn = 0;
s3.on('connection', () => {
  viaExplicitOn++;
});
s3.emit('connection', {} as any);
console.log("  explicit .on('connection') invoked by emit('connection'):", viaExplicitOn === 1, ' <-- the workaround');
process.exit(0);
