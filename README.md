# vsql: the VibeSQL command line

A terminal-native interface for [VibeSQL](https://vibesql.online). Query, inspect, and manage VibeSQL databases from the command line.

```bash
vsql query "SELECT * FROM users LIMIT 5"
```

Zero runtime dependencies. Node.js 18+. Works on Windows, macOS, and Linux.

## Install

```bash
# Global install, straight from GitHub (builds on install)
npm install -g github:PayEz-Net/vsql

# A specific release
npm install -g github:PayEz-Net/vsql#v1.3.0
```

Not published to npm yet.

## Quick Start

```bash
# 1. Point the CLI at the IDP and the Vibe API
export VSQL_IDP_URL=https://idp.payez.net
export VSQL_CLIENT_ID=<your tenant>        # your developer tenant, shown in KeelBase
export VSQL_HOST=https://api.idealvibe.online

# 2. Sign in (device code), then approve the code while signed in
vsql login

# 3. Create a collection (DDL), write a row, read it back
vsql schema update my_app --file schema.json --yes
vsql insert my_app notes --data '{"note":"hello"}'
vsql rows my_app notes
```

### Which command writes what

- **`vsql schema update`** creates or changes tables. This is DDL, defined as a JSON schema per collection.
- **`vsql insert`** writes rows. **`vsql rows`** reads them back.
- **`vsql query`** is **read-only SQL**. The hosted API refuses DDL and writes on this route until row-level security lands, and the CLI tells you which command to use instead.

The CLI signs in as **you**, which is what DDL needs. A KeelBase client id and secret (from the KeelBase page) are for your **app's** runtime calls. Use the SDK or `@payez/next-mvp` for those, not this CLI.

## Commands

### `vsql query <sql>`

Execute SQL and display results.

```bash
vsql query "SELECT * FROM users LIMIT 5"
vsql query "SELECT * FROM users" --format json
vsql query --file ./reports/monthly.sql
vsql query "SELECT id, name FROM users" | head -5   # pipe-friendly
```

**Options:**
- `--format <table|json|csv|raw>` — Output format (default: `table`, auto-switches to `csv` when piped)
- `--file <path>` — Read SQL from a file instead of inline
- `--host <url>` — Override VibeSQL server URL
- `--profile <name>` — Use a named auth profile

### `vsql tables`

List all tables in a schema.

```bash
vsql tables                        # default: public schema
vsql tables --schema vibe_agents   # specific schema
```

### `vsql describe <table>`

Show column details — name, type, nullable, default.

```bash
vsql describe users
vsql describe agent_profiles --format json
```

### `vsql rollback <collection>`

Roll back a VibeSQL schema collection to a previous version.

```bash
vsql rollback my_collection --list           # show version history
vsql rollback my_collection --dry-run        # preview changes without applying
vsql rollback my_collection --version 14     # roll back to specific version
vsql rollback my_collection --yes            # skip confirmation prompt
```

Requires typing the collection name to confirm (unless `--yes` is passed):

```
Rolling back "my_collection" to version 14:
  Current: 9 tables (version 16, active)
  Target:  7 tables (version 14)
  Tables removed: orders_v2, temp_staging
  Tables added: (none)

Type the collection name to confirm: my_collection
```

### `vsql login` / `vsql logout`

Authenticate against the IDP. Tokens (access + refresh) are stored per profile and
refreshed automatically when they expire.

```bash
vsql login                              # device-code flow (default)
vsql login --passwordless you@email.com # email passwordless flow
vsql login --profile production         # authenticate a named profile
vsql logout                             # clear tokens from the profile
```

Device-code flow prints a code and a URL — approve it in your browser, and the CLI
saves the resulting Bearer/JWT. Passwordless emails you a 6-digit code.

Requires `VSQL_IDP_URL` and `VSQL_CLIENT_ID` to be set (see [Authentication](#authentication)).

### `vsql config <set|show|clear>`

Manage saved connection profiles. Hosts are set here; **tokens come from `vsql login`**.

```bash
vsql config set host https://vibesql.online  # set the host for a profile
vsql config set host http://localhost:52411 --profile local
vsql config show                             # display config (tokens masked)
vsql config clear                            # wipe all profiles
```

> `vsql config init` no longer takes an API key — it just points you to `vsql login`.

Config is stored at `~/.vibesql/config.json`:

```json
{
  "default": {
    "host": "https://vibesql.online",
    "auth_method": "device-code",
    "access_token": "<jwt>",
    "refresh_token": "<token>",
    "expires_at": "2026-05-25T18:00:00.000Z"
  },
  "local": {
    "host": "http://localhost:52411"
  }
}
```

### `vsql health`

Check server connectivity.

```bash
vsql health
# vibesql.online: healthy (45ms, v2.0.0)

vsql health --host http://localhost:52411
# localhost:52411: healthy (3ms)
```

### `vsql version`

```bash
vsql version
# vibesql-cli v1.0.0
```

## Output Formats

### Table (default)

```
┌────┬──────────┬─────────────────────┐
│ id │ name     │ created_at          │
├────┼──────────┼─────────────────────┤
│  1 │ Alice    │ 2026-01-15T09:30:00 │
│  2 │ Bob      │ 2026-02-20T14:15:00 │
└────┴──────────┴─────────────────────┘
2 rows (45ms)
```

### JSON (`--format json`)

```json
[
  { "id": 1, "name": "Alice", "created_at": "2026-01-15T09:30:00" },
  { "id": 2, "name": "Bob", "created_at": "2026-02-20T14:15:00" }
]
```

### CSV (`--format csv`)

```
id,name,created_at
1,Alice,2026-01-15T09:30:00
2,Bob,2026-02-20T14:15:00
```

### Raw (`--format raw`)

Full API response including metadata:

```json
{
  "success": true,
  "data": [...],
  "meta": { "rowCount": 2, "executionTimeMs": 45.23 }
}
```

When stdout is piped (non-TTY), the default format automatically switches from `table` to `csv`.

## Authentication

The CLI authenticates against the PayEz IDP and uses a Bearer/JWT access token. Log in
once with `vsql login`; the CLI stores the access + refresh tokens per profile and
refreshes them automatically before they expire.

Two login flows are supported:

| Flow | Command | What happens |
|------|---------|--------------|
| Device-code (default) | `vsql login` | Prints a user code + URL; approve in the browser. |
| Passwordless | `vsql login --passwordless <email>` | Emails a 6-digit code you enter at the prompt. |

**Required environment:**

| Variable | Purpose |
|----------|---------|
| `VSQL_IDP_URL` | IDP base URL (e.g. `https://idp.payez.net`). No default — set it or login fails loud. |
| `VSQL_CLIENT_ID` | Your IDP OAuth client id. No default. |

**Host resolution:** `--host` > `VSQL_HOST` env > profile host. There is **no silent
`localhost` default** — if no host is set, the CLI fails loud rather than hitting the
wrong server.

## Architecture

The CLI is a thin wrapper over the VibeSQL Server HTTP API. It doesn't know or care whether it's talking to:

- **VibeSQL Server** directly (`http://localhost:52411`)
- **VibeSQL Edge** (`https://edge.idealvibe.online`)
- **vibesql-micro** (`http://localhost:5173`)

All three speak the same protocol: `POST /v1/query` with `Authorization: Bearer <jwt>`.

```
CLI ──→ Edge Server ──→ VibeSQL Server ──→ PostgreSQL
     (auth + rate limit)   (query exec)      (data)
```

## Error Handling

Errors print to stderr with a code and hint. Exit code 1.

```bash
$ vsql query "SELCT * FROM users"
Error [INVALID_SQL]: You have an error in your SQL syntax
  Hint: Check for typos near "SELCT"

$ vsql health --host http://unreachable:52411
Error [CONNECTION_FAILED]: Could not connect to http://unreachable:52411
  Hint: Check that the VibeSQL server is running and the host is correct
```

## Technical Details

- **Language:** TypeScript (ESM)
- **Runtime:** Node.js 18+
- **Dependencies:** Zero runtime. Uses built-in `fetch`, `fs`, `path`, `readline`.
- **Core logic:** ~200 lines across 5 source files
- **Package:** `vsql`, installed from GitHub (`github:PayEz-Net/vsql`)

## License

MIT
