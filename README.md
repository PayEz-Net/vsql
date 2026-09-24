# vsql

A terminal interface for the hosted [VibeSQL](https://vibesql.online) API: query your data, manage collection schemas, and insert documents.

```bash
vsql query "SELECT * FROM notes LIMIT 5"
```

Zero runtime dependencies. Node.js 18+. Windows, macOS and Linux.

## Install

```bash
npm install -g https://github.com/PayEz-Net/vsql/releases/download/v1.3.0/vsql-1.3.0.tgz
vsql version
```

That installs the prebuilt release package and puts `vsql` on your PATH. `vsql` is not on the npm registry: `@vibesql/cli` is not published, and the npm package called `vsql` belongs to someone else. A plain `npm install -g github:PayEz-Net/vsql` does not work either, because on npm 11 the build step cannot find TypeScript.

To build from source instead: `git clone https://github.com/PayEz-Net/vsql.git && cd vsql && npm install && npm run build && npm link`.

## Two ways to authenticate, for two jobs

| For | Use | Covers |
|-----|-----|--------|
| **You, at the terminal: schemas, DDL, admin, ad-hoc queries** | Your **sign-in** (`vsql login`, device code). The primary path. | every command |
| **An app's runtime calls** (a test app, a script, a service) | Your **KeelBase client id + KeelBase secret** from the KeelBase page | `query`, `health`, `schema show`, `rollback --list`, `insert` |

Schema changes (`schema update`, `rollback`) always use your sign-in: with a KeelBase secret set they are refused and point you at `vsql login`.

## Quick start: sign in (primary)

```bash
export VSQL_IDP_URL=https://idp.payez.net       # the identity service
export KEELBASE_CLIENT_ID=<your Tenant>          # your Tenant, as shown on your KeelBase page
export VSQL_HOST=<the VibeSQL API URL>           # the hosted VibeSQL API

vsql login                                   # device code (default)
vsql query "SELECT 1 AS ok"
```

> **The device approval screen does not exist yet.** `vsql login` prints a user code and a verification URL; that URL answers **401** today (a known gap). Until the screen ships, a device code is approved by a call the **signed-in user** makes to the identity service, after completing 2FA:
>
> ```
> POST {VSQL_IDP_URL}/api/ExternalAuth/agent-device/approve
> Authorization: Bearer <your own access token>
> Content-Type: application/json
>
> { "user_code": "ABCD-1234" }
> ```
>
> **Never give your user code to anyone else to approve:** whoever approves it signs the CLI in as *themselves*. The account also needs the `vibe_agents_user` role on its client; if the approve answers 403 saying so, ask your administrator to grant it.
>
> `vsql login --passwordless you@example.com` (an emailed 6-digit code) avoids the approval step altogether.

Tokens (access + refresh) are stored per profile in `~/.vsql/config.json` and refreshed automatically.

## Key-signing with a KeelBase secret (optional, for app runtime calls)

The KeelBase page in the portal issues a **KeelBase client id** (`vibe_…`) and a **KeelBase secret** (base64, shown once). The SDK calls them `VIBE_CLIENT_ID` and `VIBE_HMAC_KEY`; so does `vsql`, so one `.env` serves both.

```bash
export VSQL_IDP_URL=https://idp.payez.net   # or IDP_URL
export VIBE_CLIENT_ID=vibe_...              # KeelBase client id
export VIBE_HMAC_KEY=...                    # KeelBase secret - keep it in .env, never commit it

vsql health                                  # proves the id + secret: the identity service checks the signature
vsql collections                             # your collections
vsql rows vibe_agents agents                 # read a table's rows back
```

Key-signing covers `query`, `health`, `collections`, `rows`, `schema show`, `rollback --list` and `insert`. Schema changes (`schema update`, `rollback`) use your sign-in.

With both variables set, every call goes through the identity service's proxy (`POST {IdP}/api/vibe/proxy`), signed `base64(HMAC-SHA256(base64decode(secret), "{unix seconds}|{METHOD}|{endpoint}"))`. What to know:

- **The secret is read from the environment only**: never from a command-line argument, never written to `~/.vsql/config.json`, never printed (`VSQL_DEBUG=1` shows each request's target, not the secret).
- **Setting only one of the two variables is an error**, not a silent fall-back to your sign-in.
- **Rotation is immediate.** Rotating the secret on the KeelBase page stops the old one at once; update your `.env` first.
- **The secret is shown once.** If you lose it, rotate it.
- **The signature covers the timestamp, method and endpoint, not the request body.** A fix is tracked.
- `--host` does not apply in this mode; unset the two variables to use `--host` with `vsql login`.

## Commands

### `vsql query <sql>`

```bash
vsql query "SELECT * FROM notes LIMIT 5"
vsql query "SELECT * FROM notes" --format json
vsql query --file ./reports/monthly.sql
```

The hosted query endpoint is **read-only for tenant data** until row-level security lands. Row writes go through `vsql insert` and schema changes through `vsql schema update`; a write sent to `query` gets the API's own refusal, printed as it comes. `tables` and `describe` read `information_schema`, which the same guard refuses on the hosted API.

Options: `--format <table|json|csv|raw>` (default `table`, `csv` when piped), `--file <path>`, `--host <url>`, `--profile <name>`.

### `vsql schema show <collection>` / `vsql schema update <collection> --file schema.json`

```bash
vsql schema show keelbase_demo
vsql schema update keelbase_demo --file schema.json --dry-run
vsql schema update keelbase_demo --file schema.json --yes
```

`update` sends the file's JSON as the new schema version and activates it (sign-in only).

### `vsql insert <collection> <table>`

```bash
vsql insert keelbase_demo notes --data '{"title":"hello"}'
vsql insert keelbase_demo notes --file rows.json --batch   # each element of a JSON array
```

The document is sent as-is; the collection's schema decides the required fields. The tenant comes from your credential. `--client-id` is accepted for old scripts and ignored.

### `vsql rows <collection> <table>` / `vsql collections`

```bash
vsql collections
vsql rows keelbase_demo notes                    # page 1, 20 rows
vsql rows keelbase_demo notes --page 2 --page-size 50 --format json
```

Use `rows` to read back what you wrote. Hosted SQL (`query`) cannot see collection tables. Each row shows its `document_id` and the document's fields. `collections` lists collections that have documents; a collection with a schema but no documents yet does not appear, so check it with `vsql schema show <collection>`. An unknown option fails with `UNKNOWN_FLAG` rather than being ignored. Both commands are read-only and work with a KeelBase secret.

### `vsql rollback <collection>`

```bash
vsql rollback keelbase_demo --list           # version history (works with a KeelBase secret)
vsql rollback keelbase_demo --dry-run
vsql rollback keelbase_demo --version 3      # sign-in only
```

### `vsql login` / `vsql logout` / `vsql config <set|show|clear>` / `vsql health` / `vsql version`

`config show` masks tokens. When key-signing is configured, it names the KeelBase client id and says whether the secret is set. It never prints the secret. With key-signing and no sign-in profile, it says the profile is not needed.

An unknown command exits non-zero (`UNKNOWN_COMMAND`) rather than printing help and exiting 0.

## Errors

Errors go to stderr with a code and a hint; exit code 1. A reply that is not JSON (an error page, an empty 404) is reported with its HTTP status and the start of the body:

```
Error [BAD_RESPONSE]: HTTP 404: (empty body)
  Hint: The server does not have this route; check the host (or VSQL_IDP_URL) points at VibeSQL.
```

## Development

```bash
npm install
npm test        # builds, then runs the tests in test/
```

## License

Apache-2.0 (see `package.json` and `LICENSE`).
