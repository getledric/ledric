import { test, expect, E2E_ADMIN_KEY } from '../fixtures/auth.js';

// Regression for the 0.1.2 storage fix: addEntryTags returned only the
// newly-added tags, so adding a second tag visually replaced the first
// in the chip row. This test catches that by adding two tags in sequence
// and asserting both are visible.

const TYPE_NAME = 'e2e_taggable';

test.describe('tag-add regression (multiple tags stay visible)', () => {
  test.beforeAll(async ({ request }) => {
    const res = await request.post('/rpc', {
      headers: { authorization: `Bearer ${E2E_ADMIN_KEY}` },
      data: {
        tool: 'create_type',
        args: {
          name: TYPE_NAME,
          fields: {
            title: { type: 'string', required: true },
            slug: { type: 'slug', required: true, from: 'title' }
          },
          opts: { identifier_field: 'slug', display_field: 'title' }
        }
      }
    });
    if (!res.ok()) {
      const body = await res.json().catch(() => ({}));
      if (body?.error?.code !== 'TYPE_EXISTS' && body?.error?.code !== 'INVALID_REQUEST') {
        throw new Error(`create_type failed: ${res.status()} ${JSON.stringify(body)}`);
      }
    }
  });

  test('adding multiple tags through the admin chip input keeps all of them visible', async ({
    authedPage: page,
    request
  }) => {
    const slug = `tag-target-${Date.now()}`;

    // Pre-create the entry via /rpc so we land on the editor (tag input
    // only shows in edit mode).
    const draft = await request.post('/rpc', {
      headers: { authorization: `Bearer ${E2E_ADMIN_KEY}` },
      data: {
        tool: 'draft',
        args: {
          type: TYPE_NAME,
          fields: { title: 'Tag Target', slug }
        }
      }
    });
    expect(draft.ok()).toBe(true);

    await page.goto(`/admin/types/${TYPE_NAME}/${slug}`);

    // The tag input has placeholder "add tag…" — find by placeholder.
    const tagInput = page.getByPlaceholder('add tag…');
    await expect(tagInput).toBeVisible();

    await tagInput.fill('alpha');
    await tagInput.press('Enter');
    await expect(page.getByText('alpha', { exact: true })).toBeVisible();

    await tagInput.fill('beta');
    await tagInput.press('Enter');
    // Both tags must remain visible — the bug surfaced as "alpha" vanishing
    // when "beta" was added.
    await expect(page.getByText('alpha', { exact: true })).toBeVisible();
    await expect(page.getByText('beta', { exact: true })).toBeVisible();

    await tagInput.fill('gamma');
    await tagInput.press('Enter');
    await expect(page.getByText('alpha', { exact: true })).toBeVisible();
    await expect(page.getByText('beta', { exact: true })).toBeVisible();
    await expect(page.getByText('gamma', { exact: true })).toBeVisible();
  });
});
