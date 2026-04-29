import { defineCommand } from 'citty';
import { SqliteStorage, generateApiKey } from '@ledric/storage';
import type { ApiKeyRole } from '@ledric/storage';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function fmtTime(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toISOString();
}

const listCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List API keys with their prefix, role, and last-used time.'
  },
  args: {
    db: {
      type: 'string',
      description: 'Path to the SQLite database file.',
      default: './ledric.db'
    },
    'include-revoked': {
      type: 'boolean',
      description: 'Also show revoked keys.',
      default: false
    }
  },
  async run({ args }) {
    const storage = await SqliteStorage.open({ path: args.db });
    try {
      const rows = await storage.listApiKeys({
        includeRevoked: args['include-revoked']
      });
      if (rows.length === 0) {
        process.stderr.write(
          'ledric: no API keys yet. Auth is currently disabled.\n' +
            '       Run `ledric keys create --role admin` to enable it.\n'
        );
        return;
      }
      // Pretty table on stdout.
      const header = ['ID', 'ROLE', 'PREFIX', 'LABEL', 'CREATED', 'LAST USED', 'REVOKED'];
      const lines = rows.map((r) => [
        toHex(r.id).slice(0, 8),
        r.role,
        r.key_prefix + '…',
        r.label ?? '—',
        fmtTime(r.created_at),
        fmtTime(r.last_used_at),
        fmtTime(r.revoked_at)
      ]);
      const widths = header.map((h, i) =>
        Math.max(h.length, ...lines.map((l) => l[i]!.length))
      );
      const fmtRow = (cells: string[]): string =>
        cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
      process.stdout.write(fmtRow(header) + '\n');
      process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
      for (const l of lines) process.stdout.write(fmtRow(l) + '\n');
    } finally {
      await storage.close();
    }
  }
});

const createCommand = defineCommand({
  meta: {
    name: 'create',
    description:
      'Mint a new API key. The plaintext secret is printed ONCE — capture it now.'
  },
  args: {
    db: {
      type: 'string',
      description: 'Path to the SQLite database file.',
      default: './ledric.db'
    },
    role: {
      type: 'string',
      description: '"admin" (read + write) or "reader" (read-only).',
      required: true
    },
    label: {
      type: 'string',
      description: 'Optional human-friendly label (e.g. "vercel-prod").'
    }
  },
  async run({ args }) {
    if (args.role !== 'admin' && args.role !== 'reader') {
      process.stderr.write(
        `ledric: --role must be "admin" or "reader" (got "${args.role}")\n`
      );
      process.exit(1);
    }
    const role: ApiKeyRole = args.role;
    const storage = await SqliteStorage.open({ path: args.db });
    try {
      const k = generateApiKey(role);
      await storage.createApiKey({
        role: k.role,
        key_hash: k.hash,
        key_prefix: k.prefix,
        ...(args.label !== undefined ? { label: args.label } : {})
      });
      process.stdout.write(
        [
          '',
          `New ${role} key created${args.label ? ` (${args.label})` : ''}:`,
          '',
          `  ${k.secret}`,
          '',
          'This is the ONLY time the secret will be shown.',
          'Save it somewhere safe — you can rotate or revoke later.',
          ''
        ].join('\n')
      );
    } finally {
      await storage.close();
    }
  }
});

const revokeCommand = defineCommand({
  meta: {
    name: 'revoke',
    description: 'Revoke a key by its 8-char id prefix (from `keys list`).'
  },
  args: {
    db: {
      type: 'string',
      description: 'Path to the SQLite database file.',
      default: './ledric.db'
    },
    id: {
      type: 'positional',
      description: 'Key id prefix (first 8 hex chars from `keys list`).',
      required: true
    }
  },
  async run({ args }) {
    const storage = await SqliteStorage.open({ path: args.db });
    try {
      // Match the user-supplied id-prefix against existing keys. We
      // accept a partial match (8 chars by default in the table) so the
      // operator can paste straight from `keys list`.
      const rows = await storage.listApiKeys({ includeRevoked: true });
      const matches = rows.filter(
        (r) => toHex(r.id).startsWith(args.id.toLowerCase())
      );
      if (matches.length === 0) {
        process.stderr.write(`ledric: no key matches id prefix "${args.id}"\n`);
        process.exit(1);
      }
      if (matches.length > 1) {
        process.stderr.write(
          `ledric: id prefix "${args.id}" is ambiguous (${matches.length} matches). Use a longer prefix.\n`
        );
        process.exit(1);
      }
      const target = matches[0]!;
      if (target.revoked_at !== null) {
        process.stderr.write(
          `ledric: key ${toHex(target.id).slice(0, 8)} was already revoked at ${fmtTime(target.revoked_at)}.\n`
        );
        return;
      }
      const result = await storage.revokeApiKey(target.id);
      process.stdout.write(
        `Revoked ${target.role} key ${toHex(target.id).slice(0, 8)} (${target.key_prefix}…) at ${fmtTime(result?.revoked_at ?? null)}\n`
      );
    } finally {
      await storage.close();
    }
  }
});

export const keysCommand = defineCommand({
  meta: {
    name: 'keys',
    description: 'Manage API keys (list, create, revoke).'
  },
  subCommands: {
    list: listCommand,
    create: createCommand,
    revoke: revokeCommand
  }
});
