import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute filesystem path to the ledric admin GUI's static assets.
 * Pass to `runHttp(core, { gui: { assetsPath: guiAssetsPath } })`.
 */
export const guiAssetsPath: string = join(here, '..', 'web');
