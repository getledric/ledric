import { defineCommand } from 'citty';
import { Core } from '@ledric/core';
import { SqliteStorage } from '@ledric/storage';
import { resolveDb } from '../config.js';

function splitTags(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

function parseEntryRef(arg: string): { type: string; slug: string } {
  const ix = arg.indexOf('/');
  if (ix <= 0 || ix === arg.length - 1) {
    process.stderr.write(`error: ref must be <type>/<slug>, got "${arg}"\n`);
    process.exit(2);
  }
  return { type: arg.slice(0, ix), slug: arg.slice(ix + 1) };
}

export const tagCommand = defineCommand({
  meta: {
    name: 'tag',
    description: 'Add tags to an entry. Comma-separated tags accepted ("Featured Event, hero").'
  },
  args: {
    ref: { type: 'positional', description: '<type>/<slug>', required: true },
    tags: { type: 'positional', description: 'Comma-separated tags.', required: true },
    db: { type: 'string', description: 'Path to the SQLite database file. Defaults to ledric.config.json or ./ledric.db.' }
  },
  async run({ args }) {
    const tags = splitTags(args.tags);
    if (tags.length === 0) {
      process.stderr.write('ledric: no tags provided\n');
      process.exit(1);
    }
    const ref = parseEntryRef(args.ref);
    const storage = await SqliteStorage.open({ path: resolveDb(args.db) });
    try {
      const core = new Core(storage);
      const result = await core.addEntryTags(ref, tags);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } finally {
      await storage.close();
    }
  }
});

export const untagCommand = defineCommand({
  meta: {
    name: 'untag',
    description: 'Remove tags from an entry. Matches by slug (case-insensitive).'
  },
  args: {
    ref: { type: 'positional', required: true },
    tags: { type: 'positional', required: true },
    db: { type: 'string', description: 'Path to the SQLite database file. Defaults to ledric.config.json or ./ledric.db.' }
  },
  async run({ args }) {
    const tags = splitTags(args.tags);
    if (tags.length === 0) {
      process.stderr.write('ledric: no tags provided\n');
      process.exit(1);
    }
    const ref = parseEntryRef(args.ref);
    const storage = await SqliteStorage.open({ path: resolveDb(args.db) });
    try {
      const core = new Core(storage);
      const result = await core.removeEntryTags(ref, tags);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } finally {
      await storage.close();
    }
  }
});

export const tagsCommand = defineCommand({
  meta: {
    name: 'tags',
    description: 'List every tag in the env with usage counts.'
  },
  args: {
    db: { type: 'string', description: 'Path to the SQLite database file. Defaults to ledric.config.json or ./ledric.db.' }
  },
  async run({ args }) {
    const storage = await SqliteStorage.open({ path: resolveDb(args.db) });
    try {
      const core = new Core(storage);
      const result = await core.listTags();
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } finally {
      await storage.close();
    }
  }
});
