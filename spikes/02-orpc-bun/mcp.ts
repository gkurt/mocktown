/**
 * The MCP server, generated from the same contract walk as the CLI. Adding a
 * procedure gives agents a new tool with no extra work — the third surface promised
 * by 02-architecture.md's "one procedure definition, three surfaces".
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createORPCClient } from '@orpc/client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { contract } from './contract.ts';
import { walkContract } from './walk.ts';

export function buildMcpServer(baseUrl: string, headers?: () => Record<string, string>) {
  const client: any = createORPCClient(new OpenAPILink(contract, { url: baseUrl, headers }));
  const server = new McpServer({ name: 'mocktown', version: '0.0.0-spike' });

  for (const proc of walkContract(contract)) {
    const toolName = proc.path.join('_'); // services.list -> services_list
    const shape = (proc.inputSchema as any)?._zod?.def?.shape; // MCP takes a Zod raw shape

    server.registerTool(
      toolName,
      {
        description: proc.summary,
        inputSchema: shape,
        annotations: {
          // GET procedures are safe to call speculatively; PUT/POST are not.
          readOnlyHint: proc.method === 'GET',
        },
      },
      async (input: any) => {
        const call = proc.path.reduce<any>((node, key) => node[key], client);
        const result = await call(input);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      },
    );
  }
  return server;
}
