# examples/blog

A single-file HTML demo that consumes the ledric HTTP API.

It's intentionally vanilla — no framework, no build step. It's the
shortest possible answer to "what does it look like to render content
from ledric?"

## Run it

From the repo root, in one terminal:

```bash
npx ledric http
```

That starts the HTTP server on `http://localhost:3000` against
`./ledric.db`. CORS is open by default, so a `file://` page can talk
to it directly.

In another terminal (or just your file manager):

```bash
open examples/blog/index.html
```

You should see a list of every published `blog_post` entry, each with
its hero image fetched from `GET /assets/<id>`.

## Pointing at a different API

The page reads `?api=` from the URL if you want to talk to a different
host:

```
file://…/examples/blog/index.html?api=http://192.168.1.10:3000
```

## What the page does

Two HTTP calls on load:

```
GET /types                       # for schema_version + post count
GET /entries/blog_post?limit=20  # for the post list
```

Hero images are loaded by the browser as normal `<img src>` requests
to `GET /assets/<hero-id>`. The asset ids stored in each entry's
`hero` field are content-addressable, so the response carries
`Cache-Control: public, max-age=31536000, immutable` and they're free
on second view.
