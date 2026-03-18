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
# 1. Configure your connection
vibesql config init
# ? VibeSQL host: https://vibesql.online
# ? API key: vsk_live_abc123
# Config saved to ~/.vibesql/config.json

# 2. Run a query
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
- `--key <key>` — Override API key

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

### `vibesql config <init|set|show|clear>`

Manage saved connection profiles.

```bash
vibesql config init                             # interactive setup
vibesql config init --profile production        # named profile
vibesql config set host https://vibesql.online  # set a value
vibesql config set key vsk_live_abc123
vibesql config show                             # display config (keys masked)
vibesql config clear                            # wipe config
```

Config is stored at `~/.vibesql/config.json`:

```json
{
  "default": {
    "host": "https://vibesql.online",
    "key": "vsk_live_abc123"
  },
  "rosa": {
    "host": "http://10.0.0.93:52411",
    "key": "vsk_test_xyz789"
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

The CLI uses Stripe-style prefixed API keys:

| Prefix | Environment |
|--------|-------------|
| `vsk_live_` | Production |
| `vsk_test_` | Development / staging |

**Resolution order:**
1. `--key` flag (highest priority)
2. `VIBESQL_KEY` environment variable
3. Config file (`~/.vibesql/config.json`)

Host resolves the same way (`--host` > `VIBESQL_HOST` > config > `http://localhost:52411`).

## Architecture

The CLI is a thin wrapper over the VibeSQL Server HTTP API. It doesn't know or care whether it's talking to:

- **VibeSQL Server** directly (`http://localhost:52411`)
- **VibeSQL Edge** (`https://edge.idealvibe.online`)
- **vibesql-micro** (`http://localhost:5173`)

All three speak the same protocol: `POST /v1/query` with `Authorization: Secret <key>`.

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
