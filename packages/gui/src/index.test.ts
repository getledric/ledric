import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { guiAssetsPath } from './index.js';

describe('@ledric/gui', () => {
  it('exports a path to a real directory containing the admin SPA', () => {
    expect(existsSync(guiAssetsPath)).toBe(true);
    expect(existsSync(join(guiAssetsPath, 'index.html'))).toBe(true);
    expect(existsSync(join(guiAssetsPath, 'app.js'))).toBe(true);
  });

  it('ships the inline editor loader (served at /admin/inline.js)', () => {
    expect(existsSync(join(guiAssetsPath, 'inline.js'))).toBe(true);
  });
});
