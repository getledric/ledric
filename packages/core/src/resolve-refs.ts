import type { TypeDef } from '@ledric/schema';
import type { Storage } from '@ledric/storage';
import { parseRef } from './parse-ref.js';

export interface InlineRefSource {
  /** Original `to` attribute, e.g. "blog_post/hello-world". */
  to: string;
  /** Which markdown field on the entry the directive lives in. */
  in_field: string;
  version?: number;
  locale?: string;
}

export interface ResolvedRef {
  /** The original `to` token — renderers look up by this. */
  to: string;
  found: boolean;
  id?: string;
  type?: string;
  slug?: string;
  display?: string;
  url?: string;
  locale?: string;
  version?: number;
}

// :::ref{to="type/slug" version=42 locale="fr"}::: — trailing ::: optional.
const REF_RE = /:::ref\{([^}]*)\}(?::::)?/g;
// Attribute parser handles:  key="quoted",  key=42,  key=bareword
const ATTR_RE = /(\w+)\s*=\s*(?:"([^"]*)"|(\d+)|([^\s"]+))/g;

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  const re = new RegExp(ATTR_RE.source, 'g');
  while ((m = re.exec(s)) !== null) {
    const value = m[2] ?? m[3] ?? m[4];
    if (value !== undefined) out[m[1] as string] = value;
  }
  return out;
}

export interface InlineRefAttrs {
  to: string;
  version?: number;
  locale?: string;
}

/**
 * Pull every :::ref{to="..."}::: directive out of a Markdown string.
 *
 * The `to` value may also encode a version inline as "type/slug@N" — in
 * which case the parsed result picks that version up automatically and
 * `to` keeps its original spelling so renderers can match on it.
 * An explicit `version=N` attribute, if present, wins over the inline @.
 */
export function extractInlineRefs(md: string): InlineRefAttrs[] {
  if (typeof md !== 'string' || md.length === 0) return [];
  const out: InlineRefAttrs[] = [];
  const re = new RegExp(REF_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    const attrs = parseAttrs(m[1] as string);
    if (typeof attrs.to !== 'string' || attrs.to.length === 0) continue;
    const ref: InlineRefAttrs = { to: attrs.to };
    const parsed = parseRef(attrs.to);
    if (parsed?.version !== undefined) ref.version = parsed.version;
    if (attrs.version !== undefined) {
      const n = parseInt(attrs.version, 10);
      if (Number.isFinite(n)) ref.version = n;
    }
    if (attrs.locale !== undefined) ref.locale = attrs.locale;
    out.push(ref);
  }
  return out;
}

/** Walk every markdown field on the type, collect every inline ref with its source field. */
export function collectInlineRefs(
  content: Record<string, unknown>,
  type: TypeDef
): InlineRefSource[] {
  const out: InlineRefSource[] = [];
  for (const [name, field] of Object.entries(type.fields)) {
    if (field.type !== 'markdown') continue;
    const v = content[name];
    if (typeof v !== 'string') continue;
    for (const ref of extractInlineRefs(v)) {
      const src: InlineRefSource = { to: ref.to, in_field: name };
      if (ref.version !== undefined) src.version = ref.version;
      if (ref.locale !== undefined) src.locale = ref.locale;
      out.push(src);
    }
  }
  return out;
}

/**
 * Resolve every inline ref in `content`'s markdown fields. Returns a flat
 * deduped array (by to+locale+version). Renderers look up by `to` to find
 * the resolved entry. Dangling refs come back with `found: false` so the
 * renderer can show a strikethrough or skip silently.
 */
export async function resolveInlineRefs(
  content: Record<string, unknown>,
  type: TypeDef,
  storage: Storage
): Promise<ResolvedRef[]> {
  const sources = collectInlineRefs(content, type);
  const seen = new Map<string, ResolvedRef>();

  for (const src of sources) {
    const key = `${src.to}|${src.locale ?? ''}|${src.version ?? ''}`;
    if (seen.has(key)) continue;

    const parsed = parseRef(src.to);
    if (parsed === null) {
      seen.set(key, { to: src.to, found: false });
      continue;
    }
    const refType = parsed.type;
    const refSlug = parsed.slug;

    const opts: { version?: number; locale?: string } = {};
    if (src.version !== undefined) opts.version = src.version;
    if (src.locale !== undefined) opts.locale = src.locale;

    let entry: Awaited<ReturnType<Storage['readEntry']>> = null;
    try {
      entry = await storage.readEntry({ type: refType, slug: refSlug }, opts);
    } catch {
      entry = null;
    }

    if (!entry) {
      seen.set(key, { to: src.to, found: false });
      continue;
    }

    const refTypeDetail = await storage.getType(refType);
    const displayField =
      refTypeDetail?.definition.display_field ??
      refTypeDetail?.definition.identifier_field ??
      'title';
    const displayValue = entry.content[displayField];
    const display = typeof displayValue === 'string' ? displayValue : entry.slug;

    const resolved: ResolvedRef = {
      to: src.to,
      found: true,
      id: Buffer.from(entry.id).toString('hex'),
      type: entry.type,
      slug: entry.slug,
      display,
      url: `/entries/${entry.type}/${entry.slug}`
    };
    if (src.locale !== undefined) resolved.locale = src.locale;
    if (src.version !== undefined) resolved.version = src.version;
    seen.set(key, resolved);
  }

  return [...seen.values()];
}
