import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Core } from '@ledric/core';

// Read our own version once at module load. tsup bundles to
// `dist/index.js`; `../package.json` resolves to the shipped manifest.
const PKG_VERSION = (JSON.parse(
  readFileSync(
    resolvePath(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf8'
  )
) as { version: string }).version;

// Some MCP clients serialize a free-form object as a JSON string when the
// tool's inputSchema uses `additionalProperties: true`. Accept either shape.
const ObjectOrJsonString = z
  .union([z.record(z.unknown()), z.string()])
  .transform((v) => (typeof v === 'string' ? (JSON.parse(v) as Record<string, unknown>) : v));

const FieldDefSchema: z.ZodTypeAny = z
  .lazy(() =>
    z.object({
      type: z.string(),
      description: z.string().optional(),
      required: z.boolean().optional(),
      deprecated: z.boolean().optional(),
      indexed: z.boolean().optional()
    }).passthrough()
  );

const TypeDefOptionsSchema = z
  .object({
    description: z.string().optional(),
    identifier_field: z.string().optional(),
    display_field: z.string().optional(),
    summary_fields: z.array(z.string()).optional(),
    on_slug_change: z.enum(['redirect', 'error', 'silent']).optional(),
    example: z.record(z.unknown()).optional(),
    locales: z.array(z.string()).optional(),
    default_locale: z.string().optional(),
    fallback: z.record(z.string()).optional()
  })
  .strict();

const CreateTypeArgsSchema = z
  .object({
    name: z.string(),
    fields: z.record(FieldDefSchema),
    opts: TypeDefOptionsSchema.optional(),
    author: z.string().optional()
  })
  .strict();

// MCP clients vary on how they serialise ints — some send as JSON numbers,
// others as strings. Coerce to keep both happy.
const IntFromStringOrNumber = z.coerce.number().int();

const AlterTypeArgsSchema = z
  .object({
    name: z.string(),
    parent_version: IntFromStringOrNumber,
    merge_patch: ObjectOrJsonString,
    dry_run: z.boolean().optional(),
    author: z.string().optional()
  })
  .strict();

const EntryRefObject = z
  .object({
    type: z.string(),
    slug: z.string()
  })
  .strict();

const EntryRefSchema = z
  .union([EntryRefObject, z.string()])
  .transform((v) => (typeof v === 'string' ? (EntryRefObject.parse(JSON.parse(v))) : v));

const DraftArgsSchema = z
  .object({
    type: z.string(),
    fields: ObjectOrJsonString,
    ref: EntryRefSchema.optional(),
    parent_version: IntFromStringOrNumber.optional(),
    author: z.string().optional()
  })
  .strict();

const ExpandAssetsSchema = z
  .union([z.boolean(), z.array(z.string())])
  .optional();

const ReadArgsSchema = z
  .object({
    ref: EntryRefSchema,
    version: IntFromStringOrNumber.optional(),
    locale: z.string().optional(),
    expand_assets: ExpandAssetsSchema,
    resolve_references: ExpandAssetsSchema,
    resolve_refs: z.boolean().optional(),
    include_private: z.boolean().optional()
  })
  .strict();

const FindArgsSchema = z
  .object({
    type: z.string(),
    where: ObjectOrJsonString.optional(),
    limit: IntFromStringOrNumber.refine((n) => n >= 1 && n <= 200, 'limit must be 1-200').optional(),
    offset: IntFromStringOrNumber.refine((n) => n >= 0, 'offset must be >= 0').optional(),
    order: z
      .array(
        z.object({
          field: z.string(),
          dir: z.enum(['asc', 'desc'])
        })
      )
      .optional(),
    includeDeleted: z.boolean().optional(),
    locale: z.string().optional(),
    expand_assets: ExpandAssetsSchema,
    resolve_references: ExpandAssetsSchema,
    resolve_refs: z.boolean().optional(),
    include_private: z.boolean().optional(),
    published: z.boolean().optional(),
    summary: z.boolean().optional(),
    q: z.string().optional(),
    tags: z.array(z.string()).optional()
  })
  .strict();

const PublishArgsSchema = z
  .object({
    ref: EntryRefSchema,
    version: IntFromStringOrNumber.optional()
  })
  .strict();

const RenameArgsSchema = z
  .object({
    ref: EntryRefSchema,
    new_slug: z.string(),
    locale: z.string().optional()
  })
  .strict();

const UpdateAssetArgsSchema = z
  .object({
    id: z.string().length(32),
    parent_version: IntFromStringOrNumber,
    bytes_b64: z.string(),
    meta: ObjectOrJsonString.optional(),
    author: z.string().optional()
  })
  .strict();

const DeleteTypeArgsSchema = z
  .object({
    name: z.string(),
    parent_version: IntFromStringOrNumber,
    cascade: z.boolean().optional(),
    author: z.string().optional()
  })
  .strict();

const DeleteEntryArgsSchema = z
  .object({
    ref: EntryRefSchema,
    parent_version: IntFromStringOrNumber,
    author: z.string().optional()
  })
  .strict();

const TagsListSchema = z.array(z.string()).min(1);

const AssetTagsArgsSchema = z
  .object({
    id: z.string().length(32),
    tags: TagsListSchema
  })
  .strict();

const EntryTagsArgsSchema = z
  .object({
    ref: EntryRefSchema,
    tags: TagsListSchema
  })
  .strict();

const UpdateTagArgsSchema = z
  .object({
    slug: z.string(),
    label: z.string()
  })
  .strict();

const MigrateEntriesArgsSchema = z
  .object({
    type: z.string(),
    merge_patch: ObjectOrJsonString.optional(),
    filter: ObjectOrJsonString.optional(),
    dry_run: z.boolean().optional(),
    author: z.string().optional(),
    limit: IntFromStringOrNumber.refine((n) => n >= 1 && n <= 500, 'limit must be 1-500').optional()
  })
  .strict();

const GetAssetArgsSchema = z
  .object({
    id: z.string().length(32),
    version: IntFromStringOrNumber.optional()
  })
  .strict();

const ListAssetsArgsSchema = z
  .object({
    kind: z.string().optional(),
    limit: IntFromStringOrNumber.refine((n) => n >= 1 && n <= 200, 'limit must be 1-200').optional(),
    offset: IntFromStringOrNumber.refine((n) => n >= 0, 'offset must be >= 0').optional(),
    includeDeleted: z.boolean().optional()
  })
  .strict();

export const SERVER_NAME = 'ledric';
export const SERVER_VERSION = PKG_VERSION;

export const SERVER_INSTRUCTIONS = `ledric is a self-hosted, MCP-native CMS. You can fully define and evolve the content model AND author content through this MCP — schemas and entries are both first-class data here.

Always start with describe_model. It returns every content type's fields, validation rules, summary_fields projection, runtime capabilities, and a hand-written \`example\` per type. The example is your template — imitate it when drafting and your content will validate cleanly. Each field type's spec in \`capabilities.fieldTypeSpecs\` carries an optional \`wire_shape\` block — read it before writing values for \`asset\`, \`references\`, \`markdown\`, \`date\`, or \`vector\`. The wire shape distinguishes input form from output form (e.g. references write as \`["type/slug"]\` strings even though they read back as resolved objects when \`resolve_references\` is set).

Core workflows:
- Add a content type: create_type with a name, a fields map (each field has a type discriminator like {"type":"string","required":true,"max":200}), and ideally a hand-written example value.
- Evolve a type: alter_type with parent_version (optimistic concurrency) and a JSON Merge Patch (RFC 7396) describing the change. The response includes a change_class — "safe" | "needs_backfill" | "destructive". Pass dry_run:true to preview without writing.
- Author content: draft creates (omit ref) or updates (ref + parent_version) an entry. Slug auto-derives from the type's identifier_field if present.
- Publish: publish moves the published_version pointer forward. Drafts stay invisible to the published-content read path until you publish them.
- List + read: find returns paginated entries; read returns one. Both support locale projection, asset expansion, and inline-ref resolution.

Response shape (read / find / draft). Every entry comes back as a flat envelope: { id, type, slug, version, published_version?, fields, tags? }. YOUR CONTENT LIVES UNDER \`fields\`. Top-level keys are entry metadata; everything you defined on the type lives inside \`fields\`. So a blog_post's title is \`entry.fields.title\`, not \`entry.title\`. find returns { total, offset, results: Entry[] }.
- Backfill after a schema change: migrate_entries walks every entry of a type, optionally applying a merge_patch, and re-stamps with the current schema_version.
- Rename: rename_entry retires the old slug (which keeps redirecting forever) and assigns a new one.
- Delete: delete_entry soft-deletes a single entry (parent_version required); reads stop seeing it but the row stays. delete_type soft-deletes a content type (parent_version required); refuses with TYPE_NOT_EMPTY when entries remain unless cascade:true is passed, which deletes the type and every entry in one transaction.
- Tags: add_asset_tags / remove_asset_tags / add_entry_tags / remove_entry_tags accept free-form strings ("#Featured Event", "featured event", "FEATURED EVENT" all collapse to slug "featured-event"). The first writer of a new tag wins its display label; later writers inherit it. update_tag relabels an existing slug; list_tags returns every tag with usage counts. Filter on listAssets/find with \`tags: [...]\` (AND semantics — entries/assets must have ALL listed tags). Tags are surfaced on every Asset/Entry shape via \`tags: [{ slug, label }]\`.

Field types — use these as the "type" discriminator on each field def:
  string, number, boolean, date, slug, enum, asset, references, array, object, vector, markdown, jss, css.
  - object: nested {fields: {...}}; defaults to strict (rejects unknown keys) — set strict:false to allow extras.
  - array: item shape via {of: <FieldDef>}; min/max for length.
  - markdown: optional html policy ('allow' | 'sanitize' | 'forbid', default 'sanitize').
  - references: {to: ["type", ...]} declares which entry types are valid targets. Pinning ('auto' | 'manual' | 'forbidden') controls @version semantics; default 'auto'.
  - jss: CSS-in-JS object stored as JSON. Top-level keys are CSS selectors, values are rule objects whose entries are CSS properties (string/number) or nested rule objects (for &:hover, @media, ...). The string "@apply": "tailwind utilities" is permitted as a property value — utility resolution happens at the consumer renderer; ledric only validates shape.
  - css: raw CSS source string with optional max length.
  Any field may declare "default": <value> — applied at write time when the field is omitted/null. The default's runtime type must match the field's discriminator (validated at create_type / alter_type).

Conventions worth knowing:
- Localization. A type with locales[] declared accepts a _locale sidecar in content: {..., "_locale": {"fr": {"title": "...", "body": "..."}}}. Pass locale on reads to project the entry into that locale (with the configured fallback chain). Fields opt in via "localized": true.
- Asset fields hold 32-char hex ids — STABLE across versions, what entry content carries. The bytes URL is keyed on a separate per-version ref_key (also 32-char hex), so URLs change automatically when bytes change. Pass expand_assets: true on read/find to inline {id, ref_key, kind, version, meta, url} so SDK consumers don't round-trip per image.
- Replacing asset bytes: update_asset { id, parent_version, bytes_b64, meta? } bumps assets.current_version, mints a new ref_key, leaves the asset id intact. Reading entries afterwards through expand_assets surfaces the new url automatically.
- Image transforms (consumer-side URL concern). Asset URLs accept imgix-style query params for resize / format / quality: w, h, fit (clip|crop, with cover/contain aliases), q (1-100), fm (jpg|png|webp|avif), auto=format (server picks best from Accept), dpr (1-4 multiplier on w/h). Example: /assets/<id>?w=400&fm=webp. Source bytes never change; transformed bytes are computed at request time and cached. Don't store transform params in entry content — that's a renderer-side decision per page/breakpoint.
- Structural references (the references field type and inline :::ref{to="type/slug"}::: directives) accept an optional @version suffix to pin: "blog_post/hello@3". On draft, dangling or wrong-typed refs come back as warnings (the draft still saves). On publish, the same issues become errors — VALIDATION_FAILED with a structured errors[] payload. read of an entry whose stored content has unresolved refs attaches a _warnings sidecar so callers can flag stale targets without re-running the check.
- references-typed FIELD VALUES are stored as arrays of "type/slug" strings (optionally "type/slug@version"). When drafting, write them in that string form — NOT as objects. The resolved {id, type, slug, version, fields} object shape is an OUTPUT shape produced by resolve_references on read.
- Two different resolution mechanisms, easy to confuse:
  - resolve_references (the references FIELD type): pass resolve_references: true (or a list of field names) on read/find to inline the resolved entries into the field value. Fields stay as arrays; each "type/slug" string becomes the resolved entry envelope. Unresolvable entries become null in the slot.
  - resolve_refs (markdown :::ref{}::: DIRECTIVES): pass resolve_refs: true on read/find to walk markdown bodies for inline directives and attach a _refs sidecar listing resolved targets. Does not touch references fields.
- All top-level content keys starting with _ (like _locale, _redirect, _refs, _warnings) are reserved for ledric system metadata. Field names cannot start with _.
- Optimistic concurrency: alter_type and draft-on-update require parent_version. A stale parent_version returns VERSION_CONFLICT with the current version so you can re-read and retry.

Errors carry structured detail. VALIDATION_FAILED responses include errors[] with {path, code, message, expected, actual} per failure — path is a JSON Pointer ("/cta/style", "/sections/0") so you can point users at the exact field. VERSION_CONFLICT responses include current_version and your_parent_version so a retry can re-read and recompute.

When in doubt, call describe_model. It's cheap, idempotent, and tells you everything you need to construct any other call.`;

export function createMcpServer(core: Core): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'describe_model',
        description:
          "Return the full content model: every type's fields, summary fields, example, plus the runtime capabilities of this ledric instance.",
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      },
      {
        name: 'create_type',
        description:
          'Create a new content type. Fields values follow the canonical JSON form from @ledric/schema. The returned object is the newly-written type at version 1.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'The type name. Lowercase, must match /^[a-z][a-z0-9_]*$/.'
            },
            fields: {
              type: 'object',
              description: 'Map of field name → FieldDef (each has a "type" discriminator).',
              additionalProperties: { type: 'object' }
            },
            opts: {
              type: 'object',
              description: 'Optional type-level settings.',
              properties: {
                description: { type: 'string' },
                identifier_field: { type: 'string' },
                display_field: { type: 'string' },
                summary_fields: { type: 'array', items: { type: 'string' } },
                on_slug_change: { enum: ['redirect', 'error', 'silent'] },
                example: { type: 'object' }
              },
              additionalProperties: false
            },
            author: { type: 'string' }
          },
          required: ['name', 'fields'],
          additionalProperties: false
        }
      },
      {
        name: 'alter_type',
        description:
          'Mutate an existing content type via JSON Merge Patch (RFC 7396). Returns { name, version, change_class, diff }. `change_class` is one of safe | needs_backfill | destructive. Pass `dry_run: true` to preview without writing. `parent_version` must equal the type\'s current version (optimistic concurrency).',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            parent_version: {
              type: 'integer',
              description: "The type's current version. Must match."
            },
            merge_patch: {
              type: 'object',
              description:
                'Recursive RFC 7396 merge patch applied to the stored TypeDef. Null values delete keys.',
              additionalProperties: true
            },
            dry_run: { type: 'boolean' },
            author: { type: 'string' }
          },
          required: ['name', 'parent_version', 'merge_patch'],
          additionalProperties: false
        }
      },
      {
        name: 'draft',
        description:
          'Create or update a draft entry. Omit `ref` to create a new entry (slug derived from the type\'s identifier_field). Provide `ref` + `parent_version` to update an existing entry with optimistic concurrency. The returned object is the new content plus its version.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', description: 'Content type name.' },
            fields: {
              type: 'object',
              description: 'Entry content keyed by field name.',
              additionalProperties: true
            },
            ref: {
              type: 'object',
              description: 'Optional ref identifying an existing entry to update.',
              properties: {
                type: { type: 'string' },
                slug: { type: 'string' }
              },
              required: ['type', 'slug'],
              additionalProperties: false
            },
            parent_version: {
              type: 'integer',
              description: 'Required on update. Must equal the entry\'s current version.'
            },
            author: { type: 'string' }
          },
          required: ['type', 'fields'],
          additionalProperties: false
        }
      },
      {
        name: 'read',
        description:
          'Read a single entry by type + slug. Returns the current version by default; pass `version` for a specific historical version. Pass `locale` to project the entry into that locale (returns the localized field values flat, with fallback chain applied).',
        inputSchema: {
          type: 'object',
          properties: {
            ref: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                slug: { type: 'string' }
              },
              required: ['type', 'slug'],
              additionalProperties: false
            },
            version: { type: 'integer' },
            locale: { type: 'string', description: 'IETF locale tag (e.g. "fr"). Must be in the type\'s locales[].' },
            expand_assets: {
              description:
                'Resolve asset-typed fields. true expands every asset field on the type; an array of field names expands just those.',
              oneOf: [
                { type: 'boolean' },
                { type: 'array', items: { type: 'string' } }
              ]
            },
            resolve_references: {
              description:
                'Inline `references`-typed field values. true expands every references-typed field on the type; an array of field names expands just those. Distinct from resolve_refs (which walks markdown bodies for :::ref{} directives).',
              oneOf: [
                { type: 'boolean' },
                { type: 'array', items: { type: 'string' } }
              ]
            },
            resolve_refs: {
              type: 'boolean',
              description:
                'Walk markdown fields for :::ref{to="type/slug"}::: directives, resolve each, and attach a _refs sidecar to the response.'
            },
            include_private: {
              type: 'boolean',
              description:
                'Include fields marked private:true in the response. Default false — public-facing reads should leave it off; admin / authoring reads should pass true.'
            }
          },
          required: ['ref'],
          additionalProperties: false
        }
      },
      {
        name: 'find',
        description:
          'List entries of a type. `where` supports exact-match filters on top-level fields. `q` runs a full-text search across the type\'s `searchable: true` fields (overrides `order` with relevance rank). `published: true` returns only currently-published entries (drafts excluded; each result projects from its published version, not the head). `limit` defaults to 20 (max 200). Pass `locale` to project each result into that locale and to scope `q` matches to that locale. Returns { results, total, offset }.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            where: {
              type: 'object',
              description: 'Map of field name → exact-match value. Ignored when `q` is set.',
              additionalProperties: true
            },
            q: {
              type: 'string',
              description: 'Full-text search query. Matches across the type\'s searchable:true string + markdown fields. Results are ranked by relevance.'
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Filter to entries that have ALL of these tags (AND semantics).'
            },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
            order: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  field: { type: 'string' },
                  dir: { enum: ['asc', 'desc'] }
                },
                required: ['field', 'dir'],
                additionalProperties: false
              }
            },
            includeDeleted: { type: 'boolean' },
            locale: { type: 'string' },
            expand_assets: {
              oneOf: [
                { type: 'boolean' },
                { type: 'array', items: { type: 'string' } }
              ]
            },
            resolve_references: {
              oneOf: [
                { type: 'boolean' },
                { type: 'array', items: { type: 'string' } }
              ]
            },
            resolve_refs: { type: 'boolean' },
            include_private: { type: 'boolean' },
            published: {
              type: 'boolean',
              description: 'When true, restrict to currently-published entries (drafts filtered out; results project from the published version).'
            },
            summary: {
              type: 'boolean',
              description: "When true, project each result's `fields` to only the type's declared `summary_fields` — same projection an admin grid view would use. Reserved sidecars (_locale, _refs) pass through unchanged. Saves tokens for list-page renders that don't need the full body."
            }
          },
          required: ['type'],
          additionalProperties: false
        }
      },
      {
        name: 'get_asset',
        description:
          "Read an asset by id (32-char hex UUIDv7). Returns metadata + the canonical bytes URL — the bytes themselves don't travel through MCP. Fetch them with the CLI (`ledric asset bytes <id>`) or via HTTP at the returned `url` (`GET /assets/<ref_key>`, with imgix-style transforms). Upload via HTTP (`POST /assets`, multipart) or `ledric asset upload <file>`.",
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description: 'Asset id (32-char hex).'
            },
            version: { type: 'integer' }
          },
          required: ['id'],
          additionalProperties: false
        }
      },
      {
        name: 'list_assets',
        description:
          'List assets. Optional `kind` filter (image / video / file / …). Returns summary rows with metadata and storage_ref but no bytes.',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
            includeDeleted: { type: 'boolean' }
          },
          additionalProperties: false
        }
      },
      {
        name: 'migrate_entries',
        description:
          'Re-validate every entry of a type against the type\'s current schema; optionally apply a merge_patch to each matching entry first. Entries that change are re-written as new versions stamped with the current schema_version. Pass `dry_run: true` to preview. `filter` is an exact-match map over top-level fields. Returns { type, schema_version, checked, migrated, failed[] }.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            merge_patch: {
              type: 'object',
              description:
                'RFC 7396 merge patch applied to each entry\'s content before re-validation. Null values delete keys.',
              additionalProperties: true
            },
            filter: {
              type: 'object',
              description: 'Exact-match filter on top-level fields (e.g., only rows published before a cutoff).',
              additionalProperties: true
            },
            dry_run: { type: 'boolean' },
            author: { type: 'string' },
            limit: { type: 'integer', minimum: 1, maximum: 500 }
          },
          required: ['type'],
          additionalProperties: false
        }
      },
      {
        name: 'rename_entry',
        description:
          'Rename an entry by changing its slug. The old slug is retired into slug_history and will keep resolving (reads of the old slug return the entry with _redirect pointing at the new slug). Uniqueness is enforced per (type, slug). Pass `locale` to rename a non-default-locale slug; without it, renames the default-locale slug.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                slug: { type: 'string' }
              },
              required: ['type', 'slug'],
              additionalProperties: false
            },
            new_slug: {
              type: 'string',
              description: '1-64 chars, a-z / 0-9 / hyphens; no leading or trailing hyphen.'
            },
            locale: { type: 'string' }
          },
          required: ['ref', 'new_slug'],
          additionalProperties: false
        }
      },
      {
        name: 'publish',
        description:
          'Mark an entry\'s version as published. Defaults to the current version; pass `version` to publish a specific historical version.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                slug: { type: 'string' }
              },
              required: ['type', 'slug'],
              additionalProperties: false
            },
            version: { type: 'integer' }
          },
          required: ['ref'],
          additionalProperties: false
        }
      },
      {
        name: 'delete_type',
        description:
          'Soft-delete a content type. Requires `parent_version` (optimistic concurrency). With live entries the call fails with TYPE_NOT_EMPTY unless `cascade: true`, which also soft-deletes every entry of the type. Reads stop seeing soft-deleted types and entries; the rows stay in storage and can be recovered manually.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Content type name.' },
            parent_version: {
              type: 'integer',
              description: "The type's current version. Must match."
            },
            cascade: {
              type: 'boolean',
              description:
                'When true, soft-delete every non-deleted entry of this type in the same transaction. Default false (refuses if any entries remain).'
            },
            author: { type: 'string' }
          },
          required: ['name', 'parent_version'],
          additionalProperties: false
        }
      },
      {
        name: 'update_asset',
        description:
          'Replace the bytes of an existing asset in place. The asset id stays put — entry content keeps resolving — but a fresh ref_key is minted, so URLs built from expand_assets change automatically. Requires parent_version (optimistic concurrency) matching assets.current_version. `bytes_b64` is base64-encoded source bytes. Optional `meta` REPLACES the previous meta (no merge); omit it to carry the existing meta forward.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Asset id (32-char hex).' },
            parent_version: {
              type: 'integer',
              description: "The asset's current version. Must match."
            },
            bytes_b64: {
              type: 'string',
              description: 'Base64-encoded raw bytes for the new version.'
            },
            meta: {
              type: 'object',
              description:
                'Optional replacement metadata. When provided, fully replaces previous meta (does not merge).',
              additionalProperties: true
            },
            author: { type: 'string' }
          },
          required: ['id', 'parent_version', 'bytes_b64'],
          additionalProperties: false
        }
      },
      {
        name: 'delete_entry',
        description:
          'Soft-delete a single entry. Requires `parent_version` (optimistic concurrency). Reads stop seeing it, but the row stays in storage. To reuse the same slug for a fresh entry the deleted row must be hard-purged manually for now.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                slug: { type: 'string' }
              },
              required: ['type', 'slug'],
              additionalProperties: false
            },
            parent_version: {
              type: 'integer',
              description: "The entry's current version. Must match."
            },
            author: { type: 'string' }
          },
          required: ['ref', 'parent_version'],
          additionalProperties: false
        }
      },
      {
        name: 'add_asset_tags',
        description:
          'Tag an asset. Inputs are free-form strings ("#Featured Event", "featured event", "FEATURED EVENT" all collapse to slug "featured-event"). The first writer of a new tag wins its display label; later writers inherit it. Use `update_tag` to relabel.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Asset id (32-char hex).' },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1 }
          },
          required: ['id', 'tags'],
          additionalProperties: false
        }
      },
      {
        name: 'remove_asset_tags',
        description: 'Remove tags from an asset by slug match (case/whitespace insensitive). Returns the count removed.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1 }
          },
          required: ['id', 'tags'],
          additionalProperties: false
        }
      },
      {
        name: 'add_entry_tags',
        description: 'Tag an entry. Same normalization rules as add_asset_tags.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                slug: { type: 'string' }
              },
              required: ['type', 'slug'],
              additionalProperties: false
            },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1 }
          },
          required: ['ref', 'tags'],
          additionalProperties: false
        }
      },
      {
        name: 'remove_entry_tags',
        description: 'Remove tags from an entry by slug match.',
        inputSchema: {
          type: 'object',
          properties: {
            ref: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                slug: { type: 'string' }
              },
              required: ['type', 'slug'],
              additionalProperties: false
            },
            tags: { type: 'array', items: { type: 'string' }, minItems: 1 }
          },
          required: ['ref', 'tags'],
          additionalProperties: false
        }
      },
      {
        name: 'list_tags',
        description:
          'Every tag in the env, ordered by total uses (asset_uses + entry_uses) desc, then label asc. Returns [{ slug, label, asset_uses, entry_uses }].',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: 'update_tag',
        description:
          "Relabel a tag. The slug is the stable identity and never changes — passing a new label whose slug would differ still keeps the original slug. Returns null when no tag with that slug exists.",
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: 'Canonical slug of the tag to relabel.' },
            label: { type: 'string', description: 'New display label.' }
          },
          required: ['slug', 'label'],
          additionalProperties: false
        }
      }
    ]
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
      switch (name) {
        case 'describe_model': {
          const result = await core.describeModel();
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }
        case 'create_type': {
          const parsed = CreateTypeArgsSchema.parse(args ?? {});
          const result = await core.createType(parsed);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }
        case 'alter_type': {
          const parsed = AlterTypeArgsSchema.parse(args ?? {});
          const result = await core.alterType(parsed);
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        }
        case 'draft': {
          const parsed = DraftArgsSchema.parse(args ?? {});
          const result = await core.draft(parsed);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  toJsonSafe(entryToWireShape(result as unknown as Record<string, unknown>)),
                  null,
                  2
                )
              }
            ]
          };
        }
        case 'read': {
          const parsed = ReadArgsSchema.parse(args ?? {});
          const result = await core.read(parsed);
          return {
            content: [
              {
                type: 'text',
                text: result === null
                  ? `not_found: ${parsed.ref.type}/${parsed.ref.slug}`
                  : JSON.stringify(
                      toJsonSafe(entryToWireShape(result as unknown as Record<string, unknown>)),
                      null,
                      2
                    )
              }
            ]
          };
        }
        case 'find': {
          const parsed = FindArgsSchema.parse(args ?? {});
          const result = await core.find(parsed);
          const wire = {
            ...result,
            results: result.results.map((r) =>
              entryToWireShape(r as unknown as Record<string, unknown>)
            )
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(toJsonSafe(wire), null, 2) }]
          };
        }
        case 'publish': {
          const parsed = PublishArgsSchema.parse(args ?? {});
          const result = await core.publish(parsed);
          return {
            content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }]
          };
        }
        case 'rename_entry': {
          const parsed = RenameArgsSchema.parse(args ?? {});
          const result = await core.rename(parsed);
          return {
            content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }]
          };
        }
        case 'update_asset': {
          const parsed = UpdateAssetArgsSchema.parse(args ?? {});
          const bytes = new Uint8Array(Buffer.from(parsed.bytes_b64, 'base64'));
          const result = await core.updateAsset({
            id: parsed.id,
            parent_version: parsed.parent_version,
            bytes,
            ...(parsed.meta !== undefined ? { meta: parsed.meta as Record<string, unknown> } : {}),
            ...(parsed.author !== undefined ? { author: parsed.author } : {})
          });
          return {
            content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }]
          };
        }
        case 'delete_type': {
          const parsed = DeleteTypeArgsSchema.parse(args ?? {});
          const result = await core.deleteType(parsed);
          return {
            content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }]
          };
        }
        case 'delete_entry': {
          const parsed = DeleteEntryArgsSchema.parse(args ?? {});
          const result = await core.deleteEntry(parsed);
          return {
            content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }]
          };
        }
        case 'add_asset_tags': {
          const parsed = AssetTagsArgsSchema.parse(args ?? {});
          const result = await core.addAssetTags(parsed.id, parsed.tags);
          return { content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }] };
        }
        case 'remove_asset_tags': {
          const parsed = AssetTagsArgsSchema.parse(args ?? {});
          const result = await core.removeAssetTags(parsed.id, parsed.tags);
          return { content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }] };
        }
        case 'add_entry_tags': {
          const parsed = EntryTagsArgsSchema.parse(args ?? {});
          const result = await core.addEntryTags(parsed.ref, parsed.tags);
          return { content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }] };
        }
        case 'remove_entry_tags': {
          const parsed = EntryTagsArgsSchema.parse(args ?? {});
          const result = await core.removeEntryTags(parsed.ref, parsed.tags);
          return { content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }] };
        }
        case 'list_tags': {
          const result = await core.listTags();
          return { content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }] };
        }
        case 'update_tag': {
          const parsed = UpdateTagArgsSchema.parse(args ?? {});
          const result = await core.updateTag(parsed.slug, parsed.label);
          return { content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }] };
        }
        case 'get_asset': {
          const parsed = GetAssetArgsSchema.parse(args ?? {});
          const result = await core.getAsset(parsed);
          return {
            content: [
              {
                type: 'text',
                text:
                  result === null
                    ? `not_found: asset ${parsed.id}`
                    : JSON.stringify(toJsonSafe(result), null, 2)
              }
            ]
          };
        }
        case 'list_assets': {
          const parsed = ListAssetsArgsSchema.parse(args ?? {});
          const result = await core.listAssets(parsed);
          return {
            content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }]
          };
        }
        case 'migrate_entries': {
          const parsed = MigrateEntriesArgsSchema.parse(args ?? {});
          const result = await core.migrateEntries(parsed);
          return {
            content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }]
          };
        }
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: 'text', text: JSON.stringify(serializeToolError(err), null, 2) }
        ]
      };
    }
  });

  return server;
}

function serializeToolError(err: unknown): Record<string, unknown> {
  // Strings, numbers, plain objects — wrap as INTERNAL because the
  // throw site shouldn't have been a non-Error in the first place.
  if (!(err instanceof Error)) {
    return {
      code: 'INTERNAL',
      message: `non-Error thrown: ${String(err)}`
    };
  }
  const e = err as Error & {
    code?: unknown;
    errors?: unknown;
    current_version?: unknown;
    your_parent_version?: unknown;
    type?: unknown;
    slug?: unknown;
    kind?: unknown;
    ref?: unknown;
    entry_count?: unknown;
    field?: unknown;
    value?: unknown;
    conflicting_slug?: unknown;
    constraint?: unknown;
    limit?: unknown;
  };
  // Default to INTERNAL so unhandled JS errors (TypeError,
  // ReferenceError, anything without an explicit `code`) are clearly
  // distinguishable from typed validation / version-conflict / not-
  // found errors. The previous default of TOOL_ERROR conflated the
  // two and made agents assume retryable validation issues when the
  // real cause was a server-side bug.
  const code = typeof e.code === 'string' ? e.code : 'INTERNAL';
  const out: Record<string, unknown> = {
    code,
    message: err.message
  };
  // INTERNAL errors sometimes need a hint that they're not the
  // caller's fault — flag the original error class so an agent
  // doesn't waste turns "fixing" its input.
  if (code === 'INTERNAL' && err.constructor.name !== 'Error') {
    out.error_class = err.constructor.name;
  }
  if (Array.isArray(e.errors)) out.errors = e.errors;
  if (typeof e.current_version === 'number') out.current_version = e.current_version;
  if (typeof e.your_parent_version === 'number') {
    out.your_parent_version = e.your_parent_version;
  }
  if (typeof e.type === 'string') out.type = e.type;
  if (typeof e.slug === 'string') out.slug = e.slug;
  if (typeof e.kind === 'string') out.kind = e.kind;
  if (typeof e.ref === 'string') out.ref = e.ref;
  if (typeof e.entry_count === 'number') out.entry_count = e.entry_count;
  if (typeof e.field === 'string') out.field = e.field;
  if (e.value !== undefined && isJsonScalar(e.value)) out.value = e.value;
  if (typeof e.conflicting_slug === 'string') out.conflicting_slug = e.conflicting_slug;
  if (typeof e.constraint === 'string') out.constraint = e.constraint;
  if (e.limit !== undefined && isJsonScalar(e.limit)) out.limit = e.limit;
  return out;
}

function isJsonScalar(v: unknown): boolean {
  return (
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    v === null
  );
}

/**
 * Map an EntryDetail to the wire shape consumers should see — with the
 * field-content map under the key `fields`, matching the HTTP routes'
 * shape. Internally EntryDetail names that property `content` (matches
 * the storage column), but the public API and HTTP responses both use
 * `fields`. Without this mapping, MCP and HTTP returned different
 * shapes for the same data, which broke any client that targeted both
 * surfaces.
 *
 * Other fields are preserved so MCP keeps surfacing things HTTP omits
 * (schema_version, content_hash, current_version) — those are useful
 * for agents introspecting versioning and content identity.
 */
function entryToWireShape(entry: Record<string, unknown>): Record<string, unknown> {
  if (!('content' in entry)) return entry;
  const { content, ...rest } = entry as Record<string, unknown> & {
    content?: unknown;
  };
  return { ...rest, fields: content };
}

function toJsonSafe(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value;
}
