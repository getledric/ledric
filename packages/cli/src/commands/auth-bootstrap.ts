import type { Storage, ApiKeyRole } from '@ledric/storage';
import { generateApiKey } from '@ledric/storage';

export interface BootstrappedKeys {
  adminSecret: string;
  /**
   * Reader key, when one was minted. Only present if the operator
   * explicitly opted into closed-reads mode at first boot — otherwise
   * the reader key is unminted (deferred to `ledric keys create
   * --role reader`). Lets the default-mode `.env.local` stay one-line.
   */
  readerSecret?: string;
}

/**
 * If the DB has zero active keys and no override env vars are set,
 * generate the admin key (and a reader key only when explicitly
 * requested), persist them, and return the plaintext secrets so the
 * caller can print them once. Otherwise returns null — auth is
 * either already configured or being supplied via the environment.
 *
 * Pass `mintReader: true` when the operator runs with
 * `--require-reader-key`; that's the only mode where a reader key
 * matters at install time. For every other deployment the reader
 * key is opt-in via `ledric keys create --role reader` later.
 */
export async function bootstrapApiKeysIfEmpty(
  storage: Storage,
  envAdminKey: string | undefined,
  envReaderKey: string | undefined,
  opts: { mintReader?: boolean } = {}
): Promise<BootstrappedKeys | null> {
  const existing = await storage.countActiveApiKeys();
  if (existing > 0) return null;
  if (envAdminKey || envReaderKey) {
    // Operator is supplying keys via env — don't auto-mint, that would
    // bury secrets in SQLite the operator chose to keep elsewhere.
    return null;
  }

  const admin = generateApiKey('admin');
  await storage.createApiKey({
    role: 'admin',
    label: 'auto:first-boot',
    key_hash: admin.hash,
    key_prefix: admin.prefix
  });

  if (opts.mintReader === true) {
    const reader = generateApiKey('reader');
    await storage.createApiKey({
      role: 'reader',
      label: 'auto:first-boot',
      key_hash: reader.hash,
      key_prefix: reader.prefix
    });
    return { adminSecret: admin.secret, readerSecret: reader.secret };
  }
  return { adminSecret: admin.secret };
}

/**
 * Loud one-time banner so operators can't miss the keys scrolling by
 * in their boot logs. Written to stderr (stdout is reserved for the
 * MCP stdio protocol). Only the admin line is shown unless a reader
 * key was also minted.
 */
export function printFirstBootKeys(keys: BootstrappedKeys): void {
  const lines = [
    '',
    '╭──────────────────────────────────────────────────────────────────────────╮',
    '│  ledric: admin API key generated. SAVE THIS NOW — it will NOT be shown  │',
    '│  again. Treat it like a password.                                       │',
    '├──────────────────────────────────────────────────────────────────────────┤',
    `│  admin   ${keys.adminSecret.padEnd(63, ' ')}│`
  ];
  if (keys.readerSecret !== undefined) {
    lines.push(`│  reader  ${keys.readerSecret.padEnd(63, ' ')}│`);
  }
  lines.push(
    '├──────────────────────────────────────────────────────────────────────────┤',
    '│  Pass via Authorization: Bearer <key>  (or  X-Ledric-Key: <key>).       │',
    '│  Manage with `ledric keys list / create / revoke`.                      │'
  );
  if (keys.readerSecret === undefined) {
    lines.push(
      '│  A reader key is unnecessary in the default open-reads mode. Mint one   │',
      '│  later with `ledric keys create --role reader` for closed-reads sites.  │'
    );
  }
  lines.push(
    '╰──────────────────────────────────────────────────────────────────────────╯',
    ''
  );
  process.stderr.write(lines.join('\n'));
}

export function roleAccepts(presented: ApiKeyRole, required: ApiKeyRole): boolean {
  if (required === 'reader') return presented === 'reader' || presented === 'admin';
  return presented === required;
}
