/**
 * State introspection probes for emulate-backed services.
 *
 * 06-emulation.md sets the bar deliberately low here: "For emulate it's best-effort:
 * whatever its processes expose; gaps here are acceptable." emulate has no introspection
 * API, so the only honest way to list what a running emulator holds is to ask it the same
 * question a client would — a list endpoint of its own public API.
 *
 * The table follows the same rule as [emulate-recipes.ts](emulate-recipes.ts): **a probe
 * we have not exercised does not go in.** An invented endpoint would make `state get`
 * report an empty collection where the emulator actually holds data, which reads as "the
 * seed did not apply" and sends someone to debug a seed file that is fine. A service with
 * no probes reports *why* it has none, and that is a better answer than a wrong one.
 *
 * Adding a probe is a one-line contribution and the table is meant to accrete, the same
 * way the EKB does.
 */

export interface StateProbe {
  /** Collection name as it appears in `mocktown state get`. */
  collection: string;
  /** Path on the emulator, including any query string. */
  path: string;
  /** Property holding the array in the response body; empty means the body *is* the array. */
  itemsAt: string;
  /** Property of each item to use as its key. */
  keyField: string;
  /** Sent as a bearer token. emulate accepts any well-formed key on its data endpoints. */
  auth?: string;
}

/**
 * Stripe's list endpoints are the set spike 03 exercised end to end, and they need no
 * real credential — the emulator accepts any `sk_test_`-shaped key, which is also what
 * the scrubber's fake generator produces.
 */
const STRIPE_KEY = 'sk_test_mocktownstateprobe';

const stripeProbe = (collection: string, resource: string): StateProbe => ({
  collection,
  path: `/v1/${resource}?limit=100`,
  itemsAt: 'data',
  keyField: 'id',
  auth: STRIPE_KEY,
});

export const EMULATE_STATE_PROBES: Record<string, StateProbe[]> = {
  stripe: [
    stripeProbe('customers', 'customers'),
    stripeProbe('products', 'products'),
    stripeProbe('prices', 'prices'),
    stripeProbe('subscriptions', 'subscriptions'),
    stripeProbe('invoices', 'invoices'),
    stripeProbe('charges', 'charges'),
    stripeProbe('payment_intents', 'payment_intents'),
  ],
};

/**
 * Why a service has no probes. Said out loud, because "no collections" and "we never
 * taught it how to look" are different facts and only one of them is a bug in a seed file.
 */
export const NO_PROBE_REASONS: Record<string, string> = {
  github:
    "GitHub's list endpoints are all per-user and need a token minted through the OAuth consent flow, so there is nothing to poll anonymously.",
  s3: 'The S3 emulator answers in XML, not JSON, and a bucket listing is not the state a panel wants anyway.',
};

export function probesFor(emulateService: string): StateProbe[] {
  return EMULATE_STATE_PROBES[emulateService] ?? [];
}

export function noProbeReason(emulateService: string): string {
  return (
    NO_PROBE_REASONS[emulateService] ??
    `No introspection probe is known for the "${emulateService}" emulator. emulate exposes no state API, so listing entities means calling one of its own list endpoints — add one to src/ekb/emulate-state.ts once you have exercised it.`
  );
}
