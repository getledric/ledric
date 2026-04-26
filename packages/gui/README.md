# @ledric/gui

Static admin UI for ledric. React + Tailwind, served by `@ledric/http-server`,
no bundler — every dependency loads from a CDN at runtime via an importmap.

## What's in here

```
src/index.ts        single export: guiAssetsPath (absolute path to web/)
web/index.html      Tailwind Play CDN + esm.sh importmap + <div id="root">
web/app.js          React app entry: routing + layout
web/lib/api.js      fetch wrapper for the ledric HTTP API (same origin)
web/components/
  TypeList.js       /types — every content type with entry counts
  EntryList.js      /types/:type — table of entries using summary_fields
  EntryEditor.js    /types/:type/new and /types/:type/:slug — author + publish
  fields.js         per-field-type renderers (string/markdown/asset/…)
```

The package ships dist/ + web/. `dist/` is the tiny TS export; `web/` is
served verbatim by `@fastify/static`.

## Running it

```bash
yarn cli http --gui
# admin GUI at http://127.0.0.1:3000/admin
```

`--gui-mount <path>` to change the mount, `--gui-path <dir>` to point at a
fork of the assets.

## Why CDN + no bundler

This is an admin UI for the local dev loop. Iteration is "save and refresh
the browser." A bundler buys nothing and slows the inner loop.

- React 18 via [esm.sh](https://esm.sh)
- React Router via esm.sh (deps pinned to react@18)
- [`htm`](https://github.com/developit/htm) for tagged-template JSX
- Tailwind via [Play CDN](https://tailwindcss.com/docs/installation/play-cdn)
  — runtime JIT, ~50 ms first-paint cost on localhost

If/when these deps need to be vendored (offline support, custom Tailwind
config, TS for the React side), the migration is "swap the importmap for a
build step." Nothing else changes.

## Field renderers

Dispatched from `field.type` in `fields.js`. A new field type means one new
case in `FieldRenderer` and one component below it. Today's coverage:

| Field type | Renderer |
|---|---|
| `string` | input or textarea (depending on `max`) |
| `slug` | input + "derive" button (uses `from`) |
| `number` | number input with `min` / `max` / `integer` step |
| `boolean` | checkbox |
| `date` | date picker (ISO `YYYY-MM-DD`) |
| `markdown` | textarea, monospace, `max` enforced |
| `enum` | select |
| `asset` | thumbnail + file picker (uploads via `POST /assets`) |
| `references` | read-only id list (autocomplete is v2) |
| `array` of `string` | tags input |
| anything else | read-only JSON view |

## Auth

There isn't any. Requests under `/admin` and to `/rpc` are all unauthenticated.
Bind ledric to `127.0.0.1` (the default) and you're fine on a dev machine;
binding to a public interface with `--gui` will print a loud warning but
won't block the user. Real auth lands in a follow-up.
