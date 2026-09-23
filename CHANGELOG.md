# Changelog

## 1.3.0 - 2026-09-23

Re-synced with the current Vibe API. Tested end to end against dev-93 as a developer account.

### Fixed
- **`vsql query`** now calls `POST /v1/vsql/query`. It used `/v1/query`, which the Vibe API does not serve (404). The route is read-only SQL; a refused statement prints which command to use instead.
- **`vsql schema update`** now sends `POST /v1/schemas/{collection}` with `jsonSchema` as a JSON object. It sent PUT (405) with a string (400 NOT_OBJECT).
- **`vsql insert`** now sends the document fields at the top level, not wrapped in `{ data }` (400 REQUIRED_FIELDS_MISSING). It prints generated keys.
- **`vsql schema show` / `rollback --list`** read the API's camelCase fields (`jsonSchema`, `isActive`, `createdAt`). They reported "no active schema" for a live one.
- **`vsql health`** uses the service's `/health`.
- An empty or non-JSON response is now a named error with the HTTP status and route, not a raw `SyntaxError` stack trace.

### Added
- **`vsql rows <collection> <table>`**: list documents (`--limit`, `--page`, `--format`).
- **`vsql collections`**: list your collections with document counts.
- A `prepare` script, so `npm install -g github:PayEz-Net/vsql` builds on install.

### Docs
- The README uses the real command name (`vsql`), the GitHub install and the read-only query rule.


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
