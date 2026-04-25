import type { FieldDef, TypeDef } from '@ledric/schema';
import type { Storage, AssetMeta } from '@ledric/storage';

export interface ResolvedAsset {
  id: string;
  kind: string;
  storage_ref: string;
  meta: AssetMeta;
  url: string;
}

function isAssetField(field: FieldDef): boolean {
  if (field.type === 'asset') return true;
  if (field.type === 'array' && field.of.type === 'asset') return true;
  return false;
}

const HEX_ID_RE = /^[0-9a-f]{32}$/i;

async function expandOne(
  raw: unknown,
  storage: Storage
): Promise<ResolvedAsset | null> {
  if (typeof raw !== 'string' || !HEX_ID_RE.test(raw)) return null;
  const idBytes = Buffer.from(raw, 'hex');
  const asset = await storage.getAsset(new Uint8Array(idBytes));
  if (!asset) return null;
  return {
    id: raw,
    kind: asset.kind,
    storage_ref: asset.storage_ref,
    meta: asset.meta,
    url: `/assets/${raw}`
  };
}

/**
 * Replace asset-typed fields in `content` with resolved asset objects.
 * `expand` chooses what to expand:
 *   - true       → every asset-typed field on the type
 *   - string[]   → only those field names
 *   - false/undef → no-op (returns content unchanged)
 *
 * Unresolvable values (placeholder strings, missing assets) become `null`
 * so the caller can show a graceful "missing image" state without
 * second-guessing the field type.
 */
export async function resolveAssets(
  content: Record<string, unknown>,
  type: TypeDef,
  storage: Storage,
  expand: boolean | readonly string[] | undefined
): Promise<Record<string, unknown>> {
  if (expand === undefined || expand === false) return content;

  const targets = expand === true
    ? Object.entries(type.fields)
        .filter(([, f]) => isAssetField(f))
        .map(([name]) => name)
    : Array.from(expand);

  if (targets.length === 0) return content;

  const out: Record<string, unknown> = { ...content };
  for (const name of targets) {
    const field = type.fields[name];
    if (!field || !isAssetField(field)) continue;
    const value = content[name];
    if (value === undefined || value === null) continue;

    if (field.type === 'asset') {
      out[name] = await expandOne(value, storage);
    } else if (field.type === 'array') {
      if (!Array.isArray(value)) continue;
      out[name] = await Promise.all(value.map((v) => expandOne(v, storage)));
    }
  }
  return out;
}
