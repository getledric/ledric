import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Core } from '@ledric/core';
import { SqliteStorage } from '@ledric/storage';
import { createMcpServer } from './server.js';

interface TextBlock {
  type: 'text';
  text: string;
}

function firstText(content: unknown): string {
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('tool response had no content');
  }
  const block = content[0] as TextBlock;
  if (block.type !== 'text') {
    throw new Error(`expected text block, got ${block.type}`);
  }
  return block.text;
}

describe('MCP server (in-memory round trip)', () => {
  let storage: SqliteStorage;
  let client: Client;

  beforeEach(async () => {
    storage = await SqliteStorage.open({ path: ':memory:' });
    const core = new Core(storage);
    const server = createMcpServer(core);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
  });

  it('hands the server instructions to the client during initialize', async () => {
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect(instructions).toContain('describe_model');
    expect(instructions).toContain('alter_type');
    expect(instructions).toContain('_locale');
    expect(instructions).toContain(':::ref{');
    // Recent functionality must be discoverable from the instructions
    // string alone — agents shouldn't have to guess that these features
    // exist.
    expect(instructions).toContain('jss');
    expect(instructions).toContain('css');
    expect(instructions).toContain('object');
    expect(instructions).toMatch(/imgix/i);
    expect(instructions).toMatch(/auto=format/);
    expect(instructions).toMatch(/@version/);
    expect(instructions).toMatch(/_warnings/);
    expect(instructions).toMatch(/VALIDATION_FAILED/);
    expect(instructions).toMatch(/VERSION_CONFLICT/);
    expect(instructions).toMatch(/default/i);
  });

  it('lists the full slice toolset', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'alter_type',
      'create_type',
      'describe_model',
      'draft',
      'find',
      'get_asset',
      'list_assets',
      'migrate_entries',
      'publish',
      'read',
      'rename_entry'
    ]);
  });

  it('rename_entry retires the old slug; reads of it return _redirect', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true },
          slug: { type: 'slug', from: 'title' }
        }
      }
    });
    await client.callTool({
      name: 'draft',
      arguments: { type: 'note', fields: { title: 'First' } }
    });

    const renamed = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'rename_entry',
          arguments: {
            ref: { type: 'note', slug: 'first' },
            new_slug: 'the-first-note'
          }
        })
      ).content
    ));
    expect(renamed.old_slug).toBe('first');
    expect(renamed.new_slug).toBe('the-first-note');

    // Read by new slug — direct hit, no redirect.
    const direct = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'read',
          arguments: { ref: { type: 'note', slug: 'the-first-note' } }
        })
      ).content
    ));
    expect(direct.slug).toBe('the-first-note');
    expect(direct._redirect).toBeUndefined();

    // Read by old slug — returns current entry with _redirect.
    const redirected = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'read',
          arguments: { ref: { type: 'note', slug: 'first' } }
        })
      ).content
    ));
    expect(redirected.slug).toBe('the-first-note');
    expect(redirected._redirect).toEqual({ from: 'first', to: 'the-first-note' });
  });

  it('localization: draft + read project per-locale; rename per-locale slug works', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'post',
        fields: {
          title: { type: 'string', required: true, localized: true },
          slug: { type: 'slug', from: 'title', localized: true },
          body: { type: 'markdown', localized: true },
          published_at: { type: 'date' }
        },
        opts: {
          locales: ['en', 'fr', 'de'],
          default_locale: 'en',
          fallback: { de: 'fr' },
          identifier_field: 'slug'
        }
      }
    });

    // Draft with English at the top, FR + DE inside _locale (DE sparse).
    const drafted = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'draft',
          arguments: {
            type: 'post',
            fields: {
              title: 'Hello World',
              body: '## hi',
              published_at: '2026-04-25',
              _locale: {
                fr: { title: 'Bonjour le monde', body: '## salut' },
                de: { title: 'Hallo Welt' } // body / slug intentionally missing
              }
            }
          }
        })
      ).content
    ));
    expect(drafted.slug).toBe('hello-world');
    expect(drafted.content._locale.fr.slug).toBe('bonjour-le-monde');
    expect(drafted.content._locale.de.slug).toBe('hallo-welt');

    // Default-locale read: top-level fields, _locale stripped.
    const en = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'read',
          arguments: { ref: { type: 'post', slug: 'hello-world' } }
        })
      ).content
    ));
    expect(en.content.title).toBe('Hello World');
    expect(en.content._locale).toBeUndefined();

    // FR read by FR slug — gets FR projection.
    const fr = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'read',
          arguments: {
            ref: { type: 'post', slug: 'bonjour-le-monde' },
            locale: 'fr'
          }
        })
      ).content
    ));
    expect(fr.content.title).toBe('Bonjour le monde');
    expect(fr.content.body).toBe('## salut');

    // DE read — title from de, body falls through de → fr (per fallback).
    const de = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'read',
          arguments: {
            ref: { type: 'post', slug: 'hallo-welt' },
            locale: 'de'
          }
        })
      ).content
    ));
    expect(de.content.title).toBe('Hallo Welt');
    expect(de.content.body).toBe('## salut');

    // Rename FR slug — old FR slug should redirect.
    const renamed = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'rename_entry',
          arguments: {
            ref: { type: 'post', slug: 'bonjour-le-monde' },
            new_slug: 'salut-le-monde',
            locale: 'fr'
          }
        })
      ).content
    ));
    expect(renamed.locale).toBe('fr');
    expect(renamed.new_slug).toBe('salut-le-monde');

    const oldFr = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'read',
          arguments: {
            ref: { type: 'post', slug: 'bonjour-le-monde' },
            locale: 'fr'
          }
        })
      ).content
    ));
    expect(oldFr._redirect).toEqual({
      from: 'bonjour-le-monde',
      to: 'salut-le-monde',
      locale: 'fr'
    });

    // Default-locale slug still works untouched.
    const stillEn = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'read',
          arguments: { ref: { type: 'post', slug: 'hello-world' } }
        })
      ).content
    ));
    expect(stillEn.slug).toBe('hello-world');
  });

  it('localization: validator rejects unknown locales and non-localized fields in _locale', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'post',
        fields: {
          title: { type: 'string', required: true, localized: true },
          slug: { type: 'slug', from: 'title', localized: true },
          published_at: { type: 'date' } // NOT localized
        },
        opts: { locales: ['en', 'fr'], default_locale: 'en' }
      }
    });

    const unknownLocale = await client.callTool({
      name: 'draft',
      arguments: {
        type: 'post',
        fields: {
          title: 'Hello',
          _locale: { es: { title: 'Hola' } }
        }
      }
    });
    expect(unknownLocale.isError).toBe(true);
    expect(firstText(unknownLocale.content)).toMatch(/unknown_locale|VALIDATION_FAILED/);

    const notLocalized = await client.callTool({
      name: 'draft',
      arguments: {
        type: 'post',
        fields: {
          title: 'Hello',
          _locale: { fr: { title: 'Bonjour', published_at: '2026-04-25' } }
        }
      }
    });
    expect(notLocalized.isError).toBe(true);
    expect(firstText(notLocalized.content)).toMatch(/not_localized|VALIDATION_FAILED/);
  });

  it('rename_entry rejects an invalid slug format', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true },
          slug: { type: 'slug', from: 'title' }
        }
      }
    });
    await client.callTool({
      name: 'draft',
      arguments: { type: 'note', fields: { title: 'First' } }
    });

    const bad = await client.callTool({
      name: 'rename_entry',
      arguments: {
        ref: { type: 'note', slug: 'first' },
        new_slug: 'NOT VALID'
      }
    });
    expect(bad.isError).toBe(true);
    expect(firstText(bad.content)).toMatch(/VALIDATION_FAILED/);
  });

  it('migrate_entries: safe alter, then re-stamp existing entries with the new schema_version', async () => {
    // Create type at v1 with just title + slug.
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true },
          slug: { type: 'slug', from: 'title' }
        }
      }
    });
    // Draft two entries under v1.
    await client.callTool({
      name: 'draft',
      arguments: { type: 'note', fields: { title: 'First' } }
    });
    await client.callTool({
      name: 'draft',
      arguments: { type: 'note', fields: { title: 'Second' } }
    });

    // Alter type to v2 adding optional tags. Entries still match (safe class).
    await client.callTool({
      name: 'alter_type',
      arguments: {
        name: 'note',
        parent_version: 1,
        merge_patch: { fields: { tags: { type: 'array', of: { type: 'string' } } } }
      }
    });

    // Migrate: no transform, just re-stamp.
    const migrated = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'migrate_entries',
          arguments: { type: 'note' }
        })
      ).content
    ));
    expect(migrated.schema_version).toBe(2);
    expect(migrated.checked).toBe(2);
    expect(migrated.migrated).toBe(2);
    expect(migrated.failed).toEqual([]);

    // Both entries now stamped with schema_version 2.
    const read = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'read',
          arguments: { ref: { type: 'note', slug: 'first' } }
        })
      ).content
    ));
    expect(read.schema_version).toBe(2);
  });

  it('migrate_entries with merge_patch mutates content and bumps versions', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true },
          slug: { type: 'slug', from: 'title' },
          tags: { type: 'array', of: { type: 'string' } }
        }
      }
    });
    await client.callTool({
      name: 'draft',
      arguments: { type: 'note', fields: { title: 'First', tags: ['a'] } }
    });

    const result = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'migrate_entries',
          arguments: {
            type: 'note',
            merge_patch: { tags: ['a', 'migrated'] }
          }
        })
      ).content
    ));
    expect(result.migrated).toBe(1);
    expect(result.failed).toEqual([]);

    const read = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'read',
          arguments: { ref: { type: 'note', slug: 'first' } }
        })
      ).content
    ));
    expect(read.content.tags).toEqual(['a', 'migrated']);
    expect(read.current_version).toBe(2);
  });

  it('migrate_entries with dry_run does not write', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true },
          slug: { type: 'slug', from: 'title' }
        }
      }
    });
    await client.callTool({
      name: 'draft',
      arguments: { type: 'note', fields: { title: 'First' } }
    });

    const result = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'migrate_entries',
          arguments: {
            type: 'note',
            merge_patch: { title: 'Changed' },
            dry_run: true
          }
        })
      ).content
    ));
    expect(result.migrated).toBe(1);
    expect(result.dry_run).toBe(true);

    const read = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'read',
          arguments: { ref: { type: 'note', slug: 'first' } }
        })
      ).content
    ));
    expect(read.content.title).toBe('First');
    expect(read.current_version).toBe(1);
  });

  it('migrate_entries collects validation failures without aborting', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true },
          slug: { type: 'slug', from: 'title' }
        }
      }
    });
    await client.callTool({
      name: 'draft',
      arguments: { type: 'note', fields: { title: 'Ok' } }
    });

    // alter_type to add a required field without a default —
    // existing entries will fail validation on the next migrate pass.
    await client.callTool({
      name: 'alter_type',
      arguments: {
        name: 'note',
        parent_version: 1,
        merge_patch: {
          fields: { author: { type: 'string', required: true } }
        }
      }
    });

    const result = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'migrate_entries',
          arguments: { type: 'note' }
        })
      ).content
    ));
    expect(result.failed.length).toBe(1);
    expect(result.failed[0].errors[0].code).toBe('required');
  });

  it('alter_type with dry_run returns change_class without writing', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true, max: 200 },
          slug: { type: 'slug', from: 'title' }
        }
      }
    });

    const dryRun = await client.callTool({
      name: 'alter_type',
      arguments: {
        name: 'note',
        parent_version: 1,
        merge_patch: {
          fields: { tags: { type: 'array', of: { type: 'string' }, max: 20 } }
        },
        dry_run: true
      }
    });
    const dryRunResult = JSON.parse(firstText(dryRun.content));
    expect(dryRunResult.change_class).toBe('safe');
    expect(dryRunResult.dry_run).toBe(true);
    expect(dryRunResult.version).toBe(1); // unchanged

    const after = JSON.parse(firstText(
      (await client.callTool({ name: 'describe_model' })).content
    ));
    expect(after.types.note.version).toBe(1);
    expect(after.types.note.fields.tags).toBeUndefined();
  });

  it('alter_type applied: safe change adds a field and bumps version', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true },
          slug: { type: 'slug', from: 'title' }
        }
      }
    });

    const applied = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'alter_type',
          arguments: {
            name: 'note',
            parent_version: 1,
            merge_patch: {
              fields: { tags: { type: 'array', of: { type: 'string' }, max: 20 } }
            }
          }
        })
      ).content
    ));
    expect(applied.change_class).toBe('safe');
    expect(applied.version).toBe(2);

    const after = JSON.parse(firstText(
      (await client.callTool({ name: 'describe_model' })).content
    ));
    expect(after.types.note.version).toBe(2);
    expect(after.types.note.fields.tags).toEqual({
      type: 'array',
      of: { type: 'string' },
      max: 20
    });
  });

  it('alter_type classifies field removal as destructive', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true },
          slug: { type: 'slug', from: 'title' },
          body: { type: 'markdown' }
        }
      }
    });

    const result = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'alter_type',
          arguments: {
            name: 'note',
            parent_version: 1,
            merge_patch: { fields: { body: null } },
            dry_run: true
          }
        })
      ).content
    ));
    expect(result.change_class).toBe('destructive');
  });

  it('alter_type classifies required-field add as needs_backfill', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true },
          slug: { type: 'slug', from: 'title' }
        }
      }
    });

    const result = JSON.parse(firstText(
      (
        await client.callTool({
          name: 'alter_type',
          arguments: {
            name: 'note',
            parent_version: 1,
            merge_patch: {
              fields: { author: { type: 'string', required: true } }
            },
            dry_run: true
          }
        })
      ).content
    ));
    expect(result.change_class).toBe('needs_backfill');
  });

  it('draft → read → find → publish round trip', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true, max: 200 },
          slug: { type: 'slug', from: 'title' },
          body: { type: 'markdown' }
        },
        opts: { identifier_field: 'slug', display_field: 'title' }
      }
    });

    const drafted = JSON.parse(
      firstText(
        (
          await client.callTool({
            name: 'draft',
            arguments: {
              type: 'note',
              fields: { title: 'Hello World', body: '## hi' }
            }
          })
        ).content
      )
    );
    expect(drafted.type).toBe('note');
    expect(drafted.slug).toBe('hello-world');
    expect(drafted.version).toBe(1);
    expect(drafted.status).toBe('draft');

    const read = JSON.parse(
      firstText(
        (
          await client.callTool({
            name: 'read',
            arguments: { ref: { type: 'note', slug: 'hello-world' } }
          })
        ).content
      )
    );
    expect(read.current_version).toBe(1);
    expect(read.content.title).toBe('Hello World');
    expect(read.content.body).toBe('## hi');

    const found = JSON.parse(
      firstText(
        (await client.callTool({ name: 'find', arguments: { type: 'note' } })).content
      )
    );
    expect(found.total).toBe(1);
    expect(found.results[0].slug).toBe('hello-world');

    const published = JSON.parse(
      firstText(
        (
          await client.callTool({
            name: 'publish',
            arguments: { ref: { type: 'note', slug: 'hello-world' } }
          })
        ).content
      )
    );
    expect(published.published_version).toBe(1);

    const readAfterPublish = JSON.parse(
      firstText(
        (
          await client.callTool({
            name: 'read',
            arguments: { ref: { type: 'note', slug: 'hello-world' } }
          })
        ).content
      )
    );
    expect(readAfterPublish.published_version).toBe(1);
  });

  it('draft rejects content that fails validation', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'product',
        fields: {
          title: { type: 'string', required: true, max: 10 },
          slug: { type: 'slug', from: 'title' },
          price: { type: 'number', min: 0 }
        }
      }
    });

    const bad = await client.callTool({
      name: 'draft',
      arguments: {
        type: 'product',
        fields: { title: 'way too long a title', price: -5 }
      }
    });
    expect(bad.isError).toBe(true);
    expect(firstText(bad.content)).toMatch(/VALIDATION_FAILED/);
  });

  it('updating with stale parent_version yields a VERSION_CONFLICT', async () => {
    await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'note',
        fields: {
          title: { type: 'string', required: true },
          slug: { type: 'slug', from: 'title' }
        }
      }
    });

    const created = JSON.parse(
      firstText(
        (
          await client.callTool({
            name: 'draft',
            arguments: { type: 'note', fields: { title: 'First' } }
          })
        ).content
      )
    );
    expect(created.version).toBe(1);

    await client.callTool({
      name: 'draft',
      arguments: {
        type: 'note',
        ref: { type: 'note', slug: 'first' },
        parent_version: 1,
        fields: { title: 'First', slug: 'first' }
      }
    });

    const conflict = await client.callTool({
      name: 'draft',
      arguments: {
        type: 'note',
        ref: { type: 'note', slug: 'first' },
        parent_version: 1,
        fields: { title: 'First', slug: 'first' }
      }
    });
    expect(conflict.isError).toBe(true);
    expect(firstText(conflict.content)).toMatch(/VERSION_CONFLICT/);
  });

  it('describe_model on an empty DB has no types', async () => {
    const result = await client.callTool({ name: 'describe_model' });
    const parsed = JSON.parse(firstText(result.content));
    expect(parsed.types).toEqual({});
    expect(parsed.schema_version).toBe(0);
  });

  it('create_type then describe_model round trip', async () => {
    const created = await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'product',
        fields: {
          title: { type: 'string', required: true, max: 120 },
          price: { type: 'number', min: 0 }
        },
        opts: { summary_fields: ['title', 'price'] }
      }
    });
    const createdParsed = JSON.parse(firstText(created.content));
    expect(createdParsed.name).toBe('product');
    expect(createdParsed.version).toBe(1);

    const described = await client.callTool({ name: 'describe_model' });
    const describedParsed = JSON.parse(firstText(described.content));
    expect(Object.keys(describedParsed.types)).toEqual(['product']);
    expect(describedParsed.types.product.fields.title.max).toBe(120);
    expect(describedParsed.schema_version).toBe(1);
  });

  it('surfaces validation errors as isError tool responses', async () => {
    const result = await client.callTool({
      name: 'create_type',
      arguments: {
        name: 'Bad-Name',
        fields: { title: { type: 'string' } }
      }
    });
    expect(result.isError).toBe(true);
    expect(firstText(result.content)).toMatch(/type name/);
  });
});
