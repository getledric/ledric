import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { promises as fs, readFileSync } from 'node:fs';
import { join as pathJoin, dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

// Read our own version once at module load. tsup bundles to
// `dist/index.js`; `../package.json` resolves to the shipped manifest.
const PKG_VERSION = (JSON.parse(
  readFileSync(
    resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf8'
  )
) as { version: string }).version;
import type { Core } from '@ledric/core';
import { parseTransformParams } from '@ledric/core';
import { createStreamableHttpHandle } from '@ledric/mcp-server';
import type { StreamableHttpHandle } from '@ledric/mcp-server';
import { SCOPE_TO_ROLE } from '@ledric/oauth';
import type { Storage, ApiKeyRole, LedricStorage } from '@ledric/storage';
import { hashApiKey, parseApiKeyRole, looksLikeApiKey } from '@ledric/storage';
import { mountOAuthRoutes, type AccessTokenVerifier } from './oauth-routes.js';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function parseRefKeyHex(s: string): Buffer | null {
  if (typeof s !== 'string' || !/^[0-9a-f]{32}$/i.test(s)) return null;
  return Buffer.from(s, 'hex');
}

/** Collapse `?tag=a&tag=b` (string | string[] | undefined) into a string[]. */
function collectTagParam(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
}

function toJsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}

function parseExpandAssets(raw: string | undefined): boolean | string[] | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Parse `?order=field:dir,field2:dir` into the `order: [{field, dir}]`
 * shape `core.find` accepts. Skips malformed entries silently rather
 * than failing the whole request — agents probing the syntax shouldn't
 * have a typo bring the route down. Empty input returns [].
 */
function parseOrderParam(raw: string | undefined): Array<{ field: string; dir: 'asc' | 'desc' }> {
  if (raw === undefined || raw === '') return [];
  const out: Array<{ field: string; dir: 'asc' | 'desc' }> = [];
  for (const chunk of raw.split(',')) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(':');
    let field: string;
    let dir: 'asc' | 'desc' = 'asc';
    if (colon === -1) {
      field = trimmed;
    } else {
      field = trimmed.slice(0, colon).trim();
      const d = trimmed.slice(colon + 1).trim().toLowerCase();
      if (d === 'desc') dir = 'desc';
      else if (d === 'asc' || d === '') dir = 'asc';
      else continue; // bogus dir → skip
    }
    if (field.length === 0) continue;
    out.push({ field, dir });
  }
  return out;
}

function injectBaseHref(html: string, basePath: string): string {
  const tag = `<base href="${basePath}">`;
  if (/<base\s/i.test(html)) {
    return html.replace(/<base\s[^>]*>/i, tag);
  }
  return html.replace(/<head[^>]*>/i, (m) => `${m}\n    ${tag}`);
}

function guessKindFromMime(mime: string | undefined): string {
  if (mime === undefined) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

export interface HttpAuthOptions {
  /** Storage handle for API-key lookups. Required when auth is wired. */
  storage: Storage;
  /**
   * When true, GET routes also require at least a reader key. Default
   * behavior is admin-protects-writes only — GETs stay open so single-
   * site setups don't have to ship a reader key to their renderer.
   */
  requireReaderKey?: boolean;
  /**
   * Optional plaintext admin key from an env var. Matched alongside
   * the DB-issued keys; useful for ops scenarios where you don't want
   * the secret living in the SQLite file.
   */
  envAdminKey?: string;
  /** Same idea, but for the reader role. */
  envReaderKey?: string;
}

export interface HttpServerOptions {
  logger?: boolean;
  /** CORS origin policy. Default: '*' (open). Set to false to disable CORS. */
  cors?: string | string[] | boolean;
  /**
   * Mount a static-served GUI alongside the API.
   * `assetsPath` is an absolute filesystem path to the directory of static
   * files (typically `@ledric/gui`'s `web/`). `mountPath` defaults to
   * `/admin` and must start with `/`.
   */
  gui?: { assetsPath: string; mountPath?: string };
  /** Maximum upload size in bytes for POST /assets. Default 25 MiB. */
  uploadLimitBytes?: number;
  /**
   * API-key auth configuration. When omitted, ALL routes are open.
   * When present, auth is enforced — but only once at least one
   * non-revoked DB key OR an env var key exists; until then the
   * middleware treats requests as anonymous (auth-off mode).
   */
  auth?: HttpAuthOptions;
  /**
   * Streamable HTTP MCP transport. Two modes, ordered by escalation:
   *
   * - `http: true` — mount `/mcp` (POST/GET/DELETE) on whatever bind
   *   address the HTTP server is configured for. API-key bearer only;
   *   per-tool auth mirrors `/rpc`. Origin allowlist tolerates
   *   localhost-on-any-port for dev tooling. The natural setup for
   *   multiple local clients (Claude Code, Cursor, Claude Desktop via
   *   `mcp-remote`) sharing one ledric daemon. No `publicUrl` required.
   *
   * - `public: true` (implies `http`) — additionally mounts the OAuth
   *   provider routes, accepts OAuth bearer tokens on `/mcp`, requires
   *   `publicUrl`, and rejects non-allowlist Origins (no localhost
   *   escape). The path you take when claude.ai or another cloud-hosted
   *   client needs to reach in over the public internet.
   *
   * `allowedCidrs` is an optional pre-auth IP filter applied before any
   * other check on `/mcp` (and `/oauth/*` when `public` is on). Empty
   * or unset = allow all. Document Anthropic's published cloud IP
   * ranges as the recommended production value but don't hardcode —
   * they change.
   */
  mcp?: {
    http?: boolean;
    public?: boolean;
    allowedOrigins?: readonly string[];
    publicUrl?: string;
    allowedCidrs?: readonly string[];
    /** OAuth: enable/disable DCR. Default: enabled. */
    dcr?: boolean;
    accessTokenTtlSeconds?: number;
    refreshTokenTtlSeconds?: number;
  };
}

export function createHttpServer(core: Core, opts: HttpServerOptions = {}): FastifyInstance {
  const uploadLimit = opts.uploadLimitBytes ?? 25 * 1024 * 1024;
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: uploadLimit
  });

  // Default 404 handler: return the same `{error: {code, message}}`
  // shape every other route uses. Without this, Fastify's default
  // `{message, error, statusCode}` shape would surface for any
  // unmatched URL — and an agent probing the API (`/v1/types`,
  // `/api/posts`, etc.) would see two different error envelopes
  // depending on whether it found a route or not.
  //
  // Skipped when the GUI is being mounted; that block sets its own
  // not-found handler with the same JSON-404 fall-through plus an
  // SPA-fallback for deep HTML routes.
  if (opts.gui === undefined) {
    app.setNotFoundHandler(async (req, reply) => {
      reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: `route ${req.url}` } });
    });
  }

  // Default error handler: same envelope shape on uncaught throws
  // so a 500 doesn't escape with Fastify's default schema either.
  app.setErrorHandler(async (err, req, reply) => {
    if (opts.logger) req.log.error(err);
    const e = err as Error & { statusCode?: number };
    const status = typeof e.statusCode === 'number' ? e.statusCode : 500;
    const message = typeof e.message === 'string' ? e.message : String(err);
    reply.code(status).send({
      error: {
        code: status === 500 ? 'INTERNAL' : 'ERROR',
        message
      }
    });
  });

  // Content-API ergonomics: CORS open by default so any frontend can read.
  const corsOption = opts.cors ?? '*';
  if (corsOption !== false) {
    app.register(cors, {
      origin: corsOption,
      methods: ['GET', 'POST', 'OPTIONS'],
      exposedHeaders: ['X-Ledric-Redirect', 'X-Ledric-Redirect-Locale']
    });
  }

  app.register(multipart, {
    limits: { fileSize: uploadLimit, files: 1 }
  });

  // application/x-www-form-urlencoded — needed by OAuth's /oauth/token,
  // /oauth/authorize POST, and /oauth/revoke per RFC 6749. Always
  // registered (cheap; no body still parses to {}).
  app.register(formbody);

  // Mode flags pulled up here so attachAuth and the /mcp mount can
  // both reference them. Validation (publicUrl required when public
  // is on) happens at the /mcp mount further down — early exit there
  // keeps the error message close to the route it concerns.
  const mcpHttpFlag = opts.mcp?.http === true || opts.mcp?.public === true;
  const mcpPublicFlag = opts.mcp?.public === true;

  // OAuth routes mount BEFORE the auth preHandler so its `verify` is
  // captured by the closure attachAuth holds. The mount itself is async
  // (Ed25519 key load), so it goes through Fastify's plugin system —
  // app.ready() awaits the registration.
  let oauthVerifier: AccessTokenVerifier | null = null;
  if (mcpPublicFlag) {
    if (opts.mcp?.publicUrl === undefined || opts.mcp.publicUrl.length === 0) {
      throw new Error(
        'public-MCP mode requires `mcp.publicUrl` to be set (this is the OAuth issuer and Origin allowlist anchor — see docs/remote-mcp.md).'
      );
    }
    const issuer = opts.mcp.publicUrl;
    app.register(async (instance) => {
      const { verify, close } = await mountOAuthRoutes(
        instance,
        opts.auth!.storage as LedricStorage,
        {
          issuer,
          ...(opts.mcp?.dcr !== undefined ? { dcr: opts.mcp.dcr } : {}),
          ...(opts.mcp?.accessTokenTtlSeconds !== undefined
            ? { accessTokenTtlSeconds: opts.mcp.accessTokenTtlSeconds }
            : {}),
          ...(opts.mcp?.refreshTokenTtlSeconds !== undefined
            ? { refreshTokenTtlSeconds: opts.mcp.refreshTokenTtlSeconds }
            : {})
        }
      );
      oauthVerifier = verify;
      instance.addHook('onClose', async () => close());
    });
  }

  if (opts.auth !== undefined) {
    attachAuth(
      app,
      opts.auth,
      opts.gui?.mountPath ?? null,
      mcpPublicFlag,
      opts.mcp?.publicUrl,
      () => oauthVerifier
    );
  }

  if (opts.gui !== undefined) {
    const mountPath = opts.gui.mountPath ?? '/admin';
    if (!mountPath.startsWith('/')) {
      throw new Error(`gui.mountPath must start with '/', got "${mountPath}"`);
    }
    const prefix = mountPath.endsWith('/') ? mountPath : `${mountPath}/`;
    const indexPath = pathJoin(opts.gui.assetsPath, 'index.html');

    // Explicit routes for the mount roots so we control index.html serving
    // and can inject <base href>. Without that, deep SPA paths like
    // /admin/types/blog_post/foo break relative imports (./app.js resolves
    // against the current URL, not the mount root).
    const serveIndex = async (_req: unknown, reply: import('fastify').FastifyReply) => {
      try {
        const raw = await fs.readFile(indexPath, 'utf-8');
        reply.code(200).type('text/html; charset=utf-8').send(injectBaseHref(raw, prefix));
      } catch (err) {
        reply.code(500).send({
          error: {
            code: 'INTERNAL',
            message: err instanceof Error ? err.message : String(err)
          }
        });
      }
    };
    app.get(mountPath, serveIndex);
    if (prefix !== mountPath) app.get(prefix, serveIndex);

    app.register(fastifyStatic, {
      root: opts.gui.assetsPath,
      prefix,
      decorateReply: false,
      // index.html is served by the routes above; let fastify-static fall
      // through (404) for directory roots so the SPA handler can pick up.
      index: false
    });

    // SPA fallback: any HTML navigation under the mount path that didn't
    // resolve to a real file (deep React Router route, nested refresh)
    // serves the same injected-base index. JSON / asset requests still
    // 404 normally so API errors stay surfaced.
    app.setNotFoundHandler(async (req, reply) => {
      const url = req.url.split('?', 1)[0] ?? req.url;
      const inMount = url === mountPath || url.startsWith(prefix);
      const accepts = String(req.headers.accept ?? '');
      const wantsHtml = accepts.includes('text/html');
      if (inMount && wantsHtml) {
        try {
          const raw = await fs.readFile(indexPath, 'utf-8');
          reply.code(200).type('text/html; charset=utf-8').send(injectBaseHref(raw, prefix));
          return;
        } catch {
          // fall through to default
        }
      }
      reply
        .code(404)
        .send({ error: { code: 'NOT_FOUND', message: `route ${req.url}` } });
    });
  }

  app.get('/auth/status', async () => {
    // Always public. The GUI hits this on load to decide whether to
    // show a key prompt; SDK consumers can detect "do I need a key?"
    // before issuing a real request that would 401.
    if (opts.auth === undefined) {
      return { required: false, reads_open: true };
    }
    const dbKeys = await opts.auth.storage.countActiveApiKeys();
    const envConfigured = Boolean(opts.auth.envAdminKey || opts.auth.envReaderKey);
    return {
      required: dbKeys > 0 || envConfigured,
      reads_open: opts.auth.requireReaderKey !== true
    };
  });

  app.get('/', async () => ({
    name: 'ledric',
    version: PKG_VERSION,
    endpoints: [
      'GET    /auth/status',
      'GET    /types',
      'GET    /types/:name',
      'GET    /entries/:type',
      'GET    /entries/:type/:slug',
      'GET    /assets',
      'POST   /assets             multipart upload',
      'GET    /assets/:key        bytes (with imgix-style transforms)',
      'GET    /assets/:key/meta',
      'GET    /tags',
      'POST   /rpc                { tool, args }',
      ...(mcpHttpFlag
        ? [
            'POST   /mcp                Streamable HTTP MCP (JSON-RPC)',
            'GET    /mcp                Streamable HTTP MCP (SSE stream)',
            'DELETE /mcp                terminate session'
          ]
        : []),
      ...(mcpPublicFlag
        ? [
            'GET    /.well-known/oauth-authorization-server',
            'GET    /.well-known/oauth-protected-resource',
            'GET    /.well-known/openid-configuration',
            'POST   /oauth/register     Dynamic Client Registration (RFC 7591)',
            'GET    /oauth/authorize    OAuth 2.1 auth-code start',
            'GET    /oauth/consent/:uid operator consent page',
            'POST   /oauth/consent/:uid submit consent (admin key)',
            'POST   /oauth/token        auth_code / refresh_token grants',
            'POST   /oauth/revoke       RFC 7009',
            'POST   /oauth/introspection',
            'GET    /oauth/jwks'
          ]
        : [])
    ],
    /**
     * Tool names accepted by POST /rpc — same surface as the MCP server
     * exposes over stdio. Inputs documented at GET /types and via the
     * MCP server's instructions string.
     */
    rpc_tools: [
      'describe_model',
      'create_type',
      'alter_type',
      'delete_type',
      'draft',
      'read',
      'find',
      'publish',
      'rename_entry',
      'delete_entry',
      'migrate_entries',
      'get_asset',
      'list_assets',
      'update_asset',
      'add_asset_tags',
      'remove_asset_tags',
      'add_entry_tags',
      'remove_entry_tags',
      'list_tags',
      'update_tag'
    ],
    /**
     * Quick pointers the consumer SDK / agent can use without round-
     * tripping describe_model. See SERVER_INSTRUCTIONS in the MCP
     * server for the full picture.
     */
    notes: {
      asset_transforms:
        'Asset URLs accept imgix-style params: w, h, fit (clip|crop), q, fm (jpg|png|webp|avif), auto=format, dpr. e.g. /assets/<id>?w=400&fm=webp.',
      ref_validation:
        'references field strings and :::ref{to=...}::: directives accept @version pinning ("type/slug@N"). Dangling refs surface as warnings on draft, errors on publish. read attaches a _warnings sidecar when stored content has unresolved refs.',
      sidecars:
        '_locale (localized values), _redirect (slug renames), _refs (resolved inline refs when resolve_refs=true), _warnings (validation issues on stored content). All keys starting with _ are reserved.',
      errors:
        'Failure responses use { error: { code, message, errors? } }. VALIDATION_FAILED carries errors[] with JSON-Pointer paths; VERSION_CONFLICT carries current_version + your_parent_version.'
    }
  }));

  app.get('/types', async () => toJsonSafe(await core.describeModel()));

  app.get<{ Params: { name: string } }>('/types/:name', async (req, reply) => {
    const full = await core.describeModel();
    const t = full.types[req.params.name];
    if (!t) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: `type "${req.params.name}"` } };
    }
    return toJsonSafe(t);
  });

  app.get<{
    Params: { type: string };
    Querystring: {
      limit?: string;
      offset?: string;
      locale?: string;
      expand_assets?: string;
      resolve_references?: string;
      resolve_refs?: string;
      include_private?: string;
      tag?: string | string[];
      q?: string;
      order?: string;
      published?: string;
      summary?: string;
    };
  }>('/entries/:type', async (req) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : undefined;
    const expandAssets = parseExpandAssets(req.query.expand_assets);
    const resolveReferences = parseExpandAssets(req.query.resolve_references);
    const resolveRefs = req.query.resolve_refs === '1' || req.query.resolve_refs === 'true';
    const includePrivate =
      req.query.include_private === '1' || req.query.include_private === 'true';
    const published = req.query.published === '1' || req.query.published === 'true';
    const summary = req.query.summary === '1' || req.query.summary === 'true';
    const tags = collectTagParam(req.query.tag);
    const q = typeof req.query.q === 'string' && req.query.q.length > 0 ? req.query.q : undefined;
    const order = parseOrderParam(req.query.order);
    const result = await core.find({
      type: req.params.type,
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(req.query.locale !== undefined ? { locale: req.query.locale } : {}),
      ...(expandAssets !== undefined ? { expand_assets: expandAssets } : {}),
      ...(resolveReferences !== undefined ? { resolve_references: resolveReferences } : {}),
      ...(resolveRefs ? { resolve_refs: true } : {}),
      ...(includePrivate ? { include_private: true } : {}),
      ...(published ? { published: true } : {}),
      ...(summary ? { summary: true } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      ...(q !== undefined ? { q } : {}),
      ...(order.length > 0 ? { order } : {})
    });
    return toJsonSafe({
      total: result.total,
      offset: result.offset,
      results: result.results.map((r) => ({
        id: toHex(r.id),
        type: r.type,
        slug: r.slug,
        version: r.current_version,
        published_version: r.published_version,
        fields: r.content,
        tags: r.tags,
        ...(r._refs !== undefined ? { _refs: r._refs } : {})
      }))
    });
  });

  app.get<{
    Params: { type: string; slug: string };
    Querystring: {
      version?: string;
      locale?: string;
      expand_assets?: string;
      resolve_references?: string;
      resolve_refs?: string;
      include_private?: string;
    };
  }>('/entries/:type/:slug', async (req, reply) => {
    const versionNum = req.query.version ? parseInt(req.query.version, 10) : undefined;
    const localeArg = req.query.locale;
    const expandAssets = parseExpandAssets(req.query.expand_assets);
    const resolveReferences = parseExpandAssets(req.query.resolve_references);
    const resolveRefs = req.query.resolve_refs === '1' || req.query.resolve_refs === 'true';
    const includePrivate =
      req.query.include_private === '1' || req.query.include_private === 'true';
    const entry = await core.read({
      ref: { type: req.params.type, slug: req.params.slug },
      ...(versionNum !== undefined ? { version: versionNum } : {}),
      ...(localeArg !== undefined ? { locale: localeArg } : {}),
      ...(expandAssets !== undefined ? { expand_assets: expandAssets } : {}),
      ...(resolveReferences !== undefined ? { resolve_references: resolveReferences } : {}),
      ...(resolveRefs ? { resolve_refs: true } : {}),
      ...(includePrivate ? { include_private: true } : {})
    });
    if (!entry) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: `${req.params.type}/${req.params.slug}` } };
    }
    if (entry._redirect !== undefined) {
      const params = new URLSearchParams();
      if (versionNum !== undefined) params.set('version', String(versionNum));
      if (localeArg !== undefined) params.set('locale', localeArg);
      const qs = params.toString() ? `?${params.toString()}` : '';
      reply.code(301);
      reply.header('Location', `/entries/${entry.type}/${entry._redirect.to}${qs}`);
      reply.header('X-Ledric-Redirect', entry._redirect.to);
      if (entry._redirect.locale !== undefined) {
        reply.header('X-Ledric-Redirect-Locale', entry._redirect.locale);
      }
      return reply.send();
    }
    return {
      id: toHex(entry.id),
      type: entry.type,
      slug: entry.slug,
      version: entry.version,
      ...(localeArg !== undefined ? { locale: localeArg } : {}),
      fields: entry.content,
      ...(entry._refs !== undefined ? { _refs: entry._refs } : {}),
      ...(entry._warnings !== undefined ? { _warnings: entry._warnings } : {})
    };
  });

  app.get<{
    Querystring: { kind?: string; limit?: string; offset?: string; tag?: string | string[] };
  }>('/assets', async (req) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : undefined;
    const tags = collectTagParam(req.query.tag);
    const result = await core.listAssets({
      ...(req.query.kind !== undefined ? { kind: req.query.kind } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(tags.length > 0 ? { tags } : {})
    });
    return toJsonSafe({
      total: result.total,
      offset: result.offset,
      results: result.results.map((r) => {
        const refKeyHex = toHex(r.ref_key);
        return {
          id: toHex(r.id),
          ref_key: refKeyHex,
          kind: r.kind,
          version: r.current_version,
          storage_ref: r.storage_ref,
          meta: r.meta,
          url: `/assets/${refKeyHex}`,
          tags: r.tags
        };
      })
    });
  });

  // Combined tag list: assets and entries together with separate counts.
  // Single endpoint matches the `list_tags` MCP tool surface.
  app.get('/tags', async () => toJsonSafe(await core.listTags()));

  app.post('/assets', async (req, reply) => {
    if (!req.isMultipart()) {
      reply.code(400);
      return { error: { code: 'INVALID_REQUEST', message: 'expected multipart/form-data' } };
    }

    let bytes: Buffer | null = null;
    let mime: string | undefined;
    let filename: string | undefined;
    let kindOverride: string | undefined;
    let altOverride: string | undefined;
    const tags: string[] = [];

    for await (const part of req.parts()) {
      if (part.type === 'file' && part.fieldname === 'file') {
        bytes = await part.toBuffer();
        mime = part.mimetype;
        filename = part.filename;
      } else if (part.type === 'field') {
        const value = typeof part.value === 'string' ? part.value : String(part.value);
        if (part.fieldname === 'kind') kindOverride = value;
        else if (part.fieldname === 'alt') altOverride = value;
        else if (part.fieldname === 'mime') mime = value;
        // Accept `tag` (single) or `tags` (single field with comma-separated, or repeated).
        else if (part.fieldname === 'tag' || part.fieldname === 'tags') {
          for (const t of value.split(',')) {
            const trimmed = t.trim();
            if (trimmed.length > 0) tags.push(trimmed);
          }
        }
      }
    }

    if (bytes === null || bytes.byteLength === 0) {
      reply.code(400);
      return { error: { code: 'INVALID_REQUEST', message: 'missing "file" part' } };
    }

    const kind = kindOverride ?? guessKindFromMime(mime);

    try {
      const written = await core.uploadAsset({
        kind,
        bytes,
        meta: {
          ...(mime !== undefined ? { mime } : {}),
          ...(filename !== undefined ? { filename } : {}),
          ...(altOverride !== undefined ? { alt: altOverride } : {})
        },
        ...(tags.length > 0 ? { tags } : {})
      });
      const idHex = Buffer.from(written.id).toString('hex');
      const refKeyHex = Buffer.from(written.ref_key).toString('hex');
      reply.code(201);
      return {
        id: idHex,
        version: written.version,
        kind: written.kind,
        storage_ref: written.storage_ref,
        meta: written.meta,
        ref_key: refKeyHex,
        url: `/assets/${refKeyHex}`
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(400);
      return { error: { code: 'UPLOAD_FAILED', message } };
    }
  });

  // Canonical asset URLs are keyed by ref_key — a per-version opaque id
  // minted at upload/replace time. The asset id (UUIDv7) lives in entry
  // content as a stable handle; the ref_key lives in the URL so bytes
  // are version-pinned and `Cache-Control: immutable` is always sound.

  // The `/meta` lookup accepts either a ref_key (per-version URL key)
  // or an asset id (stable handle in entry content). Convenient for
  // admin tools that have one or the other. The bytes route below
  // stays strict — ref_key only — so URLs are always version-pinned.
  app.get<{ Params: { key: string } }>(
    '/assets/:key/meta',
    async (req, reply) => {
      if (parseRefKeyHex(req.params.key) === null) {
        reply.code(400);
        return { error: { code: 'INVALID_REQUEST', message: 'expected 32-char hex key' } };
      }
      let asset = await core.findAssetByRefKey(req.params.key);
      if (!asset) {
        // Fall back to id-keyed lookup so consumers holding the stable
        // asset id (from entry content) can still hit this endpoint.
        try {
          asset = await core.getAsset({ id: req.params.key });
        } catch {
          asset = null;
        }
      }
      if (!asset) {
        reply.code(404);
        return { error: { code: 'NOT_FOUND', message: `asset ${req.params.key}` } };
      }
      const refKeyHex = toHex(asset.ref_key);
      return {
        id: toHex(asset.id),
        ref_key: refKeyHex,
        kind: asset.kind,
        version: asset.version,
        current_version: asset.current_version,
        published_version: asset.published_version,
        storage_ref: asset.storage_ref,
        meta: asset.meta,
        url: `/assets/${refKeyHex}`
      };
    }
  );

  app.get<{
    Params: { ref_key: string };
    Querystring: Record<string, string | undefined>;
  }>('/assets/:ref_key', async (req, reply) => {
    const refKeyBuf = parseRefKeyHex(req.params.ref_key);
    if (refKeyBuf === null) {
      reply.code(400);
      return reply.send({
        error: { code: 'INVALID_REQUEST', message: 'expected 32-char hex key' }
      });
    }

    // The path param is documented as :ref_key but is shaped as 32-char
    // hex — the same shape as a stable asset id. Resolve in two passes:
    // ref_key first (the canonical, version-pinned URL), then fall back
    // to id and 302 redirect to the current ref_key. The redirect lets
    // entry asset fields (which store the id) resolve as URL slugs
    // without forcing every consumer to expand_assets first.
    let asset = await core.findAssetByRefKey(req.params.ref_key);
    let resolvedViaId = false;
    if (!asset) {
      try {
        asset = await core.getAsset({ id: req.params.ref_key });
      } catch {
        asset = null;
      }
      if (asset) resolvedViaId = true;
    }
    if (!asset) {
      reply.code(404);
      return reply.send({
        error: { code: 'NOT_FOUND', message: `asset ${req.params.ref_key}` }
      });
    }

    if (resolvedViaId) {
      const currentRefKey = toHex(asset.ref_key);
      const qIx = req.url.indexOf('?');
      const qs = qIx >= 0 ? req.url.slice(qIx) : '';
      // 302, not 301: the target rotates whenever bytes are replaced,
      // so caches must not pin the redirect itself.
      reply.header('Cache-Control', 'public, max-age=300');
      return reply.redirect(`/assets/${currentRefKey}${qs}`, 302);
    }

    // imgix-style transforms (w, h, fit, q, fm, auto, dpr) — applied at
    // request time, cached by Core if a TransformCache is configured.
    const transform = parseTransformParams(
      req.query as Record<string, string | undefined>
    );
    if (transform !== null) {
      const result = await core.getTransformedAsset({
        ref_key: req.params.ref_key,
        params: transform,
        ...(typeof req.headers.accept === 'string'
          ? { accept: req.headers.accept }
          : {})
      });
      if (!result) {
        reply.code(404);
        return reply.send({
          error: { code: 'NOT_FOUND', message: `asset ${req.params.ref_key}` }
        });
      }
      reply.header('Content-Type', result.mime);
      reply.header('Content-Length', String(result.bytes.byteLength));
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
      // auto=format negotiates on Accept — caches must split by it.
      if (transform.auto === 'format') reply.header('Vary', 'Accept');
      reply.header('X-Ledric-Transform', result.passthrough ? 'passthrough' : 'applied');
      return reply.send(result.bytes);
    }

    const bytes = await core.readAssetBytes({
      id: toHex(asset.id),
      version: asset.version
    });
    const mime = typeof asset.meta.mime === 'string' ? asset.meta.mime : 'application/octet-stream';
    reply.header('Content-Type', mime);
    reply.header('Content-Length', String(bytes.byteLength));
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(bytes);
  });

  app.post<{ Body: { tool?: string; args?: Record<string, unknown> } }>('/rpc', async (req, reply) => {
    const tool = req.body?.tool;
    const args = req.body?.args ?? {};
    if (typeof tool !== 'string' || tool.length === 0) {
      reply.code(400);
      return { error: { code: 'INVALID_REQUEST', message: 'body must be { tool, args }' } };
    }
    try {
      const result = await dispatchTool(core, tool, args);
      return { result: toJsonSafe(result) };
    } catch (err) {
      reply.code(400);
      return { error: { tool, ...serializeToolError(err) } };
    }
  });

  // Streamable HTTP MCP transport — disabled by default. Lives in
  // mcp-server (createStreamableHttpHandle) so the tool catalogue stays
  // in one place; we just plumb it onto Fastify here. Auth is handled
  // up in the preHandler (per-method / per-tool, mirroring /rpc).
  // Two modes: `mcp.http` (local, API-key only) is the default story;
  // `mcp.public` (implies http) opens the OAuth provider routes and
  // tightens Origin/CIDR. Public requires `publicUrl` to identify the
  // OAuth issuer — fail loudly at boot if it's missing.
  let mcpHandle: StreamableHttpHandle | null = null;
  if (mcpHttpFlag) {
    mcpHandle = createStreamableHttpHandle(core);
    const allowedOrigins = computeAllowedOrigins(opts.mcp!, mcpPublicFlag);
    const allowedCidrs = parseCidrs(opts.mcp?.allowedCidrs);
    // Origin + CIDR check as an onRequest hook so it runs BEFORE the
    // global auth preHandler. Otherwise a bad-origin anonymous request
    // in public mode gets a 401 + WWW-Authenticate (leaking the OAuth
    // challenge) before the route handler can 403 it.
    const gateHook = async (
      req: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply
    ) => {
      if (!isClientIpAllowed(req.ip, allowedCidrs)) {
        return reply.code(403).send({
          error: { code: 'FORBIDDEN', message: 'Client IP not in allowlist' }
        });
      }
      if (!isOriginAllowed(req.headers.origin, allowedOrigins, mcpPublicFlag)) {
        return reply.code(403).send({
          error: {
            code: 'FORBIDDEN',
            message: `Origin ${String(req.headers.origin)} not in allowlist`
          }
        });
      }
    };
    const handler = async (req: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      // Hand the raw Node req/res to the SDK transport. Fastify must
      // not write anything else after this — `hijack()` makes it stop.
      reply.hijack();
      try {
        await mcpHandle!.handle(req.raw, reply.raw, req.body);
      } catch (err) {
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader('content-type', 'application/json');
          reply.raw.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message: err instanceof Error ? err.message : String(err)
              },
              id: null
            })
          );
        }
      }
    };
    app.post('/mcp', { onRequest: gateHook }, handler);
    app.get('/mcp', { onRequest: gateHook }, handler);
    app.delete('/mcp', { onRequest: gateHook }, handler);

    // Tear sessions down on server close so SIGINT doesn't leak them.
    app.addHook('onClose', async () => {
      if (mcpHandle !== null) await mcpHandle.close();
    });
  }

  return app;
}

/**
 * Default Origin allowlist. In `http`-only (local) mode this is just a
 * scaffold — the real check tolerates localhost-on-any-port via the
 * fallback in isOriginAllowed. In `public` mode the allowlist is the
 * sole gate: `publicUrl`'s origin plus `claude.ai` for browser-side
 * OAuth flows. Non-browser clients (no Origin header) bypass the
 * check entirely — they don't have a same-origin policy to subvert.
 */
function computeAllowedOrigins(
  mcp: NonNullable<HttpServerOptions['mcp']>,
  publicMode: boolean
): Set<string> {
  if (mcp.allowedOrigins !== undefined && mcp.allowedOrigins.length > 0) {
    return new Set(mcp.allowedOrigins);
  }
  const out = new Set<string>();
  if (mcp.publicUrl !== undefined) {
    try {
      out.add(new URL(mcp.publicUrl).origin);
    } catch {
      /* invalid URL — skip */
    }
  }
  if (publicMode) {
    // claude.ai is the canonical custom-connector origin. Add as a
    // default convenience; operators can override with allowedOrigins.
    out.add('https://claude.ai');
  } else {
    // Local mode: pre-populate localhost variants so explicit
    // `allowedOrigins: undefined` still matches dev tooling. The
    // localhost-port escape in isOriginAllowed catches the rest.
    out.add('http://localhost');
    out.add('http://127.0.0.1');
    out.add('https://localhost');
    out.add('https://127.0.0.1');
  }
  return out;
}

function isOriginAllowed(
  rawOrigin: string | string[] | undefined,
  allowed: Set<string>,
  publicMode: boolean
): boolean {
  // No Origin header → not a browser request → not the threat model
  // Origin validation is meant to address (DNS rebinding from a page
  // running in the user's browser).
  if (rawOrigin === undefined) return true;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (origin === undefined) return true;

  // Direct match against the allowlist (scheme + host + port).
  if (allowed.has(origin)) return true;

  if (!publicMode) {
    // Local mode: allow any port on localhost / 127.0.0.1 — dev
    // tooling spins up ephemeral local origins that wouldn't all be
    // in the allowlist. Public mode does NOT get this escape: a
    // localhost-bound page on the same machine as a public ledric
    // shouldn't be able to drive the public surface.
    try {
      const u = new URL(origin);
      if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    } catch {
      /* malformed origin — treat as disallowed */
    }
  }
  return false;
}

/**
 * Parse CIDR strings into a normalized form for fast matching. Returns
 * null when no CIDRs are configured (no filtering). IPv4 only for now —
 * IPv6 hosts can configure individual /128s if needed; full v6 CIDR
 * matching is more complexity than the current threat model warrants.
 */
interface ParsedCidr {
  // 32-bit network address (host bits zeroed) and the mask length.
  network: number;
  bits: number;
}

function parseCidrs(raw: readonly string[] | undefined): ParsedCidr[] | null {
  if (raw === undefined || raw.length === 0) return null;
  const out: ParsedCidr[] = [];
  for (const entry of raw) {
    const parsed = parseCidr(entry);
    if (parsed !== null) out.push(parsed);
  }
  return out.length > 0 ? out : null;
}

function parseCidr(s: string): ParsedCidr | null {
  // Accept "1.2.3.4" as a /32 single host.
  const slash = s.indexOf('/');
  const ipPart = slash === -1 ? s : s.slice(0, slash);
  const bits = slash === -1 ? 32 : parseInt(s.slice(slash + 1), 10);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const octets = ipPart.split('.');
  if (octets.length !== 4) return null;
  let ip = 0;
  for (const o of octets) {
    const n = parseInt(o, 10);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    ip = (ip << 8) | n;
  }
  // Force unsigned 32-bit arithmetic.
  ip = ip >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { network: ip & mask, bits };
}

function isClientIpAllowed(ip: string, cidrs: ParsedCidr[] | null): boolean {
  if (cidrs === null) return true;
  // Strip IPv4-mapped IPv6 prefix (::ffff:1.2.3.4 — Node's default
  // dual-stack form). Reject any other v6 address since we don't have
  // v6 CIDR matching.
  let v4 = ip;
  if (v4.startsWith('::ffff:')) v4 = v4.slice(7);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return false;
  const parsed = parseCidr(v4);
  if (parsed === null) return false;
  for (const c of cidrs) {
    const mask = c.bits === 0 ? 0 : (0xffffffff << (32 - c.bits)) >>> 0;
    if ((parsed.network & mask) === c.network) return true;
  }
  return false;
}

/**
 * Pull a Bearer credential off either the `Authorization` header or
 * the `X-Ledric-Key` shorthand. Returns the trimmed secret or
 * undefined when neither is set / either is malformed.
 */
function extractBearer(req: import('fastify').FastifyRequest): string | undefined {
  const authz = req.headers.authorization;
  const xKey = req.headers['x-ledric-key'];
  if (typeof authz === 'string' && authz.toLowerCase().startsWith('bearer ')) {
    const v = authz.slice(7).trim();
    return v.length > 0 ? v : undefined;
  }
  if (typeof xKey === 'string') {
    const v = xKey.trim();
    return v.length > 0 ? v : undefined;
  }
  return undefined;
}

/**
 * Surface as much structured detail as the thrown Error carries — code,
 * errors[], and any relevant fields on storage-layer errors — instead of
 * collapsing everything to .message. Generic catches stay readable too.
 */
function serializeToolError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) {
    return { code: 'TOOL_ERROR', message: String(err) };
  }
  const out: Record<string, unknown> = {
    code: 'TOOL_ERROR',
    message: err.message
  };
  const e = err as Error & {
    code?: unknown;
    errors?: unknown;
    current_version?: unknown;
    your_parent_version?: unknown;
    type?: unknown;
    slug?: unknown;
    kind?: unknown;
    ref?: unknown;
    entry_count?: unknown;
  };
  if (typeof e.code === 'string') out.code = e.code;
  if (Array.isArray(e.errors)) out.errors = e.errors;
  if (typeof e.current_version === 'number') out.current_version = e.current_version;
  if (typeof e.your_parent_version === 'number') {
    out.your_parent_version = e.your_parent_version;
  }
  if (typeof e.type === 'string') out.type = e.type;
  if (typeof e.slug === 'string') out.slug = e.slug;
  if (typeof e.kind === 'string') out.kind = e.kind;
  if (typeof e.ref === 'string') out.ref = e.ref;
  if (typeof e.entry_count === 'number') out.entry_count = e.entry_count;
  return out;
}

async function dispatchTool(
  core: Core,
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  // Input validation is thin here; the HTTP transport doesn't mangle objects
  // the way some MCP clients do, so callers are trusted to send correctly
  // shaped JSON. Core methods do their own validation (defineType, zod, etc.).
  const a = args as unknown;
  switch (tool) {
    case 'describe_model':
      return core.describeModel();
    case 'create_type':
      return core.createType(a as Parameters<Core['createType']>[0]);
    case 'alter_type':
      return core.alterType(a as Parameters<Core['alterType']>[0]);
    case 'draft':
      return core.draft(a as Parameters<Core['draft']>[0]);
    case 'read':
      return core.read(a as Parameters<Core['read']>[0]);
    case 'find':
      return core.find(a as Parameters<Core['find']>[0]);
    case 'publish':
      return core.publish(a as Parameters<Core['publish']>[0]);
    case 'rename_entry':
      return core.rename(a as Parameters<Core['rename']>[0]);
    case 'delete_type':
      return core.deleteType(a as Parameters<Core['deleteType']>[0]);
    case 'delete_entry':
      return core.deleteEntry(a as Parameters<Core['deleteEntry']>[0]);
    case 'migrate_entries':
      return core.migrateEntries(a as Parameters<Core['migrateEntries']>[0]);
    case 'get_asset':
      return core.getAsset(a as Parameters<Core['getAsset']>[0]);
    case 'list_assets':
      return core.listAssets(a as Parameters<Core['listAssets']>[0]);
    case 'update_asset': {
      // Bytes come over the wire as base64. Other fields are JSON-shaped.
      const raw = a as { id?: unknown; parent_version?: unknown; bytes_b64?: unknown; meta?: unknown; author?: unknown };
      if (typeof raw.bytes_b64 !== 'string') {
        throw new Error('update_asset: bytes_b64 (base64-encoded string) is required');
      }
      const bytes = new Uint8Array(Buffer.from(raw.bytes_b64, 'base64'));
      return core.updateAsset({
        id: String(raw.id),
        parent_version: Number(raw.parent_version),
        bytes,
        ...(raw.meta !== undefined ? { meta: raw.meta as Record<string, unknown> } : {}),
        ...(raw.author !== undefined ? { author: String(raw.author) } : {})
      });
    }
    case 'add_asset_tags': {
      const raw = a as { id?: unknown; tags?: unknown };
      return core.addAssetTags(String(raw.id), Array.isArray(raw.tags) ? raw.tags.map(String) : []);
    }
    case 'remove_asset_tags': {
      const raw = a as { id?: unknown; tags?: unknown };
      return core.removeAssetTags(String(raw.id), Array.isArray(raw.tags) ? raw.tags.map(String) : []);
    }
    case 'add_entry_tags': {
      const raw = a as { ref?: unknown; tags?: unknown };
      return core.addEntryTags(raw.ref as Parameters<Core['addEntryTags']>[0], Array.isArray(raw.tags) ? raw.tags.map(String) : []);
    }
    case 'remove_entry_tags': {
      const raw = a as { ref?: unknown; tags?: unknown };
      return core.removeEntryTags(raw.ref as Parameters<Core['removeEntryTags']>[0], Array.isArray(raw.tags) ? raw.tags.map(String) : []);
    }
    case 'list_tags':
      return core.listTags();
    case 'update_tag': {
      const raw = a as { slug?: unknown; label?: unknown };
      return core.updateTag(String(raw.slug), String(raw.label));
    }
    default:
      throw new Error(`Unknown tool "${tool}"`);
  }
}

/**
 * Attach the API-key auth preHandler. Runs before every route. The
 * policy:
 *   - Public routes (GET / and the GUI mount) skip auth entirely.
 *   - If no active keys exist (DB + env), every request is anonymous —
 *     this preserves the day-zero "no auth configured" UX.
 *   - Otherwise: writes require admin, reads accept reader (when
 *     reader-key mode is on; reads stay open otherwise). For
 *     `POST /rpc` the read/write split is per-tool, not per-method —
 *     `find` / `read` / `describe_model` / `list_assets` / `list_tags` /
 *     `get_asset` are reads and accept reader keys. Everything else
 *     under /rpc requires admin.
 *
 * Env-var keys (LEDRIC_ADMIN_KEY / LEDRIC_READER_KEY) are checked
 * alongside DB-issued keys so ops scenarios that don't want secrets in
 * SQLite still work.
 */
function attachAuth(
  app: FastifyInstance,
  auth: HttpAuthOptions,
  guiMountPath: string | null,
  mcpPublic: boolean,
  publicUrl: string | undefined,
  oauthVerifierGetter?: () => AccessTokenVerifier | null
): void {
  // Public-MCP implies require-reader: every /mcp call must carry an
  // OAuth bearer (or API key), otherwise the OAuth gate is bypassable
  // and protocol-level initialize from an anonymous client would
  // never trigger the WWW-Authenticate challenge that bootstraps
  // discovery.
  const requireReaderKey = auth.requireReaderKey === true || mcpPublic;
  const envKeys = new Map<string, ApiKeyRole>();
  if (auth.envAdminKey) envKeys.set(auth.envAdminKey, 'admin');
  if (auth.envReaderKey) envKeys.set(auth.envReaderKey, 'reader');

  // RFC 9728 — when we serve the OAuth provider, every 401 from a
  // protected route must point clients at the protected-resource
  // metadata URL so they can discover the issuer + token endpoint.
  // MCP Inspector (and any spec-compliant client) won't bootstrap
  // the OAuth flow without this header.
  const wwwAuthenticate =
    mcpPublic && publicUrl !== undefined
      ? `Bearer realm="ledric", resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`
      : null;
  function send401(
    reply: import('fastify').FastifyReply,
    message: string
  ): import('fastify').FastifyReply {
    if (wwwAuthenticate !== null) reply.header('WWW-Authenticate', wwwAuthenticate);
    reply.code(401).send({ error: { code: 'UNAUTHORIZED', message } });
    return reply;
  }

  const guiPrefix = guiMountPath
    ? guiMountPath.endsWith('/') ? guiMountPath : `${guiMountPath}/`
    : null;

  function isPublicPath(urlPath: string): boolean {
    if (urlPath === '/' || urlPath === '') return true;
    if (urlPath === '/auth/status') return true;
    if (guiMountPath !== null && urlPath === guiMountPath) return true;
    if (guiPrefix !== null && urlPath.startsWith(guiPrefix)) return true;
    // OAuth discovery + auth-flow endpoints are intentionally
    // unauthenticated — they ARE the auth layer. /oauth/token validates
    // grants internally; /oauth/authorize validates the consent token.
    if (urlPath.startsWith('/.well-known/')) return true;
    if (urlPath.startsWith('/oauth/')) return true;
    return false;
  }

  // Tool names dispatched by /rpc that mutate nothing — these accept a
  // reader key. Everything not in this set requires admin.
  const READ_RPC_TOOLS = new Set([
    'describe_model',
    'read',
    'find',
    'get_asset',
    'list_assets',
    'list_tags'
  ]);

  // preHandler runs after body parsing, so /rpc's `body.tool` is
  // available here for the per-tool auth split. onRequest would be too
  // early.
  app.addHook('preHandler', async (req, reply) => {
    const path = (req.url.split('?', 1)[0] ?? req.url);
    if (isPublicPath(path)) return;

    // Detect a presented bearer up front. JWTs MUST always be honored
    // (an OAuth-scoped read-only token has to be enforced as read-only
    // even when api-keys aren't configured), so the auth-off shortcut
    // below only fires when nothing was presented at all.
    const presentedBearer = extractBearer(req);
    const looksLikeJwt =
      presentedBearer !== undefined &&
      presentedBearer.startsWith('ey') &&
      presentedBearer.includes('.');

    // Auth-off when nothing is configured AND the caller didn't show
    // up with a JWT. Cheap path — count is a single COUNT(*) on a
    // tiny table. Public-MCP mode opts out: missing keys must still
    // challenge so the OAuth flow can bootstrap, otherwise /mcp would
    // be open to anyone on the public internet.
    const dbKeys = await auth.storage.countActiveApiKeys();
    if (!mcpPublic && dbKeys === 0 && envKeys.size === 0 && !looksLikeJwt) return;

    // Required role for this request. /rpc and /mcp peek at the
    // dispatched tool to decide; everything else uses HTTP-method
    // semantics.
    let required: ApiKeyRole | null = null;
    if (path === '/rpc') {
      const body = req.body as { tool?: unknown } | undefined;
      const tool = typeof body?.tool === 'string' ? body.tool : null;
      if (tool !== null && READ_RPC_TOOLS.has(tool)) {
        required = requireReaderKey ? 'reader' : null;
      } else {
        required = 'admin';
      }
    } else if (path === '/mcp') {
      // /mcp follows the same per-tool model as /rpc, but the body is
      // JSON-RPC framed: { method: 'tools/call', params: { name, … } }.
      // Protocol-level methods (`initialize`, `tools/list`, etc.) and
      // read-only tool calls accept reader; everything else needs admin.
      // GET (SSE) and DELETE (session terminate) are protocol reads.
      if (req.method === 'GET' || req.method === 'DELETE') {
        required = requireReaderKey ? 'reader' : null;
      } else {
        const body = req.body as
          | { method?: unknown; params?: { name?: unknown } }
          | undefined;
        const rpcMethod = typeof body?.method === 'string' ? body.method : null;
        if (rpcMethod === 'tools/call') {
          const toolName =
            typeof body?.params?.name === 'string' ? body.params.name : null;
          if (toolName !== null && READ_RPC_TOOLS.has(toolName)) {
            required = requireReaderKey ? 'reader' : null;
          } else {
            required = 'admin';
          }
        } else {
          // initialize, tools/list, prompts/list, ping, etc.
          required = requireReaderKey ? 'reader' : null;
        }
      }
    } else if (req.method === 'POST') {
      required = 'admin';
    } else if (requireReaderKey) {
      required = 'reader';
    }
    if (required === null) return;

    const presented = presentedBearer;

    // OAuth bearer first — JWTs always start with `ey` (base64url of `{"`).
    // Falls through to API-key auth on parse / verify failure so a
    // bad JWT doesn't dead-end clients that ALSO happen to send a key.
    let role: ApiKeyRole | null = null;
    let keyId: Uint8Array | null = null;
    if (looksLikeJwt) {
      const verifier = oauthVerifierGetter?.();
      if (verifier) {
        try {
          const claims = await verifier(presented!);
          // claims.scope can be space-separated multi-scope; highest
          // wins. ledric:write subsumes ledric:read on /mcp dispatch.
          const scopes = claims.scope.split(/\s+/).filter(Boolean);
          if (scopes.includes('ledric:write')) role = SCOPE_TO_ROLE['ledric:write'];
          else if (scopes.includes('ledric:read')) role = SCOPE_TO_ROLE['ledric:read'];
        } catch {
          // Bad / expired JWT — fall through to API-key auth.
        }
      }
    }

    if (role === null) {
      if (!presented || !looksLikeApiKey(presented)) {
        return send401(reply, 'Missing or malformed bearer credential');
      }
      role = envKeys.get(presented) ?? null;
      if (role === null) {
        const found = await auth.storage.findApiKeyByHash(hashApiKey(presented));
        if (found && found.revoked_at === null) {
          role = found.role;
          keyId = found.id;
        }
      }
    }

    if (role === null) {
      // Soft hint when the prefix is recognizable — helps debugging
      // without leaking which exact key would have matched.
      const hinted = parseApiKeyRole(presented ?? '');
      return send401(
        reply,
        hinted ? 'API key is unknown or revoked' : 'Invalid credential'
      );
    }

    if (required === 'admin' && role !== 'admin') {
      reply.code(403).send({
        error: { code: 'FORBIDDEN', message: 'Admin role required for this endpoint' }
      });
      return reply;
    }

    // Touch last_used_at — debounced inside storage so this is cheap.
    if (keyId !== null) {
      void auth.storage.markApiKeyUsed(keyId, Date.now()).catch(() => {});
    }
  });
}
