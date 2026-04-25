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
  ListAssetsOptions
} from './types.js';

export interface LedricClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
}

export class LedricError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    public readonly body: unknown,
    message: string
  ) {
    super(message);
    this.name = 'LedricError';
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

export class LedricClient {
  readonly baseUrl: string;
  private readonly _fetch: typeof globalThis.fetch;
  private readonly _headers: Record<string, string>;

  constructor(opts: LedricClientOptions) {
    this.baseUrl = trimSlash(opts.baseUrl);
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this._headers = { Accept: 'application/json', ...(opts.headers ?? {}) };
  }

  /** GET /entries/:type/:slug — returns null on 404, follows redirects transparently. */
  async read<F = Record<string, unknown>>(
    ref: EntryRef,
    opts: ReadOptions = {}
  ): Promise<Entry<F> | null> {
    const { type, slug } = parseRef(ref);
    const qs = opts.version !== undefined ? `?version=${encodeURIComponent(opts.version)}` : '';
    const url = `${this.baseUrl}/entries/${encodeURIComponent(type)}/${encodeURIComponent(slug)}${qs}`;
    const res = await this._fetch(url, { headers: this._headers });
    if (res.status === 404) return null;
    if (!res.ok) await this._raise(res, url);
    return (await res.json()) as Entry<F>;
  }

  /** GET /entries/:type — returns the find result. */
  async find<F = Record<string, unknown>>(
    type: string,
    opts: FindOptions = {}
  ): Promise<FindResult<F>> {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.offset !== undefined) params.set('offset', String(opts.offset));
    const qs = params.toString() ? `?${params.toString()}` : '';
    const url = `${this.baseUrl}/entries/${encodeURIComponent(type)}${qs}`;
    const res = await this._fetch(url, { headers: this._headers });
    if (!res.ok) await this._raise(res, url);
    return (await res.json()) as FindResult<F>;
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

  /** GET /assets/:id/meta — asset metadata only. */
  async asset(id: string): Promise<Asset | null> {
    const url = `${this.baseUrl}/assets/${encodeURIComponent(id)}/meta`;
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
    const qs = params.toString() ? `?${params.toString()}` : '';
    const url = `${this.baseUrl}/assets${qs}`;
    const res = await this._fetch(url, { headers: this._headers });
    if (!res.ok) await this._raise(res, url);
    return (await res.json()) as ListAssetsResult;
  }

  /** Build an absolute asset URL. Pure helper — no fetch. */
  assetUrl(id: string, opts: { version?: number } = {}): string {
    const qs = opts.version !== undefined ? `?version=${encodeURIComponent(opts.version)}` : '';
    return `${this.baseUrl}/assets/${encodeURIComponent(id)}${qs}`;
  }

  /** Fetch raw asset bytes as a Uint8Array. Returns null on 404. */
  async assetBytes(id: string, opts: { version?: number } = {}): Promise<Uint8Array | null> {
    const url = this.assetUrl(id, opts);
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
