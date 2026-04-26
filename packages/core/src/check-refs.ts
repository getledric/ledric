import type { TypeDef } from '@ledric/schema';
import type { Storage } from '@ledric/storage';
import { parseRef } from './parse-ref.js';
import type { ValidationError } from './validate.js';

/**
 * Walk every `references`-field value in `content` and verify each ref
 * string parses, the target entry exists, and the target's type is in
 * the field's `to: [...]` allow-list.
 *
 * Returns one ValidationError per problem. The caller decides whether to
 * surface them as warnings (draft path) or errors (publish path).
 *
 * Pinned refs (`type/slug@version`) check that specific version exists.
 * Unpinned refs check the current version.
 */
export async function checkStructuralRefs(
  content: Record<string, unknown>,
  type: TypeDef,
  storage: Storage
): Promise<ValidationError[]> {
  const issues: ValidationError[] = [];

  for (const [name, field] of Object.entries(type.fields)) {
    if (field.type !== 'references') continue;
    const value = content[name];
    if (!Array.isArray(value)) continue;

    for (let i = 0; i < value.length; i++) {
      const ref = value[i];
      const path = `/${name}/${i}`;
      if (typeof ref !== 'string' || ref.length === 0) continue;

      const parsed = parseRef(ref);
      if (parsed === null) {
        issues.push({
          path,
          code: 'unrecognized_ref_format',
          message: `Reference "${ref}" must be "type/slug" or "type/slug@version".`,
          actual: ref
        });
        continue;
      }

      const opts =
        parsed.version !== undefined ? { version: parsed.version } : undefined;
      let entry: Awaited<ReturnType<Storage['readEntry']>> = null;
      try {
        entry = await storage.readEntry(
          { type: parsed.type, slug: parsed.slug },
          opts
        );
      } catch {
        entry = null;
      }

      if (!entry) {
        issues.push({
          path,
          code:
            parsed.version !== undefined
              ? 'reference_version_not_found'
              : 'reference_not_found',
          message:
            parsed.version !== undefined
              ? `Reference "${ref}" — entry "${parsed.type}/${parsed.slug}" has no version ${parsed.version}.`
              : `Reference "${ref}" doesn't point to an existing entry.`,
          actual: ref
        });
        continue;
      }

      if (!field.to.includes(entry.type)) {
        issues.push({
          path,
          code: 'reference_type_not_allowed',
          message: `Reference "${ref}" points to type "${entry.type}", but this field accepts only: ${field.to.join(', ')}.`,
          actual: entry.type,
          expected: field.to
        });
      }
    }
  }

  return issues;
}
