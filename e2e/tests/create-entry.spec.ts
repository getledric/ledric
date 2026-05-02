import { test, expect, E2E_ADMIN_KEY } from '../fixtures/auth.js';

const TYPE_NAME = 'e2e_post';

async function createTypeViaRpc(request: import('@playwright/test').APIRequestContext) {
  // Idempotent: ignore the conflict if the type already exists from a
  // previous run (when reuseExistingServer kept the DB warm).
  const res = await request.post('/rpc', {
    headers: { authorization: `Bearer ${E2E_ADMIN_KEY}` },
    data: {
      tool: 'create_type',
      args: {
        name: TYPE_NAME,
        fields: {
          title: { type: 'string', required: true, max: 200 },
          slug: { type: 'slug', required: true, from: 'title' },
          body: { type: 'markdown', required: true }
        },
        opts: {
          identifier_field: 'slug',
          display_field: 'title',
          summary_fields: ['title', 'slug']
        }
      }
    }
  });
  // 200 on first run, 4xx with code TYPE_EXISTS on subsequent reuse.
  if (!res.ok()) {
    const body = await res.json().catch(() => ({}));
    if (body?.error?.code !== 'TYPE_EXISTS' && body?.error?.code !== 'INVALID_REQUEST') {
      throw new Error(`create_type failed: ${res.status()} ${JSON.stringify(body)}`);
    }
  }
}

test.describe('create + edit entry through the admin form', () => {
  test.beforeAll(async ({ request }) => {
    await createTypeViaRpc(request);
  });

  test('the new-entry form starts blank, and a draft round-trips through the editor', async ({
    authedPage: page,
    request
  }) => {
    // Unique slug per test run so we don't collide with reuseExistingServer.
    const slug = `e2e-draft-${Date.now()}`;

    await page.goto(`/admin/types/${TYPE_NAME}/new`);
    await expect(page.getByRole('heading', { name: `New ${TYPE_NAME}` })).toBeVisible();

    // Regression for the 0.1.2 fix: the form must NOT be pre-filled
    // from the type's example. All inputs blank.
    const titleInput = page.locator('input[type="text"]').first();
    await expect(titleInput).toHaveValue('');

    await titleInput.fill('E2E Hello');
    // Slug auto-derives from the title via field.from — give the
    // derive button a click to populate it explicitly.
    const deriveBtn = page.getByRole('button', { name: 'derive' });
    if (await deriveBtn.isVisible().catch(() => false)) {
      await deriveBtn.click();
    }
    // Override the auto-slug with our timestamped one to guarantee uniqueness.
    const slugInput = page.locator('input[type="text"]').nth(1);
    await slugInput.fill(slug);

    // Markdown body — the field renders a textarea.
    await page.locator('textarea').first().fill('# Hi\n\nFrom Playwright.');

    await page.getByRole('button', { name: /create draft/i }).click();
    await expect(page.getByText(/Saved/)).toBeVisible({ timeout: 5_000 });

    // Verify the entry exists by hitting the HTTP API.
    const verify = await request.get(`/entries/${TYPE_NAME}/${slug}`);
    expect(verify.status()).toBe(200);
    const entry = await verify.json();
    expect(entry.fields.title).toBe('E2E Hello');
    expect(entry.published_version).toBeNull();
  });
});
