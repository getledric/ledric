import { createLedricClient } from '@ledric/sdk';

const baseUrl = process.env.LEDRIC_API ?? 'http://localhost:3000';

export const client = createLedricClient({ baseUrl });
export { baseUrl as ledricApiBase };
export { refAttrs, refAttrsHtml } from '@ledric/sdk';

/** Returns true if the value looks like a real ledric asset id (32 hex chars). */
export function isAssetId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v);
}

export function formatDate(s: unknown): string {
  if (typeof s !== 'string') return '';
  try {
    return new Date(s).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  } catch {
    return s;
  }
}

export function formatPrice(value: unknown, currency: unknown): string {
  if (typeof value !== 'number') return '';
  const code = typeof currency === 'string' ? currency : 'USD';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(value);
  } catch {
    return `${value} ${code}`;
  }
}
