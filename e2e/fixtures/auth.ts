import { test as base, type Page } from '@playwright/test';
import { E2E_ADMIN_KEY } from '../constants.js';

/**
 * `test` extended with an `authedPage` fixture that drops the admin
 * key into localStorage before any page navigation, so the GUI's
 * AuthGate doesn't block headless tests with its paste prompt.
 */
export const test = base.extend<{ authedPage: Page }>({
  authedPage: async ({ page }, use) => {
    await page.addInitScript((key) => {
      // Storage key matches packages/gui/web/lib/api.js KEY_STORAGE.
      localStorage.setItem('ledric:admin-key', key);
    }, E2E_ADMIN_KEY);
    await use(page);
  }
});

export { expect } from '@playwright/test';
export { E2E_ADMIN_KEY } from '../constants.js';
