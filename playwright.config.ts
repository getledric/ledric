import { defineConfig } from '@playwright/test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { BASE_URL, HOST, PORT, E2E_ADMIN_KEY, E2E_READER_KEY } from './e2e/constants.js';

// Fresh tmp dir per run — playwright resolves cwd to repo root.
const TMP_DIR = resolve('e2e/.tmp');
const DB_PATH = resolve(TMP_DIR, 'ledric.db');
const ASSETS_PATH = resolve(TMP_DIR, 'ledric-assets');
const TRANSFORMS_PATH = resolve(TMP_DIR, 'ledric-transforms');

// rmSync is fine in module scope — playwright loads the config exactly
// once per process before any test runs, so this is the test-suite setup.
if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
mkdirSync(TMP_DIR, { recursive: true });

export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: `node packages/cli/dist/cli.js serve --gui --port=${PORT} --host=${HOST} --db=${DB_PATH} --assets-backend=local --assets-root=${ASSETS_PATH} --transforms-cache=${TRANSFORMS_PATH}`,
    url: `${BASE_URL}/auth/status`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    stderr: 'pipe',
    env: {
      LEDRIC_ADMIN_KEY: E2E_ADMIN_KEY,
      LEDRIC_READER_KEY: E2E_READER_KEY
    }
  }
});
