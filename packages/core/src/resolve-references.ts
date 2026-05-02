import type { FieldDef, TypeDef } from '@ledric/schema';
import type { Storage } from '@ledric/storage';

export interface ResolvedReference {
  id: string;
  type: string;
  slug: string;
  version: number;
  fields: Record<string, unknown>;
}

function isReferencesField(field: FieldDef): boolean {
  return field.type === 'references';
}

/**
 * "type/slug" or "type/slug@version". Returns null on a malformed input
 * — caller treats that as an unresolvable reference and emits null.
 */
function parseReferenceString(raw: unknown): {
  type: string;
  slug: string;
  version?: number;
} | null {
  if (typeof raw !== 'string') return null;
  const slashAt = raw.indexOf('/');
  if (slashAt <= 0 || slashAt === raw.length - 1) return null;
  const type = raw.slice(0, slashAt);
  let slug = raw.slice(slashAt + 1);
  let version: number | undefined;
  const atAt = slug.lastIndexOf('@');
  if (atAt > 0) {
    const v = Number(slug.slice(atAt + 1));
    if (Number.isInteger(v) && v > 0) {
      version = v;
      slug = slug.slice(0, atAt);
    }
  }
  return { type, slug, ...(version !== undefined ? { version } : {}) };
}

async function resolveOne(
  raw: unknown,
  storage: Storage
): Promise<ResolvedReference | null> {
  const parsed = parseReferenceString(raw);
  if (parsed === null) return null;
  const opts: { version?: number } = {};
  if (parsed.version !== undefined) opts.version = parsed.version;
  const entry = await storage.readEntry({ type: parsed.type, slug: parsed.slug }, opts);
  if (!entry) return null;
  return {
    id: Buffer.from(entry.id).toString('hex'),
    type: entry.type,
    slug: entry.slug,
    version: entry.version,
    fields: entry.content
  };
}

/**
 * Replace `references`-typed fields in `content` with resolved entry
 * objects. Symmetric to resolveAssets — reference fields hold string[]
 * of "type/slug" (optionally "type/slug@version"); after resolution
 * each becomes a slim entry record with `{ id, type, slug, version,
 * fields }`. Unresolvable refs become null in the same array slot so
 * the caller can render a graceful gap.
 *
 * `resolve` is the same shape as resolveAssets's `expand`:
 *   - true       → every references-typed field on the type
 *   - string[]   → only those field names
 *   - false/undef → no-op (content unchanged)
 *
 * Resolution is shallow: targets are returned as-stored, without any
 * further expand_assets / resolve_references pass on their fields.
 * Recursive expansion is a v0.2 feature (with cycle detection).
 */
export async function resolveReferences(
  content: Record<string, unknown>,
  type: TypeDef,
  storage: Storage,
  resolve: boolean | readonly string[] | undefined
): Promise<Record<string, unknown>> {
  if (resolve === undefined || resolve === false) return content;

  const targets = resolve === true
    ? Object.entries(type.fields)
        .filter(([, f]) => isReferencesField(f))
        .map(([name]) => name)
    : Array.from(resolve);

  if (targets.length === 0) return content;

  const out: Record<string, unknown> = { ...content };
  for (const name of targets) {
    const field = type.fields[name];
    if (!field || !isReferencesField(field)) continue;
    const value = content[name];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) continue;
    out[name] = await Promise.all(value.map((v) => resolveOne(v, storage)));
  }
  return out;
}
