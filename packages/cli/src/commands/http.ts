import { defineCommand } from 'citty';
import { Core, FsTransformCache } from '@ledric/core';
import { openSqlite } from '@ledric/storage';
import type { AssetsConfig } from '@ledric/storage';
import { runHttp } from '@ledric/http-server';
import { guiAssetsPath } from '@ledric/gui';
import { bootstrapApiKeysIfEmpty, printFirstBootKeys } from './auth-bootstrap.js';
import { loadConfig, resolveDb } from '../config.js';

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
      description: 'Path to the SQLite database file. Defaults to ledric.config.json or ./ledric.db.'
    },
    port: {
      type: 'string',
      description: 'Port to listen on. Defaults to ledric.config.json or 3000.'
    },
    host: {
      type: 'string',
      description: 'Host to bind. Defaults to ledric.config.json or 127.0.0.1.'
    },
    'assets-backend': {
      type: 'string',
      description: 'Asset backend: db or local. Defaults to ledric.config.json or db.'
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
    },
    'require-reader-key': {
      type: 'boolean',
      description:
        'Require a reader key on every GET (closed-reads mode). Default: GETs are open and only writes need an admin key.',
      default: false
    }
  },
  async run({ args }) {
    const cfg = loadConfig();
    const dbPath = resolveDb(args.db);
    const portStr = args.port ?? (cfg.http?.port !== undefined ? String(cfg.http.port) : '3000');
    const host = args.host ?? cfg.http?.host ?? '127.0.0.1';
    const assetsBackend = args['assets-backend'] ?? cfg.assets?.backend;
    const assetsRoot = args['assets-root'] ?? cfg.assets?.path;
    const requireReaderKey =
      args['require-reader-key'] === true || cfg.auth?.requireReaderKey === true;

    const assetsConfig = assetsConfigFromArgs({
      'assets-backend': assetsBackend,
      'assets-root': assetsRoot
    });
    const storage = await openSqlite({
      path: dbPath,
      ...(assetsConfig !== undefined ? { assets: assetsConfig } : {})
    });

    // See note in serve.ts — citty's `--no-X` magic.
    const cacheArg = args['transforms-cache'] as string | boolean;
    const cacheDisabled =
      args['no-transforms-cache'] === true ||
      cacheArg === false ||
      cacheArg === 'false' ||
      cacheArg === 'off';
    const transformCache = cacheDisabled
      ? undefined
      : new FsTransformCache(typeof cacheArg === 'string' ? cacheArg : './ledric-transforms');
    // ledric http always exposes HTTP — surface http_base on
    // describe_model so any MCP client peering at this process knows
    // where the consumer plane is.
    const httpBase = `http://${host}:${portStr}`;
    const auth = {
      read: requireReaderKey ? ('reader' as const) : ('open' as const),
      write: 'admin' as const,
      keys: ['admin', 'reader'] as const,
      header: 'Authorization: Bearer <key>'
    };
    const core = new Core(storage, {
      ...(transformCache !== undefined ? { transformCache } : {}),
      httpBase,
      auth
    });

    const envAdminKey = process.env.LEDRIC_ADMIN_KEY;
    const envReaderKey = process.env.LEDRIC_READER_KEY;
    const bootstrapped = await bootstrapApiKeysIfEmpty(
      storage,
      envAdminKey,
      envReaderKey
    );
    if (bootstrapped !== null) printFirstBootKeys(bootstrapped);

    const guiOpts =
      args.gui === true
        ? {
            assetsPath: args['gui-path'] ?? guiAssetsPath,
            mountPath: args['gui-mount'] ?? '/admin'
          }
        : undefined;

    const { url, close } = await runHttp(core, {
      port: parseInt(portStr, 10),
      host,
      ...(guiOpts !== undefined ? { gui: guiOpts } : {}),
      auth: {
        storage,
        requireReaderKey,
        ...(envAdminKey !== undefined ? { envAdminKey } : {}),
        ...(envReaderKey !== undefined ? { envReaderKey } : {})
      }
    });

    process.stderr.write(`ledric: opened ${dbPath}; HTTP server listening at ${url}\n`);
    if (guiOpts !== undefined) {
      process.stderr.write(`       admin GUI at ${url}${guiOpts.mountPath}\n`);
    }
    if (transformCache !== undefined) {
      process.stderr.write(
        `       transform cache at ${typeof cacheArg === 'string' ? cacheArg : './ledric-transforms'}\n`
      );
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
