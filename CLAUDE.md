# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo shape

pnpm workspace, Node 22+, ESM-only TypeScript. Nine packages under `packages/`, plus a top-level `e2e/` Playwright suite. All inter-package deps use `workspace:*` (rewritten to real versions at publish time). Native deps `better-sqlite3` / `sharp` / `esbuild` are allow-listed for install scripts in `pnpm-workspace.yaml` — re-add them there if you ever pull native code in.

| Package | What it owns |
|---|---|
| `cli` (published as `ledric`) | The single binary. `init`, `serve`, `http`, `get`, `ls`, `asset`, `keys`, `tag`, `types`, … |
| `core` | The brain — `read`/`find`/`draft`/`publish`/`alterType`/`describeModel`. No I/O directly; takes a `Storage` plus an optional `TransformCache`, `httpBase`, `auth`. |
| `schema` | Pure (no I/O): `defineType()`, `field.*` builders, `FIELD_TYPE_SPECS` (the field-type catalogue including the `wire_shape` advertisement), validator. Imported by both consumer code and `core` itself. |
| `storage` | Dialect-and-adapter pattern: same logical operations (`createType`, `findEntries`, `searchEntries`, `addEntryTags`, …) implemented for SQLite (default) / Postgres / MySQL via Kysely. |
| `mcp-server` | The 20-tool MCP surface plus `SERVER_INSTRUCTIONS`. Tool args are zod schemas; JSON Schemas are written separately for the ListTools response. |
| `http-server` | Fastify routes that mirror the MCP catalogue at `POST /rpc`, plus dedicated REST endpoints for reads, asset bytes, and asset uploads. Auth is per-tool, not per-method (`READ_RPC_TOOLS` set decides which tools accept reader keys via `/rpc`). |
| `gui` | React+htm SPA. **Static files only** — `web/*` is shipped as-is and rendered by the browser via CDN imports + `htm/react` (no JSX, no bundler). Only the package's `src/index.ts` is tsup-built. |
| `sdk` | TypeScript consumer client. `LedricEntries` is an empty interface that `ledric types --augment-sdk` augments. |
| `proxy` | Server-side `(Request) => Promise<Response>` primitive for consumer sites. Strips inbound auth headers and injects the configured Bearer; gates writes; framework-agnostic. |

## Common commands

```bash
# Workspace-wide
pnpm build                     # tsup builds every package; required before e2e runs
pnpm test                      # vitest, sqlite-only (~360 tests)
pnpm test:watch                # interactive vitest
pnpm typecheck                 # tsc --noEmit, root only
pnpm e2e                       # Playwright; needs `pnpm exec playwright install chromium` once
pnpm e2e:ui                    # interactive Playwright runner
pnpm cli serve --gui           # run the dev tree's CLI

# Single-package
pnpm --filter @ledric/core test
pnpm --filter @ledric/storage build
pnpm --filter ledric build     # the CLI package — name is bare `ledric`, not `@ledric/cli`

# Single test
pnpm test packages/storage/src/storage.test.ts
pnpm test -t 'addEntryTags'    # by name match
```

Postgres and MySQL test suites are **opt-in**: set `LEDRIC_TEST_POSTGRES_URL` and/or `LEDRIC_TEST_MYSQL_URL` and re-run `pnpm test`. There's a gitignored `runTests.sh` convention at repo root for running all three locally — don't commit it.

## Change recipes — where things live

When making a common change, these are the files in roughly the order you should touch them. Each list is exhaustive enough that you shouldn't need to grep further.

**New MCP tool** (or extending an existing tool's args):
1. Zod arg schema in `packages/mcp-server/src/server.ts` (top of file).
2. Tool entry in the `ListTools` response — JSON Schema describing the same args (paragraphs around the matching zod schema).
3. Dispatch arm in `dispatchTool` (`case 'foo':`).
4. Add to the `READ_RPC_TOOLS` set in `packages/http-server/src/server.ts` if read-only — otherwise reader keys can't call it via `/rpc`.
5. Underlying method on `Core` (`packages/core/src/core.ts`) if not just dispatching to existing.
6. Doc row in `docs/mcp-tools.md`.
7. Optional: SDK convenience method on `LedricClient` (`packages/sdk/src/client.ts`) + types in `packages/sdk/src/types.ts`.

**New field type:**
1. Discriminated-union variant in `packages/schema/src/types.ts` + add to `FIELD_TYPES` const.
2. Builder in `packages/schema/src/field.ts` (e.g. `field.foo({...})`).
3. `FieldTypeSpec` entry in `packages/schema/src/field-specs.ts` — include `wire_shape` if input ≠ output.
4. Validator branch in `packages/core/src/validate.ts`.
5. Storage normalization in `packages/core/src/normalize.ts` (only if defaults / coercion are non-trivial).
6. GUI editor: add a component in `packages/gui/web/components/fields.js` and a `case` in `FieldRenderer`. Falls through to `FallbackField` (read-only JSON) if you skip this.
7. TypeScript codegen mapping in `packages/cli/src/codegen/types.ts` (`fieldDefToTs`).
8. Docs: row in `docs/schema.md`, mention in `docs/concepts.md` if the wire shape is novel.

**New query param on `find` / `read`** (e.g. how `published`, `summary` were added):
1. `FindEntriesInput` / `ReadInput` in `packages/storage/src/types.ts`.
2. Wire into `findEntries` AND `searchEntries` in `packages/storage/src/storage.ts` — easy to forget the FTS branch.
3. Thread through `Core.find` / `Core.read` in `packages/core/src/core.ts` — note projection step happens after the storage call.
4. HTTP route in `packages/http-server/src/server.ts` — `Querystring` type, parse, forward to core. Truthy values get string `'1'`/`'true'`.
5. MCP tool zod schema in `packages/mcp-server/src/server.ts` + JSON Schema in the ListTools response.
6. SDK: `FindOptions` / `ReadOptions` in `packages/sdk/src/types.ts`, URL serialization in `packages/sdk/src/client.ts`.
7. Doc row in `docs/http-api.md`.

**New CLI command:**
1. New file in `packages/cli/src/commands/` (use `defineCommand` from citty).
2. Import + register in `subCommands` in `packages/cli/src/cli.ts`.
3. Add help-banner row in the same file's `CONFIG_HELP` const.

**Bumping versions:**
- All 9 packages move in lockstep: `for f in packages/*/package.json; do sed -i '' 's/"version": "X.Y.Z"/"version": "X.Y.W"/' "$f"; done`.
- The CLI carries a hardcoded `PROXY_DEP_VERSION` constant in `packages/cli/src/commands/init.ts` for the dep it injects into consumer sites — bump it whenever `@ledric/proxy` releases.
- Workspace deps stay as `workspace:*`; pnpm rewrites them at publish time.

## Architectural keystones (read multiple files to understand)

**MCP and HTTP are the same surface.** Every MCP tool is also reachable as `POST /rpc { tool, args }`. The 20-tool catalogue lives in `packages/mcp-server/src/server.ts`; `dispatchTool` is shared with `http-server`. `describe_model` is the agent-facing self-description and is where `wire_shape`, `consumer_guidance`, `auth`, `image_transforms`, and `http_base` are advertised.

**The entry envelope is `{ id, type, slug, version, published_version?, fields, tags? }`.** Field values live under `fields` — never flat. Same shape on MCP and HTTP. Core internally uses `content` (legacy); the helper `entryToWireShape()` in `packages/mcp-server/src/server.ts` does the rename at the wire boundary. **Forgetting to call `entryToWireShape` for a new MCP tool that returns entries is a recurring bug.**

**`asset` field stores the stable `id`. Bytes are served via the per-version `ref_key`.** The `id` is opaque and stable across versions; the `ref_key` rotates on every byte replacement. `GET /assets/<id>` 302-redirects to `/assets/<ref_key>` so entry asset fields are usable as URL slugs without `expand_assets`. Don't conflate the two — the GUI's `api.bytesUrl()` takes a ref_key, and `api.asset(id)` exists to look up the current ref_key.

**`references` field stores `["type/slug"]` strings.** Optionally `"type/slug@version"` to pin. Agents have repeatedly tried to write `[{type, slug, ...}]` (the *resolved-output* shape) — that's wrong. `defineType` rejects example values in the resolved-object form; `wire_shape` advertises the input form on `describe_model`. The resolved shape only appears via `resolve_references=true` on read/find.

**Two distinct resolution mechanisms with confusable names.** `resolve_references` (the field type) projects `references`-typed values from strings to envelopes. `resolve_refs` (markdown directives) walks `:::ref{to="type/slug"}:::` inline directives in markdown bodies and attaches a `_refs` sidecar. Different code paths in `packages/core/src/` (`resolve-references.ts` vs `resolve-refs.ts`).

**The two-process consumer pattern is the production deployment.** Ledric runs as one process, the consumer site (Astro/Next/SvelteKit/etc.) is a separate one. The browser never talks to ledric directly — all traffic goes through `@ledric/proxy` mounted as a route in the consumer's server runtime. Reader/admin keys stay server-side. `ledric init` detects framework from `package.json` and scaffolds the route file (see `packages/cli/src/commands/init.ts` — `detectFramework`, `proxyScaffold`).

**Auth is admin-protects-writes by default.** Reads are open; mutations need an admin key. `--require-reader-key` flips reads to closed. Keys can be env-supplied (`LEDRIC_ADMIN_KEY`/`LEDRIC_READER_KEY`) — the bootstrap will skip first-boot key minting if either env var is set, and the HTTP middleware accepts those env keys directly without a stored hash. The Playwright suite uses fixed env keys for that reason.

**Storage is dialect-aware, not feature-uniform.** FTS uses FTS5 on SQLite, tsvector on Postgres, FULLTEXT on MySQL. Each has rough edges that have bitten this codebase: SQLite's `bm25()` is an auxiliary function that breaks when wrapped in `MIN`/`MAX` aggregates AND when its argument is an alias rather than the bare table name; MySQL BOOLEAN MODE re-interprets operator chars (`+ - * ~ < > @ ( ) "`) as syntax (the `searchEntries` impl strips them); Postgres uses a separate `tsvector` column populated by trigger. When touching `findEntries` / `searchEntries`, run all three suites — the 0.1.x patch history is full of "worked on SQLite, broke on Postgres" fixes.

**Migration runner has a hand-written SQL tokenizer.** Don't naively `text.split(';')` — the tokenizer in `packages/storage/src/storage.ts` respects `--` line comments, `/* */` block comments, and string literals so `CREATE TRIGGER` bodies and other multi-statement DDL don't get mangled. Bug-fix history: a naive splitter once produced a "no statements" RangeError on perfectly valid migrations.

**`published=true` filter touches every layer.** The flag flows storage → core → http → mcp → sdk. In `findEntries`/`searchEntries`, the entry_versions JOIN switches its ON-clause from `e.current_version` to `e.published_version`, plus a `WHERE e.published_version IS NOT NULL`. The hydrate step in searchEntries also flips its JOIN — easy to update one and forget the other.

## Lurking traps

- **`verbatimModuleSyntax: true`.** Import types with `import type { … }` (not mixed-mode imports). Files cited at runtime use `.js` extensions in imports even from `.ts` source — Node ESM requires this. Mixed-mode imports fail the DTS build, not the JS build, so the failure shows up at `pnpm build` not `pnpm typecheck`.
- **`addEntryTags` / `addAssetTags` return the FULL updated tag list, not just the just-added ones.** Was a real bug in 0.1.0 — the storage method returned only the new tags, the GUI's `setTags(result)` wiped the prior ones, and "you can only add one tag" was the user-visible symptom. Tests in `packages/storage/src/storage.test.ts` assert the contract.
- **The "new entry" form must NOT pre-fill from `type.example`.** The example is for agents reading `describe_model`; pre-filling makes every new draft look like a duplicate. `EntryEditor`'s effect explicitly resets state at the top of the loader. Field-level `default`s apply server-side on draft, not in the form.
- **`defineType` rejects `references` field examples in the resolved-object form.** `[{type:'author', slug:'jane'}]` is not a valid example; `['author/jane']` is. The validator runs at type-creation time so the agent gets a clear error rather than producing a mis-shaped wire example for future calls.
- **GUI is htm + static files, not JSX.** `packages/gui/web/components/*.js` use `htm/react` template strings — no build step for the components, no JSX, browsers load them via CDN imports. Edit and refresh; don't introduce a bundler or `.tsx` files.
- **The light/dark palette is a script-applied inversion.** When extending the GUI, mind that the zinc palette ranges 50→950 are inverted from the original dark theme. Status accents (red/green/amber 600/700) are tuned for light backgrounds; amber CTA buttons keep dark text (`text-zinc-950`) for contrast against amber-500 fills.
- **Asset URL builder takes a `ref_key`, not an `id`.** `api.bytesUrl(refKey)` in `packages/gui/web/lib/api.js`. The previous `api.assetUrl(id)` was renamed because every caller of it was broken. If you have only an id, fetch metadata via `api.asset(id)` to get the ref_key.
- **Reserved content keys start with `_`** (`_locale`, `_redirect`, `_refs`, `_warnings`). Field names must not start with `_`.

## Conventions worth knowing

- **No comments unless the WHY is non-obvious.** The codebase consistently follows this — most files have only a few comments, all explaining something not visible from the code (a hidden constraint, a workaround for a specific bug, a trap).
- **Don't add per-framework adapter code.** `@ledric/proxy` is deliberately framework-agnostic (one fetch-API handler); per-framework wiring lives in the README cookbook and as `init`-time scaffolding, not as runtime code.
- **Don't speculate features.** Several issues (#9 OpenAPI, #2 alter_type dry-run impact, etc.) describe future shape; the working pattern has been to ship only when there's a real user pain point, not pre-build for hypothetical consumers.
- **Commit messages: `Closes #N` for the GitHub issue, plus a short body explaining WHY.** Co-author trailer with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` is the convention here.

## Current state

- **0.2.0** is the latest published release. Closes #1 (onboarding friction, shipped in 0.1.2), #3 (editable nested fields), #6 (asset library picker), #7 (ledric types codegen), #10 (@ledric/proxy).
- 0.2.0 introduced the `@ledric/proxy` package, the `ledric types` CLI command (with optional `--augment-sdk`), nested-field editing in the admin GUI, and the asset library picker.
- **Open issues at last check:** #2 (alter_type dry-run impact across entries), #5 (Playwright tests — landed locally but the commit may not be pushed yet), #8 (per-field examples instead of per-type), #9 (`/openapi.json` for non-MCP consumers), #11 (also landed locally — `init` scaffolds proxy route file).
- **Local-only branches that may or may not be pushed:** `docs/readme-restructure` is a single-commit WIP for badges/sections/Contents-index changes, sitting on top of main. Verify with `git log origin/main..` before assuming anything is live.

## Where to look

- `docs/architecture.md` — the ten-thousand-foot view, packages, two-process pattern, asset pipeline, inline editor.
- `docs/concepts.md` — types/entries, ids, versions, references vs inline refs, assets, locales, the wire format.
- `docs/mcp-tools.md` — the full 20-tool surface; same args/returns as `POST /rpc`.
- `docs/http-api.md` — REST routes, query params, error codes.
- `docs/storage.md` — table layout, indexing, migrations.
- `docs/agent-recipes.md` — agent-facing prompt examples for common ledric workflows.
