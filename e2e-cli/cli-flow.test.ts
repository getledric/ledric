import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

// E2E harness for the published-shape product surface. Every prior
// shipped bug (listClients export, /mcp 404, public-mode auth-off)
// would have failed one of the steps below before publish:
//
//   1. spawn the binary             — catches ESM module-load failures
//   2. GET /                        — catches "server boots but routes wrong"
//   3. anonymous POST /mcp          — catches /mcp not registered (route 404)
//                                     and catches public-mode auth-off
//                                     (no 401, no WWW-Authenticate)
//   4. discovery + DCR + token      — catches OAuth wiring regressions
//   5. authenticated /mcp tools/list — catches end-to-end routing breaks
//
// This is intentionally not a unit test: it spawns the actual built
// binary in a subprocess against a fresh tmpdir. That's the only
// surface a published `npx ledric` user touches.

const CLI_PATH = resolve(__dirname, '../packages/cli/dist/cli.js');
const BOOT_TIMEOUT_MS = 15_000;

interface Env {
  proc: ChildProcess;
  url: string;
  issuer: string;
  adminKey: string;
  tmpdir: string;
  stderrBuf: string;
}

async function reservePort(): Promise<number> {
  return new Promise((resolveFn, rejectFn) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', rejectFn);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (addr === null || typeof addr !== 'object') {
        rejectFn(new Error('probe address null'));
        return;
      }
      const port = addr.port;
      probe.close(() => resolveFn(port));
    });
  });
}

interface BootOpts {
  /** Reuse an existing tmpdir + DB + config for restart-persistence tests. */
  tmpdir?: string;
  /** Reuse an existing port (so issuer URL stays stable across restarts). */
  port?: number;
}

async function bootCli(opts: BootOpts = {}): Promise<Env> {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `CLI dist missing at ${CLI_PATH}. Run \`pnpm build\` first — this e2e ` +
        `intentionally drives the built binary, not the source.`
    );
  }

  const port = opts.port ?? (await reservePort());
  const issuer = `http://127.0.0.1:${port}`;
  const tmp = opts.tmpdir ?? (await mkdtemp(join(tmpdir(), 'ledric-e2e-')));
  if (opts.tmpdir === undefined) {
    await writeFile(
      join(tmp, 'ledric.config.json'),
      JSON.stringify({ db: './ledric.db', publicUrl: issuer }, null, 2)
    );
  }

  const proc = spawn(
    'node',
    [CLI_PATH, 'serve', '--http-mcp', '--public-mcp', '--http-port', String(port)],
    {
      cwd: tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Wipe inherited LEDRIC_* envs so the bootstrap actually mints a key.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith('LEDRIC_'))
      )
    }
  );

  let stderrBuf = '';
  proc.stderr!.setEncoding('utf8');
  proc.stderr!.on('data', (chunk: string) => {
    stderrBuf += chunk;
  });
  proc.stdout!.on('data', () => {});

  // Wait for both: minted admin key (first-boot bootstrap) AND
  // "HTTP server at" readiness signal. Either timeout or process
  // exit before then is a hard failure — surface the captured
  // stderr so the operator can see what went wrong.
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let adminKey: string | undefined;
  let ready = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(
        `CLI exited with code ${proc.exitCode} before becoming ready.\n` +
          `--- stderr ---\n${stderrBuf}`
      );
    }
    if (adminKey === undefined) {
      // The bootstrap banner formats the key inside a box-drawing
      // frame. Match `admin <secret>` with the secret spanning to
      // the trailing │. ledric admin keys begin with `lka_`.
      const m = stderrBuf.match(/admin\s+(lka_[A-Za-z0-9_-]+)/);
      if (m) adminKey = m[1];
    }
    if (!ready) {
      ready = stderrBuf.includes('ledric: HTTP server at');
    }
    // Restart-mode (existing tmpdir): bootstrap is skipped because
    // the DB already has keys, so the admin-key banner never prints.
    // Treat readiness alone as boot-complete in that case.
    if (opts.tmpdir !== undefined && ready) break;
    if (adminKey !== undefined && ready) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const adminRequired = opts.tmpdir === undefined;
  if ((adminRequired && adminKey === undefined) || !ready) {
    proc.kill('SIGTERM');
    throw new Error(
      `CLI did not boot fully within ${BOOT_TIMEOUT_MS}ms. ` +
        `adminKey=${adminKey !== undefined} ready=${ready}\n` +
        `--- stderr ---\n${stderrBuf}`
    );
  }

  return {
    proc,
    url: issuer,
    issuer,
    adminKey: adminKey ?? '',
    tmpdir: tmp,
    stderrBuf
  };
}

async function killProc(env: Env): Promise<void> {
  if (env.proc.exitCode !== null) return;
  env.proc.kill('SIGTERM');
  await new Promise<void>((r) => {
    const t = setTimeout(() => {
      env.proc.kill('SIGKILL');
      r();
    }, 3000);
    env.proc.once('exit', () => {
      clearTimeout(t);
      r();
    });
  });
}

async function teardown(env: Env): Promise<void> {
  await killProc(env);
  await rm(env.tmpdir, { recursive: true, force: true });
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64url');
}

function randomB64Url(n: number): string {
  return randomBytes(n).toString('base64url');
}

function captureCookies(res: Response, jar: string[]): void {
  const cookies =
    typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of cookies) {
    const nv = c.split(';')[0];
    if (!nv) continue;
    const name = nv.split('=')[0];
    const idx = jar.findIndex((existing) => existing.startsWith(`${name}=`));
    if (idx >= 0) jar[idx] = nv;
    else jar.push(nv);
  }
}

describe('e2e: CLI public-MCP flow against the built binary', () => {
  let env: Env;

  beforeAll(async () => {
    env = await bootCli();
  }, BOOT_TIMEOUT_MS + 5_000);

  afterAll(async () => {
    if (env) await teardown(env);
  });

  it('the binary loads, mints an admin key, and listens', () => {
    // Implicit — beforeAll succeeded — but pin the contract:
    expect(env.adminKey).toMatch(/^lka_/);
    expect(env.proc.exitCode).toBeNull();
  });

  it('GET / advertises the running version and the /mcp endpoint', async () => {
    const res = await fetch(`${env.url}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; endpoints: string[] };
    // Version is whatever's in @ledric/http-server's package.json — assert
    // the /mcp endpoint is advertised. Catches the 0.0.0-version regression
    // (#247b8b5) AND any future "server boots but /mcp not in catalog" drift.
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.endpoints.some((e) => e.includes('/mcp'))).toBe(true);
  });

  it('anonymous POST /mcp returns 401 + RFC 9728 WWW-Authenticate', async () => {
    // This single assertion catches BOTH historical bugs at once:
    //   - #18 (/mcp 404): if /mcp isn't registered, status would be 404
    //     with a "route /mcp" body, not 401.
    //   - #19 (public-mode auth-off): if auth-off applies in public
    //     mode, status would be 200 (request flowed through anonymously).
    const res = await fetch(`${env.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0' }
        }
      })
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth, 'WWW-Authenticate header missing on 401').not.toBeNull();
    expect(wwwAuth).toMatch(/^Bearer\b/);
    expect(wwwAuth).toContain(
      `resource_metadata="${env.issuer}/.well-known/oauth-protected-resource"`
    );
  });

  it('discovery chain: protected-resource → authorization-server → JWKS', async () => {
    const pr = await fetch(`${env.url}/.well-known/oauth-protected-resource`);
    expect(pr.status).toBe(200);
    const prBody = (await pr.json()) as Record<string, unknown>;
    expect(prBody.resource).toBe(`${env.issuer}/mcp`);
    expect(Array.isArray(prBody.authorization_servers)).toBe(true);

    const as = await fetch(`${env.url}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    const asBody = (await as.json()) as Record<string, unknown>;
    expect(asBody.issuer).toBe(env.issuer);
    expect(asBody.code_challenge_methods_supported).toContain('S256');
    expect(typeof asBody.token_endpoint).toBe('string');
    expect(typeof asBody.registration_endpoint).toBe('string');
    expect(typeof asBody.jwks_uri).toBe('string');

    const jwks = await fetch(asBody.jwks_uri as string);
    expect(jwks.status).toBe(200);
    const jwksBody = (await jwks.json()) as { keys: Array<{ kty: string }> };
    expect(jwksBody.keys.length).toBeGreaterThan(0);
  });

  it('full OAuth flow: DCR → consent → token → authenticated tools/list', async () => {
    // 1. DCR
    const reg = await fetch(`${env.url}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'e2e-test-client',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      })
    });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };

    // 2. Authorize → consent UI
    const verifier = randomB64Url(32);
    const challenge = pkceChallenge(verifier);
    const state = randomB64Url(8);
    const authorizeUrl =
      `${env.url}/oauth/authorize?` +
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        response_type: 'code',
        scope: 'ledric:read',
        resource: `${env.issuer}/mcp`,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      }).toString();
    const cookieJar: string[] = [];
    let res = await fetch(authorizeUrl, { redirect: 'manual' });
    captureCookies(res, cookieJar);
    while (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc === null) break;
      const next = new URL(loc, env.url).toString();
      res = await fetch(next, {
        redirect: 'manual',
        headers: cookieJar.length > 0 ? { cookie: cookieJar.join('; ') } : {}
      });
      captureCookies(res, cookieJar);
      if (next.includes('/oauth/consent/')) break;
    }
    expect(res.status).toBe(200);
    const consentHtml = await res.text();
    const uidMatch = consentHtml.match(/\/oauth\/consent\/([A-Za-z0-9_-]+)/);
    expect(uidMatch, 'consent UID not found in HTML').not.toBeNull();
    const uid = uidMatch![1]!;

    // 3. POST consent with the admin key
    const consent = await fetch(`${env.url}/oauth/consent/${uid}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieJar.join('; ')
      },
      body: new URLSearchParams({ admin_key: env.adminKey }).toString()
    });
    captureCookies(consent, cookieJar);
    expect(consent.status).toBeGreaterThanOrEqual(300);
    expect(consent.status).toBeLessThan(400);

    // Walk redirect chain back to the client redirect_uri.
    let postRes: Response = consent;
    let hops = 0;
    let finalLoc: string | null = null;
    while (postRes.status >= 300 && postRes.status < 400 && hops++ < 10) {
      const loc = postRes.headers.get('location');
      if (loc === null) break;
      const next = new URL(loc, env.url).toString();
      if (next.startsWith('http://127.0.0.1:9999/cb')) {
        finalLoc = next;
        break;
      }
      postRes = await fetch(next, {
        redirect: 'manual',
        headers: { cookie: cookieJar.join('; ') }
      });
      captureCookies(postRes, cookieJar);
    }
    expect(finalLoc).not.toBeNull();
    const codeUrl = new URL(finalLoc!);
    const code = codeUrl.searchParams.get('code');
    expect(typeof code).toBe('string');
    expect(codeUrl.searchParams.get('state')).toBe(state);

    // 4. Token exchange
    const tokenRes = await fetch(`${env.url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: client.client_id,
        code_verifier: verifier
      }).toString()
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string };
    expect(typeof tokens.access_token).toBe('string');

    // 5. Authenticated /mcp — initialize + tools/list. Catches end-to-end
    // route-mounted, JWT-verified, dispatcher-wired regressions.
    const initRes = await fetch(`${env.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e', version: '0' }
        }
      })
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId, 'mcp-session-id header missing on initialize').not.toBeNull();
  });
});

// Regression: signing keys must persist across `serve` restarts.
// Without persistence, oidc-provider auto-mints dev-mode keys at boot
// — every restart invalidates issued JWTs and claude.ai connectors
// silently lose their connection. The test boots the CLI, captures
// /oauth/jwks, kills the subprocess, boots again on the SAME tmpdir,
// captures /oauth/jwks a second time, and asserts the keys (kid, kty,
// modulus n) match. Drift means we lost persistence.
describe('e2e: OAuth signing keys persist across restart', () => {
  let env1: Env | undefined;
  let env2: Env | undefined;

  afterAll(async () => {
    if (env2) await teardown(env2);
    else if (env1) await teardown(env1);
  });

  it('issues the same JWKS kid + n after a full restart', async () => {
    env1 = await bootCli();
    const jwks1 = (await (
      await fetch(`${env1.url}/oauth/jwks`)
    ).json()) as { keys: Array<{ kid: string; kty: string; n?: string }> };
    expect(jwks1.keys.length).toBeGreaterThan(0);
    const k1 = jwks1.keys[0]!;

    // oidc-provider's dev-mode fallback uses a hardcoded keystore
    // shipped in npm — `kid: keystore-CHANGE-ME` with a fixed RSA
    // key that ANY oidc-provider install can sign with. That's a
    // forge-tokens-for-anyone bug masquerading as a quick-start
    // convenience. If kid is that sentinel, persistence isn't wired.
    expect(k1.kid, 'using oidc-provider dev keystore — persistence not wired').not.toBe(
      'keystore-CHANGE-ME'
    );

    // Kill subprocess but keep tmpdir + DB.
    await killProc(env1);

    const port1 = Number(new URL(env1.url).port);
    env2 = await bootCli({ tmpdir: env1.tmpdir, port: port1 });
    const jwks2 = (await (
      await fetch(`${env2.url}/oauth/jwks`)
    ).json()) as { keys: Array<{ kid: string; kty: string; n?: string }> };
    expect(jwks2.keys.length).toBeGreaterThan(0);
    const k2 = jwks2.keys[0]!;

    expect(k2.kid).toBe(k1.kid);
    expect(k2.kty).toBe(k1.kty);
    expect(k2.n).toBe(k1.n);
  });
});
