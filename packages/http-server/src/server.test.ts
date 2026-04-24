import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
