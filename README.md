# ledric

**A CMS that speaks AI.**

A small, self-hosted content engine built from the ground up for the age of agents. It runs from one binary, stores everything in one file, and ships with a proper MCP interface so Claude (or anything else that speaks the Model Context Protocol) can read, write, and evolve your content model — with the same validation, history, and safety rails you'd get from a clicky admin panel.

## The pitch

You've got content. You've got AI tools. In a sane world they'd just talk to each other. In the current world, your CMS wraps every entry in six layers of metadata, your rich text is a proprietary JSON tree only one SDK can render, and every time Claude tries to help it burns half its context just parsing the response.

ledric sits in the middle and gets out of the way.

## Why

This is a personal project first. After 25 years of building on top of content management systems and being annoyed by all of them, ledric is my attempt at the one I'd actually want to use. A few things to be upfront about:

- It's probably confusing in places.
- It definitely has gaps.
- Does AI make headless CMSes redundant? Maybe. I'm shipping this anyway.
- It was clearly coded quickly using AI. That's exactly what has happened here. It's in no way production-tested.

If you want a battle-tested CMS, this isn't it yet. If you like the shape of the bet — that the schema is the API, that agents deserve a real interface, that one SQLite file is enough — give it a try and tell me what's wrong with it.

## What you get

**Write your schema however you want.** Define content types in TypeScript for the autocomplete vibes, or ask Claude to make one up over chat. Both paths write the same canonical thing to the same file. No separate admin UI, no weird drift between your code and your "real" schema.

**Your content is just Markdown.** Rich-text fields are Markdown strings. Diff them in git. Paste them into Slack. Open them in any editor. No "oh, you need *our* SDK to render that" moments.

**History on every edit.** Every save writes a new version. Nothing is ever silently overwritten. You can read any historical version by number.

**Draft, then publish.** A post doesn't go live until you say so. Publishing is a pointer move — instant. Unpublishing is the same move in reverse.

**BYO preferred storage, or just roll with the built-in.** Your content lives in a SQLite file you can commit, scp, or `cp` like any other file. Assets? Same story — we'll store and serve the bytes for you (in the DB, or on disk, your call), or point us at your S3 / R2 / whatever bucket if you'd rather bring your own.

**Localization without the footguns.** Write once, translate per-field or per-entry, fall back cleanly, and let agents draft translations in place — all under the same versioning, publish, and history flow as the original.

**Renames don't break the web.** Change a post's slug and the old URL keeps resolving forever. Every retired slug is remembered. Your old tweets and Google juice stay valid.

**Edit on the page itself.** Drop one `<script>` tag on your rendered site and a floating pencil appears next to anything you tag with `data-ledric-ref`. Click → a drawer slides in with the right form → save → the page reloads with the new content. The full `/admin` SPA is there too if you want a grid-and-form view of everything at once.

**Imgix-compatible image transforms, no SaaS bill.** Asset URLs accept the usual `w`, `h`, `fit`, `q`, `fm`, `auto=format`, `dpr` — libvips does the work, transformed bytes are cached on disk. URLs are version-pinned, so browser and CDN caches stay correct even when you replace the source image in place.

**Auth without ceremony.** `ledric init` mints an admin key and a reader key on the way through; if you skip init, the first HTTP boot does it instead. Either way they're printed once and the auth gate turns on. By default writes need the admin key; reads stay open. Flip `--require-reader-key` for closed-reads mode. Rotate with `ledric keys create --role admin --raw | pbcopy` and revoke the old one.

**Agents are properly invited.** Connect Claude Desktop, Cursor, or anything else that speaks MCP. Your AI gets the same surface you do — with validation, with version history, with structured errors — so it can draft posts, publish them, and evolve the content model without you holding its hand.

**Tokens are sacred.** Responses are flat, not wrapped in metadata envelopes. Lists come in three budgets (`list`, `summary`, `full`) so you pay only for what you asked for.

## How I actually use it

Most of my real work happens in a single Claude session against the MCP server:

1. *"Go through this Figma node and build out the required asset exports."* I open Figma, run the exports, drop them in a folder.
2. *"Upload these to ledric and tag them appropriately."*
3. *"Build out the page from this Figma design using the uploaded assets and the copy I've extracted."*
4. *"Read SMARTBLOCK.md and fix the styling so it matches Figma — I want the styling editable from the admin UI in a pinch."*

So no, you don't strictly need a headless CMS in the loop if you're already operating like this. ledric exists because I want my marketing team to roll out updates without me — and I want them to be able to wire up their own LLM tools to the same content store.

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
      "args": ["-y", "ledric", "serve"],
      "cwd": "/absolute/path/to/your/content/dir"
    }
  }
}
```

`cwd` matters — `ledric.db` lives in the working directory.

Restart the client. Ask Claude to call `describe_model`. Watch it read your (empty) content model. Ask it to set up a blog. Draft a post. Publish it. You're shipping.

## See your content from the outside

```bash
npx ledric ls                              # what types do I have?
npx ledric ls blog_post                    # what posts?
npx ledric get blog_post/hello-world       # one post, in the shape a website would render
npx ledric asset upload hero.jpg           # store an image
```

## Docs

Pages are short, scoped, and self-contained — pick the one that
matches what you're trying to do.

| | |
|---|---|
| **[Build with an agent](./docs/build-with-an-agent.md)** | End-to-end walkthrough: ask Claude to set up the schema, seed content, build an Astro site that renders it, wire up inline editing. Anchored to the committed `examples/astro-blog/` artifact. |
| **[Schema](./docs/schema.md)** | Field types catalogue, `defineType()` examples, common + type-level options, validation, schema evolution. |
| **[Agent recipes](./docs/agent-recipes.md)** | Example prompts you can paste into Claude: project setup, drafting, schema evolution, bulk ops, refactoring, localization. |
| **[MCP tools](./docs/mcp-tools.md)** | The full 20-tool surface — args, returns, examples. Same surface as `POST /rpc` over HTTP. |
| **[HTTP API](./docs/http-api.md)** | REST routes for reads, multipart upload, generic `POST /rpc`, image transforms, slug redirects, error codes. |
| **[Inline editor](./docs/inline-editor.md)** | `<script>` install, `data-ledric-ref` / `data-ledric-field` attributes, `refAttrs()` helpers in both SDKs, auth, behaviour. |
| **[Assets](./docs/assets.md)** | The id / ref_key split, db vs local backends, uploads, image transforms, in-place bytes replacement, the transforms cache. |
| **[Auth](./docs/auth.md)** | Roles, key minting via `init` / first boot, header formats, closed-reads mode, listing / creating / revoking, rotation, env-var override. |
| **[SDKs](./docs/sdks.md)** | `@ledric/sdk` (TypeScript) and `Ledric\LedricClient` (PHP) — methods, options, errors, inline-editor `refAttrs()`. |
| **[Localization](./docs/localization.md)** | Per-type locales, `localized: true` fields, the `_locale` sidecar, fallback chains, locale-specific slugs, recipes. |
| **[Deployment](./docs/deployment.md)** | Production shape: CDN in front of `/assets/<ref_key>`, reverse proxy + TLS, env-supplied API keys, backups, Postgres / MySQL deploys, what to handle outside of ledric. |

## The design philosophy

Three constraints we don't break:

1. **Tokens are the new bandwidth.** Every default is tuned for minimal agent-side overhead.
2. **Agents edit differently than humans.** They batch, they diff, they need dry-runs and structured errors. The API is shaped for both.
3. **The schema is the API.** `describe_model` tells an LLM everything it needs in one call. No separate docs to keep in sync.

Everything else in this project is a consequence of those three.

## From source

```bash
git clone https://github.com/getledric/ledric
cd ledric
corepack enable                  # one time, ever — wires up pnpm
pnpm install
pnpm build
pnpm cli serve --gui             # same as `npx ledric serve --gui`, but against your dev tree
```

`pnpm dev` watches and rebuilds. `pnpm test` runs the suite (vitest, ~310 tests).

## Status

Alpha. The core works end-to-end, shapes will shift before v1. AI did most of the typing and it's in no way production-tested yet. If you try it and something breaks, open an issue — I'll see it.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

"ledric" is a trademark of James Turle; the Apache License grants you the code, not the name. See [NOTICE](./NOTICE) for details.
