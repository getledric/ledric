import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Core } from '@ledric/core';

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
    resolve_refs: z.boolean().optional()
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
    resolve_refs: z.boolean().optional()
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
export const SERVER_VERSION = '0.0.0';

export function createMcpServer(core: Core): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
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
            resolve_refs: {
              type: 'boolean',
              description:
                'Walk markdown fields for :::ref{to="type/slug"}::: directives, resolve each, and attach a _refs sidecar to the response.'
            }
          },
          required: ['ref'],
          additionalProperties: false
        }
      },
      {
        name: 'find',
        description:
          'List entries of a type. `where` supports exact-match filters on top-level fields. `limit` defaults to 20 (max 200). `order` sorts by one or more fields. Pass `locale` to project each result into that locale. Returns { results, total, offset }.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            where: {
              type: 'object',
              description: 'Map of field name → exact-match value.',
              additionalProperties: true
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
            resolve_refs: { type: 'boolean' }
          },
          required: ['type'],
          additionalProperties: false
        }
      },
      {
        name: 'get_asset',
        description:
          'Read an asset by id (32-char hex UUIDv7). Returns metadata only — bytes are fetched via the CLI (ledric asset bytes <id>) or a future HTTP endpoint. Uploads go through the CLI (ledric asset upload <file>) for the same reason.',
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
            content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }]
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
                  : JSON.stringify(toJsonSafe(result), null, 2)
              }
            ]
          };
        }
        case 'find': {
          const parsed = FindArgsSchema.parse(args ?? {});
          const result = await core.find(parsed);
          return {
            content: [{ type: 'text', text: JSON.stringify(toJsonSafe(result), null, 2) }]
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
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: message }]
      };
    }
  });

  return server;
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
