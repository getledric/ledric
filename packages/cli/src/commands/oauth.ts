import { defineCommand } from 'citty';
import { openSqlite } from '@ledric/storage';
import { listClients, revokeClient } from '@ledric/oauth';
import { resolveDb } from '../config.js';

const dbArg = {
  type: 'string' as const,
  description: 'Path to the SQLite database file. Defaults to ledric.config.json or ./ledric.db.'
};

const clientsListCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List OAuth clients registered against this ledric.'
  },
  args: {
    db: dbArg
  },
  async run({ args }) {
    const storage = await openSqlite({ path: resolveDb(args.db) });
    try {
      const clients = await listClients(storage);
      if (clients.length === 0) {
        process.stderr.write('No OAuth clients registered.\n');
        return;
      }
      // The DCR-supplied name is shown in quotes and labelled "claimed" —
      // operators have stared at this string before approving consent, so
      // the framing has to make its trust level obvious.
      for (const c of clients) {
        process.stdout.write(
          `${c.client_id}\n` +
            `  claimed name: "${c.name}"\n` +
            `  redirect_uris: ${c.redirect_uris.join(', ')}\n` +
            `  grant_types: ${c.grant_types.join(', ')}\n\n`
        );
      }
    } finally {
      await storage.close();
    }
  }
});

const clientsRevokeCommand = defineCommand({
  meta: {
    name: 'revoke',
    description: 'Revoke a registered OAuth client by client_id.'
  },
  args: {
    client_id: {
      type: 'positional',
      description: 'The OAuth client_id to revoke.',
      required: true
    },
    db: dbArg
  },
  async run({ args }) {
    const storage = await openSqlite({ path: resolveDb(args.db) });
    try {
      const ok = await revokeClient(storage, args.client_id);
      if (ok) {
        process.stderr.write(`Revoked OAuth client ${args.client_id}\n`);
      } else {
        process.stderr.write(
          `No OAuth client with id ${args.client_id} (already revoked or never existed).\n`
        );
        process.exit(1);
      }
    } finally {
      await storage.close();
    }
  }
});

const clientsCommand = defineCommand({
  meta: {
    name: 'clients',
    description: 'Manage OAuth clients registered via DCR.'
  },
  subCommands: {
    list: clientsListCommand,
    revoke: clientsRevokeCommand
  }
});

export const oauthCommand = defineCommand({
  meta: {
    name: 'oauth',
    description:
      'OAuth provider admin: list / revoke registered clients. The provider itself is mounted by `serve --public-mcp`.'
  },
  subCommands: {
    clients: clientsCommand
  }
});
