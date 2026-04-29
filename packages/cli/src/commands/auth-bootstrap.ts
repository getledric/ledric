import type { Storage, ApiKeyRole } from '@ledric/storage';
import { generateApiKey } from '@ledric/storage';

export interface BootstrappedKeys {
  adminSecret: string;
  readerSecret: string;
}

/**
 * If the DB has zero active keys and no override env vars are set,
 * generate one admin + one reader key, persist them, and return the
 * plaintext secrets so the caller can print them once. Otherwise
 * returns null — auth is either already configured or is being
 * supplied via the environment.
 */
export async function bootstrapApiKeysIfEmpty(
  storage: Storage,
  envAdminKey: string | undefined,
  envReaderKey: string | undefined
): Promise<BootstrappedKeys | null> {
  const existing = await storage.countActiveApiKeys();
  if (existing > 0) return null;
  if (envAdminKey || envReaderKey) {
    // Operator is supplying keys via env — don't auto-mint, that would
    // bury secrets in SQLite the operator chose to keep elsewhere.
    return null;
  }

  const admin = generateApiKey('admin');
  const reader = generateApiKey('reader');
  await storage.createApiKey({
    role: 'admin',
    label: 'auto:first-boot',
    key_hash: admin.hash,
    key_prefix: admin.prefix
  });
  await storage.createApiKey({
    role: 'reader',
    label: 'auto:first-boot',
    key_hash: reader.hash,
    key_prefix: reader.prefix
  });
  return { adminSecret: admin.secret, readerSecret: reader.secret };
}

/**
 * Loud one-time banner so operators can't miss the keys scrolling by
 * in their boot logs. Written to stderr (stdout is reserved for the
 * MCP stdio protocol).
 */
export function printFirstBootKeys(keys: BootstrappedKeys): void {
  const lines = [
    '',
    '╭──────────────────────────────────────────────────────────────────────────╮',
    '│  ledric: first-boot API keys generated. SAVE THESE NOW — they will NOT   │',
    '│  be shown again. Treat them like passwords.                              │',
    '├──────────────────────────────────────────────────────────────────────────┤',
    `│  admin   ${keys.adminSecret.padEnd(63, ' ')}│`,
    `│  reader  ${keys.readerSecret.padEnd(63, ' ')}│`,
    '├──────────────────────────────────────────────────────────────────────────┤',
    '│  Pass via Authorization: Bearer <key>  (or  X-Ledric-Key: <key>).        │',
    '│  Manage with `ledric keys list / create / revoke`.                       │',
    '╰──────────────────────────────────────────────────────────────────────────╯',
    ''
  ];
  process.stderr.write(lines.join('\n'));
}

export function roleAccepts(presented: ApiKeyRole, required: ApiKeyRole): boolean {
  if (required === 'reader') return presented === 'reader' || presented === 'admin';
  return presented === required;
}
