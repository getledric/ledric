import type {
  Entry,
  EntryRef,
  FindResult,
  FindOptions,
  ReadOptions,
  TypeDescription,
  DescribeModel,
  Asset,
  ListAssetsResult,
  ListAssetsOptions,
  AssetTransformOptions,
  TagInfo,
  TagWithCounts,
  LedricEntries
} from './types.js';

export interface LedricClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

export interface LedricApiError {
  code?: string;
  message?: string;
  errors?: Array<{
    path: string;
    code: string;
    message: string;
    expected?: unknown;
    actual?: unknown;
  }>;
  [k: string]: unknown;
}

export class LedricError extends Error {
  /** Stable error code from the API (e.g. VALIDATION_FAILED, VERSION_CONFLICT). */
  readonly code: string;
  /** Per-field errors when the server returned them (validator failures). */
  readonly errors: NonNullable<LedricApiError['errors']>;

  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: unknown,
    message: string
  ) {
    super(message);
    this.name = 'LedricError';
    const apiError =
      body !== null && typeof body === 'object' && 'error' in body
        ? ((body as { error?: LedricApiError }).error ?? {})
        : (body as LedricApiError | null) ?? {};
    this.code = typeof apiError.code === 'string' ? apiError.code : 'TOOL_ERROR';
    this.errors = Array.isArray(apiError.errors) ? apiError.errors : [];
  }
}

function parseRef(ref: EntryRef): { type: string; slug: string } {
  if (typeof ref === 'string') {
    const ix = ref.indexOf('/');
    if (ix === -1) {
      throw new Error(`Ref must be "type/slug" (got "${ref}")`);
    }
    return { type: ref.slice(0, ix), slug: ref.slice(ix + 1) };
  }
  return ref;
}

function trimSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function buildAssetQueryString(opts: AssetTransformOptions): string {
  const params = new URLSearchParams();
  if (opts.version !== undefined) params.set('version', String(opts.version));
  if (opts.w !== undefined) params.set('w', String(opts.w));
  if (opts.h !== undefined) params.set('h', String(opts.h));
  if (opts.fit !== undefined) params.set('fit', opts.fit);
  if (opts.q !== undefined) params.set('q', String(opts.q));
  if (opts.fm !== undefined) params.set('fm', opts.fm);
  if (opts.auto !== undefined) params.set('auto', opts.auto);
  if (opts.dpr !== undefined) params.set('dpr', String(opts.dpr));
  const s = params.toString();
  return s ? `?${s}` : '';
}

export class LedricClient {
  readonly baseUrl: string;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _headers: Record<string, string>;

  constructor(opts: LedricClientOptions) {
    this.baseUrl = trimSlash(opts.baseUrl);
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this._headers = { Accept: 'application/json', ...(opts.headers ?? {}) };
  }

  /**
   * GET /entries/:type/:slug — returns null on 404, follows redirects transparently.
   *
   * When `LedricEntries` has been augmented (via `ledric types
   * --augment-sdk`) and the caller passes a known type-name string,
   * the return type is inferred to that interface. Otherwise the
   * caller can pass an explicit field-shape generic.
   */
  async read<T extends keyof LedricEntries & string>(
    ref: `${T}/${string}` | { type: T; slug: string },
    opts?: ReadOptions
  ): Promise<Entry<LedricEntries[T]> | null>;
  async read<F = Record<string, unknown>>(
    ref: EntryRef,
    opts?: ReadOptions
  ): Promise<Entry<F> | null>;
  async read(
    ref: EntryRef,
    opts: ReadOptions = {}
  ): Promise<Entry<Record<string, unknown>> | null> {
    const { type, slug } = parseRef(ref);
    const params = new URLSearchParams();
    if (opts.version !== undefined) params.set('version', String(opts.version));
    if (opts.locale !== undefined) params.set('locale', opts.locale);
    if (opts.expandAssets !== undefined) {
      params.set(
        'expand_assets',
        opts.expandAssets === true ? '1'
          : opts.expandAssets === false ? '0'
          : opts.expandAssets.join(',')
      );
    }
    if (opts.resolveRefs === true) params.set('resolve_refs', '1');
    const qs = params.toString() ? `?${params.toString()}` : '';
    const url = `${this.baseUrl}/entries/${encodeURIComponent(type)}/${encodeURIComponent(slug)}${qs}`;
    const res = await this._fetch(url, { headers: this._headers });
    if (res.status === 404) return null;
    if (!res.ok) await this._raise(res, url);
    return (await res.json()) as Entry<Record<string, unknown>>;
  }

  /**
   * GET /entries/:type — returns the find result.
   *
   * As with `read`, when `LedricEntries` has been augmented and the
   * caller passes a known type-name string, the return type is
   * inferred to that interface. Otherwise pass an explicit
   * field-shape generic.
   */
  async find<T extends keyof LedricEntries & string>(
    type: T,
    opts?: FindOptions
  ): Promise<FindResult<LedricEntries[T]>>;
  async find<F = Record<string, unknown>>(
    type: string,
    opts?: FindOptions
  ): Promise<FindResult<F>>;
  async find(
    type: string,
    opts: FindOptions = {}
  ): Promise<FindResult<Record<string, unknown>>> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    if (opts.locale !== undefined) params.set('locale', opts.locale);
    if (opts.expandAssets !== undefined) {
      params.set(
        'expand_assets',
        opts.expandAssets === true ? '1'
          : opts.expandAssets === false ? '0'
          : opts.expandAssets.join(',')
      );
    }
    if (opts.resolveRefs === true) params.set('resolve_refs', '1');
    if (opts.published === true) params.set('published', '1');
    if (opts.summary === true) params.set('summary', '1');
    if (opts.tags) for (const t of opts.tags) params.append('tag', t);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const url = `${this.baseUrl}/entries/${encodeURIComponent(type)}${qs}`;
    const res = await this._fetch(url, { headers: this._headers });
    if (!res.ok) await this._raise(res, url);
    return (await res.json()) as FindResult<Record<string, unknown>>;
  }

  /** GET /types — full content model. */
  async types(): Promise<DescribeModel> {
    const url = `${this.baseUrl}/types`;
    const res = await this._fetch(url, { headers: this._headers });
    if (!res.ok) await this._raise(res, url);
    return (await res.json()) as DescribeModel;
  }

  /** GET /types/:name — single type detail (or null). */
  async type(name: string): Promise<TypeDescription | null> {
    const url = `${this.baseUrl}/types/${encodeURIComponent(name)}`;
    const res = await this._fetch(url, { headers: this._headers });
    if (res.status === 404) return null;
    if (!res.ok) await this._raise(res, url);
    return (await res.json()) as TypeDescription;
  }

  /**
   * GET /assets/:key/meta — fetch asset metadata. Accepts either an
   * asset id (stable handle that lives in entry content) or a ref_key
   * (per-version URL key). The server dual-looks-up.
   */
  async asset(key: string): Promise<Asset | null> {
    const url = `${this.baseUrl}/assets/${encodeURIComponent(key)}/meta`;
    const res = await this._fetch(url, { headers: this._headers });
    if (res.status === 404) return null;
    if (!res.ok) await this._raise(res, url);
    return (await res.json()) as Asset;
  }

  /** GET /assets — list assets. */
  async assets(opts: ListAssetsOptions = {}): Promise<ListAssetsResult> {
    const params = new URLSearchParams();
    if (opts.kind !== undefined) params.set('kind', opts.kind);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    if (opts.tags) for (const t of opts.tags) params.append('tag', t);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const url = `${this.baseUrl}/assets${qs}`;
    const res = await this._fetch(url, { headers: this._headers });
    if (!res.ok) await this._raise(res, url);
    return (await res.json()) as ListAssetsResult;
  }

  /** GET /tags — every tag in the env with usage counts. */
  async tags(): Promise<TagWithCounts[]> {
    const url = `${this.baseUrl}/tags`;
    const res = await this._fetch(url, { headers: this._headers });
    if (!res.ok) await this._raise(res, url);
    return (await res.json()) as TagWithCounts[];
  }

  /** Add tags to an asset. Inputs are free-form strings; server normalizes. */
  async addAssetTags(id: string, tags: string[]): Promise<TagInfo[]> {
    return this.rpc<TagInfo[]>('add_asset_tags', { id, tags });
  }
  async removeAssetTags(id: string, tags: string[]): Promise<{ removed: number }> {
    return this.rpc<{ removed: number }>('remove_asset_tags', { id, tags });
  }
  async addEntryTags(ref: EntryRef, tags: string[]): Promise<TagInfo[]> {
    return this.rpc<TagInfo[]>('add_entry_tags', { ref: parseRef(ref), tags });
  }
  async removeEntryTags(ref: EntryRef, tags: string[]): Promise<{ removed: number }> {
    return this.rpc<{ removed: number }>('remove_entry_tags', { ref: parseRef(ref), tags });
  }
  async updateTag(slug: string, label: string): Promise<TagInfo | null> {
    return this.rpc<TagInfo | null>('update_tag', { slug, label });
  }

  /**
   * Build an absolute asset URL with optional imgix-style transforms.
   * Accepts either a resolved asset object (preferred — uses its
   * `ref_key`) or a bare ref_key hex string. Never takes a raw asset
   * id — those don't have URLs of their own; resolve via expand_assets
   * or `client.asset(id)` first.
   *
   * Pure helper. Safe on both server (Astro/SSR) and browser.
   */
  assetUrl(
    refKeyOrAsset: string | { ref_key: string },
    opts: AssetTransformOptions = {}
  ): string {
    const refKey =
      typeof refKeyOrAsset === 'string' ? refKeyOrAsset : refKeyOrAsset.ref_key;
    const qs = buildAssetQueryString(opts);
    return `${this.baseUrl}/assets/${encodeURIComponent(refKey)}${qs}`;
  }

  /** Fetch raw asset bytes as a Uint8Array. Returns null on 404. */
  async assetBytes(
    refKeyOrAsset: string | { ref_key: string },
    opts: AssetTransformOptions = {}
  ): Promise<Uint8Array | null> {
    const url = this.assetUrl(refKeyOrAsset, opts);
    const res = await this._fetch(url, { headers: this._headers });
    if (res.status === 404) return null;
    if (!res.ok) await this._raise(res, url);
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf);
  }

  /** Escape hatch: POST /rpc { tool, args } for write tools and anything not surfaced above. */
  async rpc<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.baseUrl}/rpc`;
    const res = await this._fetch(url, {
      method: 'POST',
      headers: { ...this._headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool, args })
    });
    const body = (await res.json()) as { result?: T; error?: { code?: string; message?: string } };
    if (!res.ok || body.error) {
      const msg = body.error?.message ?? `${tool} failed (${res.status})`;
      throw new LedricError(res.status, url, body, msg);
    }
    return body.result as T;
  }

  private async _raise(res: Response, url: string): Promise<never> {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      try {
        body = await res.text();
      } catch {
        /* ignore */
      }
    }
    throw new LedricError(res.status, url, body, `HTTP ${res.status} for ${url}`);
  }
}

export function createLedricClient(opts: LedricClientOptions): LedricClient {
  return new LedricClient(opts);
}
