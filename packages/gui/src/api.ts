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
import { useSyncExternalStore } from 'react';

export interface Boot {
  apiBase: string;
  token: string;
  project: string;
  home: string;
}

function readBoot(): Boot {
  const block = document.querySelector('meta[name="mocktown-boot"]')?.getAttribute('content');
  if (!block) throw new Error('This page was not served by the Mocktown daemon, so it has no API token. Run `mocktown gui`.');
  return JSON.parse(block);
}

export const boot = readBoot();

/**
 * A stranded page, and how it gets that way.
 *
 * The daemon mints a bearer token per process (daemon/server.ts), and this page holds the
 * one belonging to the process that served it — read once, out of the meta element, because
 * there is nowhere else to read it from. A daemon restart therefore does not log the page
 * out so much as strand it: the token it has no longer exists anywhere, no retry will make
 * it work, and only a reload can fix it, because only the daemon can put a fresh token in
 * the HTML. A daemon that is merely *down* fails the fetch instead — that is a real error
 * and stays on the page that hit it.
 *
 * So the 401 is recorded here rather than thrown at whichever query happened to notice
 * first. The shell turns it into one banner, and the pages keep showing the last data they
 * had. Eleven copies of the word "Unauthorized" told the reader neither what broke nor that
 * the fix is `⌘R`.
 */
let stranded = false;
const watchers = new Set<() => void>();

function strand(): void {
  if (stranded) return;
  stranded = true;
  for (const watch of watchers) watch();
}

export const strandedToken = {
  get: () => stranded,
  subscribe(watch: () => void) {
    watchers.add(watch);
    return () => void watchers.delete(watch);
  },
};

/** True once this page's token has stopped being accepted. Never returns to false. */
export const useStranded = () => useSyncExternalStore(strandedToken.subscribe, strandedToken.get);

const link = new OpenAPILink(contract, {
  url: boot.apiBase,
  headers: () => ({ authorization: `Bearer ${boot.token}` }),
  fetch: async (request, init) => {
    const response = await fetch(request, init);
    if (response.status === 401) strand();
    return response;
  },
});

export const api = createORPCClient(link) as ContractRouterClient<typeof contract>;
