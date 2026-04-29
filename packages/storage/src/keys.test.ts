import { describe, it, expect } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  parseApiKeyRole,
  looksLikeApiKey,
  ROLE_PREFIX
} from './keys.js';

describe('generateApiKey', () => {
  it('mints an admin key with the lka_ prefix', () => {
    const k = generateApiKey('admin');
    expect(k.role).toBe('admin');
    expect(k.secret.startsWith('lka_')).toBe(true);
    expect(k.prefix).toBe(k.secret.slice(0, 12));
  });

  it('mints a reader key with the lkr_ prefix', () => {
    const k = generateApiKey('reader');
    expect(k.role).toBe('reader');
    expect(k.secret.startsWith('lkr_')).toBe(true);
  });

  it('produces 32-byte sha256 hashes that match hashApiKey of the secret', () => {
    const k = generateApiKey('admin');
    expect(k.hash.byteLength).toBe(32);
    expect(Buffer.from(k.hash).equals(Buffer.from(hashApiKey(k.secret)))).toBe(
      true
    );
  });

  it('produces high-entropy, non-colliding secrets', () => {
    const set = new Set<string>();
    for (let i = 0; i < 256; i++) set.add(generateApiKey('admin').secret);
    expect(set.size).toBe(256);
  });

  it('uses the role prefix table consistently', () => {
    expect(generateApiKey('admin').secret.slice(0, 4)).toBe(ROLE_PREFIX.admin);
    expect(generateApiKey('reader').secret.slice(0, 4)).toBe(ROLE_PREFIX.reader);
  });
});

describe('parseApiKeyRole', () => {
  it('recovers admin from a real admin key', () => {
    const k = generateApiKey('admin');
    expect(parseApiKeyRole(k.secret)).toBe('admin');
  });
  it('recovers reader from a real reader key', () => {
    const k = generateApiKey('reader');
    expect(parseApiKeyRole(k.secret)).toBe('reader');
  });
  it('returns null for unknown shapes', () => {
    expect(parseApiKeyRole('')).toBeNull();
    expect(parseApiKeyRole('totally-not-a-key')).toBeNull();
    expect(parseApiKeyRole('lkz_anything')).toBeNull();
    // Wrong type — shouldn't crash
    expect(parseApiKeyRole(42 as unknown as string)).toBeNull();
  });
});

describe('looksLikeApiKey', () => {
  it('accepts well-shaped keys', () => {
    expect(looksLikeApiKey(generateApiKey('admin').secret)).toBe(true);
    expect(looksLikeApiKey(generateApiKey('reader').secret)).toBe(true);
  });
  it('rejects short or unprefixed strings', () => {
    expect(looksLikeApiKey('lka_')).toBe(false); // too short
    expect(looksLikeApiKey('plain')).toBe(false);
  });
});

describe('hashApiKey', () => {
  it('is deterministic for the same input', () => {
    const a = hashApiKey('lka_xyz');
    const b = hashApiKey('lka_xyz');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
  it('differs across inputs', () => {
    const a = hashApiKey('lka_a');
    const b = hashApiKey('lka_b');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});
