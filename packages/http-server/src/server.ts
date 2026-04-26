import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { Core } from '@ledric/core';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
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

function guessKindFromMime(mime: string | undefined): string {
  if (mime === undefined) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
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

  if (opts.gui !== undefined) {
    const mountPath = opts.gui.mountPath ?? '/admin';
    if (!mountPath.startsWith('/')) {
      throw new Error(`gui.mountPath must start with '/', got "${mountPath}"`);
    }
    app.register(fastifyStatic, {
      root: opts.gui.assetsPath,
      prefix: mountPath.endsWith('/') ? mountPath : `${mountPath}/`,
      decorateReply: false
    });
  }

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
      'POST /rpc   { tool, args }'
    ]
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
      ...(entry._refs !== undefined ? { _refs: entry._refs } : {})
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
      results: result.results.map((r) => ({
        id: toHex(r.id),
        kind: r.kind,
        version: r.current_version,
        storage_ref: r.storage_ref,
        meta: r.meta,
        url: `/assets/${toHex(r.id)}`
      }))
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
      reply.code(201);
      return {
        id: idHex,
        version: written.version,
        kind: written.kind,
        storage_ref: written.storage_ref,
        meta: written.meta,
        url: `/assets/${idHex}`
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      reply.code(400);
      return { error: { code: 'UPLOAD_FAILED', message } };
    }
  });

  app.get<{
    Params: { id: string };
    Querystring: { version?: string };
  }>('/assets/:id/meta', async (req, reply) => {
    const versionNum = req.query.version ? parseInt(req.query.version, 10) : undefined;
    const asset = await core.getAsset({
      id: req.params.id,
      ...(versionNum !== undefined ? { version: versionNum } : {})
    });
    if (!asset) {
      reply.code(404);
      return { error: { code: 'NOT_FOUND', message: `asset ${req.params.id}` } };
    }
    return {
      id: req.params.id,
      kind: asset.kind,
      version: asset.version,
      current_version: asset.current_version,
      published_version: asset.published_version,
      storage_ref: asset.storage_ref,
      meta: asset.meta,
      url: `/assets/${req.params.id}`
    };
  });

  app.get<{
    Params: { id: string };
    Querystring: { version?: string };
  }>('/assets/:id', async (req, reply) => {
    const versionNum = req.query.version ? parseInt(req.query.version, 10) : undefined;
    const asset = await core.getAsset({
      id: req.params.id,
      ...(versionNum !== undefined ? { version: versionNum } : {})
    });
    if (!asset) {
      reply.code(404);
      return reply.send({ error: { code: 'NOT_FOUND', message: `asset ${req.params.id}` } });
    }
    const bytes = await core.readAssetBytes({
      id: req.params.id,
      ...(versionNum !== undefined ? { version: versionNum } : {})
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
      const message = err instanceof Error ? err.message : String(err);
      reply.code(400);
      return { error: { code: 'TOOL_ERROR', tool, message } };
    }
  });

  return app;
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
    case 'migrate_entries':
      return core.migrateEntries(a as Parameters<Core['migrateEntries']>[0]);
    case 'get_asset':
      return core.getAsset(a as Parameters<Core['getAsset']>[0]);
    case 'list_assets':
      return core.listAssets(a as Parameters<Core['listAssets']>[0]);
    default:
      throw new Error(`Unknown tool "${tool}"`);
  }
}
