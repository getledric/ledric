# FAQ

The questions that come up most. Three to six sentences each, with a
link to the deeper doc when there is one.

- [Status & maturity](#status--maturity)
- [Storage & scaling](#storage--scaling)
- [Architecture](#architecture)
- [Comparisons](#comparisons)
- [Editor UX](#editor-ux)
- [Hosting & deployment](#hosting--deployment)
- [The agent / MCP angle](#the-agent--mcp-angle)
- [Migrating in](#migrating-in)
- [Backups & operations](#backups--operations)

---

## Status & maturity

### Is this production-ready?

Not yet. ledric is alpha. The core works end-to-end (schema, entries,
assets, versions, MCP, HTTP, admin GUI, inline editor), and there's a
unit-test suite of around 360 tests plus a Playwright smoke suite,
but it has not been run in production by anyone other than the
author. Expect shape changes before v1. If you try it on something
real, please open an issue when something breaks.

### What's "alpha" actually mean here?

Specifically: APIs may change, error codes may rename, the storage
schema may add columns (with migrations, but still). The features
listed in the README under "What you get" are real and tested; the
items under "What's planned" are not. See
[`roadmap.md`](./roadmap.md).

### Why was so much of this written by AI?

Because the author is one person and AI is in fact good at typing.
The design decisions are human; the keystrokes are mostly not. The
practical consequence is that the surface area is bigger than one
human could reasonably have hand-written in the time available, and
the test suite is the safety net. If you find a bug that smells like
"the model didn't understand the spec here", that's probably
exactly what happened — please file it.

---

## Storage & scaling

### Why SQLite by default?

Because most content sites are smaller than people think, and
SQLite is the lowest-friction way to ship a CMS. One file. No
separate database process to manage. `cp ledric.db backup.db` is a
backup. `scp` is a deploy. Nothing to install on a fresh VM
beyond Node. You can graduate to Postgres or MySQL when SQLite
genuinely runs out of room — the storage layer is portable.

### Can SQLite handle real traffic?

Read-heavy workloads, yes — comfortably. SQLite at WAL mode
handles thousands of concurrent reads on a single machine. The
sharp limit is *concurrent writes*: SQLite serialises writes
through a single writer. For a CMS that's almost never a
problem (humans and agents don't write content at machine
speeds). Read-heavy traffic in front of `/assets/<ref_key>` is
also normally CDN-cached, which moves the busiest URLs out of
ledric's hot path entirely. If you're writing thousands of
entries per second, you want Postgres.

### When should I switch to Postgres or MySQL?

Switch when you have a concrete reason: multiple writer processes,
read replicas, a managed-database operational story you already
trust, or vector / FTS workloads that benefit from
production-grade engines. Don't switch because someone said
"SQLite isn't a real database" — that hasn't been true for a
decade. See
[`deployment.md`'s Postgres / MySQL section](./deployment.md#postgres--mysql-deploys).

### How big can my content get on SQLite?

The practical ceiling is "as much as fits comfortably on the
disk and the page cache". A few GB of structured content
(thousands of entries) is well inside the comfort zone. Asset
*bytes* in the DB grow faster than entry rows do; if you're
storing many large originals, switching to the local
filesystem backend (or an external bucket once those land —
see [`roadmap.md`](./roadmap.md)) is a more meaningful
optimisation than switching engines.

---

## Architecture

### Is there a plugin system?

No. The core is fixed: storage adapters, schema engine, MCP, HTTP,
admin GUI, asset pipeline. Customisation lives in the layer above
ledric — your consumer site, an `@ledric/proxy` mounted in front,
or your own scripts hitting the HTTP API. If you find yourself
reaching for a plugin hook, please file an issue describing the
shape; that's useful information for the v1 design.

### What's `@ledric/proxy`?

A server-side primitive for any Node-compatible framework
(Astro, Next.js, Express, Hono, etc.). It mounts at a path on
your consumer site, holds the admin API key server-side, and
forwards a curated subset of ledric's HTTP surface to the
browser. Use it when the inline editor needs admin reach
(versioned reads, asset uploads) but you don't want to leak the
admin key into client code.

### Why is the consumer site a separate process?

Because the consumer doesn't need ledric's dependencies.
`better-sqlite3` and `sharp` (libvips) are ~50MB of native
binaries each, and they don't belong in your Vercel build for a
site that's only doing reads. The two-process shape also means
ledric scales independently — your CMS box and your render
boxes are different concerns. See the architecture section in
[`build-with-an-agent.md`](./build-with-an-agent.md#architecture-ledric-and-your-consumer-site-are-separate-processes).

### Can I run ledric and the consumer site in the same process for local dev?

You can colocate them in two terminals (or one `concurrently`
script) — that's the recommended local setup. You shouldn't
import the `ledric` package into your consumer site's runtime
code; the SDK (`@ledric/sdk`) is what consumer code should use.

---

## Comparisons

### How does it compare to Payload? Sanity? Directus? Strapi?

Long answer in [`why.md`](./why.md). The short version:

- **Payload**: ledric is process-separated and framework-agnostic; Payload is Next.js-embedded.
- **Sanity**: ledric is self-hosted single-file SQLite with markdown content; Sanity is hosted-first with Portable Text.
- **Directus**: ledric owns its schema; Directus reads schema from your existing database.
- **Strapi**: ledric has no plugin ecosystem and no admin-clicking schema builder; Strapi has both.

Across all four, ledric leans harder on MCP-as-primary-interface,
markdown-as-rich-content, and flat-token-cheap-responses than the
others.

---

## Editor UX

### Does the admin GUI work without an MCP client?

Yes. The admin GUI is a regular SPA; load `http://localhost:3000/admin`
in any browser, paste the admin key, and you can author content
without ever touching MCP. MCP is a *second* interface, not a
prerequisite.

### Can a non-technical user use it without an LLM in the loop?

Mostly yes, with caveats. Schema authoring (creating types, adding
fields) requires either chat-with-an-agent or someone writing
`defineType()` — there's no Content-Type Builder UI like Strapi's.
Once types exist, day-to-day content authoring (writing entries,
uploading assets, publishing, tagging) is fully covered by the
admin GUI and the inline editor with no LLM involvement. The
intended division of labour is "developer or agent sets up the
schema; editor lives in the admin and inline editor".

### What does the inline editor actually do?

You drop one `<script>` tag on your rendered consumer site. It
walks the DOM looking for `data-ledric-ref` and
`data-ledric-field` attributes (the SDKs' `refAttrs()` helper
emits these). When you hover an editable element, a pencil icon
appears; click it, and a drawer slides in with the right form
field already focused. Save → publish → the page reloads with
new content. Full walkthrough in
[`inline-editor.md`](./inline-editor.md).

### Can I customise the admin GUI?

Not at runtime — there's no theming or plugin system. You can
fork it (it's React + Vite) but that's a real maintenance cost.
The current direction is to keep the admin minimal and let
non-trivial editorial UX live in your own consumer site, where
the inline editor turns any rendered page into an editing
surface.

---

## Hosting & deployment

### Is there a hosted version planned?

Not actively. The project is self-host-first by design and a
hosted product would be a meaningful change in scope. If demand is
high enough that someone offers managed hosting on top of the
open-source core, that's fine — and the Apache-2.0 license
permits it — but it's not on any roadmap right now.

### Can I run it serverless / on Vercel?

No, not directly. ledric uses `better-sqlite3` and `sharp` (both
native modules) and runs as a long-lived process. Serverless
runtimes (Vercel Functions, Cloudflare Workers, AWS Lambda) won't
cleanly run that. The right shape is "long-running container
or VM, behind a CDN that caches `/assets/<ref_key>`". Your
*consumer site* can absolutely deploy to Vercel — it just calls
ledric over HTTP. See [`deployment.md`](./deployment.md).

### Can I put a CDN in front of ledric?

You should. `/assets/<ref_key>` URLs are version-pinned, so
they're long-lived-cacheable; the rest of the API is dynamic and
should bypass the CDN cache. Sample CDN config notes are in
[`deployment.md`](./deployment.md#asset-serving-via-a-cdn).

### How do I run it behind TLS?

Reverse proxy (Caddy, nginx, Traefik) doing TLS termination.
ledric speaks plain HTTP and isn't trying to manage certs
itself. See [`deployment.md`'s reverse-proxy
section](./deployment.md#reverse-proxy--tls).

---

## The agent / MCP angle

### What happens if MCP changes / Anthropic deprecates it?

MCP is an open protocol with multiple implementations, not a
proprietary Anthropic API. Even if Anthropic walked away from it
tomorrow, the spec is published and the surface ledric exposes
would still be reachable from any MCP-speaking client. More
practically: every MCP tool ledric exposes is *also* reachable
via plain HTTP at `POST /rpc`. If MCP died entirely, the same
tool surface would still work over JSON-RPC-over-HTTP without
any code changes on ledric's side. Loss-of-MCP would be
unfortunate but not existential.

### Do I have to use Claude?

No. MCP is the protocol; Claude is one client. Cursor speaks
MCP. Other agents are adding support. If you don't want any
agent at all, the HTTP API and the admin GUI cover the entire
surface — MCP is opt-in.

### Does ledric send my content to Anthropic?

No. ledric makes no outbound calls to any LLM provider. The
agent runs in your environment (Claude Desktop, Claude Code,
your own MCP client) and *that* client may send content to
whichever LLM it's configured to use. ledric is purely a server;
it serves whatever client knocks on its door.

### Why are responses so flat compared to Contentful's?

Because tokens cost money and context windows are finite. Every
extra envelope key on every entry on every list response gets
multiplied across every prompt the agent runs. The Contentful
shape is fine for a renderer; it's expensive for an LLM. ledric
opts the cost-saving way by default.

---

## Migrating in

### How do I import from Contentful / Sanity / WordPress?

There's no first-class importer in v1. The pattern that works
today: write a small script (Python, Node, whatever you like)
that reads from the source CMS's API, calls ledric's `create_type`
to set up the schema, then loops through entries calling
`draft` and `publish`. The scripts tend to be ~100-200 lines for a
typical content set. Once the shape stabilises, first-class
importers (Contentful first) are on the post-v1 roadmap.

### Can I export my content out again?

Yes. `GET /entries/<type>` and `GET /entries/<type>/<slug>`
return JSON-everything. A small loop dumps your content to disk.
The MCP `find` tool returns the same shape. There's no
proprietary export format to lock you in — the wire format *is*
the export format.

---

## Backups & operations

### How do I back up my data?

If you're on the default SQLite + in-DB-assets backend, your
content is one file (`ledric.db`). Copy it. `cp`, `rsync`, `scp`,
Restic, your-favorite-backup-tool — any of them work. Use SQLite's
`.backup` command (or run a snapshot from a brief read lock) for
a consistent copy under load. If you've moved assets to the
on-disk backend, back up the assets directory alongside the DB.
See [`deployment.md`'s backup section](./deployment.md#backups).

### What about Postgres / MySQL?

Standard database backups: `pg_dump` for Postgres, `mysqldump` for
MySQL. Schedule it, store it somewhere with separate access
control from the running database. Same as you'd do for any other
service.

### Where do I file bugs / get support?

GitHub issues at <https://github.com/getledric/ledric/issues>.
There's no paid support tier and no SLA — it's an alpha project.
Reproducible bug reports get fixed faster than vague ones.

### Is there a community?

Small. GitHub Discussions, when enabled, is the place to ask
"is this the right shape?" questions. For "I think this is a
bug" — open an issue.
