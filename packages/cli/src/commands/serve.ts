import { defineCommand } from 'citty';
import { Core } from '@ledric/core';
import { SqliteStorage } from '@ledric/storage';
import { runStdio } from '@ledric/mcp-server';

export const serveCommand = defineCommand({
  meta: {
    name: 'serve',
    description: 'Start ledric as an MCP server over stdio.'
  },
  args: {
    db: {
      type: 'string',
      description: 'Path to the SQLite database file.',
      default: './ledric.db'
    }
  },
  async run({ args }) {
    const storage = await SqliteStorage.open({ path: args.db });
    const core = new Core(storage);

    process.stderr.write(`ledric: opened ${args.db}; MCP stdio server ready\n`);

    const shutdown = async (signal: string): Promise<void> => {
      process.stderr.write(`ledric: ${signal} received, shutting down\n`);
      try {
        await storage.close();
      } finally {
        process.exit(0);
      }
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));

    await runStdio(core);
  }
});
