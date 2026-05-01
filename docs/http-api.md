# HTTP API

Same surface as the [MCP tools](./mcp-tools.md), reachable over plain
HTTP. All `read` operations have dedicated REST endpoints (cheap to
hit from a CDN, easy to cache); everything else dispatches through a
single `POST /rpc` that mirrors the MCP tool catalogue.

Boot the server with:

```bash
npx ledric serve --gui          # MCP stdio + HTTP + admin UI
# or, HTTP-only:
npx ledric http --port 3000
```

CORS is wide open by default — the origin check lives at the network
layer.

- [Auth](#auth)
- [Routes](#routes)
- [Asset URLs and image transforms](#asset-urls-and-image-transforms)
- [Slug redirects](#slug-redirects)
- [`POST /rpc`](#post-rpc)
- [Errors](#errors)

---

## Auth

ledric defaults to **admin-protects-writes**: GETs are open, anything
that mutates needs an admin key. Flip to closed-reads with
`--require-reader-key`.

Pass the key on every request as either header:

```
Authorization: Bearer lka_<the-secret>
X-Ledric-Key: lka_<the-secret>          # equivalent
```

Probe whether auth is on:

```bash
curl http://localhost:3000/auth/status
# { "required": true, "reads_open": true }
```

`required: false` means no keys are minted yet — the server is
running in dev/no-auth mode. The admin GUI uses this probe to decide
whether to show a key prompt before issuing a real request.

---

## Routes

### `GET /`

Self-describing root. Lists every endpoint and the `rpc_tools`
catalogue. Useful for an SDK doing capability detection.

### `GET /types`

The full content model — every type, every field, summary fields,
example. Same shape as `describe_model`.

```bash
curl http://localhost:3000/types
```

### `GET /types/:name`

A single type's definition.

```bash
curl http://localhost:3000/types/blog_post
```

Returns 404 if the type doesn't exist.

### `GET /entries/:type`

List entries of a type.

| Query param | Notes |
|---|---|
| `limit` | 1–200, default 20 |
| `offset` | |
| `locale` | Project results into this locale |
| `expand_assets` | `1` / `true` to expand all asset fields, or comma-separated field names |
| `resolve_refs` | `1` / `true` to walk markdown for `:::ref{}` directives |
| `tag` | Repeatable. AND semantics — entry must have ALL listed tags. `?tag=featured&tag=2025` |

```bash
curl 'http://localhost:3000/entries/blog_post?limit=10&tag=featured'
curl 'http://localhost:3000/entries/blog_post?expand_assets=hero'
```

Response:

```json
{
  "total": 42,
  "offset": 0,
  "results": [
    {
      "id": "0193cf2c...",
      "type": "blog_post",
      "slug": "why-kysely",
      "version": 4,
      "published_version": 3,
      "fields": { "title": "Why I switched to Kysely", "..." : "..." },
      "tags": [{ "slug": "featured", "label": "Featured" }]
    }
  ]
}
```

### `GET /entries/:type/:slug`

Read a single entry.

| Query param | Notes |
|---|---|
| `version` | Specific historical version |
| `locale` | Project into this locale |
| `expand_assets` | `1` / `true` or comma-separated field names |
| `resolve_refs` | `1` / `true` |

```bash
curl http://localhost:3000/entries/blog_post/why-kysely
curl 'http://localhost:3000/entries/blog_post/why-kysely?expand_assets=true'
```

If the slug was renamed, the response is a `301` redirect to the new
URL with `X-Ledric-Redirect: <new-slug>` set — your CDN's
permanent-redirect rule keeps old URLs valid forever.

### `GET /assets`

List assets.

| Query param | Notes |
|---|---|
| `kind` | `image` / `video` / `file` / ... |
| `tag` | Repeatable, AND semantics |
| `limit`, `offset` | |

```bash
curl 'http://localhost:3000/assets?kind=image&limit=50'
```

Each result includes a ready-to-use `url` field
(`/assets/<ref_key>`) — see the next section for transforms.

### `POST /assets`

Multipart upload.

Form fields:

| Field | Notes |
|---|---|
| `file` | The bytes (required) |
| `mime` | Override the auto-detected MIME |
| `kind` | Override the auto-detected kind (`image` / `video` / `audio` / `file`) |
| `alt` | Alt text (stored in meta) |
| `tag` or `tags` | Initial tags. Comma-separated string OR repeated field. |

```bash
curl -X POST http://localhost:3000/assets \
  -H 'Authorization: Bearer lka_...' \
  -F 'file=@hero.jpg' \
  -F 'alt=Team photo 2025' \
  -F 'tags=hero,team'
```

Response (`201 Created`):

```json
{
  "id": "0193ec4b...",
  "ref_key": "a1b2c3d4...",
  "version": 1,
  "kind": "image",
  "meta": { "mime": "image/jpeg", "filename": "hero.jpg", "alt": "Team photo 2025" },
  "url": "/assets/a1b2c3d4..."
}
```

### `GET /assets/:ref_key`

Asset bytes. Pinned by version via the per-version `ref_key`, so
`Cache-Control: public, max-age=31536000, immutable` is always
correct — caches never serve stale content.

See [Asset URLs and image transforms](#asset-urls-and-image-transforms)
for the imgix-style query params.

### `GET /assets/:key/meta`

Read asset metadata. Accepts either a `ref_key` (per-version URL
key) or the stable asset `id` — convenient for admin tools that have
one or the other.

```bash
curl http://localhost:3000/assets/a1b2c3d4.../meta
```

### `GET /tags`

Every tag in the env, sorted by usage. Same shape as `list_tags`
over MCP.

```json
[
  { "slug": "featured", "label": "Featured", "asset_uses": 3, "entry_uses": 12 },
  ...
]
```

### `POST /rpc`

Catch-all dispatch for the MCP tool surface. Same input shape as
calling the tool over MCP, just wrapped in `{ tool, args }`.

```bash
curl -X POST http://localhost:3000/rpc \
  -H 'Authorization: Bearer lka_...' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "draft",
    "args": {
      "type": "blog_post",
      "fields": { "title": "Hello", "slug": "hello", "body": "# Hi" }
    }
  }'
```

Response:

```json
{
  "result": { "type": "blog_post", "slug": "hello", "version": 1, "content": { "..." : "..." } }
}
```

Failures come back as `{ "error": { "code", "message", ... } }` with
the same status semantics as the dedicated REST routes.

The full list of `tool` names matches the MCP tool catalogue —
see [`mcp-tools.md`](./mcp-tools.md).

---

## Asset URLs and image transforms

`/assets/:ref_key` accepts imgix-style query params for image
fields. The transform happens at request time; results are cached on
disk under `--transforms-cache` (default `./ledric-transforms`).

| Param | Values | Notes |
|---|---|---|
| `w` | integer | Target width (pixels) |
| `h` | integer | Target height |
| `fit` | `clip` \| `crop` | How to fit when both `w` and `h` are set |
| `q` | 1–100 | Quality |
| `fm` | `jpg` \| `png` \| `webp` \| `avif` | Output format |
| `auto` | `format` | Negotiate on `Accept`. Adds `Vary: Accept`. |
| `dpr` | 1–4 | Device pixel ratio multiplier on `w`/`h` |

```html
<!-- Plain bytes, original format, full size -->
<img src="/assets/a1b2c3d4...">

<!-- Width-bounded WebP -->
<img src="/assets/a1b2c3d4...?w=600&fm=webp">

<!-- Auto-format negotiation -->
<img src="/assets/a1b2c3d4...?w=800&auto=format">

<!-- 2x for high-DPI screens -->
<img srcset="/assets/a1b2c3d4...?w=400&dpr=1 1x,
             /assets/a1b2c3d4...?w=400&dpr=2 2x">
```

The `ref_key` rotates whenever the underlying bytes change
(`update_asset` mints a fresh one), so URLs are inherently
version-pinned. Browser and CDN caches stay correct without manual
invalidation.

---

## Slug redirects

When you `rename_entry` (or `ledric rename` from the CLI), the old
slug retires into `slug_history`. Subsequent reads of
`/entries/:type/<old-slug>` return a `301 Moved Permanently` to the
new canonical URL with two custom headers:

```
HTTP/1.1 301 Moved Permanently
Location: /entries/blog_post/new-slug
X-Ledric-Redirect: new-slug
```

Per-locale redirects also set `X-Ledric-Redirect-Locale`. CDN edge
rules can mirror these into your public URL space so old links and
backlinks never rot.

---

## Errors

All routes use the same error shape:

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "errors": [...] } }
```

| HTTP | `code` | When |
|---|---|---|
| 400 | `INVALID_REQUEST` | Malformed args, missing required field, unknown query param |
| 400 | `VALIDATION_FAILED` | Content failed schema validation. `errors` carries JSON-Pointer paths. |
| 401 | `UNAUTHORIZED` | Missing or invalid API key (when auth is required) |
| 403 | `FORBIDDEN` | Reader key on a write endpoint |
| 404 | `NOT_FOUND` | Entry / type / asset / route doesn't exist |
| 409 | `VERSION_CONFLICT` | `parent_version` mismatch. Body carries `current_version` + `your_parent_version`. |
| 409 | `SLUG_TAKEN` | `rename_entry` collided with an existing slug |
| 422 | `TYPE_NOT_EMPTY` | `delete_type` without `cascade: true` while entries remain |
| 500 | `INTERNAL` | Bug — please file an issue with the `request_id` from the response |

Validation responses include the offending paths:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "fields rejected schema",
    "errors": [
      { "path": "/title", "message": "required" },
      { "path": "/published_at", "message": "expected ISO 8601 date" }
    ]
  }
}
```
