import { describe, it, expect } from 'vitest';
import {
  buildConfig,
  mergeMcpServers,
  patchGitignoreContent,
  claudeDesktopConfigPath,
  detectFramework,
  proxyScaffold,
  addProxyDependency,
  PROXY_DEP_VERSION,
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

  describe('detectFramework', () => {
    it('returns null when no package.json was found', () => {
      expect(detectFramework(null)).toBe(null);
    });

    it('matches astro', () => {
      expect(detectFramework({ dependencies: { astro: '^6.2.0' } })).toBe('astro');
    });

    it('matches sveltekit via @sveltejs/kit dep', () => {
      expect(detectFramework({ devDependencies: { '@sveltejs/kit': '^2.0.0' } })).toBe(
        'sveltekit'
      );
    });

    it('distinguishes Next App Router from Pages Router via app-dir hint', () => {
      const pkg = { dependencies: { next: '^15.0.0' } };
      expect(detectFramework(pkg, true)).toBe('next-app');
      expect(detectFramework(pkg, false)).toBe('next-pages');
    });

    it('flags hono / express / fastify as unsupported (manual wiring)', () => {
      expect(detectFramework({ dependencies: { hono: '^4.0.0' } })).toBe('unsupported');
      expect(detectFramework({ dependencies: { express: '^4.18.0' } })).toBe('unsupported');
      expect(detectFramework({ dependencies: { fastify: '^4.0.0' } })).toBe('unsupported');
    });

    it('returns null when no known framework dep is present', () => {
      expect(detectFramework({ dependencies: { lodash: '^4.0.0' } })).toBe(null);
    });

    it('astro takes precedence over a coexisting next dep', () => {
      // Edge case: a project might list multiple, we pick the most specific.
      expect(
        detectFramework({ dependencies: { astro: '^6', next: '^15' } })
      ).toBe('astro');
    });
  });

  describe('proxyScaffold', () => {
    it('returns route + code for each supported framework', () => {
      for (const fw of ['astro', 'next-app', 'next-pages', 'sveltekit'] as const) {
        const r = proxyScaffold(fw);
        expect(r).not.toBeNull();
        expect(r!.routePath).toMatch(/ledric/);
        expect(r!.routeCode).toContain("from '@ledric/proxy'");
        expect(r!.routeCode).toContain('createLedricProxy');
      }
    });

    it('returns null for unsupported / unknown frameworks', () => {
      expect(proxyScaffold('unsupported')).toBe(null);
      expect(proxyScaffold(null)).toBe(null);
    });

    it('astro scaffold uses import.meta.env (not process.env)', () => {
      const r = proxyScaffold('astro')!;
      expect(r.routeCode).toContain('import.meta.env.LEDRIC_URL');
      expect(r.routeCode).not.toContain('process.env.LEDRIC_URL');
    });

    it('next-app scaffold awaits ctx.params (Next 15 promise shape)', () => {
      const r = proxyScaffold('next-app')!;
      expect(r.routeCode).toContain('await ctx.params');
      expect(r.routeCode).toContain('export const GET = handler');
    });

    it('sveltekit scaffold imports $env/dynamic/private', () => {
      const r = proxyScaffold('sveltekit')!;
      expect(r.routeCode).toContain("from '$env/dynamic/private'");
    });
  });

  describe('addProxyDependency', () => {
    it('adds @ledric/proxy when missing', () => {
      const { next, changed } = addProxyDependency({ dependencies: { astro: '^6' } });
      expect(changed).toBe(true);
      expect(next.dependencies?.['@ledric/proxy']).toBe(PROXY_DEP_VERSION);
      expect(next.dependencies?.astro).toBe('^6');
    });

    it("leaves an existing pin untouched (idempotent)", () => {
      const { next, changed } = addProxyDependency({
        dependencies: { '@ledric/proxy': '0.1.0' }
      });
      expect(changed).toBe(false);
      expect(next.dependencies?.['@ledric/proxy']).toBe('0.1.0');
    });

    it('respects an existing devDependencies pin', () => {
      const { next, changed } = addProxyDependency({
        devDependencies: { '@ledric/proxy': 'workspace:*' }
      });
      expect(changed).toBe(false);
      expect(next).toEqual({ devDependencies: { '@ledric/proxy': 'workspace:*' } });
    });

    it('preserves other top-level package.json fields', () => {
      const { next } = addProxyDependency({
        name: 'my-site',
        scripts: { dev: 'astro dev' },
        dependencies: { astro: '^6' }
      });
      expect(next.name).toBe('my-site');
      expect(next.scripts).toEqual({ dev: 'astro dev' });
    });
  });
});
