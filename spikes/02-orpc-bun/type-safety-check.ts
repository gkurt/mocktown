/**
 * The contract is only worth having if it actually constrains the three surfaces.
 * These are deliberate mistakes — `bunx tsc --noEmit` on this file must report all of
 * them. If it reports none, the types are decorative.
 */
import { createORPCClient } from '@orpc/client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { implement } from '@orpc/server';
import { contract } from './contract.ts';

const client = createORPCClient<any>(new OpenAPILink(contract, { url: 'http://127.0.0.1:4499/api/v1' }));
type Client = { services: { list: (i: { project: string; provider?: string }) => Promise<{ project: string; services: unknown[] }> } };
const typed = client as unknown as Client;

// @ts-expect-error — `project` is required by the contract
typed.services.list({});

// @ts-expect-error — `nope` is not a field on the input schema
typed.services.list({ project: 'acme-api', nope: 1 });

// @ts-expect-error — the handler must return the contract's output shape
implement(contract).services.list.handler(() => ({ wrong: true }));

// @ts-expect-error — `set` must return a service, not a bare string
implement(contract).services.set.handler(() => 'done');
