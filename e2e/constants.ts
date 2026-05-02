// Shared constants for the e2e harness. Imported by both the Playwright
// config and the test fixtures; keeping them in their own module avoids
// pulling the full config into every test file.

export const PORT = Number(process.env.LEDRIC_E2E_PORT ?? 3399);
export const HOST = '127.0.0.1';
export const BASE_URL = `http://${HOST}:${PORT}`;

// Fixed keys so tests authenticate without scraping stderr. Bootstrap
// sees these and skips minting; the HTTP auth middleware accepts them
// directly as the active admin/reader keys (no hashing needed for an
// env-supplied key).
export const E2E_ADMIN_KEY = 'lka_e2e_admin_key_0000000000000000000000';
export const E2E_READER_KEY = 'lkr_e2e_reader_key_000000000000000000000';
