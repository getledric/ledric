// Helpers for sprinkling ledric ref markers onto rendered HTML so the
// inline editor (served at /admin/inline.js) can find what to edit.
//
// Convention:
//   data-ledric-ref="type/slug"
//   data-ledric-field="title"   (optional — focuses one field on open)
//
// These are pure helpers. They never reach the network.

export interface RefSource {
  type: string;
  slug: string;
}

/**
 * Build the data-attribute object for a given entry. Pass `field` to
 * mark a specific field on the element. Returns an empty object if
 * `entry` is falsy — convenient when templating against possibly-null
 * data without conditional spreads.
 */
export function refAttrs(
  entry: RefSource | null | undefined,
  field?: string
): Record<string, string> {
  if (!entry || typeof entry.type !== 'string' || typeof entry.slug !== 'string') {
    return {};
  }
  const out: Record<string, string> = {
    'data-ledric-ref': `${entry.type}/${entry.slug}`
  };
  if (typeof field === 'string' && field.length > 0) {
    out['data-ledric-field'] = field;
  }
  return out;
}

/**
 * Same as refAttrs, but pre-rendered as a string for direct interpolation
 * into HTML templates: `<h1 ${refAttrsHtml(post, 'title')}>...</h1>`.
 * Returns an empty string for missing input.
 */
export function refAttrsHtml(
  entry: RefSource | null | undefined,
  field?: string
): string {
  const attrs = refAttrs(entry, field);
  const keys = Object.keys(attrs);
  if (keys.length === 0) return '';
  return keys
    .map((k) => `${k}="${escapeAttr(attrs[k] as string)}"`)
    .join(' ');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
