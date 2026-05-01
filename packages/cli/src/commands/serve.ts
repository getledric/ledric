import { defineCommand } from 'citty';
import { Core, FsTransformCache } from '@ledric/core';
import { SqliteStorage } from '@ledric/storage';
import type { AssetsConfig } from '@ledric/storage';
import { runStdio } from '@ledric/mcp-server';
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

export const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Start ledric. MCP stdio always on; HTTP and admin GUI optional.'
  },
  args: {
    db: {
      type: 'string',
      description: 'Path to the SQLite database file. Defaults to ledric.config.json or ./ledric.db.'
    },
    http: {
      type: 'boolean',
      description: 'Also start the HTTP API on --http-port / --http-host.',
      default: false
    },
    'http-port': {
      type: 'string',
      description: 'HTTP port (when --http or --gui is set). Defaults to ledric.config.json or 3000.'
    },
    'http-host': {
      type: 'string',
      description: 'HTTP host. Defaults to ledric.config.json or 127.0.0.1.'
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
      description: 'Asset backend: db or local. Defaults to ledric.config.json or db.'
    },
    'assets-root': {
      type: 'string',
      description: 'For the local backend: directory where bytes live.'
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
    const httpPortStr =
      args['http-port'] ?? (cfg.http?.port !== undefined ? String(cfg.http.port) : '3000');
    const httpHost = args['http-host'] ?? cfg.http?.host ?? '127.0.0.1';
    const assetsBackend = args['assets-backend'] ?? cfg.assets?.backend;
    const assetsRoot = args['assets-root'] ?? cfg.assets?.path;
    const requireReaderKey =
      args['require-reader-key'] === true || cfg.auth?.requireReaderKey === true;
    const wantGui = args.gui === true || cfg.gui?.enabled === true;
    const wantHttp = args.http === true || wantGui;

    const assetsConfig = assetsConfigFromArgs({
      'assets-backend': assetsBackend,
      'assets-root': assetsRoot
    });
    const storage = await SqliteStorage.open({
      path: dbPath,
      ...(assetsConfig !== undefined ? { assets: assetsConfig } : {})
    });

    // citty's `--no-foo` magic flips `args['foo']` to `false` for any
    // string flag. We accept either path: a plaintext "false" / "off",
    // or an explicit --no-transforms-cache flag.
    const cacheArg = args['transforms-cache'] as string | boolean;
    const cacheDisabled =
      args['no-transforms-cache'] === true ||
      cacheArg === false ||
      cacheArg === 'false' ||
      cacheArg === 'off';
    const transformCache = cacheDisabled
      ? undefined
      : new FsTransformCache(typeof cacheArg === 'string' ? cacheArg : './ledric-transforms');
    const core = new Core(
      storage,
      transformCache !== undefined ? { transformCache } : {}
    );

    // First-boot key generation. Only relevant when HTTP is on (stdio
    // MCP runs in-process and is implicitly trusted), but we mint keys
    // before the server boots so the auth middleware sees them.
    let httpServer: { url: string; close: () => Promise<void> } | null = null;
    if (wantHttp) {
      const envAdminKey = process.env.LEDRIC_ADMIN_KEY;
      const envReaderKey = process.env.LEDRIC_READER_KEY;
      const bootstrapped = await bootstrapApiKeysIfEmpty(
        storage,
        envAdminKey,
        envReaderKey
      );
      if (bootstrapped !== null) printFirstBootKeys(bootstrapped);

      const guiMount = args['gui-mount'] ?? cfg.gui?.mount ?? '/admin';
      const guiOpts = wantGui
        ? {
            assetsPath: args['gui-path'] ?? guiAssetsPath,
            mountPath: guiMount
          }
        : undefined;
      httpServer = await runHttp(core, {
        port: parseInt(httpPortStr, 10),
        host: httpHost,
        ...(guiOpts !== undefined ? { gui: guiOpts } : {}),
        auth: {
          storage,
          requireReaderKey,
          ...(envAdminKey !== undefined ? { envAdminKey } : {}),
          ...(envReaderKey !== undefined ? { envReaderKey } : {})
        }
      });
      process.stderr.write(`ledric: HTTP server at ${httpServer.url}\n`);
      if (guiOpts !== undefined) {
        process.stderr.write(
          `       admin GUI at ${httpServer.url}${guiOpts.mountPath}\n`
        );
      }
    }

    if (transformCache !== undefined) {
      process.stderr.write(
        `       transform cache at ${typeof cacheArg === 'string' ? cacheArg : './ledric-transforms'}\n`
      );
    }

    process.stderr.write(`ledric: opened ${dbPath}; MCP stdio server ready\n`);

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
