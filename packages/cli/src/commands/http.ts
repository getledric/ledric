import { defineCommand } from 'citty';
import { Core } from '@ledric/core';
import { SqliteStorage } from '@ledric/storage';
import type { AssetsConfig } from '@ledric/storage';
import { runHttp } from '@ledric/http-server';

function assetsConfigFromArgs(args: {
  'assets-backend'?: string;
  'assets-root'?: string;
}): AssetsConfig | undefined {
  if (args['assets-backend'] === 'local') {
    return { backend: 'local', root: args['assets-root'] ?? './ledric-assets' };
  }
  return undefined;
}

export const httpCommand = defineCommand({
  meta: {
    name: 'http',
    description: 'Start ledric as an HTTP server.'
  },
  args: {
    db: {
      type: 'string',
      description: 'Path to the SQLite database file.',
      default: './ledric.db'
    },
    port: {
      type: 'string',
      description: 'Port to listen on.',
      default: '3000'
    },
    host: {
      type: 'string',
      description: 'Host to bind.',
      default: '127.0.0.1'
    },
    'assets-backend': {
      type: 'string',
      description: 'Asset backend: db (default) or local.'
    },
    'assets-root': {
      type: 'string',
      description: 'For the local backend: directory where bytes are served from.'
    }
  },
  async run({ args }) {
    const assetsConfig = assetsConfigFromArgs({
      'assets-backend': args['assets-backend'],
      'assets-root': args['assets-root']
    });
    const storage = await SqliteStorage.open({
      path: args.db,
      ...(assetsConfig !== undefined ? { assets: assetsConfig } : {})
    });
    const core = new Core(storage);

    const { url, close } = await runHttp(core, {
      port: parseInt(args.port, 10),
      host: args.host
    });

    process.stderr.write(`ledric: opened ${args.db}; HTTP server listening at ${url}\n`);

    const shutdown = async (signal: string): Promise<void> => {
      process.stderr.write(`ledric: ${signal} received, shutting down\n`);
      try {
        await close();
      } finally {
        await storage.close();
        process.exit(0);
      }
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  }
});
