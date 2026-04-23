#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import { serveCommand } from './commands/serve.js';

const CONFIG_HELP = `
ledric — MCP/LLM-native self-hosted CMS

USAGE
  ledric serve                 start the MCP server on stdio (uses ./ledric.db)
  ledric serve --db <path>     use a different SQLite file

HOOK IT UP TO YOUR MCP CLIENT

Claude Desktop  (~/Library/Application Support/Claude/claude_desktop_config.json):

  {
    "mcpServers": {
      "ledric": {
        "command": "npx",
        "args": ["-y", "ledric", "serve"],
        "cwd": "/absolute/path/to/your/content/dir"
      }
    }
  }

Claude Code  (one-liner):

  claude mcp add ledric -- npx -y ledric serve

Then restart the client and ask it to call describe_model.

Run \`ledric --help\` for full CLI help.
`;

const main = defineCommand({
  meta: {
    name: 'ledric',
    description: 'ledric — MCP/LLM-native self-hosted CMS.'
  },
  subCommands: {
    serve: serveCommand
  },
  run() {
    // Citty invokes the parent's `run` even when a subcommand matches; only
    // print the banner when the user genuinely passed no arguments, otherwise
    // this would corrupt `serve`'s MCP stdio protocol.
    if (process.argv.slice(2).length > 0) return;
    process.stdout.write(CONFIG_HELP);
  }
});

void runMain(main);
