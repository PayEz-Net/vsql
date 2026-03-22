# Changelog

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
