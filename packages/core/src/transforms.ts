// On-the-fly image transforms — imgix-compatible URL params drive
// resize / format / quality conversions over libvips (sharp). Consumer
// HTML drives this; CMS content is never aware of the transform.
//
// Design:
//   - Pure helpers (parse, computeOutputMime, applyTransforms) live in
//     this file with no Core or storage dependency.
//   - A `TransformCache` interface defines the storage hook. The default
//     implementation, FsTransformCache, writes transformed bytes to disk
//     keyed by (refKey, paramsHash). The ref_key is the per-version
//     opaque id minted at upload/replace time, so cache entries from
//     stale versions are naturally addressable but never collide with
//     fresh ones. Other backends (memory, s3) plug in via the same
//     interface.
//   - Core.getTransformedAsset (in core.ts) ties it all together.

import { promises as fs } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

/** Subset of imgix-compatible knobs we support. */
export interface TransformParams {
  /** Output width in source pixels (multiplied by dpr at apply time). */
  w?: number;
  /** Output height in source pixels (multiplied by dpr at apply time). */
  h?: number;
  /**
   * Resize fit mode.
   *  - `clip` / `contain`: scale-to-fit, preserves aspect, may letterbox
   *  - `crop` / `cover`: fill exactly, may crop
   * Default: `clip`.
   */
  fit?: 'clip' | 'crop';
  /** Output quality (1-100), used for jpeg/webp/avif. Default: 80. */
  q?: number;
  /** Force output format. */
  fm?: 'jpg' | 'png' | 'webp' | 'avif';
  /** `format` picks best format from the request's Accept header. */
  auto?: 'format';
  /** Pixel-density multiplier applied to w/h. Default 1, max 4. */
  dpr?: number;
}

/** Per-request context that influences output (currently just Accept). */
export interface TransformContext {
  /** Browser Accept header — used for auto=format negotiation. */
  accept?: string;
}

/** Largest output dimension we'll honor — bounds DoS surface. */
export const MAX_OUTPUT_DIMENSION = 4096;

/** Mime types we'll actually transform. Everything else passes through. */
const TRANSFORMABLE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif'
]);

const FORMAT_MIME: Record<NonNullable<TransformParams['fm']>, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif'
};

const FORMAT_EXT: Record<NonNullable<TransformParams['fm']>, string> = {
  jpg: 'jpg',
  png: 'png',
  webp: 'webp',
  avif: 'avif'
};

/**
 * Read a query bag and produce a normalized TransformParams. Returns
 * null when no recognized transform params are present, so callers can
 * cheaply skip the transform path entirely.
 *
 * Unknown / out-of-range params are silently dropped — the URL stays
 * stable across server upgrades that add params, and a typo doesn't
 * break the response.
 */
export function parseTransformParams(
  query: Record<string, string | string[] | undefined>
): TransformParams | null {
  const out: TransformParams = {};
  let any = false;

  const get = (k: string): string | undefined => {
    const v = query[k];
    if (Array.isArray(v)) return v[0];
    return v;
  };

  const w = parsePositiveInt(get('w'));
  if (w !== null) {
    out.w = Math.min(MAX_OUTPUT_DIMENSION, w);
    any = true;
  }
  const h = parsePositiveInt(get('h'));
  if (h !== null) {
    out.h = Math.min(MAX_OUTPUT_DIMENSION, h);
    any = true;
  }

  const fit = get('fit');
  if (fit === 'clip' || fit === 'contain') {
    out.fit = 'clip';
    any = true;
  } else if (fit === 'crop' || fit === 'cover') {
    out.fit = 'crop';
    any = true;
  }

  const q = parsePositiveInt(get('q'));
  if (q !== null && q >= 1 && q <= 100) {
    out.q = q;
    any = true;
  }

  const fm = get('fm');
  if (fm === 'jpg' || fm === 'jpeg') {
    out.fm = 'jpg';
    any = true;
  } else if (fm === 'png' || fm === 'webp' || fm === 'avif') {
    out.fm = fm;
    any = true;
  }

  if (get('auto') === 'format') {
    out.auto = 'format';
    any = true;
  }

  const dpr = parseFloat(get('dpr') ?? '');
  if (Number.isFinite(dpr) && dpr >= 1 && dpr <= 4) {
    out.dpr = dpr;
    any = true;
  }

  return any ? out : null;
}

function parsePositiveInt(s: string | undefined): number | null {
  if (s === undefined || s === '') return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Decide which output format the response will have, given source mime
 * + params + Accept header. Pure/synchronous — used for caching keys
 * and Content-Type before we actually pay the libvips cost.
 *
 * Returns null if the source isn't transformable; the caller should
 * pass the source bytes through unchanged.
 */
export function computeOutputFormat(
  sourceMime: string,
  params: TransformParams,
  ctx: TransformContext = {}
): { fm: NonNullable<TransformParams['fm']>; mime: string } | null {
  if (!TRANSFORMABLE_MIMES.has(sourceMime)) return null;

  let fm: TransformParams['fm'] | undefined = params.fm;

  if (!fm && params.auto === 'format' && ctx.accept) {
    const accept = ctx.accept.toLowerCase();
    if (accept.includes('image/avif')) fm = 'avif';
    else if (accept.includes('image/webp')) fm = 'webp';
  }

  if (!fm) {
    // No conversion requested — keep source format.
    if (sourceMime === 'image/jpeg') fm = 'jpg';
    else if (sourceMime === 'image/png') fm = 'png';
    else if (sourceMime === 'image/webp') fm = 'webp';
    else if (sourceMime === 'image/avif') fm = 'avif';
    else return null;
  }

  return { fm, mime: FORMAT_MIME[fm] };
}

/**
 * Run libvips with the requested transforms. Returns transformed bytes
 * + the final mime. Caller should have already checked that the source
 * mime is transformable; if it isn't, this throws.
 */
export async function applyTransforms(
  bytes: Uint8Array,
  params: TransformParams,
  sourceMime: string,
  ctx: TransformContext = {}
): Promise<{ bytes: Buffer; mime: string }> {
  const fmt = computeOutputFormat(sourceMime, params, ctx);
  if (fmt === null) {
    throw new Error(`Source mime "${sourceMime}" is not transformable`);
  }

  let pipeline = sharp(Buffer.from(bytes), { failOn: 'truncated' });

  // Resize
  if (params.w !== undefined || params.h !== undefined) {
    const dpr = params.dpr ?? 1;
    const w = params.w !== undefined ? Math.round(params.w * dpr) : undefined;
    const h = params.h !== undefined ? Math.round(params.h * dpr) : undefined;
    pipeline = pipeline.resize({
      ...(w !== undefined ? { width: Math.min(MAX_OUTPUT_DIMENSION, w) } : {}),
      ...(h !== undefined ? { height: Math.min(MAX_OUTPUT_DIMENSION, h) } : {}),
      fit: params.fit === 'crop' ? 'cover' : 'inside',
      withoutEnlargement: false
    });
  }

  const q = params.q ?? 80;

  if (fmt.fm === 'jpg') {
    pipeline = pipeline.jpeg({ quality: q, mozjpeg: true });
  } else if (fmt.fm === 'png') {
    // PNG is lossless; quality knob does nothing meaningful.
    pipeline = pipeline.png({ compressionLevel: 9 });
  } else if (fmt.fm === 'webp') {
    pipeline = pipeline.webp({ quality: q });
  } else if (fmt.fm === 'avif') {
    pipeline = pipeline.avif({ quality: q });
  }

  const out = await pipeline.toBuffer();
  return { bytes: out, mime: fmt.mime };
}

/**
 * Stable hash for a normalized transform spec — used as the cache key.
 * The effective output format must be included so that auto=format with
 * different Accept headers gets separate cache entries.
 */
export function transformCacheKey(
  params: TransformParams,
  effectiveFm: NonNullable<TransformParams['fm']>
): string {
  const normalized = {
    w: params.w ?? null,
    h: params.h ?? null,
    fit: params.fit ?? null,
    q: params.q ?? null,
    fm: effectiveFm,
    dpr: params.dpr ?? null
  };
  const json = JSON.stringify(normalized, Object.keys(normalized).sort());
  return createHash('sha1').update(json).digest('hex').slice(0, 16);
}

/**
 * Pluggable cache for transformed bytes. Keyed by (refKey, paramsHash).
 * The ref_key is the per-version opaque id, so distinct versions always
 * land in distinct cache slots — no stale-version reuse.
 */
export interface TransformCache {
  get(refKey: string, key: string, ext: string): Promise<Buffer | null>;
  put(refKey: string, key: string, ext: string, bytes: Buffer): Promise<void>;
  /**
   * Drop every cached entry for a ref_key. Optional — implementations
   * that can't easily enumerate may no-op. Used by clearTransformCache
   * when the operator wants to reclaim space without restarting.
   */
  clear(refKey: string): Promise<void>;
}

/**
 * Disk-backed transform cache. Layout:
 *   <root>/<refKey>/<paramsHash>.<ext>
 */
export class FsTransformCache implements TransformCache {
  constructor(private readonly root: string) {}

  /** Where this cache writes its files — exposed for diagnostics. */
  get rootPath(): string {
    return this.root;
  }

  private fileFor(refKey: string, key: string, ext: string): string {
    return join(this.root, refKey, `${key}.${ext}`);
  }

  async get(refKey: string, key: string, ext: string): Promise<Buffer | null> {
    const path = this.fileFor(refKey, key, ext);
    try {
      return await fs.readFile(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async put(
    refKey: string,
    key: string,
    ext: string,
    bytes: Buffer
  ): Promise<void> {
    const path = this.fileFor(refKey, key, ext);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, bytes);
  }

  async clear(refKey: string): Promise<void> {
    const dir = join(this.root, refKey);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Filesystem-friendly extension for a given format token. */
export function extForFormat(fm: NonNullable<TransformParams['fm']>): string {
  return FORMAT_EXT[fm];
}
