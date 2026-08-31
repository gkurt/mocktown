/**
 * emulate also exports a programmatic API (`createEmulator`) with `reset()` and
 * `generatedSecrets`. 06-emulation.md chose child processes; this checks whether the
 * in-process route works under Bun at all, and what it would buy — recorded as an
 * option, not adopted.
 */
import { createEmulator } from "emulate";

try {
  const emu = await createEmulator({
    service: "stripe",
    port: 4555,
    seed: { stripe: { customers: [{ email: "ada@example.com", name: "Ada" }] } } as any,
  });
  const before: any = await (await fetch(`${emu.url}/v1/customers`, { headers: { authorization: "Bearer sk_x" } })).json();
  await fetch(`${emu.url}/v1/customers`, {
    method: "POST", headers: { authorization: "Bearer sk_x", "content-type": "application/x-www-form-urlencoded" },
    body: "email=runtime@example.com",
  });
  const after: any = await (await fetch(`${emu.url}/v1/customers`, { headers: { authorization: "Bearer sk_x" } })).json();
  emu.reset();
  const reset: any = await (await fetch(`${emu.url}/v1/customers`, { headers: { authorization: "Bearer sk_x" } })).json();

  console.log("  PASS  createEmulator runs in-process under Bun");
  console.log(`        url=${emu.url}  seeded=${before.data.length}  after write=${after.data.length}  after reset()=${reset.data.length}`);
  console.log(`        generatedSecrets=${JSON.stringify(emu.generatedSecrets.map((s: any) => `${s.kind}:${s.label}`))}`);
  await emu.close();
} catch (e: any) {
  console.log("  FAIL  createEmulator under Bun:", (e.message ?? String(e)).slice(0, 200));
}
process.exit(0);
