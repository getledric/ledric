import {
  defineType,
  FIELD_TYPES,
  FIELD_TYPE_SPECS,
  NAME_PATTERN,
  RESERVED_CONTENT_KEYS
} from '@ledric/schema';
import type { FieldDef, FieldTypeSpec, TypeDef, TypeDefOptions } from '@ledric/schema';
import type {
  Storage,
  ChangeClass,
  EntryDetail,
  EntryRef,
  EntryWrite,
  FindEntriesInput,
  FindEntriesResult,
  AssetMeta,
  AssetDetail,
  AssetSummary,
  AssetWrite,
  ListAssetsInput,
  ListAssetsResult,
  TagInfo,
  TagWithCounts
} from '@ledric/storage';
import { UniqueViolationError } from '@ledric/storage';
import sharp from 'sharp';
import { normalizeTypeDef } from './normalize.js';
import { deriveContent } from './derive.js';
import { validateContent, type ValidationError } from './validate.js';
import { classifyChange, deepEqual, type TypeDiff } from './classify.js';
import { applyMergePatch } from './merge-patch.js';
import { projectForLocale, extractLocaleSlugs } from './locale.js';
import { resolveAssets } from './resolve-assets.js';
import { resolveReferences } from './resolve-references.js';
import { resolveInlineRefs } from './resolve-refs.js';
import { checkStructuralRefs } from './check-refs.js';
import {
  applyTransforms,
  computeOutputFormat,
  extForFormat,
  transformCacheKey,
  type TransformCache,
  type TransformParams
} from './transforms.js';

export interface Capabilities {
  vectorSearch: boolean;
  nativePubSub: boolean;
  fts: 'fts5' | 'tsvector';
  /**
   * Asset URLs accept imgix-style query params (w/h/fit/q/fm/auto/dpr).
   * Structured so consumers don't have to hit the API root for the param
   * list. Truthy as a whole — boolean checks against the prior shape
   * still work, but new code should read `params` and `example`.
   */
  imageTransforms: ImageTransformsCapability;
  /**
   * Structural ref validation: dangling or wrong-typed refs surface as
   * warnings on draft and as errors on publish. Always true.
   */
  refValidation: boolean;
  /**
   * The complete set of valid field type discriminators on this server.
   * Lets agents avoid hardcoding the list and degrade gracefully when
   * older servers don't ship newer types.
   */
  fieldTypes: readonly string[];
  /**
   * Per-discriminator catalogue: required keys, optional keys, and a
   * complete example. Lets an agent constructing a new type pick the
   * right keys for `array.of`, `object.fields`, `references.to`, etc.
   * without trial-and-error or doc-hunting.
   */
  fieldTypeSpecs: Record<string, FieldTypeSpec>;
  /**
   * Base URL of the HTTP API exposed by this ledric process, if one is
   * running alongside MCP (i.e. `serve --http` or `serve --gui`). Absent
   * when MCP is the only surface. Lets agents call the consumer-facing
   * REST routes without probing or guessing the port.
   */
  http_base?: string;
  /**
   * Plain-language guidance for agents wiring up consumer sites. Steers
   * them toward the right architecture (ledric runs as a separate
   * process; consumers fetch via http_base) instead of inadvisable
   * defaults like adding ledric to the consumer project's
   * package.json — which would drag better-sqlite3 + sharp into every
   * consumer build.
   */
  consumer_guidance: string;
  /** HTTP auth posture. Absent in pure-stdio MCP mode. */
  auth?: AuthCapability;
}

export interface ImageTransformsCapability {
  enabled: true;
  /** Param name → human-readable description of accepted values. */
  params: Record<string, string>;
  /** Concrete example a consumer can paste. */
  example: string;
}

/**
 * Naming rules and reserved keys an agent should respect when
 * constructing types or content. Surfaced in describeModel so the
 * "leading underscore is reserved" rule is discoverable inline rather
 * than hidden in error messages.
 */
export interface Conventions {
  /** Regex (string form) every type and field name must satisfy. */
  name_pattern: string;
  /**
   * Top-level content keys ledric uses for sidecars (locale overrides,
   * slug-rename redirects, ref resolution, warnings). Field names must
   * not collide with these. Anything starting with `_` is reserved.
   */
  reserved_content_keys: readonly string[];
  /** Plain-language explanation, in case the rules above need context. */
  notes: string;
}

export interface DescribeModelResult {
  schema_version: number;
  types: Record<string, TypeDescription>;
  capabilities: Capabilities;
  conventions: Conventions;
}

export interface TypeDescription extends TypeDef {
  version: number;
}

export interface CreateTypeInput {
  name: string;
  fields: Record<string, FieldDef>;
  opts?: TypeDefOptions;
  author?: string;
}

export interface AlterTypeInput {
  name: string;
  parent_version: number;
  merge_patch: Record<string, unknown>;
  dry_run?: boolean;
  author?: string;
}

export interface AlterTypeResult {
  name: string;
  version: number;
  change_class: ChangeClass;
  diff: TypeDiff;
  dry_run?: boolean;
  definition: TypeDef;
}

export interface DraftInput {
  type: string;
  fields: Record<string, unknown>;
  ref?: EntryRef;
  parent_version?: number;
  author?: string;
  /** Initial tags for new entries. Ignored when updating an existing entry. */
  tags?: readonly string[];
}

export interface DraftResult extends EntryWrite {
  status: 'draft';
  content: Record<string, unknown>;
  /**
   * Soft issues with the draft — typically structural-ref problems
   * (target missing, wrong type). The draft is accepted; the same
   * issues become hard errors on publish.
   */
  warnings: ValidationError[];
}

export interface ReadInput {
  ref: EntryRef;
  version?: number;
  locale?: string;
  /**
   * Resolve asset-typed fields in the response.
   *   true       → every asset-typed field on the type
   *   string[]   → only the named asset fields
   *   undefined  → leave as opaque ids (default)
   */
  expand_assets?: boolean | readonly string[];
  /**
   * Resolve `references`-typed fields in the response. Symmetric to
   * `expand_assets` but for cross-entry references rather than assets.
   *   true       → every references-typed field on the type
   *   string[]   → only the named fields
   *   undefined  → leave as opaque "type/slug" strings (default)
   *
   * Resolution is shallow — the resolved entries are returned as
   * stored, without further expand_assets / resolve_references passes
   * on their fields. (v0.2 will add recursive expansion.)
   *
   * Distinct from `resolve_refs` (below), which walks markdown bodies
   * for :::ref{} directives — totally different mechanism.
   */
  resolve_references?: boolean | readonly string[];
  /** Resolve inline :::ref{} directives in markdown fields into a _refs sidecar. */
  resolve_refs?: boolean;
  /**
   * Include fields marked `private: true` in the response. Default false.
   * The admin GUI / inline editor / authoring tools should pass true; public
   * consumer reads should leave it false.
   */
  include_private?: boolean;
  /**
   * Project the response from `entries.published_version` instead of
   * `current_version`. Returns null when the entry has never been
   * published — callers asking for the public-facing copy must not
   * accidentally see drafts.
   *
   * Mirrors `find({ published: true })`. Mutually exclusive with
   * `version`: when both are set, `version` wins (you're asking for a
   * specific revision, not the live one).
   */
  published?: boolean;
}

export interface PublishInput {
  ref: EntryRef;
  version?: number;
}

export interface PublishResult extends EntryWrite {
  published_version: number;
}

export interface RenameInput {
  ref: EntryRef;
  new_slug: string;
  locale?: string;
}

export interface RenameResult {
  id: string;
  type: string;
  old_slug: string;
  new_slug: string;
  locale: string | null;
  retired_at: number;
}

export interface DeleteTypeInput {
  name: string;
  parent_version: number;
  cascade?: boolean;
  author?: string;
}

export interface DeleteTypeResult {
  name: string;
  deleted_at: number;
  entries_deleted: number;
}

export interface DeleteEntryInput {
  ref: EntryRef;
  parent_version: number;
  author?: string;
}

export interface DeleteEntryResult {
  id: string;
  type: string;
  slug: string;
  deleted_at: number;
}

export interface MigrateEntriesInput {
  type: string;
  merge_patch?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  dry_run?: boolean;
  author?: string;
  limit?: number;
}

export interface MigrateFailure {
  ref: EntryRef;
  errors: ValidationError[];
}

export interface MigrateEntriesResult {
  type: string;
  schema_version: number;
  checked: number;
  migrated: number;
  failed: MigrateFailure[];
  dry_run?: boolean;
}

export interface UploadAssetInput {
  kind: string;
  bytes: Uint8Array;
  meta?: AssetMeta;
  author?: string;
  /** Initial tags. Free-form strings; normalized server-side. */
  tags?: readonly string[];
}

export interface GetAssetInput {
  id: string; // hex
  version?: number;
}

export class ValidationFailedError extends Error {
  readonly code = 'VALIDATION_FAILED';
  constructor(public readonly errors: ValidationError[]) {
    super(`VALIDATION_FAILED: ${errors.length} error(s)`);
  }
}

export class AssetConstraintError extends Error {
  readonly code = 'ASSET_CONSTRAINT';
  constructor(
    public readonly field: string,
    public readonly constraint: string,
    public readonly value: unknown,
    public readonly limit: unknown
  ) {
    super(
      `ASSET_CONSTRAINT: field "${field}" violates ${constraint} (got ${String(value)}, limit ${String(limit)})`
    );
  }
}

/**
 * Throw AssetConstraintError if the resolved asset violates any of the
 * field-level constraints. Called once per referenced asset id.
 *
 * Width/height come from asset meta (set by uploadAsset for images);
 * when meta lacks them we skip the dimension rules rather than fail —
 * non-image assets won't have them.
 */
function validateAssetAgainstField(
  fieldName: string,
  fieldDef: FieldAssetDef,
  asset: { kind: string; meta: unknown }
): void {
  const meta = (asset.meta ?? {}) as {
    mime?: unknown;
    size?: unknown;
    width?: unknown;
    height?: unknown;
  };

  if (Array.isArray(fieldDef.kinds) && fieldDef.kinds.length > 0) {
    if (!fieldDef.kinds.includes(asset.kind)) {
      throw new AssetConstraintError(fieldName, 'kinds', asset.kind, fieldDef.kinds.join(','));
    }
  }
  if (Array.isArray(fieldDef.mime_types) && fieldDef.mime_types.length > 0) {
    if (typeof meta.mime !== 'string' || !fieldDef.mime_types.includes(meta.mime)) {
      throw new AssetConstraintError(fieldName, 'mime_types', meta.mime, fieldDef.mime_types.join(','));
    }
  }
  if (typeof fieldDef.max_size_bytes === 'number') {
    if (typeof meta.size === 'number' && meta.size > fieldDef.max_size_bytes) {
      throw new AssetConstraintError(fieldName, 'max_size_bytes', meta.size, fieldDef.max_size_bytes);
    }
  }
  const w = typeof meta.width === 'number' ? meta.width : null;
  const h = typeof meta.height === 'number' ? meta.height : null;
  if (typeof fieldDef.min_width === 'number' && w !== null && w < fieldDef.min_width) {
    throw new AssetConstraintError(fieldName, 'min_width', w, fieldDef.min_width);
  }
  if (typeof fieldDef.max_width === 'number' && w !== null && w > fieldDef.max_width) {
    throw new AssetConstraintError(fieldName, 'max_width', w, fieldDef.max_width);
  }
  if (typeof fieldDef.min_height === 'number' && h !== null && h < fieldDef.min_height) {
    throw new AssetConstraintError(fieldName, 'min_height', h, fieldDef.min_height);
  }
  if (typeof fieldDef.max_height === 'number' && h !== null && h > fieldDef.max_height) {
    throw new AssetConstraintError(fieldName, 'max_height', h, fieldDef.max_height);
  }
  if (typeof fieldDef.aspect_ratio === 'string' && w !== null && h !== null && h > 0) {
    const m = /^(\d+):(\d+)$/.exec(fieldDef.aspect_ratio);
    if (m) {
      const targetW = parseInt(m[1]!, 10);
      const targetH = parseInt(m[2]!, 10);
      if (targetH > 0) {
        const actual = w / h;
        const target = targetW / targetH;
        if (Math.abs(actual - target) > 0.005) {
          throw new AssetConstraintError(
            fieldName,
            'aspect_ratio',
            `${w}x${h} (=${actual.toFixed(3)})`,
            fieldDef.aspect_ratio
          );
        }
      }
    }
  }
}

/** Field shape we care about in validateAssetAgainstField. */
interface FieldAssetDef {
  type: 'asset';
  kinds?: readonly string[];
  mime_types?: readonly string[];
  max_size_bytes?: number;
  min_width?: number;
  max_width?: number;
  min_height?: number;
  max_height?: number;
  aspect_ratio?: string;
}

/**
 * Drop top-level fields marked `private: true` from a projected content
 * object unless the caller explicitly opted in via `include_private`.
 * Run last in the read pipeline (after locale projection and asset
 * expansion) so the dropped fields stay invisible in every shape we
 * return — list summaries, detail reads, expanded asset URLs, the lot.
 */
function stripPrivateFields(
  content: Record<string, unknown>,
  typeDef: TypeDef,
  includePrivate: boolean
): Record<string, unknown> {
  if (includePrivate) return content;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    const def = typeDef.fields[key];
    if (def && (def as { private?: boolean }).private === true) continue;
    out[key] = value;
  }
  return out;
}

export interface CoreOptions {
  /**
   * Cache for on-the-fly image transforms. When provided, transformed
   * bytes are stored here keyed by (asset id, version, params) so repeat
   * requests skip the libvips pass.
   */
  transformCache?: TransformCache;
  /**
   * Base URL of the HTTP API exposed by this ledric process, when one is
   * running. Surfaced on `describe_model().capabilities.http_base` so MCP
   * clients know where to call without probing. Set by the CLI's serve
   * command when --http or --gui is on; absent otherwise.
   */
  httpBase?: string;
  /**
   * HTTP auth posture, surfaced on describe_model so consumers know which
   * keys are needed without trial-and-error. Set by the cli/http-server
   * once keys have been resolved at startup. Absent in pure-stdio MCP
   * mode where there is no HTTP surface to authenticate against.
   */
  auth?: AuthCapability;
}

export interface AuthCapability {
  /** What reads need: 'open' (default), or 'reader' under --require-reader-key. */
  read: 'open' | 'reader';
  /** What writes need. Currently always 'admin'. */
  write: 'admin';
  /** Which key kinds are minted on this server. */
  keys: readonly ('admin' | 'reader')[];
  /** Header format consumers must use. */
  header: string;
}

/**
 * Look up a transformed asset by its per-version ref_key. The ref_key
 * is what consumer URLs carry (`/assets/<ref_key>`) — opaque, immutable,
 * and uniquely identifies a (asset_id, version) pair.
 */
export interface GetTransformedAssetInput {
  ref_key: string;
  params: TransformParams;
  /** Browser Accept header — used when `params.auto === 'format'`. */
  accept?: string;
}

export interface TransformedAsset {
  bytes: Buffer;
  mime: string;
  /** True when the bytes came from the transform cache. Mostly for tests. */
  cached: boolean;
  /** True when the source mime wasn't transformable so we returned bytes as-is. */
  passthrough: boolean;
  version: number;
  /** The asset id this ref_key resolved to (hex). */
  asset_id: string;
}

export interface UpdateAssetInput {
  id: string;
  parent_version: number;
  bytes: Uint8Array;
  meta?: Record<string, unknown>;
  author?: string;
}

export interface UpdateAssetResult {
  id: string;
  version: number;
  kind: string;
  storage_ref: string;
  meta: Record<string, unknown>;
  ref_key: string;
}

export class Core {
  private readonly transformCache: TransformCache | undefined;
  private readonly httpBase: string | undefined;
  private readonly auth: AuthCapability | undefined;

  constructor(private readonly storage: Storage, opts: CoreOptions = {}) {
    this.transformCache = opts.transformCache;
    this.httpBase = opts.httpBase;
    this.auth = opts.auth;
  }

  async describeModel(): Promise<DescribeModelResult> {
    const summaries = await this.storage.listTypes();
    const types: Record<string, TypeDescription> = {};
    let schemaVersionTotal = 0;

    for (const summary of summaries) {
      const detail = await this.storage.getType(summary.name);
      if (!detail) continue;
      types[detail.name] = { ...detail.definition, version: detail.current_version };
      schemaVersionTotal += detail.current_version;
    }

    return {
      schema_version: schemaVersionTotal,
      types,
      capabilities: {
        vectorSearch: false,
        nativePubSub: false,
        fts: 'fts5',
        imageTransforms: {
          enabled: true,
          params: {
            w: 'integer — target width in pixels',
            h: 'integer — target height in pixels',
            fit: "'clip' | 'crop' (default 'clip') — how to fit when both w and h are set",
            q: 'integer 1-100 — output quality',
            fm: "'jpg' | 'png' | 'webp' | 'avif' — output format",
            auto: "'format' — negotiate output via Accept header (sets Vary: Accept on response)",
            dpr: 'integer 1-4 — device pixel ratio multiplier on w/h'
          },
          example: '/assets/<ref_key>?w=400&fm=webp&q=80&dpr=2'
        },
        refValidation: true,
        fieldTypes: FIELD_TYPES,
        fieldTypeSpecs: FIELD_TYPE_SPECS as unknown as Record<string, FieldTypeSpec>,
        ...(this.httpBase !== undefined ? { http_base: this.httpBase } : {}),
        ...(this.auth !== undefined ? { auth: this.auth } : {}),
        consumer_guidance:
          'ledric is intended to run as a standalone process. Consumer sites (Astro, Next.js, plain HTML, etc.) should reference its HTTP URL via http_base, NOT include ledric as a package dependency — that would drag better-sqlite3 + sharp + libvips into every consumer build (~50MB native binaries). For local dev convenience you can use `npx -y ledric http` from the consumer directory; in production, run ledric somewhere stable (Oracle Cloud free tier, Hetzner VPS, etc.) and point consumers at it via env var. The MCP server describes the admin plane; the HTTP API at http_base is the consumer plane. ' +
          'For PRODUCTION setups, install `@ledric/proxy` and mount its handlers in your consumer site\'s server runtime — it is a framework-agnostic (Request) => Promise<Response> primitive, with copy-paste wiring snippets for Astro / Next / SvelteKit / Hono / Express in the package README. The browser must NOT call ledric directly: keys stay server-side, ledric binds to localhost or a private network, and the proxy exposes a curated subset (assets and a content allowlist by default; inline-editor and admin endpoints stay off). ' +
          'Quick recipes against the HTTP plane: ' +
          '(1) list with assets+refs inlined — `GET <http_base>/entries/blog_post?expand_assets=true&resolve_references=true&limit=20` returns { total, offset, results: Entry[] }. ' +
          '(2) read one entry — `GET <http_base>/entries/blog_post/<slug>?expand_assets=true` returns Entry; old slugs 301-redirect to the current one. ' +
          '(3) image URL with transforms — entry asset fields hold a stable id; either pass `expand_assets=true` (the inlined object carries `url` keyed on ref_key), or just use `<http_base>/assets/<id>?w=400&fm=webp` (the id route 302-redirects to the current ref_key). ' +
          'Entry envelope: { id, type, slug, version, published_version?, fields, tags? } — your content lives under `fields`. Filter to live content with `?published=true`.'
      },
      conventions: {
        name_pattern: NAME_PATTERN,
        reserved_content_keys: RESERVED_CONTENT_KEYS,
        notes:
          'Type and field names match name_pattern (lowercase, must start with a letter, underscores allowed mid-name). ' +
          'A leading underscore is NEVER allowed — that prefix is reserved for content sidecars (_locale, _redirect, _refs, _warnings) so we can add new ones without breaking existing schemas.'
      }
    };
  }

  async createType(input: CreateTypeInput): Promise<TypeDescription> {
    const validated = defineType(input.name, input.fields, input.opts ?? {});
    const definition = normalizeTypeDef(validated);
    await this.storage.createType({
      definition,
      ...(input.author !== undefined ? { author: input.author } : {})
    });
    return { ...definition, version: 1 };
  }

  async alterType(input: AlterTypeInput): Promise<AlterTypeResult> {
    const current = await this.storage.getType(input.name);
    if (!current) throw new Error(`Unknown type "${input.name}"`);

    if (
      typeof (input.merge_patch as { name?: unknown }).name === 'string' &&
      (input.merge_patch as { name: string }).name !== input.name
    ) {
      throw new Error(
        `alterType cannot rename "${input.name}" — renaming is a separate operation.`
      );
    }

    const merged = applyMergePatch(current.definition, {
      ...input.merge_patch,
      name: input.name
    }) as TypeDef;

    const validated = defineType(merged.name, merged.fields, {
      ...(merged.description !== undefined ? { description: merged.description } : {}),
      ...(merged.identifier_field !== undefined
        ? { identifier_field: merged.identifier_field }
        : {}),
      ...(merged.display_field !== undefined
        ? { display_field: merged.display_field }
        : {}),
      ...(merged.summary_fields !== undefined
        ? { summary_fields: merged.summary_fields }
        : {}),
      ...(merged.on_slug_change !== undefined
        ? { on_slug_change: merged.on_slug_change }
        : {}),
      ...(merged.example !== undefined ? { example: merged.example } : {}),
      ...(merged.locales !== undefined ? { locales: merged.locales } : {}),
      ...(merged.default_locale !== undefined
        ? { default_locale: merged.default_locale }
        : {}),
      ...(merged.fallback !== undefined ? { fallback: merged.fallback } : {})
    });
    const definition = normalizeTypeDef(validated);

    const diff = classifyChange(current.definition, definition);

    if (input.dry_run === true) {
      return {
        name: input.name,
        version: current.current_version,
        change_class: diff.class,
        diff,
        definition,
        dry_run: true
      };
    }

    const write = await this.storage.alterType({
      name: input.name,
      parent_version: input.parent_version,
      definition,
      change_class: diff.class,
      ...(input.author !== undefined ? { author: input.author } : {})
    });

    return {
      name: input.name,
      version: write.version,
      change_class: diff.class,
      diff,
      definition
    };
  }

  async draft(input: DraftInput): Promise<DraftResult> {
    const typeDetail = await this.storage.getType(input.type);
    if (!typeDetail) throw new Error(`Unknown type "${input.type}"`);

    const derived = deriveContent(typeDetail.definition, input.fields);
    const validated = validateContent(typeDetail.definition, derived);
    if (!validated.ok) throw new ValidationFailedError(validated.errors);

    const slugField = typeDetail.definition.identifier_field ?? 'slug';
    const slug = validated.value[slugField];
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new ValidationFailedError([
        {
          path: `/${slugField}`,
          code: 'required',
          message: `The identifier field "${slugField}" must produce a non-empty slug.`
        }
      ]);
    }

    // Compute locale_slugs from any per-locale slug fields. Only included
    // when the type is localized AND the slug field itself is localized
    // AND the locale block contains one. For non-localized types this is
    // always undefined — zero overhead at the storage layer.
    const localeSlugs = extractLocaleSlugs(typeDetail.definition, validated.value, slugField);

    // Soft check: structural references. Targets that don't exist (yet)
    // or point at a disallowed type surface as warnings on draft, errors
    // on publish — this lets agents stage related entries in any order.
    const warnings = await checkStructuralRefs(
      validated.value,
      typeDetail.definition,
      this.storage
    );

    // Uniqueness — fail fast at draft so the conflict is reported before
    // the storage write rather than as a SQL constraint violation later.
    await this.checkUniqueFields(
      typeDetail.definition,
      validated.value,
      input.ref
    );

    // Per-field asset constraints (mime / size / dimensions / aspect ratio).
    // The asset itself is unconstrained at upload time; constraints live on
    // the field that USES the asset, so the same image can be a hero on one
    // type and a thumbnail on another with different rules.
    await this.checkAssetConstraints(typeDetail.definition, validated.value);

    if (input.ref !== undefined) {
      if (input.ref.slug !== slug) {
        throw new ValidationFailedError([
          {
            path: `/${slugField}`,
            code: 'slug_change',
            message: `Cannot change slug on update in this version (ref was "${input.ref.slug}", content is "${slug}"). Slug changes will land when rename is implemented.`
          }
        ]);
      }
      if (input.parent_version === undefined) {
        throw new ValidationFailedError([
          {
            path: '/parent_version',
            code: 'required',
            message: 'parent_version is required when updating an existing entry.'
          }
        ]);
      }
      const write = await this.storage.updateEntry({
        ref: input.ref,
        content: validated.value,
        parent_version: input.parent_version,
        schema_version: typeDetail.current_version,
        ...(input.author !== undefined ? { author: input.author } : {}),
        ...(localeSlugs !== undefined ? { locale_slugs: localeSlugs } : {})
      });
      return { ...write, status: 'draft', content: validated.value, warnings };
    }

    const write = await this.storage.createEntry({
      type: input.type,
      slug,
      content: validated.value,
      schema_version: typeDetail.current_version,
      ...(input.author !== undefined ? { author: input.author } : {}),
      ...(localeSlugs !== undefined ? { locale_slugs: localeSlugs } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {})
    });
    return { ...write, status: 'draft', content: validated.value, warnings };
  }

  async read(input: ReadInput): Promise<EntryDetail | null> {
    const opts: { version?: number; locale?: string; published?: boolean } = {};
    if (input.version !== undefined) opts.version = input.version;
    if (input.locale !== undefined) opts.locale = input.locale;
    // version takes precedence over published — asking for a specific
    // revision is more specific than "the live one."
    if (input.published === true && input.version === undefined) {
      opts.published = true;
    }
    const entry = await this.storage.readEntry(input.ref, opts);
    if (!entry) return null;

    // For localized types, always run projection — even for the default
    // locale or no-locale reads — so consumers never see other locales'
    // translations leaking through `_locale`. For non-localized types
    // this is a cheap no-op.
    const typeDetail = await this.storage.getType(entry.type);
    if (!typeDetail) return entry;
    const projected = projectForLocale(
      entry.content,
      typeDetail.definition,
      input.locale
    );
    const assetsResolved = await resolveAssets(
      projected,
      typeDetail.definition,
      this.storage,
      input.expand_assets
    );
    const referencesResolved = await resolveReferences(
      assetsResolved,
      typeDetail.definition,
      this.storage,
      input.resolve_references
    );
    const refs =
      input.resolve_refs === true
        ? await resolveInlineRefs(referencesResolved, typeDetail.definition, this.storage)
        : undefined;
    // Surface structural-ref issues as a sidecar so consumers can show
    // "this points at content that no longer exists" without re-running
    // the check themselves.
    const warnings = await checkStructuralRefs(
      referencesResolved,
      typeDetail.definition,
      this.storage
    );
    const visible = stripPrivateFields(
      referencesResolved,
      typeDetail.definition,
      input.include_private === true
    );
    return {
      ...entry,
      content: visible,
      ...(refs !== undefined ? { _refs: refs } : {}),
      ...(warnings.length > 0 ? { _warnings: warnings } : {})
    };
  }

  async find(
    input: FindEntriesInput & {
      locale?: string;
      expand_assets?: boolean | readonly string[];
      resolve_references?: boolean | readonly string[];
      resolve_refs?: boolean;
      include_private?: boolean;
      summary?: boolean;
    }
  ): Promise<FindEntriesResult> {
    const result = await this.storage.findEntries(input);
    const typeDetail = await this.storage.getType(input.type);
    if (!typeDetail) return result;
    const summaryFields =
      input.summary === true && Array.isArray(typeDetail.definition.summary_fields)
        ? new Set(typeDetail.definition.summary_fields)
        : null;
    const projected: typeof result.results = [];
    for (const r of result.results) {
      const localeProjected = projectForLocale(
        r.content,
        typeDetail.definition,
        input.locale
      );
      const assetsResolved = await resolveAssets(
        localeProjected,
        typeDetail.definition,
        this.storage,
        input.expand_assets
      );
      const referencesResolved = await resolveReferences(
        assetsResolved,
        typeDetail.definition,
        this.storage,
        input.resolve_references
      );
      const refs =
        input.resolve_refs === true
          ? await resolveInlineRefs(referencesResolved, typeDetail.definition, this.storage)
          : undefined;
      const visible = stripPrivateFields(
        referencesResolved,
        typeDetail.definition,
        input.include_private === true
      );
      // summary projection drops fields the type author marked as
      // non-summary. _-prefixed sidecars (_locale, _refs, _warnings)
      // pass through regardless — they're not user-defined fields.
      const finalContent = summaryFields
        ? Object.fromEntries(
            Object.entries(visible).filter(
              ([k]) => k.startsWith('_') || summaryFields.has(k)
            )
          )
        : visible;
      projected.push({
        ...r,
        content: finalContent,
        ...(refs !== undefined ? { _refs: refs } : {})
      });
    }
    return { ...result, results: projected };
  }

  async rename(input: RenameInput): Promise<RenameResult> {
    const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
    if (!SLUG_RE.test(input.new_slug)) {
      throw new ValidationFailedError([
        {
          path: '/new_slug',
          code: 'format',
          message:
            'Slug must be 1-64 chars, lowercase a-z/0-9/hyphens, not starting or ending with a hyphen.',
          actual: input.new_slug
        }
      ]);
    }
    const result = await this.storage.renameEntry({
      ref: input.ref,
      new_slug: input.new_slug,
      ...(input.locale !== undefined ? { locale: input.locale } : {})
    });
    return {
      id: Buffer.from(result.id).toString('hex'),
      type: result.type,
      old_slug: result.old_slug,
      new_slug: result.new_slug,
      locale: result.locale,
      retired_at: result.retired_at
    };
  }

  async deleteType(input: DeleteTypeInput): Promise<DeleteTypeResult> {
    return this.storage.deleteType({
      name: input.name,
      parent_version: input.parent_version,
      ...(input.cascade !== undefined ? { cascade: input.cascade } : {})
    });
  }

  async deleteEntry(input: DeleteEntryInput): Promise<DeleteEntryResult> {
    const result = await this.storage.deleteEntry({
      ref: input.ref,
      parent_version: input.parent_version
    });
    return {
      id: Buffer.from(result.id).toString('hex'),
      type: result.type,
      slug: result.slug,
      deleted_at: result.deleted_at
    };
  }

  // -------------------- Tags --------------------

  /** Resolve an entry ref to its uuid bytes. Throws NOT_FOUND if missing. */
  private async resolveEntryId(ref: EntryRef): Promise<Uint8Array> {
    const entry = await this.storage.readEntry(ref);
    if (!entry) throw new Error(`NOT_FOUND: entry "${ref.type}/${ref.slug}"`);
    return entry.id;
  }

  /**
   * Walk every top-level asset-typed field on the type and check the
   * referenced asset(s) against the field's per-use constraints
   * (mime_types, max_size_bytes, dimension bounds, aspect_ratio).
   * Dimensions only apply when the asset's meta carries width/height —
   * non-image assets and old-format images skip those checks.
   */
  private async checkAssetConstraints(
    typeDef: TypeDef,
    content: Record<string, unknown>
  ): Promise<void> {
    for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
      if (fieldDef.type !== 'asset') continue;
      const raw = content[fieldName];
      if (raw === undefined || raw === null) continue;
      const ids: string[] = Array.isArray(raw)
        ? raw.filter((v): v is string => typeof v === 'string')
        : typeof raw === 'string'
          ? [raw]
          : [];
      for (const idHex of ids) {
        const idBytes = Buffer.from(idHex, 'hex');
        if (idBytes.byteLength !== 16) continue; // not a real id; validateContent will catch
        const asset = await this.storage.getAsset(new Uint8Array(idBytes));
        if (!asset) continue; // ref-validation surfaces this elsewhere
        validateAssetAgainstField(fieldName, fieldDef, asset);
      }
    }
  }

  /**
   * For every top-level field declared with `unique: true`, query for any
   * other live entry of the same type that already has the same value.
   * `excludeRef` is the entry being updated (so it doesn't match itself).
   * Throws UniqueViolationError on the first collision found.
   */
  private async checkUniqueFields(
    typeDef: TypeDef,
    content: Record<string, unknown>,
    excludeRef: EntryRef | undefined
  ): Promise<void> {
    for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
      if ((fieldDef as { unique?: boolean }).unique !== true) continue;
      const value = content[fieldName];
      if (value === undefined || value === null) continue;
      const result = await this.storage.findEntries({
        type: typeDef.name,
        where: { [fieldName]: value },
        limit: 2
      });
      const conflict = result.results.find(
        (r) => excludeRef === undefined || r.slug !== excludeRef.slug
      );
      if (conflict) {
        throw new UniqueViolationError(typeDef.name, fieldName, value, conflict.slug);
      }
    }
  }

  /** Hex-decode an asset id (32-char hex) to its uuid bytes. */
  private decodeAssetId(idHex: string): Uint8Array {
    const buf = Buffer.from(idHex, 'hex');
    if (buf.byteLength !== 16) {
      throw new Error(`Invalid asset id "${idHex}" (expected 32-char hex)`);
    }
    return new Uint8Array(buf);
  }

  async addAssetTags(idHex: string, tags: readonly string[]): Promise<TagInfo[]> {
    return this.storage.addAssetTags(this.decodeAssetId(idHex), tags);
  }

  async removeAssetTags(idHex: string, tags: readonly string[]): Promise<{ removed: number }> {
    const removed = await this.storage.removeAssetTags(this.decodeAssetId(idHex), tags);
    return { removed };
  }

  async addEntryTags(ref: EntryRef, tags: readonly string[]): Promise<TagInfo[]> {
    const id = await this.resolveEntryId(ref);
    return this.storage.addEntryTags(id, tags);
  }

  async removeEntryTags(ref: EntryRef, tags: readonly string[]): Promise<{ removed: number }> {
    const id = await this.resolveEntryId(ref);
    const removed = await this.storage.removeEntryTags(id, tags);
    return { removed };
  }

  async listTags(): Promise<TagWithCounts[]> {
    return this.storage.listTags();
  }

  async updateTag(slug: string, label: string): Promise<TagInfo | null> {
    return this.storage.updateTag(slug, label);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    // Re-check structural refs and refuse to publish if any are dangling
    // or wrong-typed. Warnings on draft become errors here — that's the
    // moment integrity actually has to hold.
    const opts =
      input.version !== undefined ? { version: input.version } : undefined;
    const entry = await this.storage.readEntry(input.ref, opts);
    if (entry !== null) {
      const typeDetail = await this.storage.getType(entry.type);
      if (typeDetail !== null) {
        const refIssues = await checkStructuralRefs(
          entry.content,
          typeDetail.definition,
          this.storage
        );
        if (refIssues.length > 0) {
          throw new ValidationFailedError(refIssues);
        }
      }
    }

    const write = await this.storage.publishEntry({
      ref: input.ref,
      ...(input.version !== undefined ? { version: input.version } : {})
    });
    return { ...write, published_version: write.version };
  }

  async uploadAsset(input: UploadAssetInput): Promise<AssetWrite> {
    const meta: Record<string, unknown> = { ...(input.meta ?? {}) };
    // Always stash byte size so per-field max_size_bytes has something to
    // check against. Caller-supplied size wins (e.g. for streamed uploads
    // where bytes is a chunked Buffer view).
    if (meta.size === undefined && input.bytes !== undefined) {
      meta.size = input.bytes.byteLength;
    }
    // For images, extract intrinsic width/height via sharp so per-field
    // dimension constraints have something to validate against. We never
    // overwrite a width/height that the caller already supplied.
    if (input.kind === 'image' && (meta.width === undefined || meta.height === undefined)) {
      try {
        const probe = await sharp(input.bytes as Buffer).metadata();
        if (typeof probe.width === 'number' && meta.width === undefined) {
          meta.width = probe.width;
        }
        if (typeof probe.height === 'number' && meta.height === undefined) {
          meta.height = probe.height;
        }
      } catch {
        // Non-image bytes labelled as image, or sharp can't read them.
        // Leave width/height unset; constraint checks treat absent
        // dimensions as "unknown" and skip dimension rules.
      }
    }
    return this.storage.createAsset({
      kind: input.kind,
      bytes: input.bytes,
      ...(Object.keys(meta).length > 0 ? { meta: meta as AssetMeta } : {}),
      ...(input.author !== undefined ? { author: input.author } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {})
    });
  }

  async getAsset(input: GetAssetInput): Promise<AssetDetail | null> {
    const id = Buffer.from(input.id, 'hex');
    if (id.byteLength !== 16) {
      throw new Error(`Invalid asset id "${input.id}" (expected 32-char hex)`);
    }
    return this.storage.getAsset(
      new Uint8Array(id),
      ...(input.version !== undefined ? [{ version: input.version }] : [])
    );
  }

  async findAssetByRefKey(refKeyHex: string): Promise<AssetDetail | null> {
    const buf = Buffer.from(refKeyHex, 'hex');
    if (buf.byteLength !== 16) {
      throw new Error(`Invalid ref_key "${refKeyHex}" (expected 32-char hex)`);
    }
    return this.storage.findAssetByRefKey(new Uint8Array(buf));
  }

  async listAssets(input?: ListAssetsInput): Promise<ListAssetsResult> {
    return this.storage.listAssets(input);
  }

  async readAssetBytes(input: GetAssetInput): Promise<Buffer> {
    const id = Buffer.from(input.id, 'hex');
    if (id.byteLength !== 16) {
      throw new Error(`Invalid asset id "${input.id}" (expected 32-char hex)`);
    }
    return this.storage.readAssetBytes(
      new Uint8Array(id),
      ...(input.version !== undefined ? [{ version: input.version }] : [])
    );
  }

  /**
   * Apply imgix-style URL transforms (resize, format, quality) to an
   * asset's bytes. Returns null when the asset doesn't exist.
   *
   * Source mimes we can't transform (gif, svg, video, pdf, ...) come
   * back as a passthrough — same bytes, same mime, params ignored.
   */
  async getTransformedAsset(
    input: GetTransformedAssetInput
  ): Promise<TransformedAsset | null> {
    const refKeyBuf = Buffer.from(input.ref_key, 'hex');
    if (refKeyBuf.byteLength !== 16) {
      throw new Error(`Invalid ref_key "${input.ref_key}" (expected 32-char hex)`);
    }
    const refKeyBytes = new Uint8Array(refKeyBuf);

    const asset = await this.storage.findAssetByRefKey(refKeyBytes);
    if (!asset) return null;

    const sourceMime =
      typeof asset.meta.mime === 'string' ? asset.meta.mime : 'application/octet-stream';
    const assetIdHex = Buffer.from(asset.id).toString('hex');

    const fmt = computeOutputFormat(sourceMime, input.params, {
      ...(input.accept !== undefined ? { accept: input.accept } : {})
    });

    // Source isn't transformable — pass through.
    if (fmt === null) {
      const bytes = await this.storage.readAssetBytes(asset.id, { version: asset.version });
      return {
        bytes,
        mime: sourceMime,
        cached: false,
        passthrough: true,
        version: asset.version,
        asset_id: assetIdHex
      };
    }

    const key = transformCacheKey(input.params, fmt.fm);
    const ext = extForFormat(fmt.fm);

    if (this.transformCache) {
      const hit = await this.transformCache.get(input.ref_key, key, ext);
      if (hit !== null) {
        return {
          bytes: hit,
          mime: fmt.mime,
          cached: true,
          passthrough: false,
          version: asset.version,
          asset_id: assetIdHex
        };
      }
    }

    const sourceBytes = await this.storage.readAssetBytes(asset.id, { version: asset.version });
    const out = await applyTransforms(sourceBytes, input.params, sourceMime, {
      ...(input.accept !== undefined ? { accept: input.accept } : {})
    });

    if (this.transformCache) {
      // Best-effort write — a failing cache must never break the response.
      try {
        await this.transformCache.put(input.ref_key, key, ext, out.bytes);
      } catch {
        /* swallow */
      }
    }

    return {
      bytes: out.bytes,
      mime: out.mime,
      cached: false,
      passthrough: false,
      version: asset.version,
      asset_id: assetIdHex
    };
  }

  async updateAsset(input: UpdateAssetInput): Promise<UpdateAssetResult> {
    const idBuf = Buffer.from(input.id, 'hex');
    if (idBuf.byteLength !== 16) {
      throw new Error(`Invalid asset id "${input.id}" (expected 32-char hex)`);
    }
    const written = await this.storage.updateAsset({
      id: new Uint8Array(idBuf),
      parent_version: input.parent_version,
      bytes: input.bytes,
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
      ...(input.author !== undefined ? { author: input.author } : {})
    });
    return {
      id: Buffer.from(written.id).toString('hex'),
      version: written.version,
      kind: written.kind,
      storage_ref: written.storage_ref,
      meta: written.meta,
      ref_key: Buffer.from(written.ref_key).toString('hex')
    };
  }

  async clearAssetTransformCache(refKeyHex: string): Promise<void> {
    if (!this.transformCache) return;
    await this.transformCache.clear(refKeyHex);
  }

  // No-op pass-through used by tests and future hooks.
  async migrateEntries(input: MigrateEntriesInput): Promise<MigrateEntriesResult> {
    const typeDetail = await this.storage.getType(input.type);
    if (!typeDetail) throw new Error(`Unknown type "${input.type}"`);

    const PAGE = Math.min(input.limit ?? 500, 500);
    let offset = 0;
    let checked = 0;
    let migrated = 0;
    const failed: MigrateFailure[] = [];

    // Stable page ordering (created_at DESC by default) is fine here because
    // we re-query each page and mutate current_version under optimistic
    // concurrency; if a page shifts we'll just skip what we already saw.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await this.storage.findEntries({
        type: input.type,
        ...(input.filter !== undefined ? { where: input.filter } : {}),
        limit: PAGE,
        offset
      });
      if (page.results.length === 0) break;

      for (const entry of page.results) {
        checked++;
        const ref: EntryRef = { type: entry.type, slug: entry.slug };

        let candidate = entry.content;
        if (input.merge_patch !== undefined) {
          candidate = applyMergePatch(candidate, input.merge_patch) as Record<string, unknown>;
        }
        candidate = deriveContent(typeDetail.definition, candidate);

        const v = validateContent(typeDetail.definition, candidate);
        if (!v.ok) {
          failed.push({ ref, errors: v.errors });
          continue;
        }

        const schemaChanged = entry.schema_version !== typeDetail.current_version;
        const contentChanged = !deepEqual(entry.content, v.value);
        if (!contentChanged && !schemaChanged) continue;

        migrated++;
        if (input.dry_run === true) continue;

        const slugField = typeDetail.definition.identifier_field ?? 'slug';
        const localeSlugs = extractLocaleSlugs(typeDetail.definition, v.value, slugField);

        await this.storage.updateEntry({
          ref,
          content: v.value,
          parent_version: entry.current_version,
          schema_version: typeDetail.current_version,
          ...(input.author !== undefined ? { author: input.author } : {}),
          ...(localeSlugs !== undefined ? { locale_slugs: localeSlugs } : {})
        });
      }

      if (page.results.length < PAGE) break;
      offset += page.results.length;
    }

    return {
      type: input.type,
      schema_version: typeDetail.current_version,
      checked,
      migrated,
      failed,
      ...(input.dry_run === true ? { dry_run: true } : {})
    };
  }
}
