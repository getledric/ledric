# SDKs

Two consumer-side clients ship in the box, both intentionally
read-first. Writes go through `rpc()` — the same dispatch as the
HTTP `POST /rpc` — because most consumers are renderers, not
editors. Editing happens through the admin GUI, the inline editor,
or an MCP-connected agent.

- [`@ledric/sdk` (TypeScript)](#ledricsdk-typescript)
- [`Ledric\LedricClient` (PHP)](#ledriclledricclient-php)
- [Inline editor helpers](#inline-editor-helpers)

---

## `@ledric/sdk` (TypeScript)

Install:

```bash
npm install @ledric/sdk
# pnpm add @ledric/sdk
# yarn add @ledric/sdk
```

Construct:

```ts
import { LedricClient } from '@ledric/sdk';

const client = new LedricClient({
  baseUrl: 'https://cms.example.com',
  apiKey: process.env.LEDRIC_READER_KEY  // optional under default reads-open mode
});
```

Options:

| Option | Type | Notes |
|---|---|---|
| `baseUrl` | string | Origin of your ledric server. Required. |
| `apiKey` | string | API key. Optional under reads-open mode. |
| `headers` | object | Extra headers merged into every request. |
| `fetch` | function | Custom fetch implementation (e.g. `node-fetch` for old Node, or a tracing-instrumented fetch). |

### Reading content

```ts
// Single entry
const post = await client.read({ type: 'blog_post', slug: 'why-kysely' });
// or as a string:
const post = await client.read('blog_post/why-kysely');

// With options
const post = await client.read('blog_post/why-kysely', {
  expandAssets: true,           // inline asset metadata + URLs
  expandAssets: ['hero'],       // or just specific fields
  resolveRefs: true,            // walk markdown for :::ref{}
  version: 3,                   // historical version
  locale: 'fr'                  // localized projection
});

// Returns null on 404. Follows slug-rename redirects transparently.
if (!post) { /* ... */ }

console.log(post.fields.title);
```

### Listing

```ts
const { results, total, offset } = await client.find('blog_post', {
  tags: ['featured'],           // AND semantics
  limit: 10,
  offset: 0,
  locale: 'fr',
  expandAssets: true
});
```

### Types

```ts
const model = await client.types();           // every type's full def
const blogPost = await client.type('blog_post'); // one type, or null
```

### Assets

```ts
const meta = await client.asset(refKeyOrId);  // metadata
const url = client.assetUrl(refKeyOrId, {     // build a URL with imgix params
  w: 800,
  fm: 'webp',
  auto: 'format'
});
const bytes = await client.assetBytes(refKeyOrId); // ArrayBuffer

const list = await client.assets({ kind: 'image', tags: ['hero'] });
```

### Tags

```ts
await client.tags();                           // all tags + counts
await client.addEntryTags({ type: 'blog_post', slug: 'why-kysely' }, ['featured']);
await client.removeEntryTags({ type: 'blog_post', slug: 'why-kysely' }, ['draft']);
await client.addAssetTags(assetId, ['hero']);
await client.updateTag('featured', 'Featured Posts');
```

### Writes (via `rpc`)

The TS SDK exposes a generic `rpc()` for everything else. Same
shape as the HTTP `POST /rpc` and the MCP tool catalogue.

```ts
const draft = await client.rpc('draft', {
  type: 'blog_post',
  fields: { title: 'Hello', slug: 'hello', body: '# Hi' }
});

await client.rpc('publish', {
  ref: { type: 'blog_post', slug: 'hello' }
});

await client.rpc('alter_type', {
  name: 'blog_post',
  parent_version: 3,
  merge_patch: { fields: { reading_time: { type: 'number', integer: true } } }
});
```

See [`mcp-tools.md`](./mcp-tools.md) for every tool name and arg
shape.

### Errors

`LedricApiError` (extends `Error`) is thrown on non-2xx responses.
It carries:

```ts
try {
  await client.rpc('draft', { /* ... */ });
} catch (err) {
  if (err instanceof LedricApiError) {
    err.status;     // HTTP status
    err.code;       // ledric error code (VALIDATION_FAILED, VERSION_CONFLICT, ...)
    err.errors;     // [{ path, message }] on validation failures
  }
}
```

---

## `Ledric\LedricClient` (PHP)

Install:

```bash
composer require ledric/sdk
```

Construct:

```php
use Ledric\LedricClient;

$client = new LedricClient('https://cms.example.com', [
    'apiKey' => getenv('LEDRIC_READER_KEY')
]);
```

Method surface mirrors the TS SDK:

```php
$post = $client->read('blog_post/why-kysely');
$post = $client->read('blog_post/why-kysely', [
    'expandAssets' => true,
    'resolveRefs' => true,
    'locale' => 'fr'
]);

$list = $client->find('blog_post', [
    'tags' => ['featured'],
    'limit' => 10
]);

$model = $client->types();
$type  = $client->type('blog_post');

$asset = $client->asset($refKeyOrId);
$url   = $client->assetUrl($refKeyOrId, ['w' => 800, 'fm' => 'webp']);
$bytes = $client->assetBytes($refKeyOrId);

$client->addEntryTags(['type' => 'blog_post', 'slug' => 'why-kysely'], ['featured']);
$client->updateTag('featured', 'Featured Posts');

// Writes via generic rpc()
$client->rpc('draft', [
    'type' => 'blog_post',
    'fields' => ['title' => 'Hello', 'slug' => 'hello', 'body' => '# Hi']
]);
```

PHP-specific notes:

- Uses `ext-curl` and `ext-json`. No Guzzle / no extra HTTP layer.
- Returns associative arrays (not objects) for entries / types /
  assets — so `$post['fields']['title']` rather than
  `$post->fields->title`.
- `null` on 404 (same shape as the TS SDK).
- Throws `Ledric\LedricApiError` on non-2xx — same fields
  (`status`, `code`, `errors`).

---

## Inline editor helpers

Both SDKs export a `refAttrs()` helper for building the
`data-ledric-ref` / `data-ledric-field` attributes the inline editor
uses. See [`inline-editor.md`](./inline-editor.md) for the full
walkthrough.

```ts
// TypeScript / JSX
import { refAttrs } from '@ledric/sdk';

<article {...refAttrs(post)}>
  <h1 {...refAttrs(post, 'title')}>{post.fields.title}</h1>
</article>
```

```php
// PHP
<article <?= $client->refAttrs($post) ?>>
  <h1 <?= $client->refAttrs($post, 'title') ?>><?= htmlspecialchars($post['fields']['title']) ?></h1>
</article>
```

Returns empty (object / string) when the entry is null — safe to
spread/inject without conditional logic.
