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

**BYO preferred storage, or just roll with the built-in one.** Your content lives in a SQLite file (commit it, scp it, cp it — it's just a file). For image and file bytes, you get two adapters out of the box: stash everything inside the DB for zero config, or write to a folder on disk if you'd rather rsync them separately. A future S3 adapter plugs into the same slot.

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
- Ten MCP tools covering the whole lifecycle (introspect → create → draft → publish → migrate)
- Versioning on both entries *and* schemas — evolve a type and old content still reads correctly
- An asset pipeline with SQLite-blob storage by default, local filesystem as option two, plugin slot for S3 / R2 / whatever
- Markdown-first rich text with per-field HTML policies (allow / sanitize / forbid)
- A CLI for everything you'd want to do from a terminal
- One SQLite file you can back up with `cp`

## Not in the box (yet)

- A browser editor UI — BYO, or drive it from the CLI for now
- An HTTP API — today the surface is MCP + CLI; HTTP is on the roadmap
- Slug rename + redirect — the data model is ready, the tool isn't wired
- A revert-to-version convenience call — versions are stored, the one-shot isn't
- Localization — deliberately cut from v1, the slug model already plans for it
- S3 asset backend — designed for, not written

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
