# @vibesql/cli

A terminal-native interface for [VibeSQL](https://vibesql.online). Query, inspect, and manage VibeSQL databases from the command line.

```bash
vibesql query "SELECT * FROM users LIMIT 5"
```

Zero runtime dependencies. Node.js 18+. Works on Windows, macOS, and Linux.

## Install

```bash
# Global install
npm install -g @vibesql/cli

# Or run without installing
npx @vibesql/cli query "SELECT 1"
```

## Quick Start

```bash
# 1. Point the CLI at your IDP + server
export VSQL_IDP_URL=https://idp.payez.net
export VSQL_CLIENT_ID=your_oauth_client_id
export VSQL_HOST=https://vibesql.online

# 2. Authenticate (device-code flow)
vibesql login
# Go to: https://idp.payez.net/auth/device
# Enter code: ABCD-1234
# Approved. Tokens saved.

# 3. Run a query
vibesql query "SELECT * FROM users LIMIT 5"
```

## Commands

### `vibesql query <sql>`

Execute SQL and display results.

```bash
vibesql query "SELECT * FROM users LIMIT 5"
vibesql query "SELECT * FROM users" --format json
vibesql query --file ./reports/monthly.sql
vibesql query "SELECT id, name FROM users" | head -5   # pipe-friendly
```

**Options:**
- `--format <table|json|csv|raw>` — Output format (default: `table`, auto-switches to `csv` when piped)
- `--file <path>` — Read SQL from a file instead of inline
- `--host <url>` — Override VibeSQL server URL
- `--profile <name>` — Use a named auth profile

### `vibesql tables`

List all tables in a schema.

```bash
vibesql tables                        # default: public schema
vibesql tables --schema vibe_agents   # specific schema
```

### `vibesql describe <table>`

Show column details — name, type, nullable, default.

```bash
vibesql describe users
vibesql describe agent_profiles --format json
```

### `vibesql rollback <collection>`

Roll back a VibeSQL schema collection to a previous version.

```bash
vibesql rollback my_collection --list           # show version history
vibesql rollback my_collection --dry-run        # preview changes without applying
vibesql rollback my_collection --version 14     # roll back to specific version
vibesql rollback my_collection --yes            # skip confirmation prompt
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

### `vibesql login` / `vibesql logout`

Authenticate against the IDP. Tokens (access + refresh) are stored per profile and
refreshed automatically when they expire.

```bash
vibesql login                              # device-code flow (default)
vibesql login --passwordless you@email.com # email passwordless flow
vibesql login --profile production         # authenticate a named profile
vibesql logout                             # clear tokens from the profile
```

Device-code flow prints a code and a URL — approve it in your browser, and the CLI
saves the resulting Bearer/JWT. Passwordless emails you a 6-digit code.

Requires `VSQL_IDP_URL` and `VSQL_CLIENT_ID` to be set (see [Authentication](#authentication)).

### `vibesql config <set|show|clear>`

Manage saved connection profiles. Hosts are set here; **tokens come from `vibesql login`**.

```bash
vibesql config set host https://vibesql.online  # set the host for a profile
vibesql config set host http://localhost:52411 --profile local
vibesql config show                             # display config (tokens masked)
vibesql config clear                            # wipe all profiles
```

> `vibesql config init` no longer takes an API key — it just points you to `vibesql login`.

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

### `vibesql health`

Check server connectivity.

```bash
vibesql health
# vibesql.online: healthy (45ms, v2.0.0)

vibesql health --host http://localhost:52411
# localhost:52411: healthy (3ms)
```

### `vibesql version`

```bash
vibesql version
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
once with `vibesql login`; the CLI stores the access + refresh tokens per profile and
refreshes them automatically before they expire.

Two login flows are supported:

| Flow | Command | What happens |
|------|---------|--------------|
| Device-code (default) | `vibesql login` | Prints a user code + URL; approve in the browser. |
| Passwordless | `vibesql login --passwordless <email>` | Emails a 6-digit code you enter at the prompt. |

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
$ vibesql query "SELCT * FROM users"
Error [INVALID_SQL]: You have an error in your SQL syntax
  Hint: Check for typos near "SELCT"

$ vibesql health --host http://unreachable:52411
Error [CONNECTION_FAILED]: Could not connect to http://unreachable:52411
  Hint: Check that the VibeSQL server is running and the host is correct
```

## Technical Details

- **Language:** TypeScript (ESM)
- **Runtime:** Node.js 18+
- **Dependencies:** Zero runtime. Uses built-in `fetch`, `fs`, `path`, `readline`.
- **Core logic:** ~200 lines across 5 source files
- **Package:** `@vibesql/cli` on npm

## License

MIT
