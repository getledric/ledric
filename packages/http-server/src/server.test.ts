import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core } from '@ledric/core';
import { SqliteStorage } from '@ledric/storage';
import { createHttpServer } from './server.js';
import type { FastifyInstance } from 'fastify';

describe('HTTP server', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;

  beforeEach(async () => {
    storage = await SqliteStorage.open({ path: ':memory:' });
    const core = new Core(storage);
    app = createHttpServer(core);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
  });

  it('GET / returns the endpoint catalogue', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.name).toBe('ledric');
    expect(Array.isArray(body.endpoints)).toBe(true);
  });

  it('POST /rpc drives create_type → describe_model roundtrip', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        tool: 'create_type',
        args: {
          name: 'note',
          fields: {
            title: { type: 'string', required: true },
            slug: { type: 'slug', from: 'title' }
          }
        }
      }
    });
    expect(created.statusCode).toBe(200);
    expect(JSON.parse(created.body).result.name).toBe('note');

    const describe = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: { tool: 'describe_model' }
    });
    expect(describe.statusCode).toBe(200);
    const body = JSON.parse(describe.body);
    expect(body.result.types.note).toBeDefined();
  });

  it('GET /entries/:type/:slug returns the consumer shape', async () => {
    await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        tool: 'create_type',
        args: {
          name: 'note',
          fields: {
            title: { type: 'string', required: true },
            slug: { type: 'slug', from: 'title' }
          }
        }
      }
    });
    await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        tool: 'draft',
        args: { type: 'note', fields: { title: 'Hello World' } }
      }
    });

    const res = await app.inject({ method: 'GET', url: '/entries/note/hello-world' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.slug).toBe('hello-world');
    expect(body.fields.title).toBe('Hello World');
    // No internal fields leak through.
    expect(body.content_hash).toBeUndefined();
    expect(body.schema_version).toBeUndefined();
  });

  it('GET /entries/:type/:slug 404s on missing entry', async () => {
    await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        tool: 'create_type',
        args: {
          name: 'note',
          fields: {
            title: { type: 'string', required: true },
            slug: { type: 'slug', from: 'title' }
          }
        }
      }
    });
    const res = await app.inject({ method: 'GET', url: '/entries/note/ghost' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('GET /assets/:id streams bytes with the right Content-Type', async () => {
    const bytes = Buffer.from('greetings', 'utf8');
    const write = await storage.createAsset({
      kind: 'file',
      bytes,
      meta: { mime: 'text/plain' }
    });
    const id = Buffer.from(write.id).toString('hex');

    const res = await app.inject({ method: 'GET', url: `/assets/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.rawPayload.equals(bytes)).toBe(true);
  });

  it('GET /entries/:type/:slug returns a 301 when the slug was renamed', async () => {
    await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        tool: 'create_type',
        args: {
          name: 'note',
          fields: {
            title: { type: 'string', required: true },
            slug: { type: 'slug', from: 'title' }
          }
        }
      }
    });
    await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: { tool: 'draft', args: { type: 'note', fields: { title: 'First' } } }
    });
    await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        tool: 'rename_entry',
        args: {
          ref: { type: 'note', slug: 'first' },
          new_slug: 'the-first-note'
        }
      }
    });

    const res = await app.inject({ method: 'GET', url: '/entries/note/first' });
    expect(res.statusCode).toBe(301);
    expect(res.headers.location).toBe('/entries/note/the-first-note');
    expect(res.headers['x-ledric-redirect']).toBe('the-first-note');

    const direct = await app.inject({ method: 'GET', url: '/entries/note/the-first-note' });
    expect(direct.statusCode).toBe(200);
    expect(JSON.parse(direct.body).slug).toBe('the-first-note');
  });

  it('POST /assets accepts a multipart upload and creates an asset', async () => {
    const boundary = '----TestBoundary' + Math.random().toString(36).slice(2);
    const fileBytes = Buffer.from('PNGFAKEBYTES');
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="file"; filename="hero.png"\r\n'),
      Buffer.from('Content-Type: image/png\r\n\r\n'),
      fileBytes,
      Buffer.from(`\r\n--${boundary}\r\n`),
      Buffer.from('Content-Disposition: form-data; name="alt"\r\n\r\n'),
      Buffer.from('a hero shot'),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/assets',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`
      },
      payload: body
    });
    expect(res.statusCode).toBe(201);
    const json = JSON.parse(res.body);
    expect(json.id).toMatch(/^[0-9a-f]{32}$/);
    expect(json.kind).toBe('image');
    expect(json.meta.mime).toBe('image/png');
    expect(json.meta.alt).toBe('a hero shot');
    expect(json.url).toBe(`/assets/${json.id}`);

    // Round-trip: bytes are fetchable and identical.
    const bytesRes = await app.inject({ method: 'GET', url: json.url });
    expect(bytesRes.statusCode).toBe(200);
    expect(bytesRes.headers['content-type']).toBe('image/png');
    expect(bytesRes.rawPayload.equals(fileBytes)).toBe(true);
  });

  it('POST /assets rejects non-multipart requests', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/assets',
      headers: { 'content-type': 'application/json' },
      payload: '{}'
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_REQUEST');
  });

  it('POST /rpc surfaces unknown tool as 400 TOOL_ERROR', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: { tool: 'nope', args: {} }
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('TOOL_ERROR');
    expect(body.error.message).toMatch(/Unknown tool/);
  });
});

describe('HTTP server with GUI mount', () => {
  let storage: SqliteStorage;
  let app: FastifyInstance;
  let guiDir: string;

  beforeEach(async () => {
    storage = await SqliteStorage.open({ path: ':memory:' });
    guiDir = mkdtempSync(join(tmpdir(), 'ledric-gui-test-'));
    writeFileSync(
      join(guiDir, 'index.html'),
      '<!doctype html><html><head><title>ledric</title></head><body><h1>admin</h1></body></html>'
    );
    writeFileSync(join(guiDir, 'app.js'), 'console.log("admin")');
    app = createHttpServer(new Core(storage), {
      gui: { assetsPath: guiDir, mountPath: '/admin' }
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(guiDir, { recursive: true, force: true });
  });

  it('serves index.html at the mount path', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('admin');
    expect(res.headers['content-type']).toContain('text/html');
  });

  it('serves additional static files at the mount path', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('admin');
  });

  it('does not interfere with API routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/types' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).schema_version).toBeDefined();
  });

  it('serves index.html for client-side routes (SPA fallback)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/types/blog_post',
      headers: { accept: 'text/html' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('admin');
  });

  it('serves index.html at the mount root with <base href> injected', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/',
      headers: { accept: 'text/html' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<base href="/admin/">');
  });

  it('deep refreshes get the same injected base href so relative imports keep working', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/types/blog_post/something/nested',
      headers: { accept: 'text/html' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<base href="/admin/">');
  });

  it('JSON 404s do not get rewritten to index.html', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/types/nope',
      headers: { accept: 'application/json' }
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND');
  });
});
