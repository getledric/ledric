# ledric/sdk (PHP)

Read client for ledric, mirrors the surface of `@ledric/sdk` (TypeScript)
in idiomatic PHP. Targets PHP 7.4+; uses ext-curl, no third-party HTTP
dependency.

## Install

```bash
composer require ledric/sdk
```

## Usage

```php
use Ledric\LedricClient;

$client = new LedricClient('http://localhost:3000');

// Read one entry. Returns null on 404.
$post = $client->read('blog_post/why-we-built-ledric');
echo $post['fields']['title'];

// Read in another locale; resolves through the type's fallback chain.
$fr = $client->read('blog_post/why-we-built-ledric', ['locale' => 'fr']);

// Expand asset-typed fields inline so you don't round-trip per image.
$post = $client->read('blog_post/why-we-built-ledric', ['expandAssets' => true]);
echo $post['fields']['hero']['url'];   // "/assets/<id>"
echo $post['fields']['hero']['meta']['alt'];

// List entries.
$list = $client->find('blog_post', ['limit' => 10, 'locale' => 'fr']);
foreach ($list['results'] as $row) {
    echo $row['slug'] . "\n";
}

// Build an absolute asset URL without fetching.
$src = $client->assetUrl('019dc0b5553477e894374b563cd4e633');

// Fetch raw bytes (string, or null on 404).
$bytes = $client->assetBytes('019dc0b5553477e894374b563cd4e633');

// Inline ref resolution: scans markdown fields, attaches `_refs` sidecar.
$post = $client->read('blog_post/some-post', ['resolveRefs' => true]);
foreach ($post['_refs'] ?? [] as $ref) {
    if ($ref['found']) {
        echo $ref['to'] . ' → ' . $ref['url'] . "\n";
    }
}

// Escape hatch: any tool the HTTP /rpc surface accepts.
$result = $client->rpc('describe_model');
$created = $client->rpc('draft', [
    'type' => 'note',
    'fields' => ['title' => 'From PHP'],
]);
```

## Options

| Option | Where | Type | What it does |
|---|---|---|---|
| `version` | `read` | int | Read a specific historical version. |
| `locale` | `read`, `find` | string | Project the entry into this locale. |
| `expandAssets` | `read`, `find` | `bool\|string[]` | Resolve asset fields inline. `true` expands all; an array of field names expands those. |
| `resolveRefs` | `read`, `find` | bool | Scan markdown fields for `:::ref{}` directives, attach `_refs` sidecar. |
| `limit`, `offset` | `find`, `assets` | int | Pagination. |

## Errors

Failed HTTP responses raise `Ledric\LedricError`, which carries
`status`, `url`, `body`, and a message. 404s on `read`, `type`, `asset`,
and `assetBytes` return `null` instead of throwing.

```php
use Ledric\LedricError;

try {
    $client->rpc('nope');
} catch (LedricError $e) {
    echo $e->status . ': ' . $e->getMessage();
}
```

## Custom HTTP

Inject any `Ledric\HttpClient` for tests, alternate transports, or
proxying.

```php
$client = new LedricClient('http://localhost:3000', [
    'http'    => new MyCustomHttpClient(),
    'headers' => ['Authorization' => 'Bearer …'],
]);
```

The included `Ledric\CurlHttpClient` is the default and only depends on
`ext-curl`.

## Tests

```bash
composer install
composer test
```

16 unit tests against a mock HTTP layer cover the surface. Integration
against a running ledric is straightforward — point `LedricClient` at
the live HTTP server (`pnpm cli http` from the monorepo) and call the
methods directly.
