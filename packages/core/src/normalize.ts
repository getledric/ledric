import type { FieldDef, TypeDef } from '@ledric/schema';

export function normalizeTypeDef(def: TypeDef): TypeDef {
  const fields: Record<string, FieldDef> = {};
  for (const [name, f] of Object.entries(def.fields)) {
    fields[name] = normalizeField(f);
  }
  return { ...def, fields };
}

export function normalizeField(f: FieldDef): FieldDef {
  switch (f.type) {
    case 'markdown':
      return { html: 'sanitize', ...f };
    case 'references':
      return { pinning: 'auto', ...f };
    case 'array':
      return { ...f, of: normalizeField(f.of) };
    default:
      return f;
  }
}
