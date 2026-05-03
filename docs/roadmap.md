# Roadmap

What's stable, what's being worked on, what's planned, and what's
explicitly not in scope. People plan around clear "no" better than
around vague "maybe", so the lines below are deliberately drawn.

No timeline commitments. ledric is a personal-project-scaled effort
right now; "when it's ready" is the only honest answer.

- [Stable](#stable)
- [In progress](#in-progress)
- [Planned (post-v1)](#planned-post-v1)
- [Explicitly out of scope](#explicitly-out-of-scope)
- [How decisions get made](#how-decisions-get-made)

---

## Stable

APIs and behaviours that won't change before v1 without notice.
"Stable" here means the surface; the implementation under it can
still get better.

- **The 20 MCP tools.** Names, argument shapes, and return shapes
  are settled. New optional arguments may be added; existing ones
  won't be renamed or repurposed without a deprecation cycle. See
  [`mcp-tools.md`](./mcp-tools.md).
- **The HTTP routes.** `GET /types`, `GET /entries/:type[/:slug]`,
  `GET /assets/...`, `POST /assets`, `POST /rpc`. Same compatibility
  promise.
- **The wire format.** Flat entries with `fields`, optional
  `_meta`, `_redirect` sidecar on slug renames, `_locale` sidecar
  on localized reads, `_refs` sidecar on `resolveRefs: true`.
- **Schema authoring.** `defineType()` from `@ledric/schema`,
  the field-type catalogue documented in [`schema.md`](./schema.md),
  the canonical JSON shape that gets stored.
- **Auth model.** Two roles (admin, reader), `Authorization: Bearer`
  header, env-var override. Closed-reads mode via
  `--require-reader-key`.
- **`@ledric/sdk` (TS) and `ledric/sdk` (PHP) public surfaces.**
  The methods documented in [`sdks.md`](./sdks.md) are stable.
  Internal helpers may move; public methods won't.
- **`@ledric/proxy`.** The mount-anywhere proxy primitive's
  public API.
- **Slug history and redirects.** Renames retire old slugs into
  `slug_history`; reads of old slugs return 301 with `_redirect`.
- **Storage portability.** SQLite, Postgres, and MySQL are all
  first-class. No plans to drop any of them.
- **Asset URL shape.** `/assets/<ref_key>` with imgix-style
  query parameters. URLs are version-pinned.

---

## In progress

Partial features with concrete remaining work. These are real
today in some form; they're not yet what they'll be at v1.

### Stable test surface

- **Unit tests** (~360 in vitest, SQLite-only by default;
  ~18 Postgres + ~18 MySQL opt-in via env vars) cover storage,
  schema, core, and MCP dispatch.
- **Playwright e2e** smoke suite covers the admin GUI.
- **Remaining:** more end-to-end coverage of HTTP routes against
  real storage, a published "minimum supported Node" CI matrix.

### Codegen

- **Today:** `ledric types` reads your live schema and writes
  `ledric.types.ts`. Optional `--augment-sdk` adds a
  `declare module` block so `client.read<'blog_post'>(...)` is
  inferred.
- **Remaining:** more nuanced types for `:::ref{}:::` resolution
  shape, generated guards (`isBlogPost(entry)`), better error
  messages when the codegen runs against a stale schema.

### Asset pipeline polish

- **Today:** uploads, in-place bytes replacement, transforms via
  sharp/libvips, two backends (db, local fs), URL version-pinning,
  on-disk transform cache.
- **Remaining:** automatic pruning of old `ref_key` bytes (today
  they stick around forever), automatic cleanup of the transforms
  cache, S3 / R2 / generic-bucket adapters (the backend interface
  exists; the implementations don't).

### MCP `init` and onboarding

- **Today:** `ledric init` walks DB path, port, MCP client wiring
  (Claude Desktop config, `.mcp.json` for Code/Cursor), key
  minting, `.gitignore` patches.
- **Remaining:** wider client support (anything new that joins the
  MCP ecosystem), better recovery from partial-init states.

---

## Planned (post-v1)

Real intentions, no commitments. Listed here so you know whether
to wait or build around the gap.

### `subscribe` / SSE / webhooks

The original spec describes a `subscribe` MCP tool and a webhook
delivery system. Neither is implemented. The delivery shape is
clear; the work is real implementation effort plus deciding how
the in-process bus on SQLite vs. native pub/sub on Postgres
should differ.

If you need eventing today, poll. The HTTP API is fast enough that
a 5–30 second poll loop is fine for most "did anything change"
workflows.

### Versioning tools over MCP

`read_version`, `revert`, `diff`, `list_versions` are described in
the original spec but aren't surfaced as MCP tools. You can pass
`version: N` to `read` today; the rest is HTTP-callable but not
yet first-class.

The shape is settled; this is mostly typing.

### Branching and environments

The storage schema has `env_id` and `parent_env` columns on every
type, entry, and asset. The plumbing exists. The API to fork an
environment, write changes inside it, and merge back into the
parent doesn't.

This is the feature that needs the most design work — copy-on-write
metadata, three-way per-entry merge for JSON content, conflict
representation that an agent can resolve programmatically. Not
something to expect soon.

### External asset backends

S3 / R2 / generic-bucket adapters. The `AssetBackend` interface
exists; the implementations don't. Mostly straightforward — the
hard parts are auth, permissioning the upload path, and deciding
how the backend interacts with version-pinned `ref_key` URLs.

### Vector / similarity search

The `vector` field type is wired through schema and validator —
you can declare `field.vector({ dims: 1536, byo: true })` and
write vectors to it. There is **no similarity-search query path
yet**. `find` doesn't accept a `vector` filter. Don't ship a
search-by-meaning feature on top of this today.

When this lands, it'll likely use `pgvector` for Postgres,
`sqlite-vec` (not vss) for SQLite, and a documented "your
embedding model is your problem" stance for the actual vectors.

### `:::component{…}:::` directives

The original spec mentions `:::component{...}:::` as a sibling to
`:::ref{...}:::` for rendering reusable components inline. The
parser only recognises `:::ref{...}:::` today. Adding `component`
is a small parser change plus a meaningful design decision: what
does "a component" mean when the renderer is a separate process
that ledric doesn't know about?

The current answer is "use a `references` field that points at
a section/component-shaped entry and let the renderer pick the
template". `:::component{}:::` would only earn its place if it
makes that flow noticeably nicer.

### First-class importers

Contentful, Sanity, Strapi, WordPress. Today's pattern is "write
a small script". The pattern works; first-class importers are a
nice-to-have, not a blocker for anyone determined.

### Scheduled publishes

`publish` is immediate today. Scheduled publish (move the
`published_version` pointer at time T) is in the original spec
and on the post-v1 list. Implementation needs a small worker /
cron path to run.

### Soft-delete retention policy

Soft delete is implemented (`deleted_at` set, row stays).
There's no automatic GC of soft-deleted rows yet — you have to
hard-delete manually. Configurable per-type retention (default
90 days, say) is on the post-v1 list.

### Better admin GUI

The admin works. It's deliberately functional. Nicer table
filters, bulk operations, schema-editing UI for non-coders, an
asset organiser that doesn't make you scroll forever — all of
these are real opportunities, all on the post-v1 list. None of
them are in flight today.

### Permissions beyond admin / reader

Per-type, per-field, per-environment grants. Two-role auth is
fine for a small project; it isn't fine for an editorial team
of 30 people with different responsibilities. This is on the
post-v1 list and will probably need someone with strong
opinions about CMS permission models to drive the design.

---

## Explicitly out of scope

Lifted from the original spec, with caveats. These are decisions,
not gaps.

### Server-side LLM calls

ledric makes no outbound calls to any LLM provider. No
auto-alt-text, no NL→query translation inside the server, no AI
translation, no embedding-on-write. Embedding is BYO — the
client writes the vector — and everything else that wants AI
involvement happens in the agent that's *talking* to ledric, not
inside ledric itself.

This boundary is intentional. It keeps ledric runnable on a
laptop with no API keys, makes the security/privacy story
straightforward (your content does not leave your machine
unless you send it somewhere), and avoids the "but which model"
political problem of building an LLM integration into the
server.

### Real-time collaborative editing

No multiplayer cursors, no operational-transform document
sync. The inline editor is a single-user click-to-edit drawer.
Sanity Studio is genuinely good at multiplayer; if that's a
hard requirement, that's the tool.

### Portable Text

Sanity's block-array rich-text format. Markdown plus
`:::ref{}:::` directives covers the same ground with a more
LLM-legible wire format and ledric leans on that. There is no
plan to add Portable Text as a parallel field type.

### Editor UI as a product

The admin GUI exists; it isn't a separately-marketed product
or a separately-themable surface. The expectation is that
serious editorial UX lives on the consumer site, where the
inline editor turns any rendered page into an editing surface.

### Per-entry branching

Full-environment branching is on the post-v1 list. Per-entry
branching ("this one entry has a separate experimental branch
nobody else can see") isn't planned. The version history per
entry covers most of the same use cases more simply.

### Hosted ledric

Self-hosted only by design. If demand drives someone to offer
managed hosting on top of the open-source core, that's fine
(Apache-2.0 permits it), but it's not on any roadmap.

---

## How decisions get made

Roughly:

1. **Spec drift is reconciled toward the code.** When the
   [original spec](./internal/original-spec.md) and the
   shipping behaviour diverge, the docs reflect what ships. The
   spec is preserved as a record of intent, not a
   forward-looking promise.
2. **GitHub issues and Discussions are the input channel.**
   "I tried X and it broke" issues get fixed faster than design
   debates, but design debates are read.
3. **No private roadmap meetings.** If something's coming, it's
   either listed above or being discussed in the open.

If you want to influence what lands first: file the issue with
the most concrete reproducer or use case. Concrete beats abstract
every time.

---

## Where to go next

- [Concepts](./concepts.md) — what's in the model today.
- [FAQ](./faq.md) — the questions this page sets up.
- [Why ledric](./why.md) — the comparative argument and "when
  ledric is the wrong choice".
- [Original spec](./internal/original-spec.md) — what was
  intended; useful as historical context.
