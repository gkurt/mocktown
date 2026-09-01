/**
 * The GUI's only way to reach anything: the same `OpenAPILink` client the CLI and the MCP
 * server use, built from the same contract (02-architecture.md — every client is thin, and
 * none has privileged access). Typed end to end, so a procedure that changes shape breaks
 * this build rather than the browser.
 *
 * The token comes from the `mocktown-boot` meta element the daemon injects as it serves the
 * page, never from the bundle.
 */
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { contract } from 'mocktown/contract';

export interface Boot {
  apiBase: string;
  token: string;
  project: string;
}

function readBoot(): Boot {
  const block = document.querySelector('meta[name="mocktown-boot"]')?.getAttribute('content');
  if (!block) throw new Error('This page was not served by the Mocktown daemon, so it has no API token. Run `mocktown gui`.');
  return JSON.parse(block);
}

export const boot = readBoot();

const link = new OpenAPILink(contract, {
  url: boot.apiBase,
  headers: () => ({ authorization: `Bearer ${boot.token}` }),
});

export const api = createORPCClient(link) as ContractRouterClient<typeof contract>;
