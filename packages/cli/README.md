# ledric

**A CMS that speaks AI.**

A small, self-hosted content engine built for the age of agents. One binary, one SQLite file, and a proper MCP interface — so Claude (or anything else that speaks the Model Context Protocol) can read, write, and evolve your content model with the same validation, history, and safety rails as a clicky admin panel.

## Quick start

```bash
# Point Claude Desktop at it (one-liner — works with any MCP client)
claude mcp add ledric -- npx -y ledric serve

# Or run the full HTTP API + admin GUI
npx ledric serve --gui
# → admin GUI at http://127.0.0.1:3000/admin
```

A `./ledric.db` file appears next to you. With `--gui`, ledric mints an admin key and a reader key on first boot and prints them once to stderr — copy them somewhere safe.

## What you get

- **MCP server** over stdio (`ledric serve`) — drop-in for Claude Desktop, Cursor, Claude Code, or any MCP client
- **HTTP API** (`ledric http`) — same surface, for websites and SDKs
- **Admin GUI** at `/admin` — plus inline editor: drop `<script src="/admin/inline.js">` on your site and edit on the page itself
- **CLI** — `ledric ls`, `ledric get`, `ledric asset upload`, `ledric tag`, `ledric rename`, `ledric refs check`, `ledric keys create`
- **Imgix-compatible image transforms** — `?w=600&fit=cover&auto=format`, no SaaS bill
- **Versioning, draft/publish, soft-delete with cascade, localization, slug renames that don't break the web**

Everything lives in one SQLite file you can `cp`, `scp`, or commit.

## See your content from the outside

```bash
npx ledric ls                              # types + entry counts
npx ledric ls blog_post                    # entries of a type
npx ledric get blog_post/hello-world       # one entry, in render shape
npx ledric asset upload hero.jpg           # store an image
```

## Full docs

https://github.com/getledric/ledric

## License

Apache 2.0. "ledric" is a trademark of James Turle — see [NOTICE](https://github.com/getledric/ledric/blob/main/NOTICE).
