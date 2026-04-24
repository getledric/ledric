import type { TypeDef } from '@ledric/schema';

export function slugify(source: string): string {
  return source
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function deriveContent(
  def: TypeDef,
  content: Record<string, unknown>
): Record<string, unknown> {
  const out = { ...content };
  for (const [name, field] of Object.entries(def.fields)) {
    if (field.type !== 'slug') continue;
    if (typeof out[name] === 'string' && (out[name] as string).length > 0) continue;
    if (field.from === undefined) continue;
    const src = out[field.from];
    if (typeof src === 'string' && src.length > 0) {
      out[name] = slugify(src);
    }
  }
  return out;
}
