# Deployment

ledric ships as a single Node process that talks to a SQLite file (or, if you've configured one, a Postgres / MySQL database). For development, that's it — `npx ledric serve --gui` and you're done. For production there are a few things you almost certainly want in front.

This page is the operator-side counterpart to [`auth.md`](./auth.md) (which is about API keys) and [`assets.md`](./assets.md) (which is about how the asset model works internally).

- [The shape of a production deploy](#the-shape-of-a-production-deploy)
- [Asset serving via a CDN](#asset-serving-via-a-cdn)
- [Reverse proxy + TLS](#reverse-proxy--tls)
- [Auth in production](#auth-in-production)
- [Backups](#backups)
- [Postgres / MySQL deploys](#postgres--mysql-deploys)
- [What ledric won't do for you](#what-ledric-wont-do-for-you)

---

## The shape of a production deploy

The minimum viable production setup is:

```
[ Browsers / consumer sites / agents ]
              │
              ▼
[ CDN (Cloudflare / CloudFront / Fastly) ]   ← caches /assets/<ref_key>
              │
              ▼
[ Reverse proxy (nginx / Caddy) ]            ← TLS termination, request routing
              │
              ▼
[ ledric process (npx ledric http) ]
              │
              ▼
[ ./ledric.db (SQLite)  OR  Postgres / MySQL ]
```

You can collapse the proxy into the CDN if your CDN does TLS-to-origin (Cloudflare, etc.). You can drop the CDN entirely for low-traffic internal sites and serve assets directly. Don't drop both.

---

## Asset serving via a CDN

The `/assets/<ref_key>` route is built to be cached aggressively. Every byte response carries:

```
Cache-Control: public, max-age=31536000, immutable
```

with `Vary: Accept` added when `auto=format` is in play. The `ref_key` rotates whenever an asset's bytes change (`update_asset` mints a fresh one), so the URL is *inherently* version-pinned — a CDN can hold it forever and never serve stale content.

**What to put in front:**

- **Cloudflare** — point the proxy DNS at your origin, set a Cache Rule for `/assets/*` if the default doesn't pick up `Cache-Control: immutable` (it should, but check). Argo / Tiered Cache is overkill for most setups.
- **CloudFront** — origin = your ledric host; behavior for `/assets/*` with TTL inherited from origin headers, "Cache based on selected request headers" → include `Accept` for the `auto=format` path.
- **nginx as a caching proxy** — `proxy_cache_path` + a `location /assets/` block with `proxy_cache_valid 200 365d;`. Cheap and works.
- **squid** — `refresh_pattern -i \.(jpg|jpeg|png|webp|avif|svg)$ 525600 100% 525600` and you're done.

The transforms (`?w=600&fm=webp&auto=format` etc.) are part of the URL, so each variant gets its own cache entry. The on-disk transform cache in ledric (default `./ledric-transforms/`) is the *origin's* cache — useful when your CDN hasn't seen a variant yet, or when you're testing without a CDN. In production with a healthy CDN hit rate, the on-disk cache barely runs.

---

## Reverse proxy + TLS

ledric speaks plain HTTP — TLS termination is whatever you set up at the edge.

### nginx

```nginx
upstream ledric {
  server 127.0.0.1:3000;
}

server {
  listen 443 ssl http2;
  server_name cms.example.com;

  ssl_certificate     /etc/letsencrypt/live/cms.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/cms.example.com/privkey.pem;

  client_max_body_size 50M;   # asset uploads — bump to your max image size

  location / {
    proxy_pass http://ledric;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Caddy

```caddy
cms.example.com {
  reverse_proxy 127.0.0.1:3000
  request_body { max_size 50MB }
}
```

Caddy auto-provisions Let's Encrypt certs.

---

## Auth in production

`ledric init` mints API keys into the SQLite DB on first boot. That's fine for local development. For production, you want to be deliberate about where the keys live.

**Recommended pattern**: don't auto-mint. Provide the keys via env vars from your secret manager (Vercel, fly.io, Doppler, k8s, etc.):

```bash
LEDRIC_ADMIN_KEY=lka_...        \
LEDRIC_READER_KEY=lkr_...       \
  ledric http --require-reader-key
```

When env keys are set, ledric skips first-boot auto-mint entirely — secrets stay in your secret manager, not in the DB. See [`auth.md`](./auth.md) for the full env-var override flow.

**`--require-reader-key`** flips ledric to closed-reads mode, which you almost certainly want for production unless your content really is public-anonymous-readable. With closed reads on, every consumer needs at least a reader key.

CDN gotcha: if your CDN is fronting `/assets/<ref_key>` and you're in closed-reads mode, the CDN needs to attach the reader key on origin pulls. Most CDNs let you set a static `Authorization` header on outbound requests for that.

---

## Backups

### SQLite

The whole content store is one file plus the WAL/SHM siblings. Stop ledric, then `cp ./ledric.db /backup/...`. Or — better — use SQLite's online backup API via `sqlite3 ./ledric.db ".backup /backup/ledric-$(date +%Y%m%d).db"` while ledric is running.

If you're using the `local` asset backend, also back up `./ledric-assets/`. With the `db` asset backend, the bytes are inside the SQLite file already.

### Postgres / MySQL

Standard `pg_dump` / `mysqldump`. ledric doesn't store anything outside its tables (assets are blobs in `asset_blobs`), so a logical dump is sufficient.

---

## Postgres / MySQL deploys

The `db` SQLite default is fine through "small team, hundreds of MB of content." Past that, the things that drive a switch are:

- **Concurrent writers** — SQLite serializes writers; if you have multiple ledric processes (or one process with high concurrent draft volume from a big editorial team), Postgres / MySQL handle it natively.
- **Hosted ops** — Supabase, Neon, fly.io postgres, AWS RDS, PlanetScale — managed backups, replication, point-in-time recovery come for free.
- **Database team conventions** — your team already has Postgres in production, they don't want a new ops thing.

Boot ledric against an external DB:

```bash
# Postgres
ledric http --db postgres://user:pass@host:5432/dbname

# MySQL
ledric http --db mysql://user:pass@host:3306/dbname
```

(If a CLI flag for connection URL isn't there yet — older builds expected a path — open as the `LEDRIC_DB` env var or use a config file. Both are equivalent at the open layer.)

The connection string is the only knob you need. Migrations run on first boot; the `Storage` interface is identical across dialects. The same `npx ledric serve --gui` ergonomics apply.

**One caveat**: Postgres / MySQL adapters are tested against real instances (CI-style integration tests live in the repo) but they're behind opt-in env vars rather than always-on CI. The SQLite path has the deepest test coverage. If you hit a Postgres- or MySQL-specific bug, open an issue with the connection details and the failing op — it's fixable.

---

## What ledric won't do for you

Things you should plan for outside of ledric, not inside it:

- **Image upload virus scanning / NSFW detection** — if you accept user-generated assets, run them through ClamAV / a moderation pipeline at the edge (or as a pre-upload hook in your own application code).
- **Rate limiting per IP / per key** — your reverse proxy or CDN does this better than ledric ever will.
- **Audit log shipping** — ledric records every entry version in `entry_versions`, but if you need that streamed to an external SIEM, hook a log forwarder at the database level or query the table on a schedule.
- **Multi-tenant isolation** — ledric's `env` concept exists in the schema but isn't exposed yet. Today: one ledric process per logical tenant. Future: branched envs with per-key scope.
- **CDN purging on rename** — slug renames return `301` with `X-Ledric-Redirect`, which most CDNs respect. But if your CDN aggressively caches HTML, you may need to bust it manually after a rename.

Plan accordingly.
