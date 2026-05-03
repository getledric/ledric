import { describe, it, expect } from 'vitest';
import { Core } from '@ledric/core';
import { openSqlite } from '@ledric/storage';
import { runHttp } from './runner.js';

// Regression for the 0.3.0/0.3.1 bug where `runHttp` constructed its
// own subset of HttpServerOptions and silently dropped `mcp`. Result:
// `serve --http-mcp --public-mcp` returned 404 on /mcp because the
// route was never registered. The fix has runHttp spread its opts
// straight through to createHttpServer; this test holds it there.
describe('runHttp option pass-through', () => {
  it('forwards mcp.http so /mcp is mounted', async () => {
    const storage = await openSqlite({ path: ':memory:' });
    const core = new Core(storage);
    const server = await runHttp(core, {
      port: 0,
      host: '127.0.0.1',
      mcp: { http: true },
      auth: { storage }
    });
    try {
      const res = await fetch(`${server.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
      });
      // Exactly the 404 envelope the user hit through the Cloudflare
      // tunnel — if /mcp isn't mounted, this body comes back.
      const body = (await res.json()) as unknown;
      expect(body).not.toEqual({ error: { code: 'NOT_FOUND', message: 'route /mcp' } });
    } finally {
      await server.close();
      await storage.close();
    }
  });
});
