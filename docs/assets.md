# Assets

Files — images, video, audio, anything — that you reference from
entry content. The model has two ideas worth understanding before
you wire it up:

- A stable `id` that lives in entry content. Survives version bumps,
  bytes replacement, label changes. Never changes.
- A per-version `ref_key` that lives in URLs. Mints fresh whenever
  the underlying bytes change. Keeps caches honest.

That split is the whole reason `<img src=".../assets/<ref_key>">`
can carry `Cache-Control: immutable` and still update when you
replace the source image.

- [The id / ref_key split](#the-id--ref_key-split)
- [Storage backends](#storage-backends)
- [Uploading](#uploading)
- [Reading bytes](#reading-bytes) (and image transforms)
- [Replacing bytes in place](#replacing-bytes-in-place)
- [Asset metadata](#asset-metadata)
- [Tagging](#tagging)
- [The transforms cache](#the-transforms-cache)

---

## The id / ref_key split

Every asset has two 32-char hex identifiers:

| | What | Lifetime | Where it shows up |
|---|---|---|---|
| **`id`** | Stable handle (UUIDv7) | Forever | Entry content (`fields.hero = "01941..."`), `get_asset` calls |
| **`ref_key`** | Per-version URL key | Until the next bytes replacement | `/assets/<ref_key>`, `<img src>`, the URL emitted by `expand_assets` |

When you `update_asset` (replace bytes in place):

- `id` doesn't change. Every entry referring to the old hero still
  resolves to the new bytes — you don't have to re-edit posts.
- `current_version` bumps from N to N+1.
- `ref_key` rotates. Old ref_key URLs keep serving the old bytes
  (each version is its own row), so caches that pinned an old URL
  never see stale-but-different content. New URLs serve the new
  bytes.

This is why `Cache-Control: public, max-age=31536000, immutable` is
correct on every byte response: the URL is *inherently*
version-pinned, so a cache holding it forever is never wrong. When
bytes change, the URL changes.

`expand_assets: true` on `read` / `find` inlines both:

```json
{
  "fields": {
    "hero": {
      "id": "01941b2c...",
      "ref_key": "a1b2c3d4...",
      "kind": "image",
      "version": 2,
      "meta": { "mime": "image/jpeg", "alt": "Team photo" },
      "url": "/assets/a1b2c3d4..."
    }
  }
}
```

---

## Storage backends

Two ship in the box. Pick one per ledric instance.

### `db` (default)

Bytes live as `BLOB` columns in the same SQLite (or MySQL/Postgres)
file as your content. Pros: one file to back up; simple ops; no
filesystem layout to manage. Cons: not great for very large media
libraries (`.db` grows; `cp` / `scp` copies the whole thing).

```bash
npx ledric serve --gui                          # db backend (default)
```

### `local`

Bytes live on disk under a configurable root (default
`./ledric-assets`). The DB stores only metadata + a path-style
`storage_ref`. Pros: the DB stays small; you can `rsync` the asset
directory separately; cheap to plug into a CDN at the file level.

```bash
npx ledric serve --gui --assets-backend local --assets-root ./media
```

Or in `ledric.config.json`:

```json
{
  "assets": { "backend": "local", "path": "./media" }
}
```

### Future: bring-your-own-bucket

The internal `AssetBackend` interface accepts arbitrary
implementations. S3 / R2 / Cloudflare adapters are on the
roadmap. The `update_asset` / `get_asset` / streaming logic doesn't
care which backend writes the bytes.

---

## Uploading

Three paths. They all end up calling the same `core.uploadAsset()`
under the hood.

### CLI

```bash
npx ledric asset upload hero.jpg
npx ledric asset upload hero.jpg --kind image --tag "Featured Event, hero"
npx ledric asset upload poster.png --assets-backend local --assets-root ./media
```

Returns the new `id`, `ref_key`, and `url` on stdout as JSON.

### HTTP multipart

```bash
curl -X POST http://localhost:3000/assets \
  -H 'Authorization: Bearer lka_...' \
  -F 'file=@hero.jpg' \
  -F 'alt=Team photo 2025' \
  -F 'tags=hero,team'
```

Returns `201 Created` with the same id/ref_key/url shape — see
[`http-api.md`](./http-api.md).

### Admin GUI / inline editor

Drag and drop into an asset field. Same code path as the upload
endpoints; nothing custom in the UI.

### Why not over MCP?

Base64-encoding bytes inflates them ~33% and burns agent tokens for
no gain. ledric's MCP surface intentionally doesn't have an
`upload_asset` tool — agents that need bytes call the CLI or the
HTTP endpoint via shell. They CAN replace existing bytes with
`update_asset` (it takes `bytes_b64`) — that's a per-need, not a
per-upload, operation.

---

## Reading bytes

`GET /assets/<ref_key>` is canonical — version-pinned, immutable
cache. `GET /assets/<id>` also works but 302-redirects to the
current `ref_key` (preserving any query string), which is what makes
entry asset fields usable as URL slugs even though they store the
`id`. The redirect itself is short-cached (~5 minutes) because the
target rotates when bytes change. The `/meta` companion (`GET
/assets/<key>/meta`) accepts either, returning the full record.

### Image transforms

imgix-style query params. Applied at request time, cached on disk
so the second hit is a static-file read.

| Param | Values | Notes |
|---|---|---|
| `w` | integer | Target width (pixels) |
| `h` | integer | Target height |
| `fit` | `clip` \| `crop` | How to fit when both `w` and `h` are set |
| `q` | 1–100 | Quality |
| `fm` | `jpg` \| `png` \| `webp` \| `avif` | Output format |
| `auto` | `format` | Negotiate on `Accept`. Adds `Vary: Accept` to the response. |
| `dpr` | 1–4 | Multiplies `w` / `h` for high-DPI screens |

```html
<!-- 600px-wide WebP for smaller payloads -->
<img src="/assets/a1b2c3d4...?w=600&fm=webp">

<!-- Auto-format: server picks AVIF / WebP / JPEG based on Accept -->
<img src="/assets/a1b2c3d4...?w=800&auto=format">

<!-- Responsive srcset -->
<img srcset="
  /assets/a1b2c3d4...?w=400&auto=format 400w,
  /assets/a1b2c3d4...?w=800&auto=format 800w,
  /assets/a1b2c3d4...?w=1200&auto=format 1200w
" sizes="(min-width: 768px) 800px, 100vw">
```

libvips does the work. JPEG / PNG / WebP / AVIF in, the same out.
Non-image kinds (video, audio, file) are served verbatim, transform
params ignored.

---

## Replacing bytes in place

When you need to swap an image without re-editing every post that
embeds it. Same `id`, new `ref_key`.

### Via CLI

```bash
npx ledric asset replace 01941b2c... ./hero-v2.jpg
# bumps assets.current_version, mints a new ref_key, prints the new URL
```

### Via MCP / HTTP

`update_asset` takes `id`, `parent_version`, `bytes_b64` (base64
source bytes), and an optional `meta` (which **replaces** the
previous meta, doesn't merge — pass it explicitly if you want it
carried forward).

```bash
curl -X POST http://localhost:3000/rpc \
  -H 'Authorization: Bearer lka_...' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "update_asset",
    "args": {
      "id": "01941b2c...",
      "parent_version": 1,
      "bytes_b64": "/9j/4AAQSkZJRg...",
      "meta": { "mime": "image/jpeg", "alt": "Team photo (refreshed Apr 2026)" }
    }
  }'
```

Posts that referenced the old hero by id keep working without
modification. Their `expand_assets` URL fields surface the new
`ref_key` automatically because that's what `find_by_id` returns.

---

## Asset metadata

`meta` is a free-form object stored alongside each asset. ledric
fills in some keys at upload time; you can add anything else.

| Key | Set by | Notes |
|---|---|---|
| `mime` | upload | The detected (or overridden) MIME type |
| `filename` | upload | Original filename |
| `alt` | you | Alt text for images. Used by the admin GUI for accessibility. |
| `title` | you | Optional caption / title |
| `width`, `height` | future | Currently set only when libvips touches the image during transform |

Anything else you write goes through verbatim. Consumers can rely
on whatever shape they put in.

---

## Tagging

Same tag system as entries. `add_asset_tags`, `remove_asset_tags`,
`list_tags` over MCP; `?tag=hero` filter on `GET /assets` over HTTP.
See [`mcp-tools.md`](./mcp-tools.md#tags).

```bash
npx ledric asset upload hero.jpg --tag "Featured Event, hero"
npx ledric asset ls --kind image    # later, list all images
```

Tags are normalised the same way as entry tags: `"#Featured Event"`,
`"featured event"`, and `"FEATURED EVENT"` all collapse to slug
`"featured-event"`.

---

## The transforms cache

Default location: `./ledric-transforms/`. Disable with
`--no-transforms-cache`.

Each transformed variant is keyed by `ref_key` + the canonicalised
query string, so two requests for `?w=800&fm=webp` and
`?fm=webp&w=800` hit the same cache entry. The cache regenerates
automatically — there's no manual invalidation step. When `ref_key`
rotates (bytes replacement), the new URL has no cache entry yet and
gets one on first hit.

The `auto=format` variant is cached separately per output format
(JPEG / WebP / AVIF), so a single source URL fans out into one
cached file per format the client negotiates.

For production deploys: put a real CDN in front. The `immutable`
header means the CDN holds files indefinitely; the `Vary: Accept`
header on `auto=format` means it splits by client capability
correctly.
