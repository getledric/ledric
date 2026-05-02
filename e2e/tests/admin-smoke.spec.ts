import { test, expect } from '../fixtures/auth.js';

test.describe('admin GUI smoke', () => {
  test('GET / returns the self-describing root with rpc_tools', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.rpc_tools).toBeDefined();
    expect(Array.isArray(body.rpc_tools)).toBe(true);
  });

  test('admin GUI loads at /admin once the key is in localStorage', async ({ authedPage: page }) => {
    await page.goto('/admin');
    // The nav banner is the most stable surface in the layout.
    await expect(page.getByText('LEDRIC · ADMIN')).toBeVisible();
    // Default landing redirects to /admin/types — verify the heading.
    await expect(page.getByRole('heading', { name: 'Types' })).toBeVisible();
  });

  test('without a key the GUI shows the auth gate paste prompt', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByText(/admin key/i).first()).toBeVisible();
  });
});
