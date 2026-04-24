import { defineCommand } from 'citty';
import { Core } from '@ledric/core';
import { SqliteStorage } from '@ledric/storage';

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
      description: 'Path to the SQLite database file.',
      default: './ledric.db'
    },
    version: {
      type: 'string',
      description: 'Read a specific historical version (integer).'
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

    const storage = await SqliteStorage.open({ path: args.db });
    try {
      const core = new Core(storage);
      const versionNum = args.version ? parseInt(args.version, 10) : undefined;
      const entry = await core.read({
        ref: { type, slug },
        ...(versionNum !== undefined ? { version: versionNum } : {})
      });

      if (!entry) {
        process.stderr.write(`not found: ${type}/${slug}\n`);
        process.exit(1);
      }

      const output: Record<string, unknown> = {
        id: toHex(entry.id),
        type: entry.type,
        slug: entry.slug,
        version: entry.version,
        fields: entry.content
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
    } finally {
      await storage.close();
    }
  }
});
