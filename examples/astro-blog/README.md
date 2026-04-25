# examples/astro-blog

A small Astro site that consumes the ledric HTTP API via `@ledric/sdk`.
Server-rendered (no client JS for content) — every page fetches live
data from your local ledric instance and renders it on the server.

Pages:

- `/` — list of every published `blog_post`, with hero images.
- `/posts/[slug]` — single post with the markdown body rendered.
- `/products` — product grid with prices and stock.
- `/products/[slug]` — product detail with related-product cross-sell.

## Run it

From the repo root, in two terminals:

```bash
# 1. ledric API
yarn cli http

# 2. astro dev server
yarn workspace @ledric/example-astro-blog dev
```

Then visit `http://localhost:4321`.

## Pointing at a different API

```bash
LEDRIC_API=http://192.168.1.10:3000 yarn workspace @ledric/example-astro-blog dev
```

## How it talks to ledric

`src/lib/ledric.ts` builds one `LedricClient` per process. The pages
use it directly in their frontmatter — Astro runs that on the server,
so the SDK never ships to the browser. Hero images load via plain
`<img src={client.assetUrl(id)}>` — those go straight to the ledric
HTTP server, which streams bytes with `Cache-Control: immutable`.

## Build for production

```bash
yarn workspace @ledric/example-astro-blog build
yarn workspace @ledric/example-astro-blog start
```

The site runs as a standalone Node server (via `@astrojs/node`).
