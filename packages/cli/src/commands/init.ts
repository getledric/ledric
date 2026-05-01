import { defineCommand } from 'citty';
import * as p from '@clack/prompts';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync
} from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';
import { SqliteStorage } from '@ledric/storage';
import { bootstrapApiKeysIfEmpty } from './auth-bootstrap.js';
import { configPath, type LedricConfig } from '../config.js';

export interface InitAnswers {
  db: string;
  port: number;
  host: string;
  assetsBackend: 'db' | 'local';
  assetsPath: string | null;
  configureClaudeCode: boolean;
  configureClaudeDesktop: boolean;
  mintKeys: boolean;
  updateGitignore: boolean;
}

export const DEFAULTS: InitAnswers = {
  db: './ledric.db',
  port: 3000,
  host: '127.0.0.1',
  assetsBackend: 'db',
  assetsPath: null,
  configureClaudeCode: true,
  configureClaudeDesktop: false,
  mintKeys: true,
  updateGitignore: true
};

const LEDRIC_GITIGNORE_LINES: readonly string[] = [
  '# ledric',
  'ledric.db',
  'ledric.db-journal',
  'ledric.db-wal',
  'ledric.db-shm',
  'ledric-assets/',
  'ledric-transforms/',
  '.env.local'
];

// ───────────────────────────── pure helpers ─────────────────────────────

export function buildConfig(a: InitAnswers): LedricConfig {
  const cfg: LedricConfig = {
    db: a.db,
    http: { port: a.port, host: a.host },
    assets: { backend: a.assetsBackend }
  };
  if (a.assetsBackend === 'local' && a.assetsPath !== null && cfg.assets) {
    cfg.assets.path = a.assetsPath;
  }
  return cfg;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface McpJsonShape {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export function mergeMcpServers(
  existing: unknown,
  serverName: string,
  entry: McpServerEntry
): McpJsonShape {
  const base: McpJsonShape =
    existing !== null && typeof existing === 'object' && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const servers: Record<string, McpServerEntry> =
    base.mcpServers !== undefined &&
    base.mcpServers !== null &&
    typeof base.mcpServers === 'object'
      ? { ...base.mcpServers }
      : {};
  servers[serverName] = entry;
  base.mcpServers = servers;
  return base;
}

export function patchGitignoreContent(
  existing: string,
  linesToAdd: readonly string[]
): string {
  const present = new Set(
    existing.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  );
  const additions = linesToAdd.filter((l) => !present.has(l.trim()));
  if (additions.length === 0) return existing;
  if (existing.length === 0) return additions.join('\n') + '\n';
  const trail = existing.endsWith('\n') ? '' : '\n';
  return existing + trail + '\n' + additions.join('\n') + '\n';
}

export function claudeDesktopConfigPath(
  plat: NodeJS.Platform = platform(),
  home: string = homedir(),
  appData: string | undefined = process.env.APPDATA
): string | null {
  if (plat === 'darwin') {
    return join(
      home,
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json'
    );
  }
  if (plat === 'win32') {
    if (appData === undefined || appData.length === 0) return null;
    return join(appData, 'Claude', 'claude_desktop_config.json');
  }
  if (plat === 'linux') {
    return join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
  return null;
}

// ───────────────────────────── i/o wrappers ─────────────────────────────

function readJsonOrNull(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
}

function ledricMcpEntry(cwd: string): McpServerEntry {
  return {
    command: 'npx',
    args: ['-y', 'ledric', 'serve'],
    cwd
  };
}

// ───────────────────────────── interactive prompts ─────────────────────────────

async function runPrompts(): Promise<InitAnswers> {
  const responses = await p.group(
    {
      db: () =>
        p.text({
          message: 'Path to the SQLite database file',
          placeholder: './ledric.db',
          defaultValue: './ledric.db'
        }),
      port: () =>
        p.text({
          message: 'HTTP port',
          placeholder: '3000',
          defaultValue: '3000',
          validate: (v) => {
            const n = parseInt(v, 10);
            if (!Number.isFinite(n) || n < 1 || n > 65535) {
              return 'must be a port number 1-65535';
            }
            return undefined;
          }
        }),
      host: () =>
        p.text({
          message: 'HTTP host',
          placeholder: '127.0.0.1',
          defaultValue: '127.0.0.1'
        }),
      assetsBackend: () =>
        p.select({
          message: 'Where should asset bytes live?',
          options: [
            {
              value: 'db' as const,
              label: 'In the database',
              hint: 'simple, one file to back up'
            },
            {
              value: 'local' as const,
              label: 'Local disk',
              hint: 'better for big media libraries'
            }
          ],
          initialValue: 'db' as const
        }),
      assetsPath: ({ results }) =>
        results.assetsBackend === 'local'
          ? p.text({
              message: 'Asset directory',
              placeholder: './ledric-assets',
              defaultValue: './ledric-assets'
            })
          : Promise.resolve(undefined),
      configureClaudeCode: () =>
        p.confirm({
          message: 'Configure Claude Code MCP (./.mcp.json) for this project?',
          initialValue: true
        }),
      configureClaudeDesktop: () =>
        p.confirm({
          message: 'Add to Claude Desktop globally?',
          initialValue: false
        }),
      mintKeys: () =>
        p.confirm({
          message: 'Mint admin + reader API keys now?',
          initialValue: true
        }),
      updateGitignore: () =>
        p.confirm({
          message: 'Update .gitignore with ledric files?',
          initialValue: true
        })
    },
    {
      onCancel: () => {
        p.cancel('Cancelled.');
        process.exit(0);
      }
    }
  );

  return {
    db: typeof responses.db === 'string' ? responses.db : DEFAULTS.db,
    port:
      typeof responses.port === 'string'
        ? parseInt(responses.port, 10)
        : DEFAULTS.port,
    host: typeof responses.host === 'string' ? responses.host : DEFAULTS.host,
    assetsBackend: responses.assetsBackend ?? DEFAULTS.assetsBackend,
    assetsPath:
      typeof responses.assetsPath === 'string' ? responses.assetsPath : null,
    configureClaudeCode: responses.configureClaudeCode === true,
    configureClaudeDesktop: responses.configureClaudeDesktop === true,
    mintKeys: responses.mintKeys === true,
    updateGitignore: responses.updateGitignore === true
  };
}

// ───────────────────────────── the command ─────────────────────────────

export const initCommand = defineCommand({
  meta: {
    name: 'init',
    description:
      'Set up ledric in the current directory: write config, patch .mcp.json, optionally mint API keys.'
  },
  args: {
    yes: {
      type: 'boolean',
      description: 'Skip prompts and use defaults (non-interactive).',
      default: false
    },
    force: {
      type: 'boolean',
      description: 'Overwrite ledric.config.json if it already exists.',
      default: false
    }
  },
  async run({ args }) {
    p.intro('ledric init');

    const answers = args.yes ? DEFAULTS : await runPrompts();
    const cwd = process.cwd();

    // 1. ledric.config.json
    const cfgPath = configPath(cwd);
    if (existsSync(cfgPath) && !args.force) {
      p.log.warn(
        `ledric.config.json already exists — skipped (use --force to overwrite).`
      );
    } else {
      writeJsonFile(cfgPath, buildConfig(answers));
      p.log.success(`Wrote ${cfgPath}`);
    }

    // 2. ./.mcp.json — Claude Code project-local
    if (answers.configureClaudeCode) {
      const mcpPath = resolve(cwd, '.mcp.json');
      const existing = readJsonOrNull(mcpPath);
      const merged = mergeMcpServers(existing, 'ledric', ledricMcpEntry(cwd));
      writeJsonFile(mcpPath, merged);
      p.log.success(`${existing === null ? 'Created' : 'Patched'} ${mcpPath}`);
    }

    // 3. Claude Desktop config (global)
    if (answers.configureClaudeDesktop) {
      const cdPath = claudeDesktopConfigPath();
      if (cdPath === null) {
        p.log.warn('Claude Desktop config path not detected on this OS — skipped.');
      } else {
        const existing = readJsonOrNull(cdPath);
        const merged = mergeMcpServers(existing, 'ledric', ledricMcpEntry(cwd));
        writeJsonFile(cdPath, merged);
        p.log.success(`${existing === null ? 'Created' : 'Patched'} ${cdPath}`);
      }
    }

    // 4. Mint API keys (and write .env.local)
    if (answers.mintKeys) {
      const storage = await SqliteStorage.open({ path: answers.db });
      try {
        const keys = await bootstrapApiKeysIfEmpty(storage, undefined, undefined);
        if (keys === null) {
          p.log.warn('Keys already exist in this DB — skipped minting.');
        } else {
          p.note(
            `admin:  ${keys.adminSecret}\nreader: ${keys.readerSecret}`,
            'API keys (save these — not shown again)'
          );
          const envPath = resolve(cwd, '.env.local');
          const envBody =
            `LEDRIC_ADMIN_KEY=${keys.adminSecret}\n` +
            `LEDRIC_READER_KEY=${keys.readerSecret}\n`;
          writeFileSync(envPath, envBody);
          p.log.success(`Wrote ${envPath}`);
        }
      } finally {
        await storage.close();
      }
    }

    // 5. .gitignore
    if (answers.updateGitignore) {
      const giPath = resolve(cwd, '.gitignore');
      const existing = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
      const next = patchGitignoreContent(existing, LEDRIC_GITIGNORE_LINES);
      if (next !== existing) {
        writeFileSync(giPath, next);
        p.log.success(`Updated ${giPath}`);
      } else {
        p.log.info('.gitignore already covers ledric files.');
      }
    }

    p.outro(
      'Ready! Run `npx ledric serve` (stdio) or `npx ledric serve --gui` (HTTP + admin UI).'
    );
  }
});
