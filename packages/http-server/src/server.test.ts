import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { Core, FsTransformCache } from '@ledric/core';
import { openSqlite, type LedricStorage } from '@ledric/storage';
import { createHttpServer } from './server.js';
import type { FastifyInstance } from 'fastify';

describe('HTTP server', () => {
  let storage: LedricStorage;
  let app: FastifyInstance;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
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
    expect(Array.isArray(body.rpc_tools)).toBe(true);
    // Includes recent tools so agents discovering the surface see them.
    expect(body.rpc_tools).toContain('describe_model');
    expect(body.rpc_tools).toContain('migrate_entries');
    expect(body.notes.asset_transforms).toMatch(/imgix/i);
    expect(body.notes.ref_validation).toMatch(/@version/);
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

  it('GET /entries/:type?order=field:dir orders results by the named field', async () => {
    await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        tool: 'create_type',
        args: {
          name: 'post',
          fields: {
            title: { type: 'string', required: true },
            slug: { type: 'slug', from: 'title' },
            published_at: { type: 'date', required: true }
          },
          opts: { identifier_field: 'slug', display_field: 'title' }
        }
      }
    });
    // Insert in non-sorted order so the query has to do real work.
    for (const [title, date] of [
      ['Middle', '2026-03-15'],
      ['First', '2026-01-01'],
      ['Last', '2026-06-30']
    ] as const) {
      await app.inject({
        method: 'POST',
        url: '/rpc',
        payload: {
          tool: 'draft',
          args: { type: 'post', fields: { title, published_at: date } }
        }
      });
    }

    // ?order=published_at:desc — newest first.
    const desc = await app.inject({
      method: 'GET',
      url: '/entries/post?order=published_at:desc'
    });
    expect(desc.statusCode).toBe(200);
    const descBody = JSON.parse(desc.body);
    expect(descBody.results.map((r: { slug: string }) => r.slug)).toEqual(['last', 'middle', 'first']);

    // ?order=published_at:asc — oldest first.
    const asc = await app.inject({
      method: 'GET',
      url: '/entries/post?order=published_at:asc'
    });
    const ascBody = JSON.parse(asc.body);
    expect(ascBody.results.map((r: { slug: string }) => r.slug)).toEqual(['first', 'middle', 'last']);

    // Bare field name (no `:dir`) defaults to ascending.
    const bare = await app.inject({
      method: 'GET',
      url: '/entries/post?order=published_at'
    });
    const bareBody = JSON.parse(bare.body);
    expect(bareBody.results.map((r: { slug: string }) => r.slug)).toEqual(['first', 'middle', 'last']);
  });

  it('GET /entries/:type/:slug?published=true projects from published version', async () => {
    // Without this branch in storage, ?published=true was silently
    // ignored: the head/draft was returned regardless. Drafts leaked
    // straight to public consumers. Pin the projection here AND on
    // /rpc so neither path regresses.
    await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'create_type', args: {
        name: 'page',
        fields: { title: { type: 'string', required: true }, slug: { type: 'slug', from: 'title' } },
        opts: { identifier_field: 'slug', display_field: 'title' }
      }}
    });
    const drafted = await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'draft', args: { type: 'page', fields: { title: 'live', slug: 'about' } } }
    });
    const v1 = JSON.parse(drafted.body).result.version;
    await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'publish', args: { ref: { type: 'page', slug: 'about' }, version: v1 } }
    });
    // Stack a draft on top — head advances, published stays. Pin
    // slug so the title change doesn't accidentally rename the entry.
    await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'draft', args: { type: 'page', fields: { title: 'draft', slug: 'about' }, ref: { type: 'page', slug: 'about' }, parent_version: v1 } }
    });

    const head = await app.inject({ method: 'GET', url: '/entries/page/about' });
    expect(JSON.parse(head.body).fields.title).toBe('draft');

    const onlyPublished = await app.inject({ method: 'GET', url: '/entries/page/about?published=true' });
    expect(JSON.parse(onlyPublished.body).fields.title).toBe('live');

    // Same projection via /rpc { tool: read, args: { ..., published: true } }.
    const rpcRead = await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'read', args: { ref: { type: 'page', slug: 'about' }, published: true } }
    });
    expect(JSON.parse(rpcRead.body).result.fields.title).toBe('live');
  });

  it('GET /entries/:type/:slug?published=true 404s on never-published entries', async () => {
    await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'create_type', args: {
        name: 'page',
        fields: { title: { type: 'string', required: true }, slug: { type: 'slug', from: 'title' } },
        opts: { identifier_field: 'slug', display_field: 'title' }
      }}
    });
    await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'draft', args: { type: 'page', fields: { title: 'draft only' } } }
    });

    // Head is reachable.
    const head = await app.inject({ method: 'GET', url: '/entries/page/draft-only' });
    expect(head.statusCode).toBe(200);

    // Published-only is not — drafts must not be visible to public consumers.
    const live = await app.inject({ method: 'GET', url: '/entries/page/draft-only?published=true' });
    expect(live.statusCode).toBe(404);

    // /rpc returns null in that case (the MCP-shaped envelope unwraps to it).
    const rpcRead = await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'read', args: { ref: { type: 'page', slug: 'draft-only' }, published: true } }
    });
    expect(JSON.parse(rpcRead.body).result).toBeNull();
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

  it('GET /assets/:ref_key streams bytes with the right Content-Type', async () => {
    const bytes = Buffer.from('greetings', 'utf8');
    const write = await storage.createAsset({
      kind: 'file',
      bytes,
      meta: { mime: 'text/plain' }
    });
    const refKey = Buffer.from(write.ref_key).toString('hex');

    const res = await app.inject({ method: 'GET', url: `/assets/${refKey}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain');
    expect(res.rawPayload.equals(bytes)).toBe(true);
  });

  it('GET /assets/:ref_key with transform params resizes via sharp', async () => {
    const png = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } }
    })
      .png()
      .toBuffer();
    const write = await storage.createAsset({
      kind: 'image',
      bytes: png,
      meta: { mime: 'image/png' }
    });
    const refKey = Buffer.from(write.ref_key).toString('hex');

    const res = await app.inject({ method: 'GET', url: `/assets/${refKey}?w=80&fm=webp` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['x-ledric-transform']).toBe('applied');
    const meta = await sharp(res.rawPayload).metadata();
    expect(meta.width).toBe(80);
    expect(meta.format).toBe('webp');
  });

  it('GET /assets/:ref_key with auto=format adds Vary: Accept', async () => {
    const png = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 255, b: 0 } }
    })
      .png()
      .toBuffer();
    const write = await storage.createAsset({
      kind: 'image',
      bytes: png,
      meta: { mime: 'image/png' }
    });
    const refKey = Buffer.from(write.ref_key).toString('hex');

    const res = await app.inject({
      method: 'GET',
      url: `/assets/${refKey}?w=50&auto=format`,
      headers: { accept: 'image/avif,image/webp,*/*' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['vary']).toBe('Accept');
    expect(res.headers['content-type']).toBe('image/avif');
  });

  it('GET /assets/:ref_key passes non-image assets through untouched', async () => {
    const bytes = Buffer.from('hello pdf');
    const write = await storage.createAsset({
      kind: 'file',
      bytes,
      meta: { mime: 'application/pdf' }
    });
    const refKey = Buffer.from(write.ref_key).toString('hex');

    const res = await app.inject({ method: 'GET', url: `/assets/${refKey}?w=200&fm=webp` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['x-ledric-transform']).toBe('passthrough');
    expect(res.rawPayload.equals(bytes)).toBe(true);
  });

  it('GET /assets/:ref_key without transform params hits the fast bytes path', async () => {
    const bytes = Buffer.from('plain', 'utf8');
    const write = await storage.createAsset({
      kind: 'file',
      bytes,
      meta: { mime: 'text/plain' }
    });
    const refKey = Buffer.from(write.ref_key).toString('hex');

    const res = await app.inject({ method: 'GET', url: `/assets/${refKey}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ledric-transform']).toBeUndefined();
  });

  it('GET /assets/:id 302-redirects to the current ref_key, preserving query', async () => {
    const write = await storage.createAsset({
      kind: 'file',
      bytes: Buffer.from('redirect-me'),
      meta: { mime: 'text/plain' }
    });
    const id = Buffer.from(write.id).toString('hex');
    const refKey = Buffer.from(write.ref_key).toString('hex');
    expect(id).not.toBe(refKey);

    const plain = await app.inject({ method: 'GET', url: `/assets/${id}` });
    expect(plain.statusCode).toBe(302);
    expect(plain.headers.location).toBe(`/assets/${refKey}`);

    const withQs = await app.inject({ method: 'GET', url: `/assets/${id}?w=80&fm=webp` });
    expect(withQs.statusCode).toBe(302);
    expect(withQs.headers.location).toBe(`/assets/${refKey}?w=80&fm=webp`);
  });

  it('GET /assets/:something returns 404 when neither ref_key nor id match', async () => {
    const random = '0'.repeat(32);
    const res = await app.inject({ method: 'GET', url: `/assets/${random}` });
    expect(res.statusCode).toBe(404);
  });

  it('GET /assets/:key/meta accepts either a ref_key or an asset id', async () => {
    const write = await storage.createAsset({
      kind: 'file',
      bytes: Buffer.from('m'),
      meta: { mime: 'text/plain' }
    });
    const id = Buffer.from(write.id).toString('hex');
    const refKey = Buffer.from(write.ref_key).toString('hex');

    const byRef = await app.inject({ method: 'GET', url: `/assets/${refKey}/meta` });
    expect(byRef.statusCode).toBe(200);
    expect(JSON.parse(byRef.body).id).toBe(id);

    const byId = await app.inject({ method: 'GET', url: `/assets/${id}/meta` });
    expect(byId.statusCode).toBe(200);
    expect(JSON.parse(byId.body).ref_key).toBe(refKey);
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
    expect(json.ref_key).toMatch(/^[0-9a-f]{32}$/);
    expect(json.kind).toBe('image');
    expect(json.meta.mime).toBe('image/png');
    expect(json.meta.alt).toBe('a hero shot');
    expect(json.url).toBe(`/assets/${json.ref_key}`);

    // Round-trip: bytes are fetchable and identical via the ref_key URL.
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

  it('POST /rpc returns structured ValidationError details, not just a message', async () => {
    await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        tool: 'create_type',
        args: {
          name: 'cta',
          fields: {
            slug: { type: 'string', required: true },
            label: { type: 'string', required: true, max: 5 }
          }
        }
      }
    });
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        tool: 'draft',
        args: { type: 'cta', fields: { slug: 'x', label: 'way too long' } }
      }
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.error.errors)).toBe(true);
    expect(body.error.errors[0].path).toBe('/label');
    expect(body.error.errors[0].code).toBe('max');
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

  it('returns the structured error envelope on unmatched routes (no Fastify default leak)', async () => {
    // An agent probing /v1/types or any other guessed-at path should see
    // {error: {code, message}}, not Fastify's {message, error, statusCode}.
    const res = await app.inject({ method: 'GET', url: '/v1/types' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toMatch(/\/v1\/types/);
    // Fastify default keys must NOT appear at the top level.
    expect(body.statusCode).toBeUndefined();
    expect(body.message).toBeUndefined();
  });

  // /rpc has historically returned the raw core result, leaking the
  // legacy `content` field that MCP renames to `fields` at its tool
  // boundary. These tests pin the rename so the two surfaces stay
  // consistent.
  it('POST /rpc { tool: read } returns fields (not content)', async () => {
    await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'create_type', args: {
        name: 'post',
        fields: { title: { type: 'string', required: true }, slug: { type: 'slug', from: 'title' } },
        opts: { identifier_field: 'slug', display_field: 'title' }
      }}
    });
    await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'draft', args: { type: 'post', fields: { title: 'Hello' } } }
    });
    const res = await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'read', args: { ref: { type: 'post', slug: 'hello' } } }
    });
    const body = JSON.parse(res.body);
    expect(body.result).not.toBeNull();
    expect(body.result.fields).toMatchObject({ title: 'Hello' });
    expect(body.result.content).toBeUndefined();
  });

  it('POST /rpc { tool: find } projects fields on every result entry', async () => {
    await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'create_type', args: {
        name: 'post',
        fields: { title: { type: 'string', required: true }, slug: { type: 'slug', from: 'title' } },
        opts: { identifier_field: 'slug', display_field: 'title' }
      }}
    });
    for (const title of ['A', 'B']) {
      await app.inject({
        method: 'POST', url: '/rpc',
        payload: { tool: 'draft', args: { type: 'post', fields: { title } } }
      });
    }
    const res = await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'find', args: { type: 'post' } }
    });
    const body = JSON.parse(res.body);
    expect(body.result.results.length).toBe(2);
    for (const entry of body.result.results) {
      expect(entry.fields).toBeDefined();
      expect(entry.content).toBeUndefined();
    }
  });

  it('POST /rpc { tool: draft } returns the new entry with fields, not content', async () => {
    await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'create_type', args: {
        name: 'post',
        fields: { title: { type: 'string', required: true }, slug: { type: 'slug', from: 'title' } },
        opts: { identifier_field: 'slug', display_field: 'title' }
      }}
    });
    const res = await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'draft', args: { type: 'post', fields: { title: 'Hi' } } }
    });
    const body = JSON.parse(res.body);
    expect(body.result.fields).toMatchObject({ title: 'Hi' });
    expect(body.result.content).toBeUndefined();
  });

  // Always-on hardening (helmet, body limits, query bounds). These
  // are sensible defaults — no flag required, every operator gets them.
  it('always-on: helmet sets HSTS / nosniff / referrer-policy / permissions headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-permitted-cross-domain-policies']).toBe('none');
  });

  it('always-on: REST /entries/:type clamps ?limit to 1..200', async () => {
    await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'create_type', args: {
        name: 'note',
        fields: { title: { type: 'string', required: true }, slug: { type: 'slug', from: 'title' } },
        opts: { identifier_field: 'slug', display_field: 'title' }
      }}
    });
    const high = await app.inject({ method: 'GET', url: '/entries/note?limit=999' });
    expect(high.statusCode).toBe(400);
    expect(JSON.parse(high.body).error.code).toBe('INVALID_REQUEST');

    const zero = await app.inject({ method: 'GET', url: '/entries/note?limit=0' });
    expect(zero.statusCode).toBe(400);

    const ok = await app.inject({ method: 'GET', url: '/entries/note?limit=10' });
    expect(ok.statusCode).toBe(200);
  });

  it('always-on: REST /entries/:type rejects ?q over 256 chars', async () => {
    await app.inject({
      method: 'POST', url: '/rpc',
      payload: { tool: 'create_type', args: {
        name: 'note',
        fields: { title: { type: 'string', required: true }, slug: { type: 'slug', from: 'title' } },
        opts: { identifier_field: 'slug', display_field: 'title' }
      }}
    });
    const huge = 'x'.repeat(257);
    const res = await app.inject({ method: 'GET', url: `/entries/note?q=${huge}` });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe('INVALID_REQUEST');
  });

  it('always-on: POST /rpc rejects bodies over the 1 MiB per-route cap', async () => {
    // /rpc cap is 1 MiB, far below the 25 MiB global upload cap.
    // 1.5 MiB of JSON-shaped payload should fail-413; 0.5 MiB should
    // succeed (or fail for tool-specific reasons, but not on size).
    const huge = 'x'.repeat(1.5 * 1024 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: { tool: 'describe_model', args: { padding: huge } }
    });
    // Fastify returns 413 (FST_ERR_CTP_BODY_TOO_LARGE).
    expect(res.statusCode).toBe(413);
  });
});

describe('HTTP server with GUI mount', () => {
  let storage: LedricStorage;
  let app: FastifyInstance;
  let guiDir: string;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
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

  it("GUI HTML responses set CSP frame-ancestors 'self' (clickjacking guard)", async () => {
    // Both the mount-root + SPA-fallback paths should set the header.
    const root = await app.inject({
      method: 'GET',
      url: '/admin/',
      headers: { accept: 'text/html' }
    });
    expect(root.headers['content-security-policy']).toBe("frame-ancestors 'self'");

    const deep = await app.inject({
      method: 'GET',
      url: '/admin/types/blog/foo',
      headers: { accept: 'text/html' }
    });
    expect(deep.headers['content-security-policy']).toBe("frame-ancestors 'self'");
  });

  it('X-Forwarded-Prefix overrides <base href> so the proxy prefix wins', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/',
      headers: { accept: 'text/html', 'x-forwarded-prefix': '/ledric-admin' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<base href="/ledric-admin/">');
  });

  it('X-Forwarded-Prefix injects window.LEDRIC_BASE_URL for api.js', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/',
      headers: { accept: 'text/html', 'x-forwarded-prefix': '/ledric-admin' }
    });
    expect(res.body).toContain('window.LEDRIC_BASE_URL="/ledric-admin"');
  });

  it('no X-Forwarded-Prefix → no LEDRIC_BASE_URL script (falls back to window.location.origin)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/',
      headers: { accept: 'text/html' }
    });
    expect(res.body).not.toContain('LEDRIC_BASE_URL');
  });

  it('SPA deep-refresh under proxy prefix carries through to the injected base', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/types/blog_post/nested',
      headers: { accept: 'text/html', 'x-forwarded-prefix': '/ledric-admin/' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<base href="/ledric-admin/">');
    expect(res.body).toContain('window.LEDRIC_BASE_URL="/ledric-admin"');
  });
});

describe('HTTP server with auth (admin-protects-writes default)', () => {
  let storage: LedricStorage;
  let app: FastifyInstance;
  let adminSecret: string;
  let readerSecret: string;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
    const core = new Core(storage);

    // Seed one type so reads have something to find later.
    await core.createType({
      name: 'note',
      fields: {
        title: { type: 'string', required: true },
        slug: { type: 'slug', from: 'title' }
      },
      opts: { identifier_field: 'slug' }
    });

    // Mint keys via storage (mirrors what the CLI does on first boot).
    const { generateApiKey } = await import('@ledric/storage');
    const admin = generateApiKey('admin');
    const reader = generateApiKey('reader');
    await storage.createApiKey({ role: 'admin', label: 'admin', key_hash: admin.hash, key_prefix: admin.prefix });
    await storage.createApiKey({ role: 'reader', label: 'reader', key_hash: reader.hash, key_prefix: reader.prefix });
    adminSecret = admin.secret;
    readerSecret = reader.secret;

    app = createHttpServer(core, { auth: { storage } });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
  });

  it('GET / stays public — no key required', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /auth/status reports required:true when keys exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/status' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.required).toBe(true);
    expect(body.reads_open).toBe(true);
  });

  it('GET routes are open by default (no reader-key requirement)', async () => {
    const res = await app.inject({ method: 'GET', url: '/types' });
    expect(res.statusCode).toBe(200);
  });

  it('POST /rpc requires an admin key for write tools (no auth → 401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        tool: 'create_type',
        args: { name: 'note', fields: { title: { type: 'string', required: true } } }
      }
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('UNAUTHORIZED');
  });

  it('POST /rpc with a malformed token returns 401 (write tool)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: 'Bearer not-a-key' },
      payload: {
        tool: 'create_type',
        args: { name: 'note', fields: { title: { type: 'string', required: true } } }
      }
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /rpc with a reader key passes for read-only tools (describe_model)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: `Bearer ${readerSecret}` },
      payload: { tool: 'describe_model' }
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /rpc with a reader key returns 403 for write tools (create_type)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: `Bearer ${readerSecret}` },
      payload: {
        tool: 'create_type',
        args: { name: 'note', fields: { title: { type: 'string', required: true } } }
      }
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).error.code).toBe('FORBIDDEN');
  });

  it('POST /rpc with a reader key passes for find (read-only)', async () => {
    // Need a type to find against, so create it as admin first.
    await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: `Bearer ${adminSecret}` },
      payload: {
        tool: 'create_type',
        args: { name: 'note', fields: { title: { type: 'string', required: true } } }
      }
    });
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: `Bearer ${readerSecret}` },
      payload: { tool: 'find', args: { type: 'note' } }
    });
    expect(res.statusCode).toBe(200);
  });

  it('POST /rpc with an admin Bearer key passes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: `Bearer ${adminSecret}` },
      payload: { tool: 'describe_model' }
    });
    expect(res.statusCode).toBe(200);
  });

  it('X-Ledric-Key header works as an Authorization alternative', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { 'x-ledric-key': adminSecret },
      payload: { tool: 'describe_model' }
    });
    expect(res.statusCode).toBe(200);
  });

  it('revoked keys stop working immediately', async () => {
    const all = await storage.listApiKeys();
    const adminRow = all.find((r) => r.label === 'admin')!;
    await storage.revokeApiKey(adminRow.id);

    // Use a write tool here so the auth gate actually engages — reads
    // are open in default mode, so a revoked-key + read would return
    // 200 (auth gate skipped entirely).
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: `Bearer ${adminSecret}` },
      payload: {
        tool: 'create_type',
        args: { name: 'note', fields: { title: { type: 'string', required: true } } }
      }
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('HTTP server with auth (--require-reader-key mode)', () => {
  let storage: LedricStorage;
  let app: FastifyInstance;
  let readerSecret: string;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
    const core = new Core(storage);

    const { generateApiKey } = await import('@ledric/storage');
    const reader = generateApiKey('reader');
    await storage.createApiKey({ role: 'reader', label: 'reader', key_hash: reader.hash, key_prefix: reader.prefix });
    readerSecret = reader.secret;

    app = createHttpServer(core, { auth: { storage, requireReaderKey: true } });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
  });

  it('GET /types now requires a reader key', async () => {
    const blocked = await app.inject({ method: 'GET', url: '/types' });
    expect(blocked.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'GET',
      url: '/types',
      headers: { authorization: `Bearer ${readerSecret}` }
    });
    expect(ok.statusCode).toBe(200);
  });

  it('GET / still public even in strict mode', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
  });
});

describe('HTTP server with auth + env-var keys', () => {
  let storage: LedricStorage;
  let app: FastifyInstance;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
    const core = new Core(storage);

    // Pretend an operator set LEDRIC_ADMIN_KEY in the environment. The
    // value just has to look like a real key (right prefix shape).
    app = createHttpServer(core, {
      auth: {
        storage,
        envAdminKey: 'lka_envprovidedadminkey00000000000000000000000'
      }
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
  });

  it('env-supplied admin key authorizes writes even without DB-issued keys', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      headers: { authorization: 'Bearer lka_envprovidedadminkey00000000000000000000000' },
      payload: { tool: 'describe_model' }
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('HTTP server with auth-off (no keys exist)', () => {
  let storage: LedricStorage;
  let app: FastifyInstance;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
    const core = new Core(storage);
    // Auth wired but DB has zero active keys — should pass through.
    app = createHttpServer(core, { auth: { storage } });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
  });

  it('POST /rpc passes without a key when no keys are configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: { tool: 'describe_model' }
    });
    expect(res.statusCode).toBe(200);
  });

  it('GET /auth/status reports required:false when no keys exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ required: false, reads_open: true });
  });
});

describe('HTTP server with no auth configured at all', () => {
  let storage: LedricStorage;
  let app: FastifyInstance;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
    const core = new Core(storage);
    app = createHttpServer(core); // no auth opts
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
  });

  it('GET /auth/status still answers (default open) without auth opts', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ required: false, reads_open: true });
  });
});
