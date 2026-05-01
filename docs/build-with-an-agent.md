# Build a site with an agent

The bet ledric is making is that once an agent can read your content
model with a single tool call, it has everything it needs to design
the schema, draft the content, write the consumer site that renders
it, and wire up the inline editor — without you handing it a spec
document, type definitions, or example payloads. The schema *is* the
spec.

This page walks through what that looks like end-to-end. The prompts
are written the way you'd actually paste them. The resulting code is
real — it's committed in [`examples/astro-blog/`](../examples/astro-blog/).
The agent's tool-call flow is representative of how Claude (Sonnet
or Opus) actually behaves over MCP, not a literal recording.

> **What's authentic here:** the prompts, the committed code, the
> shape of Claude's tool calls. **What's illustrative:** specific
> response wording and turn counts will vary by model and session.

- [Before you start](#before-you-start)
- [Setting up the schema](#setting-up-the-schema)
- [Seeding some content](#seeding-some-content)
- [Building the frontend](#building-the-frontend)
- [Making it editable in place](#making-it-editable-in-place)
- [What just happened](#what-just-happened)
- [Other stacks](#other-stacks)

---

## Before you start

A 60-second setup so the rest of the page makes sense:

```bash
mkdir my-site && cd my-site
npx -y ledric init
# accept defaults — patches .mcp.json, mints keys, writes .gitignore
npx ledric serve --gui &
# admin GUI at http://localhost:3000/admin

claude    # start Claude Code in this directory
```

Because `init` patched `./.mcp.json`, Claude Code picks up the
ledric MCP server automatically when you start a session in this
directory. No further config.

In the Claude session, confirm it's connected:

> What MCP tools do you have access to right now?

It should list the 20 ledric tools. If it doesn't, restart Claude
Code (the MCP discovery happens at session start).

---

## Setting up the schema

This is the conversation that creates the content model. Notice that
the prompt doesn't specify field types or options — the agent picks
them by calling `describe_model` first to learn the field-type
catalogue, then making sensible choices.

> Set up a blog. Posts have a title (required, capped at 120 chars),
> a slug derived from the title, a markdown body, an optional hero
> image, an author reference, a short summary, a published date, and
> a tags string array. Title is what shows in admin lists; show
> title, author, and published_at in summary views.
>
> Then add an author type with name (required), bio (markdown), and
> avatar (image asset).

What Claude does, in order:

1. **`describe_model`** — to see whether the types already exist and
   to remind itself of the field-type catalogue.
2. **`create_type` for `author`** first (because `blog_post`
   references it — author has to exist for the reference to validate).
3. **`create_type` for `blog_post`** with the `references` field
   pointing at `author`.

The actual create_type call for `blog_post` looks like:

```json
{
  "name": "blog_post",
  "fields": {
    "title": { "type": "string", "required": true, "max": 120 },
    "slug": { "type": "slug", "required": true, "from": "title" },
    "summary": { "type": "string", "max": 280 },
    "body": { "type": "markdown", "required": true },
    "hero": { "type": "asset", "kinds": ["image"] },
    "author": { "type": "references", "to": ["author"], "min": 1, "max": 1 },
    "published_at": { "type": "date" },
    "tags": { "type": "array", "of": { "type": "string" } }
  },
  "opts": {
    "display_field": "title",
    "summary_fields": ["title", "author", "published_at"]
  }
}
```

You didn't specify `min`/`max` on the author reference, but the agent
inferred "1" because you said "an author" (singular, implied
required). If that's wrong it's one prompt to correct
("authors should be optional, and posts can have multiple"). The
schema is cheap to alter.

Verify with the CLI:

```bash
npx ledric ls
# {
#   "db": "./ledric.db",
#   "types": [
#     { "name": "author",    "version": 1, "entries": 0 },
#     { "name": "blog_post", "version": 1, "entries": 0 }
#   ]
# }
```

---

## Seeding some content

You need something to render. Ask the agent to make it up.

> Draft three blog posts. Pick realistic titles, write 3-paragraph
> bodies, give them sensible published dates from the last few
> months. Authors can be made up — create one or two `author`
> entries first if you need to.

Claude:

1. Drafts one or two `author` entries.
2. Drafts three `blog_post` entries, each referencing one of the
   authors.
3. Asks if you want them published or left as drafts.

Tell it to publish:

> Publish all three posts.

The agent calls `publish` once per entry. They're now live.

(If a draft fails validation — say Claude tried to set `body: null`
when it's required — it gets back a `VALIDATION_FAILED` error with
the exact field path. It corrects and retries on its own; you don't
need to debug.)

---

## Building the frontend

Now switch contexts. The schema and content are in place; you want
a site that renders them.

> Build me an Astro project in this directory that consumes the blog
> from ledric. Index page lists posts (title, summary, hero image,
> date). A `posts/[slug].astro` page renders the full post — title,
> hero, body as rendered markdown, author, tags. Use the
> `@ledric/sdk` package for reads. Server-rendered, no client JS.

Claude does:

1. **`describe_model`** again — confirms the schema is what it
   thinks it is (this is cheap and it always re-grounds when
   switching contexts).
2. **Scaffolds Astro** — `pnpm create astro@latest`, picks the
   minimal template, agrees to TypeScript.
3. **Adds `@ledric/sdk` and `marked`** for reads + markdown rendering.
4. **Writes `src/lib/ledric.ts`** — a thin client module that exports
   the SDK instance and a few helpers.
5. **Writes `src/pages/index.astro`** — calls `client.find('blog_post', {...})`
   and maps results into a list view.
6. **Writes `src/pages/posts/[slug].astro`** — calls `client.read('blog_post/${slug}')`
   and renders the post.
7. **Adds a `Base.astro` layout** because the two pages share chrome.

The actual files Claude produces look like (these are what's in
[`examples/astro-blog/`](../examples/astro-blog/)):

`src/lib/ledric.ts` — the thin shared module:

```ts
import { createLedricClient } from '@ledric/sdk';

const baseUrl = process.env.LEDRIC_API ?? 'http://localhost:3000';

export const client = createLedricClient({ baseUrl });
export { refAttrs, refAttrsHtml } from '@ledric/sdk';

export function isAssetId(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v);
}

export function formatDate(s: unknown): string {
  if (typeof s !== 'string') return '';
  return new Date(s).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric'
  });
}
```

`src/pages/index.astro` — the list view, abridged:

```astro
---
import Base from '../layouts/Base.astro';
import { client, isAssetId, formatDate } from '../lib/ledric';

const result = await client.find('blog_post', { limit: 20 });
const posts = result.results.map((p) => {
  const f = p.fields as Record<string, unknown>;
  return {
    slug: p.slug,
    title: typeof f.title === 'string' ? f.title : '(untitled)',
    summary: typeof f.summary === 'string' ? f.summary : '',
    publishedAt: formatDate(f.published_at),
    heroId: isAssetId(f.hero) ? f.hero : null,
    tags: Array.isArray(f.tags) ? (f.tags as string[]) : []
  };
});
---
<Base title="The latest from the team">
  <ul class="post-list">
    {posts.map((p) => (
      <li class="post-card">
        {p.heroId && <img src={client.assetUrl(p.heroId)} alt={p.title} />}
        <h2><a href={`/posts/${p.slug}`}>{p.title}</a></h2>
        <div class="meta">{p.publishedAt}</div>
        {p.summary && <p>{p.summary}</p>}
        {p.tags.length > 0 && (
          <div class="tags">{p.tags.map((t) => <span>{t}</span>)}</div>
        )}
      </li>
    ))}
  </ul>
</Base>
```

`src/pages/posts/[slug].astro` — the detail view, abridged:

```astro
---
import Base from '../../layouts/Base.astro';
import { client, isAssetId, formatDate, refAttrs } from '../../lib/ledric';
import { marked } from 'marked';

const { slug } = Astro.params;
const post = slug ? await client.read(`blog_post/${slug}`) : null;
if (!post) return new Response('Not found', { status: 404 });

const f = post.fields as Record<string, unknown>;
const title = typeof f.title === 'string' ? f.title : '(untitled)';
const heroId = isAssetId(f.hero) ? f.hero : null;
const bodyHtml = marked.parse(typeof f.body === 'string' ? f.body : '', { async: false }) as string;
---
<Base title={title}>
  <div {...refAttrs(post)}>
    {heroId && <img class="hero" src={client.assetUrl(heroId)} alt={title} {...refAttrs(post, 'hero')} />}
    <div class="meta" {...refAttrs(post, 'author')}>{formatDate(f.published_at)}</div>
    <article class="prose" set:html={bodyHtml} {...refAttrs(post, 'body')} />
  </div>
</Base>
```

Three things worth pausing on:

1. **The agent never asked you for the schema.** It called
   `describe_model` and read it. The shape of the loop in `index.astro`
   directly reflects the field types — `title: string`, `summary: string`,
   `hero: asset` (resolved through `assetUrl`), `tags: array`.

2. **The reads are typed at the runtime boundary, not by codegen.**
   The `as Record<string, unknown>` plus the per-field
   `typeof` / `isAssetId` checks is the agent being defensive about
   the wire format. There's no TS schema codegen step — the agent
   chose runtime narrowing because it's simpler and won't drift.

3. **The body is just markdown.** `marked.parse()` and you're done.
   No proprietary AST, no SDK lock-in. If you'd rather use
   `markdown-it` or render server-side React from MDX, the same
   string flows in.

Run it:

```bash
pnpm dev
# astro dev server at http://localhost:4321
```

Live data from the live ledric instance. Edit a post in the admin
GUI at `:3000/admin`, hit publish, refresh `:4321` — change shows up.

---

## Making it editable in place

The site renders fine. Now wire up the inline editor so you (or
anyone with the admin key) can click-edit on the actual rendered
page.

> Add the inline editor. I should be able to hover anything and get
> a pencil icon that opens the edit drawer.

Claude:

1. **Drops the script tag** into the layout
   (`<script src={`${baseUrl}/admin/inline.js`} defer></script>`).
2. **Confirms `refAttrs(post)` is already on the post wrapper** in
   `[slug].astro` — it was, because Claude wrote it there originally
   knowing the inline editor would want it.
3. **Adds field-scoped `refAttrs(post, 'title')` to the heading**,
   `refAttrs(post, 'body')` to the article, etc.

Reload the page. Hover the title. Pencil appears. Click it. Drawer
slides in with the form pre-scrolled to the title field. Edit, save,
page reloads with the new published content.

This entire feature is two lines of HTML and one `<script>` tag. The
agent already knew about it from `describe_model`'s `features`
section.

---

## What just happened

A few claims about the experience that should now be concrete:

**The schema is the API.** You wrote zero type definitions in your
frontend code. The agent read them once via `describe_model` and
that was the whole spec.

**`describe_model` is the discovery primitive.** Claude called it
twice: once before creating types (to check what's there + remind
itself of the catalogue), once when starting the frontend (to ground
on the same model the renderer would consume). That single
in-context handoff is what lets the conversation jump from
"I want a blog" to "here's a post detail page" without a
specification document in between.

**Validation drives correctness.** When Claude's first draft of a
post failed validation (it omitted `summary`, which you'd specified
as having a max length, and it tried to set `body: null` for an
empty post), the structured error told it which field and why. It
fixed and retried without you debugging.

**Tokens stay cheap.** The list page used `find` with the default
summary budget — Claude got `title`, `author`, `published_at` per
result, not the full body of every post just to render a list.
The detail page used `read` with `expand_assets: false` (the
default) and built the URL from the asset id manually via
`assetUrl()`. No wasted bytes.

**Inline editing is plumbing-free.** `refAttrs(post, 'field')` plus
one script tag. The drawer is the same form the admin GUI uses, so
validation and version conflict handling are identical.

You can run all of this against the committed
[`examples/astro-blog/`](../examples/astro-blog/) — it's the same
shape, with a couple of extra niceties (locale switcher,
`_redirect` handling, light styling). Treat it as the artifact this
walkthrough produces; the agent session is just the path that gets
you there.

---

## Other stacks

The pattern is the same wherever you can speak HTTP or import a JS
client:

**Next.js / Remix / React Router** — `@ledric/sdk` works the same.
Use it from `getServerSideProps`, route loaders, or RSC server
components. `refAttrs()` returns a `Record<string, string>` which
spreads into JSX exactly as it does in Astro.

**Plain HTML + htmx** — agent generates a tiny PHP / Node / Python
backend that calls `client.find()` and templates the result. The
inline editor doesn't care about your stack — it walks the rendered
DOM at runtime.

**PHP** — `composer require ledric/sdk` and use `Ledric\LedricClient`
the same way. Agent will pick it up if your project has a
`composer.json` and a php file or two.

**Static-site builds (11ty, Hugo via shell, etc.)** — `npx ledric
get type/slug --json` returns one entry's render shape on stdout. A
build script can iterate `ledric ls type --json` and emit one file
per result. The site's static; the editor still works (it doesn't
care that the page was prebuilt).

The thread connecting all of these: the agent learns your model
once via `describe_model`, picks the right SDK or HTTP shape for
your stack, and writes code that consumes the same flat-JSON shape
you'd see at `GET /entries/blog_post/why-kysely`. There's nothing
stack-specific to teach it.
