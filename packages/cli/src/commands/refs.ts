import { defineCommand } from 'citty';
import { Core, collectInlineRefs } from '@ledric/core';
import { openSqlite } from '@ledric/storage';
import { resolveDb } from '../config.js';

interface DanglingRef {
  entry_type: string;
  entry_slug: string;
  in_field: string;
  to: string;
  reason: 'invalid_format' | 'not_found';
}

const checkCommand = defineCommand({
  meta: {
    name: 'check',
    description: 'Lint every entry for inline :::ref{} directives that point at missing content.'
  },
  args: {
    db: {
      type: 'string',
      description: 'Path to the SQLite database file. Defaults to ledric.config.json or ./ledric.db.'
    },
    type: {
      type: 'string',
      description: 'Limit the scan to a single content type.'
    },
    json: {
      type: 'boolean',
      description: 'Print structured JSON instead of human text.',
      default: false
    }
  },
  async run({ args }) {
    const storage = await openSqlite({ path: resolveDb(args.db) });
    try {
      const core = new Core(storage);
      const types = args.type
        ? [{ name: args.type }]
        : (await storage.listTypes()).filter((t) => t.deleted_at === null);

      let checkedEntries = 0;
      let checkedRefs = 0;
      const dangling: DanglingRef[] = [];

      for (const t of types) {
        const typeDetail = await storage.getType(t.name);
        if (!typeDetail) continue;
        let offset = 0;
        for (;;) {
          const page = await core.find({ type: t.name, limit: 200, offset });
          if (page.results.length === 0) break;
          for (const entry of page.results) {
            checkedEntries++;
            const sources = collectInlineRefs(entry.content, typeDetail.definition);
            for (const src of sources) {
              checkedRefs++;
              const slashAt = src.to.indexOf('/');
              if (slashAt === -1) {
                dangling.push({
                  entry_type: entry.type,
                  entry_slug: entry.slug,
                  in_field: src.in_field,
                  to: src.to,
                  reason: 'invalid_format'
                });
                continue;
              }
              const refType = src.to.slice(0, slashAt);
              const refSlug = src.to.slice(slashAt + 1);
              const opts: { version?: number; locale?: string } = {};
              if (src.version !== undefined) opts.version = src.version;
              if (src.locale !== undefined) opts.locale = src.locale;
              const target = await storage.readEntry(
                { type: refType, slug: refSlug },
                opts
              );
              if (!target) {
                dangling.push({
                  entry_type: entry.type,
                  entry_slug: entry.slug,
                  in_field: src.in_field,
                  to: src.to,
                  reason: 'not_found'
                });
              }
            }
          }
          offset += page.results.length;
          if (page.results.length < 200) break;
        }
      }

      if (args.json) {
        process.stdout.write(
          JSON.stringify(
            {
              checked_entries: checkedEntries,
              checked_refs: checkedRefs,
              dangling
            },
            null,
            2
          ) + '\n'
        );
      } else {
        const scope = args.type ? `type "${args.type}"` : 'all types';
        process.stdout.write(
          `Checked ${checkedRefs} ref${checkedRefs === 1 ? '' : 's'} across ${checkedEntries} entries in ${scope}.\n`
        );
        if (dangling.length === 0) {
          process.stdout.write('No dangling refs.\n');
        } else {
          process.stdout.write(`\n${dangling.length} dangling ref${dangling.length === 1 ? '' : 's'}:\n`);
          for (const d of dangling) {
            process.stdout.write(
              `  ${d.entry_type}/${d.entry_slug}  ${d.in_field}  → ${d.to}  (${d.reason})\n`
            );
          }
        }
      }

      if (dangling.length > 0) process.exit(1);
    } finally {
      await storage.close();
    }
  }
});

export const refsCommand = defineCommand({
  meta: {
    name: 'refs',
    description: 'Tools for inline ref directives.'
  },
  subCommands: {
    check: checkCommand
  }
});
