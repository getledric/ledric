import { describe, it, expect } from 'vitest';
import { createLedricProxy } from './index.js';

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  hasBody: boolean;
}

function makeStubFetch(
  reply: (req: { url: string; method: string }) => {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Uint8Array | null;
  }
): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const stub: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    const method = init?.method ?? 'GET';
    const headersObj: Record<string, string> = {};
    const headerInit = init?.headers as HeadersInit | undefined;
    if (headerInit instanceof Headers) {
      headerInit.forEach((v, k) => {
        headersObj[k.toLowerCase()] = v;
      });
    }
    calls.push({
      url,
      method,
      headers: headersObj,
      hasBody: init?.body !== undefined && init?.body !== null
    });
    const r = reply({ url, method });
    return new Response(r.body ?? null, {
      status: r.status ?? 200,
      headers: r.headers ?? {}
    });
  };
  return { fetch: stub, calls };
}

describe('createLedricProxy', () => {
  describe('assets', () => {
    it('uses the explicit path argument and forwards transform query params', async () => {
      const { fetch: stub, calls } = makeStubFetch(() => ({
        body: 'bytes',
        headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000' }
      }));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        fetch: stub
      });
      const res = await proxy.assets(
        new Request('https://site.example/api/ledric/assets/abc?w=400&fm=webp'),
        '/assets/abc'
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('cache-control')).toBe('public, max-age=31536000');
      expect(calls[0]?.url).toBe('http://upstream:3000/assets/abc?w=400&fm=webp');
      expect(calls[0]?.headers.authorization).toBe('Bearer rk');
    });

    it('falls back to request URL pathname when no explicit path is given', async () => {
      const { fetch: stub, calls } = makeStubFetch(() => ({ body: 'bytes' }));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        fetch: stub
      });
      await proxy.assets(new Request('https://site.example/assets/abc'));
      expect(calls[0]?.url).toBe('http://upstream:3000/assets/abc');
    });

    it('strips inbound auth headers — consumer cannot smuggle a bearer', async () => {
      const { fetch: stub, calls } = makeStubFetch(() => ({}));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        fetch: stub
      });
      await proxy.assets(
        new Request('https://site.example/x', {
          headers: { authorization: 'Bearer attacker', 'x-ledric-key': 'attacker' }
        }),
        '/assets/abc'
      );
      expect(calls[0]?.headers.authorization).toBe('Bearer rk');
      expect(calls[0]?.headers['x-ledric-key']).toBeUndefined();
    });

    it('refuses non-GET methods', async () => {
      const { fetch: stub, calls } = makeStubFetch(() => ({}));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        fetch: stub
      });
      const res = await proxy.assets(
        new Request('https://site.example/x', { method: 'POST' }),
        '/assets/abc'
      );
      expect(res.status).toBe(405);
      expect(calls).toHaveLength(0);
    });

    it('404s when assets is disabled', async () => {
      const { fetch: stub, calls } = makeStubFetch(() => ({}));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        assets: false,
        fetch: stub
      });
      const res = await proxy.assets(new Request('https://site.example/x'), '/assets/abc');
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    });
  });

  describe('content', () => {
    it('forwards GET /entries/:type', async () => {
      const { fetch: stub, calls } = makeStubFetch(() => ({
        body: '{"total":0,"offset":0,"results":[]}',
        headers: { 'content-type': 'application/json' }
      }));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        fetch: stub
      });
      const res = await proxy.content(new Request('https://site.example/x'), '/entries/blog_post');
      expect(res.status).toBe(200);
      expect(calls[0]?.url).toBe('http://upstream:3000/entries/blog_post');
    });

    it('rejects types not in the allowlist', async () => {
      const { fetch: stub, calls } = makeStubFetch(() => ({}));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        content: { types: ['blog_post', 'author'] },
        fetch: stub
      });
      const ok = await proxy.content(new Request('https://site.example/x'), '/entries/blog_post');
      expect(ok.status).toBe(200);
      const denied = await proxy.content(
        new Request('https://site.example/x'),
        '/entries/secret_doc'
      );
      expect(denied.status).toBe(404);
      expect(calls).toHaveLength(1);
    });

    it('injects published=1 when forcePublished is set, even if consumer omitted it', async () => {
      const { fetch: stub, calls } = makeStubFetch(() => ({}));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        content: { forcePublished: true },
        fetch: stub
      });
      await proxy.content(
        new Request('https://site.example/x?limit=10'),
        '/entries/blog_post'
      );
      expect(calls[0]?.url).toBe('http://upstream:3000/entries/blog_post?limit=10&published=1');
    });
  });

  describe('handler dispatcher', () => {
    it('routes /assets/, /entries/, /inline/, /admin/ correctly', async () => {
      const { fetch: stub, calls } = makeStubFetch(() => ({}));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        adminKey: 'ak',
        inlineEditor: true,
        admin: true,
        fetch: stub
      });
      await proxy.handler(new Request('https://x.example/y'), '/assets/abc');
      await proxy.handler(new Request('https://x.example/y'), '/entries/blog_post');
      await proxy.handler(new Request('https://x.example/y'), '/inline/blog_post/hello');
      await proxy.handler(new Request('https://x.example/y'), '/admin/');
      expect(calls.map((c) => c.url)).toEqual([
        'http://upstream:3000/assets/abc',
        'http://upstream:3000/entries/blog_post',
        'http://upstream:3000/inline/blog_post/hello',
        'http://upstream:3000/admin/'
      ]);
    });

    it('returns 404 for unknown prefixes', async () => {
      const { fetch: stub } = makeStubFetch(() => ({}));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        fetch: stub
      });
      const res = await proxy.handler(new Request('https://x.example/y'), '/some-other-route');
      expect(res.status).toBe(404);
    });
  });

  describe('admin / inline editor (writes)', () => {
    it('admin proxy uses the admin key, not the reader key', async () => {
      const { fetch: stub, calls } = makeStubFetch(() => ({}));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        adminKey: 'ak',
        admin: true,
        fetch: stub
      });
      await proxy.admin(new Request('https://x.example/y'), '/admin/');
      expect(calls[0]?.headers.authorization).toBe('Bearer ak');
    });

    it("inline editor proxy is off by default — returns 404 even on a valid path", async () => {
      const { fetch: stub, calls } = makeStubFetch(() => ({}));
      const proxy = createLedricProxy({
        baseUrl: 'http://upstream:3000',
        readerKey: 'rk',
        adminKey: 'ak',
        fetch: stub
      });
      const res = await proxy.inlineEditor(
        new Request('https://x.example/y'),
        '/inline/blog_post/hello'
      );
      expect(res.status).toBe(404);
      expect(calls).toHaveLength(0);
    });
  });
});
