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

**Agents are properly invited.** Connect Claude Desktop, Cursor, or anything else that speaks MCP. Your AI gets the same surface you do — with validation, with version history, with structured errors — so it can draft posts, publish them, and evolve the content model without you holding its hand.

**Tokens are sacred.** Responses are flat, not wrapped in metadata envelopes. Lists come in three budgets (`list`, `summary`, `full`) so you pay only for what you asked for.

## Two minutes to running

```bash
# Node 22+ and Yarn 4 (via corepack)
corepack enable
yarn install
yarn build
yarn cli serve
```

That's it. A `./ledric.db` file just appeared next to you and an MCP server is listening on stdio. Point Claude Desktop at it:

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

## See your content from the outside

```bash
yarn cli ls                              # what types do I have?
yarn cli ls blog_post                    # what posts?
yarn cli get blog_post/hello-world       # one post, in the shape a website would render
yarn cli asset upload hero.jpg           # store an image
```

## Inside the box

- A full content model: types, fields, references, assets, examples
- An MCP surface that covers the whole lifecycle — introspect, draft, publish, evolve the schema, backfill existing content, manage assets
- An HTTP API with the same shape, so websites and SDKs don't need MCP
- Versioning on both entries *and* schemas — evolve a type and old content still reads correctly; time-travel to any version with one call
- Asset storage + serving, with SQLite-blob and local-filesystem backends built in and an adapter slot for S3 / R2 / whatever
- Markdown-first rich text with per-field HTML policies (allow / sanitize / forbid)
- Full localization — per-field or per-entry, with fallback rules
- Slug renames with permanent redirects, so links never rot
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

TBD.
