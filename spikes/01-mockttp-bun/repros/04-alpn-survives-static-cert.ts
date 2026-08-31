// Escape hatch: Mockttp already parses the inbound ClientHello (it reads SNI/ALPN for
// its passthrough rules), so it could skip SNICallback entirely — pick the cert itself
// and hand the socket to a per-hostname tls.Server with a STATIC cert + static ALPN.
// Does ALPN survive that under Bun, including the emit('connection') handoff a MITM needs?
import tls from "node:tls";
import net from "node:net";
import { generateCACertificate } from "mockttp";

const leaf = await generateCACertificate({ subject: { commonName: "localhost" } });

// Static cert, static ALPN, no SNICallback anywhere.
const tlsServer = tls.createServer({ cert: leaf.cert, key: leaf.key, ALPNProtocols: ["h2", "http/1.1"] });
let negotiatedServerSide = "none";
tlsServer.on("secureConnection", (s) => { negotiatedServerSide = String(s.alpnProtocol); s.end(); });

// Socket arrives via handoff, as it does post-CONNECT.
const tcp = net.createServer((socket) => tlsServer.emit("connection", socket));
await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
const port = (tcp.address() as net.AddressInfo).port;

const chosen = await new Promise<string>((resolve) => {
  const t = setTimeout(() => resolve("TIMEOUT"), 4000);
  const c = tls.connect({ port, host: "127.0.0.1", servername: "localhost", rejectUnauthorized: false, ALPNProtocols: ["h2", "http/1.1"] },
    () => { clearTimeout(t); const p = c.alpnProtocol; c.destroy(); resolve(String(p)); });
  c.on("error", (e) => { clearTimeout(t); resolve("ERROR " + e.message.slice(0, 60)); });
});
await new Promise((r) => setTimeout(r, 100));
console.log(`  ${chosen === "h2" ? "PASS" : "FAIL"}  static cert + static ALPN via handoff: client=${chosen} server=${negotiatedServerSide}`);
process.exit(0);
