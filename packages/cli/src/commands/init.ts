import { defineCommand } from 'citty';
import * as p from '@clack/prompts';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { openSqlite } from '@ledric/storage';
import { bootstrapApiKeysIfEmpty } from './auth-bootstrap.js';
import { configPath, type LedricConfig } from '../config.js';

export interface InitAnswers {
  db: string;
  port: number;
  host: string;
  assetsBackend: 'db' | 'local';
  assetsPath: string | null;
  configureClaudeCode: boolean;
  configureClaudeDesktop: boolean;
  mintKeys: boolean;
  updateGitignore: boolean;
  scaffoldProxy: boolean;
  /** Mount /mcp on Streamable HTTP for local clients. Default Y. */
  enableHttpMcp: boolean;
  /** Expose to claude.ai over the public internet. Default N. Implies enableHttpMcp. */
  enablePublicMcp: boolean;
  /** Required when enablePublicMcp is true; null otherwise. */
  publicUrl: string | null;
}

export const DEFAULTS: InitAnswers = {
  db: './ledric.db',
  port: 3000,
  host: '127.0.0.1',
  assetsBackend: 'db',
  assetsPath: null,
  configureClaudeCode: true,
  configureClaudeDesktop: false,
  mintKeys: true,
  updateGitignore: true,
  scaffoldProxy: true,
  enableHttpMcp: true,
  enablePublicMcp: false,
  publicUrl: null
};

// Version pin for the @ledric/proxy dep we add to a consumer's
// package.json. Kept in lockstep with the CLI's own version — bump on
// each release that ships a proxy change.
export const PROXY_DEP_VERSION = '^0.3.2';

const LEDRIC_GITIGNORE_LINES: readonly string[] = [
  '# ledric',
  'ledric.db',
  'ledric.db-journal',
  'ledric.db-wal',
  'ledric.db-shm',
  'ledric-assets/',
  'ledric-transforms/',
  '.env.local'
];

// ───────────────────────────── pure helpers ─────────────────────────────

export function buildConfig(a: InitAnswers): LedricConfig {
  const cfg: LedricConfig = {
    db: a.db,
    http: { port: a.port, host: a.host },
    assets: { backend: a.assetsBackend }
  };
  if (a.assetsBackend === 'local' && a.assetsPath !== null && cfg.assets) {
    cfg.assets.path = a.assetsPath;
  }
  if (a.enablePublicMcp) {
    cfg.mcp = { http: true, public: true };
    if (a.publicUrl !== null && a.publicUrl.length > 0) {
      cfg.publicUrl = a.publicUrl;
    }
  } else if (a.enableHttpMcp) {
    cfg.mcp = { http: true };
  }
  return cfg;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpJsonShape {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export function mergeMcpServers(
  existing: unknown,
  serverName: string,
  entry: McpServerEntry
): McpJsonShape {
  const base: McpJsonShape =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const servers: Record<string, McpServerEntry> =
    base.mcpServers !== undefined &&
    base.mcpServers !== null &&
    typeof base.mcpServers === 'object'
      ? { ...base.mcpServers }
      : {};
  servers[serverName] = entry;
  base.mcpServers = servers;
  return base;
}

export function patchGitignoreContent(
  existing: string,
  linesToAdd: readonly string[]
): string {
  const present = new Set(
    existing.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  );
  const additions = linesToAdd.filter((l) => !present.has(l.trim()));
  if (additions.length === 0) return existing;
  if (existing.length === 0) return additions.join('\n') + '\n';
  const trail = existing.endsWith('\n') ? '' : '\n';
  return existing + trail + '\n' + additions.join('\n') + '\n';
}

// ───────────────────────────── proxy scaffold ─────────────────────────────

export type Framework =
  | 'astro'
  | 'next-app'
  | 'next-pages'
  | 'sveltekit'
  | 'unsupported'
  | null;

export interface PackageJsonShape {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [k: string]: unknown;
}

/**
 * Detect the consumer's web framework from package.json deps.
 * `hasAppDir` distinguishes Next App Router from Pages Router (both
 * carry the `next` dep).
 *
 * Returns:
 *   - one of the supported framework keys when we can scaffold a route file,
 *   - `'unsupported'` for known frameworks that need manual wiring (Hono / Express / Fastify),
 *   - `null` when we can't make a guess.
 */
export function detectFramework(
  pkg: PackageJsonShape | null,
  hasAppDir: boolean = false
): Framework {
  if (pkg === null) return null;
  const deps: Record<string, string> = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.devDependencies ?? {})
  };
  if ('astro' in deps) return 'astro';
  if ('@sveltejs/kit' in deps) return 'sveltekit';
  if ('next' in deps) return hasAppDir ? 'next-app' : 'next-pages';
  if ('hono' in deps || 'express' in deps || 'fastify' in deps) return 'unsupported';
  return null;
}

export interface ProxyScaffold {
  /** Project-relative path the route file should land at. */
  routePath: string;
  /** Source code for the route file. */
  routeCode: string;
}

/**
 * Build the route file we'd write for a given framework. Returns null
 * for `'unsupported'` and `null` frameworks — caller should print the
 * @ledric/proxy README pointer instead.
 */
export function proxyScaffold(framework: Framework): ProxyScaffold | null {
  switch (framework) {
    case 'astro':
      return {
        routePath: 'src/pages/api/ledric/[...path].ts',
        routeCode: ASTRO_ROUTE_SOURCE
      };
    case 'next-app':
      return {
        routePath: 'app/api/ledric/[...path]/route.ts',
        routeCode: NEXT_APP_ROUTE_SOURCE
      };
    case 'next-pages':
      return {
        routePath: 'pages/api/ledric/[...path].ts',
        routeCode: NEXT_PAGES_ROUTE_SOURCE
      };
    case 'sveltekit':
      return {
        routePath: 'src/routes/ledric/[...path]/+server.ts',
        routeCode: SVELTEKIT_ROUTE_SOURCE
      };
    default:
      return null;
  }
}

/**
 * Add `@ledric/proxy` to the consumer's package.json dependencies if
 * not already present. Returns the modified shape (caller writes it).
 * Idempotent — leaves an existing pin untouched even if it differs
 * from `version`.
 */
export function addProxyDependency(
  pkg: PackageJsonShape,
  version: string = PROXY_DEP_VERSION
): { next: PackageJsonShape; changed: boolean } {
  const existingDeps = pkg.dependencies ?? {};
  const existingDev = pkg.devDependencies ?? {};
  if ('@ledric/proxy' in existingDeps || '@ledric/proxy' in existingDev) {
    return { next: pkg, changed: false };
  }
  const next: PackageJsonShape = {
    ...pkg,
    dependencies: { ...existingDeps, '@ledric/proxy': version }
  };
  return { next, changed: true };
}

const ASTRO_ROUTE_SOURCE = `// Generated by \`ledric init\` — server-side proxy for ledric.
// The browser never talks to ledric directly: requests are forwarded
// through this route with a server-held reader key. Edit baseUrl /
// readerKey via .env.local — never inline secrets here.
import type { APIRoute } from 'astro';
import { createLedricProxy } from '@ledric/proxy';

const proxy = createLedricProxy({
  baseUrl: import.meta.env.LEDRIC_URL,
  readerKey: import.meta.env.LEDRIC_READER_KEY
});

export const ALL: APIRoute = ({ request, params }) => {
  const segs = Array.isArray(params.path)
    ? params.path
    : params.path
      ? [params.path]
      : [];
  return proxy.handler(request, '/' + segs.filter(Boolean).join('/'));
};
`;

const NEXT_APP_ROUTE_SOURCE = `// Generated by \`ledric init\` — server-side proxy for ledric.
// The browser never talks to ledric directly: requests are forwarded
// through this route with a server-held reader key. Edit baseUrl /
// readerKey via your env (.env.local in dev) — never inline secrets.
import { createLedricProxy } from '@ledric/proxy';

const proxy = createLedricProxy({
  baseUrl: process.env.LEDRIC_URL!,
  readerKey: process.env.LEDRIC_READER_KEY
});

const handler = async (
  req: Request,
  ctx: { params: Promise<{ path: string[] }> }
) => {
  const { path } = await ctx.params;
  return proxy.handler(req, '/' + (path ?? []).join('/'));
};

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
`;

const NEXT_PAGES_ROUTE_SOURCE = `// Generated by \`ledric init\` — server-side proxy for ledric.
// Bridges Next's Node IncomingMessage/ServerResponse to a fetch-API
// Request/Response so @ledric/proxy can do its thing. Reader key stays
// server-side via process.env.
import type { NextApiRequest, NextApiResponse } from 'next';
import { createLedricProxy } from '@ledric/proxy';

export const config = { api: { bodyParser: false } };

const proxy = createLedricProxy({
  baseUrl: process.env.LEDRIC_URL!,
  readerKey: process.env.LEDRIC_READER_KEY
});

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const url = new URL(req.url ?? '', \`http://\${req.headers.host}\`);
  const path = url.pathname.replace(/^\\/api\\/ledric/, '') || '/';
  const init: RequestInit = {
    method: req.method,
    headers: req.headers as HeadersInit
  };
  if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
    (init as { body?: unknown; duplex?: 'half' }).body = req as unknown as ReadableStream;
    (init as { duplex?: 'half' }).duplex = 'half';
  }
  const out = await proxy.handler(new Request(url, init), path);
  res.status(out.status);
  out.headers.forEach((v, k) => res.setHeader(k, v));
  if (out.body) {
    const reader = out.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}
`;

const SVELTEKIT_ROUTE_SOURCE = `// Generated by \`ledric init\` — server-side proxy for ledric.
// The browser never talks to ledric directly: requests are forwarded
// through this route with a server-held reader key. Edit baseUrl /
// readerKey via your env (\`.env.local\` in dev).
import type { RequestHandler } from './$types';
import { createLedricProxy } from '@ledric/proxy';
import { env } from '$env/dynamic/private';

const proxy = createLedricProxy({
  baseUrl: env.LEDRIC_URL,
  readerKey: env.LEDRIC_READER_KEY
});

const handler: RequestHandler = ({ request, params }) =>
  proxy.handler(request, '/' + (params.path ?? ''));

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
export const HEAD = handler;
`;

export function claudeDesktopConfigPath(
  plat: NodeJS.Platform = platform(),
  home: string = homedir(),
  appData: string | undefined = process.env.APPDATA
): string | null {
  if (plat === 'darwin') {
    return join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  }
  if (plat === 'win32') {
    if (appData === undefined || appData.length === 0) return null;
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (plat === 'linux') {
    return join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
  return null;
}

// ───────────────────────────── i/o wrappers ─────────────────────────────

function readJsonOrNull(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function ledricMcpEntry(cwd: string): McpServerEntry {
  // Default to `serve --gui` so the spawned process gives the agent
  // both MCP stdio (for tool calls) AND the HTTP API + admin GUI (for
  // testing consumer-side reads, browsing /admin). Without --gui the
  // agent has to start a second process via Bash whenever it wants to
  // curl an endpoint, which is wasteful and confusing. Port comes from
  // ledric.config.json so the user's chosen port carries through.
  return {
    command: 'npx',
    args: ['-y', 'ledric', 'serve', '--gui'],
    cwd
  };
}

// ───────────────────────────── interactive prompts ─────────────────────────────

async function runPrompts(framework: Framework): Promise<InitAnswers> {
  const responses = await p.group(
    {
      db: () =>
        p.text({
          message: 'Path to the SQLite database file',
          placeholder: './ledric.db',
          defaultValue: './ledric.db'
        }),
      port: () =>
        p.text({
          message: 'HTTP port',
          placeholder: '3000',
          defaultValue: '3000',
          validate: (v) => {
            const n = parseInt(v, 10);
            if (!Number.isFinite(n) || n < 1 || n > 65535) {
              return 'must be a port number 1-65535';
            }
            return undefined;
          }
        }),
      host: () =>
        p.text({
          message: 'HTTP host',
          placeholder: '127.0.0.1',
          defaultValue: '127.0.0.1'
        }),
      assetsBackend: () =>
        p.select({
          message: 'Where should asset bytes live?',
          options: [
            {
              value: 'db' as const,
              label: 'In the database',
              hint: 'simple, one file to back up'
            },
            {
              value: 'local' as const,
              label: 'Local disk',
              hint: 'better for big media libraries'
            }
          ],
          initialValue: 'db' as const
        }),
      assetsPath: ({ results }) =>
        results.assetsBackend === 'local'
          ? p.text({
              message: 'Asset directory',
              placeholder: './ledric-assets',
              defaultValue: './ledric-assets'
            })
          : Promise.resolve(undefined),
      configureClaudeCode: () =>
        p.confirm({
          message: 'Configure Claude Code MCP (./.mcp.json) for this project?',
          initialValue: true
        }),
      configureClaudeDesktop: () =>
        p.confirm({
          message: 'Add to Claude Desktop globally?',
          initialValue: false
        }),
      mintKeys: () =>
        p.confirm({
          message: 'Mint admin + reader API keys now?',
          initialValue: true
        }),
      updateGitignore: () =>
        p.confirm({
          message: 'Update .gitignore with ledric files?',
          initialValue: true
        }),
      scaffoldProxy: () => {
        if (framework === null) return Promise.resolve(false);
        if (framework === 'unsupported') {
          p.log.info(
            'Detected Hono / Express / Fastify — see @ledric/proxy README for wiring (no scaffold written).'
          );
          return Promise.resolve(false);
        }
        return p.confirm({
          message: `Detected ${framework} — scaffold an @ledric/proxy route file?`,
          initialValue: true
        });
      },
      // Two MCP-mode questions, asked independently so the user thinks
      // about local-vs-public separately. The local case ships /mcp on
      // 127.0.0.1 with API-key auth; the public case adds the OAuth
      // provider and binds 0.0.0.0.
      enableHttpMcp: () =>
        p.confirm({
          message:
            'Enable HTTP MCP for local clients? (Lets multiple Claude Code / Cursor / Claude Desktop sessions share one ledric daemon over /mcp.)',
          initialValue: true
        }),
      enablePublicMcp: ({ results }) =>
        results.enableHttpMcp === false
          ? Promise.resolve(false)
          : p.confirm({
              message:
                'Make this instance reachable from claude.ai over the public internet? (Adds the OAuth provider; only do this if you actually need it.)',
              initialValue: false
            }),
      publicUrl: ({ results }) =>
        results.enablePublicMcp === true
          ? p.text({
              message: 'Public URL where this ledric will be reachable',
              placeholder: 'https://ledric.example.com',
              validate: (v) => {
                if (typeof v !== 'string' || v.length === 0) return 'required';
                try {
                  const u = new URL(v);
                  if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
                    return 'must be https (loopback http allowed for testing)';
                  }
                } catch {
                  return 'not a valid URL';
                }
                return undefined;
              }
            })
          : Promise.resolve(undefined)
    },
    {
      onCancel: () => {
        p.cancel('Cancelled.');
        process.exit(0);
      }
    }
  );

  return {
    db: typeof responses.db === 'string' ? responses.db : DEFAULTS.db,
    port:
      typeof responses.port === 'string'
        ? parseInt(responses.port, 10)
        : DEFAULTS.port,
    host: typeof responses.host === 'string' ? responses.host : DEFAULTS.host,
    assetsBackend: responses.assetsBackend ?? DEFAULTS.assetsBackend,
    assetsPath:
      typeof responses.assetsPath === 'string' ? responses.assetsPath : null,
    configureClaudeCode: responses.configureClaudeCode === true,
    configureClaudeDesktop: responses.configureClaudeDesktop === true,
    mintKeys: responses.mintKeys === true,
    updateGitignore: responses.updateGitignore === true,
    scaffoldProxy: responses.scaffoldProxy === true,
    enableHttpMcp: responses.enableHttpMcp === true || responses.enablePublicMcp === true,
    enablePublicMcp: responses.enablePublicMcp === true,
    publicUrl: typeof responses.publicUrl === 'string' ? responses.publicUrl : null
  };
}

// ───────────────────────────── the command ─────────────────────────────

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description:
      'Set up ledric in the current directory: write config, patch .mcp.json, optionally mint API keys.'
  },
  args: {
    yes: {
      type: 'boolean',
      description: 'Skip prompts and use defaults (non-interactive).',
      default: false
    },
    force: {
      type: 'boolean',
      description: 'Overwrite ledric.config.json if it already exists.',
      default: false
    },
    'require-reader-key': {
      type: 'boolean',
      description:
        'Mint a reader key alongside the admin key, for closed-reads deployments. Default: skip (the reader key only matters with --require-reader-key on serve / http; mint later via `ledric keys create --role reader`).',
      default: false
    }
  },
  async run({ args }) {
    p.intro('ledric init');

    const cwd = process.cwd();
    const consumerPkgPath = resolve(cwd, 'package.json');
    const consumerPkg = readJsonOrNull(consumerPkgPath) as PackageJsonShape | null;
    const hasAppDir = existsSync(resolve(cwd, 'app'));
    const framework = detectFramework(consumerPkg, hasAppDir);

    const answers = args.yes
      ? {
          ...DEFAULTS,
          // --yes only scaffolds when we'd succeed without prompting:
          // a known framework + a usable package.json to add the dep to.
          scaffoldProxy:
            consumerPkg !== null &&
            framework !== null &&
            framework !== 'unsupported'
        }
      : await runPrompts(framework);

    // 1. ledric.config.json
    const cfgPath = configPath(cwd);
    if (existsSync(cfgPath) && !args.force) {
      p.log.warn(
        `ledric.config.json already exists — skipped (use --force to overwrite).`
      );
    } else {
      writeJsonFile(cfgPath, buildConfig(answers));
      p.log.success(`Wrote ${cfgPath}`);
    }

    // 2. ./.mcp.json — Claude Code project-local
    if (answers.configureClaudeCode) {
      const mcpPath = resolve(cwd, '.mcp.json');
      const existing = readJsonOrNull(mcpPath);
      const merged = mergeMcpServers(existing, 'ledric', ledricMcpEntry(cwd));
      writeJsonFile(mcpPath, merged);
      p.log.success(`${existing === null ? 'Created' : 'Patched'} ${mcpPath}`);
    }

    // 3. Claude Desktop config (global)
    if (answers.configureClaudeDesktop) {
      const cdPath = claudeDesktopConfigPath();
      if (cdPath === null) {
        p.log.warn('Claude Desktop config path not detected on this OS — skipped.');
      } else {
        const existing = readJsonOrNull(cdPath);
        const merged = mergeMcpServers(existing, 'ledric', ledricMcpEntry(cwd));
        writeJsonFile(cdPath, merged);
        p.log.success(`${existing === null ? 'Created' : 'Patched'} ${cdPath}`);
      }
    }

    // 4. Mint API keys (and write .env.local)
    if (answers.mintKeys) {
      const storage = await openSqlite({ path: answers.db });
      try {
        const mintReader = args['require-reader-key'] === true;
        const keys = await bootstrapApiKeysIfEmpty(
          storage,
          undefined,
          undefined,
          { mintReader }
        );
        if (keys === null) {
          p.log.warn('Keys already exist in this DB — skipped minting.');
        } else {
          const noteBody = keys.readerSecret !== undefined
            ? `admin:  ${keys.adminSecret}\nreader: ${keys.readerSecret}`
            : `admin:  ${keys.adminSecret}`;
          p.note(noteBody, 'API key (save it — not shown again)');
          const envPath = resolve(cwd, '.env.local');
          const lines = [`LEDRIC_ADMIN_KEY=${keys.adminSecret}`];
          if (keys.readerSecret !== undefined) {
            lines.push(`LEDRIC_READER_KEY=${keys.readerSecret}`);
          }
          // The proxy scaffold reads LEDRIC_URL — add it when we know
          // we'll be writing a route that needs it.
          if (answers.scaffoldProxy) {
            lines.push(`LEDRIC_URL=http://${answers.host}:${answers.port}`);
          }
          writeFileSync(envPath, lines.join('\n') + '\n');
          p.log.success(`Wrote ${envPath}`);
        }
      } finally {
        await storage.close();
      }
    }

    // 5. .gitignore
    if (answers.updateGitignore) {
      const giPath = resolve(cwd, '.gitignore');
      const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
      const next = patchGitignoreContent(existing, LEDRIC_GITIGNORE_LINES);
      if (next !== existing) {
        writeFileSync(giPath, next);
        p.log.success(`Updated ${giPath}`);
      } else {
        p.log.info('.gitignore already covers ledric files.');
      }
    }

    // 6. @ledric/proxy scaffold (route file + package.json dep)
    if (answers.scaffoldProxy) {
      const scaffold = proxyScaffold(framework);
      if (scaffold === null || consumerPkg === null) {
        p.log.warn(
          'Skipped proxy scaffold — see @ledric/proxy README for manual wiring.'
        );
      } else {
        const routeAbs = resolve(cwd, scaffold.routePath);
        if (existsSync(routeAbs)) {
          p.log.warn(`${scaffold.routePath} already exists — left untouched.`);
        } else {
          mkdirSync(dirname(routeAbs), { recursive: true });
          writeFileSync(routeAbs, scaffold.routeCode);
          p.log.success(`Wrote ${scaffold.routePath}`);
        }
        const { next, changed } = addProxyDependency(consumerPkg);
        if (changed) {
          writeJsonFile(consumerPkgPath, next);
          p.log.success(
            `Added @ledric/proxy ${PROXY_DEP_VERSION} to package.json — run your package manager's install to fetch it.`
          );
        }
      }
    }

    p.outro(
      'Ready! Run `npx ledric serve` (stdio) or `npx ledric serve --gui` (HTTP + admin UI).'
    );
  }
});
