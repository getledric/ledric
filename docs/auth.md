# API keys and auth

ledric ships an API-key auth layer with two roles, sensible
defaults, and a one-shot bootstrap so you don't have to figure out
key minting before you can run anything.

- [The default mode](#the-default-mode)
- [Roles](#roles)
- [How keys get minted](#how-keys-get-minted)
- [Sending keys with requests](#sending-keys-with-requests)
- [Closed-reads mode](#closed-reads-mode)
- [Listing, creating, revoking](#listing-creating-revoking)
- [Rotation](#rotation)
- [Env-var override](#env-var-override)
- [No-auth dev mode](#no-auth-dev-mode)

---

## The default mode

**Admin-protects-writes, reads stay open.**

- `GET` requests don't need a key. Public sites can fetch directly.
- `POST` / mutation requests need an admin key.
- `npx ledric init` mints both an admin and a reader key on the way
  through. The first HTTP boot does it instead if you skipped init.
- Either way, the secrets are printed *once* — to stderr in the
  CLI, into the init's note block in the GUI, and into
  `.env.local` if init wrote it.

If you never opt into key minting, ledric runs without auth — fine
for local dev, not fine for anything reachable over the network.
The GUI's `/auth/status` probe reports `required: false` in this
mode so client tools know they don't need to prompt.

---

## Roles

| Role | Prefix | Can do |
|---|---|---|
| `admin` | `lka_` | Read + write everything. The role you use for editing. |
| `reader` | `lkr_` | Reads only. Use this in production frontends so leaking the key doesn't grant write access. |

The full secret looks like
`lka_<24-byte-base64url>` — about 36 chars total. Treat it like a
password.

A `reader` key only matters when [closed-reads mode](#closed-reads-mode)
is on — under the default (reads_open) mode you don't need one.

---

## How keys get minted

### `ledric init` (recommended)

```bash
npx ledric init
```

Prompt: "Mint admin + reader API keys now? (Y/n)" — defaults yes.
The keys are:

- Printed once in the init session's note block (for backup).
- Written to `.env.local` as `LEDRIC_ADMIN_KEY=...` /
  `LEDRIC_READER_KEY=...` (gitignored by init's `.gitignore` patch).
- Stored hashed in the DB (sha256 — the plaintext can't be recovered).

### First HTTP boot

If the DB has zero active keys and `LEDRIC_ADMIN_KEY` /
`LEDRIC_READER_KEY` env vars aren't set, the first run of
`ledric serve --gui` (or `ledric http`) auto-mints one of each and
prints them in a banner to stderr. Same hashing, same one-shot
visibility — capture them then or `ledric keys revoke` and start
again.

### Manual

`ledric keys create --role admin` mints a fresh one any time:

```bash
npx ledric keys create --role admin --label "vercel-prod"
# prints the secret once + a confirmation line
```

For pipe-friendly usage:

```bash
npx ledric keys create --role admin --raw | pbcopy
# stdout = the secret
# stderr = the confirmation banner
```

---

## Sending keys with requests

Either header works:

```
Authorization: Bearer lka_<the-secret>
X-Ledric-Key: lka_<the-secret>
```

The SDK clients (`@ledric/sdk` + the PHP `LedricClient`) take a
key in their constructor and inject it automatically:

```ts
import { LedricClient } from '@ledric/sdk';

const client = new LedricClient({
  baseUrl: 'https://cms.example.com',
  apiKey: process.env.LEDRIC_READER_KEY
});
```

The MCP-stdio path is implicitly trusted — the agent runs in your
own process, so MCP calls don't carry headers.

For browser-based admin / inline editor: the key lives in
`localStorage` under `ledric:admin-key`. The GUI prompts for it on
first load; the inline editor's iframe inherits it from the same
origin.

---

## Closed-reads mode

Flip `--require-reader-key` (or set
`auth.requireReaderKey: true` in `ledric.config.json`) and **every**
request — reads included — needs at least a reader key.

```bash
npx ledric serve --gui --require-reader-key
```

When this is on:

- Public-anonymous reads stop working.
- `GET /auth/status` returns `reads_open: false` so client tools
  know to attach a reader key.
- A reader key is enough for `GET`s; mutations still need admin.
- The auto-mint on first boot only mints both roles when neither
  exists — same flow either way.

Use this for internal CMS deployments where even reads should be
gated, or when serving private/preview content.

---

## Listing, creating, revoking

```bash
npx ledric keys list
# ID            ROLE    PREFIX     LABEL              CREATED                   LAST USED       REVOKED
# 01941b2c...   admin   lka_a3b…   auto:first-boot    2026-04-15T12:00:00.000Z  …               —
# 01941b3f...   reader  lkr_x7f…   auto:first-boot    2026-04-15T12:00:00.000Z  …               —

npx ledric keys list --include-revoked     # also show revoked rows

npx ledric keys create --role admin --label "vercel-prod"

npx ledric keys revoke 01941b2c            # any unique id-prefix; or `lka_a3b` works too
```

The id prefix is the first 8 hex chars of the row's UUIDv7. If two
keys minted in the same millisecond share the prefix, ledric prints
"ambiguous" and asks for a longer one.

Revoked keys stay in the table but their `revoked_at` is set. The
auth gate rejects them with `401`.

---

## Rotation

Standard pattern: mint new → switch consumers → revoke old.

```bash
# 1. Mint the replacement
NEW_KEY=$(npx ledric keys create --role admin --label "vercel-prod-2025q3" --raw)

# 2. Push it to the consumer (Vercel env, fly.io secrets, k8s, whatever)
vercel env add LEDRIC_ADMIN_KEY production <<<"$NEW_KEY"

# 3. Verify it's flowing — call something with the new key
curl -H "Authorization: Bearer $NEW_KEY" https://cms.example.com/auth/status

# 4. Revoke the old one
npx ledric keys revoke 01941b2c    # the old prefix
```

Active connections holding the old key get `401` on their next
request and reconnect with the new one — there's no graceful-period
inflight handling, just standard rotate-then-revoke.

---

## Env-var override

`LEDRIC_ADMIN_KEY` and `LEDRIC_READER_KEY` env vars, when set, take
precedence over (and **prevent**) the auto-mint on first boot. This
is the right move for secret-managed environments (Vercel, fly,
k8s) where you don't want secrets sitting in SQLite.

```bash
LEDRIC_ADMIN_KEY=lka_... LEDRIC_READER_KEY=lkr_... npx ledric serve --gui
```

The auth gate accepts both: the in-DB hashed key OR the env var
plaintext. You can mix paths — a DB-stored key alongside an env-var
key, both valid — but for production it's cleaner to pick one.

---

## No-auth dev mode

If the DB has no keys AND no env vars are set, ledric runs without
the gate. `/auth/status` reports `required: false`. Useful for
quick local hacking against `:memory:` or a throwaway `./ledric.db`.

The moment you mint your first key (`ledric keys create` or via
`init`), auth turns on globally — there's no way to half-enable it.
That's deliberate; partial auth is a worse failure mode than no
auth.

To turn auth off again, revoke every active key:

```bash
npx ledric keys list --include-revoked    # see what's there
# revoke each by prefix
```

Or just blow away the `api_keys` table (it's a SQLite file; you have
all the tools).
