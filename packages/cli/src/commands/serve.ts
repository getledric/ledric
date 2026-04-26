import { defineCommand } from 'citty';
import { Core } from '@ledric/core';
import { SqliteStorage } from '@ledric/storage';
import type { AssetsConfig } from '@ledric/storage';
import { runStdio } from '@ledric/mcp-server';
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

export const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Start ledric. MCP stdio always on; HTTP and admin GUI optional.'
  },
  args: {
    db: {
      type: 'string',
      description: 'Path to the SQLite database file.',
      default: './ledric.db'
    },
    http: {
      type: 'boolean',
      description: 'Also start the HTTP API on --http-port / --http-host.',
      default: false
    },
    'http-port': {
      type: 'string',
      description: 'HTTP port (when --http or --gui is set).',
      default: '3000'
    },
    'http-host': {
      type: 'string',
      description: 'HTTP host.',
      default: '127.0.0.1'
    },
    gui: {
      type: 'boolean',
      description: 'Mount the @ledric/gui admin UI. Implies --http.',
      default: false
    },
    'gui-mount': {
      type: 'string',
      description: 'URL path the GUI is served from.',
      default: '/admin'
    },
    'gui-path': {
      type: 'string',
      description: 'Override the GUI assets directory (advanced).'
    },
    'assets-backend': {
      type: 'string',
      description: 'Asset backend: db (default) or local.'
    },
    'assets-root': {
      type: 'string',
      description: 'For the local backend: directory where bytes live.'
    }
  },
  async run({ args }) {
    const wantHttp = args.http === true || args.gui === true;

    const assetsConfig = assetsConfigFromArgs({
      'assets-backend': args['assets-backend'],
      'assets-root': args['assets-root']
    });
    const storage = await SqliteStorage.open({
      path: args.db,
      ...(assetsConfig !== undefined ? { assets: assetsConfig } : {})
    });
    const core = new Core(storage);

    let httpServer: { url: string; close: () => Promise<void> } | null = null;
    if (wantHttp) {
      const guiOpts =
        args.gui === true
          ? {
              assetsPath: args['gui-path'] ?? guiAssetsPath,
              mountPath: args['gui-mount'] ?? '/admin'
            }
          : undefined;
      httpServer = await runHttp(core, {
        port: parseInt(args['http-port'], 10),
        host: args['http-host'],
        ...(guiOpts !== undefined ? { gui: guiOpts } : {})
      });
      process.stderr.write(`ledric: HTTP server at ${httpServer.url}\n`);
      if (guiOpts !== undefined) {
        process.stderr.write(
          `       admin GUI at ${httpServer.url}${guiOpts.mountPath}\n`
        );
      }
    }

    process.stderr.write(`ledric: opened ${args.db}; MCP stdio server ready\n`);

    const shutdown = async (signal: string): Promise<void> => {
      process.stderr.write(`ledric: ${signal} received, shutting down\n`);
      try {
        if (httpServer !== null) await httpServer.close();
        await storage.close();
      } finally {
        process.exit(0);
      }
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await runStdio(core);
  }
});
