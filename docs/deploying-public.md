# Deploying ledric to the public internet

The default ledric posture is "behind a proxy on `127.0.0.1`." The
`--public` preset flips a sensible-defaults posture for binding ledric
directly to the internet — no Laravel/nginx in front for the HTTP /
MCP / OAuth surface.

```bash
LEDRIC_ADMIN_KEY=lka_… \
  npx ledric serve --public
```

## What `--public` enables

A single flag, equivalent to setting all of these at once:

| Flag | Effect |
| --- | --- |
| `--public-mcp` | Mount the OAuth provider, accept OAuth bearers on `/mcp`, require `publicUrl`. |
| `--require-reader-key` | Close GET routes — every read needs a reader key (not just writes). |
| `--http-host 0.0.0.0` | Bind external by default (overridable via `--http-host`). |
| `--trust-proxy` | Honor `X-Forwarded-*` from a fronting CDN. |

Plus, on top:

- **Boot refusals** — refuses to start without `LEDRIC_ADMIN_KEY` (or
  an existing admin key in the DB) and without `mcp.publicUrl`. The
  print-once auto-mint flow is fine on a localhost dev box but loses
  the key in systemd journal noise on a public host.
- **Rate limiting** — `@fastify/rate-limit` with sensible per-route
  defaults: 100 req/min/IP global, 10 req/min/IP on `/oauth/*` and
  `/.well-known/*`, 30 uploads/hour/IP on POST `/assets`.
- **CORS auto-derive** — instead of `origin: '*'`, allow only the host
  of `mcp.publicUrl` plus `https://claude.ai`. Override with
  `mcp.allowedOrigins` when you need extra origins.
- **Brute-force visibility** — auth failures emit a structured
  `auth.fail` log line per IP, debounced to one per 60s. Tail
  systemd journal to spot scanners.

## What runs always-on (regardless of `--public`)

Sensible defaults that don't break dev:

- **Security headers** — HSTS, `nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `X-Permitted-Cross-Domain-Policies:
  none`. CSP isn't enabled globally (the GUI's CDN-imported components
  need co-design first); the GUI HTML route does set
  `Content-Security-Policy: frame-ancestors 'self'` on its own as
  clickjacking protection, scoped to admin routes.
- **Per-route body limits** — `/rpc` capped at 1 MiB, `/assets` POST
  at the upload limit (default 25 MiB, configurable via
  `--http-upload-limit`). Stops a blanket 25 MiB tarpit on every
  anonymous endpoint.
- **Constant-time API key comparison** — lookup by 12-char prefix
  (non-secret), then verify the full hash with `crypto.timingSafeEqual`.
  No SQL-equality timing oracle.
- **Image decompression-bomb guard** — uploads with
  `width × height > 25M pixels` rejected at the metadata read.
  Override with `LEDRIC_MAX_IMAGE_PIXELS` if you legitimately need
  larger.
- **Strict argument bounds** — `find.limit` capped 1–200, `find.q`
  capped 256 chars at every entry point (REST, MCP, RPC).

## Required environment

```bash
LEDRIC_ADMIN_KEY=lka_…                    # admin key (mint with `ledric keys add admin --raw`)
LEDRIC_MCP_PUBLIC_URL=https://your.host   # OAuth issuer + CORS anchor
```

Optional:

```bash
LEDRIC_READER_KEY=lkr_…                   # reader key (rendered into your consumer site)
LEDRIC_DCR_INITIAL_TOKEN=…                # see "DCR lockdown" below
LEDRIC_MAX_IMAGE_PIXELS=50000000          # raise the image-bomb cap (default 25M)
```

## DCR lockdown (optional)

Anonymous DCR is on by default in `--public` mode (rate-limited at the
HTTP layer to 10 req/min/IP). claude.ai and other browser-launched MCP
clients need this to register their connector dynamically.

To require an out-of-band token instead, set:

```bash
LEDRIC_DCR_INITIAL_TOKEN=$(openssl rand -hex 32)
```

Hand the token to anyone you want to allow to register a client. They
present it on `/oauth/register` as `Authorization: Bearer <token>`;
others get 401. Trade-off: claude.ai's connect-from-browser flow stops
working for end users without out-of-band token distribution.

## What the operator still owns

The `--public` preset is "safe to bind to a domain"; production needs
some adjacent infrastructure ledric won't provide:

- **TLS termination.** ledric binds plain HTTP. Front it with nginx /
  Caddy / a CDN that handles certs. Forward `X-Forwarded-Host`,
  `X-Forwarded-Proto`, `X-Forwarded-For`, `X-Forwarded-Prefix` (if
  mounting under a sub-path) — `--trust-proxy` makes ledric honor them.
- **Process supervision.** `npx ledric serve --public` is fine for a
  smoke test. For production, run via systemd / supervisord with
  `Restart=on-failure`. (Don't `npx` in production — it re-resolves
  the package on every restart.)
- **Backups.** SQLite `./ledric.db` + `./ledric-transforms/` (if
  enabled) is your data. Snapshot it regularly. Postgres / MySQL
  backups are your DBA's problem.
- **Monitoring.** Tail stderr for `auth.fail` lines as a brute-force
  signal. The `oidc-provider` library logs to stderr too.
- **CIDR allowlist.** If your MCP clients are a known set
  (Anthropic's published cloud IP ranges, your own VPN), set
  `mcp.allowedCidrs` to skip the rate-limit window for non-allowlist
  IPs entirely. (Their list drifts — operator-supplied, not shipped.)

## Sample systemd unit

```ini
# /etc/systemd/system/ledric.service
[Unit]
Description=ledric
After=network.target

[Service]
Type=simple
User=ledric
WorkingDirectory=/srv/ledric
ExecStart=/srv/ledric/node_modules/.bin/ledric serve --public
EnvironmentFile=/srv/ledric/.env
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

`/srv/ledric/.env`:

```env
LEDRIC_ADMIN_KEY=lka_…
LEDRIC_READER_KEY=lkr_…
LEDRIC_MCP_PUBLIC_URL=https://your.host
```

Front with nginx for TLS + the standard `X-Forwarded-*` headers, and
you're done.
