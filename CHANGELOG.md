# Changelog

## 1.3.5 — 2026-10-07

PAY-1977. `vsql login` (device code) could not complete against an IdP whose poll endpoint requires `client_id` in the body: the CLI polled with only `{device_code}`, got a 400 "ClientId is required", and reported `Unknown error: unknown`.

### Fixed
- **The device-code poll now sends `client_id` in the request body as well as the `X-Client-Id` header** (RFC 8628 puts it in the form body; the header stays for older servers).

### Note
- Versions before 1.3.0 (the 1.1.x line on npm) rewrote a dev IdP host to `http://<host>:3600/auth/device` and ignored the verification URL the IdP returned. 1.3.x shows the IdP's `verification_url` as given; there is no rewrite left. Upgrade if `vsql login` prints a `:3600` address.

## 1.3.4 — 2026-10-06

PAY-2052. `vsql describe` was the one command still on raw SQL; the hosted API refuses `information_schema` to a tenant key (403, measured by Nextpert-Scout on dev-93, mail 69331), so `describe` failed for every key-mode user, as `tables` did before 1.3.3.

### Changed
- **`vsql describe <table> [collection]`** reads the active schema from `GET /v1/schemas` (HMAC-only, the same route `tables` uses) instead of `information_schema.columns`. Output columns are now `column_name`, `type`, `format`, `pk`, `auto_increment`, `nullable`. Differences from the SQL version: `nullable` is derived as "not in the table's `required` list", columns come in schema order (there is no ordinal), and it does not print a column's default or enum values (a schema can set `default` and `enum` on a column; `describe` shows neither, so use `schema show <collection>` to read them). Works with a KeelBase secret.
- A table name that exists in more than one collection now fails with `AMBIGUOUS_TABLE` and names the collections; pass the collection as the second argument. An unknown table or collection fails with `TABLE_NOT_FOUND` / `COLLECTION_NOT_FOUND`.

## 1.3.3 — 2026-09-29

PAY-1978 (Jon-ruled, from the Vasanth intake `E:/Repos/Agents/jon.ranes/releases/v086-intake-vasanth-first-tester-2026-09-29.md`, flaws 1-4). One release for everything the first external tester hit, on top of v1.3.1 — plus PAY-1814, the `KEELBASE_CLIENT_ID` rename (rigpert 67421: the rename must ship with this line, not as a separate 1.4.0).

### Added
- **`vsql schemas`** — every collection and its active schema, including ones with no documents yet (`collections` only shows ones that have some). **`vsql tables [collection]`** — a collection's tables, or with no argument every table grouped by collection. Both read `GET /v1/schemas` (bare), NOT `/v1/enterprise/schemas`: that route requires an `X-Vibe-Client-Secret` vsql's key mode never sends and would 401. `GET /v1/schemas` is HMAC-only, the same posture `insert`/`collections` already use, and works with a KeelBase secret. `tables` no longer reads `information_schema`, which 403'd for every tenant key on prod — that was the actual bug Vasanth hit. Its old `--schema <name>` flag (a Postgres schema namespace) no longer applies and is refused locally with a pointer to `vsql schemas`.
- **`.env` loading.** `vsql` now reads a `.env` file from the CURRENT WORKING DIRECTORY (not the install location) before any command runs. A real environment variable already set is NEVER overridden by a `.env` value — the real one silently wins, by design. Missing/unreadable `.env` is not an error; malformed lines are skipped, not fatal.
- **`vsql health` names its sources.** Prints, to stderr, the mode (`key-signing`, `sign-in` or `anonymous`), the host it checked, and where each came from: `--host`, `VSQL_HOST` (env or `.env`), a named saved profile, or (for the key pair) `env`/`.env` — never the credential VALUE. Closes two silent-failure shapes measured on Vasanth's machine: a Windows user-level `VIBE_HMAC_KEY` silently beating the shell's value, and `health` falling back to an old saved profile and reporting "healthy" for a different server with no indication it had done so.
- **Key-mode `query` refuses locally, with the sign-in hint.** The KeelBase secret is the *application's* identity; `query` and schema changes are attributed to a *person*, so they run on your sign-in (Jon's design ruling). With a KeelBase secret set, `vsql query` now refuses before sending anything (`NOT_WITH_KEELBASE_SECRET`, the same hint DDL already gives) instead of reaching the server and getting back `RAW_SQL_PLATFORM_ADMIN_ONLY`, which read like a permissions bug rather than "wrong mode for this command."

### Changed
- README: `query` and schema-changing commands moved out of the key-signing "covers" list into the sign-in-only list (they were never actually reachable with a key on the hosted API; the README just hadn't caught up). Reading a schema (`schema show`, `rollback --list`) stays key-signable, since it's a read, not a change.
- **`KEELBASE_CLIENT_ID` replaces `VSQL_CLIENT_ID` as the client the CLI signs in on** (PAY-1814). Its value is your **Tenant** — the name your KeelBase page shows as "Tenant" — not your KeelBase client id (the `vibe_...` signing credential). `VSQL_CLIENT_ID` is still read as a **deprecated fallback**, with one warning, so existing `.env` files keep working. If both are set to **different** values the CLI refuses rather than guess; if neither is set it fails loud, as before.

## 1.3.1 — 2026-09-29

PAY-1975 (Vasanth's hackathon, Jon, today): v1.3.0 had `insert` but no way to update or delete a
row. The server always supported it (measured on the dev-93 twin: `PATCH .../{id}` → 200,
`DELETE .../{id}` → 204, read-back confirms both); the CLI just never carried the commands
forward from the old ADO vsql-cli 1.1.1.

### Added
- **`vsql update <collection> <table> <id> --data '{...}'`** — merge-update a document, `PATCH /v1/collections/{c}/tables/{t}/{id}`.
- **`vsql replace <collection> <table> <id> --data '{...}'`** — whole-document replace, `PUT` on the same path.
- **`vsql delete <collection> <table> <id>`** — delete a document, `DELETE` on the same path. Prompts for confirmation on a TTY; `--yes` skips the prompt; a non-TTY call without `--yes` refuses outright rather than deleting silently or hanging on a prompt nothing can answer.
- `data update|replace|delete` are kept as aliases of the three commands above, matching the 1.1.1 spelling, so existing docs/scripts using it still work.
- All three are covered by key-signing (a KeelBase secret), the same as `insert` — row writes are app runtime, not a schema change.
- `--data` is validated locally before any request is sent: invalid JSON, or JSON that isn't a plain object, fails with `INVALID_JSON` rather than reaching the server half-parsed.

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
