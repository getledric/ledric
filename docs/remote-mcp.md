# Remote MCP

Two ways to make ledric reachable from MCP clients other than the
desktop ones that spawn a stdio child.

You probably want the **local** mode. The **public** mode is the
deployment escalation you only take when claude.ai or another
cloud-hosted client needs to reach in.

- [Local mode (`--http-mcp`)](#local-mode---http-mcp)
- [Public mode (`--public-mcp`)](#public-mode---public-mcp)
- [The OAuth flow from the operator's seat](#the-oauth-flow-from-the-operators-seat)
- [Deployment shape](#deployment-shape)
- [The mcp-remote bridge](#the-mcp-remote-bridge)
- [Routes added by each mode](#routes-added-by-each-mode)

---

## Local mode (`--http-mcp`)

The natural setup if you want **multiple local clients** — Claude
Code, Cursor, Claude Desktop, an ad-hoc curl harness — to share one
running ledric daemon over `/mcp` instead of each spawning their own
stdio child.

```bash
npx ledric serve --http-mcp
```

What happens:

- `/mcp` mounts on Streamable HTTP at the existing HTTP port (default
  `127.0.0.1:3000`). POST for JSON-RPC, GET for the optional SSE
  stream, DELETE for session termination.
- Auth on `/mcp` uses the same `lka_…` / `lkr_…` API keys you mint at
  first boot — same per-tool model as `POST /rpc` (read-only tool
  calls accept reader keys; writes need admin).
- Origin validation rejects browser pages outside the localhost
  loopback. Non-browser clients (no `Origin` header) bypass the
  check.
- No OAuth surface mounted. `/.well-known/oauth-authorization-server`
  and `/oauth/*` return 404. `publicUrl` is **not required**.

In `ledric.config.json`:

```json
{
  "mcp": { "http": true }
}
```

### Wiring local clients to a single shared daemon

Most desktop MCP clients still expect a stdio child. Use
[`mcp-remote`](https://github.com/geelen/mcp-remote) as the bridge:

```jsonc
// .mcp.json (Claude Code, Cursor) — or claude_desktop_config.json
{
  "mcpServers": {
    "ledric": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://127.0.0.1:3000/mcp",
        "--allow-http",
        "--header", "Authorization: Bearer ${LEDRIC_ADMIN_KEY}"
      ]
    }
  }
}
```

Multiple clients can connect concurrently. They each get a fresh
`Mcp-Session-Id`; tool dispatch goes through one shared `Core` so
draft / publish / asset uploads stay consistent.

---

## Public mode (`--public-mcp`)

The deployment escalation. Implies `--http-mcp` and adds:

- The OAuth 2.1 provider (DCR + PKCE + JWT) under `/oauth/*` and
  `/.well-known/*`.
- Acceptance of OAuth bearer tokens on `/mcp` alongside the existing
  API-key path. Scope `ledric:read` maps to reader, `ledric:write`
  maps to admin.
- Strict Origin allowlist on `/mcp` — only the configured `publicUrl`
  origin and `https://claude.ai`. **No localhost escape.**
- Default bind flips to `0.0.0.0`. Override with `--http-host` if
  you're putting a reverse proxy in front (recommended; see below).

```bash
npx ledric serve --public-mcp
```

`ledric.config.json`:

```json
{
  "publicUrl": "https://ledric.example.com",
  "mcp": {
    "http": true,
    "public": true,
    "allowedCidrs": ["8.8.4.0/22"]
  }
}
```

`publicUrl` is **mandatory** — it's the OAuth issuer, the JWT `iss`
claim, and the canonical Origin allowlist anchor. Boot fails loudly
without it.

### `mcp.allowedCidrs` (recommended in production)

Optional pre-auth IP allowlist. Requests to `/mcp` and `/oauth/*` from
outside any allowlisted CIDR are rejected with 403 **before** auth
runs.

```json
{ "mcp": { "allowedCidrs": ["8.8.4.0/22", "203.0.113.42/32"] } }
```

Anthropic publishes the IP ranges their cloud uses to reach custom
connectors. Use those as your starting point — but **don't expect
this list to be hardcoded in ledric**, because Anthropic changes it.
Look the current values up before you set the allowlist.

Empty / unset = allow all. That's fine for testing; lock it down for
real deployments.

---

## The OAuth flow from the operator's seat

claude.ai's "Add custom connector" flow walks the standard OAuth 2.1
authorization-code dance. From your side it looks like this:

1. **Operator boots** `npx ledric serve --public-mcp`. Server prints a
   one-time **consent token** to stderr, like:

   ```
   ╭──────────────────────────────────────────────────────────────────────────╮
   │  OAuth consent token (single-use, ~10 min). Paste this into the          │
   │  consent page when claude.ai or another client requests authorization.   │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  W3aJ_7K9qP8x_v2Zk4nL5mB1                                                │
   ╰──────────────────────────────────────────────────────────────────────────╯
   ```

2. **claude.ai discovers** the OAuth issuer via
   `/.well-known/oauth-protected-resource` → registers a client via
   DCR (`POST /oauth/register`).

3. **Browser bounces** to ledric's `/oauth/authorize` consent page.
   The page renders the DCR-supplied display name in quotes, marked
   "(claimed by client; not verified)" — alongside the system-
   generated `client_id`, the validated `redirect_uri`, and the
   requested scope mapped to its ledric role. The operator pastes
   the consent token from step 1 and clicks Approve.

4. **Token exchange.** claude.ai gets the auth code, POSTs it with the
   PKCE verifier to `/oauth/token`, gets back a JWT access token (1h
   default, ed25519 signed) and a refresh token (30d, rotating).

5. **MCP calls.** claude.ai uses the JWT as a `Bearer` token on every
   `/mcp` request. Refresh tokens rotate on each use; presenting an
   already-rotated token revokes the entire lineage (replay-attack
   defense per OAuth 2.1 best practice).

The consent token rotates on every consume, success or failure. If
you want to add a second connector later in the same session, the
new token is auto-printed to stderr right after the first one is
used.

### Verifying what you're approving

The display name on the consent page is **untrusted** — any DCR
registrant can claim "Claude Desktop". The trustworthy fields are:

- **`client_id`** — system-generated by ledric at registration time.
- **`redirect_uri`** — registered with the client and validated
  against `oauth.allowedRedirectHosts` if you set that.

Always verify the `redirect_uri` host matches the service you think
you're approving (e.g. `claude.ai`).

### Managing registered clients

```bash
npx ledric oauth clients list                # all active
npx ledric oauth clients list --include-revoked
npx ledric oauth clients revoke <client_id>  # blocks future authorize + token
```

Revoking a client doesn't invalidate already-issued JWTs — those
expire on their own (1h default). Refresh-token rotation will fail,
which is the practical kill switch.

---

## Deployment shape

Public-mode ledric expects to be reachable on `publicUrl` over HTTPS.
Recommended layout:

```
internet → CDN / reverse proxy (TLS, IP allowlist, rate limits)
                    ↓
              ledric (127.0.0.1, --public-mcp + --http-host=127.0.0.1)
```

Bind ledric to localhost and let the reverse proxy be the only
public-facing thing. The reverse proxy:

- Terminates TLS.
- Enforces the Anthropic-IP allowlist (or your VPN range, or
  whatever).
- Rate-limits `/oauth/*` so a flood of DCR registrations can't fill
  the database. Ledric doesn't rate-limit on its own.
- Forwards through with `X-Forwarded-For` so ledric's `req.ip` (and
  thus `mcp.allowedCidrs`) sees the real client.

Cloudflare Tunnel works well for laptop-as-deployment-target scenarios
where you want a stable hostname without poking holes in your
firewall.

### Storage on a public deployment

The OAuth tables (`oauth_clients`, `oauth_codes`, `oauth_refresh_tokens`,
`oauth_keys`) live in the same SQLite file as everything else. Back it
up with the same shape as the rest of your ledric data — there's no
separate dance.

The signing keypair is generated on first public-mode boot and
persists across restarts. Delete the row in `oauth_keys` to force a
rotation; all existing JWTs become invalid (refreshes must
re-authorize), but registered clients keep their `client_id` /
`redirect_uri`.

---

## The mcp-remote bridge

`mcp-remote` is a stdio→Streamable-HTTP bridge maintained outside
ledric. Useful in two scenarios:

1. A desktop MCP client expects a stdio child but you want it talking
   to a remote ledric (over `--http-mcp` or `--public-mcp`).
2. You're testing ledric's `/mcp` surface with a CLI-friendly tool
   that handles the JSON-RPC framing for you.

API-key path (works against either mode):

```bash
npx -y mcp-remote http://127.0.0.1:3000/mcp \
  --allow-http \
  --header "Authorization: Bearer lka_..."
```

OAuth path (claude.ai-shaped, public mode only):

```bash
npx -y mcp-remote https://ledric.example.com/mcp
# mcp-remote walks the OAuth flow itself; you'll be prompted to paste
# the consent token from your ledric server's stderr.
```

---

## Routes added by each mode

| Route | `--http-mcp` | `--public-mcp` |
|---|---|---|
| `POST /mcp` (JSON-RPC) | ✅ | ✅ |
| `GET /mcp` (SSE) | ✅ | ✅ |
| `DELETE /mcp` (session terminate) | ✅ | ✅ |
| `GET /.well-known/oauth-authorization-server` | 404 | ✅ |
| `GET /.well-known/oauth-protected-resource` | 404 | ✅ |
| `POST /oauth/register` (DCR) | 404 | ✅ |
| `GET /oauth/authorize` (consent page) | 404 | ✅ |
| `POST /oauth/authorize` (consume consent) | 404 | ✅ |
| `POST /oauth/token` (auth code → JWT, refresh rotation) | 404 | ✅ |
| `POST /oauth/revoke` (RFC 7009) | 404 | ✅ |
| `GET /oauth/jwks` | 404 | ✅ |

Existing surfaces (`POST /rpc`, REST routes, `/admin/*`) are
unchanged in either mode. Stdio MCP also keeps working — your
existing `.mcp.json` setups don't need to change.
