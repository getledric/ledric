/**
 * @ledric/proxy — server-side proxy primitive for ledric.
 *
 * Mounts in any Node-compatible framework (Astro, Next, SvelteKit, Hono,
 * Express, plain Node) as a fetch-API handler: `(Request) => Promise<Response>`.
 * Holds the API key server-side so the browser never sees it, and
 * exposes a curated subset of ledric's HTTP surface to the consumer.
 *
 * See README.md for framework-by-framework wiring snippets.
 */

export interface LedricProxyOptions {
  /** Base URL of the running ledric HTTP server. Required. */
  baseUrl: string;
  /**
   * Reader key used for GET requests. Falls back to adminKey when absent.
   * Pass it from a server-only secret (process.env / runtime secrets).
   */
  readerKey?: string;
  /**
   * Admin key. Required only for inline editor / admin proxies (which
   * accept writes). Reader endpoints prefer readerKey when both are set.
   */
  adminKey?: string;

  /** Asset proxy config. Default: enabled. */
  assets?: AssetsOptions | boolean;
  /**
   * Content (entries) proxy config. Default: enabled with no allowlist
   * (every type forwardable). Set `types: [...]` to lock down.
   */
  content?: ContentOptions | boolean;
  /**
   * Inline editor proxy config. Default: disabled — opt in for preview
   * environments only. Forwards writes; needs adminKey.
   */
  inlineEditor?: InlineEditorOptions | boolean;
  /**
   * Admin GUI proxy config. Default: disabled. Most production sites
   * should never enable this — keep the admin GUI on a private network.
   */
  admin?: AdminOptions | boolean;

  /** Override fetch (testing). Default: globalThis.fetch. */
  fetch?: typeof fetch;
  /** Upstream timeout in ms. Default: 60_000. */
  timeout?: number;
}

export interface AssetsOptions {
  enabled?: boolean;
}

export interface ContentOptions {
  enabled?: boolean;
  /**
   * Allowlist of type names. When set, requests for any other type 404.
   * Undefined / empty = no restriction.
   */
  types?: readonly string[];
  /**
   * If true, force `published=true` on every forwarded request (consumer
   * cannot read drafts). Default: false — consumer chooses per request.
   */
  forcePublished?: boolean;
}

export interface InlineEditorOptions {
  enabled?: boolean;
}

export interface AdminOptions {
  enabled?: boolean;
}

export interface LedricProxy {
  /** Forward `/assets/<key>` and `/assets/<key>/meta`. */
  assets: ProxyHandler;
  /** Forward `/entries/:type` and `/entries/:type/:slug`. */
  content: ProxyHandler;
  /** Forward `/inline/*` (gated by `inlineEditor.enabled`). */
  inlineEditor: ProxyHandler;
  /** Forward `/admin/*` (gated by `admin.enabled`). */
  admin: ProxyHandler;
  /**
   * Dispatcher — picks the right sub-handler based on the path prefix
   * (`/assets/`, `/entries/`, `/inline/`, `/admin/`). Pass `path`
   * explicitly when your framework already routed to a catchall;
   * otherwise it's read from `new URL(request.url).pathname`.
   */
  handler: ProxyHandler;
}

export type ProxyHandler = (request: Request, path?: string) => Promise<Response>;

interface ResolvedOptions {
  baseUrl: string;
  readerKey: string | undefined;
  adminKey: string | undefined;
  assets: { enabled: boolean };
  content: { enabled: boolean; types: ReadonlySet<string> | null; forcePublished: boolean };
  inlineEditor: { enabled: boolean };
  admin: { enabled: boolean };
  fetch: typeof fetch;
  timeout: number;
}

function resolveSection<T extends { enabled?: boolean }>(
  v: T | boolean | undefined,
  defaultEnabled: boolean
): { enabled: boolean } & T {
  if (v === undefined) return { enabled: defaultEnabled } as { enabled: boolean } & T;
  if (v === true) return { enabled: true } as { enabled: boolean } & T;
  if (v === false) return { enabled: false } as { enabled: boolean } & T;
  return { enabled: v.enabled ?? defaultEnabled, ...v };
}

function resolve(opts: LedricProxyOptions): ResolvedOptions {
  if (!opts.baseUrl || typeof opts.baseUrl !== 'string') {
    throw new Error('@ledric/proxy: `baseUrl` is required');
  }
  const baseUrl = opts.baseUrl.replace(/\/+$/, '');
  const assets = resolveSection<AssetsOptions>(opts.assets, true);
  const contentRaw = resolveSection<ContentOptions>(opts.content, true);
  const content = {
    enabled: contentRaw.enabled,
    types:
      Array.isArray(contentRaw.types) && contentRaw.types.length > 0
        ? new Set(contentRaw.types)
        : null,
    forcePublished: contentRaw.forcePublished === true
  };
  const inlineEditor = resolveSection<InlineEditorOptions>(opts.inlineEditor, false);
  const admin = resolveSection<AdminOptions>(opts.admin, false);
  return {
    baseUrl,
    readerKey: opts.readerKey,
    adminKey: opts.adminKey,
    assets: { enabled: assets.enabled },
    content,
    inlineEditor: { enabled: inlineEditor.enabled },
    admin: { enabled: admin.enabled },
    fetch: opts.fetch ?? globalThis.fetch,
    timeout: opts.timeout ?? 60_000
  };
}

const SAFE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'if-none-match',
  'if-modified-since',
  'range',
  'content-type'
]);

const SAFE_RESPONSE_HEADERS = new Set([
  'content-type',
  'content-length',
  'cache-control',
  'etag',
  'last-modified',
  'vary',
  'content-encoding',
  'content-disposition',
  'location',
  'x-ledric-redirect',
  'x-ledric-redirect-locale',
  'x-ledric-transform'
]);

function buildHeaders(req: Request, key: string | undefined): Headers {
  const out = new Headers();
  req.headers.forEach((v, k) => {
    if (SAFE_REQUEST_HEADERS.has(k.toLowerCase())) out.set(k, v);
  });
  if (key) out.set('Authorization', `Bearer ${key}`);
  return out;
}

function buildResponse(upstream: Response): Response {
  const headers = new Headers();
  upstream.headers.forEach((v, k) => {
    if (SAFE_RESPONSE_HEADERS.has(k.toLowerCase())) headers.set(k, v);
  });
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  });
}

async function fetchUpstream(
  url: string,
  init: RequestInit,
  opts: ResolvedOptions
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout);
  try {
    return await opts.fetch(url, { ...init, signal: ctrl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

function pathFromRequest(req: Request, override: string | undefined): string {
  if (override !== undefined) return override.startsWith('/') ? override : '/' + override;
  try {
    return new URL(req.url).pathname;
  } catch {
    return '/';
  }
}

function notFound(): Response {
  return new Response(
    JSON.stringify({ error: { code: 'NOT_FOUND', message: 'route not allowed by proxy' } }),
    { status: 404, headers: { 'content-type': 'application/json' } }
  );
}

function methodNotAllowed(allowed: readonly string[]): Response {
  return new Response(
    JSON.stringify({
      error: { code: 'METHOD_NOT_ALLOWED', message: `proxy accepts: ${allowed.join(', ')}` }
    }),
    {
      status: 405,
      headers: { 'content-type': 'application/json', allow: allowed.join(', ') }
    }
  );
}

export function createLedricProxy(opts: LedricProxyOptions): LedricProxy {
  const r = resolve(opts);

  const assets: ProxyHandler = async (req, pathOverride) => {
    if (!r.assets.enabled) return notFound();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return methodNotAllowed(['GET', 'HEAD']);
    }
    const path = pathFromRequest(req, pathOverride);
    if (!path.startsWith('/assets/')) return notFound();
    const url = new URL(req.url);
    const upstream = await fetchUpstream(
      `${r.baseUrl}${path}${url.search}`,
      { method: req.method, headers: buildHeaders(req, r.readerKey ?? r.adminKey) },
      r
    );
    return buildResponse(upstream);
  };

  const content: ProxyHandler = async (req, pathOverride) => {
    if (!r.content.enabled) return notFound();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return methodNotAllowed(['GET', 'HEAD']);
    }
    const path = pathFromRequest(req, pathOverride);
    if (!path.startsWith('/entries/')) return notFound();

    const segments = path.slice('/entries/'.length).split('/').filter(Boolean);
    const typeName = segments[0];
    if (!typeName) return notFound();
    if (r.content.types !== null && !r.content.types.has(typeName)) return notFound();

    const url = new URL(req.url);
    const params = new URLSearchParams(url.search);
    if (r.content.forcePublished) params.set('published', '1');
    const search = params.toString();
    const qs = search ? `?${search}` : '';

    const upstream = await fetchUpstream(
      `${r.baseUrl}${path}${qs}`,
      { method: req.method, headers: buildHeaders(req, r.readerKey ?? r.adminKey) },
      r
    );
    return buildResponse(upstream);
  };

  const inlineEditor: ProxyHandler = async (req, pathOverride) => {
    if (!r.inlineEditor.enabled) return notFound();
    const path = pathFromRequest(req, pathOverride);
    if (!path.startsWith('/inline/')) return notFound();
    return forwardWithBody(req, path, r.adminKey ?? r.readerKey, r);
  };

  const admin: ProxyHandler = async (req, pathOverride) => {
    if (!r.admin.enabled) return notFound();
    const path = pathFromRequest(req, pathOverride);
    if (!path.startsWith('/admin/')) return notFound();
    return forwardWithBody(req, path, r.adminKey, r);
  };

  const handler: ProxyHandler = async (req, pathOverride) => {
    const path = pathFromRequest(req, pathOverride);
    if (path.startsWith('/assets/')) return assets(req, path);
    if (path.startsWith('/entries/')) return content(req, path);
    if (path.startsWith('/inline/')) return inlineEditor(req, path);
    if (path.startsWith('/admin/')) return admin(req, path);
    return notFound();
  };

  return { assets, content, inlineEditor, admin, handler };
}

async function forwardWithBody(
  req: Request,
  path: string,
  key: string | undefined,
  r: ResolvedOptions
): Promise<Response> {
  const url = new URL(req.url);
  // For methods with bodies, pipe through. For GET/HEAD, no body.
  const init: RequestInit = {
    method: req.method,
    headers: buildHeaders(req, key)
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = req.body;
    // Node's fetch needs duplex:'half' when streaming a request body.
    (init as { duplex?: 'half' }).duplex = 'half';
  }
  const upstream = await fetchUpstream(`${r.baseUrl}${path}${url.search}`, init, r);
  return buildResponse(upstream);
}
