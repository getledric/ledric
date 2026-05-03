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

interface BootOpts {
  http?: boolean;
  public?: boolean;
  publicUrl?: string;
  allowedOrigins?: readonly string[];
  allowedCidrs?: readonly string[];
}

async function bootHttp(opts: BootOpts = {}): Promise<Listening> {
  const storage = await openSqlite({ path: ':memory:' });
  const core = new Core(storage);
  const mcp = opts.http === true || opts.public === true
    ? {
        http: true as const,
        ...(opts.public === true ? { public: true as const } : {}),
        ...(opts.publicUrl !== undefined ? { publicUrl: opts.publicUrl } : {}),
        ...(opts.allowedOrigins !== undefined
          ? { allowedOrigins: opts.allowedOrigins }
          : {}),
        ...(opts.allowedCidrs !== undefined
          ? { allowedCidrs: opts.allowedCidrs }
          : {})
      }
    : undefined;
  // Public-MCP mode mounts the OAuth provider, which needs storage.
  // Auth is otherwise off (no keys minted) — auth-off mode lets the
  // tests focus on Origin/CIDR semantics.
  const auth = opts.public === true ? { storage } : undefined;
  const app = createHttpServer(core, {
    ...(mcp !== undefined ? { mcp } : {}),
    ...(auth !== undefined ? { auth } : {})
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
  let env: Listening | undefined;

  afterEach(async () => {
    if (env) {
      await env.app.close();
      await env.storage.close();
      env = undefined;
    }
  });

  it('404s /mcp when neither mcp.http nor mcp.public is set', async () => {
    env = await bootHttp();
    const res = await fetch(`${env.url}/mcp`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('refuses to boot in public mode without publicUrl', async () => {
    const storage = await openSqlite({ path: ':memory:' });
    const core = new Core(storage);
    expect(() => createHttpServer(core, { mcp: { public: true } })).toThrow(/publicUrl/);
    await storage.close();
  });

  describe('http-only mode (mcp.http: true, mcp.public: false)', () => {
    let client: Client;

    beforeEach(async () => {
      env = await bootHttp({ http: true });
      const transport = new StreamableHTTPClientTransport(new URL(`${env.url}/mcp`));
      client = new Client({ name: 'http-test', version: '0.0.0' });
      await client.connect(transport);
    });

    afterEach(async () => {
      await client.close();
    });

    it('lists the same 20-tool catalogue stdio exposes', async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toContain('describe_model');
      expect(names).toContain('create_type');
      expect(names).toContain('draft');
      expect(names).toContain('publish');
      expect(names.length).toBe(20);
    });

    it('round-trips describe_model on an empty DB', async () => {
      const result = await client.callTool({ name: 'describe_model' });
      const block = (result.content as Array<{ type: string; text: string }>)[0];
      expect(block?.type).toBe('text');
      const parsed = JSON.parse(block!.text) as { types: Record<string, unknown> };
      expect(parsed.types).toEqual({});
    });

    it('boots without publicUrl and the OAuth surface is absent', async () => {
      // /oauth and /.well-known endpoints don't exist in http-only
      // mode. They'll start existing once P2 lands and `public: true`
      // is set; until then both situations 404 these paths.
      const reg = await fetch(`${env!.url}/oauth/register`, { method: 'POST' });
      expect(reg.status).toBe(404);
      const meta = await fetch(`${env!.url}/.well-known/oauth-authorization-server`);
      expect(meta.status).toBe(404);
    });

    it('hands the server instructions through during initialize', async () => {
      const instructions = client.getInstructions();
      expect(instructions).toContain('describe_model');
      expect(instructions).toContain('wire_shape');
    });
  });

  describe('Origin validation — http-only mode (lenient)', () => {
    beforeEach(async () => {
      env = await bootHttp({ http: true });
    });

    it('rejects a non-loopback Origin not in the allowlist', async () => {
      const res = await initRequest(env!.url, 'http://evil.example.com');
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string } };
      expect(body.error?.code).toBe('FORBIDDEN');
    });

    it('accepts requests with no Origin header (non-browser clients)', async () => {
      const transport = new StreamableHTTPClientTransport(new URL(`${env!.url}/mcp`));
      const client = new Client({ name: 'no-origin', version: '0.0.0' });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      await client.close();
    });

    it('accepts a localhost Origin on any port (the dev-tooling escape)', async () => {
      const res = await initRequest(env!.url, 'http://localhost:54321');
      expect(res.status).not.toBe(403);
    });
  });

  describe('Origin validation — public mode (strict)', () => {
    beforeEach(async () => {
      env = await bootHttp({
        public: true,
        publicUrl: 'https://cms.example.com'
      });
    });

    it('accepts the configured publicUrl origin', async () => {
      const res = await initRequest(env!.url, 'https://cms.example.com');
      expect(res.status).not.toBe(403);
    });

    it('accepts the default https://claude.ai origin', async () => {
      const res = await initRequest(env!.url, 'https://claude.ai');
      expect(res.status).not.toBe(403);
    });

    it('REJECTS localhost origins — no dev-tooling escape in public mode', async () => {
      const res = await initRequest(env!.url, 'http://localhost:54321');
      expect(res.status).toBe(403);
    });

    it('rejects unrelated origins', async () => {
      const res = await initRequest(env!.url, 'http://evil.example.com');
      expect(res.status).toBe(403);
    });
  });

  describe('CIDR allowlist (mcp.allowedCidrs)', () => {
    it('accepts traffic from inside the allowlist (127.0.0.1/32)', async () => {
      env = await bootHttp({ http: true, allowedCidrs: ['127.0.0.1/32'] });
      const transport = new StreamableHTTPClientTransport(new URL(`${env.url}/mcp`));
      const client = new Client({ name: 'cidr-ok', version: '0.0.0' });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      await client.close();
    });

    it('rejects traffic from outside the allowlist with a clear error', async () => {
      env = await bootHttp({ http: true, allowedCidrs: ['10.0.0.0/8'] });
      const res = await fetch(`${env.url}/mcp`, { method: 'POST' });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error?: { code?: string; message?: string } };
      expect(body.error?.code).toBe('FORBIDDEN');
      expect(body.error?.message).toMatch(/IP/);
    });

    it('treats an empty/unset allowlist as allow-all', async () => {
      env = await bootHttp({ http: true });
      const res = await fetch(`${env.url}/mcp`, { method: 'POST' });
      // 400 from MCP transport (no init body) — but NOT 403 from CIDR.
      expect(res.status).not.toBe(403);
    });
  });
});

/**
 * Build a minimal valid initialize request — used by Origin-validation
 * tests where we want to drive a request manually with a controlled
 * Origin header rather than letting the SDK client manage it.
 */
async function initRequest(baseUrl: string, origin: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'origin-probe', version: '0' }
      },
      id: 1
    })
  });
}
