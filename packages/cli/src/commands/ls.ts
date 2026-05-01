import { defineCommand } from 'citty';
import { Core } from '@ledric/core';
import { openSqlite, NotFoundError } from '@ledric/storage';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List entries of a type. Prints a compact JSON array.'
  },
  args: {
    type: {
      type: 'positional',
      description: 'Type name. If omitted, lists all types with entry counts.',
      required: false
    },
    db: {
      type: 'string',
      description: 'Path to the SQLite database file.',
      default: './ledric.db'
    },
    limit: {
      type: 'string',
      description: 'Max results to return (default 20, max 200).',
      default: '20'
    },
    offset: {
      type: 'string',
      description: 'Offset for pagination.',
      default: '0'
    },
    full: {
      type: 'boolean',
      description: 'Include full fields in each row instead of a summary.',
      default: false
    },
    locale: {
      type: 'string',
      description: 'Project each entry into this locale.'
    },
    tag: {
      type: 'string',
      description: 'Comma-separated tag filter (AND semantics).'
    }
  },
  async run({ args }) {
    const storage = await openSqlite({ path: args.db });
    try {
      const core = new Core(storage);

      // No type given → list all types with per-type entry counts.
      if (args.type === undefined || args.type === '') {
        const types = await storage.listTypes();
        const rows: Array<{ name: string; version: number; entries: number }> = [];
        for (const t of types) {
          const count = await core.find({ type: t.name, limit: 1 });
          rows.push({ name: t.name, version: t.current_version, entries: count.total });
        }
        process.stdout.write(
          JSON.stringify({ db: args.db, types: rows }, null, 2) + '\n'
        );
        return;
      }

      const typeDetail = await storage.getType(args.type);
      if (!typeDetail) {
        const known = (await storage.listTypes()).map((t) => t.name);
        process.stderr.write(
          `ledric: no type "${args.type}" in ${args.db}\n` +
            (known.length > 0
              ? `  known types: ${known.join(', ')}\n`
              : `  this database has no types yet; create one with create_type over MCP.\n`)
        );
        process.exit(1);
      }
      const summaryFields = typeDetail.definition.summary_fields ?? [];

      const tags = (typeof args.tag === 'string' && args.tag.length > 0)
        ? args.tag.split(',').map((t) => t.trim()).filter((t) => t.length > 0)
        : [];
      const result = await core.find({
        type: args.type,
        limit: parseInt(args.limit, 10),
        offset: parseInt(args.offset, 10),
        ...(args.locale !== undefined ? { locale: args.locale } : {}),
        ...(tags.length > 0 ? { tags } : {})
      });

      const rows = result.results.map((r) => {
        const fields = args.full
          ? r.content
          : pick(r.content, summaryFields);
        return {
          id: toHex(r.id),
          slug: r.slug,
          version: r.current_version,
          published_version: r.published_version,
          fields,
          tags: r.tags
        };
      });

      process.stdout.write(
        JSON.stringify(
          { type: args.type, total: result.total, offset: result.offset, results: rows },
          null,
          2
        ) + '\n'
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        process.stderr.write(`ledric: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    } finally {
      await storage.close();
    }
  }
});

function pick(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  if (keys.length === 0) return source;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in source) out[k] = source[k];
  }
  return out;
}
