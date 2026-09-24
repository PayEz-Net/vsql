# Changelog

## Unreleased

### Changed
- **`KEELBASE_CLIENT_ID` replaces `VSQL_CLIENT_ID` as the client the CLI signs in on** (PAY-1814). Its value is your **Tenant** — the name your KeelBase page shows as "Tenant" — not your KeelBase client id (the `vibe_...` signing credential). `VSQL_CLIENT_ID` is still read as a **deprecated fallback**, with one warning, so existing `.env` files keep working. If both are set to **different** values the CLI refuses rather than guess; if neither is set it fails loud, as before.

## 1.3.0 — 2026-09-23

Re-synced with the hosted VibeSQL API, plus optional key-signing with a KeelBase secret. The routes were read from the API's source and measured on dev-93.

### Changed / BREAKING
- **The CLI targets the hosted VibeSQL API's routes.** v1.2.0 had drifted from it on four:
  - `query`: `POST /v1/query` (404 on the API) → `POST /v1/vsql/query`. The hosted query is read-only for tenant data until row-level security lands; writes get the API's own refusal.
  - `schema update`: `PUT` (405) with a string schema (400 `NOT_OBJECT`) → `POST /v1/schemas/{collection}` with `jsonSchema` as an object.
  - `insert`: the document was wrapped as `{ clientId, data: "<string>" }` (400 `REQUIRED_FIELDS_MISSING`) → the document itself is the body.
  - `schema show` / `rollback --list`: read `is_active` / `json_schema`, but the API answers camelCase, so every schema looked inactive (`NO_ACTIVE_SCHEMA` right after a successful create). Both spellings are read now.
  - `health` uses the API's public `/health`.
- A self-hosted VibeSQL Server, Edge or vibesql-micro speaking `POST /v1/query` is no longer a target of this CLI. For local work, use vibesql-micro's own `vsql-micro`.
- `--client-id` is ignored: the tenant comes from the credential.

### Added
- **Key-signing (optional, for app runtime calls):** set `VIBE_CLIENT_ID` (KeelBase client id) and `VIBE_HMAC_KEY` (KeelBase secret) and calls go through the identity service's proxy, `POST {IdP}/api/vibe/proxy`, HMAC-signed. Covers `query`, `health`, `schema show`, `rollback --list` and `insert`. Schema changes are refused with a secret; they use `vsql login`.
  - The secret is read from the environment only, and is never logged, written to config or passed in argv.
  - Setting only one of the two variables fails loud.
- **`vsql rows <collection> <table>`** (`--page`, `--page-size`) reads a table's rows back through `GET /v1/collections/{c}/tables/{t}`, and **`vsql collections`** lists your collections. Hosted SQL cannot see collection tables, so before this there was no way to read back what you wrote. Both are read-only and work with a KeelBase secret. Taken from rigpert's PR #2.
- `VSQL_DEBUG=1` prints each request's target to stderr, never a credential.
- `config show` names the KeelBase client id when key-signing is configured, and whether the secret is set.
- Tests (`npm test`):
  - the signature is checked against vectors computed by the identity service's own verifier;
  - one test per route pins the recorded contract;
  - key-signing is checked for its proxy request shape, for keeping the secret off the wire and out of debug output, and for refusing DDL.

### Fixed
- An unknown command (or `schema`/`config` subcommand) printed help and exited 0, so a typo looked like it ran. It now exits non-zero with `UNKNOWN_COMMAND`.
- An unknown option was taken silently, with the next word as its value, so `rows --limit 3` looked like it worked. It now fails with `UNKNOWN_FLAG`.
- `config show` in key-signing mode said "No config found. Run `vsql login`" under a working key-signing line. It now says a sign-in profile is not needed for key-signing.
- An empty or non-JSON reply printed a raw `SyntaxError` stack trace; it now reports the HTTP status and the start of the body.

### Docs
- **README:** install is one line: `npm install -g` of the release tarball (`vsql-1.3.0.tgz`, attached to the GitHub release). It is not on the npm registry.
- **README:** it says plainly that the device approval screen does not exist yet, and how a code is approved today.

## 1.2.0 — 2026-05-25

### Changed / BREAKING
- **Auth migrated to IDP device-code login** — authentication now yields a Bearer/JWT obtained from the IDP (`vsql login`), configured via `VSQL_IDP_URL` + `VSQL_CLIENT_ID` (both required; the CLI fails loud if either is unset). The Stripe-style API key path (`vsk_*` keys, `VIBESQL_KEY` env var, `Authorization: Secret`) is **REMOVED** — `config init` no longer issues a key. Run `vsql login`. Host resolution drops the silent `http://localhost:52411` default; set `--host` / `VSQL_HOST` / a profile host or the CLI fails loud.

### Added
- **`vsql login`** — Authenticate via IDP device-code flow (default), or `--passwordless <email>` / `--email <email>` for the email passwordless flow. Tokens are stored per profile and refreshed automatically before expiry.
- **`vsql logout`** — Clear stored tokens from the profile.

## 1.1.0 — 2026-03-18

Initial public release.

### Added
- **`vsql query <sql>`** — Execute SQL with table, JSON, CSV, or raw output formats. Reads from inline argument or `--file`. Auto-switches to CSV when piped (non-TTY).
- **`vsql tables`** — List all tables in a schema (default: public, override with `--schema`).
- **`vsql describe <table>`** — Show column name, type, nullable, and default for a table.
- **`vsql schema show <collection>`** — Dump the active JSON schema for a VibeSQL collection with version and table count.
- **`vsql schema update <collection>`** — Push a new schema version from a JSON file. Dry-run and confirmation prompt with table diff (added/removed).
- **`vsql insert <collection> <table>`** — Insert documents from `--file` or `--data`. Supports `--batch` for JSON array insertion.
- **`vsql rollback <collection>`** — Roll back a schema collection to a previous version. `--list` shows version history, `--dry-run` previews changes, `--yes` skips confirmation. Requires typing collection name to confirm.
- **`vsql config <init|set|show|clear>`** — Multi-profile connection management stored at `~/.vsql/config.json`. Named profiles via `--profile`.
- **`vsql health`** — Server connectivity check with latency and version display.
- **Stripe-style API key auth** — `vsk_live_*` for production, `vsk_test_*` for dev/staging. Resolution: `--key` flag > `VIBESQL_KEY` env > config file.
- **Host resolution** — `--host` flag > `VIBESQL_HOST` env > config file > `http://localhost:52411`.
- **Zero runtime dependencies** — Uses built-in Node.js `fetch`, `fs`, `path`, `readline`. No commander, no chalk, no cli-table3.
- **Protocol-agnostic** — Works against VibeSQL Server, VibeSQL Edge, or vibesql-micro. All speak `POST /v1/query` with `Authorization: Secret <key>`.
