import type { Core } from '@ledric/core';
import { createHttpServer } from './server.js';

export interface RunHttpOptions {
  port?: number;
  host?: string;
  logger?: boolean;
}

export async function runHttp(core: Core, opts: RunHttpOptions = {}): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const port = opts.port ?? 3000;
  const host = opts.host ?? '127.0.0.1';
  const app = createHttpServer(core, { logger: opts.logger ?? false });
  await app.listen({ port, host });
  return {
    url: `http://${host}:${port}`,
    close: async () => {
      await app.close();
    }
  };
}
