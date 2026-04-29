import { defineCommand } from 'citty';
import { Core, FsTransformCache } from '@ledric/core';
import { SqliteStorage } from '@ledric/storage';
import type { AssetsConfig } from '@ledric/storage';
import { runHttp } from '@ledric/http-server';
import { guiAssetsPath } from '@ledric/gui';

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
    },
    gui: {
      type: 'boolean',
      description: 'Mount the @ledric/gui admin UI at the gui-mount path.',
      default: false
    },
    'gui-mount': {
      type: 'string',
      description: 'URL path the GUI is served from when --gui is set.',
      default: '/admin'
    },
    'gui-path': {
      type: 'string',
      description: 'Override the GUI assets directory (advanced; defaults to @ledric/gui).'
    },
    'transforms-cache': {
      type: 'string',
      description: 'Directory for cached on-the-fly image transforms.',
      default: './ledric-transforms'
    },
    'no-transforms-cache': {
      type: 'boolean',
      description: 'Disable the transform cache (recompute every request).',
      default: false
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

    const transformCache =
      args['no-transforms-cache'] === true
        ? undefined
        : new FsTransformCache(args['transforms-cache']);
    const core = new Core(
      storage,
      transformCache !== undefined ? { transformCache } : {}
    );

    const guiOpts =
      args.gui === true
        ? {
            assetsPath: args['gui-path'] ?? guiAssetsPath,
            mountPath: args['gui-mount'] ?? '/admin'
          }
        : undefined;

    const { url, close } = await runHttp(core, {
      port: parseInt(args.port, 10),
      host: args.host,
      ...(guiOpts !== undefined ? { gui: guiOpts } : {})
    });

    process.stderr.write(`ledric: opened ${args.db}; HTTP server listening at ${url}\n`);
    if (guiOpts !== undefined) {
      process.stderr.write(`       admin GUI at ${url}${guiOpts.mountPath}\n`);
    }
    if (transformCache !== undefined) {
      process.stderr.write(`       transform cache at ${args['transforms-cache']}\n`);
    }

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
