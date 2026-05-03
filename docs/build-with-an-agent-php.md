# Build a site with an agent — PHP

The PHP counterpart to [`build-with-an-agent.md`](./build-with-an-agent.md).
Same blog example, same agent flow — `describe_model` → `create_type`
→ seed → render → wire up the inline editor — but the consumer side
is plain PHP using `Ledric\LedricClient`.

> **A note on the artifact.** The TypeScript walkthrough is anchored
> to a committed [`examples/astro-blog/`](../examples/astro-blog/) you
> can clone and run. There isn't a committed `examples/blog-php/` yet
> — the existing [`examples/blog/`](../examples/blog/) is a vanilla
> HTML + fetch demo. The PHP code below is the one you'd write today
> with the shipped SDK; an issue is open to commit a runnable
> example next to the Astro one.

- [Before you start](#before-you-start)
- [Setting up the schema](#setting-up-the-schema)
- [Seeding some content](#seeding-some-content)
- [Building the frontend](#building-the-frontend)
- [Making it editable in place](#making-it-editable-in-place)
- [What just happened](#what-just-happened)
- [Other PHP stacks](#other-php-stacks)

---

## Architecture: ledric and your PHP site are separate processes

Same as the Astro version: ledric runs in **its own process** and
your PHP consumer is a **different project** that fetches over HTTP.

```
[ ./ledric-content/  ]      [ ./my-site-php/         ]
     ↓ runs                       ↓ runs
[ npx ledric serve ]  ←  HTTP  ←  [ php -S localhost:8000 ]
   (one Node process)               (one PHP process)
   exposes :3000                    fetches LEDRIC_API_URL
```

The PHP side never imports anything from ledric directly. It pulls
in `ledric/sdk` from Composer and that's it — `ext-curl` and
`ext-json` are the only PHP requirements.

---

## Before you start

You need:

- Node 22+ (for ledric itself)
- PHP 7.4+ with `ext-curl` and `ext-json`
- Composer
- An MCP-speaking client — Claude Code or Claude Desktop, ideally

A 60-second setup:

```bash
mkdir my-content && cd my-content      # ← ledric's directory
npx -y ledric init
# accept defaults — patches .mcp.json, mints keys, writes .gitignore
npx ledric serve --gui &
# admin GUI at http://localhost:3000/admin

claude    # start Claude Code in this directory
```

Because `init` patched `./.mcp.json`, Claude Code picks up the ledric
MCP server automatically. Confirm it's connected:

> What MCP tools do you have access to right now?

It should list the 20 ledric tools.

You'll scaffold the PHP consumer in a sibling directory
(`../my-site-php/` or wherever) — not inside `my-content/`.

---

## Setting up the schema

Same prompt as the Astro walkthrough — the schema is identical
regardless of consumer language.

> Set up a blog. Posts have a title (required, capped at 120 chars),
> a slug derived from the title, a markdown body, an optional hero
> image, an author reference, a short summary, a published date, and
> a tags string array. Title is what shows in admin lists; show
> title, author, and published_at in summary views.
>
> Then add an author type with name (required), bio (markdown), and
> avatar (image asset).

What Claude does:

1. **`describe_model`** — to see whether the types already exist and
   to remind itself of the field-type catalogue.
2. **`create_type` for `author`** first (because `blog_post`
   references it).
3. **`create_type` for `blog_post`** with the `references` field
   pointing at `author`.

Verify with the CLI:

```bash
npx ledric ls
# {
#   "db": "./ledric.db",
#   "types": [
#     { "name": "author",    "version": 1, "entries": 0 },
#     { "name": "blog_post", "version": 1, "entries": 0 }
#   ]
# }
```

For details of what each `create_type` call looks like and how the
agent infers `min`/`max` cardinality from the prompt, see the
[Astro walkthrough's schema section](./build-with-an-agent.md#setting-up-the-schema).
The wire shape is identical — only the consumer that renders the
result differs.

---

## Seeding some content

Same prompt:

> Draft three blog posts. Pick realistic titles, write 3-paragraph
> bodies, give them sensible published dates from the last few
> months. Authors can be made up — create one or two `author`
> entries first if you need to.

Claude drafts authors and posts via `draft`, then asks if you want
them published. Tell it yes:

> Publish all three posts.

`publish` once per entry. They're live.

---

## Building the frontend

Switch contexts. The schema and content are in place; now ask for a
PHP site that renders them.

> Build me a small PHP site in this directory that consumes the blog
> from ledric. Use plain PHP (no framework) and PHP's built-in dev
> server. Index page lists posts (title, summary, hero image, date).
> A post detail page renders the full post — title, hero, body as
> rendered markdown, author, tags. Use the `ledric/sdk` Composer
> package for reads.

What Claude does:

1. **`describe_model`** — re-grounds on the schema before writing
   the renderer.
2. **`composer init`** with sensible defaults.
3. **`composer require ledric/sdk league/commonmark`** — the SDK
   plus a markdown renderer.
4. **Writes `lib/ledric.php`** — a thin module that exports a
   shared `LedricClient` instance and a few helpers.
5. **Writes `index.php`** — the post-list page.
6. **Writes `post.php`** — the detail page (looks up by `?slug=`).
7. **Writes a tiny `router.php`** so PHP's built-in server routes
   pretty URLs to the right script.

The actual files end up looking like this.

`composer.json` (the relevant bits):

```json
{
  "require": {
    "php": "^8.0",
    "ledric/sdk": "^0.2",
    "league/commonmark": "^2"
  },
  "autoload": {
    "files": ["lib/ledric.php"]
  }
}
```

`lib/ledric.php` — the thin shared module:

```php
<?php
declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

use Ledric\LedricClient;

function ledric(): LedricClient {
    static $client = null;
    if ($client === null) {
        $client = new LedricClient(
            getenv('LEDRIC_API') ?: 'http://localhost:3000'
        );
    }
    return $client;
}

function isAssetId($v): bool {
    return is_string($v) && preg_match('/^[0-9a-f]{32}$/i', $v) === 1;
}

function formatDate($s): string {
    if (!is_string($s) || $s === '') return '';
    $ts = strtotime($s);
    return $ts !== false ? date('M j, Y', $ts) : '';
}

function renderMarkdown(string $md): string {
    static $converter = null;
    if ($converter === null) {
        $converter = new \League\CommonMark\CommonMarkConverter([
            'html_input' => 'allow',
            'allow_unsafe_links' => false,
        ]);
    }
    return (string) $converter->convert($md);
}
```

`index.php` — the list view:

```php
<?php
require_once __DIR__ . '/lib/ledric.php';

$result = ledric()->find('blog_post', ['limit' => 20]);
$posts = array_map(function ($p) {
    $f = $p['fields'] ?? [];
    return [
        'slug'        => $p['slug'],
        'title'       => is_string($f['title'] ?? null) ? $f['title'] : '(untitled)',
        'summary'     => is_string($f['summary'] ?? null) ? $f['summary'] : '',
        'publishedAt' => formatDate($f['published_at'] ?? null),
        'heroId'      => isAssetId($f['hero'] ?? null) ? $f['hero'] : null,
        'tags'        => is_array($f['tags'] ?? null) ? $f['tags'] : [],
        'entry'       => $p,
    ];
}, $result['results'] ?? []);
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>The latest from the team</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <h1>The latest from the team</h1>
  <ul class="post-list">
  <?php foreach ($posts as $p): ?>
    <li class="post-card">
      <?php if ($p['heroId']): ?>
        <img src="<?= htmlspecialchars(ledric()->assetUrl($p['heroId'], ['w' => 800])) ?>"
             alt="<?= htmlspecialchars($p['title']) ?>">
      <?php endif; ?>
      <h2><a href="/posts/<?= rawurlencode($p['slug']) ?>"><?= htmlspecialchars($p['title']) ?></a></h2>
      <div class="meta"><?= htmlspecialchars($p['publishedAt']) ?></div>
      <?php if ($p['summary'] !== ''): ?>
        <p><?= htmlspecialchars($p['summary']) ?></p>
      <?php endif; ?>
      <?php if (!empty($p['tags'])): ?>
        <div class="tags">
          <?php foreach ($p['tags'] as $t): ?>
            <span><?= htmlspecialchars((string) $t) ?></span>
          <?php endforeach; ?>
        </div>
      <?php endif; ?>
    </li>
  <?php endforeach; ?>
  </ul>
  <script src="<?= htmlspecialchars(ledric()->getBaseUrl()) ?>/admin/inline.js" defer></script>
</body>
</html>
```

`post.php` — the detail view:

```php
<?php
require_once __DIR__ . '/lib/ledric.php';

use Ledric\LedricClient;

$slug = $_GET['slug'] ?? null;
$post = is_string($slug) ? ledric()->read("blog_post/{$slug}") : null;

if ($post === null) {
    http_response_code(404);
    echo 'Not found';
    return;
}

$f = $post['fields'] ?? [];
$title  = is_string($f['title'] ?? null) ? $f['title'] : '(untitled)';
$body   = is_string($f['body']  ?? null) ? $f['body']  : '';
$heroId = isAssetId($f['hero'] ?? null) ? $f['hero'] : null;
$bodyHtml = renderMarkdown($body);
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title><?= htmlspecialchars($title) ?></title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <article <?= LedricClient::refAttrsHtml($post) ?>>
    <?php if ($heroId): ?>
      <img class="hero"
           src="<?= htmlspecialchars(ledric()->assetUrl($heroId, ['w' => 1200])) ?>"
           alt="<?= htmlspecialchars($title) ?>"
           <?= LedricClient::refAttrsHtml($post, 'hero') ?>>
    <?php endif; ?>
    <h1 <?= LedricClient::refAttrsHtml($post, 'title') ?>>
      <?= htmlspecialchars($title) ?>
    </h1>
    <div class="meta" <?= LedricClient::refAttrsHtml($post, 'published_at') ?>>
      <?= htmlspecialchars(formatDate($f['published_at'] ?? null)) ?>
    </div>
    <div class="prose" <?= LedricClient::refAttrsHtml($post, 'body') ?>>
      <?= $bodyHtml ?>
    </div>
  </article>
  <script src="<?= htmlspecialchars(ledric()->getBaseUrl()) ?>/admin/inline.js" defer></script>
</body>
</html>
```

`router.php` — for PHP's built-in dev server, so `/posts/hello-world`
routes to `post.php?slug=hello-world`:

```php
<?php
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';

// Static assets: let the built-in server handle them.
if (preg_match('/\.(css|js|png|jpe?g|svg|ico|woff2?)$/i', $path)) {
    return false;
}

// /posts/<slug> → post.php?slug=<slug>
if (preg_match('#^/posts/([^/]+)/?$#', $path, $m)) {
    $_GET['slug'] = rawurldecode($m[1]);
    require __DIR__ . '/post.php';
    return true;
}

// Everything else → index.php
require __DIR__ . '/index.php';
return true;
```

Three things worth pausing on, same as the Astro version:

1. **The agent never asked you for the schema.** It called
   `describe_model` and read it. The `array_map` shape on the index
   page directly reflects the field types — `title: string`,
   `summary: string`, `hero: asset` (resolved via `assetUrl`),
   `tags: array`.

2. **The reads are typed at the runtime boundary, not by codegen.**
   The PHP SDK returns associative arrays (not objects), so the
   per-field `is_string` / `isAssetId` checks are doing the same
   defensive narrowing the TypeScript version did with `typeof` and
   `as Record<string, unknown>`. There's no codegen step — the
   wire format is the contract.

3. **The body is just markdown.** `league/commonmark` parses it. If
   you want a different markdown library (`erusev/parsedown`,
   `michelf/php-markdown`), the same string flows in. ledric stores
   markdown verbatim — no SDK lock-in.

Run it:

```bash
php -S localhost:8000 router.php
```

Live data from the live ledric instance. Edit a post in the admin
GUI at `:3000/admin`, hit publish, refresh `:8000` — the change shows
up on next request (no caching beyond what the browser does).

---

## Making it editable in place

The site renders. Now wire up the inline editor so you can
click-edit on the rendered page.

> Add the inline editor. I should be able to hover anything and get
> a pencil icon that opens the edit drawer.

The agent's actual changes:

1. **The `<script src=".../admin/inline.js">` tag** is already in
   the templates above. (Claude tends to add it on the first pass
   when it knows the inline editor is coming. If yours doesn't,
   just ask it to.)
2. **`LedricClient::refAttrsHtml($post)`** on the post wrapper —
   already there in `post.php`.
3. **Field-scoped attrs** — `LedricClient::refAttrsHtml($post,
   'title')` on the heading, `'body'` on the content, etc.

Reload `/posts/hello-world`. Hover the title. Pencil appears.
Click it. Drawer slides in, scrolled to the title field. Edit,
save — page reloads with the new published content.

The ergonomics in PHP are slightly noisier than in JSX (no spread
operator), but the helper does the work. `refAttrsHtml` returns
a single pre-escaped string that drops directly into an HTML
attribute position with `<?= ... ?>`. There's also `refAttrs()`
that returns an associative array of `data-*` keys if you want to
build the HTML differently (e.g. inside a Twig macro that loops
over attributes).

---

## What just happened

The same bullets as the Astro walkthrough, with PHP-specific notes:

**The schema is the API.** Zero type definitions in your PHP code.
The agent read the schema once via `describe_model` and that was
the spec.

**`describe_model` is the discovery primitive.** Claude called it
twice: once before creating types, once when starting the PHP
consumer. The same in-context handoff works regardless of what
language ends up rendering the result.

**Validation drives correctness.** When Claude's first draft of a
post fails validation (e.g. `summary` over the max length, or
`body: null` when required), the structured error tells it the
field path and code. It corrects and retries on its own.

**Tokens stay cheap.** The list page used `find` with the default
summary budget (`title`, `author`, `published_at` per result, not
the full body of every post). The detail page used `read` without
`expandAssets`, building the URL from the asset id manually with
`assetUrl()`.

**Inline editing is plumbing-free.** `LedricClient::refAttrsHtml`
plus one script tag. The drawer is the same form the admin GUI
uses; validation and version conflict handling are identical
between the surfaces.

The shape of this build — `lib/ledric.php`, `index.php`, `post.php`,
`router.php`, the Composer file — totals about 200 lines of PHP.
That's the entire consumer for a working blog.

---

## Other PHP stacks

The pattern is the same wherever you can `composer require
ledric/sdk` and emit HTML.

**Twig** — the templates above translate directly. `getEnvironment()`
the Twig instance once, render with `$client->read(...)` data, use
the global function approach to expose `LedricClient::refAttrsHtml`
to templates. Inline editor doesn't care.

**Laravel** — `composer require ledric/sdk`, register the
`LedricClient` as a singleton in a service provider, inject it into
controllers. Blade templates work the same way as the PHP files
above; use `{!! \Ledric\LedricClient::refAttrsHtml($post, 'title')
!!}` for unescaped attribute output.

**Symfony / Slim / etc.** — all the same shape. The SDK has zero
framework dependencies.

**Static-site builds** — a tiny PHP CLI script that loops over
`ledric()->find('blog_post', ...)` and writes one HTML file per
result. The inline editor still works on the static output (it
walks the rendered DOM at runtime regardless of how the page was
generated).

The thread connecting all of these: the agent learns your model
once via `describe_model`, picks the right SDK shape for the
target language, and writes code that consumes the same flat-JSON
shape you'd see at `GET /entries/blog_post/why-kysely`.

---

## Where to go next

- [The TypeScript walkthrough](./build-with-an-agent.md) — the
  side-by-side comparison.
- [SDKs](./sdks.md) — the full PHP method surface, options, and
  errors.
- [Inline editor](./inline-editor.md) — the attribute reference and
  behavioural details.
- [Agent recipes](./agent-recipes.md) — more example prompts you can
  paste into Claude.
