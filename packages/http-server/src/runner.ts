import type { Core } from '@ledric/core';
import { createHttpServer } from './server.js';
import type { HttpAuthOptions } from './server.js';

export interface RunHttpOptions {
  port?: number;
  host?: string;
  logger?: boolean;
  gui?: { assetsPath: string; mountPath?: string };
  uploadLimitBytes?: number;
  auth?: HttpAuthOptions;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export async function runHttp(core: Core, opts: RunHttpOptions = {}): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const port = opts.port ?? 3000;
  const host = opts.host ?? '127.0.0.1';

  if (opts.gui !== undefined && !LOOPBACK_HOSTS.has(host)) {
    process.stderr.write(
      [
        '',
        '╭──────────────────────────────────────────────────────────────────────╮',
        '│  ⚠  ledric admin GUI is enabled and bound to a non-loopback host.   │',
        '│     Authentication is not implemented yet — anyone who can reach    │',
        `│     ${host.padEnd(63, ' ')}│`,
        '│     can read AND mutate every entry, type, and asset.               │',
        '│     Bind to 127.0.0.1 unless you know what you\'re doing.            │',
        '╰──────────────────────────────────────────────────────────────────────╯',
        ''
      ].join('\n')
    );
  }

  const serverOpts: Parameters<typeof createHttpServer>[1] = {
    logger: opts.logger ?? false
  };
  if (opts.gui !== undefined) serverOpts.gui = opts.gui;
  if (opts.uploadLimitBytes !== undefined) serverOpts.uploadLimitBytes = opts.uploadLimitBytes;
  if (opts.auth !== undefined) serverOpts.auth = opts.auth;
  const app = createHttpServer(core, serverOpts);

  // fastify.listen() returns the actual bound URL — important when port is 0
  // (OS-assigned), which the SDK tests rely on.
  const url = await app.listen({ port, host });
  return {
    url,
    close: async () => {
      await app.close();
    }
  };
}
