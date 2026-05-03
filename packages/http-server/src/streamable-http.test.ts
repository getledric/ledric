import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Core } from '@ledric/core';
import { openSqlite, type LedricStorage } from '@ledric/storage';
import { createHttpServer } from './server.js';
import type { FastifyInstance } from 'fastify';

interface Listening {
  app: FastifyInstance;
  url: string;
  port: number;
  storage: LedricStorage;
}

async function bootHttp(opts: { remoteMcp: boolean }): Promise<Listening> {
  const storage = await openSqlite({ path: ':memory:' });
  const core = new Core(storage);
  const app = createHttpServer(core, {
    ...(opts.remoteMcp
      ? {
          mcp: {
            remote: true,
            publicUrl: 'http://127.0.0.1'
          }
        }
      : {})
  });
  await app.ready();
  // Port 0 → kernel-assigned ephemeral port. Pull the actual address
  // back from `server.address()` so the client knows where to connect.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr !== 'object') {
    throw new Error('listen() returned no address');
  }
  return { app, url: `http://127.0.0.1:${addr.port}`, port: addr.port, storage };
}

describe('Streamable HTTP MCP transport', () => {
  let env: Listening;

  afterEach(async () => {
    if (env) {
      await env.app.close();
      await env.storage.close();
    }
  });

  it('404s /mcp when the transport is disabled (the default)', async () => {
    env = await bootHttp({ remoteMcp: false });
    const res = await fetch(`${env.url}/mcp`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  describe('with --remote-mcp on', () => {
    let client: Client;

    beforeEach(async () => {
      env = await bootHttp({ remoteMcp: true });
      const transport = new StreamableHTTPClientTransport(new URL(`${env.url}/mcp`));
      client = new Client({ name: 'streamable-test', version: '0.0.0' });
      await client.connect(transport);
    });

    afterEach(async () => {
      await client.close();
    });

    it('lists the same 20-tool catalogue stdio exposes', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // Spot-check the headline ones — the full list lives in
      // packages/mcp-server/src/server.test.ts and is asserted there.
      expect(names).toContain('describe_model');
      expect(names).toContain('create_type');
      expect(names).toContain('draft');
      expect(names).toContain('publish');
      expect(names).toContain('find');
      expect(names).toContain('read');
      expect(names.length).toBe(20);
    });

    it('round-trips describe_model on an empty DB', async () => {
      const result = await client.callTool({ name: 'describe_model' });
      expect(Array.isArray(result.content)).toBe(true);
      const block = (result.content as Array<{ type: string; text: string }>)[0];
      expect(block?.type).toBe('text');
      const parsed = JSON.parse(block!.text) as { types: Record<string, unknown> };
      expect(parsed.types).toEqual({});
    });

    it('hands the server instructions through during initialize', async () => {
      const instructions = client.getInstructions();
      expect(instructions).toBeDefined();
      expect(instructions).toContain('describe_model');
      expect(instructions).toContain('wire_shape');
    });
  });

  describe('Origin header validation', () => {
    beforeEach(async () => {
      env = await bootHttp({ remoteMcp: true });
    });

    it('rejects a non-loopback Origin not in the allowlist', async () => {
      const res = await fetch(`${env.url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          origin: 'http://evil.example.com'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'evil', version: '0' }
          },
          id: 1
        })
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('FORBIDDEN');
    });

    it('accepts requests with no Origin header (non-browser clients)', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${env.url}/mcp`));
      const client = new Client({ name: 'no-origin', version: '0.0.0' });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      await client.close();
    });

    it('accepts a localhost Origin on any port', async () => {
      const res = await fetch(`${env.url}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          origin: 'http://localhost:54321'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'local-dev', version: '0' }
          },
          id: 1
        })
      });
      expect(res.status).not.toBe(403);
    });
  });
});
