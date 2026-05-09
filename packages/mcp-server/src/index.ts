export const PACKAGE_NAME = '@ledric/mcp-server';

export {
  createMcpServer,
  SERVER_NAME,
  SERVER_VERSION,
  SERVER_INSTRUCTIONS,
  entryToWireShape
} from './server.js';
export { runStdio } from './stdio.js';
export { createStreamableHttpHandle } from './streamable-http.js';
export type { StreamableHttpHandle } from './streamable-http.js';
