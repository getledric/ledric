import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Core } from '@ledric/core';
import { createMcpServer } from './server.js';

export async function runStdio(core: Core): Promise<void> {
  const server = createMcpServer(core);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
