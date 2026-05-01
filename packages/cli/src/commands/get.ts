import { defineCommand } from 'citty';
import { Core } from '@ledric/core';
import { SqliteStorage, NotFoundError } from '@ledric/storage';
import { resolveDb } from '../config.js';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

export const getCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Read an entry by <type>/<slug>. Prints what a consumer SDK would see.'
  },
  args: {
    ref: {
      type: 'positional',
      description: '<type>/<slug> — e.g. "blog_post/hello-world"',
      required: true
    },
    db: {
      type: 'string',
      description: 'Path to the SQLite database file. Defaults to ledric.config.json or ./ledric.db.'
    },
    version: {
      type: 'string',
      description: 'Read a specific historical version (integer).'
    },
    locale: {
      type: 'string',
      description: 'Project the entry into this locale.'
    },
    'expand-assets': {
      type: 'boolean',
      description: 'Resolve asset-typed fields to { id, kind, meta, url } inline.',
      default: false
    },
    meta: {
      type: 'boolean',
      description: 'Include _meta (version numbers, content hash, created_at).',
      default: false
    }
  },
  async run({ args }) {
    const [type, slug] = args.ref.split('/');
    if (!type || !slug) {
      process.stderr.write(
        `error: ref must be of the form <type>/<slug>, got "${args.ref}"\n`
      );
      process.exit(2);
    }

    const dbPath = resolveDb(args.db);
    const storage = await SqliteStorage.open({ path: dbPath });
    try {
      const core = new Core(storage);
      const typeDetail = await storage.getType(type);
      if (!typeDetail) {
        const known = (await storage.listTypes()).map((t) => t.name);
        process.stderr.write(
          `ledric: no type "${type}" in ${dbPath}\n` +
            (known.length > 0
              ? `  known types: ${known.join(', ')}\n`
              : `  this database has no types yet; create one with create_type over MCP.\n`)
        );
        process.exit(1);
      }

      const versionNum = args.version ? parseInt(args.version, 10) : undefined;
      const entry = await core.read({
        ref: { type, slug },
        ...(versionNum !== undefined ? { version: versionNum } : {}),
        ...(args.locale !== undefined ? { locale: args.locale } : {}),
        ...(args['expand-assets'] === true ? { expand_assets: true } : {})
      });

      if (!entry) {
        process.stderr.write(`ledric: no entry "${type}/${slug}" in ${dbPath}\n`);
        process.exit(1);
      }

      const output: Record<string, unknown> = {
        id: toHex(entry.id),
        type: entry.type,
        slug: entry.slug,
        version: entry.version,
        ...(args.locale !== undefined ? { locale: args.locale } : {}),
        fields: entry.content,
        ...(entry._redirect !== undefined ? { _redirect: entry._redirect } : {})
      };

      if (args.meta) {
        output._meta = {
          current_version: entry.current_version,
          published_version: entry.published_version,
          schema_version: entry.schema_version,
          content_hash: toHex(entry.content_hash),
          created_at: new Date(entry.created_at).toISOString(),
          ...(entry.deleted_at !== null
            ? { deleted_at: new Date(entry.deleted_at).toISOString() }
            : {})
        };
      }

      process.stdout.write(JSON.stringify(output, null, 2) + '\n');
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
