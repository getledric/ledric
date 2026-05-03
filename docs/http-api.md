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

### The entry envelope

Both `GET /entries/:type` (in each `results` element) and
`GET /entries/:type/:slug` (the response itself) return the same
shape:

```json
{
  "id": "0193cf2c...",
  "type": "blog_post",
  "slug": "why-kysely",
  "version": 4,
  "published_version": 3,
  "fields": { "title": "Why I switched to Kysely", "body": "..." },
  "tags": [{ "slug": "featured", "label": "Featured" }]
}
```

**Your content lives under `fields`.** The top-level keys (`id`,
`type`, `slug`, `version`, `published_version`, `tags`) are entry
metadata; everything you defined on the type lives inside `fields`.
Consumer-side TypeScript types want this shape:

```ts
interface Entry<F> {
  id: string;
  type: string;
  slug: string;
  version: number;
  published_version?: number;
  fields: F;
  tags?: Array<{ slug: string; label: string }>;
}
```

The same envelope is used by the MCP `read` and `find` tools — pick
the appropriate transport, the response shape is identical.

### `GET /entries/:type`

List entries of a type.

| Query param | Notes |
|---|---|
| `limit` | 1–200, default 20 |
| `offset` | |
| `locale` | Project results into this locale (with fallback) |
| `order` | `field:dir` — e.g. `?order=published_at:desc`. Comma-separate for multi-field: `?order=published_at:desc,title:asc`. Bare `?order=field` defaults to ascending. |
| `expand_assets` | `1` / `true` to expand all asset fields, or comma-separated field names |
| `resolve_references` | `1` / `true` to inline `references`-typed field values, or comma-separated field names. Different from `resolve_refs` — that walks markdown for `:::ref{}` directives. |
| `resolve_refs` | `1` / `true` to walk markdown for `:::ref{}` directives, attaches `_refs` sidecar |
| `q` | Full-text search across `searchable: true` fields. AND-composes with `tag`, overrides `order` with relevance rank. |
| `tag` | Repeatable. AND semantics — entry must have ALL listed tags. `?tag=featured&tag=2025` |
| `include_private` | `1` / `true` to include `private: true` fields (admin-only contexts) |
| `published` | `1` / `true` to restrict to currently-published entries (drafts filtered out; each result projects from its published version, not the head). The natural default for SSG / SSR consumers. |
| `summary` | `1` / `true` to project each result's `fields` to the type's declared `summary_fields`. Reserved sidecars (`_locale`, `_refs`) pass through unchanged. Saves payload size for list views that don't need the full body. Default: full fields. |

```bash
curl 'http://localhost:3000/entries/blog_post?order=published_at:desc&limit=10'
curl 'http://localhost:3000/entries/blog_post?expand_assets=hero&resolve_references=author'
curl 'http://localhost:3000/entries/blog_post?q=kysely'
curl 'http://localhost:3000/entries/blog_post?published=true'
```

Response: `{ total, offset, results: Entry[] }` — see the envelope
above.

### `GET /entries/:type/:slug`

Read a single entry.

| Query param | Notes |
|---|---|
| `version` | Specific historical version |
| `locale` | Project into this locale |
| `expand_assets` | `1` / `true` or comma-separated field names |
| `resolve_references` | `1` / `true` or comma-separated field names |
| `resolve_refs` | `1` / `true` |
| `include_private` | `1` / `true` |

```bash
curl http://localhost:3000/entries/blog_post/why-kysely
curl 'http://localhost:3000/entries/blog_post/why-kysely?expand_assets=true&resolve_references=author'
```

Response: a single `Entry` (the envelope above).

If the slug was renamed, the response is a `301` redirect to the new
URL with `X-Ledric-Redirect: <new-slug>` set — your CDN's
permanent-redirect rule keeps old URLs valid forever.

> **Watch out: `Date` parsing.** `published_at` and other `date`
> fields come back as `YYYY-MM-DD` strings. `new Date("2026-05-01")`
> parses as UTC midnight, which renders as the previous day in
> negative-UTC timezones. If you want the date as the editor wrote
> it, parse manually: `const [y,m,d] = iso.split("-").map(Number);
> new Date(y, m-1, d);`

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

If the path param is the stable asset `id` instead of a `ref_key`,
the route 302-redirects to the current `ref_key` URL (preserving any
query string). Entry asset fields store the `id`, so they work as URL
slugs without `expand_assets`. The redirect itself is short-cached
(`max-age=300`) since the target ref_key rotates whenever bytes are
replaced — caches must not pin it.

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

### `ANY /mcp` (when `--http-mcp` or `--public-mcp` is on)

Streamable HTTP MCP transport. POST for client→server JSON-RPC, GET
for the optional server→client SSE stream, DELETE to terminate a
session. Session correlation via the `Mcp-Session-Id` header per
[the MCP spec](https://modelcontextprotocol.io/specification).

Auth on `/mcp` is per-tool, mirroring `/rpc`: protocol-level reads
(`initialize`, `tools/list`, etc.) and read-only `tools/call` invocations
accept reader keys; writes need admin. Public mode also accepts
OAuth bearer JWTs (scope → role per the table in
[`auth.md`](./auth.md#oauth-tokens-third-path---public-mcp-only)).
Routes 404 when the flag isn't set.

See [`remote-mcp.md`](./remote-mcp.md) for the local-vs-public mode
split.

### OAuth provider (when `--public-mcp` is on)

Six routes, all rooted at the configured `publicUrl`:

| Path | Purpose |
|---|---|
| `GET /.well-known/oauth-authorization-server` | RFC 8414 discovery |
| `GET /.well-known/oauth-protected-resource` | MCP authorization spec |
| `POST /oauth/register` | DCR (RFC 7591) — public PKCE-only clients |
| `GET /oauth/authorize` | Auth-code flow start (handled by oidc-provider) |
| `GET /oauth/consent/:uid` | Operator consent page (admin-key paste) |
| `POST /oauth/consent/:uid` | Submit admin key, finalize the interaction |
| `POST /oauth/token` | `authorization_code` and `refresh_token` grants |
| `POST /oauth/revoke` | RFC 7009 |
| `GET /oauth/jwks` | Ed25519 public key (single-key set, stable `kid`) |

Tokens are Ed25519-signed JWTs. Default access TTL is 1h, refresh TTL
30d, refresh rotation enabled. Replaying an already-rotated refresh
token revokes the entire lineage forward.

### `POST /rpc`

Catch-all dispatch for the MCP tool surface. Same input shape as
calling the tool over MCP, just wrapped in `{ tool, args }`.

**Auth note:** /rpc is per-tool, not per-method. Read-only tools
(`describe_model`, `read`, `find`, `get_asset`, `list_assets`,
`list_tags`) accept reader keys; write tools require admin. So you
can hit `POST /rpc { tool: "find" }` with a reader key safely.

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
