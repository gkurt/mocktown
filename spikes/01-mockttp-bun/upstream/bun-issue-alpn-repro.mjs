// Self-contained repro: ALPN is not negotiated when SNICallback is set.
// Run with `node alpn-repro.mjs` and `bun run alpn-repro.mjs` and compare.
import tls from "node:tls";

const cert = `-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIUQwR8W/wGTeEr5/cSnLVURaUH1DEwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDgzMTE1NTI1MloXDTM2MDgy
ODE1NTI1MlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA0GL2Ji8M8h3+PnOdyLvibpsrZi/S0/hJT/drWaez+WX/
iaDQQrP8fV5tTeyjW/s8BbLN2rdza/DEs2d1Qf7VcfYsrq9tVwO43hW4RJVXofjR
SLzStv7g0WZc2I+0bMKT7RcZ/D7L+klEu4LkrfsRXEmWVN5c7JVhA7i+G3GmQuVt
tss8pnpuZUBzbBMMEBVJChOZMABzTz//7f3Dd5FQHMumrmh+v5qSjsBMas1NqWcx
gAzjwyPXGJdbO+LrYh15MYbwMFwjkVZDncnn6hdoLYpPK+bH5rrwcOt3erCMFw2W
/v5As4QcxQqYbnQCp7kXDR738F0xCBTfcGe6M11VFQIDAQABo2kwZzAdBgNVHQ4E
FgQU7TiXSmOI7UdYfgcDpnY66VEoP2cwHwYDVR0jBBgwFoAU7TiXSmOI7UdYfgcD
pnY66VEoP2cwDwYDVR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3Qw
DQYJKoZIhvcNAQELBQADggEBAKuPUGevbRrGnXEP+5hse/u8DAdvlxp6UfBdM1Nk
roBl9qXWlEoR6/TnzxghDEmVT+mZSmGhm8ysk6AkWZCd+txmjwiqPWxvN+mlI7Qz
iLHnqlZ5f31sbn/6avbcO1hKHuIQ6YJ7QQliWMo7A1az1MXUtPBTG2AEKzXggDXw
Yz98JsFX4aFvQ7nqIkXbJ5eRutfyH44ygQQtwRDoXB6PMIfjnoZUpkQ7hhGAEy1I
x/bPhGWJtaplVkWYz/VnIKPu2j1mr/p75hXkhxhRyi/wKLA7vLUMOZS3WPi/MdxK
60vkmws0stJjtp/ap9HkxplTdrkAA3N0p/IGBywtuhl+Txg=
-----END CERTIFICATE-----`;
const key = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDQYvYmLwzyHf4+
c53Iu+JumytmL9LT+ElP92tZp7P5Zf+JoNBCs/x9Xm1N7KNb+zwFss3at3Nr8MSz
Z3VB/tVx9iyur21XA7jeFbhElVeh+NFIvNK2/uDRZlzYj7RswpPtFxn8Psv6SUS7
guSt+xFcSZZU3lzslWEDuL4bcaZC5W22yzymem5lQHNsEwwQFUkKE5kwAHNPP//t
/cN3kVAcy6auaH6/mpKOwExqzU2pZzGADOPDI9cYl1s74utiHXkxhvAwXCORVkOd
yefqF2gtik8r5sfmuvBw63d6sIwXDZb+/kCzhBzFCphudAKnuRcNHvfwXTEIFN9w
Z7ozXVUVAgMBAAECggEAA6NPZ39j4HGHvsOyqgVXAjqZfsPwEEYuG/HfnHIBXXUJ
Li7u7n6beWs1ABt5gM2/hGKd/aDboku0M8ZzVtBk+Uy/+oRAUHvVjlrMYeaz7DVe
mKIIBSCKgI1Zz0OrLHl4R09+0OaL2NXzPGWN5y2nfjIH63nOBsdpTc9yrWuMAPaC
eq6eLYDckFB9qEiLEU/GFJylpiV6MPw6cYEK6TvS3Wo+9bjIXDkYLco/iAA9hs/4
3/I0hvnxrlRbhw76mKb4CaY5/JE0jlESfVrZ/uPuDp+UFt8jh+7DXP32C0eLdZ8s
cXkQT63UEGuZzbvxL+i7NjIwbGyHmARDni4/9pIylwKBgQDr9W+JUYrR+wTPOdYa
mo/WeIh/u6GliwpUn6tU9VmhS3ctNgC/nmoJBEFesF08bqAgzRK5hWpCXUHSGEe3
ermWNlNaLmyaGmyD9K7jO8W9aLbJnFjVqQNLesnJ3bYGUA3pUqDesLlgPTu2eCgK
lATKSn0wNXe2Wa9phk22yMqF3wKBgQDiFgLPt0hXNZSJRhzN1xo2zzi7YBkGGhnO
fACwta0VSoPtbfUHOYp1v6y9+HUxBHF1i3TNtesrxeaHEcuOrlGPcm9GulxvOird
56MsZW9Qv+kf+NvuEdauCR2CZXfO2/24Js3UZ/4wFftx0wAr9P5qOggau6swBygk
vIiW9nv7iwKBgF4iwubD02BGhvqtlk9yzmPAHqTnFGxY9jwgn1f7slB5LQiqfM31
w1PpkLLYJbpQYC314ryFD4l+bx4EdcgrfBMDhWl7D/TDCfvzCDq7w/324sW4THCh
RyE70XlprI8ELSiiwG9Xjf1pMINxmHfv6aFS6nLrQeFMEoFFBYggvzt9AoGADzBx
YekraAiGgS5/suiXr0T+x7/uDnXkc/XqyfR6u2p1MJdpleGsxrpo7Z5qqS9mPAJx
h3yIXzl9gmeUqHJXsm56wWK14RckWCI+2TW7Y85w6B/9DqKOLMUaAW+1u+UVx7B7
taCC+FIRwZTudwWPri1V7A3ds21XqhgsiQ/oRn8CgYEAx0JueSfPIn63wgXtAH8R
BWc7kvPkKYfNZ24DQaH7/yUli+Nq9PZf/4cuqJMvvDBNwAfMRk03+8Uxr8APBXWP
30d4lTz9/vmzNtAJXZMY6AEnzOgiLmmKGp2r/3c8/Z3sVknKOpdnuPQogrLr8T10
S4qBSnebFW9O0W6kPW+uHLc=
-----END PRIVATE KEY-----`;

const ctx = tls.createSecureContext({ cert, key });
const ALPN = ["h2", "http/1.1"];

const cases = {
  "ALPN in server options": { cert, key, ALPNProtocols: ALPN },
  "ALPN + SNICallback": { cert, key, ALPNProtocols: ALPN, SNICallback: (_s, cb) => cb(null, ctx) },
  "SNICallback, ALPN only on returned context": {
    cert, key,
    SNICallback: (_s, cb) => cb(null, tls.createSecureContext({ cert, key, ALPNProtocols: ALPN })),
  },
  "ALPNCallback": { cert, key, ALPNCallback: ({ protocols }) => protocols.find((p) => ALPN.includes(p)) },
  "ALPNCallback + SNICallback": {
    cert, key,
    ALPNCallback: ({ protocols }) => protocols.find((p) => ALPN.includes(p)),
    SNICallback: (_s, cb) => cb(null, ctx),
  },
};

const runtime = process.versions.bun ? `bun  ${process.versions.bun}` : `node ${process.versions.node}`;
console.log(`\n  ${runtime}   client offers ALPN ["h2", "http/1.1"]\n`);

for (const [name, options] of Object.entries(cases)) {
  const server = tls.createServer(options, (s) => s.end());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();

  const negotiated = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve("TIMEOUT"), 4000);
    const socket = tls.connect(
      { port, host: "127.0.0.1", servername: "localhost", rejectUnauthorized: false, ALPNProtocols: ALPN },
      () => { clearTimeout(timer); resolve(socket.alpnProtocol); socket.destroy(); }
    );
    socket.on("error", (e) => { clearTimeout(timer); resolve(`ERROR ${e.code ?? e.message}`); });
  });

  const ok = negotiated === "h2";
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name.padEnd(44)} alpnProtocol = ${JSON.stringify(negotiated)}`);
  server.close();
}
console.log();
process.exit(0);
