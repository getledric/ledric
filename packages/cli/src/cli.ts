#!/usr/bin/env node
import { defineCommand, runMain } from 'citty';
import { serveCommand } from './commands/serve.js';
import { httpCommand } from './commands/http.js';
import { getCommand } from './commands/get.js';
import { lsCommand } from './commands/ls.js';
import { assetCommand } from './commands/asset.js';
import { renameCommand } from './commands/rename.js';
import { refsCommand } from './commands/refs.js';
import { keysCommand } from './commands/keys.js';
import { tagCommand, untagCommand, tagsCommand } from './commands/tag.js';
import { initCommand } from './commands/init.js';

const CONFIG_HELP = `
ledric — MCP/LLM-native self-hosted CMS

USAGE
  ledric init                        interactive setup: writes ledric.config.json,
                                     patches .mcp.json, optionally mints API keys
  ledric init --yes                  non-interactive — accept all defaults
  ledric serve                       MCP stdio (default; uses ./ledric.db)
  ledric serve --http                 … plus the HTTP API on :3000
  ledric serve --gui                 … plus HTTP and the admin GUI at /admin
  ledric http                        HTTP-only (no MCP)
  ledric http --port 8080             … on a different port
  ledric http --gui                  … with the admin UI
  ledric get <type>/<slug>           read one entry (consumer-facing shape)
  ledric get <type>/<slug> --meta    include _meta (version, hash, timestamps)
  ledric ls                          list every type in the DB with entry counts
  ledric ls <type>                   list entries of a type (summary fields only)
  ledric ls <type> --full            list entries with full content
  ledric asset upload <file>         upload a file (db backend by default)
  ledric asset upload <file> --assets-backend local
                                     … or write bytes to ./ledric-assets
  ledric asset replace <id> <file>   in-place bytes replacement (bumps version, mints fresh ref_key)
  ledric asset ls [--kind image]     list assets
  ledric asset get <id>              read asset metadata (incl. ref_key)
  ledric asset bytes <id>            write asset bytes to stdout
  ledric rename <type>/<old> <new>   rename an entry (old slug keeps redirecting)
  ledric refs check                  lint all entries for dangling :::ref{} directives
  ledric keys list                   show issued API keys (prefix only)
  ledric keys create --role admin    mint a new admin or reader key (prints once)
  ledric keys revoke <id-prefix>     revoke a key

HOOK IT UP TO YOUR MCP CLIENT

Claude Desktop  (~/Library/Application Support/Claude/claude_desktop_config.json):

  {
    "mcpServers": {
      "ledric": {
        "command": "npx",
        "args": ["-y", "ledric", "serve", "--gui"],
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
    init: initCommand,
    serve: serveCommand,
    http: httpCommand,
    get: getCommand,
    ls: lsCommand,
    asset: assetCommand,
    rename: renameCommand,
    refs: refsCommand,
    keys: keysCommand,
    tag: tagCommand,
    untag: untagCommand,
    tags: tagsCommand
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
