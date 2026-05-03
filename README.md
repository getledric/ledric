# ledric

**A CMS that speaks AI.**

[![ledric on npm](https://img.shields.io/npm/v/ledric?label=ledric&color=cb3837)](https://www.npmjs.com/package/ledric)
[![@ledric/sdk on npm](https://img.shields.io/npm/v/%40ledric%2Fsdk?label=%40ledric%2Fsdk&color=cb3837)](https://www.npmjs.com/package/@ledric/sdk)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org/)
[![Status: alpha](https://img.shields.io/badge/status-alpha-orange)](#status)

A small, self-hosted content engine built from the ground up for the age of agents. It runs from one binary, stores everything in one file, and ships with a proper MCP interface so Claude (or anything else that speaks the Model Context Protocol) can read, write, and evolve your content model — with the same validation, history, and safety rails you'd get from a clicky admin panel.

## The pitch

You've got content. You've got AI tools. In a sane world they'd just talk to each other. In the current world, your CMS wraps every entry in six layers of metadata, your rich text is a proprietary JSON tree only one SDK can render, and every time Claude tries to help it burns half its context just parsing the response.

ledric sits in the middle and gets out of the way.

Concretely: ledric is a Node 22+ process you run in a content directory. It exposes an MCP server over stdio for desktop clients (Claude Desktop, Cursor, Claude Code), an HTTP API that includes the same tool surface at `POST /rpc`, and an admin SPA at `/admin`. Content lives in a single `ledric.db` file (SQLite by default; Postgres and MySQL also supported). Your consumer site is a separate process that fetches over HTTP via `@ledric/sdk` (TypeScript) or `ledric/sdk` (Composer/PHP).

## Contents

- [Quickstart](#two-minutes-to-running)
- [What you get](#what-you-get)
- [MCP tools](#the-20-mcp-tools)
- [How I actually use it](#how-i-actually-use-it)
- [Docs](#docs)
- [Build from source](#from-source)
- [Status](#status)

## Two minutes to running

Needs Node 22+. That's it.

```bash
# Interactive: walks you through DB path, port, MCP client wiring, key minting.
npx -y ledric init

# Or skip the prompts — same flow, all defaults:
npx -y ledric init --yes
```

`init` writes a `ledric.config.json`, patches your project's `.mcp.json` so Claude Code picks up the server automatically, mints admin + reader API keys, drops them into `.env.local`, and adds the usual entries to `.gitignore`. After that:

```bash
npx ledric serve                # MCP stdio only — perfect for Claude Desktop
npx ledric serve --gui          # also: HTTP API + admin GUI at http://127.0.0.1:3000/admin
```

A `./ledric.db` file just appeared next to you. The admin GUI is at `http://127.0.0.1:3000/admin` — paste the admin key from `.env.local` to get in. Same key works for the inline editor on any consumer site that loads `/admin/inline.js`.

### Wire it into your MCP client

| Client | How |
|---|---|
| **Claude Code** | `init` already patched `.mcp.json` for you, or do it yourself: `claude mcp add ledric -- npx -y ledric serve` |
| **Claude Desktop** | Run `init` and answer "yes" to the global prompt — it patches `~/Library/Application Support/Claude/claude_desktop_config.json`. Or paste the JSON below into that file by hand. |
| **Cursor** | Cursor reads the same `.mcp.json` Claude Code does — `init` already wired it. |

Manual Claude Desktop config:

```json
{
  "mcpServers": {
    "ledric": {
      "command": "npx",
      "args": ["-y", "ledric", "serve", "--gui"],
      "cwd": "/absolute/path/to/your/content/dir"
    }
  }
}
```

`cwd` matters — `ledric.db` lives in the working directory.

Restart your MCP client. In Claude, ask: *"Call `describe_model`, then set up a blog with posts and authors."* Watch it call `create_type` twice, then ask it to draft and publish a post. That's the entire onboarding path — there is no separate admin tutorial to read.

### See your content from the outside

```bash
npx ledric ls                              # what types do I have?
npx ledric ls blog_post                    # what posts?
npx ledric get blog_post/hello-world       # one post, in the shape a website would render
npx ledric asset upload hero.jpg           # store an image
```

## What you get

### For agents

A first-class surface so an LLM can do real work without burning context.

- **`describe_model`** returns the entire content model — every type's fields, summary fields, hand-written example, plus the runtime capabilities of this instance — in one call. No separate docs to keep in sync.
- **Structured errors.** Validation failures come back as machine-parseable objects with field paths and codes, not prose strings the model has to re-parse.
- **Token-cheap responses.** Lists come in three budgets (full, summary, list); responses are flat, not wrapped in `sys`/`fields`/`metadata` envelopes.
- **Draft → publish primitives.** `draft`, `publish`, `rename_entry`, `delete_entry` — all with `parent_version` optimistic concurrency so an agent can't silently clobber a concurrent edit.
- **Version history is readable over MCP.** Every save writes a new version; pass `version: N` to `read` to fetch any historical version.

### For humans

Two places to edit, both built in.

- **Admin GUI** at `/admin` — types list, entry forms, asset library, keys management. Paste the admin key once, you're in.
- **Inline editor.** Drop one `<script>` tag on your rendered site and a floating pencil appears next to anything you tag with `data-ledric-ref`. Click → drawer slides in with the right form → save → page reloads with the new content.
- **Schema by chat.** "I want a blog with posts, authors, and tags" — Claude writes the canonical types and calls `create_type`. Coders who still code get `defineType()` from `@ledric/schema` for the autocomplete vibes — same canonical output, same row in the DB.
- **Drafts don't leak.** Publishing is a pointer move — instant. Unpublishing is the same move in reverse.

### For ops

Boring on purpose.

- **One file by default.** Your content lives in a SQLite file you can commit, scp, or `cp` like any other file. Postgres and MySQL are first-class options when you outgrow that.
- **Slug-history redirects.** Rename a post and the old URL keeps resolving forever. Every retired slug is remembered; reads of the old slug return the entry with `_redirect` pointing at the new one.
- **Imgix-compatible image transforms, no SaaS bill.** Asset URLs accept the usual `w`, `h`, `fit` (`clip`/`crop`), `q`, `fm` (`jpg`/`png`/`webp`/`avif`), `auto=format`, `dpr` — `sharp` (libvips) does the work, transformed bytes are cached on disk. URLs are version-pinned, so browser and CDN caches stay correct even when you replace the source image in place. Example: `/assets/<ref_key>?w=800&fit=crop&auto=format`.
- **Localization.** Per-type locales, `localized: true` fields, fallback chains, locale-specific slugs — all under the same versioning, publish, and history flow as the original.
- **Auth without ceremony.** `ledric init` mints an admin key and a reader key on the way through; if you skip init, the first HTTP boot does it instead. By default writes need the admin key; reads stay open. Flip `--require-reader-key` for closed-reads mode. Rotate with `ledric keys create --role admin --raw | pbcopy` and revoke the old one.
- **Asset bytes go in the DB or on disk** — your call. (External-bucket adapters for S3 / R2 are on the roadmap.)

### For your codebase

The shapes you'll actually import.

- **`@ledric/sdk`** (TypeScript) — read client, inline-editor `refAttrs()` helpers, types generated from your schema.
- **`Ledric\LedricClient`** (PHP, Composer package `ledric/sdk`) — read client, same wire format.
- **`ledric` CLI** — `init`, `serve`, `ls`, `get`, `asset upload`, `keys create`, etc.
- **HTTP `POST /rpc`** — every MCP tool exposed as plain JSON over HTTP for non-MCP callers, with the same auth split (reader vs admin) as the MCP server.
- **Markdown rich text with embedding magic.** Rich-text fields are Markdown strings — diff them in git, paste them into Slack, open them in any editor. Embed a section, asset, or another entry inline with `:::ref{to="section/hero"}:::` and ledric resolves it on read.

## The 20 MCP tools

| Reads | Writes | Schema | Assets | Tags |
|---|---|---|---|---|
| `describe_model` `read` `find` | `draft` `publish` `rename_entry` `delete_entry` `migrate_entries` | `create_type` `alter_type` `delete_type` | `get_asset` `list_assets` `update_asset` | `list_tags` `update_tag` `add_entry_tags` `remove_entry_tags` `add_asset_tags` `remove_asset_tags` |

Asset *uploads* and bytes-fetching are HTTP-only by design — `POST /assets` (multipart) and `GET /assets/<ref_key>` — they don't go through MCP.

Full reference: [`docs/mcp-tools.md`](docs/mcp-tools.md).

## How I actually use it

This is a personal project first. After 25 years of building bespoke content management systems for clients (pre-headless CMS days) and working with the major players since, and being annoyed by most of them, ledric is my attempt at the one I'd actually want to use.

Most pages I build aren't just "title, body, hero image." They're collections of sections — a hero with desktop and mobile backgrounds, a pricing table that gets reused on three pages, a testimonials block, a CTA, a feature grid — sometimes with prose flowing around them, sometimes entirely composed of them.

The shape of the work I kept doing on every project:

1. Design and copy land in Figma.
2. I shuttle assets and content to the CMS, structure it as best as the CMS lets me.
3. I build a rendering / template engine on top of the headless CMS that turns those content rows back into pages — section ordering, asset variants per breakpoint, linked blocks, fallbacks for missing fields, the cache layer, the lot.
4. The rendering engine becomes the actual CMS, with its own template-module system. The "real" CMS is just a poorly-shaped ORM underneath. Non-technical maintainers can't touch any of it.

I've built that pile too many times. ledric is what the data layer wants to look like *before* the rendering engine grows tentacles: sections are first-class entries you can compose into a page (top-level via `references`, inline via `:::ref{to="section/hero"}:::` in any markdown field), assets are version-pinned with imgix-style transforms baked in, and the inline editor lets a non-technical maintainer change what they see without owning the rendering pipeline.

A typical session against the MCP server now looks like:

1. *"Go through this page design in Figma and prepare all required asset exports."*
2. *"Import all assets into ledric, tagging them appropriately."*
3. *"Build out the required sections, and roll them into a page."*

Without ledric in the loop, Claude could write static HTML and call it a day. ledric exists because I want my marketing team to roll out updates without me — and I want them to be able to wire up their own LLM tools to the same content store.

## The design philosophy

Three constraints we don't break:

1. **Tokens are the new bandwidth.** Every default is tuned for minimal agent-side overhead.
2. **Agents edit differently than humans.** They batch, they diff, they need dry-runs and structured errors. The API is shaped for both.
3. **The schema is the API.** `describe_model` tells an LLM everything it needs in one call. No separate docs to keep in sync.

Everything else in this project is a consequence of those three.

## Docs

Pages are short, scoped, and self-contained — pick the one that matches what you're trying to do.

| | |
|---|---|
| **[Concepts](./docs/concepts.md)** | The mental model in one page: types, entries, ids vs slugs vs refs, versions, structural vs inline references, assets, locales, environments, the wire format. Read this first. |
| **[Build with an agent](./docs/build-with-an-agent.md)** | End-to-end walkthrough: ask Claude to set up the schema, seed content, build an Astro site that renders it, wire up inline editing. Anchored to the committed `examples/astro-blog/` artifact. |
| **[Build with an agent — PHP](./docs/build-with-an-agent-php.md)** | Same walkthrough, vanilla PHP consumer using `Ledric\LedricClient`. |
| **[Schema](./docs/schema.md)** | Field types catalogue, `defineType()` examples, common + type-level options, validation, schema evolution. |
| **[Agent recipes](./docs/agent-recipes.md)** | Example prompts you can paste into Claude: project setup, drafting, schema evolution, bulk ops, refactoring, localization. |
| **[MCP tools](./docs/mcp-tools.md)** | The full 20-tool surface — args, returns, examples. Same surface as `POST /rpc` over HTTP. |
| **[HTTP API](./docs/http-api.md)** | REST routes for reads, multipart upload, generic `POST /rpc`, image transforms, slug redirects, error codes. |
| **[Remote MCP](./docs/remote-mcp.md)** | Two modes: local (`--http-mcp`, share one daemon across local clients) and public (`--public-mcp`, OAuth provider for claude.ai custom connectors). |
| **[SDKs](./docs/sdks.md)** | `@ledric/sdk` (TypeScript) and `Ledric\LedricClient` (PHP) — methods, options, errors, inline-editor `refAttrs()`. |
| **[Inline editor](./docs/inline-editor.md)** | `<script>` install, `data-ledric-ref` / `data-ledric-field` attributes, `refAttrs()` helpers in both SDKs, auth, behaviour. |
| **[Assets](./docs/assets.md)** | The id / ref_key split, db vs local backends, uploads, image transforms, in-place bytes replacement, the transforms cache. |
| **[Localization](./docs/localization.md)** | Per-type locales, `localized: true` fields, the `_locale` sidecar, fallback chains, locale-specific slugs, recipes. |
| **[Auth](./docs/auth.md)** | Roles, key minting via `init` / first boot, header formats, closed-reads mode, listing / creating / revoking, rotation, env-var override. |
| **[Architecture](./docs/architecture.md)** | What's running when ledric boots: the packages, the storage adapters, the asset pipeline, the inline editor, process lifecycle. |
| **[Deployment](./docs/deployment.md)** | Production shape: CDN in front of `/assets/<ref_key>`, reverse proxy + TLS, env-supplied API keys, backups, Postgres / MySQL deploys, what to handle outside of ledric. |
| **[Why ledric](./docs/why.md)** | Honest comparison vs Contentful, Sanity, Payload, Strapi, Directus — and when ledric is the wrong choice. |
| **[FAQ](./docs/faq.md)** | The questions that come up most: production-readiness, SQLite limits, hosting, the agent angle, migration. |
| **[Roadmap](./docs/roadmap.md)** | What's stable, in progress, planned, and explicitly out of scope. |

## From source

```bash
git clone https://github.com/getledric/ledric
cd ledric
corepack enable                  # one time, ever — wires up pnpm
pnpm install
pnpm build
pnpm cli serve --gui             # same as `npx ledric serve --gui`, but against your dev tree
```

`pnpm dev` watches and rebuilds. `pnpm test` runs the unit suite (vitest, ~360 tests sqlite-only; an extra ~18 Postgres + ~18 MySQL tests opt-in via `LEDRIC_TEST_POSTGRES_URL` / `LEDRIC_TEST_MYSQL_URL` env vars). `pnpm e2e` runs the Playwright smoke suite against a freshly-booted CLI (admin GUI flows — needs `pnpm exec playwright install chromium` once); use `pnpm e2e:ui` for the interactive runner.

## Status

Alpha. The core works end-to-end, shapes will shift before v1. AI did most of the typing and it's in no way production-tested yet. If you try it and something breaks, open an issue — I'll see it.

A few things to be upfront about:

- It's probably confusing in places.
- It definitely has gaps.
- Does AI make headless CMSes redundant? Maybe. I'm shipping this anyway.
- It was clearly coded quickly using AI. That's exactly what has happened here. It's in no way production-tested.

If you want a battle-tested CMS, this isn't it yet. If you like the shape of the bet — that the schema is the API, that agents deserve a real interface, that one SQLite file is enough — give it a try and tell me what's wrong with it.

### What's planned

- **External asset backends** — S3 / R2 / generic-bucket adapters for asset bytes. The backend interface is in place; the implementations aren't.
- **Vector / embeddings.** The `vector` field type is wired through the schema and validator, but there is no similarity-search query path yet. Don't rely on it.
- **Multi-environment branching.** The storage schema reserves environment columns (`env_id`, `parent_env`); the API to fork, edit, and merge environments isn't exposed yet.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

"ledric" is a trademark of James Turle; the Apache License grants you the code, not the name. See [NOTICE](./NOTICE) for details.
