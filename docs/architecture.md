# Architecture

How the pieces fit together. This page exists for the operator,
contributor, or curious reader who wants to know what's actually
running when `npx ledric serve --gui` boots up.

If you only want to *use* ledric, [`build-with-an-agent.md`](./build-with-an-agent.md)
will get you further faster. Come back here when you need to reason
about deployment shape, debugging, or why a particular boundary
exists.

- [The ten-thousand-foot view](#the-ten-thousand-foot-view)
- [The packages](#the-packages)
- [Inside the ledric process](#inside-the-ledric-process)
- [The two-process consumer pattern](#the-two-process-consumer-pattern)
- [Storage adapters](#storage-adapters)
- [The asset pipeline](#the-asset-pipeline)
- [The inline editor](#the-inline-editor)
- [Process lifecycle](#process-lifecycle)

---

## The ten-thousand-foot view

```
┌────────────────────────┐         ┌────────────────────────┐
│  Agent (Claude Code,   │         │  Browser              │
│  Cursor, your script)  │         │  (admin GUI, inline   │
│                        │         │  editor)              │
└──────┬──────────┬──────┘         └────────────┬───────────┘
       │          │                             │
   MCP │      MCP │                       HTTPS │
   stdio│      SSE│                             │
       │          │                             ▼
       │          │              ┌────────────────────────┐
       │          │              │  Reverse proxy +       │
       │          └──────────────│  TLS (in production)   │
       │                         └────────────┬───────────┘
       │                                      │
       ▼                                      ▼
┌────────────────────────────────────────────────────────────┐
│  ledric process (Node 22+)                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │  MCP server  │  │  HTTP server │  │  Admin GUI   │     │
│  │  (stdio +    │  │  (REST +     │  │  (static SPA │     │
│  │   SSE)       │  │   /rpc)      │  │   served at  │     │
│  └──────┬───────┘  └──────┬───────┘  │   /admin)    │     │
│         │                 │          └──────┬───────┘     │
│         └─────────┬───────┘                 │             │
│                   ▼                         ▼             │
│         ┌──────────────────────────────────────────┐      │
│         │  Core (schema, validation, refs,         │      │
│         │  versions, transforms)                   │      │
│         └──────────────────┬───────────────────────┘      │
│                            ▼                              │
│         ┌──────────────────────────────────────────┐      │
│         │  Storage (SQLite | Postgres | MySQL)     │      │
│         │  + Asset backend (db | local fs)         │      │
│         └──────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────┘
                            │
                            ▼
                   ┌─────────────────┐
                   │   ledric.db     │
                   │   (or remote    │
                   │    Postgres /   │
                   │    MySQL DB)    │
                   └─────────────────┘
```

One process. One file (or one external DB). Multiple ways in (MCP,
HTTP, admin GUI). One core doing schema/versioning/validation. A
pluggable storage layer underneath.

---

## The packages

ledric is a pnpm monorepo. Each package has one job.

```
packages/
├── schema/        — defineType(), field types, validation
├── storage/       — SQLite/Postgres/MySQL adapters + asset backends
├── core/          — read/draft/publish/find, transforms, ref resolution
├── mcp-server/    — registers the 20 MCP tools, dispatches to core
├── http-server/   — Express-style routes (REST + /rpc), serves the GUI
├── gui/           — admin SPA (React + Vite); also serves /admin/inline.js
├── sdk/           — @ledric/sdk: TS read client + refAttrs helpers
├── proxy/         — @ledric/proxy: server-side proxy primitive for consumers
└── cli/           — ledric command (init, serve, get, ls, asset, keys, …)

clients/
└── php/           — ledric/sdk (Composer): PHP read client
```

Three things worth noticing:

1. **Core is the single dispatch point.** Both `mcp-server` and
   `http-server` are thin shells over `core` — they parse their
   transport's args, call into `core`, and serialise the result
   back. Adding a third transport (gRPC, queue-based ingestion,
   anything) wouldn't require duplicating business logic.

2. **Storage is two layers, not one.** `storage` has a dialect
   layer (SQLite / Postgres / MySQL) and an asset-backend layer
   (db / local). Either dimension can flex independently — you
   can run SQLite-with-on-disk-assets or Postgres-with-in-DB-assets
   if you want.

3. **`sdk` and `proxy` are consumer-facing.** They're the
   packages you'll add to your *consumer site's* `package.json`,
   not ledric's. They don't import `storage` or `core` — they
   speak HTTP to a running ledric.

---

## Inside the ledric process

What's actually running when `ledric serve --gui` boots.

### The MCP server (`packages/mcp-server`)

Registers the 20 tools listed in
[`mcp-tools.md`](./mcp-tools.md). Listens on stdio by default
(which is what desktop MCP clients like Claude Desktop expect). It
dispatches every `CallToolRequest` to `core`, wraps errors into
the structured ledric error shape, and returns the result.

The same tool surface is available over HTTP at `POST /rpc` —
that path lives in `http-server`, but the dispatch goes through
exactly the same `core` methods. There is no second
implementation.

### The HTTP server (`packages/http-server`)

A handful of REST routes plus the catch-all `/rpc`:

```
GET  /                        — root: API info, endpoint list
GET  /auth/status             — auth posture check
GET  /types                   — same as describe_model over HTTP
GET  /types/:name
GET  /entries/:type           — list (paginated, filterable)
GET  /entries/:type/:slug     — read one (with version, locale, expand opts)
POST /assets                  — multipart upload
GET  /assets                  — list
GET  /assets/:id              — metadata
GET  /assets/:id/meta         — explicit metadata
GET  /assets/<ref_key>        — bytes (with imgix-style transforms)
POST /rpc                     — generic dispatch to any of the 20 tools
GET  /admin/*                 — static GUI files (when --gui is on)
GET  /admin/inline.js         — the inline editor loader script
```

The REST routes exist because they're more ergonomic for a
browser, a CDN, or a traditional HTTP client than `POST /rpc`
would be. The two surfaces are equivalent — anything you can do
over REST you can also do via `/rpc`, and vice versa.

Auth lives here too: a simple middleware that reads
`Authorization: Bearer <key>` (or env-var override) and routes
requests to admin / reader / unauthenticated paths based on the
key's role.

### Core (`packages/core`)

The brain. Owns:

- **Reads.** `read`, `find`, with all the projection options
  (`expand_assets`, `resolve_references`, `resolve_refs`,
  `summary`, locale projection, version selection).
- **Writes.** `draft`, `publish`, `rename_entry`, `delete_entry`,
  `migrate_entries`. Concurrency via `parent_version`. Validation
  via `schema`.
- **Schema lifecycle.** `create_type`, `alter_type`, `delete_type`.
  Computes `change_class` (`safe` / `needs_backfill` /
  `destructive`) by diffing field definitions.
- **Asset transforms.** `core/src/transforms.ts` wraps `sharp`
  (libvips), parses imgix-style query parameters, and writes a
  per-`(ref_key, params_hash)` cache to disk.
- **Ref resolution.** `core/src/resolve-refs.ts` parses
  `:::ref{to="…"}:::` directives in markdown fields and resolves
  the target entries.
- **`describe_model`.** Walks the schema, decorates with capability
  flags, returns the whole content model.

Core depends on `storage` for persistence and `schema` for type
validation. It doesn't know about HTTP, MCP, or the admin GUI.

### Schema (`packages/schema`)

Pure TypeScript: `defineType()`, the field-type catalogue, the
validator. No I/O. Imported by both consumer code (in user
projects, via `@ledric/schema`) and by `core` for write-time
validation.

### Storage (`packages/storage`)

Dialect-and-adapter pattern. The same logical operations
(`createType`, `getEntry`, `listEntries`, `writeVersion`, …)
implemented three times (SQLite, Postgres, MySQL) on the
dialect side, and twice (db-resident, local filesystem) on
the asset-bytes side.

Tests run against real databases when `LEDRIC_TEST_POSTGRES_URL`
or `LEDRIC_TEST_MYSQL_URL` are set; the default `pnpm test` is
SQLite-only.

### Admin GUI (`packages/gui`)

A React + Vite SPA. Built into static files at install time;
served by `http-server` under `/admin/`. State management is
plain React; data fetching is the `@ledric/sdk` client pointed at
the same origin.

`/admin/inline.js` is also served by this package — the script
is small, framework-free vanilla JS, and is loaded by consumer
sites with a single `<script>` tag.

### CLI (`packages/cli`)

Wraps everything. `ledric init` walks first-time setup; `ledric
serve` boots the MCP server (with optional `--http` and `--gui`
flags); `ledric ls` / `get` / `asset` are admin-side reads; `ledric
keys` mints and revokes API keys; `ledric types` codegens
TypeScript from your schema; `ledric refs check` lints inline refs
across all your markdown fields.

Full CLI surface is documented per-command in `ledric --help`.

---

## The two-process consumer pattern

```
┌──────────────────────┐                ┌──────────────────────┐
│  ledric process       │                │  Consumer process     │
│  (the CMS)            │                │  (Astro, Next, PHP,   │
│                       │                │   plain HTML, …)      │
│  npx ledric serve     │                │  npm run dev          │
│                       │                │                       │
│  - MCP stdio          │                │  - imports @ledric/sdk│
│  - HTTP API           │ ◄── HTTP ──►  │  - calls client.read()│
│  - Admin GUI          │                │  - renders pages      │
│  - libsharp + sqlite  │                │  - serves /admin/inline.js│
└──────────────────────┘                └──────────────────────┘
        ./ledric.db                          ./astro.config.mjs
```

The consumer site is **a different process in a different
directory**. It does not import `ledric` itself. It imports
`@ledric/sdk` (TS) or `ledric/sdk` (PHP) — read clients that
speak HTTP to the running ledric process.

Why:

- **Build-size hygiene.** `better-sqlite3` and `sharp` are heavy
  native modules. Your Vercel build (or your Lambda cold start)
  doesn't need them.
- **Independent scaling.** ledric handles writes and admin
  traffic; consumer renderers handle reads-and-render. Different
  shapes, different machines.
- **Same SDK, many stacks.** Astro, Next, Remix, plain HTML +
  htmx, vanilla PHP, Twig templates — they all hit the same HTTP
  surface with the same client shape. There's no
  framework-specific deep integration to maintain.

For local dev convenience, the two processes are usually started
side by side. Production deploys put a CDN in front of
`/assets/<ref_key>`, a reverse proxy in front of everything else,
and run the consumer site on its own host fleet that fetches from
ledric over the network.

When the consumer needs admin-level reach (versioned reads,
asset uploads, write operations) without leaking the admin key
into the browser, it mounts `@ledric/proxy` server-side. The
proxy holds the admin key in environment variables and exposes
a curated subset of ledric's surface to the browser.

---

## Storage adapters

The storage package implements the same logical interface three
times.

```
storage/
├── interface.ts           — the methods every dialect implements
├── dialects/
│   ├── sqlite.ts          — better-sqlite3, WAL mode, FTS5
│   ├── postgres.ts        — pg, tsvector FTS
│   └── mysql.ts           — mysql2, FULLTEXT FTS
└── assets/
    ├── backend.ts         — the asset-bytes interface
    ├── db.ts              — bytes in an asset_blobs table
    └── local.ts           — bytes on disk, keyed by ref_key
```

Capability differences are reported through `describe_model`'s
`capabilities` block:

```json
{
  "capabilities": {
    "vectorSearch": false,
    "nativePubSub": false,
    "fts": "fts5"
  }
}
```

`fts` is one of `fts5` (SQLite), `tsvector` (Postgres), or
`fulltext` (MySQL). Vector search and native pub/sub are reserved
capability flags for features that aren't shipped — see
[`roadmap.md`](./roadmap.md).

---

## The asset pipeline

```
┌──────────────────┐
│ Upload           │  POST /assets (multipart)
│ (HTTP only)      │
└────────┬─────────┘
         ▼
┌──────────────────┐
│ Asset record     │  assets table: id, ref_key, kind, version,
│                  │  meta (json: width, height, mime, alt, …)
└────────┬─────────┘
         ▼
┌──────────────────┐  asset_blobs (db backend) OR
│ Bytes            │  ./assets/<ref_key>.bin (local backend)
└────────┬─────────┘
         ▼
GET /assets/<ref_key>?w=800&fm=webp
         │
         ▼
┌──────────────────┐
│ Transform cache  │  ./.ledric-cache/transforms/<key>.bin
│ (libvips/sharp)  │  (cache miss → render → write → serve)
└────────┬─────────┘
         ▼
   Bytes back
```

URLs are version-pinned via `ref_key`. Replacing the bytes mints
a new `ref_key` and therefore a new URL — CDN caches invalidate
themselves. Old URLs keep serving old bytes until you prune them
(no automatic GC yet).

The transform cache lives next to the database file (`.ledric-cache/`
by default) and is just files keyed by `(ref_key, params_hash)`.
Safe to delete; will be regenerated on next request.

For the full asset story — uploads, transforms, in-place
replacement, the cache layout — see [`assets.md`](./assets.md).

---

## The inline editor

```
Consumer site HTML
┌───────────────────────────────────────────────┐
│ <article data-ledric-ref="blog_post/hello">  │
│   <h1 data-ledric-ref="blog_post/hello"      │
│       data-ledric-field="title">Hello</h1>    │
│   <div data-ledric-ref="..."                  │
│        data-ledric-field="body">…</div>       │
│ </article>                                    │
│                                                │
│ <script src="<ledric>/admin/inline.js"></script>│
└───────────────────────────────────────────────┘
                  │
                  │ (script walks the DOM, attaches
                  │  hover handlers to data-ledric-ref
                  │  elements)
                  ▼
       Hover → pencil icon → click
                  │
                  ▼
       Drawer: form for the entry, scrolled
       to the field that was clicked
                  │
                  ▼
       Save → POST through the admin API →
       new version → publish → page reloads
```

Three pieces working together:

1. **`refAttrs(entry)` / `refAttrs(entry, field)` SDK helpers**
   emit the `data-ledric-ref` and `data-ledric-field` attributes
   on the consumer-rendered HTML.
2. **`/admin/inline.js`** is loaded by the consumer site (one
   `<script>` tag). It walks the DOM looking for those
   attributes, attaches mouseenter/click listeners, and renders
   the floating pencil + drawer.
3. **The drawer's form** is the same form `gui/` uses for the
   admin entry editor. It's served by ledric's HTTP server, so
   validation, version conflict handling, and save semantics are
   identical between the two surfaces.

The script is small and framework-free; it works on any rendered
HTML regardless of the consumer's stack. See
[`inline-editor.md`](./inline-editor.md) for the full attribute
reference and behavioural details.

---

## Process lifecycle

What `ledric serve --gui` does, in order:

1. **Read config.** `ledric.config.json` if present; otherwise
   defaults (SQLite at `./ledric.db`, port 3000, `/admin` for
   the GUI).
2. **Open storage.** Dialect chosen from the DB connection
   string. SQLite opens the file (creating it if missing);
   Postgres / MySQL connect to the configured URL. Migrations
   run automatically — every bootup converges the schema.
3. **First-boot key minting.** If no API keys exist, mint an
   admin and a reader key, write them to `.env.local` (CLI
   path) or print them to stdout (programmatic path).
4. **Boot the MCP server.** Stdio transport wired up; tool
   handlers registered.
5. **Boot the HTTP server.** REST routes mounted, `/rpc`
   mounted, GUI static files mounted (with `--gui`),
   `/admin/inline.js` served.
6. **Listen.** MCP on stdio. HTTP on the configured port.
   Process stays up until killed.

Every request — whether MCP `read` or HTTP `GET /entries/...`
— routes through `core`, which routes through `storage`, which
talks to the underlying database. There's no internal queue, no
worker pool, no separate process for renders. It's a Node
event-loop process with the usual concurrency story.

---

## Where to go next

- [Build a site with an agent](./build-with-an-agent.md) — see all
  this in motion against a working Astro example.
- [Deployment](./deployment.md) — what changes in production
  (CDN, reverse proxy, Postgres / MySQL, backups).
- [MCP tools](./mcp-tools.md) — every tool the dispatch table
  knows about.
- [HTTP API](./http-api.md) — every route the HTTP server exposes.
