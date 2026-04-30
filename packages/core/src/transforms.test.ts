import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  parseTransformParams,
  computeOutputFormat,
  applyTransforms,
  transformCacheKey,
  FsTransformCache,
  extForFormat,
  MAX_OUTPUT_DIMENSION
} from './transforms.js';

describe('parseTransformParams', () => {
  it('returns null when no recognized params are present', () => {
    expect(parseTransformParams({})).toBeNull();
    expect(parseTransformParams({ unrelated: 'value' })).toBeNull();
  });

  it('parses width and height as positive integers', () => {
    expect(parseTransformParams({ w: '400', h: '300' })).toEqual({
      w: 400,
      h: 300
    });
  });

  it('caps width and height at MAX_OUTPUT_DIMENSION', () => {
    const r = parseTransformParams({ w: '99999' });
    expect(r?.w).toBe(MAX_OUTPUT_DIMENSION);
  });

  it('drops negative or zero dimensions silently', () => {
    expect(parseTransformParams({ w: '0' })).toBeNull();
    expect(parseTransformParams({ w: '-50' })).toBeNull();
    expect(parseTransformParams({ w: 'banana' })).toBeNull();
  });

  it('normalizes fit aliases', () => {
    expect(parseTransformParams({ fit: 'cover' })?.fit).toBe('crop');
    expect(parseTransformParams({ fit: 'crop' })?.fit).toBe('crop');
    expect(parseTransformParams({ fit: 'contain' })?.fit).toBe('clip');
    expect(parseTransformParams({ fit: 'clip' })?.fit).toBe('clip');
    expect(parseTransformParams({ fit: 'gibberish' })).toBeNull();
  });

  it('normalizes jpeg → jpg in fm', () => {
    expect(parseTransformParams({ fm: 'jpeg' })?.fm).toBe('jpg');
    expect(parseTransformParams({ fm: 'jpg' })?.fm).toBe('jpg');
    expect(parseTransformParams({ fm: 'webp' })?.fm).toBe('webp');
    expect(parseTransformParams({ fm: 'avif' })?.fm).toBe('avif');
    expect(parseTransformParams({ fm: 'tiff' })).toBeNull();
  });

  it('only accepts auto=format', () => {
    expect(parseTransformParams({ auto: 'format' })?.auto).toBe('format');
    expect(parseTransformParams({ auto: 'compress' })).toBeNull();
  });

  it('clamps quality to 1..100', () => {
    expect(parseTransformParams({ q: '50' })?.q).toBe(50);
    expect(parseTransformParams({ q: '0' })).toBeNull();
    expect(parseTransformParams({ q: '101' })).toBeNull();
  });

  it('clamps dpr to 1..4', () => {
    expect(parseTransformParams({ dpr: '2' })?.dpr).toBe(2);
    expect(parseTransformParams({ dpr: '5' })).toBeNull();
    expect(parseTransformParams({ dpr: '0.5' })).toBeNull();
  });
});

describe('computeOutputFormat', () => {
  it('returns null for non-image mimes (passthrough)', () => {
    expect(computeOutputFormat('application/pdf', { w: 100 })).toBeNull();
    expect(computeOutputFormat('image/gif', { w: 100 })).toBeNull();
    expect(computeOutputFormat('image/svg+xml', { w: 100 })).toBeNull();
  });

  it('keeps source format when no fm/auto requested', () => {
    expect(computeOutputFormat('image/jpeg', { w: 100 })).toEqual({
      fm: 'jpg',
      mime: 'image/jpeg'
    });
    expect(computeOutputFormat('image/png', { w: 100 })).toEqual({
      fm: 'png',
      mime: 'image/png'
    });
  });

  it('honors explicit fm', () => {
    expect(computeOutputFormat('image/jpeg', { fm: 'webp' })?.mime).toBe(
      'image/webp'
    );
  });

  it('auto=format prefers avif when Accept allows it', () => {
    const r = computeOutputFormat(
      'image/jpeg',
      { auto: 'format' },
      { accept: 'image/avif,image/webp,image/*,*/*' }
    );
    expect(r?.fm).toBe('avif');
  });

  it('auto=format falls back to webp when avif is not in Accept', () => {
    const r = computeOutputFormat(
      'image/jpeg',
      { auto: 'format' },
      { accept: 'image/webp,image/*,*/*' }
    );
    expect(r?.fm).toBe('webp');
  });

  it('auto=format keeps source format when neither avif nor webp accepted', () => {
    const r = computeOutputFormat(
      'image/jpeg',
      { auto: 'format' },
      { accept: 'image/jpeg,*/*' }
    );
    expect(r?.fm).toBe('jpg');
  });

  it('explicit fm wins over auto=format', () => {
    const r = computeOutputFormat(
      'image/jpeg',
      { auto: 'format', fm: 'png' },
      { accept: 'image/avif' }
    );
    expect(r?.fm).toBe('png');
  });
});

describe('transformCacheKey', () => {
  it('returns a stable hash that is order-independent', () => {
    const a = transformCacheKey({ w: 400, h: 300, q: 80 }, 'webp');
    const b = transformCacheKey({ q: 80, h: 300, w: 400 }, 'webp');
    expect(a).toBe(b);
  });

  it('changes when the effective format changes', () => {
    const a = transformCacheKey({ w: 400 }, 'webp');
    const b = transformCacheKey({ w: 400 }, 'avif');
    expect(a).not.toBe(b);
  });

  it('changes when any dimension changes', () => {
    const a = transformCacheKey({ w: 400 }, 'webp');
    const b = transformCacheKey({ w: 401 }, 'webp');
    expect(a).not.toBe(b);
  });
});

describe('applyTransforms', () => {
  // 200x100 red png we make on the fly to avoid any test-fixture overhead.
  let source: Buffer;

  beforeEach(async () => {
    source = await sharp({
      create: {
        width: 200,
        height: 100,
        channels: 3,
        background: { r: 255, g: 0, b: 0 }
      }
    })
      .png()
      .toBuffer();
  });

  it('resizes inside a bounding box (fit=clip preserves aspect)', async () => {
    const out = await applyTransforms(
      source,
      { w: 80, h: 80 },
      'image/png'
    );
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(80);
    expect(meta.height).toBe(40); // 200x100 → 80x40 keeps aspect
  });

  it('crops to fill when fit=crop', async () => {
    const out = await applyTransforms(
      source,
      { w: 80, h: 80, fit: 'crop' },
      'image/png'
    );
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(80);
    expect(meta.height).toBe(80);
  });

  it('multiplies w/h by dpr', async () => {
    const out = await applyTransforms(
      source,
      { w: 100, dpr: 2 },
      'image/png'
    );
    const meta = await sharp(out.bytes).metadata();
    expect(meta.width).toBe(200);
  });

  it('converts format via fm=webp', async () => {
    const out = await applyTransforms(source, { fm: 'webp' }, 'image/png');
    expect(out.mime).toBe('image/webp');
    const meta = await sharp(out.bytes).metadata();
    expect(meta.format).toBe('webp');
  });

  it('throws for non-transformable source mimes', async () => {
    await expect(
      applyTransforms(source, { w: 100 }, 'application/pdf')
    ).rejects.toThrow(/not transformable/);
  });
});

describe('FsTransformCache', () => {
  let dir: string;
  let cache: FsTransformCache;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ledric-tx-'));
    cache = new FsTransformCache(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips bytes by (refKey, paramsHash, ext)', async () => {
    const bytes = Buffer.from('hello');
    await cache.put('refkey1', 'k1', 'webp', bytes);
    const got = await cache.get('refkey1', 'k1', 'webp');
    expect(got).not.toBeNull();
    expect(got?.equals(bytes)).toBe(true);
  });

  it('returns null on a cache miss', async () => {
    expect(await cache.get('abc', 'missing', 'webp')).toBeNull();
  });

  it('different ref_keys are distinct slots (no collision across versions)', async () => {
    await cache.put('rk-v1', 'k', 'webp', Buffer.from('v1'));
    await cache.put('rk-v2', 'k', 'webp', Buffer.from('v2'));
    const v1 = await cache.get('rk-v1', 'k', 'webp');
    const v2 = await cache.get('rk-v2', 'k', 'webp');
    expect(v1?.toString()).toBe('v1');
    expect(v2?.toString()).toBe('v2');
  });

  it('clear(refKey) removes every entry for a ref_key', async () => {
    await cache.put('rk-x', 'k1', 'webp', Buffer.from('a'));
    await cache.put('rk-x', 'k2', 'webp', Buffer.from('b'));
    await cache.clear('rk-x');
    expect(await cache.get('rk-x', 'k1', 'webp')).toBeNull();
    expect(await cache.get('rk-x', 'k2', 'webp')).toBeNull();
  });
});

describe('extForFormat', () => {
  it('maps every format to its canonical extension', () => {
    expect(extForFormat('jpg')).toBe('jpg');
    expect(extForFormat('png')).toBe('png');
    expect(extForFormat('webp')).toBe('webp');
    expect(extForFormat('avif')).toBe('avif');
  });
});
