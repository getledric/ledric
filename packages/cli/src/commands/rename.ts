import { defineCommand } from 'citty';
import { Core } from '@ledric/core';
import { SqliteStorage, NotFoundError } from '@ledric/storage';

export const renameCommand = defineCommand({
  meta: {
    name: 'rename',
    description: 'Rename an entry. Old slug keeps resolving via redirect.'
  },
  args: {
    ref: {
      type: 'positional',
      description: '<type>/<old-slug>',
      required: true
    },
    'new-slug': {
      type: 'positional',
      description: 'New slug.',
      required: true
    },
    db: {
      type: 'string',
      default: './ledric.db'
    }
  },
  async run({ args }) {
    const [type, slug] = args.ref.split('/');
    if (!type || !slug) {
      process.stderr.write(`error: ref must be <type>/<slug>, got "${args.ref}"\n`);
      process.exit(2);
    }
    const storage = await SqliteStorage.open({ path: args.db });
    try {
      const core = new Core(storage);
      const result = await core.rename({
        ref: { type, slug },
        new_slug: args['new-slug']
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
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
