// Tag normalization. Tags are stored as a (slug, label) pair:
//   - slug  = canonical, lowercased, URL-safe form. Used for matching,
//             filtering, and as the stable identity.
//   - label = whatever case the first author wrote. Preserved across
//             subsequent uses; relabel via update_tag.
//
// "Featured Event", "#featured event", "FEATURED EVENT", "featured-event"
// all normalize to slug = "featured-event". Whichever spelling lands
// first wins the label.

export interface NormalizedTag {
  slug: string;
  label: string;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
const LABEL_MAX = 64;

/**
 * Normalize a free-form tag string into { slug, label }. Returns null
 * if the input can't be coerced into a valid tag — caller decides
 * whether to throw or silently drop.
 */
export function normalizeTag(input: unknown): NormalizedTag | null {
  if (typeof input !== 'string') return null;

  // Strip leading # characters and trim/collapse whitespace, but keep
  // case for the label.
  const label = input
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (label.length === 0 || label.length > LABEL_MAX) return null;

  const slug = label
    .toLowerCase()
    // Drop characters we don't allow in slugs. Keeps a-z0-9, whitespace,
    // hyphen, underscore. Everything else gets stripped silently — the
    // operator typed something we can't store, but we still try to make
    // a sensible slug from what's left.
    .replace(/[^a-z0-9\s_-]/g, '')
    // Whitespace runs become single hyphens.
    .replace(/\s+/g, '-')
    // Collapse hyphen runs left over from earlier substitutions.
    .replace(/-+/g, '-')
    // Trim leading/trailing hyphens or underscores so the slug doesn't
    // start or end with punctuation.
    .replace(/^[-_]+|[-_]+$/g, '');

  if (!SLUG_RE.test(slug)) return null;
  return { slug, label };
}

/**
 * Normalize an array of tag inputs, dropping nulls and de-duplicating
 * by slug. Last write of a given slug keeps its label (because the dedupe
 * runs forward — but in practice all-same-slug inputs share a label
 * anyway, so this is mostly a safety net).
 */
export function normalizeTags(inputs: readonly unknown[]): NormalizedTag[] {
  const seen = new Map<string, NormalizedTag>();
  for (const raw of inputs) {
    const t = normalizeTag(raw);
    if (t === null) continue;
    if (!seen.has(t.slug)) seen.set(t.slug, t);
  }
  return Array.from(seen.values());
}
