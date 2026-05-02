# @ledric/proxy

**Server-side proxy primitive for [ledric](https://github.com/getledric/ledric).** Mounts a thin reverse proxy in your consumer site's server runtime so the browser never talks to ledric directly — keys stay server-side, and only a curated subset of ledric's HTTP surface is exposed to the public.

```
browser ──HTTP──▶ your site (Astro/Next/SvelteKit/...) ──proxy──▶ ledric
                  ↑ public                                ↑ private (127.0.0.1 / VPN)
```

The package exports framework-agnostic [fetch-API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API) handlers — `(Request) => Promise<Response>` — so wiring is a 3-line job in any framework. No per-framework adapter code to keep in sync.

## Install

```bash
pnpm add @ledric/proxy
```

## Quickstart

```ts
import { createLedricProxy } from '@ledric/proxy';

export const proxy = createLedricProxy({
  baseUrl: process.env.LEDRIC_URL!,           // http://127.0.0.1:3000 in dev
  readerKey: process.env.LEDRIC_READER_KEY,   // never reaches the browser
});
```

By default:
- `assets` is **on** — `/assets/<key>` and image transforms are forwarded.
- `content` is **on** — `/entries/:type` and `/entries/:type/:slug` are forwarded for any type.
- `inlineEditor` is **off** — opt in for preview environments only.
- `admin` is **off** — most production sites should never enable this.

Lock down `content` to a specific allowlist:

```ts
content: { types: ['blog_post', 'author'] }
```

Force published-only reads (drafts invisible to consumers):

```ts
content: { forcePublished: true }
```

## Framework wiring

Every framework gets the same handler. Pick the one matching your stack — the rest of this README stays relevant.

### Astro

```ts
// src/pages/api/ledric/[...path].ts
import type { APIRoute } from 'astro';
import { proxy } from '../../../lib/ledric';

export const ALL: APIRoute = ({ request, params }) => {
  const path = '/' + (Array.isArray(params.path) ? params.path.join('/') : params.path ?? '');
  return proxy.handler(request, path);
};
```

### Next.js (App Router)

```ts
// app/api/ledric/[...path]/route.ts
import { proxy } from '@/lib/ledric';

const handler = (req: Request, ctx: { params: { path: string[] } }) =>
  proxy.handler(req, '/' + ctx.params.path.join('/'));

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
```

### Next.js (Pages Router)

```ts
// pages/api/ledric/[...path].ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { proxy } from '@/lib/ledric';

export const config = { api: { bodyParser: false } };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`);
  const path = url.pathname.replace(/^\/api\/ledric/, '') || '/';
  const fetchReq = new Request(url, {
    method: req.method,
    headers: req.headers as HeadersInit,
    body: ['GET', 'HEAD'].includes(req.method ?? '') ? undefined : (req as unknown as ReadableStream),
    duplex: 'half'
  } as RequestInit);
  const out = await proxy.handler(fetchReq, path);
  res.status(out.status);
  out.headers.forEach((v, k) => res.setHeader(k, v));
  if (out.body) {
    const reader = out.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}
```

### SvelteKit

```ts
// src/routes/ledric/[...path]/+server.ts
import { proxy } from '$lib/ledric';
import type { RequestHandler } from './$types';

const handler: RequestHandler = ({ request, params }) =>
  proxy.handler(request, '/' + params.path);

export { handler as GET, handler as POST, handler as PUT, handler as DELETE, handler as HEAD };
```

### Hono

```ts
import { Hono } from 'hono';
import { proxy } from './lib/ledric';

const app = new Hono();
app.all('/ledric/*', (c) => {
  const path = c.req.path.replace(/^\/ledric/, '') || '/';
  return proxy.handler(c.req.raw, path);
});
```

### Express

```ts
import express from 'express';
import { proxy } from './lib/ledric';

const app = express();
app.use('/ledric', async (req, res) => {
  // Express → fetch Request adapter (Node 22+).
  const url = new URL(req.originalUrl, `http://${req.headers.host}`);
  const fetchReq = new Request(url, {
    method: req.method,
    headers: req.headers as HeadersInit
  });
  const out = await proxy.handler(fetchReq, req.url.split('?')[0] || '/');
  res.status(out.status);
  out.headers.forEach((v, k) => res.setHeader(k, v));
  if (out.body) {
    const reader = out.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
});
```

### Plain Node / Bun.serve / Deno.serve

```ts
import { proxy } from './lib/ledric';

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/ledric/')) {
      return proxy.handler(req, url.pathname.replace(/^\/ledric/, ''));
    }
    // ... your other routes
    return new Response('Not Found', { status: 404 });
  }
});
```

## Updating browser-side URLs

In your consumer code, asset URLs and entry URLs now point at *your* mount path, not at ledric. The handlers preserve query strings (including image transforms), redirects, and cache headers, so this is mostly a path rewrite:

```diff
- <img src={`${LEDRIC_URL}/assets/${asset.id}?w=600&fm=webp`} />
+ <img src={`/api/ledric/assets/${asset.id}?w=600&fm=webp`} />
```

## API

### `createLedricProxy(options): LedricProxy`

| Option           | Default          | Notes |
|---|---|---|
| `baseUrl`        | required         | Base URL of the running ledric server. |
| `readerKey`      | undefined        | Bearer key for read endpoints. Falls back to `adminKey`. |
| `adminKey`       | undefined        | Bearer key for write endpoints (inline editor / admin). |
| `assets`         | `true`           | Enable `/assets/*` proxy. Boolean or `{ enabled }`. |
| `content`        | `true`           | Enable `/entries/*` proxy. `{ enabled, types?, forcePublished? }`. |
| `inlineEditor`   | `false`          | Enable `/inline/*` proxy. |
| `admin`          | `false`          | Enable `/admin/*` proxy. |
| `fetch`          | `globalThis.fetch` | Override (testing). |
| `timeout`        | `60_000`         | Upstream request timeout in ms. |

Returned object:

```ts
interface LedricProxy {
  assets:       (req: Request, path?: string) => Promise<Response>;
  content:      (req: Request, path?: string) => Promise<Response>;
  inlineEditor: (req: Request, path?: string) => Promise<Response>;
  admin:        (req: Request, path?: string) => Promise<Response>;
  handler:      (req: Request, path?: string) => Promise<Response>;
}
```

`handler` dispatches by path prefix (`/assets/`, `/entries/`, `/inline/`, `/admin/`). Pass an explicit `path` when your framework already routed to a catchall — that's the canonical case. When omitted, it's read from `new URL(request.url).pathname`.

## Security model

- **Inbound `Authorization` and `X-Ledric-Key` headers are stripped** before forwarding. The proxy injects its own configured Bearer key. Consumers cannot smuggle credentials through.
- **Response headers are filtered** to a known-safe allowlist (`Content-Type`, `Cache-Control`, `ETag`, `Vary`, `Location`, etc.). Upstream `Set-Cookie` is dropped.
- **Only fetch-shaped methods are accepted** on read endpoints (GET/HEAD); inline editor and admin proxies pass through bodies for writes.
- **Sub-handlers verify the path prefix** before forwarding — mounting at `/api/ledric/[...path]` and calling `proxy.assets(req, '/entries/...')` returns 404, not a confused upstream call.

## License

Apache-2.0 — same as ledric.
