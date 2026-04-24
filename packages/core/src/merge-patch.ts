// RFC 7396 JSON Merge Patch — recursive merge where null values delete keys.
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null) return null;
  if (typeof patch !== 'object' || Array.isArray(patch)) return patch;

  const base =
    typeof target === 'object' && target !== null && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};

  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === null) {
      delete base[k];
    } else if (typeof v === 'object' && !Array.isArray(v)) {
      base[k] = applyMergePatch(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}
