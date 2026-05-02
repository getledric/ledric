import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineCommand } from 'citty';
import { Core } from '@ledric/core';
import { openSqlite } from '@ledric/storage';
import { resolveDb } from '../config.js';
import { generateTypes } from '../codegen/types.js';

export const typesCommand = defineCommand({
  meta: {
    name: 'types',
    description:
      'Generate a TypeScript types file (ledric.types.ts) from the live schema, so consumer code is type-safe against your content model.'
  },
  args: {
    out: {
      type: 'string',
      description: 'Output file path. Defaults to ./ledric.types.ts.',
      default: 'ledric.types.ts'
    },
    from: {
      type: 'string',
      description:
        'Source: an HTTP base URL (e.g. http://127.0.0.1:3000) to call /types, or omit to read the local DB directly.'
    },
    db: {
      type: 'string',
      description: 'Path to the SQLite database file when reading locally. Defaults to ledric.config.json or ./ledric.db.'
    },
    'augment-sdk': {
      type: 'boolean',
      description:
        'Emit a declare-module block that augments @ledric/sdk\'s LedricEntries interface, so client.read<\'blog_post\'>(...) picks up the right shape.',
      default: false
    },
    stdout: {
      type: 'boolean',
      description: 'Print to stdout instead of writing a file. Useful for piping into custom locations.',
      default: false
    }
  },
  async run({ args }) {
    let model;
    if (typeof args.from === 'string' && args.from.length > 0) {
      const base = args.from.replace(/\/+$/, '');
      const url = `${base}/types`;
      const res = await fetch(url, {
        headers: process.env.LEDRIC_READER_KEY
          ? { Authorization: `Bearer ${process.env.LEDRIC_READER_KEY}` }
          : process.env.LEDRIC_ADMIN_KEY
            ? { Authorization: `Bearer ${process.env.LEDRIC_ADMIN_KEY}` }
            : {}
      });
      if (!res.ok) {
        process.stderr.write(`ledric: failed to fetch ${url}: HTTP ${res.status}\n`);
        process.exit(1);
      }
      model = await res.json();
    } else {
      const dbPath = resolveDb(args.db);
      const storage = await openSqlite({ path: dbPath });
      try {
        const core = new Core(storage);
        model = await core.describeModel();
      } finally {
        await storage.close();
      }
    }

    const source = generateTypes(model, {
      augmentSdk: args['augment-sdk'] === true
    });

    if (args.stdout === true) {
      process.stdout.write(source);
      if (!source.endsWith('\n')) process.stdout.write('\n');
      return;
    }

    const target = resolve(process.cwd(), args.out);
    writeFileSync(target, source.endsWith('\n') ? source : source + '\n', 'utf8');
    process.stderr.write(
      `ledric: wrote ${target} — ${Object.keys(model.types).length} type(s)\n`
    );
  }
});
