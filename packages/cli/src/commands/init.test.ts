import { describe, it, expect } from 'vitest';
import {
  buildConfig,
  mergeMcpServers,
  patchGitignoreContent,
  claudeDesktopConfigPath,
  DEFAULTS
} from './init.js';

describe('init helpers', () => {
  describe('buildConfig', () => {
    it('emits db backend without an assets path', () => {
      const cfg = buildConfig({ ...DEFAULTS });
      expect(cfg.db).toBe('./ledric.db');
      expect(cfg.assets).toEqual({ backend: 'db' });
      expect(cfg.http?.port).toBe(3000);
      expect(cfg.http?.host).toBe('127.0.0.1');
    });

    it('includes assets.path when local backend has one', () => {
      const cfg = buildConfig({
        ...DEFAULTS,
        assetsBackend: 'local',
        assetsPath: './my-assets'
      });
      expect(cfg.assets).toEqual({ backend: 'local', path: './my-assets' });
    });

    it('omits assets.path for local backend if path is null', () => {
      const cfg = buildConfig({
        ...DEFAULTS,
        assetsBackend: 'local',
        assetsPath: null
      });
      expect(cfg.assets).toEqual({ backend: 'local' });
    });
  });

  describe('mergeMcpServers', () => {
    it('creates a fresh shape from null', () => {
      const merged = mergeMcpServers(null, 'ledric', {
        command: 'npx',
        args: ['-y', 'ledric']
      });
      expect(merged.mcpServers?.ledric).toEqual({
        command: 'npx',
        args: ['-y', 'ledric']
      });
    });

    it('preserves other servers in the same file', () => {
      const existing = {
        mcpServers: {
          other: { command: 'node', args: ['/path/to/other.js'] }
        }
      };
      const merged = mergeMcpServers(existing, 'ledric', {
        command: 'npx',
        args: ['ledric']
      });
      expect(merged.mcpServers?.other).toEqual({
        command: 'node',
        args: ['/path/to/other.js']
      });
      expect(merged.mcpServers?.ledric).toBeDefined();
    });

    it('overwrites an existing entry with the same name', () => {
      const existing = {
        mcpServers: { ledric: { command: 'old', args: [] } }
      };
      const merged = mergeMcpServers(existing, 'ledric', {
        command: 'npx',
        args: ['ledric']
      });
      expect(merged.mcpServers?.ledric).toEqual({
        command: 'npx',
        args: ['ledric']
      });
    });

    it('preserves top-level keys other than mcpServers', () => {
      const existing = {
        mcpServers: { other: { command: 'foo', args: [] } },
        someOtherTopLevel: 42
      };
      const merged = mergeMcpServers(existing, 'ledric', {
        command: 'x',
        args: []
      });
      expect(merged.someOtherTopLevel).toBe(42);
    });

    it('treats malformed input as empty', () => {
      const merged = mergeMcpServers('not an object', 'ledric', {
        command: 'x',
        args: []
      });
      expect(merged.mcpServers?.ledric).toEqual({ command: 'x', args: [] });
    });

    it('treats arrays as malformed', () => {
      const merged = mergeMcpServers([1, 2, 3], 'ledric', {
        command: 'x',
        args: []
      });
      expect(merged.mcpServers?.ledric).toBeDefined();
    });
  });

  describe('patchGitignoreContent', () => {
    it('appends missing lines to an existing file', () => {
      const result = patchGitignoreContent('node_modules\n', [
        'ledric.db',
        '.env.local'
      ]);
      expect(result).toContain('node_modules');
      expect(result).toContain('ledric.db');
      expect(result).toContain('.env.local');
    });

    it('does not duplicate existing lines', () => {
      const before = 'ledric.db\n.env.local\n';
      const result = patchGitignoreContent(before, ['ledric.db']);
      expect(result).toBe(before);
    });

    it('handles empty input', () => {
      const result = patchGitignoreContent('', ['ledric.db', '.env.local']);
      expect(result).toBe('ledric.db\n.env.local\n');
    });

    it('adds a trailing newline if missing', () => {
      const result = patchGitignoreContent('foo', ['bar']);
      expect(result.endsWith('\n')).toBe(true);
    });

    it('skips comment lines that are already present', () => {
      const before = '# ledric\nledric.db\n';
      const result = patchGitignoreContent(before, ['# ledric', 'ledric.db']);
      expect(result).toBe(before);
    });
  });

  describe('claudeDesktopConfigPath', () => {
    it('returns macOS path under Library/Application Support', () => {
      expect(claudeDesktopConfigPath('darwin', '/Users/jane')).toBe(
        '/Users/jane/Library/Application Support/Claude/claude_desktop_config.json'
      );
    });

    it('returns Linux path under .config', () => {
      expect(claudeDesktopConfigPath('linux', '/home/jane')).toBe(
        '/home/jane/.config/Claude/claude_desktop_config.json'
      );
    });

    it('returns Windows path under APPDATA when set', () => {
      expect(
        claudeDesktopConfigPath(
          'win32',
          'C:\\Users\\jane',
          'C:\\Users\\jane\\AppData\\Roaming'
        )
      ).toBe(
        'C:\\Users\\jane\\AppData\\Roaming/Claude/claude_desktop_config.json'
      );
    });

    it('returns null on Windows when APPDATA is unset', () => {
      expect(claudeDesktopConfigPath('win32', 'C:\\Users\\jane', undefined)).toBe(
        null
      );
    });

    it('returns null on unsupported platforms', () => {
      expect(
        claudeDesktopConfigPath('freebsd' as NodeJS.Platform, '/home/jane')
      ).toBe(null);
    });
  });
});
