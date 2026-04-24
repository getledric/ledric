import { createHash } from 'node:crypto';

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map(
        (k) =>
          JSON.stringify(k) +
          ':' +
          canonicalStringify((value as Record<string, unknown>)[k])
      )
      .join(',') +
    '}'
  );
}

export function contentHash(content: Record<string, unknown>): Uint8Array {
  return new Uint8Array(createHash('sha256').update(canonicalStringify(content)).digest());
}
