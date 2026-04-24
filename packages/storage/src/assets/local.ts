import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AssetBackend, AssetGetResult, AssetPutInput } from './backend.js';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'application/pdf': '.pdf',
  'application/json': '.json',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/octet-stream': ''
};

function extFromMime(mime: string | undefined): string {
  if (mime === undefined) return '';
  return EXT_BY_MIME[mime] ?? '';
}

export class LocalAssetBackend implements AssetBackend {
  readonly scheme = 'local';

  constructor(private readonly root: string) {}

  async put(input: AssetPutInput): Promise<string> {
    const hex = Buffer.from(input.assetId).toString('hex');
    const ext = extFromMime(input.mime);
    const rel = path.posix.join(hex, `v${input.version}${ext}`);
    const abs = path.join(this.root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, input.bytes);
    return `local:${rel}`;
  }

  async get(storageRef: string): Promise<AssetGetResult> {
    const rel = parseLocalRef(storageRef);
    const abs = path.join(this.root, rel);
    const bytes = await fs.readFile(abs);
    return { bytes };
  }

  async delete(storageRef: string): Promise<void> {
    const rel = parseLocalRef(storageRef);
    const abs = path.join(this.root, rel);
    await fs.unlink(abs).catch(() => {
      // best-effort
    });
  }
}

function parseLocalRef(ref: string): string {
  if (!ref.startsWith('local:')) {
    throw new Error(`Not a local storage_ref: ${ref}`);
  }
  return ref.slice('local:'.length);
}
