# ledric

**A CMS that speaks AI.**

A small, self-hosted content engine built from the ground up for the age of agents. It runs from one binary, stores everything in one file, and ships with a proper MCP interface so Claude (or anything else that speaks the Model Context Protocol) can read, write, and evolve your content model — with the same validation, history, and safety rails you'd get from a clicky admin panel.

## The pitch

You've got content. You've got AI tools. In a sane world they'd just talk to each other. In the current world, your CMS wraps every entry in six layers of metadata, your rich text is a proprietary JSON tree only one SDK can render, and every time Claude tries to help it burns half its context just parsing the response.

ledric sits in the middle and gets out of the way.

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

**Auth without ceremony.** On first HTTP boot ledric mints one admin key and one reader key, prints them once, and the auth gate turns on. By default writes need the admin key; reads stay open. Flip `--require-reader-key` for closed-reads mode. Want to rotate? `ledric keys create --role admin --raw | pbcopy` and revoke the old one.

**Agents are properly invited.** Connect Claude Desktop, Cursor, or anything else that speaks MCP. Your AI gets the same surface you do — with validation, with version history, with structured errors — so it can draft posts, publish them, and evolve the content model without you holding its hand.

**Tokens are sacred.** Responses are flat, not wrapped in metadata envelopes. Lists come in three budgets (`list`, `summary`, `full`) so you pay only for what you asked for.

## Two minutes to running

```bash
# Node 22+ and pnpm (via corepack)
corepack enable
pnpm install
pnpm build

# Pick your shape:
pnpm cli serve                # MCP stdio only — perfect for Claude Desktop
pnpm cli serve --gui          # also: HTTP API + admin GUI at http://127.0.0.1:3000/admin
```

That's it. A `./ledric.db` file just appeared next to you. With `--gui`, ledric also generates an admin key and a reader key on first boot and prints them once to stderr — copy them somewhere safe.

Point Claude Desktop at the stdio MCP:

```json
{
  "mcpServers": {
    "ledric": {
      "command": "node",
      "args": ["/absolute/path/to/ledric/packages/cli/dist/cli.js", "serve"]
    }
  }
}
```

Ask Claude to call `describe_model`. Watch it read your (empty) content model. Ask it to `create_type` for a blog post. Draft a post. Publish it. You're shipping.

If you want the admin UI in your browser, paste the printed admin key into the prompt at `http://127.0.0.1:3000/admin`. Same key works for the inline editor on any consumer site that loads `/admin/inline.js`.

## See your content from the outside

```bash
pnpm cli ls                              # what types do I have?
pnpm cli ls blog_post                    # what posts?
pnpm cli get blog_post/hello-world       # one post, in the shape a website would render
pnpm cli asset upload hero.jpg           # store an image
```

## Inside the box

- A full content model: types, fields, references, assets, examples
- An MCP surface that covers the whole lifecycle — introspect, draft, publish, evolve the schema, backfill existing content, manage assets, soft-delete with cascade
- An HTTP API with the same shape, so websites and SDKs don't need MCP
- Versioning on both entries *and* schemas — evolve a type and old content still reads correctly; time-travel to any version with one call
- An admin GUI plus a drop-in inline editor (browse and edit through `/admin`, or sprinkle `data-ledric-ref` on your rendered site for click-to-edit)
- Imgix-compatible image transforms with on-disk cache — resize, format, quality, auto-pick-from-Accept, all driven by URL params
- Asset storage + serving, with SQLite-blob and local-filesystem backends built in and an adapter slot for S3 / R2 / whatever; in-place bytes replacement (`update_asset`) bumps the version without breaking entry references
- Markdown-first rich text with per-field HTML policies (allow / sanitize / forbid), and JSS / CSS field types when you want to attach styling to a block
- Full localization — per-field or per-entry, with fallback rules
- Slug renames with permanent redirects, so links never rot
- API key auth (admin / reader roles, first-boot auto-generated) — turn on by minting a key, off by not minting one
- A CLI for everything you'd want to do from a terminal
- One SQLite file you can back up with `cp`

## The design philosophy

Three constraints we don't break:

1. **Tokens are the new bandwidth.** Every default is tuned for minimal agent-side overhead.
2. **Agents edit differently than humans.** They batch, they diff, they need dry-runs and structured errors. The API is shaped for both.
3. **The schema is the API.** `describe_model` tells an LLM everything it needs in one call. No separate docs to keep in sync.

Everything else in this project is a consequence of those three.

## Status

Alpha. The core works end-to-end. Shapes will shift before v1. If you try it and something breaks, open an issue — I'll see it.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

"ledric" is a trademark of James Turle; the Apache License grants you the code, not the name. See [NOTICE](./NOTICE) for details.
