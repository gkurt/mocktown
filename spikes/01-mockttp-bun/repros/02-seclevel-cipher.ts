// Mockttp appends OpenSSL's '@SECLEVEL=0' to its upstream cipher list whenever
// certificate checks are relaxed (passthrough-handling.js:137-141) — the "magic cipher"
// that lets OpenSSL talk to legacy servers. BoringSSL, which Bun uses, has no such
// directive. Recording against a staging host with a self-signed cert hits this.
import tls from 'node:tls';

const BASE = 'TLS_AES_128_GCM_SHA256:ECDHE-RSA-AES128-GCM-SHA256:AES128-SHA';
for (const [name, ciphers] of [
  ['plain cipher list', BASE],
  ['with @SECLEVEL=0', `${BASE}:@SECLEVEL=0`],
] as const) {
  try {
    tls.createSecureContext({ ciphers });
    console.log(`  PASS  ${name}`);
  } catch (e: any) {
    console.log(`  FAIL  ${name}: ${e.message}`);
  }
}
process.exit(0);
