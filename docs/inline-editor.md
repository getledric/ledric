# Inline editor

Drop a `<script>` tag on your rendered site, sprinkle two
data-attributes on the elements that should be editable, and a
floating pencil shows up on hover. Click it → a drawer slides in
with the right form for the entry → save → the page reloads with
the updated published content.

The same admin GUI you'd use at `/admin` is what loads in the
drawer, just sized down. Same auth, same validation, same draft /
publish flow. No separate "embeddable widget" SDK to learn.

- [Installing the script](#installing-the-script)
- [Marking elements editable](#marking-elements-editable)
- [Helpers](#helpers) — `refAttrs()` from the SDKs
- [Auth](#auth)
- [Behaviour and lifecycle](#behaviour-and-lifecycle)
- [Styling and z-index](#styling-and-z-index)

---

## Installing the script

Boot ledric with `--gui` so the admin GUI is mounted:

```bash
npx ledric serve --gui          # admin GUI at http://localhost:3000/admin
npx ledric http --gui           # HTTP-only, same mount
```

Then drop the loader on every page that should be editable:

```html
<script src="http://localhost:3000/admin/inline.js" defer></script>
```

The script auto-derives the API origin from its own `src` URL — so
the same file works whether ledric is mounted at `/admin`, at the
root, or behind a custom path. No config needed.

For production: serve from your real ledric origin.

```html
<script src="https://cms.example.com/admin/inline.js" defer></script>
```

---

## Marking elements editable

Two data-attributes do the work:

```html
<article data-ledric-ref="blog_post/why-kysely">
  <h1 data-ledric-field="title">Why I switched to Kysely</h1>
  <div data-ledric-field="body">
    <!-- rendered markdown -->
  </div>
</article>
```

| Attribute | Notes |
|---|---|
| `data-ledric-ref="<type>/<slug>"` | Identifies the entry. Required on the element (or any ancestor) for the pencil to appear. |
| `data-ledric-field="<field-name>"` | Optional. When the drawer opens, scrolls to and focuses this field. Without it, the drawer opens to the top of the form. |

The pencil appears for any element with `data-ledric-ref` set, or
that has an ancestor with one. So you can scope the editable region
broadly (`<article data-ledric-ref="...">`) and still mark
individual fields:

```html
<article data-ledric-ref="blog_post/why-kysely">
  <h1 data-ledric-field="title">...</h1>           <!-- pencil → focuses title -->
  <p data-ledric-field="dek">...</p>                <!-- pencil → focuses dek -->
  <img data-ledric-field="hero" src="..." />        <!-- pencil → focuses hero -->
  <section><!-- no field attr → pencil → opens drawer at top --></section>
</article>
```

---

## Helpers

Both SDKs ship a tiny `refAttrs()` helper so you don't string-build
the attributes yourself.

### TypeScript / JavaScript (`@ledric/sdk`)

```ts
import { refAttrs } from '@ledric/sdk';

const post = await client.read('blog_post', 'why-kysely');
```

```jsx
// React / Astro / anywhere JSX
<article {...refAttrs(post)}>
  <h1 {...refAttrs(post, 'title')}>{post.fields.title}</h1>
  <div {...refAttrs(post, 'body')}>{renderMarkdown(post.fields.body)}</div>
</article>
```

For string-template engines:

```ts
import { refAttrsHtml } from '@ledric/sdk';

const html = `
  <article ${refAttrsHtml(post)}>
    <h1 ${refAttrsHtml(post, 'title')}>${post.fields.title}</h1>
  </article>
`;
```

Returns `''` (or `{}`) when `post` is null/undefined — safe to spread
without conditional logic.

### PHP (`Ledric\LedricClient`)

```php
$post = $client->read('blog_post', 'why-kysely');
?>
<article <?= $client->refAttrs($post) ?>>
  <h1 <?= $client->refAttrs($post, 'title') ?>><?= htmlspecialchars($post['fields']['title']) ?></h1>
</article>
```

---

## Auth

The drawer iframe needs the same admin key your `/admin` SPA uses.
First time it loads on a given origin, it shows a paste prompt; the
key is stashed in `localStorage` (`ledric:admin-key`) and reused on
subsequent loads.

If you want to seed the key automatically (e.g. for an internal
preview server), set it before the script loads:

```html
<script>
  localStorage.setItem('ledric:admin-key', 'lka_...');
</script>
<script src="https://cms.example.com/admin/inline.js" defer></script>
```

To kick someone out: clear the same key. The next interaction
re-prompts.

---

## Behaviour and lifecycle

**On hover** — the script walks up from the hovered element looking
for the first ancestor with `data-ledric-ref`. If found, a small
amber pencil button positions itself in the top-right corner of that
element. Hover ends → pencil hides after a short timeout.

**On click** — pencil opens a fixed-position drawer iframe on the
right side of the viewport. The iframe loads
`/admin/inline?ref=type/slug&field=title` — the same SPA you'd see
at `/admin`, just narrowed to a single entry's form.

**On save** — the drawer posts a `message` event to the parent;
script reloads the page so the new published content is what
visitors see.

**MutationObserver** — the script watches for elements added to the
DOM after page load (SPAs, infinite scroll, htmx swaps) and the
pencil works on those too without a re-init.

**Already loaded** — if the script is loaded twice on the same page
(common with SPA navigations) it's a no-op the second time
(`window.__ledricInlineLoaded`).

---

## Styling and z-index

The pencil and drawer are absolutely-positioned with
`z-index: 2147483645` (max int minus padding) so they sit above
basically anything. If your site has a higher-z modal that
overlaps, raise the modal — don't lower the pencil; you'll lose it
on header bars and sticky elements.

The pencil inherits no page styles (set explicitly via inline
`style`). The drawer is its own iframe, so the page's CSS can't leak
into the form.

---

## When NOT to use it

- **High-traffic public pages with no auth gate.** The pencil
  doesn't mean "anyone can edit" — clicking it still demands a key —
  but the affordance leaks "this is a CMS" to every visitor. Use a
  staging env, or gate the script tag behind a logged-in cookie.

- **JS-disabled environments.** No script, no pencil. Use `/admin`
  directly.

- **Pages where the same entry is rendered many times.** Pick one
  ancestor for `data-ledric-ref`; multiple sibling refs to the same
  entry will all show pencils, which is just visual noise. Field
  attributes can repeat freely.
