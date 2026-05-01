import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { defineCommand } from 'citty';
import { Core } from '@ledric/core';
import { openSqlite, NotFoundError } from '@ledric/storage';
import type { AssetsConfig } from '@ledric/storage';

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function guessMime(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  const MAP: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/markdown'
  };
  return MAP[ext];
}

function guessKind(mime: string | undefined): string {
  if (mime === undefined) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function assetsConfigFromArgs(args: { assetsBackend?: string; assetsRoot?: string }): AssetsConfig {
  if (args.assetsBackend === 'local') {
    return { backend: 'local', root: args.assetsRoot ?? './ledric-assets' };
  }
  return { backend: 'db' };
}

/** Comma-separated `--tag "Featured Event, hero"` → ["Featured Event", "hero"]. */
function splitTags(raw: string | undefined): string[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  return raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
}

const uploadCommand = defineCommand({
  meta: {
    name: 'upload',
    description: 'Upload a file as an asset. Writes to the configured backend.'
  },
  args: {
    file: {
      type: 'positional',
      description: 'Path to the file to upload.',
      required: true
    },
    db: {
      type: 'string',
      description: 'Path to the SQLite database file.',
      default: './ledric.db'
    },
    kind: {
      type: 'string',
      description: 'Asset kind (image, video, audio, file). Auto-detected from extension if omitted.'
    },
    mime: {
      type: 'string',
      description: 'MIME type. Auto-detected from extension if omitted.'
    },
    alt: {
      type: 'string',
      description: 'Alt text (for images; stored in meta).'
    },
    'assets-backend': {
      type: 'string',
      description: 'Asset backend: db (default) or local.'
    },
    'assets-root': {
      type: 'string',
      description: 'For the local backend: directory where bytes are written (default ./ledric-assets).'
    },
    tag: {
      type: 'string',
      description: 'Comma-separated initial tags ("Featured Event, hero, q4").'
    }
  },
  async run({ args }) {
    const abs = path.resolve(args.file);
    const bytes = await fs.readFile(abs);
    const mime = args.mime ?? guessMime(abs);
    const kind = args.kind ?? guessKind(mime);
    const tags = splitTags(args.tag);

    const storage = await openSqlite({
      path: args.db,
      assets: assetsConfigFromArgs({
        assetsBackend: args['assets-backend'],
        assetsRoot: args['assets-root']
      })
    });
    try {
      const core = new Core(storage);
      const result = await core.uploadAsset({
        kind,
        bytes,
        meta: {
          ...(mime !== undefined ? { mime } : {}),
          ...(args.alt !== undefined ? { alt: args.alt } : {})
        },
        ...(tags.length > 0 ? { tags } : {})
      });
      process.stdout.write(
        JSON.stringify(
          {
            id: toHex(result.id),
            ref_key: toHex(result.ref_key),
            version: result.version,
            kind: result.kind,
            storage_ref: result.storage_ref,
            meta: result.meta
          },
          null,
          2
        ) + '\n'
      );
    } finally {
      await storage.close();
    }
  }
});

const lsCommand = defineCommand({
  meta: {
    name: 'ls',
    description: 'List assets.'
  },
  args: {
    db: {
      type: 'string',
      description: 'Path to the SQLite database file.',
      default: './ledric.db'
    },
    kind: {
      type: 'string',
      description: 'Filter by kind (image / video / file / …).'
    },
    tag: {
      type: 'string',
      description: 'Comma-separated tag filter (AND semantics).'
    },
    limit: {
      type: 'string',
      default: '50'
    },
    offset: {
      type: 'string',
      default: '0'
    }
  },
  async run({ args }) {
    const storage = await openSqlite({ path: args.db });
    try {
      const core = new Core(storage);
      const tags = splitTags(args.tag);
      const result = await core.listAssets({
        ...(args.kind !== undefined ? { kind: args.kind } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        limit: parseInt(args.limit, 10),
        offset: parseInt(args.offset, 10)
      });
      process.stdout.write(
        JSON.stringify(
          {
            total: result.total,
            offset: result.offset,
            results: result.results.map((r) => ({
              id: toHex(r.id),
              ref_key: toHex(r.ref_key),
              kind: r.kind,
              version: r.current_version,
              storage_ref: r.storage_ref,
              meta: r.meta
            }))
          },
          null,
          2
        ) + '\n'
      );
    } finally {
      await storage.close();
    }
  }
});

const getCommand = defineCommand({
  meta: {
    name: 'get',
    description: 'Read asset metadata by id (32-char hex).'
  },
  args: {
    id: {
      type: 'positional',
      description: 'Asset id (hex).',
      required: true
    },
    db: {
      type: 'string',
      default: './ledric.db'
    },
    version: {
      type: 'string',
      description: 'Specific historical version.'
    }
  },
  async run({ args }) {
    const storage = await openSqlite({ path: args.db });
    try {
      const core = new Core(storage);
      const versionNum = args.version ? parseInt(args.version, 10) : undefined;
      const asset = await core.getAsset({
        id: args.id,
        ...(versionNum !== undefined ? { version: versionNum } : {})
      });
      if (!asset) {
        process.stderr.write(`ledric: no asset ${args.id} in ${args.db}\n`);
        process.exit(1);
      }
      process.stdout.write(
        JSON.stringify(
          {
            id: toHex(asset.id),
            ref_key: toHex(asset.ref_key),
            kind: asset.kind,
            version: asset.version,
            current_version: asset.current_version,
            published_version: asset.published_version,
            storage_ref: asset.storage_ref,
            meta: asset.meta,
            author: asset.author,
            created_at: new Date(asset.created_at).toISOString()
          },
          null,
          2
        ) + '\n'
      );
    } catch (err) {
      if (err instanceof NotFoundError) {
        process.stderr.write(`ledric: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    } finally {
      await storage.close();
    }
  }
});

const bytesCommand = defineCommand({
  meta: {
    name: 'bytes',
    description: 'Write asset bytes to stdout.'
  },
  args: {
    id: {
      type: 'positional',
      description: 'Asset id (hex).',
      required: true
    },
    db: {
      type: 'string',
      default: './ledric.db'
    },
    version: {
      type: 'string'
    },
    'assets-root': {
      type: 'string',
      description: 'For local-backend assets: directory where bytes live (default ./ledric-assets).'
    }
  },
  async run({ args }) {
    const storage = await openSqlite({
      path: args.db,
      assets: {
        backend: 'local',
        root: args['assets-root'] ?? './ledric-assets'
      }
    });
    try {
      const core = new Core(storage);
      const versionNum = args.version ? parseInt(args.version, 10) : undefined;
      const bytes = await core.readAssetBytes({
        id: args.id,
        ...(versionNum !== undefined ? { version: versionNum } : {})
      });
      process.stdout.write(bytes);
    } catch (err) {
      if (err instanceof NotFoundError) {
        process.stderr.write(`ledric: ${err.message}\n`);
        process.exit(1);
      }
      throw err;
    } finally {
      await storage.close();
    }
  }
});

const replaceCommand = defineCommand({
  meta: {
    name: 'replace',
    description:
      'Replace the bytes of an existing asset in place. Bumps version, mints a fresh ref_key, leaves the asset id intact so entry references keep resolving.'
  },
  args: {
    id: {
      type: 'positional',
      description: 'Asset id (32-char hex).',
      required: true
    },
    file: {
      type: 'positional',
      description: 'Path to the new bytes.',
      required: true
    },
    db: {
      type: 'string',
      description: 'Path to the SQLite database file.',
      default: './ledric.db'
    },
    'parent-version': {
      type: 'string',
      description:
        "The asset's current version (run `ledric asset get <id>` to see it). Required — protects against concurrent replacements."
    },
    mime: {
      type: 'string',
      description: 'Override mime. Auto-detected from extension if omitted.'
    },
    alt: {
      type: 'string',
      description: 'Alt text. Provided alone, this also clears any previous meta fields beyond mime/alt.'
    },
    'assets-backend': {
      type: 'string',
      description: 'Asset backend: db (default) or local.'
    },
    'assets-root': {
      type: 'string',
      description: 'For the local backend: directory where bytes are written.'
    }
  },
  async run({ args }) {
    const abs = path.resolve(args.file);
    const bytes = await fs.readFile(abs);
    const mime = args.mime ?? guessMime(abs);

    const storage = await openSqlite({
      path: args.db,
      assets: assetsConfigFromArgs({
        assetsBackend: args['assets-backend'],
        assetsRoot: args['assets-root']
      })
    });
    try {
      const core = new Core(storage);

      // Resolve parent_version: explicit flag wins; otherwise read the
      // current version off the asset row to avoid making the user
      // chase it down for the simple single-author flow.
      let parentVersion: number;
      if (args['parent-version']) {
        parentVersion = parseInt(args['parent-version'], 10);
      } else {
        const cur = await core.getAsset({ id: args.id });
        if (!cur) {
          process.stderr.write(`ledric: no asset ${args.id} in ${args.db}\n`);
          process.exit(1);
        }
        parentVersion = cur.current_version;
      }

      const meta: Record<string, unknown> | undefined =
        mime !== undefined || args.alt !== undefined
          ? {
              ...(mime !== undefined ? { mime } : {}),
              ...(args.alt !== undefined ? { alt: args.alt } : {})
            }
          : undefined;

      const result = await core.updateAsset({
        id: args.id,
        parent_version: parentVersion,
        bytes,
        ...(meta !== undefined ? { meta } : {})
      });
      process.stdout.write(
        JSON.stringify(
          {
            id: result.id,
            ref_key: result.ref_key,
            version: result.version,
            kind: result.kind,
            storage_ref: result.storage_ref,
            meta: result.meta
          },
          null,
          2
        ) + '\n'
      );
    } finally {
      await storage.close();
    }
  }
});

const tagCommand = defineCommand({
  meta: {
    name: 'tag',
    description: 'Add tags to an asset. Comma-separated tags accepted.'
  },
  args: {
    id: { type: 'positional', description: 'Asset id (32-char hex).', required: true },
    tags: { type: 'positional', description: '"hero, Featured Event, q4"', required: true },
    db: { type: 'string', default: './ledric.db' }
  },
  async run({ args }) {
    const tags = splitTags(args.tags);
    if (tags.length === 0) {
      process.stderr.write('ledric: no tags provided\n');
      process.exit(1);
    }
    const storage = await openSqlite({ path: args.db });
    try {
      const core = new Core(storage);
      const result = await core.addAssetTags(args.id, tags);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } finally {
      await storage.close();
    }
  }
});

const untagCommand = defineCommand({
  meta: {
    name: 'untag',
    description: 'Remove tags from an asset. Matches by slug (case-insensitive).'
  },
  args: {
    id: { type: 'positional', required: true },
    tags: { type: 'positional', required: true },
    db: { type: 'string', default: './ledric.db' }
  },
  async run({ args }) {
    const tags = splitTags(args.tags);
    if (tags.length === 0) {
      process.stderr.write('ledric: no tags provided\n');
      process.exit(1);
    }
    const storage = await openSqlite({ path: args.db });
    try {
      const core = new Core(storage);
      const result = await core.removeAssetTags(args.id, tags);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } finally {
      await storage.close();
    }
  }
});

const tagsCommand = defineCommand({
  meta: {
    name: 'tags',
    description: 'List every tag in the env (across assets and entries) with usage counts.'
  },
  args: {
    db: { type: 'string', default: './ledric.db' }
  },
  async run({ args }) {
    const storage = await openSqlite({ path: args.db });
    try {
      const core = new Core(storage);
      const result = await core.listTags();
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } finally {
      await storage.close();
    }
  }
});

export const assetCommand = defineCommand({
  meta: {
    name: 'asset',
    description: 'Manage assets (upload, list, read, replace, tag).'
  },
  subCommands: {
    upload: uploadCommand,
    replace: replaceCommand,
    ls: lsCommand,
    get: getCommand,
    bytes: bytesCommand,
    tag: tagCommand,
    untag: untagCommand,
    tags: tagsCommand
  }
});
