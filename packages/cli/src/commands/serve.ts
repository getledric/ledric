import { defineCommand } from 'citty';
import { Core, FsTransformCache } from '@ledric/core';
import { openSqlite } from '@ledric/storage';
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
    },
    'http-mcp': {
      type: 'boolean',
      description:
        'Mount the Streamable HTTP MCP transport at /mcp for local clients (Claude Code, Cursor, mcp-remote). Bearer-key auth only. Binds 127.0.0.1 by default. Implies --http.',
      default: false
    },
    'public-mcp': {
      type: 'boolean',
      description:
        'Expose this ledric on the public internet so claude.ai custom connectors can reach it. Implies --http-mcp. Mounts the OAuth provider, accepts OAuth bearers on /mcp, requires publicUrl, and defaults the bind to 0.0.0.0.',
      default: false
    },
    'trust-proxy': {
      type: 'boolean',
      description:
        'Trust X-Forwarded-* headers from a reverse proxy. Required when fronted by nginx/Caddy/Cloudflare/etc. so req.ip reflects the originating client (without this, mcp.allowedCidrs allowlists silently fail). Implied by --public.',
      default: false
    },
    public: {
      type: 'boolean',
      description:
        'Hardened public-internet preset. Implies --public-mcp + --require-reader-key + --http-host 0.0.0.0 + --trust-proxy. Refuses to start without LEDRIC_ADMIN_KEY (no first-boot auto-mint) and without publicUrl. Adds rate limiting, security headers, CORS auto-derived from publicUrl, and brute-force protection on the /rpc auth path. The "safe to point a domain at" mode.',
      default: false
    }
  },
  async run({ args }) {
    const cfg = loadConfig();
    const dbPath = resolveDb(args.db);
    const httpPortStr =
      args['http-port'] ?? (cfg.http?.port !== undefined ? String(cfg.http.port) : '3000');
    const assetsBackend = args['assets-backend'] ?? cfg.assets?.backend;
    const assetsRoot = args['assets-root'] ?? cfg.assets?.path;
    // --public is the "safe to expose to the internet" preset. It
    // bundles together every other flag the operator would otherwise
    // have to remember, plus a few first-boot refusals that prevent
    // common shoot-yourself scenarios on a fresh public deployment.
    const publicMode = args.public === true || cfg.mode === 'public';

    const requireReaderKey =
      publicMode ||
      args['require-reader-key'] === true ||
      cfg.auth?.requireReaderKey === true;
    const wantGui = args.gui === true || cfg.gui?.enabled === true;
    const publicMcp =
      publicMode || args['public-mcp'] === true || cfg.mcp?.public === true;
    // public implies http; otherwise honor each independently.
    const httpMcp =
      publicMcp || args['http-mcp'] === true || cfg.mcp?.http === true;
    const wantHttp = args.http === true || wantGui || httpMcp;
    const trustProxy =
      publicMode ||
      args['trust-proxy'] === true ||
      cfg.http?.trustProxy === true;
    // Public mode flips the default bind to 0.0.0.0; otherwise the
    // existing 127.0.0.1 default stands. Explicit --http-host always wins.
    const httpHostDefault = publicMcp ? '0.0.0.0' : '127.0.0.1';
    const httpHost = args['http-host'] ?? cfg.http?.host ?? httpHostDefault;

    const assetsConfig = assetsConfigFromArgs({
      'assets-backend': assetsBackend,
      'assets-root': assetsRoot
    });
    const storage = await openSqlite({
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
    // We know the HTTP URL before runHttp boots (port + host are
    // already resolved); compute it eagerly so Core.describeModel can
    // surface http_base to MCP clients without a follow-up update.
    const httpBase = wantHttp ? `http://${httpHost}:${httpPortStr}` : undefined;
    const auth = wantHttp
      ? {
          read: requireReaderKey ? ('reader' as const) : ('open' as const),
          write: 'admin' as const,
          keys: ['admin', 'reader'] as const,
          header: 'Authorization: Bearer <key>'
        }
      : undefined;
    const core = new Core(storage, {
      ...(transformCache !== undefined ? { transformCache } : {}),
      ...(httpBase !== undefined ? { httpBase } : {}),
      ...(auth !== undefined ? { auth } : {})
    });

    // First-boot key generation. Only relevant when HTTP is on (stdio
    // MCP runs in-process and is implicitly trusted), but we mint keys
    // before the server boots so the auth middleware sees them.
    let httpServer: { url: string; close: () => Promise<void> } | null = null;
    if (wantHttp) {
      const envAdminKey = process.env.LEDRIC_ADMIN_KEY;
      const envReaderKey = process.env.LEDRIC_READER_KEY;

      // Public-mode boot refusal: never auto-mint. The print-once flow
      // is fine on a localhost dev box (operator sees stderr); on a
      // freshly provisioned public host, the printed key gets lost in
      // systemd journal noise and the operator has no recourse but to
      // wipe the DB and try again. Force them to set LEDRIC_ADMIN_KEY
      // up front, OR have an existing admin key already in the DB.
      if (publicMode) {
        const dbAdminKeys = await storage.countActiveApiKeys();
        if (envAdminKey === undefined && dbAdminKeys === 0) {
          process.stderr.write(
            'ledric --public: no admin key configured. Set LEDRIC_ADMIN_KEY in the environment OR mint one with `ledric keys add admin --raw` before starting in public mode. Auto-minting is disabled here on purpose — the print-once key is too easy to lose on a fresh public deployment.\n'
          );
          process.exit(2);
        }
      }

      const bootstrapped = publicMode
        ? null
        : await bootstrapApiKeysIfEmpty(
            storage,
            envAdminKey,
            envReaderKey,
            { mintReader: requireReaderKey }
          );
      if (bootstrapped !== null) printFirstBootKeys(bootstrapped);

      const guiMount = args['gui-mount'] ?? cfg.gui?.mount ?? '/admin';
      const guiOpts = wantGui
        ? {
            assetsPath: args['gui-path'] ?? guiAssetsPath,
            mountPath: guiMount
          }
        : undefined;
      // publicUrl is mandatory in public mode (it's the OAuth issuer
      // and the Origin allowlist anchor). In http-only mode it's
      // optional — fall back to the local bind URL purely so the
      // describe_model http_base advertisement stays accurate.
      const publicUrl = cfg.publicUrl;
      if (publicMcp && (publicUrl === undefined || publicUrl.length === 0)) {
        process.stderr.write(
          (publicMode ? 'ledric --public' : 'ledric: --public-mcp') +
            ' requires `publicUrl` to be set in ledric.config.json (it identifies this server as an OAuth issuer and anchors the Origin allowlist). See docs/remote-mcp.md.\n'
        );
        process.exit(2);
      }
      const mcpOpts = httpMcp
        ? {
            http: true as const,
            ...(publicMcp ? { public: true as const } : {}),
            ...(publicUrl !== undefined ? { publicUrl } : {}),
            ...(Array.isArray(cfg.mcp?.allowedOrigins)
              ? { allowedOrigins: cfg.mcp.allowedOrigins }
              : {}),
            ...(Array.isArray(cfg.mcp?.allowedCidrs)
              ? { allowedCidrs: cfg.mcp.allowedCidrs }
              : {})
          }
        : undefined;
      httpServer = await runHttp(core, {
        port: parseInt(httpPortStr, 10),
        host: httpHost,
        ...(trustProxy ? { trustProxy: true } : {}),
        ...(guiOpts !== undefined ? { gui: guiOpts } : {}),
        ...(mcpOpts !== undefined ? { mcp: mcpOpts } : {}),
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
