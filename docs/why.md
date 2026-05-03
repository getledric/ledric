# Why ledric

There are already plenty of headless CMSes. This page is the honest
case for ledric being a different shape, plus the equally honest case
for when it isn't the right tool.

The TL;DR: most CMSes were designed for a person clicking around in a
web app, with the API as a side effect. ledric is designed for an
agent driving the API, with a person's admin GUI as a side effect.
Most of the differences below trace back to that.

- [The shape of the bet](#the-shape-of-the-bet)
- [vs Contentful](#vs-contentful)
- [vs Sanity](#vs-sanity)
- [vs Payload](#vs-payload)
- [vs Strapi](#vs-strapi)
- [vs Directus](#vs-directus)
- [When ledric is the wrong choice](#when-ledric-is-the-wrong-choice)

---

## The shape of the bet

Three constraints ledric doesn't break:

1. **Tokens are the new bandwidth.** Every default — response shape,
   list budgets, schema serialisation — is tuned for minimal
   agent-side overhead.
2. **Agents edit differently than humans.** They batch. They diff.
   They need optimistic concurrency, structured errors, and
   dry-runs. The tool surface is shaped for both.
3. **The schema is the API.** `describe_model` returns the entire
   content model in a single call. There is no second source of
   truth for an agent to keep in sync.

Everything else in this project is a downstream consequence.

---

## vs Contentful

Contentful is the archetype of "headless CMS that predates
agent-driven workflows". Solid for what it was designed for. Painful
when you put an LLM in front of it.

| Contentful pain | ledric fix |
|---|---|
| Every node wrapped in `{ sys, fields, metadata }`. A "give me 20 posts" call is half envelope. | Flat entries. `_meta` only when explicitly requested with `include_meta: true`. |
| Rich text is a proprietary JSON tree (Contentful's "Rich Text format"). One SDK can render it. LLMs can't read or write it usefully. | `markdown` field type. The wire format is the string. Diff it in git, paste it in Slack, render it with anything. |
| Fields are always wrapped in a per-locale envelope (`{ "en-US": "value" }`), even for unlocalized content. | Default locale lives at the top level. `_locale` sidecar only when the type opts in. |
| GraphQL surface encourages nested queries → N+1 reads, token bloat. | Flat reads with `expandAssets` and `resolveRefs` opt-ins. You ask for what you want, you get only that. |
| Content model changes are made in the web UI; "migrations as code" is a bolted-on contrib library. | Schema-as-code via `defineType()`, or `create_type`/`alter_type` over MCP. Same canonical row either way. |
| Environments take seconds to spin up; merging is manual. | Single environment in v1; copy-on-write branching is on the roadmap. (Honest gap, not a strength.) |
| MCP support is an afterthought (community projects, not first-party). | MCP is the primary interface. Twenty tools, designed against the data model. |
| Self-hosting requires a paid enterprise plan. | Self-hosting is the only deployment model. |

The Contentful comparison is the most lopsided of the bunch — they're
solving for a different shape of customer, and there's no overlap on
"agent-first design".

When Contentful is still the right choice: large editorial teams that
need fine-grained role-based access today, multi-region SOC2-attested
hosting, an editor experience that's been polished for a decade, or
integrations with adjacent SaaS that ledric doesn't have (and won't
soon).

---

## vs Sanity

Sanity is the closest thing to a "developer-first" CMS that
predates LLM tooling. Schema-as-code (TypeScript), real-time
collaborative editing in Sanity Studio, Portable Text for rich
content, hosted by default with an optional self-host path.

What ledric does differently:

- **Markdown, not Portable Text.** Portable Text is a
  block-array JSON format. It's well-defined, and it's what
  Sanity has always recommended. It's also poorly suited to an
  LLM editing a document — every paragraph is a JSON object, every
  inline mark is a span object. ledric uses markdown strings with
  `:::ref{…}:::` directives for cross-content embedding. The
  diffing, copy-pasting, and prompt-shaping ergonomics are
  qualitatively different.
- **Local SQLite by default.** Sanity is hosted-first; you store
  content in their cloud (or self-host the dataset, but the studio
  expects to talk to the hosted service). ledric is single-process,
  one file, runs on a laptop or a $5 VPS. Postgres / MySQL when you
  outgrow that.
- **MCP as the primary interface.** Sanity has a community MCP
  server; ledric's tool surface was designed against the data
  model from day one.
- **No real-time collaborative editing.** Sanity Studio's
  multiplayer cursor experience is genuinely good. ledric doesn't
  have it. The inline editor is a single-user click-to-edit
  drawer.

When Sanity is still the right choice: a team that's already been
using Sanity Studio happily, real-time collaborative editing as a
hard requirement, a content workflow that maps cleanly onto Portable
Text, willingness to pay for the hosted product.

---

## vs Payload

Payload (now Payload 3.0) is "developer-first CMS as a Next.js
plugin". You install it into your Next app, it provides an admin
panel and a database layer, you ship one process.

What ledric does differently:

- **Separate process by design.** ledric runs in its own directory,
  exposing HTTP. Your consumer site is a different project that
  fetches over the network — same shape whether the consumer is
  Next.js, Astro, plain PHP, or a static-site builder. Your ledric
  process doesn't drag `sharp` and `better-sqlite3` (~50MB native
  binaries) into every consumer build.
- **MCP-first.** Payload has REST + GraphQL + a Local API for
  same-process callers. ledric has MCP + a flat HTTP `POST /rpc`
  that mirrors the MCP surface. An agent gets the same tool
  catalogue regardless of transport.
- **No framework lock-in.** Payload is heavily integrated with
  Next.js — that's the value proposition for some teams and a
  blocker for others. ledric doesn't care what your renderer
  uses.
- **Code-first schema, not config-driven.** Payload's schema is
  a config object you pass to `payload.init()`; ledric's is a
  `defineType()` call that emits canonical JSON, callable from
  TypeScript or chat (via `create_type`). The end state is the
  same row in the DB.

When Payload is still the right choice: you want a CMS embedded in
your Next.js app, you want fine-grained access control out of the
box, you want a more polished admin UI, and you're happy living
inside the Next ecosystem.

---

## vs Strapi

Strapi is the longest-running open-source headless CMS. Big plugin
ecosystem, optional self-host, a Node + database stack.

What ledric does differently:

- **No plugin system (yet).** Strapi's plugin architecture is its
  selling point and its accumulated complexity. ledric ships a
  fixed core: storage adapters, the asset pipeline, the schema
  engine, MCP, the admin GUI. If you want to customise behaviour,
  you write a thin layer on top — there's no extension API to
  learn.
- **Schema-as-code, not admin-clicking.** Strapi's primary schema
  authoring is the Content-Type Builder (a UI). ledric's primary
  authoring is `defineType()` or chat. Both produce the same
  canonical row.
- **Single-file SQLite default.** Strapi can run on SQLite; the
  documentation pushes you toward Postgres + a separate hosting
  setup for anything serious. ledric makes the SQLite-file path
  the default and stays there.
- **MCP-first.** Strapi has a community MCP plugin. ledric's tool
  surface is the primary interface.
- **Token-cheap responses.** Strapi's REST responses include
  Strapi's own envelope (`{ data, meta, attributes: {...} }`).
  ledric's are flat.

When Strapi is still the right choice: you want a vast plugin
catalogue, you want an admin UI that's been iterated on for years,
you want roles + permissions out of the box, and the agent-first
design is a non-goal.

---

## vs Directus

Directus is "an instant API on top of any SQL database". Point it at
your existing Postgres, get REST and GraphQL.

What ledric does differently:

- **ledric owns its schema.** Directus reads schema from your
  database. ledric writes schema *to* its database, validated and
  versioned by the type system. The two products are solving
  different problems — Directus says "I'll API-ify what you've
  already got"; ledric says "let me model your content".
- **Schema versioning and migration tooling.** Every entry is
  written under a known schema version; `alter_type` classifies
  changes; `migrate_entries` re-validates and backfills. Directus
  doesn't really have an equivalent — schema changes are SQL
  migrations on your database.
- **MCP-first.** Directus has community MCP work; ledric is
  primary.
- **Flat wire format.** Directus's responses include relational
  metadata Directus needs, which an agent has to parse around.

When Directus is still the right choice: you have an existing SQL
database that's already shaped the way you want, you want generic
data tooling more than a CMS, or your team is more comfortable
with SQL than with code-first schemas.

---

## When ledric is the wrong choice

This is the section that makes the rest of the page credible.
ledric is alpha and opinionated. It's not the right pick for
several real situations.

### You need fine-grained role-based access today

ledric ships two roles: admin (writes) and reader (reads).
Per-type, per-field, per-environment grants are not implemented.
If your content workflow needs "writers can edit drafts but only
editors can publish, and only certain editors can touch the
homepage", ledric isn't there yet — and probably won't be for a
while. Contentful, Sanity, and Strapi all do this better today.

### You need real-time collaborative editing

Two people simultaneously editing the same blog post with cursors
and presence indicators? That's not in scope. Sanity Studio is
genuinely good at this; if it matters to your team, that's the
tool.

### You need SOC2-attested managed hosting

ledric is self-hosted, alpha-grade, and has had no audit. If
you're shipping to a regulated environment that requires
attestation today, the conversation is over before it starts. A
hosted offering is on the very speculative future roadmap; right
now there isn't one.

### You need a polished editor UX out of the box

The admin GUI works. It's deliberately functional, not delightful.
Field forms render from the schema, the entry list is a table, the
asset library is a grid. If your editorial team expects the
inline-rich-text-with-AI-helpers experience that's now table
stakes in commercial CMSes, ledric will feel sparse.

The inline-on-page editor is genuinely differentiated and worth
trying — but it's a single-user, click-to-edit drawer, not a
collaborative writing surface.

### You need a serverless / edge deployment

ledric runs as a long-lived Node process. It uses
`better-sqlite3` and `sharp` (libvips), both of which are
native modules incompatible with most serverless runtimes
(Vercel Functions, Cloudflare Workers, etc.). The right shape is
"long-running container or VM behind a CDN" — see
[`deployment.md`](./deployment.md). If "no servers" is a hard
requirement, this isn't the tool.

### You need to point a CMS at an existing database

ledric writes its own tables (`types`, `entries`, `entry_versions`,
`assets`, etc.) into the database you give it. It doesn't read or
expose tables you've already created — that's Directus's job, not
ledric's.

### You need a plugin / extension ecosystem

ledric has neither. The fixed core is intentional. If your stack
depends on a CMS that has plugins for your specific CRM, your
specific newsletter, your specific commerce platform, ledric will
not have any of those — and the work to add them is on you.

### You need vector / semantic search today

The `vector` field type is wired through the schema and validator,
but there's no similarity-search query path yet. Don't ship a
production search-by-meaning feature on top of it.

### You need stability

It's alpha. Shapes will shift before v1. AI did most of the
typing. If "the API contract has been frozen for two years and
won't move" is a value to you, this isn't it yet.

---

## Where to go next

- [Concepts](./concepts.md) — the mental model behind everything above.
- [Build a site with an agent](./build-with-an-agent.md) — what
  ledric feels like end-to-end.
- [Roadmap](./roadmap.md) — what's stable, what's in progress, what's
  out of scope.
- [FAQ](./faq.md) — the more specific questions this page sets up.
