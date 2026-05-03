import type { LedricStorage } from '@ledric/storage';

export interface ClientSummary {
  client_id: string;
  name: string;
  redirect_uris: string[];
  grant_types: string[];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export async function listClients(storage: LedricStorage): Promise<ClientSummary[]> {
  const rows = await storage.db
    .selectFrom('oidc_payloads')
    .select(['id', 'payload'])
    .where('model', '=', 'Client')
    .execute();
  return rows.map((r) => {
    const p = JSON.parse(r.payload) as Record<string, unknown>;
    return {
      client_id: r.id,
      name: typeof p.client_name === 'string' ? p.client_name : '',
      redirect_uris: asStringArray(p.redirect_uris),
      grant_types: asStringArray(p.grant_types)
    };
  });
}

export async function revokeClient(
  storage: LedricStorage,
  clientId: string
): Promise<boolean> {
  const result = await storage.db
    .deleteFrom('oidc_payloads')
    .where('model', '=', 'Client')
    .where('id', '=', clientId)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0) > 0;
}
