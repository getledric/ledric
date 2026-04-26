/**
 * A parsed structural reference. Used in two places:
 *  - `references` field content strings ("blog_post/why-we-built-ledric@2")
 *  - inline :::ref{to="..."}::: directives in markdown
 *
 * Format:  type/slug          → { type, slug }
 *          type/slug@N        → { type, slug, version: N }
 *
 * Slugs cannot contain @ (the slug regex excludes it), so the first @
 * after the slash unambiguously starts the version.
 */
export interface ParsedRef {
  type: string;
  slug: string;
  version?: number;
}

export function parseRef(s: string): ParsedRef | null {
  if (typeof s !== 'string' || s.length === 0) return null;
  const slashAt = s.indexOf('/');
  if (slashAt <= 0 || slashAt === s.length - 1) return null;
  const type = s.slice(0, slashAt);
  let slug = s.slice(slashAt + 1);
  let version: number | undefined;

  const atAt = slug.indexOf('@');
  if (atAt !== -1) {
    const versionPart = slug.slice(atAt + 1);
    if (!/^\d+$/.test(versionPart)) return null;
    version = parseInt(versionPart, 10);
    slug = slug.slice(0, atAt);
    if (slug.length === 0) return null;
  }

  return version !== undefined ? { type, slug, version } : { type, slug };
}
