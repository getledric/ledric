import type { Adapter, AdapterConstructor, AdapterPayload } from 'oidc-provider';
import type { LedricStorage } from '@ledric/storage';

/**
 * Kysely-backed adapter for `oidc-provider`. One row per (model, id)
 * in the `oidc_payloads` table covers every model the library
 * persists (Client, AuthorizationCode, AccessToken, RefreshToken,
 * Grant, Interaction, Session, ReplayDetection, ...). Adding new
 * model types requires no schema change.
 *
 * Adapter contract (from `oidc-provider`'s docs):
 *   upsert(id, payload, expiresIn) — write (replace on duplicate)
 *   find(id)                       — return latest payload or undef
 *   findByUid(uid)                 — Session lookup by `uid`
 *   findByUserCode(userCode)       — DeviceCode lookup; we don't enable
 *                                    device flow but the column exists
 *   consume(id)                    — flag as consumed (stamp consumed_at)
 *   destroy(id)                    — delete the row
 *   revokeByGrantId(grantId)       — cascade-delete by grant_id
 */
export class KyselyOidcAdapter implements Adapter {
  constructor(
    private readonly storage: LedricStorage,
    private readonly model: string
  ) {}

  /**
   * Factory shape oidc-provider's `adapter` config option expects. The
   * library calls `new adapter(name)` per model, so we curry a Storage
   * handle and return the constructor.
   */
  static factory(storage: LedricStorage): AdapterConstructor {
    return class extends KyselyOidcAdapter {
      constructor(name: string) {
        super(storage, name);
      }
    };
  }

  async upsert(id: string, payload: AdapterPayload, expiresIn: number): Promise<void> {
    // Client rows persist forever — oidc-provider passes
    // `expiresIn === undefined` for them. Everything else gets a
    // `now + expiresIn` unix-seconds timestamp.
    const expiresAt =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn)
        ? Math.floor(Date.now() / 1000) + expiresIn
        : null;
    const row = {
      model: this.model,
      id,
      payload: JSON.stringify(payload),
      grant_id: typeof payload.grantId === 'string' ? payload.grantId : null,
      user_code: typeof payload.userCode === 'string' ? payload.userCode : null,
      uid: typeof payload.uid === 'string' ? payload.uid : null,
      expires_at: expiresAt,
      consumed_at: null
    };
    // Replace on conflict — Session refreshes hit upsert with the same
    // id repeatedly, e.g. when the client lands back on /auth.
    await this.storage.db
      .insertInto('oidc_payloads')
      .values(row)
      .onConflict((oc) =>
        oc.columns(['model', 'id']).doUpdateSet({
          payload: row.payload,
          grant_id: row.grant_id,
          user_code: row.user_code,
          uid: row.uid,
          expires_at: row.expires_at,
          consumed_at: null
        })
      )
      .execute();
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const row = await this.storage.db
      .selectFrom('oidc_payloads')
      .selectAll()
      .where('model', '=', this.model)
      .where('id', '=', id)
      .executeTakeFirst();
    return this.hydrate(row);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const row = await this.storage.db
      .selectFrom('oidc_payloads')
      .selectAll()
      .where('model', '=', this.model)
      .where('user_code', '=', userCode)
      .executeTakeFirst();
    return this.hydrate(row);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const row = await this.storage.db
      .selectFrom('oidc_payloads')
      .selectAll()
      .where('model', '=', this.model)
      .where('uid', '=', uid)
      .executeTakeFirst();
    return this.hydrate(row);
  }

  async consume(id: string): Promise<void> {
    await this.storage.db
      .updateTable('oidc_payloads')
      .set({ consumed_at: Math.floor(Date.now() / 1000) })
      .where('model', '=', this.model)
      .where('id', '=', id)
      .execute();
  }

  async destroy(id: string): Promise<void> {
    await this.storage.db
      .deleteFrom('oidc_payloads')
      .where('model', '=', this.model)
      .where('id', '=', id)
      .execute();
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    // Per the contract this is NOT scoped to model — when a grant is
    // revoked, every artefact bound to it (across all models) goes
    // too. Library docs are explicit on that.
    await this.storage.db
      .deleteFrom('oidc_payloads')
      .where('grant_id', '=', grantId)
      .execute();
  }

  private hydrate(
    row:
      | {
          payload: string;
          expires_at: number | null;
          consumed_at: number | null;
        }
      | undefined
  ): AdapterPayload | undefined {
    if (row === undefined) return undefined;
    // null expires_at = no expiry (Client rows). Everything else
    // checks against now and returns undefined for stale.
    if (row.expires_at !== null && Number(row.expires_at) * 1000 < Date.now()) {
      return undefined;
    }
    const payload = JSON.parse(row.payload) as AdapterPayload;
    if (row.consumed_at !== null) {
      // oidc-provider checks for `payload.consumed` truthiness on
      // AuthorizationCode replay detection.
      (payload as AdapterPayload & { consumed?: number }).consumed = Number(row.consumed_at);
    }
    return payload;
  }
}

/**
 * Periodically reap expired rows. oidc-provider doesn't garbage-
 * collect — that's the adapter's job. Schedule via setInterval at
 * boot time; clear the timer on server shutdown.
 *
 * The query is intentionally cheap (single index scan on expires_at).
 */
export async function reapExpiredOidcPayloads(storage: LedricStorage): Promise<number> {
  // Skip rows with null expires_at (Client rows — they live forever).
  const result = await storage.db
    .deleteFrom('oidc_payloads')
    .where('expires_at', 'is not', null)
    .where('expires_at', '<', Math.floor(Date.now() / 1000))
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
