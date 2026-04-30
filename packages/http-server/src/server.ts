import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { promises as fs } from 'node:fs';
import { join as pathJoin } from 'node:path';
import type { Core } from '@ledric/core';
import { parseTransformParams } from '@ledric/core';
import type { Storage, ApiKeyRole } from '@ledric/storage';
import { hashApiKey, parseApiKeyRole, looksLikeApiKey } from '@ledric/storage';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function parseRefKeyHex(s: string): Buffer | null {
  if (typeof s !== 'string' || !/^[0-9a-f]{32}$/i.test(s)) return null;
  return Buffer.from(s, 'hex');
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
}

export function createHttpServer(core: Core, opts: HttpServerOptions = {}): FastifyInstance {
  const uploadLimit = opts.uploadLimitBytes ?? 25 * 1024 * 1024;
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: uploadLimit
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

  if (opts.auth !== undefined) {
    attachAuth(app, opts.auth, opts.gui?.mountPath ?? null);
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
    version: '0.0.0',
    endpoints: [
      'GET  /types',
      'GET  /types/:name',
      'GET  /entries/:type',
      'GET  /entries/:type/:slug',
      'GET  /assets',
      'GET  /assets/:id',
      'GET  /assets/:id/meta',
      'POST /assets        multipart upload',
      'POST /rpc           { tool, args }'
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
      'update_asset'
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
      resolve_refs?: string;
    };
  }>('/entries/:type', async (req) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : undefined;
    const expandAssets = parseExpandAssets(req.query.expand_assets);
    const resolveRefs = req.query.resolve_refs === '1' || req.query.resolve_refs === 'true';
    const result = await core.find({
      type: req.params.type,
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(req.query.locale !== undefined ? { locale: req.query.locale } : {}),
      ...(expandAssets !== undefined ? { expand_assets: expandAssets } : {}),
      ...(resolveRefs ? { resolve_refs: true } : {})
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
      resolve_refs?: string;
    };
  }>('/entries/:type/:slug', async (req, reply) => {
    const versionNum = req.query.version ? parseInt(req.query.version, 10) : undefined;
    const localeArg = req.query.locale;
    const expandAssets = parseExpandAssets(req.query.expand_assets);
    const resolveRefs = req.query.resolve_refs === '1' || req.query.resolve_refs === 'true';
    const entry = await core.read({
      ref: { type: req.params.type, slug: req.params.slug },
      ...(versionNum !== undefined ? { version: versionNum } : {}),
      ...(localeArg !== undefined ? { locale: localeArg } : {}),
      ...(expandAssets !== undefined ? { expand_assets: expandAssets } : {}),
      ...(resolveRefs ? { resolve_refs: true } : {})
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
    Querystring: { kind?: string; limit?: string; offset?: string };
  }>('/assets', async (req) => {
    const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined;
    const offset = req.query.offset ? parseInt(req.query.offset, 10) : undefined;
    const result = await core.listAssets({
      ...(req.query.kind !== undefined ? { kind: req.query.kind } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {})
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
          url: `/assets/${refKeyHex}`
        };
      })
    });
  });

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
        }
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
        error: { code: 'INVALID_REQUEST', message: 'expected 32-char hex ref_key' }
      });
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

    const asset = await core.findAssetByRefKey(req.params.ref_key);
    if (!asset) {
      reply.code(404);
      return reply.send({
        error: { code: 'NOT_FOUND', message: `asset ${req.params.ref_key}` }
      });
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

  return app;
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
 *   - Otherwise: POSTs require admin; GETs are open by default but
 *     require reader when `requireReaderKey` is set.
 *
 * Env-var keys (LEDRIC_ADMIN_KEY / LEDRIC_READER_KEY) are checked
 * alongside DB-issued keys so ops scenarios that don't want secrets in
 * SQLite still work.
 */
function attachAuth(
  app: FastifyInstance,
  auth: HttpAuthOptions,
  guiMountPath: string | null
): void {
  const requireReaderKey = auth.requireReaderKey === true;
  const envKeys = new Map<string, ApiKeyRole>();
  if (auth.envAdminKey) envKeys.set(auth.envAdminKey, 'admin');
  if (auth.envReaderKey) envKeys.set(auth.envReaderKey, 'reader');

  const guiPrefix = guiMountPath
    ? guiMountPath.endsWith('/') ? guiMountPath : `${guiMountPath}/`
    : null;

  function isPublicPath(urlPath: string): boolean {
    if (urlPath === '/' || urlPath === '') return true;
    if (urlPath === '/auth/status') return true;
    if (guiMountPath !== null && urlPath === guiMountPath) return true;
    if (guiPrefix !== null && urlPath.startsWith(guiPrefix)) return true;
    return false;
  }

  app.addHook('onRequest', async (req, reply) => {
    const path = (req.url.split('?', 1)[0] ?? req.url);
    if (isPublicPath(path)) return;

    // Auth-off when nothing is configured. Cheap path — count is a
    // single COUNT(*) on a tiny table.
    const dbKeys = await auth.storage.countActiveApiKeys();
    if (dbKeys === 0 && envKeys.size === 0) return;

    // Required role for this request.
    let required: ApiKeyRole | null = null;
    if (req.method === 'POST') required = 'admin';
    else if (requireReaderKey) required = 'reader';
    if (required === null) return;

    // Extract presented secret.
    const authz = req.headers.authorization;
    const xKey = req.headers['x-ledric-key'];
    let presented: string | undefined;
    if (typeof authz === 'string' && authz.toLowerCase().startsWith('bearer ')) {
      presented = authz.slice(7).trim();
    } else if (typeof xKey === 'string') {
      presented = xKey.trim();
    }
    if (!presented || !looksLikeApiKey(presented)) {
      reply.code(401).send({
        error: { code: 'UNAUTHORIZED', message: 'Missing or malformed API key' }
      });
      return reply;
    }

    // Resolve to a role.
    let role: ApiKeyRole | null = envKeys.get(presented) ?? null;
    let keyId: Uint8Array | null = null;

    if (role === null) {
      const found = await auth.storage.findApiKeyByHash(hashApiKey(presented));
      if (found && found.revoked_at === null) {
        role = found.role;
        keyId = found.id;
      }
    }

    if (role === null) {
      // Soft hint when the prefix is recognizable — helps debugging
      // without leaking which exact key would have matched.
      const hinted = parseApiKeyRole(presented);
      reply.code(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: hinted
            ? 'API key is unknown or revoked'
            : 'Invalid API key'
        }
      });
      return reply;
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
